import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { ensureVoucherNumbers } from './voucherNumbers'
import { bdCalc } from './billDiscounting'
import { bankLedgerName } from './treasury'
import { postSaleInvoiceJournal } from './sales'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// DUPLICATE COMPONENT VOUCHERS ON GROUPED SALES INVOICES (audit F01).
//
// An invoice that runs across several sale rows posts ONE voucher for the whole
// invoice. An older build also left a small voucher behind for each extra row —
// Dr the party / Cr the sales head for that row's taxable value — so the
// invoice's revenue and the party's balance were counted twice for those rows.
// Each such voucher balances on its own, which is why a balance check never
// caught them.
//
// This finds them and removes them — but only on request, never at startup,
// and only the exact shape described above:
//   - the invoice has exactly one voucher whose sales credit equals the whole
//     invoice's taxable value (the real one);
//   - the extra is two lines only: Dr the same party ledger the real voucher
//     debits, Cr a sales head the real voucher credits, both for that row's
//     own taxable value (to the paisa);
//   - nothing is allocated or split against either line.
// Anything else on a grouped invoice is reported for a person to look at and
// left alone: a second voucher that does not have this shape may be a real
// adjustment. Every removed voucher is archived line by line in
// accounting_repair_log, and its permanent voucher number stays taken.

const TOL = 0.011

async function ensureLog(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
}

export interface DuplicateSaleFinding {
  company_id: number
  invoice_key: string
  invoice_no: string
  party: string
  invoice_taxable: number
  posted_revenue: number
  canonical_entry_id: number | null
  duplicates: Array<{ entry_id: number; sale_id: number; amount: number }>
  removable_amount: number
  // Why this invoice (or part of it) is left for a person, when it is.
  review: string | null
}

async function scan(companyId?: number): Promise<{ findings: DuplicateSaleFinding[]; lines: Map<number, Row[]>; entries: Map<number, Row> }> {
  const c = getClient()
  const groups = await c.execute({
    sql: `SELECT company_id, invoice_group AS k, SUM(amount) AS taxable, GROUP_CONCAT(id) AS ids
            FROM sales
           WHERE COALESCE(invoice_group, '') <> ''${companyId ? ' AND company_id = ?' : ''}
           GROUP BY company_id, invoice_group
          HAVING COUNT(*) > 1`,
    args: companyId ? [companyId] : []
  })
  const findings: DuplicateSaleFinding[] = []
  const linesBy = new Map<number, Row[]>()
  const entriesBy = new Map<number, Row>()
  for (const g of groups.rows) {
    const saleIds = String(g.ids).split(',').map(Number).filter(Boolean)
    const ents = (
      await c.execute({
        sql: `SELECT e.*, s.amount AS row_amount, s.invoice_no AS row_invoice
                FROM journal_entries e JOIN sales s ON s.id = e.sale_id
               WHERE e.sale_id IN (${saleIds.map(() => '?').join(',')}) AND e.company_id = ? AND e.vch_type = 'SALE'
               ORDER BY e.id`,
        args: [...saleIds, g.company_id]
      })
    ).rows.map((r) => ({ ...r }) as Row)
    if (ents.length < 2) continue
    const det = (
      await c.execute({
        sql: `SELECT l.*, a.name AS account_name, a.acc_group,
                     (SELECT COUNT(*) FROM journal_bill_allocs b WHERE b.line_id = l.id) +
                     (SELECT COUNT(*) FROM journal_line_splits sp WHERE sp.line_id = l.id) AS links
                FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
               WHERE l.entry_id IN (${ents.map(() => '?').join(',')})`,
        args: ents.map((e) => e.id)
      })
    ).rows.map((r) => ({ ...r }) as Row)
    const linesOf = (id: unknown): Row[] => det.filter((l) => Number(l.entry_id) === Number(id))
    const salesCr = (id: unknown): number =>
      linesOf(id)
        .filter((l) => l.acc_group === 'Sales Accounts')
        .reduce((s, l) => s + Number(l.cr) - Number(l.dr), 0)
    const taxable = Number(g.taxable)
    const revenue = ents.reduce((s, e) => s + salesCr(e.id), 0)
    if (revenue - taxable <= 0.05) continue
    for (const e of ents) {
      linesBy.set(Number(e.id), linesOf(e.id))
      entriesBy.set(Number(e.id), e)
    }

    const full = ents.filter((e) => Math.abs(salesCr(e.id) - taxable) <= TOL)
    const base: DuplicateSaleFinding = {
      company_id: Number(g.company_id),
      invoice_key: String(g.k),
      invoice_no: String(ents[0].row_invoice || ents[0].vch_no || g.k),
      party: '',
      invoice_taxable: round2(taxable),
      posted_revenue: round2(revenue),
      canonical_entry_id: null,
      duplicates: [],
      removable_amount: 0,
      review: null
    }
    if (full.length !== 1) {
      findings.push({ ...base, review: full.length ? 'More than one voucher carries the whole invoice' : 'No single voucher carries the whole invoice' })
      continue
    }
    const canonical = full[0]
    const cl = linesOf(canonical.id)
    // The party is whatever the real voucher debits most — a debtor usually,
    // a supplier's ledger when the sale went to a party we also buy from.
    const partyLine = cl.filter((l) => Number(l.dr) > 0).sort((a, b) => Number(b.dr) - Number(a.dr))[0]
    const salesHeads = new Set(cl.filter((l) => l.acc_group === 'Sales Accounts' && Number(l.cr) > 0).map((l) => Number(l.account_id)))
    base.canonical_entry_id = Number(canonical.id)
    base.party = String(partyLine?.account_name || '')
    const odd: string[] = []
    for (const e of ents) {
      if (Number(e.id) === Number(canonical.id)) continue
      const ls = linesOf(e.id)
      const credit = ls.find((l) => salesHeads.has(Number(l.account_id)) && Number(l.cr) > 0 && !Number(l.dr))
      const debit = ls.find((l) => partyLine && Number(l.account_id) === Number(partyLine.account_id) && Number(l.dr) > 0 && !Number(l.cr))
      const shaped =
        e.order_id == null &&
        e.payment_id == null &&
        ls.length === 2 &&
        !!credit &&
        !!debit &&
        Math.abs(Number(credit.cr) - Number(e.row_amount)) <= TOL &&
        Math.abs(Number(debit.dr) - Number(credit.cr)) <= TOL
      if (!shaped) {
        odd.push(`voucher ${e.id} is not a plain duplicate`)
        continue
      }
      if (ls.some((l) => Number(l.links) > 0)) {
        odd.push(`voucher ${e.id} has bill allocations against it`)
        continue
      }
      base.duplicates.push({ entry_id: Number(e.id), sale_id: Number(e.sale_id), amount: round2(Number(credit.cr)) })
    }
    base.removable_amount = round2(base.duplicates.reduce((s, d) => s + d.amount, 0))
    base.review = odd.length ? odd.join('; ') : null
    findings.push(base)
  }
  return { findings, lines: linesBy, entries: entriesBy }
}

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

/** What the repair would remove — read only. */
export async function previewDuplicateInvoicePostings(companyId?: number): Promise<{
  findings: DuplicateSaleFinding[]
  removable_vouchers: number
  removable_amount: number
  needs_review: number
}> {
  const { findings } = await scan(companyId)
  return {
    findings,
    removable_vouchers: findings.reduce((s, f) => s + f.duplicates.length, 0),
    removable_amount: round2(findings.reduce((s, f) => s + f.removable_amount, 0)),
    needs_review: findings.filter((f) => f.review).length
  }
}

/**
 * Remove the duplicates the preview listed. `entryIds` must name them — a
 * voucher not in a fresh scan's removable list is refused, so a stale screen
 * can never delete something that has changed since it was shown.
 */
export async function repairDuplicateInvoicePostings(entryIds: number[], companyId?: number): Promise<{ removed: number; revenue: number }> {
  const wanted = new Set((entryIds || []).map(Number).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the duplicate vouchers to remove')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureVoucherNumbers()
    await ensureLog()
    const { findings, lines, entries } = await scan(companyId)
    const allowed = new Map<number, DuplicateSaleFinding>()
    for (const f of findings) for (const d of f.duplicates) allowed.set(d.entry_id, f)
    const stale = [...wanted].filter((id) => !allowed.has(id))
    if (stale.length) throw new Error(`Voucher${stale.length === 1 ? '' : 's'} ${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} no longer a plain duplicate — refresh the list`)
    let removed = 0
    let revenue = 0
    for (const id of wanted) {
      const f = allowed.get(id) as DuplicateSaleFinding
      const ls = lines.get(id) || []
      // Never discard evidence: the exact header and lines, and which voucher
      // it duplicated. The permanent number stays reserved.
      await c.execute({
        sql: 'INSERT INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`sales-component-v1:${id}`, id, JSON.stringify({ entry: entries.get(id), lines: ls, canonicalId: f.canonical_entry_id, invoice: f.invoice_no })]
      })
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [id] })
      removed++
      revenue += f.duplicates.find((d) => d.entry_id === id)?.amount || 0
    }
    return { removed, revenue: round2(revenue) }
  })
}

// ---------------------------------------------------------------------------
// The other audit findings that need a person's evidence before anything is
// posted. These are lists, not repairs: an NBFC's advice decides whether a PID
// went to the supplier or to us, a bank statement decides the day upfront
// interest was paid, and an LC that does not clear needs its actual payout and
// fees read off the bank's letter. Guessing any of them would put a figure in
// the books that nobody can support.
// ---------------------------------------------------------------------------

async function columns(table: string): Promise<Set<string>> {
  const r = await getClient().execute(`PRAGMA table_info(${table})`)
  return new Set(r.rows.map((x) => String(x.name)))
}

export async function accountingChecks(companyId?: number): Promise<{
  bd_route_unconfirmed: Row[]
  bd_upfront_unposted: Row[]
  lc_residuals: Row[]
}> {
  const c = getClient()
  const cid = companyId ?? null

  const bdCols = await columns('bill_discountings')
  const hasRoute = bdCols.has('disbursement_route')
  const bdRows = (
    await c.execute({
      sql: `SELECT bd.*, nb.name AS nbfc_name,
                   COALESCE(s.name, cu.name) AS party_name
              FROM bill_discountings bd
              LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
              LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
              LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
             WHERE (? IS NULL OR bd.company_id = ?)
             ORDER BY bd.company_id, bd.id`,
      args: [cid, cid]
    })
  ).rows.map((r) => ({ ...r }) as Row)
  const pick = (b: Row): Row => ({
    id: Number(b.id),
    company_id: Number(b.company_id),
    bd_no: b.bd_no,
    finance_type: b.finance_type,
    nbfc_name: b.nbfc_name,
    party_name: b.party_name,
    amount: Number(b.amount) || 0,
    payment_received_date: b.payment_received_date || null,
    journal_entry_id: b.journal_entry_id || null
  })
  const bd_route_unconfirmed = hasRoute
    ? bdRows.filter((b) => String(b.disbursement_route || 'unconfirmed') === 'unconfirmed' && b.payment_received_date).map(pick)
    : []
  const bd_upfront_unposted = bdRows
    .filter((b) => Number(b.interest_upfront) === 1 && b.payment_received_date && !Number(b.upfront_interest_journal_entry_id))
    .map((b) => {
      const k = bdCalc(b)
      return { ...pick(b), interest: round2(k.interestAmount), tds: round2(k.tdsAmount), net: round2(k.netInterest) }
    })

  // Each LC's own vouchers, every column that names one, counted once.
  const lcCols = [...(await columns('letters_of_credit'))].filter((x) => x.endsWith('journal_entry_id'))
  const repCols = [...(await columns('lc_repayments'))].filter((x) => x.endsWith('journal_entry_id'))
  const lcs = (
    await c.execute({
      sql: `SELECT l.* FROM letters_of_credit l
             WHERE (? IS NULL OR l.company_id = ?)
               AND (l.preclosed_date IS NOT NULL OR EXISTS (SELECT 1 FROM lc_repayments r WHERE r.lc_id = l.id))
             ORDER BY l.company_id, l.id`,
      args: [cid, cid]
    })
  ).rows.map((r) => ({ ...r }) as Row)
  const lc_residuals: Row[] = []
  for (const l of lcs) {
    const ids = new Set<number>()
    for (const col of lcCols) if (Number(l[col])) ids.add(Number(l[col]))
    const iss = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE lc_id = ? AND journal_entry_id IS NOT NULL', args: [l.id] })
    for (const r of iss.rows) ids.add(Number(r.journal_entry_id))
    if (repCols.length) {
      const reps = await c.execute({ sql: `SELECT ${repCols.join(', ')} FROM lc_repayments WHERE lc_id = ?`, args: [l.id] })
      for (const r of reps.rows) for (const col of repCols) if (Number(r[col])) ids.add(Number(r[col]))
    }
    if (!ids.size) continue
    const list = [...ids]
    const bal = await c.execute({
      sql: `SELECT COALESCE(SUM(jl.cr - jl.dr), 0) AS residual, GROUP_CONCAT(DISTINCT a.name) AS accounts
              FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE jl.entry_id IN (${list.map(() => '?').join(',')}) AND a.name LIKE 'LC PAYABLE%'`,
      args: list
    })
    const residual = round2(Number(bal.rows[0].residual) || 0)
    if (Math.abs(residual) < 0.5) continue
    lc_residuals.push({
      id: Number(l.id),
      company_id: Number(l.company_id),
      lc_no: l.lc_no,
      amount: Number(l.amount) || 0,
      preclosed_date: l.preclosed_date || null,
      entry_ids: list.sort((a, b) => a - b),
      accounts: bal.rows[0].accounts || '',
      residual
    })
  }
  return { bd_route_unconfirmed, bd_upfront_unposted, lc_residuals }
}


// ---------------------------------------------------------------------------
// BANK A/C — THE BANK THAT IS NOT A BANK.
//
// Bill Discounting used to post every disbursement, repayment and interest
// payment to one generic ledger, BANK A/C, because it never asked which bank.
// No statement can be reconciled against it. Where the owner knows the money
// all went through one real account, this moves a company's BANK A/C postings
// there in one step: each voucher's bank line is re-pointed, nothing else —
// amounts, dates, voucher numbers and allocations stay as they are. Every line
// moved is logged in accounting_repair_log so the move can be traced (and
// undone line by line). The bills are told their bank too, so a later re-post
// or the next repayment keeps using it, and the company's BANK A/C is
// redirected to it so nothing lands there again.
// ---------------------------------------------------------------------------

const GENERIC_BANK = 'BANK A/C'
const CASH_BANK_GROUPS = ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand']

export async function genericBankPostings(): Promise<Row[]> {
  const c = getClient()
  const acct = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = ?', args: [GENERIC_BANK] })
  if (!acct.rows.length) return []
  const aid = Number(acct.rows[0].id)
  const byCo = await c.execute({
    sql: `SELECT e.company_id, co.name AS company_name, COUNT(*) AS lines, COUNT(DISTINCT e.id) AS vouchers,
                 ROUND(SUM(l.dr), 2) AS dr, ROUND(SUM(l.cr), 2) AS cr
            FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            LEFT JOIN companies co ON co.id = e.company_id
           WHERE l.account_id = ?
           GROUP BY e.company_id ORDER BY e.company_id`,
    args: [aid]
  })
  const out: Row[] = []
  for (const r of byCo.rows.map((x) => ({ ...x }) as Row)) {
    // The company's own bank, when it has exactly one — the obvious target.
    const banks = await c
      .execute({
        sql: 'SELECT name, account_no FROM banks WHERE company_id = ? AND COALESCE(active, 1) = 1',
        args: [Number(r.company_id)]
      })
      .catch(() => null)
    const names = (banks?.rows || []).map((b) => bankLedgerName(b.name, b.account_no))
    out.push({ ...r, suggested: names.length === 1 ? names[0] : '', company_banks: names })
  }
  return out
}

export async function moveGenericBankPostings(
  companyId: number,
  target: string
): Promise<{ lines: number; vouchers: number; account: string }> {
  const cid = Number(companyId)
  if (!cid) throw new Error('Pick the company')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const from = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = ?', args: [GENERIC_BANK] })
    if (!from.rows.length) return { lines: 0, vouchers: 0, account: target }
    const fromId = Number(from.rows[0].id)
    const to = await c.execute({
      sql: 'SELECT id, name, acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = ?',
      args: [String(target || '').trim().toUpperCase()]
    })
    if (!to.rows.length || !CASH_BANK_GROUPS.includes(String(to.rows[0].acc_group))) {
      throw new Error('Pick a real bank ledger to move them to')
    }
    const toId = Number(to.rows[0].id)
    const toName = String(to.rows[0].name)
    if (toId === fromId) throw new Error('That is BANK A/C itself')
    const lines = (
      await c.execute({
        sql: `SELECT l.id, l.entry_id, l.dr, l.cr FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
               WHERE l.account_id = ? AND e.company_id = ? ORDER BY l.id`,
        args: [fromId, cid]
      })
    ).rows.map((x) => ({ ...x }) as Row)
    if (!lines.length) return { lines: 0, vouchers: 0, account: toName }
    const entryIds = [...new Set(lines.map((l) => Number(l.entry_id)))]
    const stamp = new Date().toISOString()
    // Evidence first: exactly which lines moved, from where to where.
    await c.execute({
      sql: 'INSERT INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
      args: [`bank-ac-move-v1:${cid}:${stamp}`, entryIds[0], JSON.stringify({ from: GENERIC_BANK, to: toName, company_id: cid, lines })]
    })
    await c.execute({
      sql: 'UPDATE journal_lines SET account_id = ? WHERE account_id = ? AND entry_id IN (SELECT id FROM journal_entries WHERE company_id = ?)',
      args: [toId, fromId, cid]
    })
    await c
      .execute({
        sql: `UPDATE journal_bill_allocs SET account_id = ? WHERE account_id = ?
                AND line_id IN (SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.company_id = ?)`,
        args: [toId, fromId, cid]
      })
      .catch(() => undefined)
    // The bills learn their bank, so a re-post or the next repayment keeps it.
    const list = entryIds.join(',')
    await c
      .execute({
        sql: `UPDATE bill_discountings SET disbursement_route = 'bank', disbursement_account = ?
               WHERE company_id = ? AND journal_entry_id IN (${list})
                 AND COALESCE(disbursement_route, 'unconfirmed') IN ('unconfirmed', 'bank')`,
        args: [toName, cid]
      })
      .catch(() => undefined)
    await c
      .execute({
        sql: `UPDATE bill_discountings SET margin_release_account = ? WHERE company_id = ? AND margin_release_journal_entry_id IN (${list})`,
        args: [toName, cid]
      })
      .catch(() => undefined)
    for (const [table, col] of [
      ['bd_repayments', 'bank_account'],
      ['bd_interest_payments', 'bank_account'],
      ['bd_payment_ins', 'account']
    ]) {
      await c
        .execute({ sql: `UPDATE ${table} SET ${col} = ? WHERE journal_entry_id IN (${list})`, args: [toName] })
        .catch(() => undefined)
    }
    // And nothing addressed to BANK A/C in this company lands there again.
    await c
      .execute({
        sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
              VALUES (?, ?, ?, ?, 'accounting check')
              ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name, note = excluded.note`,
        args: [cid, GENERIC_BANK, toName, `BANK A/C postings moved to ${toName}`]
      })
      .catch(() => undefined)
    return { lines: lines.length, vouchers: entryIds.length, account: toName }
  })
}

// ---------------------------------------------------------------------------
// TDS ON SALES INVOICES (2026-09-30).
//
// Sales no longer carry TDS (SALE_TDS_PCT in sales.ts): the customer is debited
// the whole invoice and their withholding is posted by hand when they deduct
// it. Invoices saved before that still hold a TDS rate and amount on their
// lines, and their voucher still debits TDS RECEIVABLE A/C for it with the
// customer debited that much less.
//
// This clears it — on request, never at startup. It is surgical rather than a
// re-post: the TDS RECEIVABLE line comes out and its amount goes onto the
// customer's own debit line, so the voucher keeps its id, its number, its date
// and every other line exactly as they are (a full re-post would also rebuild
// anything else that had drifted from the lines, which is not what was asked).
// The lines' TDS rate and amount go to 0, and the customer's informal ledger
// row with them. A voucher whose shape is not the plain one — no single
// customer line to move the amount onto, a TDS line on the credit side, or
// anything allocated against it — is listed for a person and left alone.
// Every invoice changed is archived first, in accounting_repair_log.
// ---------------------------------------------------------------------------

const TDS_LEDGER = 'TDS RECEIVABLE A/C'
// The debit lines a sale voucher has besides the customer's own.
const SALE_OTHER_DEBITS = new Set([TDS_LEDGER, 'ROUND OFF A/C', 'FREIGHT OUTWARD A/C'])

export interface SaleTdsFinding {
  company_id: number
  company_name: string
  invoice_key: string
  invoice_no: string
  sale_date: string
  party: string
  sale_ids: number[]
  // What the lines of the invoice hold, and what its voucher posted.
  lines_tds: number
  voucher_tds: number
  entry_id: number | null
  customer_line_id: number | null
  customer_ledger: string | null
  tds_line_ids: number[]
  review: string | null
}

async function scanSaleTds(companyId?: number): Promise<SaleTdsFinding[]> {
  const c = getClient()
  const coArgs = companyId ? [companyId] : []
  // Every invoice, keyed the way the posting keys it, with its TDS figures.
  const inv = (
    await c.execute({
      sql: `SELECT s.company_id, COALESCE(s.invoice_group, 'L' || s.id) AS k, MIN(s.invoice_no) AS invoice_no,
                   MIN(s.sale_date) AS sale_date, GROUP_CONCAT(s.id) AS ids, ROUND(SUM(COALESCE(s.tds_amount, 0)), 2) AS tds,
                   MAX(ABS(COALESCE(s.tds_pct, 0))) AS pct, MIN(COALESCE(cu.name, s.customer, '')) AS party,
                   MIN(co.name) AS company_name
              FROM sales s
              LEFT JOIN customers cu ON cu.id = s.customer_id
              LEFT JOIN companies co ON co.id = s.company_id
             WHERE 1 = 1${companyId ? ' AND s.company_id = ?' : ''}
             GROUP BY s.company_id, COALESCE(s.invoice_group, 'L' || s.id)`,
      args: coArgs
    })
  ).rows.map((x) => ({ ...x }) as Row)
  const bySale = new Map<number, Row>()
  for (const r of inv) for (const id of String(r.ids || '').split(',').map(Number).filter(Boolean)) bySale.set(id, r)

  // Every SALE voucher with a TDS RECEIVABLE line, and all of its lines.
  const tdsLines = (
    await c.execute({
      sql: `SELECT je.id AS entry_id, je.sale_id
              FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id
              JOIN ledger_accounts la ON la.id = jl.account_id
             WHERE UPPER(TRIM(la.name)) = ? AND je.vch_type = 'SALE' AND je.sale_id IS NOT NULL${companyId ? ' AND je.company_id = ?' : ''}`,
      args: [TDS_LEDGER, ...coArgs]
    })
  ).rows.map((x) => ({ ...x }) as Row)
  const saleOfEntry = new Map<number, number>()
  for (const l of tdsLines) saleOfEntry.set(Number(l.entry_id), Number(l.sale_id))
  const entryIds = [...saleOfEntry.keys()]
  const linesOf = new Map<number, Row[]>()
  const allocated = new Set<number>()
  if (entryIds.length) {
    const list = entryIds.join(',')
    const all = await c.execute(
      `SELECT jl.id, jl.entry_id, jl.dr, jl.cr, la.name AS account
         FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE jl.entry_id IN (${list}) ORDER BY jl.id`
    )
    for (const l of all.rows.map((x) => ({ ...x }) as Row)) {
      const k = Number(l.entry_id)
      linesOf.set(k, [...(linesOf.get(k) || []), l])
    }
    const al = await c.execute(
      `SELECT DISTINCT line_id FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id IN (${list}))`
    )
    for (const r of al.rows) allocated.add(Number(r.line_id))
  }

  const findings = new Map<string, SaleTdsFinding>()
  const findingFor = (r: Row): SaleTdsFinding => {
    const key = `${r.company_id}:${r.k}`
    let f = findings.get(key)
    if (!f) {
      f = {
        company_id: Number(r.company_id),
        company_name: String(r.company_name || ''),
        invoice_key: String(r.k),
        invoice_no: String(r.invoice_no || '—'),
        sale_date: String(r.sale_date || ''),
        party: String(r.party || ''),
        sale_ids: String(r.ids || '').split(',').map(Number).filter(Boolean),
        lines_tds: Number(r.tds) || 0,
        voucher_tds: 0,
        entry_id: null,
        customer_line_id: null,
        customer_ledger: null,
        tds_line_ids: [],
        review: null
      }
      findings.set(key, f)
    }
    return f
  }
  for (const r of inv) if (Math.abs(Number(r.tds) || 0) > 0.004 || Number(r.pct) > 0) findingFor(r)

  for (const entryId of entryIds) {
    const r = bySale.get(saleOfEntry.get(entryId) as number)
    // A voucher for a sale no longer on file is not this repair's to touch.
    if (!r) continue
    const f = findingFor(r)
    if (f.entry_id) {
      f.review = 'the invoice has more than one voucher carrying TDS'
      continue
    }
    const ls = linesOf.get(entryId) || []
    const tds = ls.filter((l) => String(l.account).trim().toUpperCase() === TDS_LEDGER)
    const cust = ls.filter((l) => Number(l.dr) > 0 && !SALE_OTHER_DEBITS.has(String(l.account).trim().toUpperCase()))
    f.entry_id = entryId
    f.tds_line_ids = tds.map((l) => Number(l.id))
    f.voucher_tds = round2(tds.reduce((s, l) => s + Number(l.dr) - Number(l.cr), 0))
    if (tds.some((l) => Number(l.cr) > 0)) {
      f.review = 'the TDS line is on the credit side'
    } else if (cust.length !== 1) {
      f.review = cust.length ? 'more than one debit line could be the customer’s' : 'no customer line to move the amount onto'
    } else if (tds.some((l) => allocated.has(Number(l.id)))) {
      f.review = 'something is allocated against the TDS line'
    } else {
      f.customer_line_id = Number(cust[0].id)
      f.customer_ledger = String(cust[0].account)
    }
  }
  return [...findings.values()].sort(
    (a, b) => a.company_id - b.company_id || a.sale_date.localeCompare(b.sale_date) || a.invoice_no.localeCompare(b.invoice_no)
  )
}

/** Which invoices still carry TDS, and what clearing each would change — read only. */
export async function previewSaleTds(companyId?: number): Promise<{
  findings: SaleTdsFinding[]
  clearable: number
  voucher_tds: number
  needs_review: number
}> {
  const findings = await scanSaleTds(companyId)
  const ok = findings.filter((f) => !f.review)
  return {
    findings,
    clearable: ok.length,
    voucher_tds: round2(ok.reduce((s, f) => s + f.voucher_tds, 0)),
    needs_review: findings.length - ok.length
  }
}

/**
 * Clear TDS from the invoices the preview listed. `keys` name them as
 * `company_id:invoice_key`; one that a fresh scan no longer offers (changed,
 * already cleared, or now needing review) is refused, so a stale screen can
 * never touch something different from what it showed.
 */
export async function clearSaleTds(
  keys: string[],
  companyId?: number
): Promise<{ invoices: number; vouchers: number; tds: number }> {
  const wanted = new Set((keys || []).map(String).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the invoices to clear')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const findings = await scanSaleTds(companyId)
    const allowed = new Map(findings.filter((f) => !f.review).map((f) => [`${f.company_id}:${f.invoice_key}`, f]))
    const stale = [...wanted].filter((k) => !allowed.has(k))
    if (stale.length) {
      throw new Error(`${stale.length} invoice${stale.length === 1 ? ' has' : 's have'} changed since the list was shown — check again`)
    }
    const stamp = new Date().toISOString()
    let vouchers = 0
    let tds = 0
    for (const k of wanted) {
      const f = allowed.get(k) as SaleTdsFinding
      const ids = f.sale_ids.join(',')
      // Evidence first: the voucher's lines, the sale lines' TDS and the
      // customer ledger rows, exactly as they were.
      const before: Row = { invoice: f.invoice_no, finding: f }
      if (f.entry_id) {
        before.lines = (
          await c.execute({ sql: 'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id', args: [f.entry_id] })
        ).rows.map((x) => ({ ...x }))
      }
      before.sales = (await c.execute(`SELECT id, tds_pct, tds_amount FROM sales WHERE id IN (${ids})`)).rows.map((x) => ({ ...x }))
      before.customer_ledger = (
        await c
          .execute(`SELECT * FROM customer_ledger WHERE entry_type = 'sale' AND sale_id IN (${ids})`)
          .then((r) => r.rows)
          .catch(() => [])
      ).map((x) => ({ ...x }))
      await c.execute({
        sql: 'INSERT INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`sales-tds-v1:${k}:${stamp}`, f.entry_id || 0, JSON.stringify(before)]
      })

      if (f.entry_id && f.customer_line_id && f.tds_line_ids.length) {
        await c.execute({
          sql: 'UPDATE journal_lines SET dr = ROUND(dr + ?, 2) WHERE id = ? AND entry_id = ?',
          args: [f.voucher_tds, f.customer_line_id, f.entry_id]
        })
        await c.execute({
          sql: `DELETE FROM journal_lines WHERE entry_id = ? AND id IN (${f.tds_line_ids.join(',')})`,
          args: [f.entry_id]
        })
        vouchers++
        tds += f.voucher_tds
      }
      // The informal customer ledger stored the net after TDS: give it back.
      for (const s of before.sales as Row[]) {
        const t = Number(s.tds_amount) || 0
        if (Math.abs(t) > 0.004) {
          await c
            .execute({
              sql: "UPDATE customer_ledger SET amount = ROUND(amount - ?, 2) WHERE sale_id = ? AND entry_type = 'sale'",
              args: [t, Number(s.id)]
            })
            .catch(() => undefined)
        }
      }
      await c.execute(`UPDATE sales SET tds_pct = 0, tds_amount = 0 WHERE id IN (${ids})`)
    }
    return { invoices: wanted.size, vouchers, tds: round2(tds) }
  })
}

// ---------------------------------------------------------------------------
// LC REPAYMENT CHARGES ROUTED THROUGH THE PAYABLE (2026-09-30).
//
// A repayment with bank charges (LC-1: ₹94,00,000 principal + ₹1,180 charges,
// one ₹94,01,180 debit on the statement) used to post as two vouchers:
//   JOURNAL  Dr BANK CHARGES 1,180      / Cr LC PAYABLE 1,180
//   PAYMENT  Dr LC PAYABLE   94,01,180  / Cr BANK       94,01,180
// Balances came out right, but the payable showed the charges as money owed
// on the LC and then repaid. It now posts as ONE payment (postLcRepaymentEntry):
//   Dr LC PAYABLE 94,00,000 · Dr BANK CHARGES 1,180 / Cr BANK 94,01,180
//
// This rewrites the old ones into that shape, on request. Surgical: the
// payment voucher keeps its id, number, date and bank line; its payable line
// drops by the charges and the charge lines move onto it; the charges journal
// is archived and removed (its number stays taken). Only the plain shape is
// touched — a charges journal carrying anything else (a rescued upfront
// interest), a payment with other lines, or anything allocated — is listed for
// a person and left alone. Every account's balance is unchanged either way.
// ---------------------------------------------------------------------------

const CHARGE_LEDGERS = new Set(['BANK CHARGES A/C', 'COMM. CHARGES A/C'])

export interface LcChargeFinding {
  repayment_id: number
  company_id: number
  company_name: string
  lc_no: string
  repay_date: string
  total: number
  charges: number
  payment_entry_id: number
  fee_entry_id: number
  review: string | null
}

async function scanLcCharges(): Promise<{ findings: LcChargeFinding[]; lines: Map<number, Row[]> }> {
  const c = getClient()
  const reps = (
    await c.execute(`SELECT r.id, r.amount, r.repay_date, r.journal_entry_id, r.fee_journal_entry_id, l.lc_no, l.company_id, co.name AS company_name
                       FROM lc_repayments r
                       JOIN letters_of_credit l ON l.id = r.lc_id
                       LEFT JOIN companies co ON co.id = l.company_id
                      WHERE r.posted = 1 AND r.journal_entry_id IS NOT NULL AND r.fee_journal_entry_id IS NOT NULL
                      ORDER BY l.company_id, r.repay_date, r.id`)
  ).rows.map((x) => ({ ...x }) as Row)
  const lines = new Map<number, Row[]>()
  const entryIds = reps.flatMap((r) => [Number(r.journal_entry_id), Number(r.fee_journal_entry_id)])
  const allocated = new Set<number>()
  if (entryIds.length) {
    const list = entryIds.join(',')
    const ls = await c.execute(
      `SELECT jl.id, jl.entry_id, jl.account_id, jl.dr, jl.cr, UPPER(TRIM(la.name)) AS account
         FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE jl.entry_id IN (${list}) ORDER BY jl.id`
    )
    for (const l of ls.rows.map((x) => ({ ...x }) as Row)) {
      const k = Number(l.entry_id)
      lines.set(k, [...(lines.get(k) || []), l])
    }
    const al = await c.execute(
      `SELECT DISTINCT line_id FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id IN (${list}))`
    )
    for (const r of al.rows) allocated.add(Number(r.line_id))
  }
  const findings: LcChargeFinding[] = []
  for (const r of reps) {
    const payId = Number(r.journal_entry_id)
    const feeId = Number(r.fee_journal_entry_id)
    const pay = lines.get(payId) || []
    const fee = lines.get(feeId) || []
    const feeDr = fee.filter((l) => Number(l.dr) > 0)
    const feeCr = fee.filter((l) => Number(l.cr) > 0)
    const charges = round2(feeDr.reduce((s, l) => s + Number(l.dr), 0))
    const payDr = pay.filter((l) => Number(l.dr) > 0)
    const payCr = pay.filter((l) => Number(l.cr) > 0)
    let review: string | null = null
    if (!fee.length) review = 'its charges voucher is missing'
    else if (!feeDr.every((l) => CHARGE_LEDGERS.has(String(l.account)))) review = 'the charges voucher carries more than bank/commission charges (an upfront interest caught at repayment)'
    else if (feeCr.length !== 1) review = 'the charges voucher does not credit a single payable'
    else if (pay.length !== 2 || payDr.length !== 1 || payCr.length !== 1) review = 'the payment voucher has other lines'
    else if (Number(payDr[0].account_id) !== Number(feeCr[0].account_id)) review = 'the payment and the charges were posted to different payables'
    else if (Math.abs(Number(payDr[0].dr) - Number(r.amount)) > TOL) review = 'the payment no longer matches the repayment amount'
    else if (Number(payDr[0].dr) - charges < -TOL) review = 'the charges are more than the payment'
    else if ([...pay, ...fee].some((l) => allocated.has(Number(l.id)))) review = 'something is allocated against these vouchers'
    findings.push({
      repayment_id: Number(r.id),
      company_id: Number(r.company_id),
      company_name: String(r.company_name || ''),
      lc_no: String(r.lc_no || ''),
      repay_date: String(r.repay_date || ''),
      total: round2(Number(r.amount) || 0),
      charges,
      payment_entry_id: payId,
      fee_entry_id: feeId,
      review
    })
  }
  return { findings, lines }
}

/** LC repayments still posted in two vouchers — read only. */
export async function previewLcCharges(): Promise<{ findings: LcChargeFinding[]; fixable: number; charges: number }> {
  const { findings } = await scanLcCharges()
  const ok = findings.filter((f) => !f.review)
  return { findings, fixable: ok.length, charges: round2(ok.reduce((s, f) => s + f.charges, 0)) }
}

/** Rewrite the listed repayments into one voucher each. Refuses anything a fresh scan no longer offers. */
export async function fixLcCharges(repaymentIds: number[]): Promise<{ fixed: number; charges: number }> {
  const wanted = new Set((repaymentIds || []).map(Number).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the repayments to fix')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureVoucherNumbers()
    await ensureLog()
    const { findings, lines } = await scanLcCharges()
    const allowed = new Map(findings.filter((f) => !f.review).map((f) => [f.repayment_id, f]))
    const stale = [...wanted].filter((id) => !allowed.has(id))
    if (stale.length) {
      throw new Error(`${stale.length} repayment${stale.length === 1 ? ' has' : 's have'} changed since the list was shown — check again`)
    }
    const stamp = new Date().toISOString()
    let charges = 0
    for (const id of wanted) {
      const f = allowed.get(id) as LcChargeFinding
      const pay = lines.get(f.payment_entry_id) || []
      const fee = lines.get(f.fee_entry_id) || []
      const feeEntry = (await c.execute({ sql: 'SELECT * FROM journal_entries WHERE id = ?', args: [f.fee_entry_id] })).rows.map((x) => ({ ...x }))
      // Evidence first: both vouchers exactly as they were.
      await c.execute({
        sql: 'INSERT INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [
          `lc-repay-charges-v1:${id}:${stamp}`,
          f.payment_entry_id,
          JSON.stringify({ finding: f, payment_lines: pay, fee_entry: feeEntry[0] || null, fee_lines: fee })
        ]
      })
      const payable = pay.find((l) => Number(l.dr) > 0) as Row
      await c.execute({
        sql: 'UPDATE journal_lines SET dr = ROUND(dr - ?, 2) WHERE id = ? AND entry_id = ?',
        args: [f.charges, Number(payable.id), f.payment_entry_id]
      })
      for (const l of fee.filter((x) => Number(x.dr) > 0)) {
        await c.execute({
          sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, 0)',
          args: [f.payment_entry_id, Number(l.account_id), round2(Number(l.dr))]
        })
      }
      await c.execute({
        sql: "UPDATE journal_entries SET narration = COALESCE(narration, '') || ? WHERE id = ?",
        args: [` (incl. ${f.charges.toFixed(2)} charges)`, f.payment_entry_id]
      })
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [f.fee_entry_id] })
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [f.fee_entry_id] })
      await c.execute({ sql: 'UPDATE lc_repayments SET fee_journal_entry_id = NULL WHERE id = ?', args: [id] })
      charges += f.charges
    }
    return { fixed: wanted.size, charges: round2(charges) }
  })
}

// ---------------------------------------------------------------------------
// DUPLICATE SALES VOUCHERS, FIXED AT START (asked for on 2026-09-30).
//
// The duplicate component vouchers on grouped invoices (audit F01) were made
// by the startup catch-up bug of 2026-09-03 — 59 of them in the same minute —
// and each counts a line's revenue, and the party's debt, a second time. The
// reviewed repair above removes the plain ones on a button; this runs the same
// thing once at start, and goes one step further for the invoices it would
// have left for review:
//
//   - PLAIN duplicates: removed by repairDuplicateInvoicePostings — archived
//     line by line, voucher numbers kept taken.
//   - An invoice the scan flags for review (an extra voucher with GST, freight
//     or TDS on it, or no one voucher carrying the whole invoice) is RE-POSTED
//     FROM ITS OWN LINES — exactly what saving the invoice from the Sales page
//     does: the earliest voucher keeps its number and date and is rewritten to
//     the invoice as it stands, and the strays go. Every voucher of the
//     invoice is archived first. A sale carries no TDS any more, so the lines'
//     leftover TDS figure is cleared with it (clearSaleTds).
//
// The lines are the invoice — they are what the Sales register, the printed
// invoice and the receivable all read — so posting from them is the one answer
// that cannot disagree with anything else in the app.
// ---------------------------------------------------------------------------

export async function autoFixDuplicateSales(): Promise<{ removed: number; revenue: number; reposted: string[] }> {
  const { findings } = await previewDuplicateInvoicePostings()
  if (!findings.length) return { removed: 0, revenue: 0, reposted: [] }

  // 1. The plain duplicates, through the reviewed repair.
  const plainIds = findings.flatMap((f) => f.duplicates.map((d) => d.entry_id))
  let removed = 0
  let revenue = 0
  if (plainIds.length) {
    const r = await repairDuplicateInvoicePostings(plainIds)
    removed = r.removed
    revenue = r.revenue
  }

  // 2. The ones left for review: re-posted from their lines, archived first.
  const reposted: string[] = []
  for (const f of findings.filter((x) => x.review)) {
    await withDbTransaction(async () => {
      // The transaction's own connection — taken INSIDE it. One fetched
      // before would write outside the transaction and wait on its lock.
      const c = getClient()
      await ensureVoucherNumbers()
      await ensureLog()
      const saleRows = (
        await c.execute({
          sql: `SELECT id FROM sales WHERE company_id = ? AND COALESCE(invoice_group, 'L' || id) = ? ORDER BY id`,
          args: [f.company_id, f.invoice_key]
        })
      ).rows.map((r) => Number(r.id))
      if (!saleRows.length) return
      const entries = (
        await c.execute(`SELECT * FROM journal_entries WHERE sale_id IN (${saleRows.join(',')}) ORDER BY id`)
      ).rows.map((x) => ({ ...x }) as Row)
      const lines = entries.length
        ? (await c.execute(`SELECT * FROM journal_lines WHERE entry_id IN (${entries.map((e) => Number(e.id)).join(',')}) ORDER BY id`)).rows.map(
            (x) => ({ ...x })
          )
        : []
      await c.execute({
        sql: 'INSERT INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [
          `sales-invoice-repost-v1:${f.company_id}:${f.invoice_key}:${new Date().toISOString()}`,
          Number(entries[0]?.id || 0),
          JSON.stringify({ invoice: f.invoice_no, review: f.review, entries, lines })
        ]
      })
      await postSaleInvoiceJournal(saleRows[0])
    })
    reposted.push(f.invoice_no)
  }

  // 3. Their lines' leftover TDS, now that the voucher carries none.
  if (reposted.length) {
    const tds = await previewSaleTds()
    const keys = tds.findings
      .filter((t) => !t.review && findings.some((f) => f.review && f.company_id === t.company_id && f.invoice_key === t.invoice_key))
      .map((t) => `${t.company_id}:${t.invoice_key}`)
    if (keys.length) await clearSaleTds(keys)
  }
  return { removed, revenue: round2(revenue), reposted }
}

// ---------------------------------------------------------------------------
// DELIVERY FREIGHT ON SALE VOUCHERS (asked for on 2026-10-01).
//
// Sale vouchers used to carry the delivery freight — Dr FREIGHT OUTWARD /
// Cr FREIGHT PAYABLE — the day the invoice was saved. Freight now stays on the
// Fr. Outward Working register until the transporter's bill is booked, and is
// posted then (see postSaleInvoiceJournal). This takes the old pair off the
// vouchers that still have it, so the ledgers read the same way for every
// invoice — and ONLY the pair: the Dr FREIGHT OUTWARD and Cr FREIGHT PAYABLE
// lines (equal, so the voucher still balances) are removed and nothing else on
// the voucher is touched. Not a re-post from the invoice lines: a voucher can
// differ from its lines for other reasons (KRFL/405's line was moved to RPO-B
// after it posted to RPO SALE), and fixing freight must not quietly fix — or
// break — anything else. The invoice's freight lines go back to "not yet in any
// ledger" so the transporter's bill expenses them when it is booked.
//
// Left for a person: a voucher whose freight is already on a booked bill (the
// bill took it off Freight Payable, so removing the credit would leave the
// payable short), or one whose two freight lines do not match. Every voucher
// is archived before it changes.
// ---------------------------------------------------------------------------

export interface OutwardFreightFinding {
  entry_id: number
  company_id: number
  company_name: string
  invoice_no: string
  sale_date: string
  customer: string
  transporter: string
  freight: number
  sale_id: number
  review: string | null
}

async function payableNames(): Promise<string[]> {
  const map = await getClient()
    .execute("SELECT use_name FROM ledger_map WHERE UPPER(posts_as) = 'FREIGHT PAYABLE A/C'")
    .catch(() => null)
  return ['FREIGHT PAYABLE A/C', ...(map ? map.rows.map((r) => String(r.use_name || '').toUpperCase()) : [])].filter(Boolean)
}

async function scanOutwardFreight(): Promise<OutwardFreightFinding[]> {
  const c = getClient()
  const payable = await payableNames()
  const res = await c.execute({
    sql: `SELECT je.id AS entry_id, je.company_id, co.name AS company_name, je.entry_date, je.sale_id,
                 COALESCE(je.vch_no, '') AS vch_no, jl.cr AS freight
            FROM journal_entries je
            JOIN journal_lines jl ON jl.entry_id = je.id
            JOIN ledger_accounts la ON la.id = jl.account_id
            LEFT JOIN companies co ON co.id = je.company_id
           WHERE je.vch_type = 'SALE' AND je.sale_id IS NOT NULL AND jl.cr > 0
             AND UPPER(la.name) IN (${payable.map(() => '?').join(',')})
           ORDER BY je.company_id, je.entry_date, je.id`,
    args: payable
  })
  const out: OutwardFreightFinding[] = []
  for (const r of res.rows.map((x) => ({ ...x }) as Row)) {
    const entryId = Number(r.entry_id)
    const sale = (
      await c.execute({
        sql: `SELECT s.id, s.invoice_no, s.invoice_group, s.company_id, COALESCE(cu.name, s.customer) AS customer, t.name AS transporter
                FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id LEFT JOIN transporters t ON t.id = s.transporter_id
               WHERE s.id = ?`,
        args: [Number(r.sale_id)]
      })
    ).rows[0] as Row | undefined
    let review: string | null = null
    const freight = round2(Number(r.freight) || 0)
    if (!sale) review = 'its sale line no longer exists'
    const ids = sale
      ? (
          await c.execute({
            sql: `SELECT id FROM sales WHERE company_id = ? AND COALESCE(invoice_group, 'id:' || id) = COALESCE(?, 'id:' || ?)`,
            args: [Number(sale.company_id), sale.invoice_group == null ? null : String(sale.invoice_group), Number(sale.id)]
          })
        ).rows.map((x) => Number(x.id))
      : []
    if (!review) {
      const fo = await c.execute({
        sql: `SELECT COUNT(*) AS n, COALESCE(SUM(jl.dr), 0) AS dr, COALESCE(SUM(jl.cr), 0) AS cr FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
               WHERE jl.entry_id = ? AND UPPER(la.name) LIKE 'FREIGHT OUTWARD%'`,
        args: [entryId]
      })
      const pc = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
               WHERE jl.entry_id = ? AND UPPER(la.name) IN (${payable.map(() => '?').join(',')})`,
        args: [entryId, ...payable]
      })
      if (Number(fo.rows[0]?.n || 0) !== 1 || Number(pc.rows[0]?.n || 0) !== 1) review = 'the voucher has more than one freight line'
      else if (Number(fo.rows[0]?.cr || 0) > TOL || Math.abs(Number(fo.rows[0]?.dr || 0) - freight) > TOL)
        review = 'Freight Outward and Freight Payable are not the same amount'
    }
    if (!review && ids.length) {
      const billed = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM transporter_ledger
               WHERE entry_type = 'freight' AND bill_id IS NOT NULL AND COALESCE(accrued, 0) = 1
                 AND sale_id IN (${ids.join(',')})`,
        args: []
      })
      if (Number(billed.rows[0]?.n || 0) > 0) review = 'its freight is already on a booked transporter bill'
    }
    out.push({
      entry_id: entryId,
      company_id: Number(r.company_id),
      company_name: String(r.company_name || ''),
      invoice_no: String(sale?.invoice_no || r.vch_no || ''),
      sale_date: String(r.entry_date || ''),
      customer: String(sale?.customer || ''),
      transporter: String(sale?.transporter || ''),
      freight,
      sale_id: Number(sale?.id || r.sale_id),
      review
    })
  }
  return out
}

/** Sale vouchers still carrying their delivery freight — read only. */
export async function previewOutwardFreight(): Promise<{ findings: OutwardFreightFinding[]; fixable: number; freight: number }> {
  const findings = await scanOutwardFreight()
  const ok = findings.filter((f) => !f.review)
  return { findings, fixable: ok.length, freight: round2(ok.reduce((s, f) => s + f.freight, 0)) }
}

/** Take the freight off the listed sale vouchers. Refuses anything a fresh scan no longer offers. */
export async function fixOutwardFreight(entryIds: number[]): Promise<{ fixed: number; freight: number }> {
  const wanted = new Set((entryIds || []).map(Number).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the sale vouchers to fix')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const findings = await scanOutwardFreight()
    const allowed = new Map(findings.filter((f) => !f.review).map((f) => [f.entry_id, f]))
    const stale = [...wanted].filter((id) => !allowed.has(id))
    if (stale.length) throw new Error(`${stale.length} voucher${stale.length === 1 ? ' has' : 's have'} changed since the list was shown — check again`)
    const payable = new Set(await payableNames())
    const isFreight = (name: string): boolean => payable.has(name) || name.startsWith('FREIGHT OUTWARD')
    const linesOf = async (entryId: number): Promise<Row[]> =>
      (
        await c.execute({
          sql: `SELECT jl.*, UPPER(TRIM(la.name)) AS account FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.id`,
          args: [entryId]
        })
      ).rows.map((x) => ({ ...x }) as Row)
    const net = (ls: Row[]): Map<string, number> => {
      const m = new Map<string, number>()
      for (const l of ls) if (!isFreight(String(l.account))) m.set(String(l.account), round2((m.get(String(l.account)) || 0) + Number(l.dr) - Number(l.cr)))
      return m
    }
    let freight = 0
    for (const id of wanted) {
      const f = allowed.get(id) as OutwardFreightFinding
      const before = await linesOf(id)
      const entry = (await c.execute({ sql: 'SELECT * FROM journal_entries WHERE id = ?', args: [id] })).rows.map((x) => ({ ...x }))[0] || null
      await c.execute({
        sql: 'INSERT OR IGNORE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`outward-freight-v1:${id}`, id, JSON.stringify({ entry, lines: before, invoice: f.invoice_no, freight: f.freight })]
      })
      // The invoice's freight lines are in no ledger once the voucher drops
      // them, so the transporter's bill must expense them, not debit the payable.
      const sale = (await c.execute({ sql: 'SELECT company_id, invoice_group FROM sales WHERE id = ?', args: [f.sale_id] })).rows[0] as Row | undefined
      if (sale) {
        await c.execute({
          sql: `UPDATE transporter_ledger SET accrued = 0
                 WHERE entry_type = 'freight' AND bill_id IS NULL
                   AND sale_id IN (SELECT id FROM sales WHERE company_id = ? AND COALESCE(invoice_group, 'id:' || id) = COALESCE(?, 'id:' || ?))`,
          args: [Number(sale.company_id), sale.invoice_group == null ? null : String(sale.invoice_group), f.sale_id]
        })
      }
      // Only the two freight lines go; the voucher keeps its number, date and
      // every other line exactly as it was.
      const gone = before.filter((l) => isFreight(String(l.account))).map((l) => Number(l.id))
      if (gone.length !== 2) throw new Error(`${f.invoice_no} no longer has exactly one freight pair — nothing was changed`)
      await c.execute({ sql: `DELETE FROM journal_bill_allocs WHERE line_id IN (${gone.join(',')})`, args: [] })
      await c.execute({ sql: `DELETE FROM journal_lines WHERE id IN (${gone.join(',')})`, args: [] })
      const after = await linesOf(id)
      const a = net(before)
      const b = net(after)
      const keys = new Set([...a.keys(), ...b.keys()])
      for (const k of keys) {
        if (Math.abs((a.get(k) || 0) - (b.get(k) || 0)) > TOL) throw new Error(`${f.invoice_no} would change on ${k} — nothing was changed`)
      }
      const diff = after.reduce((t, l) => t + Number(l.dr) - Number(l.cr), 0)
      if (Math.abs(diff) > TOL) throw new Error(`${f.invoice_no} would no longer balance — nothing was changed`)
      freight = round2(freight + f.freight)
    }
    return { fixed: wanted.size, freight }
  })
}

// ── SHARED PARTY LEDGERS ─────────────────────────────────────────────────────
//
// A customer's sale invoices posted into a SUPPLIER's ledger (or a supplier's
// bills into a customer's), because the two names met — the same name, or a
// rename redirect that carried one into the other. BUNGE INDIA PVT LTD(OIL PUR)
// held 87 Bunge sales beside the 15 purchases; LEGACY COMMODITIES PRIVATE
// LTD(RAJKOT) the same. One ledger then nets what we are owed against what we
// owe and reports neither.
//
// Each such line moves to the party's own ledger — the one the posting rule
// (partyLedgers.ts) now gives it, so later invoices land in the same place.
// Lines are recognised by what they ARE, since the redirect that caused it may
// be gone: the debit on a party ledger in a sale voucher is the customer's;
// the credit in a purchase bill is the supplier's; a note's lines follow the
// note's own party. Receipts, payments and journals on the ledger stay where
// they are and are listed, for a person to judge.

export interface SharedLedgerFinding {
  key: string
  ledger_id: number
  ledger: string
  ledger_side: 'debtor' | 'creditor'
  moving: 'customer' | 'supplier'
  party: string
  target: string
  target_exists: boolean
  entries: number
  line_ids: number[]
  net: number
  staying: { entries: number; net: number }
  review?: string
}

async function scanSharedLedgers(): Promise<SharedLedgerFinding[]> {
  const c = getClient()
  const { partySideOfGroup, partyAccountName } = await import('./partyLedgers')
  const accts = (await c.execute('SELECT id, name, acc_group FROM ledger_accounts')).rows as unknown as Row[]
  const sideOf = new Map<number, 'debtor' | 'creditor'>()
  const groupSide = new Map<string, 'debtor' | 'creditor' | null>()
  for (const a of accts) {
    const g = String(a.acc_group || '')
    if (!groupSide.has(g)) {
      const s = await partySideOfGroup(g)
      groupSide.set(g, s ? (s === 'SUNDRY DEBTORS' ? 'debtor' : 'creditor') : null)
    }
    const s = groupSide.get(g)
    if (s) sideOf.set(Number(a.id), s)
  }
  if (!sideOf.size) return []
  const nameOf = new Map(accts.map((a) => [Number(a.id), String(a.name)]))
  // Every line on a party ledger, with what its voucher belongs to.
  const rows = (
    await c.execute(`
      SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.dr, jl.cr,
             je.sale_id, je.order_id,
             (SELECT TRIM(cu.name) FROM sales s JOIN customers cu ON cu.id = s.customer_id WHERE s.id = je.sale_id) AS sale_party,
             (SELECT TRIM(su.name) FROM orders o JOIN suppliers su ON su.id = o.supplier_id WHERE o.id = je.order_id) AS order_party,
             (SELECT nt.party_type FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS note_kind,
             (SELECT CASE nt.party_type WHEN 'customer' THEN (SELECT TRIM(name) FROM customers WHERE id = nt.party_id)
                                        WHEN 'supplier' THEN (SELECT TRIM(name) FROM suppliers WHERE id = nt.party_id) END
                FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS note_party
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id`)
  ).rows as unknown as Row[]
  const groups = new Map<string, { ledger: number; moving: 'customer' | 'supplier'; party: string; lines: number[]; entries: Set<number>; net: number }>()
  const staying = new Map<number, { entries: Set<number>; net: number }>()
  const touched = new Set<number>()
  for (const r of rows) {
    const lid = Number(r.account_id)
    const side = sideOf.get(lid)
    if (!side) continue
    let moving: 'customer' | 'supplier' | null = null
    let party = ''
    if (side === 'creditor' && r.sale_id != null && Number(r.dr) > 0 && r.sale_party) {
      moving = 'customer'
      party = String(r.sale_party)
    } else if (side === 'debtor' && r.order_id != null && Number(r.cr) > 0 && r.order_party) {
      moving = 'supplier'
      party = String(r.order_party)
    } else if (side === 'creditor' && r.note_kind === 'customer' && r.note_party) {
      moving = 'customer'
      party = String(r.note_party)
    } else if (side === 'debtor' && r.note_kind === 'supplier' && r.note_party) {
      moving = 'supplier'
      party = String(r.note_party)
    }
    if (!moving) continue
    touched.add(lid)
    const key = `${lid}|${moving}|${party.toUpperCase()}`
    const g = groups.get(key) || { ledger: lid, moving, party, lines: [], entries: new Set<number>(), net: 0 }
    g.lines.push(Number(r.line_id))
    g.entries.add(Number(r.entry_id))
    g.net = round2(g.net + Number(r.dr) - Number(r.cr))
    groups.set(key, g)
  }
  if (!groups.size) return []
  // What else sits on those ledgers that is neither invoice, bill nor note.
  const moved = new Set([...groups.values()].flatMap((g) => g.lines))
  for (const r of rows) {
    const lid = Number(r.account_id)
    if (!touched.has(lid) || moved.has(Number(r.line_id))) continue
    if (r.sale_id != null || r.order_id != null || r.note_kind) continue
    const s = staying.get(lid) || { entries: new Set<number>(), net: 0 }
    s.entries.add(Number(r.entry_id))
    s.net = round2(s.net + Number(r.dr) - Number(r.cr))
    staying.set(lid, s)
  }
  const out: SharedLedgerFinding[] = []
  for (const [key, g] of groups) {
    const group = g.moving === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors'
    const target = String(await partyAccountName(g.party, group)).trim().toUpperCase()
    const tgt = (await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [target] })).rows[0] as Row | undefined
    const ledgerName = String(nameOf.get(g.ledger) || '')
    const st = staying.get(g.ledger)
    out.push({
      key,
      ledger_id: g.ledger,
      ledger: ledgerName,
      ledger_side: sideOf.get(g.ledger) as 'debtor' | 'creditor',
      moving: g.moving,
      party: g.party,
      target,
      target_exists: !!tgt,
      entries: g.entries.size,
      line_ids: g.lines,
      net: g.net,
      staying: { entries: st ? st.entries.size : 0, net: st ? st.net : 0 },
      review: target === ledgerName.trim().toUpperCase() ? 'Its own ledger would be this same one — rename one of the two masters first' : undefined
    })
  }
  return out.sort((a, b) => a.ledger.localeCompare(b.ledger) || a.party.localeCompare(b.party))
}

/** Every customer posting in a supplier's ledger and the other way round — read only. */
export async function previewSharedLedgers(): Promise<{ findings: SharedLedgerFinding[]; fixable: number; lines: number }> {
  const findings = await scanSharedLedgers()
  const ok = findings.filter((f) => !f.review)
  return { findings, fixable: ok.length, lines: ok.reduce((t, f) => t + f.line_ids.length, 0) }
}

/** Move the listed findings' lines to each party's own ledger. Refuses anything a fresh scan no longer offers. */
export async function fixSharedLedgers(keys: string[]): Promise<{ fixed: number; lines: number; ledgers: string[] }> {
  const wanted = new Set((keys || []).map(String).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the ledgers to split')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const findings = await scanSharedLedgers()
    const allowed = new Map(findings.filter((f) => !f.review).map((f) => [f.key, f]))
    const stale = [...wanted].filter((k) => !allowed.has(k))
    if (stale.length) throw new Error(`${stale.length} ${stale.length === 1 ? 'ledger has' : 'ledgers have'} changed since the list was shown — check again`)
    const { getOrCreateAccount } = await import('./journal')
    let lines = 0
    const made: string[] = []
    for (const k of wanted) {
      const f = allowed.get(k) as SharedLedgerFinding
      const group = f.moving === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors'
      // Created under the party's own side; one that exists is used as it is.
      const targetId = await getOrCreateAccount(f.target, group)
      if (targetId === f.ledger_id) throw new Error(`${f.party} would move into the ledger it is already in — nothing was changed`)
      const ids = f.line_ids.map(Number).join(',')
      const before = (await c.execute(`SELECT * FROM journal_lines WHERE id IN (${ids})`)).rows.map((x) => ({ ...x }))
      await c.execute({
        sql: 'INSERT OR IGNORE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [
          `shared-ledger-v1:${f.ledger_id}:${f.moving}:${f.party.toUpperCase()}:${Date.now()}`,
          Number((before[0] as Row | undefined)?.entry_id || 0),
          JSON.stringify({ finding: f, target_id: targetId, lines: before })
        ]
      })
      // Only which ledger the lines sit in changes: amounts, vouchers and
      // numbers are untouched, so every voucher still balances.
      await c.execute(`UPDATE journal_lines SET account_id = ${Number(targetId)} WHERE id IN (${ids}) AND account_id = ${Number(f.ledger_id)}`)
      await c.execute(`UPDATE journal_bill_allocs SET account_id = ${Number(targetId)} WHERE line_id IN (${ids})`)
      lines += f.line_ids.length
      if (!made.includes(f.target)) made.push(f.target)
    }
    return { fixed: wanted.size, lines, ledgers: made }
  })
}

// ---------------------------------------------------------------------------
// VOUCHERS FILED IN THE OTHER COMPANY'S BOOKS.
//
// A purchase posted its voucher into whichever company the desk had open, not
// the company the purchase belongs to. An inter-company transfer is raised from
// the SELLER's books — KR FINMARK selling to KR FOODS makes KR FOODS' purchase
// while KR FINMARK is open — so every such purchase voucher landed in KR
// FINMARK's books: KR FOODS' ledger for KR FINMARK stayed empty, and KR
// FINMARK carried a creditor for itself. (Fixed at the source: the voucher now
// takes the purchase's own company.)
//
// Moving one changes only which company's books it is in, and its voucher
// number becomes the next in that company's series. Lines, amounts, dates and
// the document it belongs to are untouched; the old state is logged.
// ---------------------------------------------------------------------------

const plainRows = (r: { rows: unknown[] }): Row[] => r.rows.map((x) => ({ ...(x as Row) }))

export interface WrongCompanyFinding {
  entry_id: number
  code: string
  vch_type: string
  vch_no: string
  date: string
  amount: number
  party: string
  doc: 'purchase' | 'sale'
  doc_no: string
  from_company_id: number
  from_company: string
  to_company_id: number
  to_company: string
}

async function scanWrongCompany(): Promise<WrongCompanyFinding[]> {
  const c = getClient()
  const names = new Map(plainRows(await c.execute('SELECT id, name FROM companies')).map((r) => [Number(r.id), String(r.name)]))
  const rows = plainRows(
    await c.execute(`
      SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.company_id AS from_co, o.company_id AS to_co, 'purchase' AS doc, o.invoice_no AS doc_no,
             (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
        FROM journal_entries je JOIN orders o ON o.id = je.order_id
       WHERE o.company_id IS NOT NULL AND je.company_id <> o.company_id
      UNION ALL
      SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.company_id, s.company_id, 'sale', s.invoice_no,
             (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id)
        FROM journal_entries je JOIN sales s ON s.id = je.sale_id
       WHERE s.company_id IS NOT NULL AND je.company_id <> s.company_id
       ORDER BY 2, 1`)
  )
  const out: WrongCompanyFinding[] = []
  for (const r of rows) {
    const ls = plainRows(
      await c.execute({
        sql: 'SELECT a.name, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?',
        args: [Number(r.id)]
      })
    )
    const party =
      String(r.doc) === 'purchase'
        ? ls.filter((l) => Number(l.cr) > 0).sort((a, b) => Number(b.cr) - Number(a.cr))[0]
        : ls.filter((l) => Number(l.dr) > 0).sort((a, b) => Number(b.dr) - Number(a.dr))[0]
    out.push({
      entry_id: Number(r.id),
      code: String(r.code || ''),
      vch_type: String(r.vch_type || ''),
      vch_no: String(r.vch_no || ''),
      date: String(r.entry_date || '').slice(0, 10),
      amount: round2(ls.reduce((t, l) => t + Number(l.dr || 0), 0)),
      party: party ? String(party.name) : '',
      doc: String(r.doc) === 'sale' ? 'sale' : 'purchase',
      doc_no: String(r.doc_no || ''),
      from_company_id: Number(r.from_co),
      from_company: names.get(Number(r.from_co)) || `Company ${r.from_co}`,
      to_company_id: Number(r.to_co),
      to_company: names.get(Number(r.to_co)) || `Company ${r.to_co}`
    })
  }
  return out
}

/** Every purchase or sale voucher sitting in another company's books than its document — read only. */
export async function previewWrongCompany(): Promise<{ findings: WrongCompanyFinding[]; amount: number }> {
  const findings = await scanWrongCompany()
  return { findings, amount: round2(findings.reduce((t, f) => t + f.amount, 0)) }
}

/** Move the listed vouchers into their document's company. Refuses any a fresh scan no longer shows. */
export async function moveWrongCompany(entryIds: number[]): Promise<{ moved: number; codes: string[] }> {
  const wanted = new Set((entryIds || []).map(Number).filter(Boolean))
  if (!wanted.size) throw new Error('Pick the vouchers to move')
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const findings = await scanWrongCompany()
    const by = new Map(findings.map((f) => [f.entry_id, f]))
    const stale = [...wanted].filter((id) => !by.has(id))
    if (stale.length) throw new Error(`${stale.length} voucher${stale.length === 1 ? ' has' : 's have'} changed since the list was shown — check again`)
    const codes: string[] = []
    for (const f of findings.filter((x) => wanted.has(x.entry_id))) {
      const num = (await c.execute({ sql: 'SELECT prefix, serial FROM voucher_numbers WHERE entry_id = ?', args: [f.entry_id] })).rows[0] as Row | undefined
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`wrong-company:${f.entry_id}`, f.entry_id, JSON.stringify({ company_id: f.from_company_id, code: f.code, to_company_id: f.to_company_id })]
      })
      await c.execute({ sql: 'UPDATE journal_entries SET company_id = ? WHERE id = ?', args: [f.to_company_id, f.entry_id] })
      if (num) {
        const pre = String(num.prefix)
        const nx = Number(
          (await c.execute({ sql: 'SELECT COALESCE(MAX(serial), 0) + 1 AS nx FROM voucher_numbers WHERE company_id = ? AND prefix = ?', args: [f.to_company_id, pre] }))
            .rows[0]?.nx || 1
        )
        await c.execute({ sql: 'UPDATE voucher_numbers SET company_id = ?, serial = ? WHERE entry_id = ?', args: [f.to_company_id, nx, f.entry_id] })
        codes.push(`${pre}/${nx}`)
      }
    }
    return { moved: wanted.size, codes }
  })
}

// ---------------------------------------------------------------------------
// VOUCHERS A PAISA OUT OF BALANCE — reviewed in Settings → Accounting checks.
//
// CGST and SGST are each exactly half and each stored to the paisa, so a sale
// whose GST ended in a half paisa (66,486.995) posted heads of 66,487.00 while
// the customer was debited off the unsplit figure: Dr and Cr a paisa apart.
// The posting now lets the round off take that paisa (postSaleInvoiceJournal);
// this settles the vouchers written before. Only the ROUND OFF A/C line moves —
// by the difference, the customer's debit and every other line stay as they
// are — and a voucher with no round-off line gets one. Up to five paise only:
// anything larger is not rounding, and is listed for review instead.
// ---------------------------------------------------------------------------
export async function previewPaisaImbalance(): Promise<{ findings: Row[] }> {
  const c = getClient()
  const res = await c.execute(`
    SELECT je.id, je.company_id, je.entry_date, je.vch_type, je.vch_no,
           ROUND(SUM(jl.dr), 2) AS dr, ROUND(SUM(jl.cr), 2) AS cr,
           (SELECT name FROM companies WHERE id = je.company_id) AS company
      FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
     GROUP BY je.id
    HAVING ABS(ROUND(SUM(jl.dr), 2) - ROUND(SUM(jl.cr), 2)) >= 0.005
     ORDER BY je.entry_date, je.id`)
  const findings = (res.rows as unknown as Row[]).map((r) => {
    const diff = Math.round((Number(r.dr) - Number(r.cr)) * 100) / 100
    return {
      entry_id: Number(r.id),
      company: String(r.company || ''),
      date: String(r.entry_date || '').slice(0, 10),
      type: String(r.vch_type || ''),
      vch_no: String(r.vch_no || ''),
      dr: Number(r.dr),
      cr: Number(r.cr),
      diff,
      review: Math.abs(diff) > 0.05 ? `Out by ${Math.abs(diff).toFixed(2)} — more than rounding; open the voucher and correct it` : null
    }
  })
  return { findings }
}

export async function fixPaisaImbalance(ids: number[]): Promise<{ fixed: number }> {
  const pick = new Set((ids || []).map((x) => Number(x)).filter((x) => x > 0))
  if (!pick.size) throw new Error('Pick at least one voucher')
  const { findings } = await previewPaisaImbalance()
  const todo = findings.filter((f) => pick.has(Number(f.entry_id)) && !f.review)
  await ensureLog()
  let fixed = 0
  for (const f of todo) {
    await withDbTransaction(async () => {
      const c = getClient()
      const id = Number(f.entry_id)
      const lines = await c.execute({
        sql: `SELECT jl.id, jl.dr, jl.cr, a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.id`,
        args: [id]
      })
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`paisa_balance:${id}:${Date.now()}`, id, JSON.stringify(lines.rows)]
      })
      // Dr above Cr by d: the round off gives d more on the credit side.
      const d = Math.round((Number(f.dr) - Number(f.cr)) * 100) / 100
      const ro = (lines.rows as unknown as Row[]).find((l) => String(l.name).trim().toUpperCase() === 'ROUND OFF A/C')
      if (ro) {
        const net = Math.round((Number(ro.cr) - Number(ro.dr) + d) * 100) / 100
        await c.execute({
          sql: 'UPDATE journal_lines SET cr = ?, dr = ? WHERE id = ?',
          args: [net > 0 ? net : 0, net < 0 ? -net : 0, Number(ro.id)]
        })
      } else {
        const { getOrCreateAccount } = await import('./journal')
        const acct = await getOrCreateAccount('ROUND OFF A/C', 'Indirect Expenses')
        await c.execute({
          sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
          args: [id, acct, d < 0 ? -d : 0, d > 0 ? d : 0]
        })
      }
    })
    fixed++
  }
  return { fixed }
}
