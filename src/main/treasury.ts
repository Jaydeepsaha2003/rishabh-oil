import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'

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

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Buckets a due date's days-left into the categories the dashboard filters by.
export function duePeriodOf(daysLeft: number | null): string {
  if (daysLeft == null) return 'none'
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= 1) return 't1'
  if (daysLeft <= 7) return 'week'
  if (daysLeft <= 14) return 'fortnight'
  if (daysLeft <= 30) return 'month'
  if (daysLeft <= 90) return 'quarter'
  return 'later'
}

// Remove one manual journal entry (with its bill-wise rows) by id — used to
// reverse treasury vouchers we posted ourselves.
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

// Settle the party line of an entry against a named bill reference.
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

// Which ledger account an LC's bank movements post to. Each of our own
// accounts keeps its own line in the books, so money leaving one bank is
// visible separately from another rather than lumped into one figure. An LC
// with no bank of ours named yet falls back to the single generic account the
// books used before, so nothing is stranded.
// Money that has moved is dated today or earlier. A receipt dated forward is a
// forecast, and the ledger would carry it as fact. Maturity and expiry dates
// are deliberately exempt — those are meant to be ahead of today.
function assertNotFuture(date: string, what: string): void {
  const d = String(date || '').slice(0, 10)
  if (d && d > todayISO()) throw new Error(`${what} cannot be a future date`)
}

async function bankAccountFor(lc: Row): Promise<string> {
  const id = n(lc.our_bank_id)
  if (!id) return 'BANK A/C'
  const r = await getClient().execute({ sql: 'SELECT name FROM banks WHERE id = ?', args: [id] })
  const name = String(r.rows[0]?.name || '').trim()
  return name ? `${name.toUpperCase()} A/C` : 'BANK A/C'
}

// ---------------------------------------------------------------------------
// Letter of Credit: open charges, usance due dates, maturity settlement.
// ---------------------------------------------------------------------------

// Margin + usance interest + bank charges voucher when an LC is opened
// (skipped when all three are zero). Interest is simple interest over the
// usance period: amount x interest_pct x usance_days / 365 — the same
// day-count convention interest already uses elsewhere in the books.
export async function postLcOpening(lcId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) return
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  await dropEntry(n(lc.journal_entry_id) || null)
  // Margin is the security deposit the bank asks for on the LC's own open
  // amount — a straight percentage of the credit limit itself, not of
  // whichever invoices happen to be linked to it.
  const margin = round2((n(lc.amount) * n(lc.margin_pct)) / 100)
  const rawInterest = round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
  const rawCharges = round2(n(lc.charges))
  // Some parties (e.g. Bunge-style deals) pay interest AND charges upfront
  // straight from the bank account instead of either coming out of the LC's
  // own open amount — this voucher then posts neither; both are deferred
  // until the matching bank statement line is reconciled (see
  // postLcUpfrontInterest below).
  const interest = lc.interest_upfront ? 0 : rawInterest
  const charges = lc.interest_upfront ? 0 : rawCharges
  if (margin < 0.005 && interest < 0.005 && charges < 0.005) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    return
  }
  const je = await postJournal({
    date: String(lc.open_date || todayISO()),
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} opened at ${lc.bank} — margin ${margin.toFixed(2)}, interest ${interest.toFixed(2)}, charges ${charges.toFixed(2)}${
      lc.interest_upfront
        ? ` (interest ₹${rawInterest.toFixed(2)} and charges ₹${rawCharges.toFixed(2)} paid upfront from the bank — linked separately via bank reconciliation)`
        : ''
    }`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: 'LC MARGIN A/C', group: 'Deposits (Asset)', dr: margin },
      { account: 'INTEREST A/C', group: 'Indirect Expenses', dr: interest },
      { account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: charges },
      { account: bankAcc, group: 'Bank Accounts', cr: round2(margin + interest + charges) }
    ]
  })
  await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = ? WHERE id = ?', args: [je.id, lcId] })
}

// Posts the Dr Interest + Dr Charges / Cr Bank entry for interest and charges
// that were paid upfront (see interest_upfront / postLcOpening above) —
// deferred until you actually reconcile the matching bank statement line,
// rather than posted blind at Payment Received. Re-postable: dropping any
// prior entry first means re-reconciling (or a corrected usance_days) never
// leaves a stale duplicate.
export async function postLcUpfrontInterest(lcId: number, dateIn?: string): Promise<{ id: number } | null> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  await dropEntry(n(lc.interest_journal_entry_id) || null)
  const interest = round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
  const charges = round2(n(lc.charges))
  const total = round2(interest + charges)
  if (total < 0.005) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    return null
  }
  const je = await postJournal({
    date: String(dateIn || todayISO()).slice(0, 10),
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} — interest ${interest.toFixed(2)} and charges ${charges.toFixed(2)} paid upfront from the bank, per its statement`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: 'INTEREST A/C', group: 'Indirect Expenses', dr: interest },
      { account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: charges },
      { account: bankAcc, group: 'Bank Accounts', cr: total }
    ]
  })
  await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = ? WHERE id = ?', args: [je.id, lcId] })
  return { id: je.id }
}

// What the LC actually released to the beneficiary, against what its settled
// bills say they were paid. Signed: negative means the bank retained part of the
// bill (interest/charges), positive means it released more than the bill records.
//
// Only meaningful once something has actually been paid, and only for a bill
// auto-issued for the whole limit — a bill sized to a specific purchase invoice
// is deliberate, so a leftover there is genuine undrawn limit, not a shortfall
// to settle. Such an LC is therefore only ever corrected DOWNWARD, never paid
// more than its invoice called for.
export function lcFeeDelta(lc: Row, settled: number, invoiceLinkedBills: number): number {
  if (settled <= 0.005) return 0
  const upfront = !!lc.interest_upfront
  const interest = upfront ? 0 : round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
  const charges = upfront ? 0 : round2(n(lc.charges))
  const released = round2(n(lc.amount) - interest - charges)
  const delta = round2(released - settled)
  if (Math.abs(delta) < 0.005) return 0
  if (delta > 0 && invoiceLinkedBills > 0) return 0
  return delta
}

// The bank deducts its interest and charges from the LC's open amount before it
// releases anything to the beneficiary, so a bill issued for the gross records
// the party as paid more than they actually received. This posts the difference
// back to the party — Dr Bank / Cr the party, allocated On Account — so their
// ledger shows what really reached them.
//
// Re-postable on every LC save: raise the charges and the correction grows,
// lower them and it shrinks or disappears entirely. The original settlement
// voucher is never touched, so the payment as it happened stays on the record
// with the correction sitting beside it.
export async function syncLcFeeAdjustment(lcId: number): Promise<number> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT l.*, s.name AS supplier_name
          FROM letters_of_credit l
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.id = ?`,
    args: [lcId]
  })
  if (!res.rows.length) return 0
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  const iss = await c.execute({
    sql: `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) AS settled,
                 COUNT(CASE WHEN order_id IS NOT NULL THEN 1 END) AS linked
          FROM lc_issuances WHERE lc_id = ?`,
    args: [lcId]
  })
  const delta = lcFeeDelta(lc, n(iss.rows[0]?.settled), n(iss.rows[0]?.linked))
  await dropEntry(n(lc.fee_adjust_journal_entry_id) || null)
  const party = String(lc.supplier_name || '').trim()
  if (delta === 0 || !party) {
    await c.execute({
      sql: 'UPDATE letters_of_credit SET fee_adjust_journal_entry_id = NULL WHERE id = ?',
      args: [lcId]
    })
    return 0
  }
  const size = round2(Math.abs(delta))
  const retained = delta < 0
  const je = await postJournal({
    date: String(lc.payment_received_date || lc.open_date || todayISO()).slice(0, 10),
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration: retained
      ? `LC ${lc.lc_no} — ${size.toFixed(2)} of the bill was retained by ${lc.bank} as interest and charges, ` +
        `so it never reached ${party}; their account is credited back by that much`
      : `LC ${lc.lc_no} — ${lc.bank} released ${size.toFixed(2)} to ${party} beyond the bill as drawn, ` +
        `so their account is debited by that much`,
    companyId: n(lc.company_id) || undefined,
    lines: retained
      ? [
          { account: bankAcc, group: 'Bank Accounts', dr: size },
          { account: party, group: 'Sundry Creditors', cr: size }
        ]
      : [
          { account: party, group: 'Sundry Creditors', dr: size },
          { account: bankAcc, group: 'Bank Accounts', cr: size }
        ]
  })
  // On Account: this corrects the party's balance as a whole, not one named bill.
  await allocAgainst(je.id, party, null, size)
  await c.execute({
    sql: 'UPDATE letters_of_credit SET fee_adjust_journal_entry_id = ? WHERE id = ?',
    args: [je.id, lcId]
  })
  return delta
}

// Keeps an ALREADY-POSTED upfront interest/charges voucher in step with the
// LC's own numbers, for when interest %, charges, the open amount or the
// interest days are edited after the fact. Deliberately only refreshes an
// entry that already exists — posting one early is the bank reconciliation's
// job (see postLcUpfrontInterest above), not an edit's. The original entry
// date is kept, since that's the date the bank actually took the money.
export async function refreshLcUpfrontInterest(lcId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT interest_journal_entry_id FROM letters_of_credit WHERE id = ?',
    args: [lcId]
  })
  const jeId = n(res.rows[0]?.interest_journal_entry_id)
  if (!jeId) return
  const je = await c.execute({ sql: 'SELECT entry_date FROM journal_entries WHERE id = ?', args: [jeId] })
  const date = String(je.rows[0]?.entry_date || '').slice(0, 10)
  await postLcUpfrontInterest(lcId, date || undefined)
}

// Reverses the upfront-interest posting above — used when its bank statement
// line is un-reconciled (or reclassified to misc), so the books don't keep an
// entry no longer backed by a confirmed statement line.
export async function dropLcUpfrontInterest(lcId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT interest_journal_entry_id FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (res.rows.length && res.rows[0].interest_journal_entry_id) {
    await dropEntry(n(res.rows[0].interest_journal_entry_id))
    await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?', args: [lcId] })
  }
}

// An LC's margin/security-deposit FD, released back as cash once the LC is
// preclosed and the bank no longer needs it held — a separate, optional
// voucher from the preclosure's repayment (see saveLcRepayment below).
export async function postLcMarginRelease(lcId: number, amount: number, dateIn?: string): Promise<{ id: number } | null> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  const value = round2(amount)
  if (value < 0.005) return null
  const je = await postJournal({
    date: String(dateIn || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} preclosed — margin of ${value.toFixed(2)} refunded by ${lc.bank}`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: bankAcc, group: 'Bank Accounts', dr: value },
      { account: 'LC MARGIN A/C', group: 'Deposits (Asset)', cr: value }
    ]
  })
  return { id: je.id }
}

// Preclosing means less interest actually accrues than the LC's netAvailable
// deduction assumed (that deduction was struck over the FULL planned usance
// period, when the supplier's bill was settled) — so the pending days
// (preclose date -> original maturity) are a REBATE, not a charge. It either
// goes back to the company directly, or is passed on to the supplier who was
// effectively underpaid by that same amount when their bill was settled.
export async function postLcPrematureInterestRebate(
  lcId: number,
  direction: 'credit_to_us' | 'pay_to_party',
  amount: number,
  dateIn?: string
): Promise<{ id: number } | null> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT l.*, s.name AS supplier_name FROM letters_of_credit l
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.id = ?`,
    args: [lcId]
  })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  const value = round2(amount)
  if (value < 0.005) return null
  const date = String(dateIn || todayISO()).slice(0, 10)
  let lines: { account: string; group: string; dr?: number; cr?: number }[]
  let narration: string
  if (direction === 'credit_to_us') {
    lines = [
      { account: bankAcc, group: 'Bank Accounts', dr: value },
      { account: 'INTEREST A/C', group: 'Indirect Expenses', cr: value }
    ]
    narration = `LC ${lc.lc_no} preclosed — interest rebate of ${value.toFixed(2)} for the days that won't happen, credited by ${lc.bank}`
  } else {
    const party = String(lc.supplier_name || '').trim()
    if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
    lines = [
      { account: party, group: 'Sundry Creditors', dr: value },
      { account: bankAcc, group: 'Bank Accounts', cr: value }
    ]
    narration = `LC ${lc.lc_no} preclosed — interest rebate of ${value.toFixed(2)} passed on to ${party}`
  }
  const je = await postJournal({
    date,
    vchType: direction === 'credit_to_us' ? 'RECEIPT' : 'PAYMENT',
    vchNo: String(lc.lc_no || ''),
    narration,
    companyId: n(lc.company_id) || undefined,
    lines
  })
  return { id: je.id }
}

// Every sale invoice belonging to the LC's linked Trading deal(s), with
// what's still outstanding on each — the same "bill" a manual Receipt +
// Agst Ref would pick from in Accounts, keyed the identical way
// (invoice_group, falling back to invoice_no) so this and a hand-entered
// receipt always agree on what's still owed.
async function outstandingSaleRefsForLc(
  lcId: number
): Promise<{ lc: Row; customerName: string; refs: { key: string; invoice_no: string; sale_date: string; due: number }[] }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  if (String(lc.purpose || '') !== 'trading') throw new Error('Payment IN only applies to a Trading LC')
  if (!lc.receivable_party_id) throw new Error('Set the party payment will be received from on this LC first')
  const custRes = await c.execute({ sql: 'SELECT name FROM customers WHERE id = ?', args: [Number(lc.receivable_party_id)] })
  const customerName = String(custRes.rows[0]?.name || '').trim()
  if (!customerName) throw new Error('The receivable party could not be found')

  // A deal belongs to this LC once at least one of its own purchase invoices
  // is actually linked to it (lc_linked_orders — the real per-invoice record,
  // since a deal's several invoices can each go to a different LC) — not
  // trading_deals.lc_id, which is only a soft, last-touched pointer now.
  const dealsRes = await c.execute({
    sql: `SELECT DISTINCT td.id, td.sale_id
          FROM trading_deals td
          WHERE EXISTS (
            SELECT 1 FROM lc_linked_orders lo
            WHERE lo.lc_id = ?
              AND lo.order_id IN (
                SELECT order_id FROM trading_deal_orders WHERE deal_id = td.id
                UNION SELECT td.order_id
              )
          )`,
    args: [lcId]
  })
  const dealRows = toPlain(dealsRes)
  if (!dealRows.length) throw new Error("This LC has no linked Trading deal to receive payment against")
  const dealIds = dealRows.map((d) => n(d.id))

  const linksRes = await c.execute({
    sql: `SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${dealIds.join(',')})`,
    args: []
  })
  const saleIdsByDeal = new Map<number, number[]>()
  for (const r of toPlain(linksRes)) {
    const k = n(r.deal_id)
    saleIdsByDeal.set(k, [...(saleIdsByDeal.get(k) ?? []), n(r.sale_id)])
  }
  // A deal booked before multi-invoice sales existed has no link rows — its
  // own sale_id is every bit as real, just not worth rewriting to fit.
  const saleIds = Array.from(
    new Set(dealRows.flatMap((d) => saleIdsByDeal.get(n(d.id)) ?? (n(d.sale_id) ? [n(d.sale_id)] : [])))
  )
  if (!saleIds.length) throw new Error("This LC's linked Trading deal has no sale invoice yet")

  const salesRes = await c.execute({
    sql: `SELECT COALESCE(invoice_group, invoice_no) AS key, MIN(invoice_no) AS invoice_no, MIN(sale_date) AS sale_date,
                 SUM(amount + gst_amount + round_off - tds_amount) AS due
          FROM sales WHERE id IN (${saleIds.join(',')}) GROUP BY key`,
    args: []
  })
  const bills = toPlain(salesRes)
    .map((s) => ({ key: String(s.key || '').trim(), invoice_no: String(s.invoice_no || ''), sale_date: String(s.sale_date || ''), due: round2(n(s.due)) }))
    .filter((s) => s.key)
  if (!bills.length) throw new Error("This LC's linked Trading deal has no sale invoice yet")

  // What's already been received against each of these refs (e.g. a receipt
  // logged separately in Accounts) comes off what's still due, so this never
  // double-books a bill already partly settled.
  const keys = bills.map((b) => b.key)
  const settledRes = await c.execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amt
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ? AND COALESCE(ba.sale_invoice_group, ba.ref_name) IN (${keys.map(() => '?').join(',')})
          GROUP BY key`,
    args: [n(lc.company_id) || getActiveCompanyId(), ...keys]
  })
  const settledMap = new Map<string, number>()
  for (const r of toPlain(settledRes)) settledMap.set(String(r.key), n(r.amt))

  const refs = bills
    .map((b) => ({ ...b, due: round2(b.due - (settledMap.get(b.key) || 0)) }))
    .filter((b) => b.due > 0.005)
  return { lc, customerName, refs }
}

// The open trading sale invoices for a Trading LC's linked deal(s) — the
// Payment IN dialog shows these so the user picks which invoice(s) the
// receipt is actually for, rather than money landing against the wrong bill.
export async function listLcOpenTradingInvoices(lcId: number): Promise<Row[]> {
  const { refs } = await outstandingSaleRefsForLc(lcId).catch(() => ({ refs: [] }))
  return refs
}

// The last leg of a Trading LC's round trip: the customer actually pays for
// the resale. Posted bill-wise against whichever of the LC's linked Trading
// deal sale invoices the user picked (or every one still outstanding, if none
// were picked), the same way a manual Receipt + Agst Ref would in Accounts —
// so this shortcut and a hand-entered receipt reconcile identically. The
// amount is free to differ from the LC's own open amount either way — it's
// squared against what the SALE side still owes, not the LC's purchase-side
// amount, and can come in across more than one call (a part-payment, or one
// per invoice on a multi-invoice deal) — each posts its own fresh entry
// rather than replacing the last, exactly like an LC repayment.
export async function postLcPaymentIn(
  lcId: number,
  amount: number,
  dateIn?: string,
  selectedKeys?: string[]
): Promise<{ id: number; date: string }> {
  const { lc, customerName, refs } = await outstandingSaleRefsForLc(lcId)
  const bankAcc = await bankAccountFor(lc)
  const wanted = Array.isArray(selectedKeys) && selectedKeys.length ? new Set(selectedKeys.map(String)) : null
  const outstanding = wanted ? refs.filter((r) => wanted.has(r.key)) : refs
  if (!outstanding.length) throw new Error('Every sale invoice on this deal is already fully paid')
  const totalDue = round2(outstanding.reduce((s, o) => s + o.due, 0))

  const value = round2(n(amount))
  if (value < 0.005) throw new Error('Enter the amount received')
  if (value > totalDue + 0.005) {
    throw new Error(`Only ${totalDue.toFixed(2)} is still receivable on the ${wanted ? 'selected invoice(s)' : "LC's deal(s)"}`)
  }

  const c = getClient()
  const date = String(dateIn || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The date the payment was received')
  const je = await postJournal({
    date,
    vchType: 'RECEIPT',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} — payment IN of ${value.toFixed(2)} received from ${customerName}`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: bankAcc, group: 'Bank Accounts', dr: value },
      { account: customerName, group: 'Sundry Debtors', cr: value }
    ]
  })
  // Biggest outstanding bill first, the way one lump receipt naturally clears
  // the largest dues before spilling onto the next.
  let remaining = value
  for (const o of [...outstanding].sort((a, b) => b.due - a.due)) {
    if (remaining <= 0.005) break
    const take = round2(Math.min(remaining, o.due))
    await allocAgainst(je.id, customerName, o.key, take)
    remaining -= take
  }
  await c.execute({
    sql: 'INSERT INTO lc_payment_ins (lc_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, ?)',
    args: [lcId, date, value, je.id]
  })
  return { id: je.id, date }
}

// ---------------------------------------------------------------------------
// Bill Discounting: the payment coming back IN on a trading deal.
//
// A trading discounted bill is the same round trip as a Trading LC: we discount
// the purchase, resell the goods, and the customer's money comes back to us.
// Repaying the NBFC was already tracked; this is the other leg, and it is built
// on the same three links the LC side uses -- the receivable party on the bill,
// the purchase invoices the bill funded, and through those the trading deal's
// resale invoices. Without them nothing says WHICH invoices the money is
// expected through, which is why a bill could not be settled bill-wise before.
// ---------------------------------------------------------------------------

async function outstandingSaleRefsForBd(
  bdId: number
): Promise<{ bd: Row; customerName: string; refs: { key: string; invoice_no: string; sale_date: string; due: number }[] }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bill_discountings WHERE id = ?', args: [bdId] })
  if (!res.rows.length) throw new Error('Discounted bill not found')
  const bd = toPlain(res)[0]
  if (String(bd.purpose || '') !== 'trading') throw new Error('Payment IN only applies to a Trading bill')
  if (!bd.receivable_party_id) throw new Error('Set the party payment will be received from on this bill first')
  const custRes = await c.execute({ sql: 'SELECT name FROM customers WHERE id = ?', args: [Number(bd.receivable_party_id)] })
  const customerName = String(custRes.rows[0]?.name || '').trim()
  if (!customerName) throw new Error('The receivable party could not be found')

  // A deal belongs to this bill once one of its own purchase invoices is
  // linked to it — the same per-invoice rule the LC side uses, since a deal's
  // several invoices can each be financed differently.
  const dealsRes = await c.execute({
    sql: `SELECT DISTINCT td.id, td.sale_id
          FROM trading_deals td
          WHERE EXISTS (
            SELECT 1 FROM bd_linked_orders bo
            WHERE bo.bd_id = ?
              AND bo.order_id IN (
                SELECT order_id FROM trading_deal_orders WHERE deal_id = td.id
                UNION SELECT td.order_id
              )
          )`,
    args: [bdId]
  })
  const dealRows = toPlain(dealsRes)
  if (!dealRows.length) throw new Error('This bill has no linked Trading deal to receive payment against')
  const dealIds = dealRows.map((d) => n(d.id))

  const linksRes = await c.execute({
    sql: `SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${dealIds.join(',')})`,
    args: []
  })
  const saleIdsByDeal = new Map<number, number[]>()
  for (const r of toPlain(linksRes)) {
    const k = n(r.deal_id)
    saleIdsByDeal.set(k, [...(saleIdsByDeal.get(k) ?? []), n(r.sale_id)])
  }
  // A deal booked before multi-invoice sales existed has no link rows — its own
  // sale_id is every bit as real.
  const saleIds = Array.from(
    new Set(dealRows.flatMap((d) => saleIdsByDeal.get(n(d.id)) ?? (n(d.sale_id) ? [n(d.sale_id)] : [])))
  )
  if (!saleIds.length) throw new Error("This bill's linked Trading deal has no sale invoice yet")

  const salesRes = await c.execute({
    sql: `SELECT COALESCE(invoice_group, invoice_no) AS key, MIN(invoice_no) AS invoice_no, MIN(sale_date) AS sale_date,
                 SUM(amount + gst_amount + round_off - tds_amount) AS due
          FROM sales WHERE id IN (${saleIds.join(',')}) GROUP BY key`,
    args: []
  })
  const bills = toPlain(salesRes)
    .map((x) => ({
      key: String(x.key || '').trim(),
      invoice_no: String(x.invoice_no || ''),
      sale_date: String(x.sale_date || ''),
      due: round2(n(x.due))
    }))
    .filter((x) => x.key)
  if (!bills.length) throw new Error("This bill's linked Trading deal has no sale invoice yet")

  // Whatever has already been received against these refs comes off what is
  // still due, so a bill partly settled elsewhere is never double-booked.
  const keys = bills.map((b) => b.key)
  const settledRes = await c.execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amt
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ?
            AND COALESCE(ba.sale_invoice_group, ba.ref_name) IN (${keys.map(() => '?').join(',')})
          GROUP BY key`,
    args: [n(bd.company_id) || getActiveCompanyId(), ...keys]
  })
  const settled = new Map<string, number>()
  for (const r of toPlain(settledRes)) settled.set(String(r.key), n(r.amt))

  const refs = bills
    .map((b) => ({ ...b, due: round2(b.due - (settled.get(b.key) || 0)) }))
    .filter((b) => b.due > 0.005)
  return { bd, customerName, refs }
}

// The open resale invoices behind a trading bill — the Payment IN dialog lists
// these so the receipt lands on the invoice it is actually for.
export async function listBdOpenTradingInvoices(bdId: number): Promise<Row[]> {
  try {
    const { refs } = await outstandingSaleRefsForBd(bdId)
    return refs
  } catch {
    // The dialog asks before the links are necessarily in place; an empty list
    // is the honest answer there, and saving still reports the real reason.
    return []
  }
}

// Record what the customer paid back. Posts Dr bank / Cr customer and settles
// it against the outstanding resale invoices, biggest first — the way one lump
// receipt naturally clears the largest dues before spilling onto the next. Each
// call posts its own voucher rather than replacing the last, so part-payments
// and one-per-invoice both work.
export async function postBdPaymentIn(
  bdId: number,
  amount: number,
  dateIn?: string,
  selectedKeys?: string[]
): Promise<{ id: number; date: string }> {
  const { bd, customerName, refs } = await outstandingSaleRefsForBd(bdId)
  const wanted = Array.isArray(selectedKeys) && selectedKeys.length ? new Set(selectedKeys.map(String)) : null
  const outstanding = wanted ? refs.filter((r) => wanted.has(r.key)) : refs
  if (!outstanding.length) throw new Error('Every sale invoice on this deal is already fully paid')
  const totalDue = round2(outstanding.reduce((t, o) => t + o.due, 0))

  const value = round2(n(amount))
  if (value < 0.005) throw new Error('Enter the amount received')
  if (value > totalDue + 0.005) {
    throw new Error(
      `Only ${totalDue.toFixed(2)} is still receivable on the ${wanted ? 'selected invoice(s)' : "bill's deal(s)"}`
    )
  }

  const c = getClient()
  const date = String(dateIn || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The date the payment was received')
  const je = await postJournal({
    date,
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} — payment IN of ${value.toFixed(2)} received from ${customerName}`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'BANK A/C', group: 'Bank Accounts', dr: value },
      { account: customerName, group: 'Sundry Debtors', cr: value }
    ]
  })
  let remaining = value
  for (const o of [...outstanding].sort((a, b) => b.due - a.due)) {
    if (remaining <= 0.005) break
    const take = round2(Math.min(remaining, o.due))
    await allocAgainst(je.id, customerName, o.key, take)
    remaining -= take
  }
  await c.execute({
    sql: 'INSERT INTO bd_payment_ins (bd_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, ?)',
    args: [bdId, date, value, je.id]
  })
  return { id: je.id, date }
}

export async function listBdPaymentIns(bdId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM bd_payment_ins WHERE bd_id = ? ORDER BY id DESC',
    args: [bdId]
  })
  return toPlain(res)
}

// Undo one receipt — logged twice, or against the wrong bill. Its voucher and
// the allocations under it go with it, exactly as removing a repayment does.
export async function deleteBdPaymentIn(paymentInId: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM bd_payment_ins WHERE id = ?', args: [paymentInId] })
  if (!res.rows.length) throw new Error('That receipt no longer exists')
  const je = n(res.rows[0].journal_entry_id)
  if (je) {
    // Voucher, its lines, and the bill allocations under them — the same
    // teardown a removed repayment does.
    await c.execute({
      sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
      args: [je]
    })
    await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [je] })
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [je] })
  }
  await c.execute({ sql: 'DELETE FROM bd_payment_ins WHERE id = ?', args: [paymentInId] })
  return { id: paymentInId }
}

// Every LC repayment in the active company, for the Excel export's second
// sheet. One query, not one per LC — the export would otherwise fire a query
// per row of the register.
export async function listAllLcRepayments(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT r.*, l.lc_no, l.bank, s.name AS supplier_name
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.company_id = ?
          ORDER BY l.lc_no, r.repay_date, r.id`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

export async function listLcPaymentIns(lcId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM lc_payment_ins WHERE lc_id = ? ORDER BY id DESC',
    args: [lcId]
  })
  return toPlain(res)
}

export async function deleteLcPaymentIn(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_payment_ins WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropEntry(n(res.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_payment_ins WHERE id = ?', args: [id] })
  return { id }
}

// A bill under the LC matures and the bank pays the supplier: the payable
// clears against the original invoice, money leaves the bank.
export async function settleLcBill(issuanceId: number, dateIn?: string): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT i.*, l.lc_no, l.bank, l.our_bank_id, l.party_type, l.party_id, l.company_id, s.name AS supplier_name, o.invoice_no
          FROM lc_issuances i
          JOIN letters_of_credit l ON l.id = i.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.id = ?`,
    args: [issuanceId]
  })
  if (!res.rows.length) throw new Error('LC bill not found')
  const b = toPlain(res)[0]
  const bankAcc = await bankAccountFor(b)
  if (String(b.status) === 'settled') throw new Error('This bill is already settled')
  const party = String(b.supplier_name || '').trim()
  if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const amount = round2(n(b.amount))
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(b.bill_no || b.lc_no || ''),
    narration: `LC ${b.lc_no} ${b.bill_no ? `bill ${b.bill_no}` : 'on account'} matured — paid by ${b.bank}`,
    companyId: n(b.company_id) || undefined,
    lines: [
      { account: party, group: 'Sundry Creditors', dr: amount },
      { account: bankAcc, group: 'Bank Accounts', cr: amount }
    ]
  })
  await allocAgainst(je.id, party, b.invoice_no ? String(b.invoice_no) : b.bill_no ? String(b.bill_no) : null, amount)
  await c.execute({
    sql: "UPDATE lc_issuances SET status = 'settled', settled_date = ?, journal_entry_id = ? WHERE id = ?",
    args: [date, je.id, issuanceId]
  })
  return { id: issuanceId }
}

// Every bill still outstanding on an LC settles as ONE payment — one bank
// withdrawal, one journal entry — the same way a real payment voucher covers
// several invoices at once. Each bill still gets its own bill-wise allocation
// row on the party line, so the ledger can be expanded to show exactly how
// the lump sum squares off invoice by invoice.
export async function settleLcBillsCombined(issuanceIds: number[], dateIn?: string): Promise<{ id: number } | null> {
  if (!issuanceIds.length) return null
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT i.*, l.lc_no, l.bank, l.our_bank_id, l.party_type, l.party_id, l.company_id, s.name AS supplier_name, o.invoice_no
          FROM lc_issuances i
          JOIN letters_of_credit l ON l.id = i.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.id IN (${issuanceIds.map(() => '?').join(',')})`,
    args: issuanceIds
  })
  const bills = toPlain(res).filter((b) => String(b.status) !== 'settled')
  if (!bills.length) return null
  const first = bills[0]
  const bankAcc = await bankAccountFor(first)
  const party = String(first.supplier_name || '').trim()
  if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const total = round2(bills.reduce((s, b) => s + n(b.amount), 0))
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(first.lc_no || ''),
    narration:
      bills.length === 1
        ? `LC ${first.lc_no} ${first.bill_no ? `bill ${first.bill_no}` : 'on account'} matured — paid by ${first.bank}`
        : `LC ${first.lc_no} — ${bills.length} bills matured — paid by ${first.bank}`,
    companyId: n(first.company_id) || undefined,
    lines: [
      { account: party, group: 'Sundry Creditors', dr: total },
      { account: bankAcc, group: 'Bank Accounts', cr: total }
    ]
  })
  for (const b of bills) {
    const ref = b.invoice_no ? String(b.invoice_no) : b.bill_no ? String(b.bill_no) : null
    await allocAgainst(je.id, party, ref, round2(n(b.amount)))
  }
  await c.execute({
    sql: `UPDATE lc_issuances SET status = 'settled', settled_date = ?, journal_entry_id = ?
          WHERE id IN (${bills.map(() => '?').join(',')})`,
    args: [date, je.id, ...bills.map((b) => Number(b.id))]
  })
  return { id: je.id }
}

// Reopening a bill that was settled as part of a combined payment reopens
// every bill in that same payment — a lump bank withdrawal can't be partly
// undone without contradicting what the bank statement actually shows.
export async function reopenLcBill(issuanceId: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE id = ?', args: [issuanceId] })
  if (!res.rows.length) throw new Error('LC bill not found')
  const entryId = n(res.rows[0].journal_entry_id) || null
  await dropEntry(entryId)
  const sql = entryId
    ? "UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL WHERE journal_entry_id = ?"
    : "UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL WHERE id = ?"
  await c.execute({ sql, args: [entryId || issuanceId] })
  return { id: issuanceId }
}

// ---------------------------------------------------------------------------
// LC repayment: US repaying the BANK against a Trading LC's exposure — an
// outflow, not the receivable party paying us (that's tracked separately via
// the LC's own payment-received date). The bank often deducts a variable
// maturity charge at the same moment, so both come off our account as ONE
// combined withdrawal. Logged first (with its bank document), posted to the
// books only once confirmed — `posted` is the yes/no gate the notes ask for.
// ---------------------------------------------------------------------------

export async function listLcRepayments(lcId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT r.*, cu.name AS party_name FROM lc_repayments r
          LEFT JOIN customers cu ON cu.id = r.party_id
          WHERE r.lc_id = ? ORDER BY r.id DESC`,
    args: [lcId]
  })
  return toPlain(res)
}

// Posts (or re-posts) the repayment's journal entry: money leaves our bank —
// the repayment itself and any commission/bank charges combine into that one
// Bank credit line, matching the single combined debit the bank statement shows.
async function postLcRepaymentEntry(repaymentId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT r.*, l.lc_no, l.company_id, l.bank, l.our_bank_id, l.amount AS lc_open_amount
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          WHERE r.id = ?`,
    args: [repaymentId]
  })
  if (!res.rows.length) throw new Error('Repayment not found')
  const rep = toPlain(res)[0]
  const bankAcc = await bankAccountFor(rep)
  await dropEntry(n(rep.journal_entry_id) || null)
  // rep.amount is the TOTAL the bank debited (open amount + any excess) —
  // comm_charges/bank_charges are that excess broken into expense categories,
  // so only the LC's own open amount goes to LC REPAYMENT A/C. Posting the
  // full rep.amount there too would double-count the excess against the
  // charge lines below.
  const openAmount = round2(n(rep.lc_open_amount))
  const commCharges = round2(n(rep.comm_charges))
  const bankCharges = round2(n(rep.bank_charges))
  const date = String(rep.repay_date || todayISO()).slice(0, 10)
  const lines: { account: string; group: string; dr?: number; cr?: number }[] = [
    { account: 'LC REPAYMENT A/C', group: 'Loans (Liability)', dr: openAmount }
  ]
  if (commCharges > 0.005) lines.push({ account: 'COMM. CHARGES A/C', group: 'Indirect Expenses', dr: commCharges })
  if (bankCharges > 0.005) lines.push({ account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: bankCharges })
  const totalCharges = round2(commCharges + bankCharges)
  lines.push({ account: bankAcc, group: 'Bank Accounts', cr: round2(openAmount + totalCharges) })
  const je = await postJournal({
    date,
    // A JOURNAL, not a PAYMENT: closing an LC squares the LC liability off
    // against the bank rather than paying a party, so it reads as JV in the
    // ledger. The two PAYMENT postings above are different — those settle a
    // supplier's matured bill, which genuinely is a payment.
    vchType: 'JOURNAL',
    vchNo: rep.lc_no ? String(rep.lc_no) : null,
    narration: `LC ${rep.lc_no} repaid to ${rep.bank || 'the bank'}${totalCharges > 0.005 ? ` (incl. ${totalCharges.toFixed(2)} charges)` : ''}`,
    companyId: n(rep.company_id) || undefined,
    lines
  })
  await c.execute({ sql: 'UPDATE lc_repayments SET journal_entry_id = ? WHERE id = ?', args: [je.id, repaymentId] })
}

export async function saveLcRepayment(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const lcId = n(v.lc_id)
  if (!lcId) throw new Error('Pick the LC this repayment is against')
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the repayment amount')
  const lcRes = await c.execute({ sql: 'SELECT amount FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!lcRes.rows.length) throw new Error('LC not found')
  const openAmount = n(lcRes.rows[0].amount)
  if (amount < openAmount - 0.005) {
    throw new Error(`The repayment (${amount.toFixed(2)}) cannot be less than the LC's open amount (${openAmount.toFixed(2)})`)
  }
  const commCharges = round2(n(v.comm_charges))
  const bankCharges = round2(n(v.bank_charges))
  const excess = round2(amount - openAmount)
  if (excess > 0.005) {
    if (Math.abs(commCharges + bankCharges - excess) > 0.005) {
      throw new Error(
        `Comm. charges + Bank charges must add up to the ${excess.toFixed(2)} over the open amount (currently ${(commCharges + bankCharges).toFixed(2)})`
      )
    }
  } else if (commCharges > 0.005 || bankCharges > 0.005) {
    throw new Error('Comm. charges and Bank charges only apply when the repayment exceeds the open amount')
  }
  const maturityCharges = round2(commCharges + bankCharges)
  const posted = v.posted ? 1 : 0
  assertNotFuture(v.repay_date ? String(v.repay_date).slice(0, 10) : '', 'The repayment date')
  const args = [
    lcId,
    v.party_id ? n(v.party_id) : null,
    amount,
    maturityCharges,
    commCharges,
    bankCharges,
    v.repay_date ? String(v.repay_date).slice(0, 10) : todayISO(),
    posted,
    v.document_path ? String(v.document_path) : null,
    v.note ? String(v.note).trim() : null
  ]
  let id: number
  if (v.id) {
    id = n(v.id)
    const prev = await c.execute({ sql: 'SELECT posted, journal_entry_id FROM lc_repayments WHERE id = ?', args: [id] })
    if (!prev.rows.length) throw new Error('Repayment not found')
    await c.execute({
      sql: `UPDATE lc_repayments SET lc_id = ?, party_id = ?, amount = ?, maturity_charges = ?, comm_charges = ?, bank_charges = ?,
            repay_date = ?, posted = ?, document_path = ?, note = ? WHERE id = ?`,
      args: [...args, id]
    })
    if (n(prev.rows[0].posted) && !posted) {
      await dropEntry(n(prev.rows[0].journal_entry_id) || null)
      await c.execute({ sql: 'UPDATE lc_repayments SET journal_entry_id = NULL WHERE id = ?', args: [id] })
    }
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO lc_repayments (lc_id, party_id, amount, maturity_charges, comm_charges, bank_charges, repay_date, posted, document_path, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args
    })
    id = Number(ins.lastInsertRowid)
  }
  if (posted) {
    try {
      await postLcRepaymentEntry(id)
    } catch (e) {
      // Never leave a row flagged posted (and so counted against the LC's
      // outstanding/headroom) when the journal it claims to back doesn't exist.
      await c.execute({ sql: 'UPDATE lc_repayments SET posted = 0 WHERE id = ?', args: [id] })
      throw e
    }
  }
  return { id }
}

export async function deleteLcRepayment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_repayments WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropEntry(n(res.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_repayments WHERE id = ?', args: [id] })
  return { id }
}

// ---------------------------------------------------------------------------
// Monitoring: everything the treasury needs eyes on, in one call.
// ---------------------------------------------------------------------------

export async function treasuryAlerts(): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const today = todayISO()

  const lcs = toPlain(
    await c.execute({
      sql: `SELECT l.*, s.name AS supplier_name,
                   COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized
            FROM letters_of_credit l
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            WHERE l.company_id = ? AND l.status != 'closed'`,
      args: [cid]
    })
  )
  // A preclosed LC has been repaid and wound up — its expiry date stops
  // meaning anything, so it must not keep counting toward "LCs expiring" or
  // showing as expired forever.
  const lcExpiring = lcs
    .filter((l) => !l.preclosed_date)
    .map((l) => ({ ...l, days_left: l.expiry_date ? daysBetween(today, String(l.expiry_date)) : null }))
    .filter((l) => l.days_left != null && l.days_left <= 15)
    .sort((a, b) => (a.days_left as number) - (b.days_left as number))

  const lcBills = toPlain(
    await c.execute({
      sql: `SELECT i.*, l.lc_no, l.bank, s.name AS supplier_name, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ? AND COALESCE(i.status, 'outstanding') = 'outstanding' AND i.due_date IS NOT NULL`,
      args: [cid]
    })
  )
  const lcBillsDue = lcBills
    .map((b) => ({ ...b, days_left: daysBetween(today, String(b.due_date)) }))
    .filter((b) => b.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left)

  const bd = toPlain(
    await c.execute({
      sql: `SELECT bd.*, nb.name AS nbfc_name,
                   COALESCE(s.name, cu.name) AS party_name
            FROM bill_discountings bd
            LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
            LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
            LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
            WHERE bd.company_id = ? AND bd.status = 'open' AND bd.maturity_date IS NOT NULL`,
      args: [cid]
    })
  )
  const billsDue = bd
    .map((b) => ({ ...b, days_left: daysBetween(today, String(b.maturity_date)) }))
    .filter((b) => b.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left)

  return {
    lcExpiring,
    lcBillsDue,
    billsDue,
    overdue:
      lcBillsDue.filter((b) => b.days_left < 0).length +
      billsDue.filter((b) => b.days_left < 0).length +
      lcExpiring.filter((l) => (l.days_left as number) < 0).length
  }
}

// Every payment obligation being run through treasury, in one place — LC
// bills and discounted bills, regardless of how close their due date is
// (treasuryAlerts only surfaces what's urgent). One list, one status, one
// due date, sorted soonest-first, so nothing tracked here needs checking in
// three different tabs.
export async function listPaymentTracker(): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const today = todayISO()

  const lcBills = toPlain(
    await c.execute({
      sql: `SELECT i.id, i.amount, i.due_date, i.status, i.issue_date,
                   l.lc_no AS ref, l.bank, s.name AS party, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: 'lc_bill' as const,
    kind_label: 'LC bill',
    ref: String(r.ref || ''),
    detail: `${r.bank || ''}${r.invoice_no ? ` · inv ${r.invoice_no}` : ''}`,
    party: String(r.party || ''),
    amount: n(r.amount),
    due_date: r.due_date ? String(r.due_date) : null,
    status: String(r.status || 'outstanding'),
    settled: String(r.status || 'outstanding') === 'settled'
  }))

  const bd = toPlain(
    await c.execute({
      sql: `SELECT bd.id, bd.bd_no, bd.amount, bd.maturity_date, bd.status, bd.finance_type,
                   nb.name AS nbfc_name, COALESCE(s.name, cu.name) AS party_name
            FROM bill_discountings bd
            LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
            LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
            LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
            WHERE bd.company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: 'bill_discount' as const,
    kind_label: 'Bill discounting',
    ref: String(r.bd_no || ''),
    detail: `${r.nbfc_name || ''}${r.finance_type ? ` · ${r.finance_type}` : ''}`,
    party: String(r.party_name || ''),
    amount: n(r.amount),
    due_date: r.maturity_date ? String(r.maturity_date) : null,
    status: String(r.status || 'open'),
    settled: String(r.status || '') === 'repaid'
  }))

  const all = [...lcBills, ...bd].map((r) => {
    const daysLeft = r.due_date ? daysBetween(today, r.due_date) : null
    return {
      ...r,
      days_left: daysLeft,
      due_period: duePeriodOf(daysLeft),
      overdue: !r.settled && daysLeft != null && daysLeft < 0
    }
  })
  all.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1 // open items first
    const ad = a.days_left ?? Infinity
    const bd2 = b.days_left ?? Infinity
    return ad - bd2
  })
  return all
}
