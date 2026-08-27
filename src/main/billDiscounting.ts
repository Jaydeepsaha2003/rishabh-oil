import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getSetting, setSetting } from './repos'
import { postJournal, type JournalLine } from './journal'

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

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000)
}

// ---------------------------------------------------------------------------
// Bill Discounting (PID/SID): an LC-style facility with no stage machine and
// no invoice link — a bill is opened directly with its own Payment Received
// and Maturity dates, priced against an NBFC's margin/interest/TDS terms.
// PID (Purchase Invoice Discounting) draws against a supplier; SID (Sales
// Invoice Discounting) draws against a customer.
// ---------------------------------------------------------------------------

// Same shape LC's netAvailable() uses — kept here (not just in the renderer)
// so the journal always posts exactly what the screen shows.
export function bdCalc(bd: Row): {
  intDays: number
  marginAmount: number
  openAmount: number
  interestAmount: number
  tdsAmount: number
  netInterest: number
  receiptAmount: number
} {
  const amount = n(bd.amount)
  const from = String(bd.payment_received_date || '').slice(0, 10)
  const to = String(bd.maturity_date || '').slice(0, 10)
  const intDays = from && to ? Math.max(0, daysBetween(from, to)) : 0
  const marginAmount = round2((amount * n(bd.margin_pct)) / 100)
  // What the NBFC actually funds once its margin is held back. Interest runs on
  // THIS, not on the face value of the bills — the margin never left the NBFC,
  // so there is nothing to charge interest on.
  const openAmount = round2(amount - marginAmount)
  // A 360-day year by convention, overridable per record.
  const daysYear = n(bd.days_year) || 360
  const interestAmount = round2((openAmount * n(bd.interest_pct) * intDays) / (100 * daysYear))
  const tdsAmount = round2((interestAmount * n(bd.tds_pct)) / 100)
  // TDS is withheld out of the interest and paid to the department, so it does
  // not come back to us — the NBFC still keeps the interest gross when it nets
  // the payout.
  const netInterest = round2(interestAmount - tdsAmount)
  // What actually hits the bank. Normally the NBFC discounts its interest out
  // of the disbursement, so the payout is the funded amount less the interest —
  // the working sheet's 80,000 - 2,900 = 77,100. With interest upfront the
  // interest is settled separately instead, so the whole funded amount lands
  // and the interest posts on its own voucher when it is reconciled.
  const receiptAmount = bd.interest_upfront ? openAmount : round2(openAmount - interestAmount)
  return { intDays, marginAmount, openAmount, interestAmount, tdsAmount, netInterest, receiptAmount }
}

// Remove one manual journal entry (with its bill-wise rows) — used to
// reverse/re-post a voucher we posted ourselves.
async function dropEntry(entryId?: number | null): Promise<void> {
  if (!entryId) return
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [entryId]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [entryId] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [entryId] })
}

// Settle a journal line against a named bill reference (bill-wise) or leave
// it general (on account) — the same allocation mechanism LC/orders/sales
// already use.
async function allocAgainst(entryId: number, partyName: string, ref: string | null, amount: number): Promise<void> {
  const c = getClient()
  const line = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [entryId, partyName.toUpperCase()]
  })
  if (!line.rows.length) return
  await c.execute({
    sql: 'INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount) VALUES (?, ?, ?, ?, ?)',
    args: [Number(line.rows[0].id), Number(line.rows[0].account_id), ref ? 'agst_ref' : 'on_account', ref, amount]
  })
}

async function loadBd(id: number): Promise<Row> {
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name,
                 s.name AS supplier_name, cu.name AS customer_name
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE bd.id = ?`,
    args: [id]
  })
  if (!res.rows.length) throw new Error('Bill Discounting entry not found')
  return toPlain(res)[0]
}

// How much of a bill has already gone back to the NBFC. Parts are the record
// when there are any; a bill settled in one go before part repayment existed
// has no part rows and keeps its single figure on the parent row, so it is read
// from there rather than being rewritten into the new shape.
async function repaidSoFar(bd: Row): Promise<number> {
  const r = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(amount), 0) AS paid, COUNT(*) AS parts FROM bd_repayments WHERE bd_id = ?',
    args: [Number(bd.id)]
  })
  if (n(r.rows[0].parts) > 0) return round2(n(r.rows[0].paid))
  return String(bd.status) === 'repaid' ? round2(n(bd.repaid_amount)) : 0
}

// Drop every voucher a bill's repayments posted, parts and legacy alike.
async function dropRepayEntries(bd: Row): Promise<void> {
  const c = getClient()
  const parts = await c.execute({ sql: 'SELECT journal_entry_id FROM bd_repayments WHERE bd_id = ?', args: [Number(bd.id)] })
  for (const r of parts.rows) await dropEntry(n(r.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_repayments WHERE bd_id = ?', args: [Number(bd.id)] })
  await dropEntry(n(bd.repay_journal_entry_id) || null)
}

function partyName(bd: Row): string {
  return String(bd.party_type === 'supplier' ? bd.supplier_name : bd.customer_name || '').trim()
}

// Margin/interest/TDS voucher when a bill is opened (skipped if all three —
// and the amount itself — are zero). Mirrors LC's postLcOpening: the NBFC
// funds the discounted amount net of its own deductions; what we owe it back
// at maturity is the full face amount.
export async function postBdOpening(bdId: number): Promise<void> {
  const c = getClient()
  const bd = await loadBd(bdId)
  await dropEntry(n(bd.journal_entry_id) || null)
  // This voucher IS the disbursement -- it debits the bank with what the NBFC
  // paid out. Until the payment is actually received there is no money to
  // debit and no liability to raise, so a bill still awaiting its payment
  // carries no voucher at all. It gets one the moment the receipt is marked.
  if (!bd.payment_received_date) {
    await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?', args: [bdId] })
    return
  }
  const calc = bdCalc(bd)
  // The voucher is what the face amount split into, either way round:
  //   interest discounted  ->  Dr Bank (open - interest) + Dr Margin + Dr Interest
  //   interest upfront     ->  Dr Bank (open)            + Dr Margin
  // both against Cr Bills discounted (the full face amount), so both balance.
  //
  // There is deliberately NO TDS leg here. The NBFC is paid the interest gross
  // out of the disbursement, so nothing is withheld at this point — an earlier
  // version credited TDS and only balanced because the payout wrongly added the
  // same TDS back, which is what produced "Journal not balanced" once the payout
  // was corrected to the sheet's open - interest.
  const upfront = !!bd.interest_upfront
  const interest = upfront ? 0 : calc.interestAmount
  const amount = n(bd.amount)
  if (calc.marginAmount < 0.005 && interest < 0.005 && amount < 0.005) {
    await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?', args: [bdId] })
    return
  }
  const lines: JournalLine[] = [{ account: 'BANK A/C', group: 'Bank Accounts', dr: calc.receiptAmount }]
  if (calc.marginAmount > 0.005) lines.push({ account: 'BD MARGIN A/C', group: 'Deposits (Asset)', dr: calc.marginAmount })
  if (interest > 0.005) lines.push({ account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: interest })
  lines.push({ account: 'BILLS DISCOUNTED A/C', group: 'Loans (Liability)', cr: amount })
  const je = await postJournal({
    date: String(bd.payment_received_date || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no || ''} (${bd.finance_type}) opened with ${bd.nbfc_name || 'the NBFC'} — ` +
      `margin ${calc.marginAmount.toFixed(2)}, interest ${interest.toFixed(2)}` +
      (upfront ? ' (interest settled separately on reconciliation)' : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = ? WHERE id = ?', args: [je.id, bdId] })
}

// Posts the deferred interest + TDS voucher once reconciled from the bank
// statement, for a bill that was opened with interest_upfront — mirrors LC's
// postLcUpfrontInterest. Only reachable for an upfront bill, whose opening
// voucher deliberately left the interest out, so this cannot double-count.
export async function postBdUpfrontInterest(bdId: number, dateIn?: string): Promise<{ id: number } | null> {
  const bd = await loadBd(bdId)
  if (!bd.interest_upfront) throw new Error('This Bill Discounting entry was not opened with interest upfront')
  const calc = bdCalc(bd)
  if (calc.interestAmount < 0.005) return null
  const je = await postJournal({
    date: String(dateIn || todayISO()).slice(0, 10),
    vchType: 'JOURNAL',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} — interest ${calc.interestAmount.toFixed(2)} (TDS ${calc.tdsAmount.toFixed(2)}) settled upfront, per the bank statement`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: calc.interestAmount },
      { account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: calc.tdsAmount },
      { account: 'BANK A/C', group: 'Bank Accounts', cr: calc.netInterest }
    ]
  })
  return { id: je.id }
}

// The margin/security deposit released back as cash once the bill is
// repaid and the NBFC no longer needs it held — mirrors postLcMarginRelease.
async function postBdMarginRelease(bd: Row): Promise<{ id: number } | null> {
  const calc = bdCalc(bd)
  if (calc.marginAmount < 0.005) return null
  const je = await postJournal({
    date: String(bd.repaid_date || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} repaid — margin of ${calc.marginAmount.toFixed(2)} refunded by ${bd.nbfc_name || 'the NBFC'}`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'BANK A/C', group: 'Bank Accounts', dr: calc.marginAmount },
      { account: 'BD MARGIN A/C', group: 'Deposits (Asset)', cr: calc.marginAmount }
    ]
  })
  await getClient().execute({
    sql: 'UPDATE bill_discountings SET margin_release_journal_entry_id = ? WHERE id = ?',
    args: [je.id, n(bd.id)]
  })
  return { id: je.id }
}

const BD_COLS = [
  'bd_no',
  'nbfc_id',
  'finance_type',
  'party_type',
  'party_id',
  'purpose',
  // Who pays US back on a trading bill — the other half of the round trip.
  'receivable_party_id',
  'amount',
  'invoice_amount',
  'payment_received_date',
  'maturity_date',
  'margin_pct',
  'days_year',
  'interest_pct',
  'tds_pct',
  'interest_upfront',
  'note'
]

function bdArgs(v: Row): (string | number | null)[] {
  return BD_COLS.map((k) => {
    if (k === 'interest_upfront') return v[k] ? 1 : 0
    if (k === 'days_year') return n(v[k]) || 360
    if (['amount', 'margin_pct', 'interest_pct', 'tds_pct'].includes(k)) return n(v[k])
    // Optional, and left empty by anyone who does not track it — so blank has
    // to stay blank rather than reading as a zero-value invoice.
    if (k === 'invoice_amount') {
      const val = v[k]
      return val === '' || val === undefined || val === null ? null : n(val)
    }
    if (k === 'nbfc_id' || k === 'receivable_party_id') return v[k] ? n(v[k]) : null
    const val = v[k]
    return val === '' || val === undefined || val === null ? null : String(val)
  })
}

// A purchase invoice belongs to at most one discounted bill at a time — the
// same exclusivity the LC side enforces. Refused rather than silently taken
// away from the bill that already has it.
async function syncBdLinkedOrders(bdId: number, orderIds: unknown): Promise<void> {
  const c = getClient()
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n(x)).filter((x) => x > 0) : []
  if (ids.length) {
    const taken = await c.execute({
      sql: `SELECT bo.order_id, o.invoice_no, b.bd_no
            FROM bd_linked_orders bo
            JOIN orders o ON o.id = bo.order_id
            LEFT JOIN bill_discountings b ON b.id = bo.bd_id
            WHERE bo.order_id IN (${ids.join(',')}) AND bo.bd_id != ?`,
      args: [bdId]
    })
    if (taken.rows.length) {
      const t = taken.rows[0] as Row
      throw new Error(
        `Invoice ${t.invoice_no || `#${t.order_id}`} is already linked to ${t.bd_no ? `bill ${t.bd_no}` : 'another discounted bill'}`
      )
    }
  }
  await c.execute({ sql: 'DELETE FROM bd_linked_orders WHERE bd_id = ?', args: [bdId] })
  for (const oid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO bd_linked_orders (bd_id, order_id) VALUES (?, ?)',
      args: [bdId, oid]
    })
  }
}

// The purchase invoices linked to one bill, for the form.
export async function listBdLinkedOrders(bdId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT bo.order_id, o.invoice_no, o.order_date, o.net_amount, s.name AS supplier_name
          FROM bd_linked_orders bo
          JOIN orders o ON o.id = bo.order_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          WHERE bo.bd_id = ? ORDER BY o.order_date, o.id`,
    args: [bdId]
  })
  return toPlain(res)
}

// Every check a Bill Discounting entry has to pass, on create or edit.
async function validateBd(v: Row): Promise<void> {
  // Every voucher a bill posts is numbered with this — the disbursement, each
  // repayment, the margin release — so a bill without one puts unnumbered
  // vouchers in the ledger and cannot be found by reference afterwards.
  if (!String(v.bd_no ?? '').trim()) throw new Error('Enter the BD no')
  if (!['PID', 'SID'].includes(String(v.finance_type))) throw new Error('Choose PID or SID')
  const partyType = String(v.finance_type) === 'PID' ? 'supplier' : 'customer'
  if (String(v.party_type) !== partyType) throw new Error('Party type must follow the finance type')
  if (!n(v.party_id)) throw new Error(partyType === 'supplier' ? 'Choose the supplier' : 'Choose the customer')
  if (n(v.amount) <= 0) throw new Error('Enter the open amount')
  if (!v.maturity_date) throw new Error('Enter the maturity date')
  // The payment received date is not asked for when the bill is opened -- it is
  // stamped later, when the NBFC's money actually lands -- so it is only
  // checked against the maturity when there IS one.
  if (v.payment_received_date && String(v.maturity_date).slice(0, 10) < String(v.payment_received_date).slice(0, 10)) {
    throw new Error('Maturity date cannot be before the payment received date')
  }
  const table = partyType === 'supplier' ? 'suppliers' : 'customers'
  const party = await getClient().execute({ sql: `SELECT id, active FROM ${table} WHERE id = ?`, args: [n(v.party_id)] })
  if (!party.rows.length) throw new Error('That party no longer exists')
  if (!n(party.rows[0].active)) throw new Error('That party is marked inactive')
}

export async function listBd(filter?: Row): Promise<Row[]> {
  const where: string[] = ['bd.company_id = ?']
  const args: (string | number)[] = [getActiveCompanyId()]
  if (filter?.status) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(String).filter(Boolean)
    if (statuses.length) {
      where.push(`bd.status IN (${statuses.map(() => '?').join(',')})`)
      args.push(...statuses)
    }
  }
  if (filter?.finance_type) {
    where.push('bd.finance_type = ?')
    args.push(String(filter.finance_type))
  }
  if (filter?.nbfc_id) {
    where.push('bd.nbfc_id = ?')
    args.push(n(filter.nbfc_id))
  }
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name, nb.finance_type AS nbfc_finance_type,
                 s.name AS supplier_name, cu.name AS customer_name,
                 COALESCE(rp.paid, 0) AS parts_paid, COALESCE(rp.parts, 0) AS repay_parts,
                 rc.name AS receivable_party_name,
                 -- The purchase invoices this bill funded: the route to the
                 -- trading deal, and through it to the resale invoices.
                 (SELECT COUNT(*) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_invoice_count,
                 (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM bd_linked_orders bo
                    JOIN orders o ON o.id = bo.order_id WHERE bo.bd_id = bd.id) AS linked_invoice_nos,
                 (SELECT GROUP_CONCAT(bo.order_id) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_order_ids_csv,
                 -- What the customer has already paid back on the resale.
                 COALESCE((SELECT SUM(pi.amount) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id), 0) AS payment_in_total,
                 (SELECT COUNT(*) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id) AS payment_in_count
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          LEFT JOIN customers rc ON rc.id = bd.receivable_party_id
          LEFT JOIN (SELECT bd_id, SUM(amount) AS paid, COUNT(*) AS parts
                     FROM bd_repayments GROUP BY bd_id) rp ON rp.bd_id = bd.id
          WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(bd.payment_received_date, bd.created_at) DESC, bd.id DESC`,
    args
  })
  // A part-repaid bill stays OPEN — the facility is still live for what is left
  // — so the screen needs the two figures the status word cannot carry: what
  // has gone back and what is still outstanding.
  return toPlain(res).map((bd) => {
    const parts = n(bd.repay_parts)
    const repaidTotal = round2(
      parts > 0 ? n(bd.parts_paid) : String(bd.status) === 'repaid' ? n(bd.repaid_amount) : 0
    )
    return {
      ...bd,
      party_name: partyName(bd),
      ...bdCalc(bd),
      repaid_total: repaidTotal,
      outstanding_amount: round2(Math.max(0, n(bd.amount) - repaidTotal)),
      repay_parts: parts,
      // Three stages, in the order a bill goes through them: opened and waiting
      // on the NBFC's money, live once it has landed, wound up once repaid.
      // Derived rather than stored, so the payment date stays the single fact
      // that decides it and no row can disagree with its own dates.
      stage: String(bd.status) === 'repaid' ? 'repaid' : bd.payment_received_date ? 'live' : 'awaiting'
    }
  })
}

export async function createBd(v: Row): Promise<{ id: number }> {
  await validateBd(v)
  const res = await getClient().execute({
    sql: `INSERT INTO bill_discountings (company_id, ${BD_COLS.join(', ')}, status)
          VALUES (?, ${BD_COLS.map(() => '?').join(', ')}, 'open')`,
    args: [getActiveCompanyId(), ...bdArgs(v)]
  })
  const id = Number(res.lastInsertRowid)
  // Only when the caller names them — an untouched form must not clear links.
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids)
  await postBdOpening(id)
  return { id }
}

export async function updateBd(id: number, v: Row): Promise<{ id: number }> {
  const cur = await loadBd(id)
  if (String(cur.status) === 'repaid') throw new Error('This bill is already repaid — reopen it first if it needs correcting')
  await validateBd(v)
  // Part of this bill may already have gone back. Cutting the face amount below
  // what has been repaid would leave the facility owing a negative balance, so
  // the repayments have to be undone first.
  const paid = await repaidSoFar(cur)
  if (paid > 0 && n(v.amount) - paid < -0.004) {
    throw new Error(`${inr(paid)} has already been repaid on this bill — the amount cannot be set below that`)
  }
  await getClient().execute({
    sql: `UPDATE bill_discountings SET ${BD_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...bdArgs(v), id]
  })
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids)
  await postBdOpening(id)
  return { id }
}

export async function deleteBd(id: number): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  await dropEntry(n(bd.journal_entry_id) || null)
  await dropRepayEntries(bd)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  // The customer's payments back, and the purchase-invoice links, are part of
  // this bill and mean nothing without it.
  const ins = await c.execute({ sql: 'SELECT journal_entry_id FROM bd_payment_ins WHERE bd_id = ?', args: [id] })
  for (const r of ins.rows) await dropEntry(n(r.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_payment_ins WHERE bd_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bd_linked_orders WHERE bd_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bill_discountings WHERE id = ?', args: [id] })
  return { id }
}

// A rupee figure for a message, so an error reads the way the screen does.
function inr(v: number): string {
  return `Rs ${round2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Repay/settle the bill at (or before) maturity, in full or in parts.
//
// An NBFC rarely insists a discounted bill comes back in one payment — it is
// commonly cleared in instalments over the tenure — so a repayment records the
// amount actually going back rather than assuming the whole face value. Leave
// the amount out and it settles the balance, which is the old behaviour and
// still the ordinary case. Each part is its own dated row with its own
// voucher, so the ledger shows the money leaving when it left rather than in
// one lump at the end, and the bill closes only when the parts add up to it.
//
// `settleVia: 'bank'` posts the payment straight from our own bank; `'party'`
// posts it against the supplier/customer ledger instead — bill-wise (a ref) or
// on account (blank), the same allocation choice LC/orders/sales already use.
export async function repayBd(
  id: number,
  v: {
    repay_date?: string
    settle_via?: 'bank' | 'party'
    ref?: string | null
    release_margin?: boolean
    // What is going back now. Omitted (or blank) means the whole balance.
    amount?: number | string | null
    note?: string | null
  }
): Promise<{ id: number; amount: number; outstanding: number; closed: boolean }> {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is already repaid')
  if (!bd.payment_received_date) {
    throw new Error('Mark the payment received first — there is nothing to repay until the NBFC has funded this bill')
  }
  const face = n(bd.amount)
  const already = await repaidSoFar(bd)
  const due = round2(face - already)
  if (due <= 0.004) throw new Error('There is nothing left to repay on this bill')
  const asked = v.amount === undefined || v.amount === null || String(v.amount).trim() === '' ? due : round2(n(v.amount))
  if (asked <= 0) throw new Error('Enter the amount being repaid')
  if (asked - due > 0.004) {
    throw new Error(
      already > 0
        ? `Only ${inr(due)} is still outstanding on this bill — ${inr(already)} has already been repaid`
        : `That is more than the ${inr(due)} this bill is for`
    )
  }
  const date = String(v.repay_date || todayISO()).slice(0, 10)
  const settleVia = v.settle_via === 'party' ? 'party' : 'bank'
  const party = partyName(bd)
  if (settleVia === 'party' && !party) throw new Error('This bill has no linked party to settle against')
  // What is left AFTER this payment decides whether the bill closes, and it is
  // also what the narration has to say, so the voucher reads as a running
  // balance rather than an unexplained part figure.
  const left = round2(due - asked)
  const closed = left <= 0.004
  const lines: JournalLine[] = [{ account: 'BILLS DISCOUNTED A/C', group: 'Loans (Liability)', dr: asked }]
  if (settleVia === 'party') {
    lines.push({
      account: party,
      group: bd.party_type === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors',
      cr: asked
    })
  } else {
    lines.push({ account: 'BANK A/C', group: 'Bank Accounts', cr: asked })
  }
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no} ${closed && already <= 0.004 ? 'repaid' : closed ? 'closed — final part repayment' : 'part repayment'}` +
      ` to ${bd.nbfc_name || 'the NBFC'}` +
      (closed ? '' : ` — ${inr(left)} still outstanding`) +
      (settleVia === 'party' ? ` — settled against ${party}` : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  if (settleVia === 'party') await allocAgainst(je.id, party, v.ref || null, asked)
  await c.execute({
    sql: `INSERT INTO bd_repayments (bd_id, repay_date, amount, settle_via, ref, journal_entry_id, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, date, asked, settleVia, v.ref ? String(v.ref) : null, je.id, v.note ? String(v.note) : null]
  })
  const paid = round2(already + asked)
  // The bill stays OPEN while anything is outstanding: the facility is still
  // live for the balance, and closing it early would hide it from every open
  // exposure figure on the page.
  await c.execute({
    sql: `UPDATE bill_discountings
          SET status = ?, repaid_date = ?, repaid_amount = ?, repay_journal_entry_id = NULL
          WHERE id = ?`,
    args: [closed ? 'repaid' : 'open', closed ? date : null, paid, id]
  })
  // The margin is held against the whole bill, so it only comes back when the
  // bill is actually cleared — releasing it against a part payment would return
  // money the NBFC is still holding.
  if (v.release_margin && closed) {
    const fresh = await loadBd(id)
    await postBdMarginRelease(fresh)
  }
  return { id, amount: asked, outstanding: left, closed }
}

// The repayments made against one bill, oldest first, with a running balance
// so the screen can show the bill being worked down.
export async function listBdRepayments(bdId: number): Promise<Row[]> {
  const bd = await loadBd(bdId)
  const res = await getClient().execute({
    sql: `SELECT r.*, je.vch_no, je.entry_date AS voucher_date
          FROM bd_repayments r
          LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
          WHERE r.bd_id = ? ORDER BY r.repay_date, r.id`,
    args: [bdId]
  })
  let left = n(bd.amount)
  return toPlain(res).map((r) => {
    left = round2(left - n(r.amount))
    return { ...r, balance_after: left }
  })
}

// Every repayment in the active company, oldest first, for the Excel export's
// second sheet. Deliberately ONE query rather than listBdRepayments per bill:
// the export would otherwise fire a query per row, which is exactly the N+1 the
// rest of this module was cleaned up to avoid.
export async function listAllBdRepayments(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT r.*, bd.bd_no, bd.finance_type, bd.amount AS bill_amount,
                 nb.name AS nbfc_name, s.name AS supplier_name, cu.name AS customer_name,
                 bd.party_type
          FROM bd_repayments r
          JOIN bill_discountings bd ON bd.id = r.bd_id
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE bd.company_id = ?
          ORDER BY bd.bd_no, r.repay_date, r.id`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res).map((r) => ({ ...r, party_name: partyName(r) }))
}

// Undo ONE part repayment — the wrong figure keyed, or a payment that did not
// clear — without disturbing the others. Its voucher goes with it, and a bill
// that was closed by this part reopens for the balance, giving back its margin
// release along with it since the margin is only released on closure.
export async function deleteBdRepayment(repaymentId: number): Promise<{ id: number; bd_id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE id = ?', args: [repaymentId] })
  if (!res.rows.length) throw new Error('That repayment no longer exists')
  const part = toPlain(res)[0]
  const bdId = Number(part.bd_id)
  await dropEntry(n(part.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_repayments WHERE id = ?', args: [repaymentId] })
  const bd = await loadBd(bdId)
  const paid = await repaidSoFar({ ...bd, status: 'open' })
  const closed = n(bd.amount) - paid <= 0.004
  if (!closed && n(bd.margin_release_journal_entry_id)) {
    await dropEntry(n(bd.margin_release_journal_entry_id))
  }
  await c.execute({
    sql: `UPDATE bill_discountings
          SET status = ?, repaid_date = ?, repaid_amount = ?, margin_release_journal_entry_id = ?
          WHERE id = ?`,
    args: [
      closed ? 'repaid' : 'open',
      closed ? String(bd.repaid_date || '').slice(0, 10) || null : null,
      paid > 0 ? paid : null,
      closed ? n(bd.margin_release_journal_entry_id) || null : null,
      bdId
    ]
  })
  return { id: repaymentId, bd_id: bdId }
}

// Stamp the day the NBFC's money actually landed. This is the point the bill
// goes live: the disbursement posts here (bank debited, margin held, interest
// taken, liability raised), and interest starts running from this date, which
// is why it is asked for when it happens rather than guessed at when the bill
// is opened. Re-marking simply moves the date and re-posts to match.
export async function markBdPaymentReceived(id: number, dateIn?: string): Promise<{ id: number; date: string }> {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is already repaid — reopen it first if the receipt date needs correcting')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const maturity = String(bd.maturity_date || '').slice(0, 10)
  if (maturity && date > maturity) {
    throw new Error('The payment cannot be received after the maturity date — check the date')
  }
  await c.execute({ sql: 'UPDATE bill_discountings SET payment_received_date = ? WHERE id = ?', args: [date, id] })
  await postBdOpening(id)
  return { id, date }
}

// Undo the receipt — marked against the wrong bill, or the credit never landed.
// The disbursement voucher goes with it and the bill drops back to awaiting.
// Refused once anything has been repaid: money cannot have gone back on a bill
// that was never funded, so the repayments have to come off first.
export async function unmarkBdPaymentReceived(id: number): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — reopen it first')
  const paid = await repaidSoFar(bd)
  if (paid > 0.004) {
    throw new Error(`${inr(paid)} has already been repaid on this bill — remove the repayments before undoing the receipt`)
  }
  await dropEntry(n(bd.journal_entry_id) || null)
  await c.execute({
    sql: 'UPDATE bill_discountings SET payment_received_date = NULL, journal_entry_id = NULL WHERE id = ?',
    args: [id]
  })
  return { id }
}

export async function reopenBd(id: number): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  await dropRepayEntries(bd)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  await c.execute({
    sql: "UPDATE bill_discountings SET status = 'open', repaid_date = NULL, repaid_amount = NULL, repay_journal_entry_id = NULL, margin_release_journal_entry_id = NULL WHERE id = ?",
    args: [id]
  })
  return { id }
}

// What each NBFC has sanctioned against what is drawn on it, and the same
// combined across all of them.
//
//   utilised  = the outstanding on FUNDED bills (face less what has gone back)
//   available = sanctioned - utilised
//
// Only funded bills count as drawn: a bill still awaiting the NBFC's payment
// has had nothing disbursed, so counting it would show a limit consumed by
// money that has not moved. It is reported separately as `committed` instead,
// because it is money the NBFC has agreed to and will consume the limit the
// moment it lands.
//
// The combined ceiling is a company setting, since it is not any one NBFC's to
// state; when it is unset there is no combined figure to report rather than a
// misleading zero.
export async function bdLimits(): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const res = await c.execute({
    sql: `SELECT nb.id, nb.name, nb.finance_type, nb.active,
                 COALESCE(nb.sanctioned_limit, 0) AS sanctioned,
                 COALESCE((SELECT SUM(bd.amount - COALESCE((SELECT SUM(r.amount) FROM bd_repayments r
                            WHERE r.bd_id = bd.id), 0))
                           FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid' AND bd.payment_received_date IS NOT NULL), 0) AS utilised,
                 COALESCE((SELECT SUM(bd.amount) FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid' AND bd.payment_received_date IS NULL), 0) AS committed,
                 COALESCE((SELECT COUNT(*) FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ? AND bd.status <> 'repaid'), 0) AS open_bills
          FROM nbfcs nb
          WHERE nb.company_id = ?
          ORDER BY nb.active DESC, nb.name COLLATE NOCASE`,
    args: [cid, cid, cid, cid]
  })
  const perNbfc = toPlain(res).map((r) => {
    const sanctioned = round2(n(r.sanctioned))
    const utilised = round2(n(r.utilised))
    return {
      ...r,
      sanctioned,
      utilised,
      committed: round2(n(r.committed)),
      // No sanctioned figure means nothing to be available OUT of — reported as
      // null so the screen can say "not set" rather than showing a negative.
      available: sanctioned > 0 ? round2(sanctioned - utilised) : null,
      used_pct: sanctioned > 0 ? Math.round((utilised / sanctioned) * 1000) / 10 : null
    }
  })
  const combinedRaw = await getSetting(`bd_combined_limit_${cid}`)
  const combined = combinedRaw == null || String(combinedRaw).trim() === '' ? null : round2(n(combinedRaw))
  const utilisedTotal = round2(perNbfc.reduce((t, r) => t + n(r.utilised), 0))
  const sanctionedTotal = round2(perNbfc.reduce((t, r) => t + n(r.sanctioned), 0))
  return {
    per_nbfc: perNbfc,
    // The sum of what each NBFC has sanctioned. Not the same thing as the
    // combined ceiling: a group limit can sit below the sum of its lines.
    sanctioned_sum: sanctionedTotal,
    utilised_total: utilisedTotal,
    committed_total: round2(perNbfc.reduce((t, r) => t + n(r.committed), 0)),
    combined_limit: combined,
    combined_available: combined == null ? null : round2(combined - utilisedTotal),
    combined_used_pct: combined && combined > 0 ? Math.round((utilisedTotal / combined) * 1000) / 10 : null,
    // Worth saying out loud: a group ceiling under the sum of the lines means
    // the lines cannot all be drawn at once.
    lines_exceed_combined: combined != null && sanctionedTotal > combined
  }
}

// The combined ceiling for the active company. Blank clears it.
export async function setBdCombinedLimit(value: number | string | null): Promise<{ value: number | null }> {
  const cid = getActiveCompanyId()
  const raw = value == null || String(value).trim() === '' ? '' : String(round2(n(value)))
  await setSetting(`bd_combined_limit_${cid}`, raw)
  return { value: raw === '' ? null : Number(raw) }
}

// KPI rollup for the page header, mirroring getLcLimit's shape — outstanding
// exposure, margin held, interest and TDS, across every open bill.
export async function bdKpis(): Promise<Row> {
  // Outstanding is what is still owed, not the face value — a bill half repaid
  // is half the exposure it was.
  //
  // And only a FUNDED bill is exposure at all: one still awaiting its payment
  // has no disbursement, no liability posted and no interest running, so
  // counting it here would show money owed that the ledger does not have. Those
  // are reported on their own line instead of being folded in or hidden.
  const all = await listBd({ status: ['open'] })
  const rows = all.filter((r) => String(r.stage) === 'live')
  const awaiting = all.filter((r) => String(r.stage) === 'awaiting')
  return {
    count: rows.length,
    outstanding_total: round2(rows.reduce((s, r) => s + n(r.outstanding_amount), 0)),
    margin_total: round2(rows.reduce((s, r) => s + n(r.marginAmount), 0)),
    interest_total: round2(rows.reduce((s, r) => s + n(r.interestAmount), 0)),
    tds_total: round2(rows.reduce((s, r) => s + n(r.tdsAmount), 0)),
    receipt_total: round2(rows.reduce((s, r) => s + n(r.receiptAmount), 0)),
    awaiting_count: awaiting.length,
    awaiting_total: round2(awaiting.reduce((s, r) => s + n(r.amount), 0))
  }
}
