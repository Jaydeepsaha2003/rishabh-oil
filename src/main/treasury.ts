import { withDbTransaction } from './dbTransaction'
import { isRefundDue, refundLedgerFor, REFUND_DUE_GROUP } from '../renderer/src/lib/refundDue'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { allCompanyIds, getActiveCompanyId, withCompany } from './company'
import { postJournal, repostJournal } from './journal'
import { lcInterest, lcInterestBasis, lcInterestBaseIsCustom } from './lcInterest'
import { ensureVoucherNumbers, renumberOnTypeChange, voucherCodeOf } from './voucherNumbers'
import { resolveAccountName } from './ledgerMap'
import { lcLedgerNames } from './lcLedgers'

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
  await ensureVoucherNumbers()
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

// One resale invoice still owed on a trading deal, and WHO owes it. The payer
// is per invoice because a deal can be sold on to several buyers — see
// toSaleParties in trading.ts.
type SaleRef = { key: string; invoice_no: string; sale_date: string; due: number; customer_name: string }

// How a lump receipt lands: biggest outstanding bill first, the way one
// payment naturally clears the largest dues before spilling onto the next.
//
// Split out and made to return a PLAN rather than posting as it goes, because
// the voucher's credit lines have to be known before it is written — a deal
// sold on to two buyers owes two debtors, and each one's ledger must be
// credited with what its own bills actually took. Crediting a single party for
// the whole receipt would clear buyer B's invoice against buyer A's account.
function planReceipt(
  outstanding: SaleRef[],
  value: number,
  fallbackParty: string
): { takes: { party: string; key: string; amount: number }[]; byParty: { party: string; amount: number }[] } {
  const takes: { party: string; key: string; amount: number }[] = []
  let remaining = value
  for (const o of [...outstanding].sort((a, b) => b.due - a.due)) {
    if (remaining <= 0.005) break
    const amount = round2(Math.min(remaining, o.due))
    takes.push({ party: (o.customer_name || fallbackParty).trim() || fallbackParty, key: o.key, amount })
    remaining -= amount
  }
  // Rounding each take to the paisa can leave the credits a paisa short of the
  // debit, which postJournal refuses outright. The shortfall goes on the
  // largest credit — the same place a manual voucher would absorb it.
  const totals = new Map<string, number>()
  for (const t of takes) totals.set(t.party, round2((totals.get(t.party) || 0) + t.amount))
  const byParty = Array.from(totals, ([party, amount]) => ({ party, amount }))
  const drift = round2(value - byParty.reduce((a, b) => a + b.amount, 0))
  if (Math.abs(drift) > 0.0005 && byParty.length) {
    const biggest = byParty.reduce((a, b) => (b.amount > a.amount ? b : a))
    biggest.amount = round2(biggest.amount + drift)
  }
  return { takes, byParty }
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

/**
 * The ledger one of our banks posts to — and WHICH ACCOUNT at it.
 *
 * Two accounts at the same bank are two ledgers, and a name that stops at the
 * bank lumps them into one figure nobody can reconcile against a statement. So
 * the last four digits ride on the name: HDFCBANK A/C · 4521.
 *
 * Only the last four. A whole account number on a report that leaves the
 * building is a number nobody needed to print, and four is what a bank
 * statement itself quotes.
 *
 * A bank with no number still posts to the plain name, exactly as before —
 * every bank already on file is one of those until its number is filled in,
 * and the Banks master now requires one on anything new.
 */
export function bankLedgerName(name: unknown, accountNo: unknown): string {
  const nm = String(name || '').trim().toUpperCase()
  if (!nm) return 'BANK A/C'
  const digits = String(accountNo || '').replace(/\D/g, '')
  const last4 = digits.length >= 4 ? digits.slice(-4) : ''
  return last4 ? `${nm} A/C · ${last4}` : `${nm} A/C`
}

async function bankAccountFor(lc: Row): Promise<string> {
  const id = n(lc.our_bank_id)
  if (!id) return 'BANK A/C'
  const r = await getClient().execute({ sql: 'SELECT name, account_no FROM banks WHERE id = ?', args: [id] })
  const row = r.rows[0] as unknown as Row | undefined
  return bankLedgerName(row?.name, row?.account_no)
}

// ---------------------------------------------------------------------------
// Letter of Credit: open charges, usance due dates, maturity settlement.
// ---------------------------------------------------------------------------

// Margin + usance interest + bank charges voucher when an LC is opened
// (skipped when all three are zero). Interest is simple interest over the
// usance period: amount x interest_pct x usance_days / 365 — the same
// day-count convention interest already uses elsewhere in the books.
// What you owe the bank that issued the LC, from the moment it honours the
// credit until you repay it. Named per issuing bank, so the books say who is
// owed rather than lumping every LC into one figure.
//
// This is the hinge of the whole cycle: the bank's outlay to the beneficiary
// credits it, and your repayment debits it. Both halves must name the SAME
// account or the liability never clears.
const LC_PAYABLE_GROUP = 'Current Liabilities'
// Named for YOUR OWN bank — the account the repayment leaves from — not the
// discounting bank that issued the credit.
//
// The two are different here: South Indian Bank discounts, and you settle from
// YesBank or CSB. Grouping the liability by the issuing bank split it away from
// the account that actually clears it, so neither balance answered "what do I
// owe out of this account". Naming it for your own bank puts the payable and
// its settlement side by side.
//
// Falls back to the issuing bank when no own bank is set, so an LC keyed
// without one still lands somewhere named rather than in a single anonymous
// heap.
async function lcPayable(lc: Row): Promise<string> {
  // The ledger chosen for this LC liability (Accounting checks → "LC vouchers
  // on Tally's ledgers") — LC WITH HDFC BANK LTD for LC PAYABLE - HDFCBANK.
  const L = await lcLedgerNames()
  return L.payable(await lcPayableAsked(lc))
}

/** The app's own name for an LC's liability, before any chosen ledger. */
async function lcPayableAsked(lc: Row): Promise<string> {
  const id = n(lc.our_bank_id)
  if (id) {
    const r = await getClient().execute({ sql: 'SELECT name FROM banks WHERE id = ?', args: [id] })
    const own = String(r.rows[0]?.name || '').trim().toUpperCase()
    if (own) return `LC PAYABLE - ${own}`
  }
  const bank = String(lc.bank || '').trim().toUpperCase()
  return bank ? `LC PAYABLE - ${bank}` : 'LC PAYABLE'
}

export async function postLcOpening(lcId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) return
  const lc = toPlain(res)[0]
  await dropEntry(n(lc.journal_entry_id) || null)

  // OPENING AN LC POSTS NOTHING.
  //
  // It is a commitment the bank makes, carried off the books until it honours
  // the credit — and the margin lodged against it is not this company's money
  // moving anywhere it needs a voucher for. It is security the bank holds
  // under lien, tracked on the LC itself and on the bank's own side, and the
  // mill does not want it in these books.
  //
  // It used to post a CONTRA — Dr LC MARGIN A/C, Cr the bank — which parked
  // ₹8.6 crore in a deposit account and took the same out of the bank
  // balances, against a lien nobody had paid away. Before that it was one
  // JOURNAL carrying interest and charges as well, which dated a maturity cost
  // months before it was incurred; those belong to the repayment voucher and
  // postLcRepaymentEntry carries them.
  //
  // dropEntry above still runs, so re-saving any LC that still carries an old
  // margin voucher takes it off the books. interest_journal_entry_id is
  // deliberately untouched: it belongs to the upfront path
  // (postLcUpfrontInterest), which posts against a reconciled bank statement
  // line — a voucher this function never created and cannot re-post.
  await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?', args: [lcId] })
  })
}

// The fees an LC's own settlement voucher carries — see settleLcBillsCombined,
// which posts them on the same journal as the supplier's discharge, because the
// bank pays the beneficiary and keeps its cut in one act.
//
// This function no longer posts anything. It survives to REMOVE the separate
// fee voucher earlier versions raised, so re-posting an LC cleans up after
// them rather than leaving two entries where there should be one.
export async function postLcFees(lcId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT charges_journal_entry_id FROM letters_of_credit WHERE id = ?',
    args: [lcId]
  })
  if (!res.rows.length) return
  await dropEntry(n(res.rows[0].charges_journal_entry_id) || null)
  await c.execute({ sql: 'UPDATE letters_of_credit SET charges_journal_entry_id = NULL WHERE id = ?', args: [lcId] })
  })
}

// Posts the Dr Interest + Dr Charges / Cr Bank entry for interest and charges
// that were paid upfront (see interest_upfront / postLcOpening above) —
// deferred until you actually reconcile the matching bank statement line,
// rather than posted blind at Payment Received. Re-postable: dropping any
// prior entry first means re-reconciling (or a corrected usance_days) never
// leaves a stale duplicate.
export async function postLcUpfrontInterest(lcId: number, dateIn?: string): Promise<{ id: number } | null> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  const bankAcc = await bankAccountFor(lc)
  // The voucher being replaced — its id and number stay with the LC's interest
  // (PAY/18 stays PAY/18), so a correction never renumbers what the bank book,
  // Tally and the desk already know it by.
  const oldId = n(lc.interest_journal_entry_id)
  const L = await lcLedgerNames()
  await dropEntry(oldId || null)
  const charges = round2(n(lc.charges))
  // The bank's own debit, when one was recorded against the worked figure:
  // the charges stand, and the interest is what the debit leaves.
  const debited = round2(n(lc.upfront_debited))
  const interest = debited > 0 ? round2(Math.max(0, debited - charges)) : lcInterest(lc)
  const total = round2(interest + charges)
  if (total < 0.005) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    return null
  }
  const je = await postJournal({
    date: String(dateIn || todayISO()).slice(0, 10),
    // A PAYMENT, not a JOURNAL. Money leaves our own account here — the
    // interest and the commission are paid, not adjusted — and a voucher type
    // that says otherwise misfiles it in every cash report that reads the
    // type rather than the lines. The settlement voucher beside it stays a
    // JOURNAL for the opposite reason: nothing of ours moves there at all.
    vchType: 'PAYMENT',
    vchNo: String(lc.lc_no || ''),
    narration:
      `LC ${lc.lc_no} — interest ${interest.toFixed(2)} and charges ${charges.toFixed(2)} paid upfront from the bank, per its statement` +
      (lcInterestBaseIsCustom(lc) ? ` (interest on ${lcInterestBasis(lc)})` : ''),
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: L.interest, group: 'Indirect Expenses', dr: interest },
      { account: L.charges, group: 'Indirect Expenses', dr: charges },
      { account: bankAcc, group: 'Bank Accounts', cr: total }
    ]
  })
  // THE NEW VOUCHER TAKES THE OLD ONE'S PLACE — same id, same number.
  if (oldId && oldId !== je.id && !(await c.execute({ sql: 'SELECT 1 FROM journal_entries WHERE id = ?', args: [oldId] })).rows.length) {
    await c.execute({
      sql: `INSERT INTO journal_entries (id, company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id)
            SELECT ?, company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id FROM journal_entries WHERE id = ?`,
      args: [oldId, je.id]
    })
    await c.execute({ sql: 'UPDATE journal_lines SET entry_id = ? WHERE entry_id = ?', args: [oldId, je.id] })
    const keptNo = (await c.execute({ sql: 'SELECT 1 FROM voucher_numbers WHERE entry_id = ?', args: [oldId] }).catch(() => ({ rows: [] }))).rows.length
    if (keptNo) await c.execute({ sql: 'DELETE FROM voucher_numbers WHERE entry_id = ?', args: [je.id] }).catch(() => {})
    else await c.execute({ sql: 'UPDATE voucher_numbers SET entry_id = ? WHERE entry_id = ?', args: [oldId, je.id] }).catch(() => {})
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [je.id] })
    je.id = oldId
  }
  await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = ? WHERE id = ?', args: [je.id, lcId] })
  // The fees now sit here, so the settlement voucher must let go of them.
  // Without this they would be charged twice: once on this voucher and once on
  // the settlement journal that was written before the bank line was matched.
  await resyncLcSettlement(lcId)
  return { id: je.id }
  })
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
export function lcFeeDelta(): number {
  // Always nil. This existed to plug the gap netAvailable() opened by sizing a
  // bill at the LC amount LESS interest and charges, which made the supplier's
  // ledger show them paid less than they were owed. The beneficiary is paid in
  // full, so there is nothing left to correct.
  //
  // Kept rather than deleted so syncLcFeeAdjustment() still runs and REMOVES
  // the corrections already posted under the old rule — saving any such LC
  // clears its plug voucher.
  return 0
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
  return withDbTransaction(async () => {
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
  const delta = lcFeeDelta()
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
  })
}

// Keeps an ALREADY-POSTED upfront interest/charges voucher in step with the
// LC's own numbers, for when interest %, charges, the open amount or the
// interest days are edited after the fact. Deliberately only refreshes an
// entry that already exists — posting one early is the bank reconciliation's
// job (see postLcUpfrontInterest above), not an edit's. The original entry
// date is kept, since that's the date the bank actually took the money.
export async function refreshLcUpfrontInterest(lcId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT interest_journal_entry_id, COALESCE(interest_upfront, 0) AS upfront,
                 payment_received_date, opened_date, open_date
            FROM letters_of_credit WHERE id = ?`,
    args: [lcId]
  })
  if (!res.rows.length) return
  const lc = toPlain(res)[0]
  const jeId = n(lc.interest_journal_entry_id)
  if (jeId) {
    // It exists: keep its date, which is a fact about when the bank took the
    // money, and re-derive its figures.
    const je = await c.execute({ sql: 'SELECT entry_date FROM journal_entries WHERE id = ?', args: [jeId] })
    const date = String(je.rows[0]?.entry_date || '').slice(0, 10)
    await postLcUpfrontInterest(lcId, date || undefined)
    return
  }
  // UPFRONT MEANS TWO VOUCHERS, WHETHER OR NOT THE STATEMENT HAS BEEN MATCHED.
  //
  // This used to wait for the bank line to be reconciled before raising the
  // interest voucher at all. Until then the fees rode on the settlement
  // journal instead, which folded two different acts into one entry:
  //
  //   party Dr · interest Dr · charges Dr · LC payable Cr
  //
  // But they ARE two acts, and they are settled by two different parties. The
  // bank honours the credit out of its own funds — nothing of ours moves, one
  // liability is exchanged for another — while the interest and the commission
  // come out of OUR account. Posted as one entry the bank's payable is
  // inflated by fees it never lent, and our own bank shows no payment at all.
  //
  // So an LC whose terms say the interest is paid upfront raises its own
  // voucher from the moment it is saved:
  //
  //   1  party Dr                       LC payable - <bank> Cr     (the credit)
  //   2  interest Dr, bank charges Dr   our bank Cr                (what we paid)
  //
  // Reconciling the statement line later re-posts voucher 2 on the date the
  // bank actually took it; until then it sits on the day the money landed,
  // which is the day the bank charged for.
  if (!n(lc.upfront)) return
  const date =
    String(lc.payment_received_date || lc.opened_date || lc.open_date || '').slice(0, 10) || undefined
  await postLcUpfrontInterest(lcId, date)
  })
}

// Reverses the upfront-interest posting above — used when its bank statement
// line is un-reconciled (or reclassified to misc), so the books don't keep an
// entry no longer backed by a confirmed statement line.
export async function dropLcUpfrontInterest(lcId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT interest_journal_entry_id FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (res.rows.length && res.rows[0].interest_journal_entry_id) {
    await dropEntry(n(res.rows[0].interest_journal_entry_id))
    await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    // Nothing carries the fees now, so the settlement voucher takes them back.
    // Un-matching a bank line should move an expense, never delete it.
    await resyncLcSettlement(lcId)
  }
  })
}

// An LC's margin/security-deposit FD, released back as cash once the LC is
// preclosed and the bank no longer needs it held — a separate, optional
// voucher from the preclosure's repayment (see saveLcRepayment below).
export async function postLcMarginRelease(lcId: number, amount: number, dateIn?: string): Promise<{ id: number } | null> {
  // NOTHING TO RELEASE, BECAUSE NOTHING WAS POSTED.
  //
  // The margin never enters the ledger at opening, so refunding it has no
  // entry to reverse — crediting LC MARGIN A/C here would drive an account
  // that holds nothing straight through zero. The release is still a fact
  // about the LC and precloseLC still records it on the row; it simply does
  // not reach the books.
  void lcId
  void amount
  void dateIn
  return null
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
): Promise<{ id: number; payoutId?: number } | null> {
  return withDbTransaction(async () => {
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
  const payable = await lcPayable(lc)
  const L = await lcLedgerNames()
  const value = round2(amount)
  if (value < 0.005) return null
  const date = String(dateIn || todayISO()).slice(0, 10)

  // Winding an LC up early means the interest for the unexpired stretch was
  // never incurred. That is not income and it is not a receipt — it is the
  // charge coming back off, so it posts as the OPPOSITE of the entry that put
  // it on: Cr INTEREST A/C, against the liability that carried it.
  //
  // A JOURNAL, and a voucher of its own. Folding it into a receipt called a
  // reversal a collection, and left the interest account reading as though the
  // full stretch had been charged and something unrelated had come in.
  const je = await postJournal({
    date,
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration:
      `LC ${lc.lc_no} preclosed — interest of ${value.toFixed(2)} reversed for the days that will not happen` +
      `${direction === 'pay_to_party' ? ', and passed on to the supplier' : ''}`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: payable, group: LC_PAYABLE_GROUP, dr: value },
      { account: L.interest, group: 'Indirect Expenses', cr: value }
    ]
  })

  // Where the rebate is handed to the supplier rather than kept, that is a
  // second and quite separate event: money leaving for them. It stays its own
  // PAYMENT so the reversal above is not entangled with a payout.
  let payoutId: number | undefined
  if (direction === 'pay_to_party') {
    const party = String(lc.supplier_name || '').trim()
    if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
    const pay = await postJournal({
      date,
      vchType: 'PAYMENT',
      vchNo: String(lc.lc_no || ''),
      narration: `LC ${lc.lc_no} — preclosure interest rebate of ${value.toFixed(2)} paid on to ${party}`,
      companyId: n(lc.company_id) || undefined,
      lines: [
        { account: party, group: 'Sundry Creditors', dr: value },
        { account: bankAcc, group: 'Bank Accounts', cr: value }
      ]
    })
    payoutId = pay.id
  }
  return { id: je.id, payoutId }
  })
}

// Every sale invoice belonging to the LC's linked Trading deal(s), with
// what's still outstanding on each — the same "bill" a manual Receipt +
// Agst Ref would pick from in Accounts, keyed the identical way
// (invoice_group, falling back to invoice_no) so this and a hand-entered
// receipt always agree on what's still owed.
async function outstandingSaleRefsForLc(
  lcId: number
): Promise<{ lc: Row; customerName: string; refs: SaleRef[] }> {
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

  // The buyer comes back with each bill. An invoice belongs to exactly one
  // customer, so grouping by ref still yields one name per row.
  const salesRes = await c.execute({
    sql: `SELECT COALESCE(sl.invoice_group, sl.invoice_no) AS key, MIN(sl.invoice_no) AS invoice_no,
                 MIN(sl.sale_date) AS sale_date, MIN(cu.name) AS customer_name,
                 SUM(sl.amount + sl.gst_amount + sl.round_off - sl.tds_amount) AS due
          FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
          WHERE sl.id IN (${saleIds.join(',')}) GROUP BY key`,
    args: []
  })
  const bills = toPlain(salesRes)
    .map((s) => ({
      key: String(s.key || '').trim(),
      invoice_no: String(s.invoice_no || ''),
      sale_date: String(s.sale_date || ''),
      customer_name: String(s.customer_name || '').trim(),
      due: round2(n(s.due))
    }))
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
  return withDbTransaction(async () => {
  // Same as the BD side above: a trading LC settles against its resale
  // invoices, and an LC with none of them records the receipt plainly.
  let lc: Row
  let customerName: string
  let refs: SaleRef[]
  try {
    ;({ lc, customerName, refs } = await outstandingSaleRefsForLc(lcId))
  } catch {
    return postSimplePaymentIn('lc', lcId, amount, dateIn)
  }
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
  // Worked out before the voucher is written, because the credits have to
  // follow the bills: a deal resold to two buyers credits two debtors, each
  // for what its own invoices took.
  // RECORDED ON THE LC, NOT POSTED — see PAYMENT IN IS A RECORD below.
  void bankAcc
  void customerName
  void planReceipt
  void allocAgainst
  const already = await recordedPaymentIns('lc', lcId)
  if (value > round2(totalDue - already) + 0.005) {
    throw new Error(`Only ${round2(totalDue - already).toFixed(2)} is still expected on this LC after what is already recorded`)
  }
  const ins = await c.execute({
    sql: 'INSERT INTO lc_payment_ins (lc_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, NULL)',
    args: [lcId, date, value]
  })
  return { id: Number(ins.lastInsertRowid || 0), date }
  })
}

/**
 * PAYMENT IN IS A RECORD, NOT A VOUCHER.
 *
 * The money a party pays back on an LC or a discounted bill reaches the bank,
 * and the bank's receipt is already in the books — booked from Tally, the
 * book the accountants keep (Ashok's 85,98,493 on 17-09 as RCP/206). Posting
 * a second receipt here put the same money in the bank twice (RCP/26 + RCP/27
 * for B7 and T2). So a payment in is now kept on the facility only — its
 * date, amount, method and reference, for the facility's own "what came
 * back" — and posts nothing. The ones posted before are taken back through
 * Settings → Accounting checks (previewPaymentInVouchers below).
 */
async function recordedPaymentIns(kind: 'lc' | 'bd', id: number): Promise<number> {
  const table = kind === 'lc' ? 'lc_payment_ins' : 'bd_payment_ins'
  const col = kind === 'lc' ? 'lc_id' : 'bd_id'
  const r = await getClient().execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS t FROM ${table} WHERE ${col} = ? AND journal_entry_id IS NULL`,
    args: [n(id)]
  })
  return round2(n((r.rows[0] as unknown as Row)?.t))
}

/**
 * A PAYMENT COMING BACK, WITH NOTHING TO SET IT AGAINST.
 *
 * On a TRADING facility the money comes back through resale invoices, and the
 * receipt is allocated bill by bill against them — that is the path above and
 * below this, and it stays exactly as it was.
 *
 * Everywhere else there are no such invoices. A manufacturing LC or discounted
 * bill funds the company's own trade, and when the money comes back it is a
 * receipt from the party the facility names and nothing more. Refusing to
 * record it — which is what happened before — meant the one screen that knows
 * the money was expected could not say it had arrived.
 *
 * Dr the bank, Cr the party. No allocation, because there is no bill to
 * allocate against, and inventing one would put a reference on a ledger that
 * no document answers for.
 */
async function facilityParty(row: Row): Promise<{ name: string; group: string }> {
  const c = getClient()
  // Whoever is named as paying us, if anybody is; otherwise the facility's own
  // party, which on a customer-side bill IS the debtor.
  const rid = n(row.receivable_party_id)
  if (rid) {
    const r = await c.execute({ sql: 'SELECT name FROM customers WHERE id = ?', args: [rid] })
    const nm = String((r.rows[0] as unknown as Row)?.name || '').trim()
    if (nm) return { name: nm, group: 'Sundry Debtors' }
  }
  const pid = n(row.party_id)
  const kind = String(row.party_type || '').trim().toLowerCase()
  if (pid && (kind === 'customer' || kind === 'supplier')) {
    const table = kind === 'customer' ? 'customers' : 'suppliers'
    const r = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [pid] })
    const nm = String((r.rows[0] as unknown as Row)?.name || '').trim()
    // A supplier paying US is unusual but it is what the bill says, and the
    // group has to match the ledger they already have or a second one opens.
    if (nm) return { name: nm, group: kind === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors' }
  }
  throw new Error('This facility names no party for the money to come back from — set one on it first')
}

export async function postSimplePaymentIn(
  kind: 'lc' | 'bd',
  facilityId: number,
  amount: number,
  dateIn?: string,
  method?: string,
  /** The bank the money actually landed in, and the bank's own reference. */
  account?: string,
  ref?: string
): Promise<{ id: number; date: string }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const table = kind === 'lc' ? 'letters_of_credit' : 'bill_discountings'
  const res = await c.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [n(facilityId)] })
  if (!res.rows.length) throw new Error(kind === 'lc' ? 'LC not found' : 'Discounted bill not found')
  const row = toPlain(res)[0]
  const value = round2(n(amount))
  if (value < 0.005) throw new Error('Enter the amount received')
  const date = String(dateIn || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The date the payment was received')
  // Recorded on the facility, not posted — see PAYMENT IN IS A RECORD.
  const named = String(account || '').trim()
  const refNo = String(ref || '').trim()
  const how = payMethod(method)
  if (how === 'Adjustment' && !named) throw new Error('Name the ledger this adjustment is set off against')
  void facilityParty
  void receivingSide
  const ins =
    kind === 'lc'
      ? await c.execute({
          sql: 'INSERT INTO lc_payment_ins (lc_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, NULL)',
          args: [n(facilityId), date, value]
        })
      : await c.execute({
          sql: `INSERT INTO bd_payment_ins (bd_id, pay_date, amount, journal_entry_id, method, account, ref_no)
                VALUES (?, ?, ?, NULL, ?, ?, ?)`,
          args: [n(facilityId), date, value, how, named || null, refNo || null]
        })
  return { id: Number(ins.lastInsertRowid || 0), date }
  })
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
): Promise<{ bd: Row; customerName: string; refs: SaleRef[] }> {
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

  // Same as the LC side: each bill names the buyer that owes it.
  const salesRes = await c.execute({
    sql: `SELECT COALESCE(sl.invoice_group, sl.invoice_no) AS key, MIN(sl.invoice_no) AS invoice_no,
                 MIN(sl.sale_date) AS sale_date, MIN(cu.name) AS customer_name,
                 SUM(sl.amount + sl.gst_amount + sl.round_off - sl.tds_amount) AS due
          FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
          WHERE sl.id IN (${saleIds.join(',')}) GROUP BY key`,
    args: []
  })
  const bills = toPlain(salesRes)
    .map((x) => ({
      key: String(x.key || '').trim(),
      invoice_no: String(x.invoice_no || ''),
      sale_date: String(x.sale_date || ''),
      customer_name: String(x.customer_name || '').trim(),
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
/**
 * The ways money comes back, as the desk would name them.
 *
 * A fixed list rather than free text: the point of recording the method is to
 * be able to say "show me what came by cheque", and forty spellings of RTGS
 * answer nothing. "Other" carries the rest without forcing a wrong choice.
 */
export const PAYMENT_IN_METHODS = ['RTGS', 'NEFT', 'IMPS', 'UPI', 'Cheque', 'Cash', 'Adjustment', 'Other'] as const

function payMethod(v: unknown): string | null {
  const want = String(v ?? '').trim()
  if (!want) return null
  const hit = PAYMENT_IN_METHODS.find((m) => m.toLowerCase() === want.toLowerCase())
  // An unknown method is not worth refusing a receipt over — the money did
  // arrive — so it is filed under Other rather than thrown away or trusted.
  return hit || 'Other'
}

// WHERE A PAYMENT IN ACTUALLY LANDED, AND SO WHAT KIND OF VOUCHER IT IS.
//
// Money into a bank or the cash box is a Receipt. An Adjustment is not money
// at all — the debtor's balance is set off against another ledger — so it is a
// Journal against that ledger, and it needs the ledger named: debiting a bank
// for a set-off would put money in the bank book that never arrived.
async function receivingSide(
  method: unknown,
  named: string,
  bankFallback: () => Promise<string> | string
): Promise<{ account: string; group: string; vchType: 'RECEIPT' | 'JOURNAL' }> {
  const how = payMethod(method)
  if (how === 'Adjustment') {
    if (!named) throw new Error('Name the ledger this adjustment is set off against')
    const r = await getClient().execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?', args: [named.toUpperCase()] })
    if (!r.rows.length) throw new Error(`No ledger called "${named}"`)
    return { account: named, group: String(r.rows[0].acc_group), vchType: 'JOURNAL' }
  }
  if (how === 'Cash') return { account: named || 'CASH A/C', group: 'Cash-in-Hand', vchType: 'RECEIPT' }
  return { account: named || (await bankFallback()), group: 'Bank Accounts', vchType: 'RECEIPT' }
}

export async function postBdPaymentIn(
  bdId: number,
  amount: number,
  dateIn?: string,
  selectedKeys?: string[],
  method?: string,
  account?: string,
  ref?: string
): Promise<{ id: number; date: string }> {
  return withDbTransaction(async () => {
  // TRADING SETTLES AGAINST ITS RESALE INVOICES. EVERYTHING ELSE JUST ARRIVES.
  //
  // A manufacturing bill funds the company's own trade and has no resale
  // invoices to allocate against, so this used to refuse the receipt outright
  // — the one screen that knows the money was expected could not record that
  // it had come. It falls through to the plain receipt instead: Dr bank, Cr
  // the party the bill names.
  let bd: Row
  let customerName: string
  let refs: SaleRef[]
  try {
    ;({ bd, customerName, refs } = await outstandingSaleRefsForBd(bdId))
  } catch {
    return postSimplePaymentIn('bd', bdId, amount, dateIn, method, account, ref)
  }
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
  // See the LC side: one credit line per debtor, each for what its own bills
  // actually took, worked out before the voucher is written.
  // Recorded on the bill, not posted — see PAYMENT IN IS A RECORD.
  void customerName
  const how = payMethod(method)
  const named = String(account || '').trim()
  const refNo = String(ref || '').trim()
  const already = await recordedPaymentIns('bd', bdId)
  if (value > round2(totalDue - already) + 0.005) {
    throw new Error(`Only ${round2(totalDue - already).toFixed(2)} is still expected on this bill after what is already recorded`)
  }
  const ins = await c.execute({
    sql: `INSERT INTO bd_payment_ins (bd_id, pay_date, amount, journal_entry_id, method, account, ref_no)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    args: [bdId, date, value, how, named || null, refNo || null]
  })
  return { id: Number(ins.lastInsertRowid || 0), date }
  })
}

/**
 * PAYMENT-IN VOUCHERS POSTED BEFORE PAYMENT IN BECAME A RECORD.
 *
 * Each one is the same money as the bank's receipt already booked from Tally.
 * Listed for review; on Apply the voucher (its lines and allocations) goes and
 * the payment in stays on its facility as a record. The voucher number stays
 * taken, so nothing else renumbers.
 */
export async function previewPaymentInVouchers(): Promise<Row> {
  const c = getClient()
  const rows: Row[] = []
  for (const kind of ['bd', 'lc'] as const) {
    const sql =
      kind === 'bd'
        ? `SELECT pi.id, pi.pay_date, pi.amount, pi.journal_entry_id, bd.bd_no AS facility, bd.company_id, co.name AS company
             FROM bd_payment_ins pi JOIN bill_discountings bd ON bd.id = pi.bd_id LEFT JOIN companies co ON co.id = bd.company_id
            WHERE pi.journal_entry_id IS NOT NULL`
        : `SELECT pi.id, pi.pay_date, pi.amount, pi.journal_entry_id, l.lc_no AS facility, l.company_id, co.name AS company
             FROM lc_payment_ins pi JOIN letters_of_credit l ON l.id = pi.lc_id LEFT JOIN companies co ON co.id = l.company_id
            WHERE pi.journal_entry_id IS NOT NULL`
    for (const r of toPlain(await c.execute(sql))) {
      const eid = n(r.journal_entry_id)
      const head = toPlain(
        await c.execute({
          sql: `SELECT je.entry_date, je.narration, (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
                  FROM journal_entries je WHERE je.id = ?`,
          args: [eid]
        })
      )[0]
      if (!head) continue
      const lines = toPlain(
        await c.execute({
          sql: 'SELECT a.name, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.dr DESC',
          args: [eid]
        })
      )
      rows.push({
        key: `${kind}:${n(r.id)}`,
        kind,
        facility: String(r.facility || ''),
        company: String(r.company || ''),
        date: String(r.pay_date || head.entry_date || '').slice(0, 10),
        amount: round2(n(r.amount)),
        code: String(head.code || ''),
        entry_id: eid,
        bank: String(lines.find((l) => n(l.dr) > 0)?.name || ''),
        party: String(lines.find((l) => n(l.cr) > 0)?.name || '')
      })
    }
  }
  return { findings: rows.sort((a, b) => String(a.date).localeCompare(String(b.date))) }
}

export async function removePaymentInVouchers(keys: string[]): Promise<{ removed: number }> {
  const want = new Set((keys || []).map(String))
  if (!want.size) throw new Error('Pick at least one payment in')
  return withDbTransaction(async () => {
    const c = getClient()
    const { findings } = await previewPaymentInVouchers()
    let removed = 0
    for (const f of findings as Row[]) {
      if (!want.has(String(f.key))) continue
      const eid = n(f.entry_id)
      const old = toPlain(await c.execute({ sql: 'SELECT a.name, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?', args: [eid] }))
      console.log(`[repairs] payment-in voucher ${String(f.code)} (${String(f.kind)} ${String(f.facility)}, ${String(f.date)}, ${String(f.amount)}) removed — lines ${JSON.stringify(old)}`)
      await dropEntry(eid)
      const table = f.kind === 'lc' ? 'lc_payment_ins' : 'bd_payment_ins'
      await c.execute({ sql: `UPDATE ${table} SET journal_entry_id = NULL WHERE id = ?`, args: [n(String(f.key).split(':')[1])] })
      removed++
    }
    return { removed }
  })
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
  return withDbTransaction(async () => {
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
  })
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
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_payment_ins WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropEntry(n(res.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_payment_ins WHERE id = ?', args: [id] })
  return { id }
  })
}

// A bill under the LC matures and the bank pays the supplier: the payable
// clears against the original invoice, money leaves the bank.
// Settle one bill. Delegates, deliberately: a second implementation of this
// posting is how the books came to disagree with themselves in the first place.
//
// It had its own postJournal crediting the bank directly, so settling a bill by
// hand posted the way the app used to — while the same act through Payment
// received posted the way it does now. Two paths, two answers, and no way to
// tell from a voucher which one had written it.
//
// There is one path now. Everything about how an LC settles lives in
// settleLcBillsCombined, and every caller reaches it.
export async function settleLcBill(issuanceId: number, dateIn?: string): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT status FROM lc_issuances WHERE id = ?', args: [issuanceId] })
  if (!res.rows.length) throw new Error('LC bill not found')
  if (String(res.rows[0].status) === 'settled') throw new Error('This bill is already settled')
  const je = await settleLcBillsCombined([issuanceId], dateIn)
  if (!je) throw new Error('That bill could not be settled')
  return je
  })
}

// Every bill still outstanding on an LC settles as ONE payment — one bank
// withdrawal, one journal entry — the same way a real payment voucher covers
// several invoices at once. Each bill still gets its own bill-wise allocation
// row on the party line, so the ledger can be expanded to show exactly how
// the lump sum squares off invoice by invoice.
export async function settleLcBillsCombined(
  issuanceIds: number[],
  dateIn?: string,
  // When given, the settlement is written back over THIS entry instead of a new
  // one. The ledger numbers vouchers by position, so a fresh entry would land at
  // the end of the sequence with a new number and shift every voucher after the
  // old one — see repostJournal.
  reuseEntryId?: number
): Promise<{ id: number } | null> {
  return withDbTransaction(async () => {
  if (!issuanceIds.length) return null
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT i.*, l.lc_no, l.bank, l.our_bank_id, l.party_type, l.party_id, l.company_id,
                 l.amount AS lc_amount, l.charges AS lc_charges, l.interest_pct, l.usance_days,
                 l.interest_upfront, l.interest_excl_charges, l.interest_adj,
                 l.interest_journal_entry_id,
                 s.name AS supplier_name, o.invoice_no
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
  if (bills.some((b) => n(b.lc_id) !== n(first.lc_id) || n(b.company_id) !== n(first.company_id) || n(b.party_id) !== n(first.party_id))) {
    throw new Error('Settle bills from one LC, company and supplier at a time')
  }
  const party = String(first.supplier_name || '').trim()
  if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const total = round2(bills.reduce((s2, b) => s2 + n(b.amount), 0))
  const payable = await lcPayable(first)
  const L = await lcLedgerNames()

  // ONE voucher, because this is one event.
  //
  // The bank honours the credit: it pays the beneficiary the net and keeps its
  // interest and commission out of the same credit, in a single act. Posting
  // the supplier in one journal and the fees in another made two entries out of
  // one, numbered differently, so nothing on screen showed they belonged
  // together — and the payable was credited twice for halves of one figure.
  //
  // The fees are taken once per LC, however many bills share the voucher.
  const feeLines: { account: string; group: string; dr?: number; cr?: number }[] = []
  let fees = 0
  const seen = new Set<number>()
  // PAID IN PARTS: each part's voucher carries that part's own interest, and
  // part 1 the bank's charges — stored on lc_parts when the part was paid.
  const partNos = [...new Set(bills.map((b) => n(b.installment_no)).filter((x) => x > 0))]
  const partRows = partNos.length
    ? toPlain(
        await c
          .execute({
            sql: `SELECT part_no, interest, charges FROM lc_parts WHERE lc_id = ? AND part_no IN (${partNos.map(() => '?').join(',')})`,
            args: [n(first.lc_id), ...partNos]
          })
          .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
      )
    : []
  if (partRows.length) {
    const interest = round2(partRows.reduce((s, p) => s + n(p.interest), 0))
    const charges = round2(partRows.reduce((s, p) => s + n(p.charges), 0))
    if (interest > 0.005) feeLines.push({ account: L.interest, group: 'Indirect Expenses', dr: interest })
    if (charges > 0.005) feeLines.push({ account: L.charges, group: 'Indirect Expenses', dr: charges })
    fees = round2(interest + charges)
    for (const b of bills) seen.add(n(b.lc_id))
  }
  for (const b of bills) {
    const lcId = n(b.lc_id)
    if (seen.has(lcId)) continue
    seen.add(lcId)
    // The fees belong on this voucher unless they are ALREADY on one of their
    // own. The test is whether that voucher exists, not whether the LC is
    // FLAGGED as paid upfront — those are different things, and reading the flag
    // instead of the fact lost the fees altogether.
    //
    // The upfront voucher is raised only when the bank line is reconciled
    // (bankRecon), so an LC ticked "interest paid upfront" whose statement line
    // was never matched had its interest and commission on no voucher at all:
    // this loop skipped them on the flag, and nothing else ever posted them.
    // Three live LCs were carrying ₹5,34,176 of unposted bank expense that way.
    //
    // Keying off the voucher makes the expense appear exactly once in either
    // state, and postLcUpfrontInterest/dropLcUpfrontInterest re-post this
    // voucher so the two stay in step when a line is matched or un-matched.
    if (n(b.interest_journal_entry_id)) continue
    // One LC expense, even when separate bills settle in separate calls. On
    // resync, the earliest retained settlement owns the full fee; later ones
    // release it. This also repairs duplicate fee legs on a controlled repost.
    const prior = await c.execute({
      sql: `SELECT MIN(i.journal_entry_id) AS id FROM lc_issuances i
        JOIN journal_entries e ON e.id=i.journal_entry_id
        WHERE i.lc_id=? AND i.status='settled' AND i.journal_entry_id<>?`,
      args: [lcId, reuseEntryId || 0]
    })
    const priorId = n(prior.rows[0]?.id)
    if (priorId && (!reuseEntryId || priorId < reuseEntryId)) continue
    const interest = lcInterest({
      amount: b.lc_amount,
      charges: b.lc_charges,
      interest_pct: b.interest_pct,
      usance_days: b.usance_days,
      interest_excl_charges: b.interest_excl_charges,
      interest_adj: b.interest_adj
    })
    const charges = round2(n(b.lc_charges))
    if (interest > 0.005) feeLines.push({ account: L.interest, group: 'Indirect Expenses', dr: interest })
    if (charges > 0.005) feeLines.push({ account: L.charges, group: 'Indirect Expenses', dr: charges })
    fees = round2(fees + interest + charges)
  }

  const post = reuseEntryId
    ? (args: Parameters<typeof postJournal>[0]): Promise<{ id: number }> => repostJournal(reuseEntryId, args)
    : postJournal
  const je = await post({
    date,
    // A JOURNAL, not a PAYMENT. Nothing of yours moves here — the bank honours
    // the credit out of its own funds. One liability is exchanged for another:
    // the supplier is discharged, and the bank takes their place.
    vchType: 'JOURNAL',
    vchNo: String(first.lc_no || ''),
    // A bill auto-issued against the whole LC is NAMED after it, so repeating
    // the name tells the reader nothing. It is mentioned only when it carries a
    // name of its own, such as a reference the bank gave you.
    narration: (() => {
      const bill = String(first.bill_no || '').trim()
      const named =
        bills.length === 1 && bill && bill !== String(first.lc_no || '').trim() ? ` (bill ${bill})` : ''
      const many = bills.length > 1 ? ` — ${bills.length} bills` : ''
      const kept = fees > 0.005 ? `, keeping ${fees.toFixed(2)} interest and commission` : ''
      // Only when the base is not the ordinary one — see lcInterest.ts.
      const basis = fees > 0.005 && lcInterestBaseIsCustom(first) ? ` (interest on ${lcInterestBasis(first)})` : ''
      return `LC ${first.lc_no}${named}${many} matured — ${first.bank} paid ${party} ${total.toFixed(2)}${kept}${basis}`
    })(),
    companyId: n(first.company_id) || undefined,
    lines: [
      { account: party, group: 'Sundry Creditors', dr: total },
      ...feeLines,
      { account: payable, group: LC_PAYABLE_GROUP, cr: round2(total + fees) }
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
  })
}

// Re-posts an LC's settlement voucher from the LC's CURRENT figures.
//
// A voucher written once and never revisited goes stale the moment anything it
// was derived from changes: correct an interest rate or a commission after the
// bank has paid, and the ledger keeps yesterday's number for ever. Every other
// voucher in this cycle is re-posted on save; this one was not, because the
// bills were already settled and settling skips them.
//
// The settlement DATE is preserved — it is a fact about when the bank paid, not
// something to be re-derived — and bills that shared a voucher are kept
// together so a combined settlement stays combined.
export async function resyncLcSettlement(lcId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  // A REPAID LC'S SETTLEMENT IS HISTORY.
  //
  // Re-deriving it from the LC's terms is right while the LC is live — a
  // corrected rate or usance should reach the books. Once the bank has been
  // repaid it is not: the settlement then recorded what the bank actually
  // paid and kept, and the repayment cleared exactly that. Re-saving such an
  // LC recomputed its fees from today's terms (one extra usance day on LC-9,
  // ₹1,612.22) while keeping the old supplier figure, and a payable that had
  // cleared to the rupee was left owing the difference. So a repaid LC keeps
  // the settlement it has; where its payable does not clear, Settings →
  // Accounting checks lists it for reconciliation against the bank's advice.
  const closed = await c.execute({
    sql: `SELECT l.preclosed_date,
                 (SELECT COALESCE(SUM(r.amount), 0) FROM lc_repayments r WHERE r.lc_id = l.id) AS repaid
            FROM letters_of_credit l WHERE l.id = ?`,
    args: [n(lcId)]
  })
  if (closed.rows.length && (closed.rows[0].preclosed_date || n(closed.rows[0].repaid) > 0.005)) return
  const res = await c.execute({
    sql: `SELECT i.id, i.journal_entry_id, i.settled_date, i.installment_no, l.payment_received_date
            FROM lc_issuances i JOIN letters_of_credit l ON l.id = i.lc_id
           WHERE i.lc_id = ? AND i.journal_entry_id IS NOT NULL ORDER BY i.journal_entry_id, i.id`,
    args: [n(lcId)]
  })
  if (!res.rows.length) return
  const groups = new Map<number, { ids: number[]; date: string }>()
  for (const r of toPlain(res)) {
    const je = n(r.journal_entry_id)
    // The bill settled AT payment received (no part, or part 1) is dated by
    // the LC's payment-received date — the day syncPaymentReceivedIssuance
    // posts it — so correcting that date on the LC moves the voucher with it.
    // A later part keeps its own pay date.
    const atReceipt = n(r.installment_no) <= 1 && !!r.payment_received_date
    const date = atReceipt ? String(r.payment_received_date) : String(r.settled_date || '')
    if (!groups.has(je)) groups.set(je, { ids: [], date: date.slice(0, 10) })
    groups.get(je)!.ids.push(n(r.id))
  }
  const live: number[] = []
  for (const [entryId, g] of groups) {
    // Reopen WITHOUT dropping the voucher — it is about to be rewritten in
    // place. Deleting and re-inserting would renumber it and everything after
    // it, which is what had LC-15 reading JV/46 on one page and JV/23 on
    // another.
    await c.execute({
      sql: `UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL
             WHERE id IN (${g.ids.map(() => '?').join(',')})`,
      args: g.ids
    })
    const je = await settleLcBillsCombined(g.ids, g.date || undefined, entryId)
    if (je) live.push(je.id)
  }
  // Anything else claiming to be this LC's settlement is a leftover from a
  // re-post whose link was lost. Swept here, where the live ids are known, so
  // the sweep can never take the voucher it just wrote.
  const dropped = await dropOrphanLcSettlements(lcId, live)
  if (dropped) console.log(`[lc] removed ${dropped} orphaned settlement voucher(s) on LC ${lcId}`)
  })
}

// Settlement journals for this LC that no bill points at any more.
//
// A settlement voucher is only ever reachable through the bill that owns it —
// lc_issuances.journal_entry_id. If that link is broken while the voucher
// survives, the entry becomes invisible to every check the app makes and
// permanently doubles the party's balance: DEEPCHAND carried LC-15 twice for
// exactly this reason, 1,60,54,441.64 debited on JE 2266 and again on JE 2278.
//
// Earlier verification could not catch it, because "one voucher per LC" was
// counted over the vouchers bills point AT — an orphan is in neither the numerator
// nor the denominator.
//
// Matched narrowly: this LC's own number, this LC's company, the wording the
// settlement posts, a JOURNAL, and no bill referencing it. A hand-written
// journal would have to impersonate all five to be caught.
async function dropOrphanLcSettlements(lcId: number, keep: number[] = []): Promise<number> {
  const c = getClient()
  const lc = await c.execute({
    sql: 'SELECT lc_no, company_id FROM letters_of_credit WHERE id = ?',
    args: [n(lcId)]
  })
  if (!lc.rows.length) return 0
  const lcNo = String(lc.rows[0].lc_no || '').trim()
  if (!lcNo) return 0
  const skip = keep.filter((x) => n(x) > 0)
  const res = await c.execute({
    sql: `SELECT je.id FROM journal_entries je
           WHERE je.company_id = ?
             AND TRIM(COALESCE(je.vch_no, '')) = ?
             AND je.vch_type = 'JOURNAL'
             AND je.narration LIKE '%matured%'
             AND NOT EXISTS (SELECT 1 FROM lc_issuances i WHERE i.journal_entry_id = je.id)
             ${skip.length ? `AND je.id NOT IN (${skip.map(() => '?').join(',')})` : ''}`,
    args: [n(lc.rows[0].company_id), lcNo, ...skip]
  })
  for (const r of res.rows) await dropEntry(n(r.id))
  return res.rows.length
}

// Reopening a bill that was settled as part of a combined payment reopens
// every bill in that same payment — a lump bank withdrawal can't be partly
// undone without contradicting what the bank statement actually shows.
export async function reopenLcBill(issuanceId: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
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
  })
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

// Posts (or re-posts) the repayment's voucher: ONE payment, read the way the
// bank statement reads it —
//
//   Dr LC PAYABLE - <bank>   the principal (what the LC put out for us)
//   Dr COMM. CHARGES A/C     commission the bank took on the day, if any
//   Dr BANK CHARGES A/C      bank charges taken on the day, if any
//     Cr <our bank>          the one lump that left the account
//
// It used to route the charges THROUGH the payable — a journal raising the
// payable by the charges, then a payment clearing the payable by the whole
// lump — which balanced, but left LC PAYABLE showing ₹94,01,180 repaid on a
// ₹94,00,000 LC with a ₹1,180 credit beside it. The charges were never owed to
// the LC; they are this day's expense, straight out of the bank.
export async function postLcRepaymentEntry(repaymentId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT r.*, l.lc_no, l.company_id, l.bank, l.our_bank_id, l.amount AS lc_open_amount,
                 l.interest_upfront, l.interest_journal_entry_id AS lc_interest_journal_entry_id,
                 l.interest_pct AS lc_interest_pct, l.usance_days AS lc_usance_days,
                 l.charges AS lc_charges, l.interest_excl_charges AS lc_interest_excl_charges,
                 l.interest_adj AS lc_interest_adj
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          WHERE r.id = ?`,
    args: [repaymentId]
  })
  if (!res.rows.length) throw new Error('Repayment not found')
  const rep = toPlain(res)[0]
  const bankAcc = await bankAccountFor(rep)
  const payable = await lcPayable(rep)
  const L = await lcLedgerNames()
  await dropEntry(n(rep.journal_entry_id) || null)
  await dropEntry(n(rep.fee_journal_entry_id) || null)

  // The LC's own interest and commission are NOT here — normally. The bank
  // keeps them out of the credit when it pays the beneficiary, posted then
  // (see settleLcBillsCombined) and already sitting in the payable this
  // settles.
  //
  // An UPFRONT LC works differently: its interest/charges are meant to be
  // posted only once its bank statement line is reconciled
  // (postLcUpfrontInterest) — deliberately, so the figure comes from what the
  // bank's advice actually says rather than a guess at opening. But if that
  // reconciliation never happens before the LC is repaid, that voucher never
  // gets raised and the interest lands nowhere — the exact gap that lost
  // interest on LC-5, LC-11 and LC-26. Repayment is the last point this can
  // still be caught: an upfront LC whose interest_journal_entry_id is still
  // empty here gets it folded into this voucher instead of losing it.
  //
  // The "or equals this repayment's own fee voucher" half of the check is for
  // RE-posting: dropEntry just deleted that voucher above, so without it a
  // second save of the same repayment would see the id fetched before the
  // drop, believe the interest was already (still) posted elsewhere, and
  // quietly drop it a second time.
  const ownFeeJe = n(rep.fee_journal_entry_id) || null
  const upfrontStillDue =
    !!rep.interest_upfront && (!n(rep.lc_interest_journal_entry_id) || n(rep.lc_interest_journal_entry_id) === ownFeeJe)
  const upfrontInterest = upfrontStillDue
    ? lcInterest({
        amount: n(rep.lc_open_amount),
        interest_pct: n(rep.lc_interest_pct),
        usance_days: n(rep.lc_usance_days),
        interest_excl_charges: rep.lc_interest_excl_charges,
        interest_adj: n(rep.lc_interest_adj)
      })
    : 0
  const upfrontCharges = upfrontStillDue ? round2(n(rep.lc_charges)) : 0

  // What the bank took ON THE DAY over and above the principal — a maturity
  // charge, a commission keyed off the statement. This event's own cost, so it
  // goes on the payment itself (below), not through the payable.
  const total = round2(n(rep.amount))
  const comm = round2(n(rep.comm_charges))
  const bankCharges = round2(n(rep.bank_charges))
  const rows = storedChargeRows(rep)
  const rowsTotal = round2(rows.reduce((t, x) => t + x.amount, 0))
  const principal = round2(total - comm - bankCharges - rowsTotal)
  if (principal < -0.004) {
    throw new Error(`The charges (${(comm + bankCharges + rowsTotal).toFixed(2)}) are more than the ${total.toFixed(2)} debited — check the repayment amount`)
  }
  // A rescued upfront interest (and the LC's own charges with it) is the one
  // thing still raised against the payable in a voucher of its own: it was
  // owed on the LC, never reconciled, and this is where it is caught.
  const rescued = round2(upfrontInterest + upfrontCharges)
  const date = String(rep.repay_date || todayISO()).slice(0, 10)

  let feeJe: number | null = null
  if (rescued > 0.004) {
    const lines: { account: string; group: string; dr?: number; cr?: number }[] = []
    if (upfrontInterest > 0.005) lines.push({ account: L.interest, group: 'Indirect Expenses', dr: upfrontInterest })
    if (upfrontCharges > 0.005) lines.push({ account: L.charges, group: 'Indirect Expenses', dr: upfrontCharges })
    lines.push({ account: payable, group: LC_PAYABLE_GROUP, cr: rescued })
    const je = await postJournal({
      date,
      vchType: 'JOURNAL',
      vchNo: rep.lc_no ? String(rep.lc_no) : null,
      narration: `LC ${rep.lc_no} — ${rep.bank || 'the bank'} interest ${rescued.toFixed(2)} (never reconciled upfront, caught at repayment)`,
      companyId: n(rep.company_id) || undefined,
      lines
    })
    feeJe = je.id
    if (upfrontStillDue) {
      await c.execute({
        sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = ? WHERE id = ?',
        args: [je.id, n(rep.lc_id)]
      })
    }
  } else if (n(rep.lc_interest_journal_entry_id) === ownFeeJe && ownFeeJe) {
    // The voucher just dropped was the one carrying this LC's interest, and
    // nothing here replaces it (rescued rounds to nil) — leave the LC honestly
    // marked as not yet posted rather than pointing at a deleted entry.
    await c.execute({ sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?', args: [n(rep.lc_id)] })
  }

  // One lump out of the account, exactly what the statement shows — the
  // principal off the payable and the day's charges to expense beside it.
  const payLines: { account: string; group: string; dr?: number; cr?: number }[] = []
  if (principal > 0.004) payLines.push({ account: payable, group: LC_PAYABLE_GROUP, dr: principal })
  if (comm > 0.004) payLines.push({ account: L.comm, group: 'Indirect Expenses', dr: comm })
  if (bankCharges > 0.004) payLines.push({ account: L.charges, group: 'Indirect Expenses', dr: bankCharges })
  for (const x of rows) payLines.push({ account: x.account, group: x.group || 'Indirect Expenses', dr: x.amount })
  payLines.push({ account: bankAcc, group: 'Bank Accounts', cr: total })
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: rep.lc_no ? String(rep.lc_no) : null,
    narration:
      comm + bankCharges + rowsTotal > 0.004
        ? `LC ${rep.lc_no} repaid to ${rep.bank || 'the bank'} (incl. ${(comm + bankCharges + rowsTotal).toFixed(2)} charges)`
        : `LC ${rep.lc_no} repaid to ${rep.bank || 'the bank'}`,
    companyId: n(rep.company_id) || undefined,
    lines: payLines
  })
  await c.execute({
    sql: 'UPDATE lc_repayments SET journal_entry_id = ?, fee_journal_entry_id = ? WHERE id = ?',
    args: [je.id, feeJe, repaymentId]
  })
  })
}


/**
 * A REPAYMENT THAT NEVER RELIEVED THE PAYABLE IT PAID OFF.
 *
 * An LC's maturity credits LC PAYABLE - <our bank> with what the bank put out
 * on our behalf, and repaying it debits the same account back down to nothing.
 * One repayment in the book does not: it debits an account called
 * LC REPAYMENT A/C, which no code here writes and which holds that single
 * line. It is a voucher from an older posting shape, left behind when the
 * shape changed.
 *
 * The damage is quiet but real. The payable was raised and never cleared, so
 * the LC liability is overstated by the principal; and the matching debit sits
 * under Loans (Liability) as a liability with a debit balance, which is not a
 * thing. Neither figure is wrong by a rounding — they are wrong by the whole
 * repayment, on both sides of the balance sheet.
 *
 * The repair is one field: the line moves onto the payable it was always
 * paying. Nothing else about the voucher changes — same date, same amount, the
 * bank credit untouched, the charges still expensed, and the voucher still
 * balances, because only the name on one debit was wrong. The books land
 * exactly where the current posting path would have put them.
 *
 * Deliberately narrow. It moves a line only when the voucher is an LC
 * repayment's own voucher (lc_repayments points at it), and only onto the
 * payable that LC resolves to by the same rule every other LC posting uses.
 * Where that account does not already exist it leaves the line alone rather
 * than inventing one: a repair that creates ledgers is not a repair.
 *
 * Idempotent, and run on every start rather than recorded as done once. The
 * website's database is a restorable copy of the desktop's — a restore can
 * put the bad line back long after a one-shot migration has been marked
 * finished, and this costs one query to find nothing.
 */
/**
 * AN LC REPAYMENT FILED AS A JOURNAL.
 *
 * Repaying an LC is money out of our bank, so it is a Payment — every repayment
 * posts as one (postLcRepaymentEntry). LC-7's of 29-08 (JV/33, KR Foods) was
 * left a Journal by the 31-08 reposting, so it sat in the JV register and out
 * of the payment totals. Only a repayment voucher that credits a bank is
 * touched; it becomes a Payment and takes the next PAY number, the old code
 * logged to accounting_repair_log. Lines, date and amounts do not change.
 */
export async function fileLcRepaymentsAsPayments(): Promise<string[]> {
  await ensureVoucherNumbers()
  const found = await getClient().execute(`SELECT DISTINCT e.id FROM journal_entries e
      JOIN lc_repayments rp ON rp.journal_entry_id = e.id
     WHERE e.vch_type = 'JOURNAL'
       AND EXISTS (SELECT 1 FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                    WHERE jl.entry_id = e.id AND jl.cr > 0.004 AND a.acc_group IN ('Bank Accounts', 'Bank OD A/c'))
     ORDER BY e.entry_date, e.id`)
  if (!found.rows.length) return []
  const moved: string[] = []
  await withDbTransaction(async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
        repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    for (const r of found.rows) {
      const id = Number(r.id)
      const was = await voucherCodeOf(id)
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`lc-repay-as-payment:${id}`, id, JSON.stringify({ code: was, vch_type: 'JOURNAL' })]
      })
      await c.execute({ sql: "UPDATE journal_entries SET vch_type = 'PAYMENT' WHERE id = ?", args: [id] })
      await renumberOnTypeChange(id, 'PAYMENT')
      moved.push(`${was} → ${await voucherCodeOf(id)}`)
    }
  })
  return moved
}

export async function repairLcRepaymentAccount(): Promise<number> {
  const c = getClient()
  const bad = toPlain(
    await c.execute(`SELECT jl.id AS line_id, jl.entry_id, r.lc_id
                       FROM journal_lines jl
                       JOIN ledger_accounts a ON a.id = jl.account_id
                       JOIN lc_repayments r ON r.journal_entry_id = jl.entry_id
                      WHERE TRIM(UPPER(a.name)) = 'LC REPAYMENT A/C'`)
  )
  if (!bad.length) return 0
  let moved = 0
  for (const row of bad) {
    const lcRes = await c.execute({
      sql: 'SELECT * FROM letters_of_credit WHERE id = ? LIMIT 1',
      args: [n(row.lc_id)]
    })
    if (!lcRes.rows.length) continue
    const want = (await lcPayable(toPlain(lcRes)[0])).trim().toUpperCase()
    const acc = await c.execute({
      sql: 'SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ? LIMIT 1',
      args: [want]
    })
    if (!acc.rows.length) {
      console.error(`[lc] repayment line ${n(row.line_id)}: no ${want} account to move it onto`)
      continue
    }
    await c.execute({
      sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?',
      args: [n(acc.rows[0].id), n(row.line_id)]
    })
    moved++
  }
  if (moved) console.log(`[lc] ${moved} repayment line(s) moved onto the payable they clear`)
  return moved
}

/**
 * CHARGES ON LEDGERS THE USER PICKS — as many as the bank's debit carried
 * (commission, bank charges, GST on them, stamp duty…). Each must name a
 * ledger that already exists: a typo would otherwise open a new one.
 */
export async function lcChargeRows(rows: unknown, lender = ''): Promise<{ account: string; group: string; amount: number }[]> {
  const out: { account: string; group: string; amount: number }[] = []
  for (const ch of Array.isArray(rows) ? (rows as Row[]) : []) {
    const name = String(ch?.account || '').trim()
    const amt = round2(n(ch?.amount))
    if (!name && amt <= 0.004) continue
    if (!name) throw new Error('Pick the ledger for each charge')
    if (amt <= 0.004) throw new Error(`Enter the amount charged to ${name}`)
    // Paid over the balance and the bank will refund it: a receivable on this
    // bank's own refund-due ledger, made the first time (lib/refundDue.ts).
    if (isRefundDue(name)) {
      out.push({ account: refundLedgerFor(lender), group: REFUND_DUE_GROUP, amount: amt })
      continue
    }
    const acc = await getClient().execute({ sql: 'SELECT name, acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = UPPER(?) LIMIT 1', args: [name] })
    if (!acc.rows.length) throw new Error(`There is no ledger called ${name}`)
    out.push({ account: String(acc.rows[0].name), group: String(acc.rows[0].acc_group || 'Indirect Expenses'), amount: amt })
  }
  return out
}

/** The charge rows stored on an LC repayment. */
function storedChargeRows(rep: Row): { account: string; group?: string; amount: number }[] {
  try {
    const list = JSON.parse(String(rep?.charges || '[]'))
    return Array.isArray(list) ? list.filter((x) => String(x?.account || '').trim() && n(x?.amount) > 0.004).map((x) => ({ account: String(x.account), group: x.group ? String(x.group) : undefined, amount: round2(n(x.amount)) })) : []
  } catch {
    return []
  }
}

export async function saveLcRepayment(v: Row): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const lcId = n(v.lc_id)
  if (!lcId) throw new Error('Pick the LC this repayment is against')
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the repayment amount')
  const lcRes = await c.execute({ sql: 'SELECT amount, bank FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!lcRes.rows.length) throw new Error('LC not found')
  const openAmount = n(lcRes.rows[0].amount)
  if (amount < openAmount - 0.005) {
    throw new Error(`The repayment (${amount.toFixed(2)}) cannot be less than the LC's open amount (${openAmount.toFixed(2)})`)
  }
  const commCharges = round2(n(v.comm_charges))
  const bankCharges = round2(n(v.bank_charges))
  const chargeRows = await lcChargeRows(v.charges, String(lcRes.rows[0].bank || ''))
  const rowsTotal = round2(chargeRows.reduce((t, x) => t + x.amount, 0))
  const allCharges = round2(commCharges + bankCharges + rowsTotal)
  const excess = round2(amount - openAmount)
  if (excess > 0.005) {
    if (Math.abs(allCharges - excess) > 0.005) {
      throw new Error(
        `The charges must add up to the ${excess.toFixed(2)} over the open amount (currently ${allCharges.toFixed(2)})`
      )
    }
  } else if (allCharges > 0.005) {
    throw new Error('Charges only apply when the repayment exceeds the open amount')
  }
  const maturityCharges = allCharges
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
    const prev = await c.execute({
      sql: 'SELECT posted, journal_entry_id, fee_journal_entry_id FROM lc_repayments WHERE id = ?',
      args: [id]
    })
    if (!prev.rows.length) throw new Error('Repayment not found')
    await c.execute({
      sql: `UPDATE lc_repayments SET lc_id = ?, party_id = ?, amount = ?, maturity_charges = ?, comm_charges = ?, bank_charges = ?,
            repay_date = ?, posted = ?, document_path = ?, note = ? WHERE id = ?`,
      args: [...args, id]
    })
    if (n(prev.rows[0].posted) && !posted) {
      // A repayment raises two vouchers — the fee journal and the payment —
      // so un-posting has to take both. Dropping only the payment would leave
      // the interest accrued against a liability nothing ever settles.
      const oldFeeJe = n(prev.rows[0].fee_journal_entry_id) || null
      await dropEntry(n(prev.rows[0].journal_entry_id) || null)
      await dropEntry(oldFeeJe)
      await c.execute({
        sql: 'UPDATE lc_repayments SET journal_entry_id = NULL, fee_journal_entry_id = NULL WHERE id = ?',
        args: [id]
      })
      // If that fee voucher was also carrying a rescued upfront interest
      // (postLcRepaymentEntry's fallback), un-posting must not leave the LC
      // pointing at a voucher that no longer exists — it goes back to "not
      // yet posted" so a later re-post or bank reconciliation can catch it.
      if (oldFeeJe) {
        await c.execute({
          sql: 'UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ? AND interest_journal_entry_id = ?',
          args: [lcId, oldFeeJe]
        })
      }
    }
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO lc_repayments (lc_id, party_id, amount, maturity_charges, comm_charges, bank_charges, repay_date, posted, document_path, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args
    })
    id = Number(ins.lastInsertRowid)
  }
  // The ledger rows, and their total for the readers that take charges off
  // the principal (columns added at startup — lc_repay_charges_v1).
  await c.execute({
    sql: 'UPDATE lc_repayments SET charges = ?, charges_total = ? WHERE id = ?',
    args: [chargeRows.length ? JSON.stringify(chargeRows) : null, rowsTotal > 0.004 ? rowsTotal : null, id]
  })
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
  })
}

export async function deleteLcRepayment(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT journal_entry_id, fee_journal_entry_id FROM lc_repayments WHERE id = ?',
    args: [id]
  })
  if (res.rows.length) {
    // Both vouchers, for the same reason as un-posting above.
    await dropEntry(n(res.rows[0].journal_entry_id) || null)
    await dropEntry(n(res.rows[0].fee_journal_entry_id) || null)
  }
  await c.execute({ sql: 'DELETE FROM lc_repayments WHERE id = ?', args: [id] })
  return { id }
  })
}

// ---------------------------------------------------------------------------
// Monitoring: everything the treasury needs eyes on, in one call.
// ---------------------------------------------------------------------------

// ALL COMPANIES: each company's alerts, one list of each.
export async function treasuryAlerts(opts: { all?: boolean } = {}): Promise<Row> {
  if (!opts.all) return treasuryAlertsOne()
  const parts: Row[] = []
  for (const id of await allCompanyIds()) parts.push(await withCompany(id, treasuryAlertsOne))
  const byDays = (a: Row, b: Row): number => (Number(a.days_left) || 0) - (Number(b.days_left) || 0)
  return {
    lcExpiring: parts.flatMap((p) => (p.lcExpiring as Row[]) || []).sort(byDays),
    lcBillsDue: parts.flatMap((p) => (p.lcBillsDue as Row[]) || []).sort(byDays),
    billsDue: parts.flatMap((p) => (p.billsDue as Row[]) || []).sort(byDays),
    overdue: parts.reduce((s, p) => s + (Number(p.overdue) || 0), 0)
  }
}

async function treasuryAlertsOne(): Promise<Row> {
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

// The Payment Tracker lives in paymentTracker.ts now: it reads the LC and BD
// registers, which import this module, so it cannot sit here without a cycle.
