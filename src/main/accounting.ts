import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getBooksFrom, openingMap } from './openings'
import { getOrCreateAccount, postJournal, type JournalLine } from './journal'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const round2 = (v: number): number => Math.round(v * 100) / 100
const todayISO = (): string => {
  const d = new Date()
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// ---------------------------------------------------------------------------
// Tally's standard ledger groups, with the side of the books each belongs to.
// acc_group on ledger_accounts stores the group name; anything unknown is
// treated as an asset so it still shows up rather than vanishing.
// ---------------------------------------------------------------------------

export type GroupNature = 'asset' | 'liability' | 'income' | 'expense'

export const TALLY_GROUPS: { name: string; nature: GroupNature }[] = [
  { name: 'Capital Account', nature: 'liability' },
  { name: 'Reserves & Surplus', nature: 'liability' },
  { name: 'Loans (Liability)', nature: 'liability' },
  { name: 'Secured Loans', nature: 'liability' },
  { name: 'Unsecured Loans', nature: 'liability' },
  { name: 'Bank OD A/c', nature: 'liability' },
  { name: 'Current Liabilities', nature: 'liability' },
  { name: 'Duties & Taxes', nature: 'liability' },
  { name: 'Provisions', nature: 'liability' },
  { name: 'Sundry Creditors', nature: 'liability' },
  { name: 'Fixed Assets', nature: 'asset' },
  { name: 'Investments', nature: 'asset' },
  { name: 'Current Assets', nature: 'asset' },
  { name: 'Bank Accounts', nature: 'asset' },
  { name: 'Cash-in-Hand', nature: 'asset' },
  { name: 'Deposits (Asset)', nature: 'asset' },
  { name: 'Loans & Advances (Asset)', nature: 'asset' },
  { name: 'Stock-in-Hand', nature: 'asset' },
  { name: 'Sundry Debtors', nature: 'asset' },
  { name: 'Sales Accounts', nature: 'income' },
  { name: 'Direct Incomes', nature: 'income' },
  { name: 'Indirect Incomes', nature: 'income' },
  { name: 'Purchase Accounts', nature: 'expense' },
  { name: 'Direct Expenses', nature: 'expense' },
  { name: 'Indirect Expenses', nature: 'expense' },
  { name: 'General', nature: 'asset' }
]

export function groupNature(group: string): GroupNature {
  return TALLY_GROUPS.find((g) => g.name === String(group || ''))?.nature || 'asset'
}

const CASH_BANK_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']

// Groups with the ledgers under them and their live balances — the "List of
// Accounts" screen.
export async function listGroups(companyId?: number): Promise<Row[]> {
  const res = await getClient().execute({
    args: [companyId || getActiveCompanyId()],
    sql: `
    SELECT a.id, a.name, a.acc_group,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance
    FROM ledger_accounts a ORDER BY a.acc_group, a.name`
  })
  return toPlain(res)
}

// ---------------------------------------------------------------------------
// Manual vouchers (Contra F4 / Payment F5 / Receipt F6 / Journal F7), with
// Tally's own rules about where cash and bank must sit in each type.
// ---------------------------------------------------------------------------

export type VoucherType = 'CONTRA' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'DEBIT NOTE' | 'CREDIT NOTE'

// One bill-wise adjustment on a party line, Tally style. order_id/sale_invoice_group
// are the exact link to the bill being settled when the UI picked one from the
// pending-refs list — ref_name alone (free text) can collide across bills or
// miss entirely when an invoice number is blank or duplicated.
export interface BillAlloc {
  method: 'agst_ref' | 'advance' | 'on_account' | 'new_ref'
  ref_name?: string | null
  order_id?: number | null
  sale_invoice_group?: string | null
  amount: number
}

export interface VoucherInput {
  date: string
  vchType: VoucherType
  vchNo?: string | null
  narration?: string | null
  companyId?: number
  lines: { account: string; group?: string; dr?: number; cr?: number; allocs?: BillAlloc[] }[]
}

async function accountGroupOf(name: string): Promise<string> {
  const res = await getClient().execute({
    sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?',
    args: [String(name || '').trim().toUpperCase()]
  })
  return String(res.rows[0]?.acc_group || '')
}

type LineWithAllocs = JournalLine & { allocs: BillAlloc[] }

async function validateVoucher(v: VoucherInput): Promise<LineWithAllocs[]> {
  const lines = (v.lines || [])
    .map((l) => ({
      account: String(l.account || '').trim(),
      group: l.group,
      dr: n(l.dr),
      cr: n(l.cr),
      allocs: (l.allocs || [])
        .map((a) => ({
          method: a.method,
          ref_name: a.ref_name ? String(a.ref_name).trim() : null,
          order_id: a.order_id ? Number(a.order_id) : null,
          sale_invoice_group: a.sale_invoice_group ? String(a.sale_invoice_group).trim() : null,
          amount: n(a.amount)
        }))
        .filter((a) => a.amount > 0.004)
    }))
    .filter((l) => l.account && (l.dr > 0.004 || l.cr > 0.004))
  if (lines.length < 2) throw new Error('A voucher needs at least one Dr and one Cr line')
  if (lines.some((l) => l.dr > 0.004 && l.cr > 0.004)) {
    throw new Error('A line is either Dr or Cr, not both')
  }
  const dr = lines.reduce((s, l) => s + l.dr, 0)
  const cr = lines.reduce((s, l) => s + l.cr, 0)
  if (Math.abs(dr - cr) > 0.005) {
    throw new Error(`Voucher does not balance — Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)}`)
  }
  if (!v.date) throw new Error('Voucher date is required')

  // Where must cash/bank sit? Contra: both sides. Payment: the credit side
  // (money going out). Receipt: the debit side (money coming in). The check
  // uses the ledger's saved group, falling back to the group sent for
  // ledgers being created by this very voucher.
  const isCashBank = async (l: JournalLine): Promise<boolean> => {
    const g = (await accountGroupOf(l.account)) || String(l.group || '')
    return CASH_BANK_GROUPS.includes(g)
  }
  if (v.vchType === 'CONTRA') {
    for (const l of lines) {
      if (!(await isCashBank(l))) {
        throw new Error(`Contra moves money between cash and bank only — "${l.account}" is neither`)
      }
    }
  } else if (v.vchType === 'PAYMENT') {
    const credits = lines.filter((l) => l.cr > 0.004)
    for (const l of credits) {
      if (!(await isCashBank(l))) {
        throw new Error(`In a Payment the credit side is the cash or bank paying out — "${l.account}" is neither`)
      }
    }
  } else if (v.vchType === 'RECEIPT') {
    const debits = lines.filter((l) => l.dr > 0.004)
    for (const l of debits) {
      if (!(await isCashBank(l))) {
        throw new Error(`In a Receipt the debit side is the cash or bank receiving — "${l.account}" is neither`)
      }
    }
  }
  // Bill-wise details (payment/receipt): when a party line carries them, they
  // must cover the line exactly, and a named method needs its reference.
  for (const l of lines) {
    if (!l.allocs.length) continue
    const total = l.allocs.reduce((s, a) => s + a.amount, 0)
    const lineAmt = l.dr > 0.004 ? l.dr : l.cr
    if (Math.abs(total - lineAmt) > 0.005) {
      throw new Error(
        `Bill-wise details for "${l.account}" total ${total.toFixed(2)} but the line is ${lineAmt.toFixed(2)}`
      )
    }
    for (const a of l.allocs) {
      if (!['agst_ref', 'advance', 'on_account', 'new_ref'].includes(a.method)) {
        throw new Error(`Unknown adjustment method "${a.method}"`)
      }
      if (a.method !== 'on_account' && !a.ref_name) {
        throw new Error(
          `"${l.account}": ${a.method === 'agst_ref' ? 'Agst Ref' : a.method === 'advance' ? 'Advance' : 'New Ref'} needs a reference name`
        )
      }
    }
  }
  return lines
}

// A reference name -> the document it actually names, so an allocation carries
// the id and not only the text. Exported because every writer of an allocation
// (payments, notes, treasury, bill discounting) needs the same answer, and a
// row written without ids can only ever be matched by string.
export async function resolveRefIds(
  refName: string,
  companyId: number,
  side: 'customer' | 'supplier'
): Promise<{ order_id: number | null; sale_invoice_group: string | null }> {
  const ref = String(refName || '').trim()
  if (!ref) return { order_id: null, sale_invoice_group: null }
  const c = getClient()
  if (side === 'supplier') {
    const r = await c.execute({
      sql: 'SELECT id FROM orders WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1',
      args: [companyId, ref.toUpperCase()]
    })
    return { order_id: r.rows.length ? Number(r.rows[0].id) : null, sale_invoice_group: null }
  }
  const r = await c.execute({
    sql: `SELECT COALESCE(invoice_group, invoice_no) AS grp FROM sales
           WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1`,
    args: [companyId, ref.toUpperCase()]
  })
  return { order_id: null, sale_invoice_group: r.rows.length ? String(r.rows[0].grp) : null }
}

// Store bill-wise rows against the freshly written journal lines. The entry's
// lines are re-read in insert order, which matches the validated array.
async function writeAllocs(entryId: number, lines: LineWithAllocs[]): Promise<void> {
  const c = getClient()
  const saved = await c.execute({
    sql: 'SELECT id, account_id FROM journal_lines WHERE entry_id = ? ORDER BY id ASC',
    args: [entryId]
  })
  const cid = getActiveCompanyId()
  for (let i = 0; i < lines.length && i < saved.rows.length; i++) {
    for (const a of lines[i].allocs) {
      // The caller may already know which document it is settling. When it
      // doesn't — it only picked a reference off a dropdown — resolve the name
      // here rather than storing text alone.
      let orderId = a.order_id || null
      let saleGroup = a.sale_invoice_group || null
      if (a.method === 'agst_ref' && a.ref_name && !orderId && !saleGroup) {
        const grp = String(lines[i].group || '')
        const side = grp === 'Sundry Debtors' ? 'customer' : grp === 'Sundry Creditors' ? 'supplier' : null
        if (side) {
          const ids = await resolveRefIds(String(a.ref_name), cid, side)
          orderId = ids.order_id
          saleGroup = ids.sale_invoice_group
        }
      }
      await c.execute({
        sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          Number(saved.rows[i].id),
          Number(saved.rows[i].account_id),
          a.method,
          a.ref_name || null,
          a.amount,
          orderId,
          saleGroup
        ]
      })
    }
  }
}

export async function createVoucher(v: VoucherInput): Promise<{ id: number }> {
  const lines = await validateVoucher(v)
  const res = await postJournal({
    date: v.date,
    vchType: v.vchType,
    vchNo: v.vchNo || null,
    narration: v.narration || null,
    companyId: v.companyId ? n(v.companyId) : undefined,
    lines
  })
  await writeAllocs(res.id, lines)
  return res
}

// Alter a MANUAL voucher in place (same entry id, so its voucher serial in the
// day book does not move). Auto-posted vouchers must be changed through their
// source document.
export async function updateVoucher(id: number, v: VoucherInput): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({
    sql: 'SELECT order_id, sale_id, payment_id FROM journal_entries WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Voucher not found')
  const r = cur.rows[0]
  if (r.order_id != null || r.sale_id != null || r.payment_id != null) {
    throw new Error('This voucher was posted automatically — alter its source document instead')
  }
  const isNote = await c.execute({ sql: 'SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1', args: [id] })
  if (isNote.rows.length) {
    throw new Error('This voucher belongs to a Debit/Credit note — delete the note and enter it afresh')
  }
  const lines = await validateVoucher(v)
  await c.execute({
    sql: 'UPDATE journal_entries SET entry_date = ?, vch_type = ?, vch_no = ?, narration = ? WHERE id = ?',
    args: [v.date, v.vchType, v.vchNo || null, v.narration || null, id]
  })
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group)
    await c.execute({
      sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
      args: [id, accountId, n(l.dr), n(l.cr)]
    })
  }
  await writeAllocs(id, lines)
  return { id }
}

export async function getVoucher(id: number): Promise<Row | null> {
  const c = getClient()
  const e = await c.execute({
    sql: 'SELECT * FROM journal_entries WHERE id = ?',
    args: [id]
  })
  if (!e.rows.length) return null
  const lines = await c.execute({
    sql: `SELECT jl.id, jl.dr, jl.cr, a.name AS account, a.acc_group
          FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? ORDER BY jl.id`,
    args: [id]
  })
  const entry = toPlain(e)[0]
  const noteRef = await c.execute({
    sql: 'SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1',
    args: [id]
  })
  entry.note_id = noteRef.rows.length ? Number(noteRef.rows[0].id) : null
  entry.lines = toPlain(lines)
  for (const l of entry.lines as Row[]) {
    const al = await c.execute({
      sql: 'SELECT method, ref_name, order_id, sale_invoice_group, amount FROM journal_bill_allocs WHERE line_id = ? ORDER BY id',
      args: [Number(l.id)]
    })
    l.allocs = toPlain(al)
  }
  entry.manual = entry.order_id == null && entry.sale_id == null && entry.payment_id == null && entry.note_id == null
  return entry
}

// The Day Book: every voucher in the period, one row each, with the principal
// debit and credit ledgers as Tally shows them.
export async function listVouchers(
  from?: string,
  to?: string,
  vchType?: string | string[],
  companyId?: number
): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const conds = ['je.company_id = ?']
  const args: (string | number)[] = [cid]
  if (from) {
    conds.push('je.entry_date >= ?')
    args.push(from)
  }
  if (to) {
    conds.push('je.entry_date <= ?')
    args.push(to)
  }
  if (vchType) {
    const types = (Array.isArray(vchType) ? vchType : [vchType]).filter(Boolean)
    if (types.length) {
      conds.push(`je.vch_type IN (${types.map(() => '?').join(',')})`)
      args.push(...types)
    }
  }
  const res = await c.execute({
    sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 je.order_id, je.sale_id, je.payment_id,
                 (SELECT nt.id FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS note_id,
                 (SELECT SUM(dr) FROM journal_lines WHERE entry_id = je.id) AS amount,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC LIMIT 1) AS dr_account,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC LIMIT 1) AS cr_account
          FROM journal_entries je
          WHERE ${conds.join(' AND ')}
          ORDER BY je.entry_date DESC, je.id DESC`,
    args
  })
  const rows = toPlain(res)
  for (const r of rows) r.manual = r.order_id == null && r.sale_id == null && r.payment_id == null && r.note_id == null
  return rows
}

// Trial balance as on a date (or over a period with an opening column):
// per-ledger closing Dr/Cr, grouped by acc_group, plus group subtotals — the
// grand totals must agree or the books are broken.
export async function trialBalance(from?: string, to?: string, companyId?: number): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  // The books' own start, and the opening each ledger was given as at that
  // date. Everything before the cutoff is excluded and the entered figure
  // stands in its place — otherwise the pre-book entries would be counted
  // twice, once as themselves and once inside the opening.
  const booksFrom = await getBooksFrom(cid)
  const entered = await openingMap(cid)
  const period = async (lo?: string, hi?: string): Promise<Map<number, { dr: number; cr: number }>> => {
    const conds = ['je.company_id = ?']
    const args: (string | number)[] = [cid]
    if (booksFrom) {
      conds.push('je.entry_date >= ?')
      args.push(booksFrom)
    }
    if (lo) {
      conds.push('je.entry_date >= ?')
      args.push(lo)
    }
    if (hi) {
      conds.push('je.entry_date <= ?')
      args.push(hi)
    }
    const res = await c.execute({
      sql: `SELECT jl.account_id AS aid, SUM(jl.dr) AS dr, SUM(jl.cr) AS cr
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE ${conds.join(' AND ')} GROUP BY jl.account_id`,
      args
    })
    const m = new Map<number, { dr: number; cr: number }>()
    for (const r of res.rows) m.set(Number(r.aid), { dr: n(r.dr), cr: n(r.cr) })
    return m
  }

  const accounts = toPlain(await c.execute('SELECT id, name, acc_group FROM ledger_accounts ORDER BY acc_group, name'))
  const [inPeriod, before] = await Promise.all([
    period(from, to),
    from ? period(undefined, dayBefore(from)) : Promise.resolve(new Map<number, { dr: number; cr: number }>())
  ])

  const rows: Row[] = []
  for (const a of accounts) {
    const p = inPeriod.get(Number(a.id)) || { dr: 0, cr: 0 }
    const o = before.get(Number(a.id)) || { dr: 0, cr: 0 }
    // The entered opening seeds the account; the movement between the cutoff
    // and the period start is added on top of it.
    const opening = (entered.get(Number(a.id)) || 0) + o.dr - o.cr
    const closing = opening + p.dr - p.cr
    if (Math.abs(opening) < 0.005 && Math.abs(p.dr) < 0.005 && Math.abs(p.cr) < 0.005) continue
    rows.push({
      id: a.id,
      name: a.name,
      acc_group: a.acc_group,
      nature: groupNature(String(a.acc_group)),
      opening,
      period_dr: p.dr,
      period_cr: p.cr,
      closing,
      closing_dr: closing > 0 ? closing : 0,
      closing_cr: closing < 0 ? -closing : 0
    })
  }
  const totals = {
    opening_dr: rows.reduce((s, r) => s + (r.opening > 0 ? r.opening : 0), 0),
    opening_cr: rows.reduce((s, r) => s + (r.opening < 0 ? -r.opening : 0), 0),
    period_dr: rows.reduce((s, r) => s + r.period_dr, 0),
    period_cr: rows.reduce((s, r) => s + r.period_cr, 0),
    closing_dr: rows.reduce((s, r) => s + r.closing_dr, 0),
    closing_cr: rows.reduce((s, r) => s + r.closing_cr, 0)
  }
  return { rows, totals }
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Pending bill references for a party ledger — what Tally offers under "Agst
// Ref". Supplier bills come from purchase invoices (what we owe), customer
// bills from sale invoices (what they owe), each net of everything already
// allocated against that reference. References created by Advance / New Ref
// lines appear too, so an advance can be settled later.
//
// Real bills carry an exact id (order_id for a purchase — one order is one
// bill; sale_invoice_group for a sale — one invoice can span several `sales`
// rows sharing that group) rather than relying on the invoice_no TEXT alone,
// which can be blank or duplicated across unrelated bills. Advance/New Ref
// entries have no such id — they're a hand-typed name from the start — so
// those stay matched by ref_name as before.
// `side` says which of the party's documents to offer, for a caller that knows:
// a credit note to a customer wants their SALES invoices, a debit note to a
// supplier wants their PURCHASE bills. Left unset, the party's ledger group
// decides, as before.
//
// This matters for a party that trades both ways — Bunge sells us oil and buys
// finished goods, so its ledger sits under Sundry Creditors and the group alone
// would only ever offer purchase bills, hiding every sales invoice from a credit
// note against them.
export async function listPendingRefs(
  accountName: string,
  companyId?: number,
  side?: 'customer' | 'supplier'
): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const name = String(accountName || '').trim().toUpperCase()
  if (!name) return []
  // TRIM both sides. The incoming name is trimmed, so a master name carrying
  // a trailing space could never match it — and a few do, which made every
  // one of that party's invoices invisible here.
  const acc = await c.execute({ sql: 'SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?', args: [name] })
  // A party with no ledger account yet still has documents worth offering when
  // the caller has told us which side to look at — a trading-only customer
  // never posts to these books, so no account exists for it.
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0
  if (!accountId && !side) return []
  const group = side === 'customer' ? 'Sundry Debtors' : side === 'supplier' ? 'Sundry Creditors' : String(acc.rows[0]?.acc_group || '')

  type Bill = { ref: string; bill_date: string; amount: number; order_id: number | null; sale_invoice_group: string | null }
  const bills: Bill[] = []
  if (group === 'Sundry Creditors') {
    const r = await c.execute({
      sql: `SELECT o.id AS order_id, o.invoice_no AS ref, o.order_date AS bill_date, o.net_amount AS amount
            FROM orders o JOIN suppliers s ON s.id = o.supplier_id
            WHERE o.company_id = ? AND TRIM(UPPER(s.name)) = ? AND o.invoice_no IS NOT NULL AND o.invoice_no != ''`,
      args: [cid, name]
    })
    for (const b of toPlain(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ''), amount: n(b.amount), order_id: n(b.order_id), sale_invoice_group: null })
    }
  } else if (group === 'Sundry Debtors') {
    const r = await c.execute({
      // Match the CUSTOMER MASTER's name first, falling back to the sale's own
      // free-text customer field. Matching the free text alone made every
      // invoice booked against a customer record with that text blank or
      // spelled differently invisible here — whole customers offered no
      // invoices at all to a credit note.
      sql: `SELECT COALESCE(s.invoice_group, s.invoice_no) AS grp, MIN(s.invoice_no) AS ref, MIN(s.sale_date) AS bill_date,
                   SUM(s.amount + s.gst_amount + s.round_off) AS amount
            FROM sales s
            LEFT JOIN customers cu ON cu.id = s.customer_id
            WHERE s.company_id = ? AND TRIM(UPPER(COALESCE(cu.name, s.customer, ''))) = ?
              AND s.invoice_no IS NOT NULL AND s.invoice_no != ''
            GROUP BY grp`,
      args: [cid, name]
    })
    for (const b of toPlain(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ''), amount: n(b.amount), order_id: null, sale_invoice_group: String(b.grp) })
    }
  }

  // A real bill's ref name, before anything hand-typed can touch it — a New
  // Ref/Advance that happens to spell the same name as an actual invoice must
  // never inflate that invoice's total, only its own separate running total.
  const realRefs = new Set(bills.map((b) => b.ref))

  // References this ledger's vouchers created (advances, opening bills) — no
  // id of their own, so still grouped and matched purely by name.
  const made = await c.execute({
    sql: `SELECT ba.ref_name AS ref, MIN(je.entry_date) AS bill_date, SUM(ba.amount) AS amount
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method IN ('advance', 'new_ref') AND ba.ref_name IS NOT NULL
          GROUP BY ba.ref_name`,
    args: [accountId, cid]
  })
  const madeRows: Bill[] = []
  for (const m of toPlain(made)) {
    if (realRefs.has(String(m.ref))) {
      // Don't just drop it — a colliding New Ref/Advance is a real amount
      // someone allocated, it just can't share the real bill's row. Keep it
      // visible as its own flagged line so it gets reconciled, not lost.
      madeRows.push({ ref: `${m.ref} (duplicate ref — check this)`, bill_date: String(m.bill_date || ''), amount: n(m.amount), order_id: null, sale_invoice_group: null })
      continue
    }
    madeRows.push({ ref: String(m.ref), bill_date: String(m.bill_date || ''), amount: n(m.amount), order_id: null, sale_invoice_group: null })
  }

  // Every settlement against this ledger, fetched once — matched per bill
  // below by whichever key that bill actually has (id first, name as the
  // fallback for entries with no id, e.g. advances).
  const settled = await c.execute({
    sql: `SELECT ba.ref_name AS ref, ba.order_id AS order_id, ba.sale_invoice_group AS sale_invoice_group,
                 ba.amount AS amount, je.entry_date, je.vch_type, je.vch_no, je.narration
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method = 'agst_ref'
          ORDER BY je.entry_date, je.id`,
    args: [accountId, cid]
  })
  const settledRows = toPlain(settled)
  // A settlement carrying an id matches its bill by that id. One carrying NONE
  // — a credit/debit note booked against an invoice number, an advance, an
  // opening bill — can only be matched by the name it names. That branch used
  // to also demand the BILL had no ids, and a sales invoice always has an
  // invoice_group, so a credit note raised against one never matched it: the
  // invoice stayed fully pending and the note fell through to On Account.
  const sameRef = (a: unknown, b: unknown): boolean =>
    String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
  const matches = (s2: Row, b: Bill): boolean => {
    const hasIds = !!s2.order_id || !!s2.sale_invoice_group
    if (hasIds) {
      if (b.order_id != null && n(s2.order_id) === b.order_id) return true
      if (b.sale_invoice_group != null && String(s2.sale_invoice_group || '') === b.sale_invoice_group) return true
      return false
    }
    return sameRef(s2.ref, b.ref)
  }
  // Every voucher that settled this bill, not just the total — a bill-wise
  // view has to be able to answer "paid by what" as well as "how much".
  const settlementsFor = (b: Bill): Row[] => {
    const out: Row[] = []
    for (const s of settledRows) {
      if (matches(s, b)) {
        out.push({
          entry_date: s.entry_date,
          vch_type: s.vch_type,
          vch_no: s.vch_no,
          narration: s.narration,
          amount: round2(n(s.amount))
        })
      }
    }
    return out
  }

  return [...bills, ...madeRows]
    .map((b) => {
      const settlements = settlementsFor(b)
      const paid = round2(settlements.reduce((t, x) => t + n(x.amount), 0))
      return {
        ref: b.ref,
        bill_date: b.bill_date,
        amount: n(b.amount),
        order_id: b.order_id,
        sale_invoice_group: b.sale_invoice_group,
        paid,
        settlements,
        pending: round2(n(b.amount) - paid)
      }
    })
    .filter((b) => b.pending > 0.005)
    .sort((a, b) => a.bill_date.localeCompare(b.bill_date))
}

// ---------------------------------------------------------------------------
// Bills Outstanding for one party, the way Tally's "Ledger Voucher Outstanding"
// reads: a line per bill with what it was raised for, what is still open, when
// it falls due, and how long it has been overdue — then a sub total, and an
// "On Account" line for the part of the balance no bill claims.
//
// On Account is DERIVED (closing balance less the open bills) rather than
// summed from on-account allocations. That way the report always ties to the
// ledger it is reporting on: anything the bills do not explain has to be
// on account by definition, including a payment entered before its invoice.
// ---------------------------------------------------------------------------
export async function billsOutstanding(
  accountName: string,
  companyId?: number,
  opts: { asOf?: string; side?: 'customer' | 'supplier' } = {}
): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const name = String(accountName || '').trim().toUpperCase()
  if (!name) return { rows: [], on_account: 0, total_opening: 0, total_pending: 0, as_of: opts.asOf || todayISO() }
  const asOf = String(opts.asOf || todayISO()).slice(0, 10)

  const acc = await c.execute({
    sql: 'SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?',
    args: [name]
  })
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0
  const group = String(acc.rows[0]?.acc_group || '')
  // Which way round this party's balance runs, so Dr/Cr reads correctly.
  const debtor = opts.side === 'customer' || group === 'Sundry Debtors'

  // The credit period the party was granted, for the due date.
  const master = debtor ? 'customers' : 'suppliers'
  const cp = await c.execute({
    sql: `SELECT credit_period_days FROM ${master} WHERE TRIM(UPPER(name)) = ? LIMIT 1`,
    args: [name]
  })
  const creditDays = cp.rows.length ? n(cp.rows[0].credit_period_days) : 0

  const bills = await listPendingRefs(accountName, cid, opts.side)
  const dayMs = 86400000
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`)
  const rows = bills
    .filter((b) => String(b.bill_date || '').slice(0, 10) <= asOf)
    .map((b) => {
      const billDate = String(b.bill_date || '').slice(0, 10)
      let dueOn = billDate
      if (billDate && creditDays > 0) {
        const d = new Date(`${billDate}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() + creditDays)
        dueOn = d.toISOString().slice(0, 10)
      }
      const dueMs = dueOn ? Date.parse(`${dueOn}T00:00:00Z`) : NaN
      const overdue = Number.isFinite(dueMs) && asOfMs > dueMs ? Math.floor((asOfMs - dueMs) / dayMs) : 0
      return {
        bill_date: billDate,
        ref: b.ref,
        opening: round2(n(b.amount)),
        paid: round2(n(b.paid)),
        pending: round2(n(b.pending)),
        settlements: Array.isArray(b.settlements) ? b.settlements : [],
        due_on: dueOn,
        overdue_days: overdue,
        order_id: b.order_id,
        sale_invoice_group: b.sale_invoice_group
      }
    })

  // The ledger's own closing balance as at asOf, signed the same way the
  // statement shows it (positive = Dr).
  const balRes = accountId
    ? await c.execute({
        sql: `SELECT ROUND(COALESCE(SUM(jl.dr), 0) - COALESCE(SUM(jl.cr), 0), 2) AS bal
              FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.account_id = ? AND je.company_id = ? AND je.entry_date <= ?`,
        args: [accountId, cid, asOf]
      })
    : null
  const balance = balRes ? n(balRes.rows[0]?.bal) : 0
  const totalPending = round2(rows.reduce((t, r) => t + n(r.pending), 0))
  // A debtor's bills are Dr, a creditor's are Cr — compare like for like before
  // calling the remainder On Account.
  const billsSigned = debtor ? totalPending : -totalPending
  const onAccount = round2(balance - billsSigned)

  return {
    as_of: asOf,
    debtor,
    credit_days: creditDays,
    rows,
    total_opening: round2(rows.reduce((t, r) => t + n(r.opening), 0)),
    total_paid: round2(rows.reduce((t, r) => t + n(r.paid), 0)),
    total_pending: totalPending,
    balance: round2(balance),
    on_account: onAccount
  }
}

// Turnover per oil, over a period: what was loaded in (purchases) against
// what went out (sales) — quantity and value both, so this doubles as the
// oil-loading figures and the trading/turnover account in one table instead
// of two disconnected screens.
export async function tradingAccount(from?: string, to?: string, companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const f = from || '0000-01-01'
  const t = to || '9999-12-31'

  const purchases = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(COALESCE(o.received_qty, o.ordered_qty)) AS qty, SUM(o.taxable_value) AS value
          FROM orders o JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ? AND o.order_date BETWEEN ? AND ?
          GROUP BY code`,
    args: [cid, f, t]
  })

  const sales = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(s.qty) AS qty, SUM(s.amount) AS value
          FROM sales s JOIN products p ON p.id = s.product_id
          WHERE s.company_id = ? AND s.sale_date BETWEEN ? AND ? AND s.status = 'done'
          GROUP BY code`,
    args: [cid, f, t]
  })

  const m = new Map<string, Row>()
  for (const r of toPlain(purchases)) {
    m.set(String(r.code), {
      code: r.code, name: r.name,
      purchase_qty: n(r.qty), purchase_value: n(r.value),
      sale_qty: 0, sale_value: 0
    })
  }
  for (const r of toPlain(sales)) {
    const key = String(r.code)
    const g = m.get(key) || { code: key, name: r.name, purchase_qty: 0, purchase_value: 0, sale_qty: 0, sale_value: 0 }
    g.sale_qty = n(r.qty)
    g.sale_value = n(r.value)
    m.set(key, g)
  }
  const list: Row[] = Array.from(m.values()).map((g) => ({
    ...g,
    gross: Math.round((n(g.sale_value) - n(g.purchase_value)) * 100) / 100
  }))
  return list.sort((a, b) => String(a.code).localeCompare(String(b.code)))
}
