import { withDbTransaction } from './dbTransaction'
import { isRefundDue, refundLedgerFor, REFUND_DUE_GROUP } from '../renderer/src/lib/refundDue'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getSetting, setSetting } from './repos'
import { postJournal, repostJournal, type JournalLine } from './journal'
import { ensureBdPostingFields } from './accountingSchema'
import { ensureVoucherNumbers } from './voucherNumbers'
import { resolveAccountName } from './ledgerMap'

// WHERE A DISCOUNTED BILL'S LIABILITY SITS, WHICH IS WITH THE LENDER.
//
// It posted to a single BILLS DISCOUNTED A/C for every NBFC, so eight lenders'
// borrowing piled into one figure and no ledger could answer "what do I owe
// Vanik". LC has always kept a payable per bank (LC PAYABLE - <bank>); this is
// the same thing for the NBFC side. The NBFC's name is what the ledger is
// keyed on, so renaming the NBFC master carries the ledger with it through the
// same rename path every other party uses.
//
// The bare fallback is kept for a bill with no NBFC on it — nothing should
// reach here without one, but a name is not a thing to assume.
const BD_PAYABLE_GROUP = 'Loans (Liability)'
export function bdPayable(bd: Row): string {
  const nb = String(bd.nbfc_name || '').trim().replace(/\s+/g, ' ').toUpperCase()
  return nb ? `BILLS DISCOUNTED - ${nb}` : 'BILLS DISCOUNTED A/C'
}

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
  sanctionedAmount: number
  undrawnAmount: number
  openAmount: number
  interestBase: number
  interestAmount: number
  tdsAmount: number
  netInterest: number
  receiptAmount: number
  adjCharge: number
  received: number
  toReceive: number
  legs: {
    part_no: number
    date: string
    amount: number
    days: number
    interest: number
    net: number
    maturity: string
    interest_pct: number
    margin_pct: number | null
    margin: number
  }[]
} {
  const amount = n(bd.amount)
  // The invoice as adjusted: the Adj. figure beside it adds to or takes off the
  // invoice value before the margin is struck — a credit note against it, a
  // freight line billed on it. Only with an invoice on record; never below nil.
  const invoice = n(bd.invoice_amount) > 0 ? Math.max(0, round2(n(bd.invoice_amount) + n(bd.invoice_adj))) : 0
  const from = String(bd.payment_received_date || '').slice(0, 10)
  const to = String(bd.maturity_date || '').slice(0, 10)
  // Does the receipt date itself earn interest?
  //
  // Both answers are real conventions and NBFCs differ, so it is a term like
  // the rate is. Off — the default, and what every bill already on the books
  // was posted with — interest runs from the day AFTER the money lands to
  // maturity: 1 to 30 September is 29 days. On, both ends count and the same
  // two dates are 30 days.
  const inclStart = bd.days_incl_start ? 1 : 0
  const intDays = from && to ? Math.max(0, daysBetween(from, to) + inclStart) : 0

  // The margin is the NBFC's hold-back on the INVOICE it is discounting, so it
  // is struck on the invoice value and what is left is the sanctioned amount:
  //
  //   invoice - margin% of invoice = SANCTIONED
  //
  // A bill recorded before the invoice value was captured has no invoice to
  // strike it on, so it falls back to the amount itself -- which is exactly the
  // old behaviour, and is why no figure on an existing bill moves.
  const marginBase = invoice > 0 ? invoice : amount
  const marginAmount = round2((marginBase * n(bd.margin_pct)) / 100)
  const sanctionedAmount = round2(marginBase - marginAmount)

  // What is actually DRAWN. With an invoice on record that is the open amount as
  // typed -- normally the sanctioned figure, but the user may draw less, and the
  // shortfall is undrawn headroom rather than a mistake. Without one there is
  // nothing to draw against but the sanctioned figure itself.
  const drawn = invoice > 0 ? amount : sanctionedAmount
  const undrawnAmount = round2(sanctionedAmount - drawn)

  // A 360-day year by convention, overridable per record.
  const daysYear = n(bd.days_year) || 360
  // Interest runs on what was drawn: the margin never left the NBFC, and
  // undrawn headroom was never lent.
  const openAmount = drawn
  // WHAT THE INTEREST RUNS ON. Normally the whole Open amount — the Adj. only
  // moves what reaches the bank. Some NBFCs charge their interest on what is
  // left after their own deduction instead; the bill says so with
  // interest_after_adj, and then it runs on Open + Adj. (Only meaningful on
  // the charge basis: an older bill's amount already had the Adj. in it.)
  const interestBase =
    bd.interest_after_adj && bd.open_adj_charge ? Math.max(0, round2(openAmount + n(bd.open_adj))) : openAmount
  const interestAmount = round2((interestBase * n(bd.interest_pct) * intDays) / (100 * daysYear))
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
  // A serviced bill is the same shape as an upfront one at this moment: the
  // NBFC discounts nothing, the whole drawn amount lands, and the interest is
  // paid as it runs. Deducting it here AND charging it monthly would charge it
  // twice.
  const deducted = !bd.interest_upfront && String(bd.interest_mode || '') !== 'serviced'
  // THE ADJ. ON THE OPEN AMOUNT, as a charge (open_adj_charge = 1, every bill
  // saved from 2026-09-30). The NBFC lends the whole Open amount and charges
  // interest on the whole of it — the Adj. only changes what it pays out: a
  // minus is its own deduction from the draw (posted to BD CHARGES A/C), a plus
  // is something it adds. So the drawn amount and the interest stay on Open,
  // and the receipt moves by the Adj.
  //
  // A bill saved before then (open_adj_charge = 0) stored Open ± Adj as its
  // amount — the Adj. moved what was drawn — and keeps reading that way, so
  // none of its figures shift until it is saved again.
  const adjCharge = bd.open_adj_charge ? round2(n(bd.open_adj)) : 0
  const receiptAmount = round2((deducted ? openAmount - interestAmount : openAmount) + adjCharge)

  // RECEIVED IN PARTS (SID). The NBFC released the money in legs: the first
  // is the Payment received (first_receipt_part), each later one a row of
  // bd_receipt_parts. Interest runs on each leg from ITS OWN date to maturity,
  // so a leg that came later costs less — and the bill's interest is the sum.
  // Only what has been received is owed and earns interest; the rest of the
  // open amount is still to come.
  const firstLeg = round2(n(bd.first_receipt_part))
  if (firstLeg > 0.005 && from) {
    // Each leg may carry its own maturity, interest % and margin % (blank =
    // the bill's). Part 1's sit on the bill, the later ones on their rows.
    const ownRate = (v: unknown): number | null => (v == null || String(v).trim() === '' ? null : n(v))
    const raw = [
      {
        part_no: 1,
        date: from,
        amount: firstLeg,
        maturity: String(bd.first_receipt_maturity || '').slice(0, 10),
        rate: ownRate(bd.first_receipt_interest_pct),
        mpct: ownRate(bd.first_receipt_margin_pct)
      },
      ...((Array.isArray(bd.receipt_parts) ? bd.receipt_parts : []) as Row[]).map((p) => ({
        part_no: n(p.part_no),
        date: String(p.receipt_date || '').slice(0, 10),
        amount: round2(n(p.amount)),
        maturity: String(p.maturity_date || '').slice(0, 10),
        rate: ownRate(p.interest_pct),
        mpct: ownRate(p.margin_pct)
      }))
    ]
    // The bill's margin, shared out over the drawn amount, is what a leg with
    // no margin % of its own carries — so with none set the legs add back up to
    // exactly the bill's margin.
    const shareMargin = (amt: number): number => (openAmount > 0 ? (marginAmount * amt) / openAmount : 0)
    const legs = raw.map((l, i) => {
      const due = l.maturity || to
      const days = due && l.date ? Math.max(0, daysBetween(l.date, due) + inclStart) : 0
      const rate = l.rate == null ? n(bd.interest_pct) : l.rate
      // The Adj. moves the interest base only once — with the first leg, which
      // is where the NBFC took it.
      const base = i === 0 && bd.interest_after_adj && bd.open_adj_charge ? Math.max(0, round2(l.amount + n(bd.open_adj))) : l.amount
      const interest = round2((base * rate * days) / (100 * daysYear))
      const margin = round2(l.mpct == null ? shareMargin(l.amount) : (l.amount * l.mpct) / 100)
      return { ...l, maturity: due, interest_pct: rate, margin_pct: l.mpct, margin, days, base, interest, net: round2(deducted ? l.amount - interest : l.amount) }
    })
    const received = round2(legs.reduce((s, l) => s + l.amount, 0))
    const legInterest = round2(legs.reduce((s, l) => s + l.interest, 0))
    const legTds = round2((legInterest * n(bd.tds_pct)) / 100)
    // A leg with its own margin % moves the bill's margin; what is still to
    // come keeps the bill's share.
    const ownMargin = legs.some((l) => l.margin_pct != null)
    const legMargin = ownMargin
      ? round2(legs.reduce((s, l) => s + l.margin, 0) + shareMargin(Math.max(0, openAmount - received)))
      : marginAmount
    return {
      intDays: legs[0].days,
      marginAmount: legMargin,
      sanctionedAmount,
      undrawnAmount,
      openAmount,
      interestBase: round2(legs.reduce((s, l) => s + l.base, 0)),
      interestAmount: legInterest,
      tdsAmount: legTds,
      netInterest: round2(legInterest - legTds),
      receiptAmount: round2(legs.reduce((s, l) => s + l.net, 0) + adjCharge),
      adjCharge,
      received,
      toReceive: round2(Math.max(0, openAmount - received)),
      legs: legs.map(({ part_no, date, amount, days, interest, net, maturity, interest_pct, margin_pct, margin }) => ({
        part_no,
        date,
        amount,
        days,
        interest,
        net,
        maturity,
        interest_pct,
        margin_pct,
        margin
      }))
    }
  }
  const got = from ? openAmount : 0
  return {
    intDays,
    marginAmount,
    sanctionedAmount,
    undrawnAmount,
    openAmount,
    interestBase,
    interestAmount,
    tdsAmount,
    netInterest,
    receiptAmount,
    adjCharge,
    received: got,
    toReceive: round2(Math.max(0, openAmount - got)),
    legs: []
  }
}

/** What the NBFC has actually lent on a bill — all of it, unless it is still arriving in parts. */
function principalDrawn(bd: Row): number {
  return n(bd.first_receipt_part) > 0.005 ? bdCalc(bd).received : n(bd.amount)
}

/** A receipt leg's own reference — the bill's number and the leg: GB10/R2. */
function receiptRef(bd: Row, partNo: number): string {
  return `${String(bd.bd_no || `BD${n(bd.id)}`).trim()}/R${partNo}`
}

async function receiptParts(bdId: number): Promise<Row[]> {
  return toPlain(
    await getClient()
      .execute({ sql: 'SELECT * FROM bd_receipt_parts WHERE bd_id = ? ORDER BY part_no', args: [bdId] })
      .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
  )
}

// Remove one manual journal entry (with its bill-wise rows) — used to
// reverse/re-post a voucher we posted ourselves.
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
  await ensureBdPostingFields()
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
  const bd = toPlain(res)[0]
  bd.receipt_parts = await receiptParts(id)
  return bd
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
  const shared = await c.execute({
    sql: `SELECT 1 FROM bd_repayments mine JOIN bd_repayments other
      ON other.journal_entry_id=mine.journal_entry_id AND other.bd_id<>mine.bd_id
      WHERE mine.bd_id=? LIMIT 1`, args: [Number(bd.id)]
  })
  if (shared.rows.length) throw new Error('This bill shares a repayment with another bill — undo that combined repayment first')
  const parts = await c.execute({ sql: 'SELECT journal_entry_id, interest_entry_id, charges_entry_id FROM bd_repayments WHERE bd_id = ?', args: [Number(bd.id)] })
  for (const r of parts.rows) {
    await dropEntry(n(r.charges_entry_id) || null)
    await dropEntry(n(r.interest_entry_id) || null)
    await dropEntry(n(r.journal_entry_id) || null)
  }
  await ensureBdAdjust()
  await c.execute({ sql: 'DELETE FROM bd_interest_adjustments WHERE repayment_id IN (SELECT id FROM bd_repayments WHERE bd_id = ?)', args: [Number(bd.id)] })
  await c.execute({ sql: 'DELETE FROM bd_repayments WHERE bd_id = ?', args: [Number(bd.id)] })
  await dropEntry(n(bd.repay_journal_entry_id) || null)
}

function partyName(bd: Row): string {
  return String(bd.party_type === 'supplier' ? bd.supplier_name : bd.customer_name || '').trim()
}

// THE BANK A BILL'S MONEY MOVES THROUGH, when nobody has said otherwise.
//
// The one its disbursement landed in — named on the bill, or, for a bill
// entered before that was asked, the bank on its disbursement voucher. BANK
// A/C only when there is truly nothing else to go on. Repayments, interest and
// the margin coming back all default to it, and each can be changed.
async function bdBankFor(bd: Row, asked?: unknown): Promise<string> {
  const named = String(asked ?? '').trim()
  if (named) return named
  if (String(bd.disbursement_route || '') === 'bank' && String(bd.disbursement_account || '').trim()) {
    return String(bd.disbursement_account).trim()
  }
  if (n(bd.journal_entry_id)) {
    const r = await getClient().execute({
      sql: `SELECT a.name FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
            WHERE l.entry_id = ? AND a.acc_group IN ('Bank Accounts','Bank OD A/c','Cash-in-Hand')
            ORDER BY l.dr DESC LIMIT 1`,
      args: [n(bd.journal_entry_id)]
    })
    if (r.rows.length) return String(r.rows[0].name)
  }
  return 'BANK A/C'
}

const CASH_BANK_GROUPS = ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand']

/**
 * MOVE ONE OF A BILL'S VOUCHERS TO A DIFFERENT BANK.
 *
 * The bank a repayment, an interest payment or a disbursement went through is
 * a fact the statement settles, and it is often only known later — every bill
 * entered before the question was asked sits in BANK A/C. So it can be changed
 * at any time: the voucher's one bank line is re-pointed, nothing else. The
 * amounts, the date, the voucher number and every allocation stay as they
 * are, and the choice is recorded on the bill so a later re-post keeps it.
 */
export async function setBdVoucherBank(bdId: number, entryId: number, account: string): Promise<{ id: number; account: string }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const bd = await loadBd(bdId)
    const eid = n(entryId)
    const owned = new Set<number>(
      [bd.journal_entry_id, bd.margin_release_journal_entry_id, bd.upfront_interest_journal_entry_id, bd.repay_journal_entry_id].map(n).filter(Boolean)
    )
    for (const t of ['bd_repayments', 'bd_interest_payments', 'bd_payment_ins']) {
      const r = await c.execute({ sql: `SELECT journal_entry_id FROM ${t} WHERE bd_id = ?`, args: [n(bdId)] }).catch(() => null)
      for (const row of r?.rows || []) if (n(row.journal_entry_id)) owned.add(n(row.journal_entry_id))
    }
    if (!owned.has(eid)) throw new Error('That voucher is not one of this bill’s')
    const target = String(account || '').trim().toUpperCase()
    const acct = await c.execute({ sql: 'SELECT id, name, acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = ?', args: [target] })
    if (!acct.rows.length || !CASH_BANK_GROUPS.includes(String(acct.rows[0].acc_group))) {
      throw new Error('Pick a bank or cash ledger')
    }
    const banks = await c.execute({
      sql: `SELECT l.id FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
            WHERE l.entry_id = ? AND a.acc_group IN ('Bank Accounts','Bank OD A/c','Cash-in-Hand')`,
      args: [eid]
    })
    if (!banks.rows.length) throw new Error('This voucher does not go through a bank — it settles a party directly')
    if (banks.rows.length > 1) throw new Error('This voucher has more than one bank line — change it from Accounting')
    await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?', args: [n(acct.rows[0].id), n(banks.rows[0].id)] })
    const name = String(acct.rows[0].name)
    if (eid === n(bd.journal_entry_id)) {
      await c.execute({ sql: "UPDATE bill_discountings SET disbursement_route = 'bank', disbursement_account = ? WHERE id = ?", args: [name, n(bdId)] })
    }
    if (eid === n(bd.margin_release_journal_entry_id)) {
      await c.execute({ sql: 'UPDATE bill_discountings SET margin_release_account = ? WHERE id = ?', args: [name, n(bdId)] })
    }
    if (eid === n(bd.upfront_interest_journal_entry_id)) {
      await c.execute({ sql: 'UPDATE bill_discountings SET upfront_interest_account = ? WHERE id = ?', args: [name, n(bdId)] })
    }
    await c.execute({ sql: 'UPDATE bd_repayments SET bank_account = ? WHERE journal_entry_id = ?', args: [name, eid] }).catch(() => undefined)
    await c.execute({ sql: 'UPDATE bd_interest_payments SET bank_account = ? WHERE journal_entry_id = ?', args: [name, eid] }).catch(() => undefined)
    await c.execute({ sql: 'UPDATE bd_payment_ins SET account = ? WHERE journal_entry_id = ?', args: [name, eid] }).catch(() => undefined)
    return { id: eid, account: name }
  })
}

/**
 * WHERE THE NBFC'S MONEY WENT — CORRECTED, EVEN ON A REPAID BILL.
 *
 * A repaid bill is locked against editing, rightly: its terms decided every
 * repayment. But "Disbursement paid to" decides none of them — it only says
 * whether the opening voucher debits our bank or the supplier the NBFC paid
 * for us. Tyger T1 was saved as "Our bank" while Tally shows the NBFC paid
 * Pace Ventures direct, so HDFC carried ₹2.93 Cr that never arrived. This
 * changes the route alone and re-posts the opening voucher in place (same
 * id, same number); the repayments, interest and everything after stay.
 */
export async function setBdDisbursementRoute(
  bdId: number,
  routeIn: string,
  accountIn?: string,
  // Supplier direct to several suppliers: who got how much.
  sharesIn?: { party_id?: number | string; amount?: number | string }[]
): Promise<{ id: number; route: string }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const bd = await loadBd(bdId)
    const route = String(routeIn || '').trim()
    if (!['bank', 'supplier'].includes(route)) throw new Error('Choose Our bank or Supplier direct')
    let account: string | null = null
    if (route === 'supplier') {
      if (String(bd.finance_type) !== 'PID') throw new Error('Only a PID bill can be paid straight to the supplier')
      if (String(bd.party_type) !== 'supplier' || !partyName(bd)) throw new Error('This bill names no supplier for the NBFC to have paid')
      // WHO THE NBFC PAID, AND HOW MUCH EACH. Given, it replaces the bill's
      // suppliers; one supplier, or none given, keeps the bill as it is.
      const shares = (sharesIn || [])
        .map((x) => ({ id: n(x?.party_id), amount: round2(n(x?.amount)) }))
        .filter((x) => x.id || x.amount > 0)
      if (shares.length) {
        if (shares.some((x) => !x.id)) throw new Error('Pick the supplier for each share')
        if (shares.some((x) => !(x.amount > 0))) throw new Error('Enter how much went to each supplier')
        if (new Set(shares.map((x) => x.id)).size !== shares.length) throw new Error('The same supplier is named twice — one line each')
        if (shares.length > 1 && n(bd.first_party_part) > 0.005) throw new Error('This bill was paid to its supplier in parts — several suppliers cannot be paid that way')
        const paid = round2(bdCalc(bd).receiptAmount)
        const sum = round2(shares.reduce((t, x) => t + x.amount, 0))
        if (shares.length > 1 && Math.abs(sum - paid) > 0.01 && Math.abs(sum - n(bd.amount)) > 0.01) {
          throw new Error(`The shares come to ${inr(sum)} — they must add up to the ${inr(paid)} the NBFC paid out`)
        }
        for (const x of shares) {
          const s = await c.execute({ sql: 'SELECT 1 FROM suppliers WHERE id = ?', args: [x.id] })
          if (!s.rows.length) throw new Error('A supplier picked no longer exists')
        }
        await syncBdParties(n(bdId), 'supplier', shares.map((x) => x.id), shares.length > 1 ? Object.fromEntries(shares.map((x) => [String(x.id), x.amount])) : null)
        await c.execute({ sql: 'UPDATE bill_discountings SET party_id = ? WHERE id = ?', args: [shares[0].id, n(bdId)] })
      } else {
        const parties = await c.execute({ sql: 'SELECT COUNT(*) AS k, SUM(COALESCE(amount, 0) > 0) AS withShare FROM bd_parties WHERE bd_id = ?', args: [n(bdId)] }).catch(() => null)
        if (n(parties?.rows[0]?.k) > 1 && n(parties?.rows[0]?.withShare) < n(parties?.rows[0]?.k)) {
          throw new Error('This bill names more than one supplier — say how much went to each')
        }
      }
    } else {
      account = String(accountIn || '').trim()
      if (!account) throw new Error('Pick the bank the money landed in')
      const a = await c.execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = UPPER(TRIM(?))', args: [account] })
      if (!a.rows.length || !CASH_BANK_GROUPS.includes(String(a.rows[0].acc_group))) throw new Error('Pick a bank or cash ledger')
      // Paid to the supplier in parts: each later part is its own voucher to
      // the supplier, and a bank route cannot carry them.
      const parts = await c.execute({ sql: 'SELECT COUNT(*) AS k FROM bd_party_payments WHERE bd_id = ?', args: [n(bdId)] }).catch(() => null)
      if (n(parts?.rows[0]?.k) > 0 || n(bd.first_party_part) > 0.005) {
        throw new Error('This bill was paid to the supplier in parts — take the later parts back before moving it to a bank')
      }
    }
    await c.execute({
      sql: 'UPDATE bill_discountings SET disbursement_route = ?, disbursement_account = ? WHERE id = ?',
      args: [route, account, n(bdId)]
    })
    if (bd.payment_received_date) await postBdOpening(n(bdId))
    return { id: n(bdId), route }
  })
}

// Margin/interest/TDS voucher when a bill is opened (skipped if all three —
// and the amount itself — are zero). Mirrors LC's postLcOpening: the NBFC
// funds the discounted amount net of its own deductions; what we owe it back
// at maturity is the full face amount.
export async function postBdOpening(bdId: number): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(bdId)
  // This voucher IS the disbursement -- it debits the bank with what the NBFC
  // paid out. Until the payment is actually received there is no money to
  // debit and no liability to raise, so a bill still awaiting its payment
  // carries no voucher at all. It gets one the moment the receipt is marked.
  if (!bd.payment_received_date) {
    await dropEntry(n(bd.journal_entry_id) || null)
    await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?', args: [bdId] })
    return
  }
  const calc = bdCalc(bd)
  const route = String(bd.disbursement_route || 'unconfirmed')
  if (route === 'supplier' && bd.finance_type !== 'PID') throw new Error('Direct supplier funding is only available for PID')
  // An unconfirmed (pre-existing) bill posts the way it always did: a Receipt
  // into the bank its voucher already names — BANK A/C for all of them so far.
  const legacyBank = async (): Promise<string> => {
    if (!n(bd.journal_entry_id)) return 'BANK A/C'
    const r = await c.execute({
      sql: `SELECT a.name FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
            WHERE l.entry_id = ? AND l.dr > 0 AND a.acc_group IN ('Bank Accounts','Cash-in-Hand','Bank OD A/c')
            ORDER BY l.dr DESC LIMIT 1`,
      args: [n(bd.journal_entry_id)]
    })
    return r.rows.length ? String(r.rows[0].name) : 'BANK A/C'
  }
  const destination =
    route === 'supplier' ? partyName(bd) : route === 'bank' ? String(bd.disbursement_account || '').trim() : await legacyBank()
  if (!destination) throw new Error(route === 'supplier' ? 'Choose the funded supplier' : 'Choose the bank that received the disbursement')
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
  const serviced = String(bd.interest_mode || '') === 'serviced'
  const interest = upfront || serviced ? 0 : calc.interestAmount
  const amount = n(bd.amount)
  if (calc.marginAmount < 0.005 && interest < 0.005 && amount < 0.005 && Math.abs(calc.adjCharge) < 0.005) {
    await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?', args: [bdId] })
    return
  }
  // The margin is a DEPOSIT only to the extent it was withheld from what we
  // drew. On the old basis it was — the drawn amount was the face value less the
  // margin, so bank + margin + interest came to exactly what we owed.
  //
  // Struck on the INVOICE instead, it is the NBFC's retention against a bill it
  // will collect from the customer; nothing of ours is held back out of the
  // draw, so recognising it as our asset here would put the voucher out by the
  // whole margin. The drawn amount is what we owe and what we received, and the
  // retention is reported on the register rather than posted.
  const marginWithheld = n(bd.invoice_amount) > 0 ? 0 : calc.marginAmount
  // PAID IN PARTS (supplier direct): only the first part reaches the supplier
  // on this voucher, and only that much of the NBFC's money is owed yet — the
  // rest follows, part by part, in payBdParty. The interest, margin and
  // charges stay here, taken once.
  const firstPart = route === 'supplier' && n(bd.first_party_part) > 0.005 ? Math.min(round2(n(bd.first_party_part)), calc.receiptAmount) : 0
  const toParty = firstPart > 0 ? firstPart : calc.receiptAmount
  const notYet = round2(calc.receiptAmount - toParty)
  // RECEIVED IN PARTS (SID): this voucher is the FIRST leg — its money, its
  // own interest to maturity, and the Adj. once. Each later leg posts its own
  // voucher in receiveBdPart.
  // On either route now: a PID paid straight to the supplier in legs is the
  // same shape, its money going to the supplier instead of our bank.
  const leg1 = calc.legs.length && !(route === 'supplier' && firstPart > 0) ? calc.legs[0] : null
  const interestHere = leg1 ? (upfront || serviced ? 0 : leg1.interest) : interest
  const bankHere = leg1 ? round2((upfront || serviced ? leg1.amount : leg1.net) + calc.adjCharge) : toParty
  const payableHere = leg1 ? leg1.amount : round2(amount - notYet)
  // Paid straight to SEVERAL suppliers: one debit each, by their shares of
  // what the NBFC paid out (scaled to it, the last taking any paisa left).
  const shares = route === 'supplier' && !firstPart && !leg1 ? await supplierShares(bdId) : []
  const lines: JournalLine[] =
    shares.length > 1
      ? splitByShares(bankHere, shares).map((x) => ({ account: x.name, group: 'Sundry Creditors', dr: x.amount }))
      : [{ account: destination, group: route === 'supplier' ? 'Sundry Creditors' : 'Bank Accounts', dr: bankHere }]
  if (marginWithheld > 0.005) lines.push({ account: 'BD MARGIN A/C', group: 'Deposits (Asset)', dr: marginWithheld })
  if (interestHere > 0.005) lines.push({ account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: interestHere })
  // The Adj. as a charge: what the NBFC took out of the payout (or added to
  // it), on its own expense line — the drawn amount stays the whole Open.
  // Posted to the ledger of the charge type picked beside the Adj. figure —
  // BD charges unless another was chosen (see BD_ADJ_PRESETS).
  // An Adj. split across several kinds posts each part to its own ledger.
  const adjLedger = String(bd.open_adj_ledger || '').trim().toUpperCase() || BD_ADJ_DEFAULT
  const adjParts = bdAdjParts(bd)
  // Each part on its own side: a charge (minus) is debited, money the NBFC
  // sent over (plus) credited — so ₹6,363.83 of BD charges and ₹100 excess
  // received post as Dr 6,363.83 and Cr 100, and the bank takes the net.
  for (const p of adjParts.length ? adjParts : [{ ledger: adjLedger, amount: round2(calc.adjCharge) }]) {
    if (Math.abs(p.amount) < 0.005) continue
    if (p.amount < 0) lines.push({ account: p.ledger, group: 'Indirect Expenses', dr: round2(-p.amount) })
    else lines.push({ account: p.ledger, group: adjParts.length ? 'Indirect Incomes' : 'Indirect Expenses', cr: round2(p.amount) })
  }
  lines.push({ account: bdPayable(bd), group: BD_PAYABLE_GROUP, cr: payableHere })
  const write = n(bd.journal_entry_id) ? (args: Parameters<typeof postJournal>[0]) => repostJournal(n(bd.journal_entry_id), args) : postJournal
  const je = await write({
    date: String(bd.payment_received_date || todayISO()).slice(0, 10),
    vchType: route === 'supplier' ? 'JOURNAL' : 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no || ''} (${bd.finance_type}) opened with ${bd.nbfc_name || 'the NBFC'} — ` +
      (leg1 ? `received in parts, ${receiptRef(bd, 1)}: ${leg1.amount.toFixed(2)} of ${amount.toFixed(2)}, ` : '') +
      `margin ${calc.marginAmount.toFixed(2)}, interest ${interestHere.toFixed(2)}` +
      (Math.abs(calc.adjCharge) > 0.004
        ? `, adj. ${calc.adjCharge.toFixed(2)} (${adjParts.length ? adjParts.map((p) => `${bdAdjLabel(p.ledger)} ${p.amount > 0 ? '+' : ''}${p.amount.toFixed(2)}`).join(', ') : bdAdjLabel(adjLedger)})`
        : '') +
      (serviced
        ? ` (interest serviced ${String(bd.interest_freq || 'monthly').replace('_', '-')} over the tenor)`
        : upfront
          ? ' (interest settled separately on reconciliation)'
          : '') +
      (String(bd.received_note || '').trim() ? ` — ${String(bd.received_note).trim()}` : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = ? WHERE id = ?', args: [je.id, bdId] })
  if (route === 'supplier') {
    if (shares.length > 1) for (const x of splitByShares(bankHere, shares)) await allocAgainst(je.id, x.name, null, x.amount)
    else await allocAgainst(je.id, destination, null, leg1 ? bankHere : toParty)
  }
  })
}

/** The suppliers on a bill with their shares, when there are several with shares to split by. */
async function supplierShares(bdId: number): Promise<{ name: string; share: number }[]> {
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT s.name, COALESCE(bp.amount, 0) AS amount FROM bd_parties bp JOIN suppliers s ON s.id = bp.party_id
             WHERE bp.bd_id = ? AND bp.party_type = 'supplier' ORDER BY bp.id`,
      args: [n(bdId)]
    })
  )
  if (rows.length < 2 || rows.some((r) => !(n(r.amount) > 0))) return []
  return rows.map((r) => ({ name: String(r.name), share: round2(n(r.amount)) }))
}

/**
 * What an awaiting supplier-direct bill will debit its supplier(s) with once the
 * NBFC's money is marked received — postBdOpening's own figures (a bill paid in
 * parts counts every part). For the ledger's Provisional view; posts nothing.
 */
export async function bdPendingPayout(bdId: number): Promise<{ bd: Row; parts: { name: string; amount: number }[] }> {
  const bd = await loadBd(bdId)
  const calc = bdCalc(bd)
  const upfront = !!bd.interest_upfront
  const serviced = String(bd.interest_mode || '') === 'serviced'
  const inParts = n(bd.first_party_part) > 0.005
  const leg1 = calc.legs.length && !inParts ? calc.legs[0] : null
  const pay = leg1 ? round2((upfront || serviced ? leg1.amount : leg1.net) + calc.adjCharge) : round2(calc.receiptAmount)
  const shares = !inParts && !leg1 ? await supplierShares(bdId) : []
  return { bd, parts: shares.length > 1 ? splitByShares(pay, shares) : [{ name: partyName(bd), amount: pay }] }
}

/** A total split by shares — each its proportion, the last taking what rounding leaves. */
function splitByShares(total: number, shares: { name: string; share: number }[]): { name: string; amount: number }[] {
  const whole = shares.reduce((t, x) => t + x.share, 0)
  let left = round2(total)
  return shares.map((x, i) => {
    const amt = i === shares.length - 1 ? left : round2((total * x.share) / whole)
    left = round2(left - amt)
    return { name: x.name, amount: amt }
  })
}

// Posts the deferred interest + TDS voucher once reconciled from the bank
// statement, for a bill that was opened with interest_upfront — mirrors LC's
// postLcUpfrontInterest. Only reachable for an upfront bill, whose opening
// voucher deliberately left the interest out, so this cannot double-count.
export async function postBdUpfrontInterest(bdId: number, dateIn?: string, account?: string): Promise<{ id: number } | null> {
  return withDbTransaction(async () => {
  const bd = await loadBd(bdId)
  if (n(bd.upfront_interest_journal_entry_id)) return { id: n(bd.upfront_interest_journal_entry_id) }
  if (!bd.interest_upfront) throw new Error('This Bill Discounting entry was not opened with interest upfront')
  if (!bd.payment_received_date) throw new Error('Record the funded date before paying upfront interest')
  const date = String(dateIn || '').slice(0, 10)
  if (!date) throw new Error('Enter the actual interest payment date')
  assertNotFuture(date, 'Interest payment date')
  const bank = String(account || '').trim()
  if (!bank) throw new Error('Choose the bank that paid the interest')
  const calc = bdCalc(bd)
  if (calc.interestAmount < 0.005) return null
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} — interest ${calc.interestAmount.toFixed(2)} (TDS ${calc.tdsAmount.toFixed(2)}) settled upfront, per the bank statement`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: calc.interestAmount },
      { account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: calc.tdsAmount },
      { account: bank, group: 'Bank Accounts', cr: calc.netInterest }
    ]
  })
  await getClient().execute({
    sql: 'UPDATE bill_discountings SET upfront_interest_journal_entry_id=?, upfront_interest_paid_date=?, upfront_interest_account=? WHERE id=?',
    args: [je.id, date, bank, bdId]
  })
  return { id: je.id }
  })
}

export async function reverseBdUpfrontInterest(bdId: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const bd = await loadBd(bdId)
  await dropEntry(n(bd.upfront_interest_journal_entry_id) || null)
  await getClient().execute({sql: 'UPDATE bill_discountings SET upfront_interest_journal_entry_id=NULL, upfront_interest_paid_date=NULL, upfront_interest_account=NULL WHERE id=?', args: [bdId]})
  return { id: bdId }
  })
}

// The margin/security deposit released back as cash once the bill is
// repaid and the NBFC no longer needs it held — mirrors postLcMarginRelease.
async function postBdMarginRelease(bd: Row, bankIn?: unknown): Promise<{ id: number } | null> {
  const calc = bdCalc(bd)
  const bank = await bdBankFor(bd, bankIn || bd.margin_release_account)
  // Only a margin that was actually recognised as our deposit can come back —
  // see postBdOpening. A retention struck on the invoice was never posted, so
  // there is nothing to release.
  if (n(bd.invoice_amount) > 0) return null
  if (calc.marginAmount < 0.005) return null
  const je = await postJournal({
    date: String(bd.repaid_date || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} repaid — margin of ${calc.marginAmount.toFixed(2)} refunded by ${bd.nbfc_name || 'the NBFC'}`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: bank, group: 'Bank Accounts', dr: calc.marginAmount },
      { account: 'BD MARGIN A/C', group: 'Deposits (Asset)', cr: calc.marginAmount }
    ]
  })
  await getClient().execute({
    sql: 'UPDATE bill_discountings SET margin_release_journal_entry_id = ?, margin_release_account = ? WHERE id = ?',
    args: [je.id, bank, n(bd.id)]
  })
  return { id: je.id }
}

const BD_COLS = [
  'disbursement_route',
  'disbursement_account',
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
  // + or − on the invoice value (see bdCalc). Added lazily; 0 on every bill
  // recorded before it existed, which is why none of their figures move.
  // No longer entered — the adjustment moved to the open amount (open_adj) —
  // but still honoured on the few bills that carry one.
  'invoice_adj',
  // + or − on the OPEN amount. Two readings, told apart by open_adj_charge:
  //   1 (every bill saved from 2026-09-30) — a charge on the payout: `amount`
  //     is the Open amount itself, interest runs on it, and the Adj. only
  //     moves what reaches the bank (posted to BD CHARGES A/C). See bdCalc.
  //   0 (older) — `amount` stored Open ± Adj, the drawn amount everything was
  //     priced on; kept so the form can show the two separately.
  'open_adj',
  'open_adj_charge',
  // WHAT KIND OF CHARGE the Adj. is — its ledger. Blank on every bill saved
  // before the choice existed, which reads as BD CHARGES A/C, so none moves.
  'open_adj_ledger',
  // THE ADJ. SPLIT ACROSS KINDS, when it is more than one: JSON
  // [{ledger, amount}], amounts the size of each part (the sign is the Adj.'s)
  // adding up to the whole. Null for one kind — open_adj_ledger says which.
  'open_adj_split',
  // 1 = the NBFC charges interest on the Open amount AFTER the Adj. (see
  // bdCalc's interestBase). 0 on every bill before the switch existed.
  'interest_after_adj',
  'payment_received_date',
  'maturity_date',
  'margin_pct',
  'days_year',
  'days_incl_start',
  'interest_pct',
  'tds_pct',
  'interest_upfront',
  // How the interest is charged: 'discounted' (netted out of the
  // disbursement), 'upfront' (settled separately at the start) or 'serviced'
  // (paid as it runs, on the rest below). interest_upfront is kept in step
  // with it so every older reader still behaves.
  'interest_mode',
  'interest_freq',
  // HOW LONG BEFORE THE MONEY COMES BACK. Optional, and a number of days
  // rather than a date: the terms are agreed in days, and a date typed by hand
  // drifts from whatever the bill was actually discounted on. See lc.ts.
  'payment_in_expected',
  'payment_in_days',
  'note'
]

// THE KINDS OF CHARGE AN ADJ. CAN BE. The Adj. is what the NBFC takes off
// (or adds to) its payout; WHAT it is decides the ledger it posts to. A short
// list of the usual ones, always offered, plus any the desk adds — kept in
// app_settings so every user and every bill sees the same list.
export const BD_ADJ_DEFAULT = 'BD CHARGES A/C'
const BD_ADJ_PRESETS: { label: string; ledger: string }[] = [
  { label: 'BD charges', ledger: BD_ADJ_DEFAULT },
  { label: 'Processing fees', ledger: 'PROCESSING FEES A/C' },
  { label: 'Documentation charges', ledger: 'DOCUMENTATION CHARGES A/C' },
  { label: 'Stamp duty', ledger: 'STAMP DUTY A/C' },
  { label: 'Bank charges', ledger: 'BANK CHARGES A/C' },
  { label: 'Commission', ledger: 'COMM. CHARGES A/C' },
  { label: 'Insurance charges', ledger: 'INSURANCE CHARGES A/C' }
]
const BD_ADJ_KEY = 'bd_adj_charge_types'

async function customChargeTypes(): Promise<{ label: string; ledger: string }[]> {
  try {
    const raw = await getSetting(BD_ADJ_KEY)
    const list = raw ? (JSON.parse(raw) as { label?: unknown; ledger?: unknown }[]) : []
    return Array.isArray(list)
      ? list.map((x) => ({ label: String(x?.label || '').trim(), ledger: String(x?.ledger || '').trim().toUpperCase() })).filter((x) => x.label && x.ledger)
      : []
  } catch {
    return []
  }
}

/** Every charge type an Adj. can be: the usual ones first, then the desk's own. */
export async function listBdChargeTypes(): Promise<{ label: string; ledger: string; preset: boolean }[]> {
  const custom = await customChargeTypes()
  const seen = new Set(BD_ADJ_PRESETS.map((p) => p.ledger))
  return [
    ...BD_ADJ_PRESETS.map((p) => ({ ...p, preset: true })),
    ...custom.filter((c) => !seen.has(c.ledger)).map((c) => ({ ...c, preset: false }))
  ]
}

/** Add a charge type. Its ledger is the name in capitals with A/C, created on first posting. */
export async function addBdChargeType(labelIn: string): Promise<{ label: string; ledger: string; preset: boolean }> {
  const label = String(labelIn || '').replace(/\s+/g, ' ').trim()
  if (label.length < 2) throw new Error('Give the charge a name')
  if (label.length > 40) throw new Error('Keep the name under 40 characters')
  if (!/^[A-Za-z0-9 .&()/-]+$/.test(label)) throw new Error('Use letters, numbers and . & ( ) / - only')
  const up = label.toUpperCase()
  const ledger = /\bA\/C$/.test(up) ? up : `${up} A/C`
  const all = await listBdChargeTypes()
  const hit = all.find((x) => x.ledger === ledger || x.label.toUpperCase() === up)
  if (hit) return hit
  const custom = await customChargeTypes()
  custom.push({ label, ledger })
  await setSetting(BD_ADJ_KEY, JSON.stringify(custom))
  return { label, ledger, preset: false }
}

/**
 * The parts of a split Adj. — [] when it is one kind (or none).
 *
 * SIGNED, AS THE ADJ. ITSELF IS: minus is what the NBFC took off the payout
 * (a charge), plus what it sent over (the bank paid ₹100 more — income). A
 * split saved before parts carried a sign stored them all unsigned, as shares
 * of the one Adj.; those read with the Adj.'s own sign, exactly as they did.
 */
export function bdAdjParts(bd: Row): { ledger: string; amount: number }[] {
  let raw: unknown = bd?.open_adj_split
  if (typeof raw === 'string') {
    try {
      raw = raw.trim() ? JSON.parse(raw) : []
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  const list = (raw as Row[]).map((p) => ({ ledger: String(p?.ledger || '').trim().toUpperCase(), amount: round2(Number(p?.amount) || 0) }))
  // Unsigned (the old way): every part takes the Adj.'s sign.
  const adj = round2(Number(bd?.open_adj) || 0)
  const legacy = adj < 0 && !list.some((p) => p.amount < 0)
  const seen = new Map<string, number>()
  for (const p of list) {
    const amount = legacy ? -Math.abs(p.amount) : p.amount
    if (!p.ledger || Math.abs(amount) < 0.005) continue
    seen.set(p.ledger, round2((seen.get(p.ledger) || 0) + amount))
  }
  return Array.from(seen, ([ledger, amount]) => ({ ledger, amount })).filter((p) => Math.abs(p.amount) >= 0.005)
}

function bdAdjLabel(ledger: string): string {
  const p = BD_ADJ_PRESETS.find((x) => x.ledger === ledger)
  return p ? p.label : ledger.replace(/\s*A\/C$/, '').toLowerCase()
}

let invoiceAdjReady = false
async function ensureInvoiceAdj(): Promise<void> {
  if (invoiceAdjReady) return
  for (const sql of [
    'ALTER TABLE bill_discountings ADD COLUMN invoice_adj REAL NOT NULL DEFAULT 0',
    'ALTER TABLE bill_discountings ADD COLUMN open_adj REAL NOT NULL DEFAULT 0',
    'ALTER TABLE bill_discountings ADD COLUMN open_adj_charge INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE bill_discountings ADD COLUMN open_adj_ledger TEXT',
    'ALTER TABLE bill_discountings ADD COLUMN open_adj_split TEXT',
    'ALTER TABLE bill_discountings ADD COLUMN interest_after_adj INTEGER NOT NULL DEFAULT 0'
  ]) {
    try {
      await getClient().execute(sql)
    } catch (e) {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e
    }
  }
  invoiceAdjReady = true
}

function bdArgs(v: Row): (string | number | null)[] {
  const mode = ['discounted', 'upfront', 'serviced'].includes(String(v.interest_mode || ''))
    ? String(v.interest_mode)
    : v.interest_upfront
      ? 'upfront'
      : 'discounted'
  return BD_COLS.map((k) => {
    // The old flag IS the new mode's upfront value — one of them was going to
    // drift otherwise, and it is the flag every existing query still reads.
    if (k === 'interest_upfront') return mode === 'upfront' ? 1 : 0
    if (k === 'interest_mode') return mode
    if (k === 'interest_freq') {
      return mode === 'serviced'
        ? ['fortnightly', 'monthly', 'quarterly', 'half_yearly', 'maturity'].includes(String(v.interest_freq || ''))
          ? String(v.interest_freq)
          : 'monthly'
        : null
    }
    if (k === 'days_incl_start') return v[k] ? 1 : 0
    if (k === 'days_year') return n(v[k]) || 360
    if (['amount', 'margin_pct', 'interest_pct', 'tds_pct'].includes(k)) return n(v[k])
    if (k === 'invoice_adj' || k === 'open_adj') return round2(n(v[k]))
    if (k === 'open_adj_charge') return v[k] ? 1 : 0
    if (k === 'interest_after_adj') return v[k] ? 1 : 0
    if (k === 'open_adj_ledger') {
      const parts = bdAdjParts(v)
      const led = (parts[0]?.ledger || String(v[k] ?? '')).trim().toUpperCase()
      return led && led !== BD_ADJ_DEFAULT ? led : null
    }
    if (k === 'open_adj_split') {
      const parts = bdAdjParts(v)
      if (parts.length < 2) return null
      const whole = round2(n(v.open_adj))
      const sum = round2(parts.reduce((t, p) => t + p.amount, 0))
      if (Math.abs(sum - whole) > 0.01) {
        throw new Error(`The kinds of charge come to ${sum.toFixed(2)} but the Adj. is ${whole.toFixed(2)} — make the parts match the Adj.`)
      }
      return JSON.stringify(parts)
    }
    // Optional, and left empty by anyone who does not track it — so blank has
    // to stay blank rather than reading as a zero-value invoice.
    if (k === 'invoice_amount') {
      const val = v[k]
      return val === '' || val === undefined || val === null ? null : n(val)
    }
    if (k === 'nbfc_id' || k === 'receivable_party_id') return v[k] ? n(v[k]) : null
    // Blank means "not agreed", which is not the same as nought days.
    if (k === 'payment_in_expected') return v[k] ? 1 : 0
    if (k === 'payment_in_days') {
      const val = v[k]
      return val === '' || val === undefined || val === null ? null : n(val)
    }
    const val = v[k]
    return val === '' || val === undefined || val === null ? null : String(val)
  })
}

// The bill's own party_id is the PRIMARY party, and everything that reads the
// column expects it to be the first of the list. Normalised here so the row and
// the link table can never say different things.
function withPrimaryParty(v: Row): Row {
  if (!Array.isArray(v.party_ids)) return v
  const ids = (v.party_ids as unknown[]).map((x) => n(x)).filter((x) => x > 0)
  return ids.length ? { ...v, party_id: ids[0] } : v
}

// Replace the parties on one bill. The FIRST is the primary and is written onto
// the bill itself, so everything that reads `party_id` keeps working; all of
// them, primary included, land in the link table.
async function syncBdParties(
  bdId: number,
  partyType: string,
  partyIds: unknown,
  // How much of the open amount each party accounts for, keyed by party id.
  // Absent means "not divided", and a single-party bill never needs it.
  split?: Record<string, unknown> | null
): Promise<number | null> {
  const c = getClient()
  const ids = Array.isArray(partyIds) ? Array.from(new Set(partyIds.map((x) => n(x)).filter((x) => x > 0))) : []
  await c.execute({ sql: 'DELETE FROM bd_parties WHERE bd_id = ?', args: [bdId] })
  for (const pid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id, amount) VALUES (?, ?, ?, ?)',
      args: [bdId, partyType, pid, split ? n(split[String(pid)]) : 0]
    })
  }
  return ids.length ? ids[0] : null
}

// The parties on one bill, for the form and for choosing whose ledger a
// repayment settles against.
export async function listBdParties(bdId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT bp.party_id, bp.party_type, COALESCE(bp.amount, 0) AS amount,
                 COALESCE(s.name, cu.name) AS name
          FROM bd_parties bp
          LEFT JOIN suppliers s ON bp.party_type = 'supplier' AND s.id = bp.party_id
          LEFT JOIN customers cu ON bp.party_type = 'customer' AND cu.id = bp.party_id
          WHERE bp.bd_id = ? ORDER BY bp.id`,
    args: [bdId]
  })
  return toPlain(res)
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

// The sales invoices a SID bill was drawn against. There is no link table for
// them — the form keeps them in the note ("KRFL/555, KRFL/560") — so they are
// read off the note and matched to the Sales register of the bill's company.
export async function listBdSalesInvoices(bdId: number): Promise<Row[]> {
  const c = getClient()
  const bd = (await c.execute({ sql: 'SELECT company_id, note FROM bill_discountings WHERE id = ?', args: [bdId] })).rows[0] as unknown as Row | undefined
  const nos = [...new Set(String(bd?.note || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))]
  if (!bd || !nos.length) return []
  const res = await c.execute({
    sql: `SELECT s.invoice_no, MIN(s.sale_date) AS sale_date, s.customer_id, MAX(cu.name) AS customer_name,
                 ROUND(SUM(s.amount), 2) AS taxable,
                 ROUND(SUM(s.amount + COALESCE(s.gst_amount, 0)) + MAX(COALESCE(s.round_off, 0)), 2) AS total
            FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
           WHERE s.company_id = ? AND s.rejected_at IS NULL AND s.invoice_no IN (${nos.map(() => '?').join(',')})
           GROUP BY s.invoice_no, s.customer_id ORDER BY MIN(s.sale_date), s.invoice_no`,
    args: [n(bd.company_id), ...nos]
  })
  return toPlain(res)
}

// Every check a Bill Discounting entry has to pass, on create or edit.
//
// WHO THE NBFC PAID. A new bill must say: into our own bank (a Receipt) or
// straight to the supplier (a Journal that discharges the supplier). A bill
// entered before the question existed is 'unconfirmed' and keeps posting
// exactly as it always has until someone confirms it — its books are not
// rewritten on a guess, and it is not locked against edits either.
async function validateBd(v: Row, cur?: Row): Promise<void> {
  await ensureBdPostingFields()
  const route = String(v.disbursement_route || '')
  const legacy = !!cur && String(cur.disbursement_route || 'unconfirmed') === 'unconfirmed' && route === 'unconfirmed'
  if (!legacy && !['bank', 'supplier'].includes(route)) throw new Error('Choose who receives the NBFC disbursement')
  if (v.disbursement_route === 'supplier' && v.finance_type !== 'PID') throw new Error('Only PID can be funded directly to a supplier')
  // SEVERAL SUPPLIERS PAID DIRECT — each with its share, so the opening
  // voucher can debit each what the NBFC paid them (I2: Shri Govind 39,49,153
  // + Bunge 60,50,847). Without the shares there is no way to split it.
  if (v.disbursement_route === 'supplier' && Array.isArray(v.party_ids) && v.party_ids.length > 1) {
    const amts = (v.party_amounts as Record<string, unknown> | null) || {}
    if ((v.party_ids as unknown[]).some((pid) => !(n(amts[String(n(pid))]) > 0))) {
      throw new Error('Paid straight to several suppliers — enter how much went to each')
    }
  }
  if (v.disbursement_route === 'bank' && !String(v.disbursement_account || '').trim()) throw new Error('Choose the receiving bank account')
  // Every voucher a bill posts is numbered with this — the disbursement, each
  // repayment, the margin release — so a bill without one puts unnumbered
  // vouchers in the ledger and cannot be found by reference afterwards.
  if (!String(v.bd_no ?? '').trim()) throw new Error('Enter the BD no')
  if (!['PID', 'SID'].includes(String(v.finance_type))) throw new Error('Choose PID or SID')
  const partyType = String(v.finance_type) === 'PID' ? 'supplier' : 'customer'
  if (String(v.party_type) !== partyType) throw new Error('Party type must follow the finance type')
  // One or several. The list is the source of truth when it is given; a caller
  // that sends only the single id (an older path, or the API) still works.
  const partyIds: number[] = Array.isArray(v.party_ids)
    ? Array.from(new Set((v.party_ids as unknown[]).map((x) => n(x)).filter((x) => x > 0)))
    : n(v.party_id)
      ? [n(v.party_id)]
      : []
  if (!partyIds.length) throw new Error(partyType === 'supplier' ? 'Choose the supplier' : 'Choose the customer')
  if (n(v.amount) <= 0) throw new Error('Enter the open amount')
  if (!v.maturity_date) throw new Error('Enter the maturity date')
  // The payment received date is not asked for when the bill is opened -- it is
  // stamped later, when the NBFC's money actually lands -- so it is only
  // checked against the maturity when there IS one.
  if (v.payment_received_date && String(v.maturity_date).slice(0, 10) < String(v.payment_received_date).slice(0, 10)) {
    throw new Error('Maturity date cannot be before the payment received date')
  }
  const table = partyType === 'supplier' ? 'suppliers' : 'customers'
  // Every one of them has to exist and be active, not just the first.
  const found = await getClient().execute({
    sql: `SELECT id, name, active FROM ${table} WHERE id IN (${partyIds.map(() => '?').join(',')})`,
    args: partyIds
  })
  if (found.rows.length !== partyIds.length) throw new Error('One of the parties no longer exists')
  const inactive = found.rows.find((r) => !n(r.active))
  if (inactive) throw new Error(`${String(inactive.name)} is marked inactive`)

  // With more than one party the SANCTIONED amount has to be divided between
  // them, and the parts have to come to the whole — a split that does not add
  // up is worse than none, because each party's share would be quietly wrong.
  //
  // Sanctioned rather than open: what each party is on the bill for is its
  // portion of the facility the NBFC granted against its invoices, which is
  // fixed the day the bill is raised. The open amount is only what happens to
  // be drawn against that facility right now — draw less today and every
  // party's recorded share would have to be rewritten, which is plainly not
  // what a share of a bill means.
  if (partyIds.length > 1) {
    const split = (v.party_amounts || {}) as Record<string, unknown>
    const given = partyIds.map((pid) => round2(n(split[String(pid)])))
    if (given.some((x) => x <= 0)) {
      throw new Error('Give each party its invoice amount')
    }
    const sum = round2(given.reduce((t, x) => t + x, 0))
    // EACH PARTY'S INVOICE, adding up to the bill's invoice amount — what the
    // desk has in hand is the invoices. A bill split before this, on the
    // sanctioned figure, still saves as it was.
    const invoice = round2(n(v.invoice_amount))
    const sanctioned = round2(bdCalc(v).sanctionedAmount)
    const total = invoice > 0 ? invoice : sanctioned
    // Or, on a bill the NBFC paid straight to its suppliers, what each was
    // PAID — adding up to the open amount (I2: 39,49,153 + 60,50,847), the
    // figures Tally carries and the opening voucher debits.
    const paidOut = round2(n(v.amount))
    const paidSplit = String(v.disbursement_route || '') === 'supplier' && Math.abs(sum - paidOut) <= 0.05
    if (!paidSplit && Math.abs(sum - total) > 0.05 && Math.abs(sum - sanctioned) > 0.05) {
      throw new Error(
        `The parties' amounts come to ${inr(sum)} — they must add up to the bill's invoice amount (${inr(total)})${String(v.disbursement_route || '') === 'supplier' ? ` or to the ${inr(paidOut)} the NBFC paid out` : ''}`
      )
    }
  }
}

/**
 * INTEREST TAKEN UPFRONT, BILL REPAID EARLY. The NBFC kept interest to maturity
 * when it funded the bill; each part repaid before maturity stops costing from
 * the repayment day, so the interest on those days is owed back in full (no
 * TDS comes off it). Worked out live from the repayments, nothing stored.
 * Not for a serviced bill (its interest is paid as it runs) or one received in
 * legs (each leg has its own term).
 */
function earlyRefund(bd: Row, calc: { interestAmount: number }, reps: Row[], received = 0, closed: Row | null = null): Row | null {
  const mode = String(bd.interest_mode || '') || (bd.interest_upfront ? 'upfront' : 'discounted')
  const maturity = String(bd.maturity_date || '').slice(0, 10)
  if (mode === 'serviced' || !maturity || !(calc.interestAmount > 0.004) || n(bd.first_receipt_part) > 0.005) return null
  const daysYear = n(bd.days_year) || 360
  const rate = n(bd.interest_pct)
  const lines = reps
    .map((r) => ({ date: String(r.repay_date || '').slice(0, 10), amount: n(r.amount) }))
    .filter((r) => r.date && r.date < maturity && r.amount > 0.004)
    .map((r) => {
      const days = daysBetween(r.date, maturity)
      return { ...r, days, gross: round2((r.amount * rate * days) / (100 * daysYear)) }
    })
    .filter((l) => l.gross > 0.004)
  const gross = round2(Math.min(calc.interestAmount, lines.reduce((t, l) => t + l.gross, 0)))
  if (!(gross > 0.5)) return null
  // What has come back already (linked bank receipts), and what is still due.
  // Closed fully: the NBFC paid what it paid and the rest is let go — nothing more is due.
  const short = round2(Math.max(0, gross - received))
  return {
    gross,
    net: gross,
    received: round2(received),
    due: closed ? 0 : short,
    closed: !!closed,
    written_off: closed ? short : 0,
    closed_note: closed ? String(closed.note || '') : '',
    closed_at: closed ? String(closed.closed_at || '').slice(0, 10) : '',
    maturity,
    rate,
    days_year: daysYear,
    interest: calc.interestAmount,
    lines
  }
}

export async function listBd(filter?: Row): Promise<Row[]> {
  await ensureBdPostingFields()
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
                 -- A bill can be raised against several parties; the register
                 -- names them all rather than only the one on the row.
                 (SELECT COUNT(*) FROM bd_parties bp WHERE bp.bd_id = bd.id) AS party_count,
                 (SELECT GROUP_CONCAT(COALESCE(s2.name, cu2.name), ', ') FROM bd_parties bp
                    LEFT JOIN suppliers s2 ON bp.party_type = 'supplier' AND s2.id = bp.party_id
                    LEFT JOIN customers cu2 ON bp.party_type = 'customer' AND cu2.id = bp.party_id
                    WHERE bp.bd_id = bd.id) AS party_names,
                 (SELECT GROUP_CONCAT(bp.party_id) FROM bd_parties bp WHERE bp.bd_id = bd.id) AS party_ids_csv,
                 (SELECT GROUP_CONCAT(bp.party_id || ':' || COALESCE(bp.amount, 0)) FROM bd_parties bp
                    WHERE bp.bd_id = bd.id) AS party_split_csv,
                 -- The purchase invoices this bill funded: the route to the
                 -- trading deal, and through it to the resale invoices.
                 (SELECT COUNT(*) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_invoice_count,
                 (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM bd_linked_orders bo
                    JOIN orders o ON o.id = bo.order_id WHERE bo.bd_id = bd.id) AS linked_invoice_nos,
                 (SELECT GROUP_CONCAT(bo.order_id) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_order_ids_csv,
                 -- What the customer has already paid back on the resale.
                 COALESCE((SELECT SUM(pi.amount) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id), 0) AS payment_in_total,
                 (SELECT COUNT(*) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id) AS payment_in_count,
                 -- HOW it came back, so the register can say so without a
                 -- query per row. Distinct, because three RTGS receipts are
                 -- one method, and ordered so the chip does not reshuffle
                 -- itself between loads.
                 (SELECT GROUP_CONCAT(m, ', ') FROM (
                    SELECT DISTINCT COALESCE(NULLIF(TRIM(pi.method), ''), 'Not stated') AS m
                      FROM bd_payment_ins pi WHERE pi.bd_id = bd.id ORDER BY m
                  )) AS payment_in_methods,
                 (SELECT MAX(pi.pay_date) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id) AS payment_in_last_date,
                 -- WHERE IT LANDED. The latest receipt's account and reference,
                 -- so the chip on the row can say the money is in and which
                 -- bank has it without a query per row.
                 (SELECT pi.account FROM bd_payment_ins pi WHERE pi.bd_id = bd.id
                   ORDER BY pi.pay_date DESC, pi.id DESC LIMIT 1) AS payment_in_account,
                 (SELECT pi.ref_no FROM bd_payment_ins pi WHERE pi.bd_id = bd.id
                   ORDER BY pi.pay_date DESC, pi.id DESC LIMIT 1) AS payment_in_ref,
                 -- HOW FAR THE INTEREST HAS BEEN SERVICED. A bill whose interest
                 -- is paid across the tenor has a second clock running, and the
                 -- register could not see it: a bill could be settled with the
                 -- NBFC and still owe the last stretch of interest.
                 COALESCE((SELECT SUM(ip.gross) FROM bd_interest_payments ip
                            WHERE ip.bd_id = bd.id), 0) AS interest_paid_total,
                 COALESCE((SELECT SUM(ip.tds) FROM bd_interest_payments ip
                            WHERE ip.bd_id = bd.id), 0) AS interest_paid_tds,
                 -- …or a repayment that paid the interest with it (to its repay date).
                 NULLIF(MAX(COALESCE((SELECT MAX(ip.to_date) FROM bd_interest_payments ip WHERE ip.bd_id = bd.id), ''),
                            COALESCE((SELECT MAX(rr.repay_date) FROM bd_repayments rr
                                       WHERE rr.bd_id = bd.id AND COALESCE(rr.interest, 0) > 0.004), '')), '') AS interest_paid_to,
                 (SELECT MAX(rr.repay_date) FROM bd_repayments rr
                   WHERE rr.bd_id = bd.id) AS last_repay_date,
                 -- Interest paid WITH the repayments (net) and its TDS — the
                 -- one on the repayment, or worked off the gross for one
                 -- entered before TDS was asked (bdInterestWithRepayments).
                 COALESCE((SELECT SUM(rr.interest) FROM bd_repayments rr WHERE rr.bd_id = bd.id), 0) AS rep_interest_net,
                 COALESCE((SELECT SUM(CASE WHEN rr.tds_amount IS NOT NULL THEN rr.tds_amount
                                           WHEN COALESCE(rr.interest, 0) > 0 AND bd.tds_pct > 0 AND bd.tds_pct < 100
                                           THEN ROUND(rr.interest * bd.tds_pct / (100 - bd.tds_pct), 2) ELSE 0 END)
                            FROM bd_repayments rr WHERE rr.bd_id = bd.id), 0) AS rep_interest_tds,
                 -- The later parts the NBFC paid the supplier (the first is on the bill).
                 COALESCE((SELECT SUM(pp.amount) FROM bd_party_payments pp WHERE pp.bd_id = bd.id), 0) AS party_parts_paid,
                 (SELECT COUNT(*) FROM bd_party_payments pp WHERE pp.bd_id = bd.id) AS party_parts_count
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
  // Every bill's receipt legs, in one read.
  const legRows = toPlain(
    await getClient()
      .execute({
        sql: `SELECT rp.* FROM bd_receipt_parts rp JOIN bill_discountings b ON b.id = rp.bd_id WHERE b.company_id = ? ORDER BY rp.bd_id, rp.part_no`,
        args: [getActiveCompanyId()]
      })
      .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
  )
  const legsOf = new Map<number, Row[]>()
  for (const r of legRows) {
    const k = n(r.bd_id)
    if (!legsOf.has(k)) legsOf.set(k, [])
    ;(legsOf.get(k) as Row[]).push(r)
  }
  // Every bill's repayments, in one read — for the interest an early repayment frees.
  const repRows = toPlain(
    await getClient()
      .execute({
        sql: `SELECT r.bd_id, r.repay_date, r.amount FROM bd_repayments r JOIN bill_discountings b ON b.id = r.bd_id WHERE b.company_id = ? ORDER BY r.bd_id, r.repay_date, r.id`,
        args: [getActiveCompanyId()]
      })
      .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
  )
  // Interest refunds already linked to a bank receipt (bd_interest_refunds), per bill.
  await ensureBdRefunds()
  const gotRows = toPlain(
    await getClient()
      .execute({
        sql: `SELECT f.bd_id, ROUND(SUM(f.amount), 2) AS got FROM bd_interest_refunds f
               JOIN bill_discountings b ON b.id = f.bd_id JOIN journal_entries je ON je.id = f.journal_entry_id
              WHERE b.company_id = ? GROUP BY f.bd_id`,
        args: [getActiveCompanyId()]
      })
      .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
  )
  const gotOf = new Map<number, number>(gotRows.map((r) => [n(r.bd_id), n(r.got)]))
  // Refunds closed fully (received short and the rest let go).
  const closedRows = toPlain(
    await getClient()
      .execute({
        sql: `SELECT c.* FROM bd_refund_closures c JOIN bill_discountings b ON b.id = c.bd_id WHERE b.company_id = ?`,
        args: [getActiveCompanyId()]
      })
      .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
  )
  const closedOf = new Map<number, Row>(closedRows.map((r) => [n(r.bd_id), r]))
  const repsOf = new Map<number, Row[]>()
  for (const r of repRows) {
    const k = n(r.bd_id)
    if (!repsOf.has(k)) repsOf.set(k, [])
    ;(repsOf.get(k) as Row[]).push(r)
  }
  // A part-repaid bill stays OPEN — the facility is still live for what is left
  // — so the screen needs the two figures the status word cannot carry: what
  // has gone back and what is still outstanding.
  return toPlain(res).map((raw) => {
    const bd: Row = { ...raw, receipt_parts: legsOf.get(n(raw.id)) || [] }
    const parts = n(bd.repay_parts)
    const repaidTotal = round2(
      parts > 0 ? n(bd.parts_paid) : String(bd.status) === 'repaid' ? n(bd.repaid_amount) : 0
    )
    const calcRow = bdCalc(bd)
    // PAID TO THE SUPPLIER IN PARTS: what has reached them, and what is left.
    const inParts = String(bd.disbursement_route || '') === 'supplier' && n(bd.first_party_part) > 0.005
    const partyPaid = inParts ? round2(n(bd.first_party_part) + n(bd.party_parts_paid)) : null
    return {
      ...bd,
      party_name: partyName(bd),
      ...calcRow,
      party_in_parts: inParts,
      party_paid: partyPaid,
      party_left: inParts ? round2(Math.max(0, calcRow.receiptAmount - (partyPaid || 0))) : 0,
      party_part_count: inParts ? 1 + n(bd.party_parts_count) : 0,
      // RECEIVED FROM THE NBFC IN PARTS (SID).
      receipt_in_parts: n(bd.first_receipt_part) > 0.005,
      receipt_part_count: n(bd.first_receipt_part) > 0.005 ? 1 + (bd.receipt_parts as Row[]).length : 0,
      repaid_total: repaidTotal,
      outstanding_amount: round2(Math.max(0, principalDrawn(bd) - repaidTotal)),
      repay_parts: parts,
      early_refund: earlyRefund(bd, calcRow, repsOf.get(n(bd.id)) || [], gotOf.get(n(bd.id)) || 0, closedOf.get(n(bd.id)) || null),
      // Three stages, in the order a bill goes through them: opened and waiting
      // on the NBFC's money, live once it has landed, wound up once repaid.
      // Derived rather than stored, so the payment date stays the single fact
      // that decides it and no row can disagree with its own dates.
      stage: String(bd.status) === 'repaid' ? 'repaid' : bd.payment_received_date ? 'live' : 'awaiting'
    }
  })
}

export async function createBd(v: Row): Promise<{ id: number }> {
  await ensureInvoiceAdj()
  return withDbTransaction(async () => {
  await validateBd(v)
  v = withPrimaryParty(v)
  const res = await getClient().execute({
    sql: `INSERT INTO bill_discountings (company_id, ${BD_COLS.join(', ')}, status)
          VALUES (?, ${BD_COLS.map(() => '?').join(', ')}, 'open')`,
    args: [getActiveCompanyId(), ...bdArgs(v)]
  })
  const id = Number(res.lastInsertRowid)
  const partyIds = Array.isArray(v.party_ids) ? v.party_ids : n(v.party_id) ? [n(v.party_id)] : []
  await syncBdParties(id, String(v.party_type), partyIds, v.party_amounts as Record<string, unknown> | null)
  // Only when the caller names them — an untouched form must not clear links.
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids)
  await postBdOpening(id)
  return { id }
  })
}

export async function updateBd(id: number, v: Row, opts: { repost?: boolean } = {}): Promise<{ id: number }> {
  await ensureInvoiceAdj()
  return withDbTransaction(async () => {
  const cur = await loadBd(id)
  // A screen that does not show the adjustment (the phone form, the API)
  // keeps the one the bill has rather than zeroing it — zeroing it would move
  // the margin and everything struck from it.
  if (!('invoice_adj' in v)) v = { ...v, invoice_adj: cur.invoice_adj ?? 0 }
  if (!('open_adj' in v)) v = { ...v, open_adj: cur.open_adj ?? 0 }
  if (!('open_adj_charge' in v)) v = { ...v, open_adj_charge: cur.open_adj_charge ?? 0 }
  // The phone form and the API do not carry the charge type; they keep it.
  if (!('open_adj_ledger' in v)) v = { ...v, open_adj_ledger: cur.open_adj_ledger ?? null }
  if (!('open_adj_split' in v)) v = { ...v, open_adj_split: cur.open_adj_split ?? null }
  if (!('interest_after_adj' in v)) v = { ...v, interest_after_adj: cur.interest_after_adj ?? 0 }
  if (n(cur.upfront_interest_journal_entry_id)) {
    for (const key of ['amount', 'invoice_amount', 'invoice_adj', 'open_adj', 'open_adj_charge', 'interest_after_adj', 'margin_pct', 'interest_pct', 'tds_pct', 'days_year', 'days_incl_start', 'interest_upfront', 'interest_mode', 'payment_received_date', 'maturity_date', 'nbfc_id']) {
      if (String(v[key] ?? '') !== String(cur[key] ?? '') && Number(v[key]) !== Number(cur[key])) throw new Error('Reverse the recorded upfront interest payment before changing its terms')
    }
  }
  if (String(cur.status) === 'repaid') throw new Error('This bill is already repaid — reopen it first if it needs correcting')
  // A form that does not carry the route (an older screen, the API) keeps what
  // the bill already has rather than blanking it.
  if (v.disbursement_route == null || v.disbursement_route === '') v = { ...v, disbursement_route: cur.disbursement_route || 'unconfirmed' }
  if (v.disbursement_account == null) v = { ...v, disbursement_account: cur.disbursement_account ?? null }
  await validateBd(v, cur)
  // Part of this bill may already have gone back. Cutting the face amount below
  // what has been repaid would leave the facility owing a negative balance, so
  // the repayments have to be undone first.
  v = withPrimaryParty(v)
  const paid = await repaidSoFar(cur)
  if (paid > 0 && n(v.amount) - paid < -0.004) {
    throw new Error(`${inr(paid)} has already been repaid on this bill — the amount cannot be set below that`)
  }
  await getClient().execute({
    sql: `UPDATE bill_discountings SET ${BD_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...bdArgs(v), id]
  })
  if (Array.isArray(v.party_ids) || n(v.party_id)) {
    await syncBdParties(
      id,
      String(v.party_type),
      Array.isArray(v.party_ids) ? v.party_ids : [n(v.party_id)],
      v.party_amounts as Record<string, unknown> | null
    )
  }
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids)
  // The admin correction of a repaid bill can leave the vouchers as booked.
  if (opts.repost !== false) await postBdOpening(id)
  return { id }
  })
}

/**
 * ADMIN: CORRECT A REPAID BILL WITHOUT REOPENING IT (a maturity keyed a day
 * out, a rate, a date). An administrator only, at their own risk. In ONE
 * transaction: the bill is saved exactly as Edit would save an open one — its
 * opening voucher re-posted in place — while it stays repaid (status, repaid
 * date and amount, repayments and their vouchers untouched), and interest paid
 * upfront is re-posted in place for the new terms (same number, date, bank).
 * Anything worked out live — the early-repayment refund, days, the register —
 * follows by itself.
 */
export async function adminUpdateRepaidBd(id: number, v: Row): Promise<{ id: number }> {
  const { assertAdmin } = await import('./access-gate')
  await assertAdmin('Editing a repaid bill')
  return withDbTransaction(async () => {
    const c = getClient()
    const cur = await loadBd(id)
    if (String(cur.status) !== 'repaid') return updateBd(id, v)
    const upId = n(cur.upfront_interest_journal_entry_id)
    // Past updateBd's two locks (repaid; upfront interest recorded) — put back below.
    await c.execute({ sql: "UPDATE bill_discountings SET status = 'open', upfront_interest_journal_entry_id = NULL WHERE id = ?", args: [n(id)] })
    // Vouchers carry what really moved through the bank; by default they stay as
    // booked and only the bill's terms change. Ticked, they are re-posted for the new terms.
    const repost = !!v.admin_repost
    await updateBd(id, v, { repost })
    await c.execute({
      sql: 'UPDATE bill_discountings SET status = ?, repaid_date = ?, repaid_amount = ?, upfront_interest_journal_entry_id = ? WHERE id = ?',
      args: [String(cur.status), cur.repaid_date ?? null, cur.repaid_amount ?? null, upId || null, n(id)]
    })
    if (upId && repost) {
      const bd = await loadBd(id)
      const calc = bdCalc(bd)
      if (calc.interestAmount < 0.005) throw new Error('With these terms there is no interest — reverse the upfront interest payment first')
      await repostJournal(upId, {
        date: String(bd.upfront_interest_paid_date || '').slice(0, 10),
        vchType: 'PAYMENT',
        vchNo: String(bd.bd_no || ''),
        narration: `Bill Discounting ${bd.bd_no} — interest ${calc.interestAmount.toFixed(2)} (TDS ${calc.tdsAmount.toFixed(2)}) settled upfront, per the bank statement`,
        companyId: n(bd.company_id) || undefined,
        lines: [
          { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: calc.interestAmount },
          { account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: calc.tdsAmount },
          { account: String(bd.upfront_interest_account || ''), group: 'Bank Accounts', cr: calc.netInterest }
        ]
      })
    }
    return { id: n(id) }
  })
}

/**
 * BILLS STILL ON THE OLD READING OF THE ADJ., MOVED TO THE NEW ONE.
 *
 * Before 2026-09-30 an Adj. on the Open amount changed what was DRAWN: the
 * bill stored Open ± Adj as its amount and charged interest on that. Since
 * then the NBFC is taken to lend the whole Open amount — that is what goes
 * back at maturity — and the Adj. is its own charge out of the payout (BD
 * CHARGES A/C). A bill saved before the change keeps the old figures until it
 * is saved again; this does that save for the ones still open (asked for on
 * 2026-10-01, for FD1: Open ₹70,00,000, Adj. −₹7,08,000, which read as
 * ₹62,92,000 owed).
 *
 * Exactly what Save changes would do to the money — amount back to the Open
 * figure, the Adj. as a charge, the opening voucher re-posted in place (same
 * number, same date, same bank) — and nothing else on the bill. Only a bill
 * with nothing paid against it yet: no repayment, no interest payment, no
 * upfront interest recorded. Its voucher as it stood is archived first.
 */
export async function convertOpenAdjToCharge(): Promise<string[]> {
  await ensureInvoiceAdj()
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  const res = await c.execute(
    `SELECT id, bd_no, amount, open_adj, journal_entry_id FROM bill_discountings
      WHERE ABS(COALESCE(open_adj, 0)) > 0.004 AND COALESCE(open_adj_charge, 0) = 0 AND status = 'open'
        AND upfront_interest_journal_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM bd_repayments r WHERE r.bd_id = bill_discountings.id)
        AND NOT EXISTS (SELECT 1 FROM bd_interest_payments p WHERE p.bd_id = bill_discountings.id)`
  )
  const done: string[] = []
  for (const r of toPlain(res)) {
    const id = n(r.id)
    await withDbTransaction(async () => {
      const tx = getClient()
      const je = n(r.journal_entry_id)
      if (je) {
        const entry = toPlain(await tx.execute({ sql: 'SELECT * FROM journal_entries WHERE id = ?', args: [je] }))[0] || null
        const lines = toPlain(
          await tx.execute({
            sql: `SELECT jl.*, la.name AS account FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id WHERE jl.entry_id = ?`,
            args: [je]
          })
        )
        await tx.execute({
          sql: 'INSERT OR IGNORE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
          args: [`bd-open-adj-charge-v1:${id}`, je, JSON.stringify({ bill: r, entry, lines })]
        })
      }
      await tx.execute({
        sql: 'UPDATE bill_discountings SET amount = ROUND(amount - open_adj, 2), open_adj_charge = 1 WHERE id = ?',
        args: [id]
      })
      await postBdOpening(id)
    })
    done.push(`${String(r.bd_no || id)} ${round2(n(r.amount) - n(r.open_adj)).toFixed(2)}`)
  }
  return done
}

export async function deleteBd(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(id)
  const interest = await c.execute({ sql: 'SELECT id FROM bd_interest_payments WHERE bd_id=? LIMIT 1', args: [id] })
  if (interest.rows.length || n(bd.upfront_interest_journal_entry_id)) throw new Error('Reverse this bill’s interest payments before deleting it')
  await dropEntry(n(bd.journal_entry_id) || null)
  await dropRepayEntries(bd)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  // The customer's payments back, and the purchase-invoice links, are part of
  // this bill and mean nothing without it.
  const ins = await c.execute({ sql: 'SELECT journal_entry_id FROM bd_payment_ins WHERE bd_id = ?', args: [id] })
  for (const r of ins.rows) await dropEntry(n(r.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_payment_ins WHERE bd_id = ?', args: [id] })
  // The later parts paid to the supplier, and their vouchers.
  const pp = await c.execute({ sql: 'SELECT journal_entry_id FROM bd_party_payments WHERE bd_id = ?', args: [id] }).catch(() => null)
  for (const r of pp?.rows || []) await dropEntry(n(r.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_party_payments WHERE bd_id = ?', args: [id] }).catch(() => undefined)
  // The later legs received from the NBFC, and their vouchers.
  for (const r of bd.receipt_parts as Row[]) await dropEntry(n(r.journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bd_receipt_parts WHERE bd_id = ?', args: [id] }).catch(() => undefined)
  await c.execute({ sql: 'DELETE FROM bd_linked_orders WHERE bd_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bd_parties WHERE bd_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bill_discountings WHERE id = ?', args: [id] })
  return { id }
  })
}

// Money that has moved has a date in the past or today, never ahead of it: a
// receipt or a payment dated forward is a forecast, and the ledger would carry
// it as fact. The MATURITY date is deliberately not checked this way -- a bill
// matures in the future by definition.
function assertNotFuture(date: string, what: string): void {
  const d = String(date || '').slice(0, 10)
  if (d && d > todayISO()) throw new Error(`${what} cannot be a future date`)
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
// THE INTEREST OF A REPAYMENT, BOOKED: Dr INTEREST ON BILL DISCOUNTING for
// the gross (what was paid + the TDS held), Cr the bill discounter for what was
// paid, Cr the TDS ledger — the debit for what was paid already sits on the
// discounter's ledger in the payment, so the two cancel there.
async function postBdInterestJournal(
  bd: Row,
  date: string,
  interest: number,
  tds: number,
  tdsLedger: { name: string; group: string }
): Promise<number> {
  const lines: JournalLine[] = [
    { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: round2(interest + tds) },
    { account: bdPayable(bd), group: BD_PAYABLE_GROUP, cr: interest }
  ]
  if (tds > 0.004) lines.push({ account: tdsLedger.name, group: tdsLedger.group, cr: tds })
  const je = await postJournal({
    date,
    vchType: 'JOURNAL',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Interest on Bill Discounting ${bd.bd_no} — ${inr(round2(interest + tds))}, ${inr(interest)} paid to ${bd.nbfc_name || 'the NBFC'}` +
      (tds > 0.004 ? `, TDS ${inr(tds)} held to ${tdsLedger.name}` : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  return je.id
}

export async function repayBd(
  id: number,
  v: {
    repay_date?: string
    settle_via?: 'bank' | 'party'
    ref?: string | null
    release_margin?: boolean
    // What the bank took on top of the principal, in the same debit.
    comm_charges?: string | number | null
    bank_charges?: string | number | null
    // Any other charge in the same debit, each on the ledger the user picked.
    charges?: { account?: string; amount?: string | number }[] | null
    // INTEREST PAID IN THE SAME DEBIT — gross, to the interest ledger. One
    // transfer of 30,32,145 is 30,00,000 of principal and 32,145 of interest;
    // entered apart it would be two bank lines against the statement's one.
    interest?: string | number | null
    // PENALTY INTEREST for days past maturity, gross, in the same debit — on
    // its own ledger, with the rate and days it was worked at kept on the row.
    penalty?: string | number | null
    penalty_pct?: string | number | null
    penalty_days?: string | number | null
    // What is going back now. Omitted (or blank) means the whole balance.
    amount?: number | string | null
    note?: string | null
    // Which party's ledger to settle against, when the bill carries several.
    // Defaults to the primary.
    party_id?: number | null
    // The bank the money left from. Defaults to the bill's own bank.
    bank_account?: string | null
    /**
     * OTHER BILLS THIS SAME DEBIT ALSO CLEARED.
     *
     * One transfer to the NBFC often settles several bills: 47,00,000 leaves
     * the bank and 13,03,660 of it is this bill, 33,96,340 another. Entered as
     * two repayments it posts two vouchers, so the bank book shows two lines
     * where the statement shows one, and reconciliation can never match it.
     *
     * So the figure typed here is the whole debit, and what it does not
     * settle on THIS bill is accounted for here and in the charges. One
     * voucher, one bank credit, and a repayment row against each bill.
     */
    also?: { bd_id?: number | string; amount?: number | string }[]
    // TDS HELD ON THE INTEREST — the ledger it goes to and how much. The
    // interest is booked by a journal of its own (postBdInterestJournal).
    tds_ledger?: string | null
    tds_amount?: number | string | null
  }
): Promise<{ id: number; amount: number; outstanding: number; closed: boolean }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is already repaid')
  if (!bd.payment_received_date) {
    throw new Error('Mark the payment received first — there is nothing to repay until the NBFC has funded this bill')
  }
  // What the NBFC has lent so far — on a bill still arriving in parts, only
  // the legs that have landed.
  const face = principalDrawn(bd)
  const already = await repaidSoFar(bd)
  const due = round2(face - already)
  if (due <= 0.004) throw new Error('There is nothing left to repay on this bill')
  const typed = v.amount === undefined || v.amount === null || String(v.amount).trim() === '' ? due : round2(n(v.amount))
  if (typed <= 0) throw new Error('Enter the amount being repaid')
  // What this bill takes is what it still owes, or the whole figure when the
  // figure is smaller. Anything over that is not this bill's and has to say
  // where it went before the voucher is written.
  const asked = round2(Math.min(typed, due))
  const spill = round2(typed - asked)
  const date = String(v.repay_date || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The repayment date')
  // On a SID the sales bill itself is assigned to the financier: they pay us and
  // we repay them, so the customer's ledger is not part of the transaction at
  // all. Settling one against a party would credit a customer who never owed us
  // this money. Refused rather than quietly redirected to the bank, so nobody is
  // left thinking a party ledger was touched.
  if (v.settle_via === 'party' && String(bd.finance_type) === 'SID') {
    throw new Error(
      'A SID bill is repaid to the financier, not settled against the customer — the customer’s ledger is not involved'
    )
  }
  const settleVia = v.settle_via === 'party' ? 'party' : 'bank'
  // A bill raised against several parties has to name the one being settled —
  // crediting the primary for a payment that cleared another party's invoices
  // would put the money on the wrong ledger.
  let party = partyName(bd)
  if (settleVia === 'party' && n(v.party_id) && n(v.party_id) !== n(bd.party_id)) {
    const chosen = (await listBdParties(id)).find((p) => n(p.party_id) === n(v.party_id))
    if (!chosen) throw new Error('That party is not on this bill')
    party = String(chosen.name || '').trim()
  }
  if (settleVia === 'party' && !party) throw new Error('This bill has no linked party to settle against')
  // What is left AFTER this payment decides whether the bill closes, and it is
  // also what the narration has to say, so the voucher reads as a running
  // balance rather than an unexplained part figure.
  const left = round2(due - asked)
  const closed = left <= 0.004
  // WHAT THE BANK TOOK ON TOP OF THE BILL.
  //
  // The NBFC's commission and the bank's own charges come out of the SAME
  // debit as the principal — one line on the statement, 79,50,000 against a
  // 77,76,117.45 bill. They are this event's cost, not part of what was
  // borrowed, so they ride on this voucher as expenses and the credit is the
  // whole figure that actually left the account.
  //
  // Which is why they could not be entered before: the amount is checked
  // against the bill's open balance, so the real debit was refused as "more
  // than the bill is for" and the charges never reached the books.
  const comm = round2(n(v.comm_charges))
  const bankCharges = round2(n(v.bank_charges))
  const interestPaid = round2(n(v.interest))
  const penaltyPaid = round2(n(v.penalty))
  if (penaltyPaid < 0) throw new Error('Penalty interest cannot be negative')
  const repayBank = settleVia === 'bank' ? await bdBankFor(bd, v.bank_account) : null
  if (comm < 0 || bankCharges < 0) throw new Error('Charges cannot be negative')
  if (interestPaid < 0) throw new Error('Interest cannot be negative')
  const tdsAmt = round2(n(v.tds_amount))
  let tdsLedger = { name: '', group: 'Duties & Taxes' }
  if (tdsAmt < 0) throw new Error('TDS cannot be negative')
  if (tdsAmt > 0.004) {
    const nm = String(v.tds_ledger || '').trim()
    if (!nm) throw new Error('Pick the TDS ledger')
    const t = await c.execute({ sql: 'SELECT name, acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = UPPER(?) LIMIT 1', args: [nm] })
    // A ledger not made yet (TDS ON INTEREST PAYABLE A/C on a fresh book) is
    // made by the journal under Duties & Taxes.
    tdsLedger = t.rows.length ? { name: String(t.rows[0].name), group: String(t.rows[0].acc_group || 'Duties & Taxes') } : { name: nm, group: 'Duties & Taxes' }
  }
  // CHARGES ON A LEDGER OF THE USER'S CHOOSING — as many as the debit carried.
  // The ledger must already exist: a typo would otherwise open a new one.
  const charges: { account: string; group: string; amount: number }[] = []
  for (const ch of v.charges || []) {
    const name = String(ch?.account || '').trim()
    const amt = round2(n(ch?.amount))
    if (!name && amt <= 0.004) continue
    if (!name) throw new Error('Pick the ledger for each charge')
    if (amt <= 0.004) throw new Error(`Enter the amount charged to ${name}`)
    // Paid over the balance and the NBFC will give it back: a receivable on
    // this NBFC's own refund-due ledger, made the first time (lib/refundDue.ts).
    if (isRefundDue(name)) {
      charges.push({ account: refundLedgerFor(String(bd.nbfc_name || '')), group: REFUND_DUE_GROUP, amount: amt })
      continue
    }
    const acc = await c.execute({ sql: 'SELECT name, acc_group FROM ledger_accounts WHERE UPPER(TRIM(name)) = UPPER(?) LIMIT 1', args: [name] })
    if (!acc.rows.length) throw new Error(`There is no ledger called ${name}`)
    charges.push({ account: String(acc.rows[0].name), group: String(acc.rows[0].acc_group || 'Indirect Expenses'), amount: amt })
  }
  const extra = round2(charges.reduce((t, x) => t + x.amount, 0))

  // THE OTHER BILLS, CHECKED BEFORE ANYTHING IS WRITTEN.
  const others: { bd: Row; amount: number; due: number }[] = []
  // The same bill named twice would let one debit "clear" it twice — each
  // entry checked on its own against what it owed BEFORE either was applied,
  // so two part-figures that individually fit could together run past what
  // the bill actually has outstanding.
  const alsoSeen = new Set<number>()
  for (const o of v.also || []) {
    const oid = n(o?.bd_id)
    const amt = round2(n(o?.amount))
    if (!oid || amt <= 0.004) continue
    if (oid === id) throw new Error('A bill cannot also settle itself')
    if (alsoSeen.has(oid)) throw new Error('The same bill is named twice — one line per bill')
    alsoSeen.add(oid)
    const ob = await loadBd(oid)
    if (String(ob.status) === 'repaid') throw new Error(`${ob.bd_no || 'That bill'} is already repaid`)
    if (!ob.payment_received_date) {
      throw new Error(`${ob.bd_no || 'That bill'} has not been funded yet — there is nothing to repay on it`)
    }
    if (n(ob.nbfc_id) !== n(bd.nbfc_id)) {
      throw new Error(`${ob.bd_no || 'That bill'} is with a different NBFC — one debit cannot settle both`)
    }
    const odue = round2(principalDrawn(ob) - (await repaidSoFar(ob)))
    if (amt - odue > 0.004) {
      throw new Error(`${ob.bd_no || 'That bill'} has only ${inr(odue)} outstanding`)
    }
    others.push({ bd: ob, amount: amt, due: odue })
  }
  const toOthers = round2(others.reduce((t, o) => t + o.amount, 0))

  // The typed figure is the debit. Everything over this bill's own share has
  // to be accounted for exactly — a rupee unexplained is a bank book that will
  // not reconcile, found weeks later.
  if (spill > 0.004 || others.length) {
    const explained = round2(comm + bankCharges + interestPaid + penaltyPaid + extra + toOthers)
    if (Math.abs(spill - explained) > 0.004) {
      throw new Error(
        spill > explained
          ? `${inr(round2(spill - explained))} of the ${inr(typed)} is not accounted for — add it to the charges or to another bill`
          : `${inr(round2(explained - spill))} more is allocated than the ${inr(typed)} being repaid`
      )
    }
  }
  // Charges ride ON TOP when the figure is this bill's own principal, because
  // that is what the bank debits; they come OUT of it once the figure IS the
  // debit and has been broken down.
  const paidOut = spill > 0.004 || others.length ? typed : round2(asked + comm + bankCharges + interestPaid + penaltyPaid + extra)
  // One debit for the principal of every bill this payment settled. Summed
  // rather than a line each: the ledger carries one account, and which bill
  // took what is on the repayment rows and in the narration below.
  // THE PAYMENT is the bill discounter's for the whole of principal AND
  // interest — Bills Discounted A/C To Bank A/C — and the interest is put on
  // that ledger by a journal of its own (Interest To Bills Discounted, To TDS),
  // the way Tally books it.
  // THE WHOLE DEBIT GOES THROUGH THE NBFC'S BD LEDGER (since 2026-11-26, the
  // user's rule): the payment is Bills Discounted Dr / Bank Cr for every rupee
  // that left; the costs in it come onto that ledger by a journal of their own
  // (Penalty / Commission / Bank charges Dr, To Bills Discounted), like the
  // interest journal. Money paid over the balance stays a debit on the BD
  // ledger until the NBFC refunds it (Bank Dr / To Bills Discounted).
  const costLines: JournalLine[] = []
  if (comm > 0.004) costLines.push({ account: 'COMM. CHARGES A/C', group: 'Indirect Expenses', dr: comm })
  if (bankCharges > 0.004) costLines.push({ account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: bankCharges })
  if (penaltyPaid > 0.004) costLines.push({ account: 'PENAL INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: penaltyPaid })
  for (const ch of charges) if (!isRefundDue(ch.account)) costLines.push({ account: ch.account, group: ch.group, dr: ch.amount })
  const lines: JournalLine[] = [{ account: bdPayable(bd), group: BD_PAYABLE_GROUP, dr: paidOut }]
  if (settleVia === 'party') {
    lines.push({
      account: party,
      group: bd.party_type === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors',
      cr: paidOut
    })
  } else {
    lines.push({ account: repayBank || 'BANK A/C', group: 'Bank Accounts', cr: paidOut })
  }
  const je = await postJournal({
    date,
    vchType: settleVia === 'party' ? 'JOURNAL' : 'PAYMENT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no} ${closed && already <= 0.004 ? 'repaid' : closed ? 'closed — final part repayment' : 'part repayment'}` +
      ` to ${bd.nbfc_name || 'the NBFC'}` +
      (closed ? '' : ` — ${inr(left)} still outstanding`) +
      // Said on the voucher, because a debit larger than the principal is the
      // first thing anybody querying a bank statement asks about.
      (comm > 0.004 || bankCharges > 0.004 || interestPaid > 0.004 || penaltyPaid > 0.004 || extra > 0.004
        ? ` — ${inr(paidOut)} debited, including ${
            [
              interestPaid > 0.004 ? `${inr(interestPaid)} interest` : '',
              penaltyPaid > 0.004
                ? `${inr(penaltyPaid)} penalty interest${n(v.penalty_pct) ? ` at ${n(v.penalty_pct)}%` : ''}${n(v.penalty_days) ? ` for ${n(v.penalty_days)} day${n(v.penalty_days) === 1 ? '' : 's'} past maturity` : ''}`
                : '',
              comm > 0.004 ? `${inr(comm)} commission` : '',
              bankCharges > 0.004 ? `${inr(bankCharges)} bank charges` : '',
              ...charges.map((ch) => `${inr(ch.amount)} ${ch.account}`)
            ]
              .filter(Boolean)
              .join(' and ')
          }`
        : '') +
      (others.length
        ? ` — one debit of ${inr(paidOut)} also settling ${others
            .map((o) => `${o.bd.bd_no || o.bd.id} ${inr(o.amount)}`)
            .join(', ')}`
        : '') +
      (settleVia === 'party' ? ` — settled against ${party}` : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  // The party is settled for the WHOLE debit, charges included — that is what
  // left their account against this bill.
  if (settleVia === 'party') await allocAgainst(je.id, party, v.ref || null, paidOut)
  const insRep = await c.execute({
    sql: `INSERT INTO bd_repayments (bd_id, repay_date, amount, comm_charges, bank_charges, settle_via, ref, journal_entry_id, note, bank_account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      date,
      asked,
      comm > 0.004 ? comm : null,
      bankCharges > 0.004 ? bankCharges : null,
      settleVia,
      v.ref ? String(v.ref) : null,
      je.id,
      v.note ? String(v.note) : null,
      repayBank
    ]
  })
  // The interest in this debit, on this bill's repayment row (column added at
  // startup — bd_repay_interest_v1).
  if (costLines.length) {
    const costTotal = round2(costLines.reduce((t, l) => t + n(l.dr), 0))
    const cj = await postJournal({
      date,
      vchType: 'JOURNAL',
      vchNo: String(bd.bd_no || ''),
      narration: `Charges on Bill Discounting ${bd.bd_no} repayment to ${bd.nbfc_name || 'the NBFC'} — ${costLines.map((l) => `${inr(n(l.dr))} ${l.account}`).join(', ')}`,
      companyId: n(bd.company_id) || undefined,
      lines: [...costLines, { account: bdPayable(bd), group: BD_PAYABLE_GROUP, cr: costTotal }]
    })
    await c.execute({ sql: 'UPDATE bd_repayments SET charges_entry_id = ? WHERE id = ?', args: [cj.id, Number(insRep.lastInsertRowid || 0)] })
  }
  if (interestPaid > 0.004) {
    await c.execute({ sql: 'UPDATE bd_repayments SET interest = ? WHERE id = ?', args: [interestPaid, Number(insRep.lastInsertRowid || 0)] })
    const ij = await postBdInterestJournal(bd, date, interestPaid, tdsAmt, tdsLedger)
    await c.execute({
      sql: 'UPDATE bd_repayments SET interest_entry_id = ?, tds_ledger = ?, tds_amount = ? WHERE id = ?',
      args: [ij, tdsAmt > 0.004 ? tdsLedger.name : null, tdsAmt > 0.004 ? tdsAmt : 0, Number(insRep.lastInsertRowid || 0)]
    })
  }
  if (penaltyPaid > 0.004) {
    await c.execute({
      sql: 'UPDATE bd_repayments SET penalty = ?, penalty_pct = ?, penalty_days = ? WHERE id = ?',
      args: [penaltyPaid, n(v.penalty_pct) || null, Math.round(n(v.penalty_days)) || null, Number(insRep.lastInsertRowid || 0)]
    })
  }
  // The ledger charges, kept on the row so an edit re-posts them (bd_repay_charges_v1).
  if (charges.length) {
    await c.execute({
      sql: 'UPDATE bd_repayments SET charges = ? WHERE id = ?',
      args: [JSON.stringify(charges.map(({ account, amount }) => ({ account, amount }))), Number(insRep.lastInsertRowid || 0)]
    })
  }
  // The other bills get their own repayment row against the SAME voucher, so
  // each bill's history shows what came off it and the bank shows one debit.
  for (const o of others) {
    await c.execute({
      sql: `INSERT INTO bd_repayments (bd_id, repay_date, amount, comm_charges, bank_charges, settle_via, ref, journal_entry_id, note, bank_account)
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      args: [
        n(o.bd.id),
        date,
        o.amount,
        settleVia,
        v.ref ? String(v.ref) : null,
        je.id,
        `Part of one ${inr(paidOut)} debit with ${bd.bd_no || id}`,
        repayBank
      ]
    })
    const oPaid = round2(principalDrawn(o.bd) - o.due + o.amount)
    const oClosed = round2(o.due - o.amount) <= 0.004
    await c.execute({
      sql: `UPDATE bill_discountings
            SET status = ?, repaid_date = ?, repaid_amount = ?, repay_journal_entry_id = NULL
            WHERE id = ?`,
      args: [oClosed ? 'repaid' : 'open', oClosed ? date : null, oPaid, n(o.bd.id)]
    })
  }

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
    // The margin comes back into the account the repayment left from.
    await postBdMarginRelease(fresh, repayBank)
  }
  return { id, amount: asked, outstanding: left, closed }
  })
}

// -----------------------------------------------------------------------------
// INTEREST SERVICED DURING THE TENOR
// -----------------------------------------------------------------------------
// The two older ways of charging a discounted bill both settle the whole
// tenor's interest at the start: netted out of the disbursement, or paid
// separately once. This is the third, and on longer paper the commonest — the
// interest is PAID as it runs, monthly or fortnightly or on whatever rest the
// NBFC agreed, and only the principal falls due at maturity.
//
// Nothing here accrues. Interest is expensed on the day it is paid, for the
// days that payment covers, which is exactly how the upfront voucher already
// behaves — so a serviced bill and a discounted one put the same total through
// the same expense account, and can be read side by side.

// HOW OFTEN THE INTEREST RESTS.
//
// Monthly means the CALENDAR month, not thirty days — a bill drawn on the 1st
// of July rests on the 1st of August, which is the date the NBFC's own advice
// will carry. Counting 30 days instead lands on the 31st of July and every
// later rest drifts further from the day that was agreed. Only a fortnightly
// rest is genuinely counted in days.
const BD_REST: Record<string, { days?: number; months?: number }> = {
  fortnightly: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  half_yearly: { months: 6 }
}

/** A date `d` days on from an ISO date, as ISO. */
function addDays(iso: string, d: number): string {
  const t = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + d)
  return t.toISOString().slice(0, 10)
}

/**
 * A date `m` calendar months on, keeping the day of the month.
 *
 * A day that does not exist in the target month falls back to that month's
 * last day — 31 January plus one month is 28 February, not 3 March, which is
 * what plain date arithmetic would give.
 */
function addMonths(iso: string, m: number): string {
  const d = String(iso).slice(0, 10)
  const y = Number(d.slice(0, 4))
  const mo = Number(d.slice(5, 7)) - 1
  const day = Number(d.slice(8, 10))
  const first = new Date(Date.UTC(y, mo + m, 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10)
}

/** The last day of the calendar month an ISO date falls in. */
function monthEnd(iso: string): string {
  const d = String(iso).slice(0, 10)
  const y = Number(d.slice(0, 4))
  const mo = Number(d.slice(5, 7)) - 1
  // Day 0 of the NEXT month is the last day of this one, and it handles
  // February and leap years without a table.
  return new Date(Date.UTC(y, mo + 1, 0)).toISOString().slice(0, 10)
}

/**
 * INTEREST ON THE REDUCING PRINCIPAL.
 *
 * A part of the principal paid back early stops costing interest: the NBFC
 * charges each day on what is still out that day. A repayment counts from its
 * own day — the repayment day already runs on the lower balance.
 *
 * `principalRepaidByDate` is what went back, grouped by day, oldest first.
 * `bdInterestParts` splits one inclusive stretch of days [a, b] at those dates
 * and prices each piece on its own balance — the breakdown the BD panel shows
 * under each period.
 */
async function principalRepaidByDate(bdId: number): Promise<{ date: string; amount: number }[]> {
  const r = await getClient().execute({
    sql: `SELECT substr(repay_date, 1, 10) AS d, COALESCE(SUM(amount), 0) AS amt
            FROM bd_repayments WHERE bd_id = ? GROUP BY substr(repay_date, 1, 10) ORDER BY d`,
    args: [n(bdId)]
  })
  return (r.rows as unknown as Row[]).map((x) => ({ date: String(x.d), amount: round2(n(x.amt)) })).filter((x) => x.amount > 0.004)
}

function bdInterestParts(
  base: number,
  steps: { date: string; amount: number }[],
  a: string,
  b: string,
  rate: number,
  daysYear: number
): { parts: Row[]; gross: number } {
  const parts: Row[] = []
  if (b < a) return { parts, gross: 0 }
  const balOn = (d: string): number => Math.max(0, round2(base - steps.filter((x) => x.date <= d).reduce((t, x) => t + x.amount, 0)))
  // Cut points: each repayment's own day, inside the stretch.
  const cuts = steps.map((x) => x.date).filter((d) => d > a && d <= b)
  const starts = [a, ...Array.from(new Set(cuts)).sort()]
  let raw = 0
  starts.forEach((from, i) => {
    const to = i + 1 < starts.length ? addDays(starts[i + 1], -1) : b
    const days = daysBetween(from, to) + 1
    const principal = balOn(from)
    const exact = (principal * rate * days) / (100 * daysYear)
    raw += exact
    parts.push({ from_date: from, to_date: to, days, principal, interest: round2(exact) })
  })
  return { parts, gross: round2(raw) }
}

/**
 * What a serviced bill owes, when.
 *
 * A MONTH REST IS A CALENDAR MONTH, not a thirty-day anniversary. A bill
 * funded on the 16th of September is serviced to the 30th of September, then
 * for October, then for November — which is how the lender bills it and how
 * anybody reading a statement expects to find it. Struck on the 16th of each
 * month it would agree with nothing: not the NBFC's advice, not a month-end
 * accrual, not the books.
 *
 * So a month rest lands on the END of the calendar month, and a quarterly or
 * half-yearly one on the end of the month its block finishes in. Only the
 * fortnightly rest keeps anniversary arithmetic, because a fortnight has no
 * calendar to anchor to.
 *
 * The LAST rest always lands on maturity, however short that final stretch
 * turns out to be — the tail of a bill is whatever is left of it, not a
 * period in its own right.
 *
 * Each slice is `open x rate x days / (100 x year)`, and the final slice is the
 * PLUG: it is whatever is left of the tenor's interest after the earlier ones,
 * so the schedule can never add up to a paisa more or less than the bill would
 * have been charged in one go.
 */
export async function bdInterestSchedule(bdId: number): Promise<Row[]> {
  const bd = await loadBd(bdId)
  const calc = bdCalc(bd)
  const from = String(bd.payment_received_date || '').slice(0, 10)
  const to = String(bd.maturity_date || '').slice(0, 10)
  if (String(bd.interest_mode || '') !== 'serviced' || !from || !to || calc.intDays <= 0) return []

  const rest = BD_REST[String(bd.interest_freq || 'monthly')]
  // No rest at all ('maturity') is one payment on the last day. Every mark is
  // struck from the RECEIPT date rather than from the previous mark, so a
  // month clamped to a short February cannot drag the rest of the schedule
  // backwards with it.
  //
  // `months * i - 1` is what makes the FIRST month rest end this month rather
  // than next: one month on from the 16th of September is the 16th of October,
  // whose month end is the 31st, and the stretch the lender actually bills for
  // ends on the 30th of September.
  const marks: string[] = []
  if (rest) {
    for (let i = 1; ; i++) {
      const d = rest.months
        ? monthEnd(addMonths(from, rest.months * i - 1))
        : addDays(from, (rest.days || 0) * i)
      if (d >= to) break
      marks.push(d)
    }
  }
  marks.push(to)
  // REPAID BEFORE MATURITY: interest stops the day the bill was cleared, so the
  // schedule ends there — no rest past it (a ₹0 "Due" December on B4, cleared
  // 23-11), and the rest it falls in runs to that day.
  if (String(bd.status || '') === 'repaid') {
    const lastRepay = String(
      (await getClient().execute({ sql: 'SELECT MAX(repay_date) AS d FROM bd_repayments WHERE bd_id = ?', args: [n(bdId)] })).rows[0]?.d || bd.repaid_date || ''
    ).slice(0, 10)
    if (lastRepay && lastRepay < to && lastRepay >= from) {
      const kept = marks.filter((m) => m < lastRepay)
      marks.length = 0
      marks.push(...kept, lastRepay)
    }
  }

  const daysYear = n(bd.days_year) || 360
  const rate = n(bd.interest_pct)
  const paid = await listBdInterestPayments(bdId)
  if (!paid.length) {
    const withRepay = await bdInterestWithRepayments(bd, from, to, rate, daysYear)
    if (withRepay) return withRepay
  }
  // Principal paid back inside the tenor makes every later day cheaper. A bill
  // funded in legs keeps the flat schedule — its principal grows, not shrinks.
  const steps = n(bd.first_receipt_part) > 0.005 ? [] : (await principalRepaidByDate(bdId)).filter((x) => x.date < to)
  const reducing = steps.length > 0
  // EVERY STRETCH PAID — interest payments AND interest paid with a repayment
  // (bdPaidStretches) — matched to a rest by the days it covers, not only by
  // ending on the rest's last day: PAY/1603 ran to 24-11 and left November
  // reading "Due"; the ₹15,284 paid with B4's repayment was not linked at all.
  const stretches = await bdPaidStretches(n(bdId), bd)
  // Interest paid with a repayment on days ALREADY paid — counted twice.
  const repInt = toPlain(
    await getClient().execute({
      sql: 'SELECT id, repay_date, interest, tds_amount FROM bd_repayments WHERE bd_id = ? AND COALESCE(interest, 0) > 0.004',
      args: [n(bdId)]
    })
  )
  const extra = repInt.filter((r) => !stretches.some((s) => s.via_repayment && String(s.to_date) === String(r.repay_date).slice(0, 10)))
  // Paid-twice interest set against another bill of the NBFC leaves this one.
  const movedOut = await bdAdjustmentsOutOf(n(bdId))
  const movedOf = (repId: number): Row[] => movedOut.filter((m) => n(m.repayment_id) === n(repId))
  const lastMark = marks[marks.length - 1]
  const out: Row[] = []
  let start = from
  let charged = 0
  marks.forEach((end, i) => {
    const last = i === marks.length - 1
    // Same convention the bill itself is priced on: the receipt day counts
    // only where the NBFC's terms say it does, and only on the first slice —
    // every later one starts the morning after the previous ended.
    const days = Math.max(0, daysBetween(start, end) + (i === 0 && bd.days_incl_start ? 1 : 0))
    const firstDay = i === 0 && bd.days_incl_start ? start : addDays(start, 1)
    const split = bdInterestParts(calc.interestBase, steps, firstDay, end, rate, daysYear)
    // With nothing repaid early the last slice stays the plug, so the schedule
    // adds up to exactly what the bill would have been charged in one go.
    const gross = reducing
      ? split.gross
      : last
        ? round2(calc.interestAmount - charged)
        : round2((calc.interestBase * rate * days) / (100 * daysYear))
    if (!reducing && split.parts.length === 1) split.parts[0].interest = gross
    charged = round2(charged + gross)
    const tds = round2((gross * n(bd.tds_pct)) / 100)
    // A payment already made is matched to its slice by the day it covers to,
    // so a schedule regenerated after an edit still knows what has been paid.
    // Every paid stretch ending inside this rest counts towards it; the rest is
    // paid once the stretches reach its last day.
    const lo = i === 0 ? '0000-00-00' : start
    // The last rest also takes a stretch paid past it (B4 cleared 23-11, paid to 24-11).
    const hi = end === lastMark ? '9999-12-31' : end
    const onRest = stretches.filter((p) => String(p.to_date).slice(0, 10) > lo && String(p.to_date).slice(0, 10) <= hi)
    const reach = onRest.reduce((m, p) => (String(p.to_date).slice(0, 10) > m ? String(p.to_date).slice(0, 10) : m), '')
    const fully = !!reach && (reach >= end || stretches.some((p) => String(p.to_date).slice(0, 10) >= end && String(p.from_date).slice(0, 10) <= end))
    const lead = onRest.find((p) => String(p.to_date).slice(0, 10) === reach) || onRest[onRest.length - 1]
    const done = fully ? (paid.find((p) => String(p.to_date).slice(0, 10) === reach) as Row | undefined) || ({ ...lead, id: -1, journal_entry_id: 1 } as Row) : undefined
    // Paid twice: a repayment's interest on days this rest's payments already cover.
    const twice = extra.filter((r) => String(r.repay_date).slice(0, 10) > lo && String(r.repay_date).slice(0, 10) <= (end === lastMark ? '9999-12-31' : end))
    const movedGross = round2(twice.reduce((t, r) => t + movedOf(n(r.id)).reduce((s, m) => s + n(m.gross), 0), 0))
    const movedNet = round2(twice.reduce((t, r) => t + movedOf(n(r.id)).reduce((s, m) => s + n(m.net), 0), 0))
    const twiceGross = round2(twice.reduce((t, r) => t + n(r.interest) + n(r.tds_amount), 0) - movedGross)
    const paidGross = round2(onRest.reduce((t, p) => t + n(p.gross), 0) + twiceGross)
    const paidNet = round2(onRest.reduce((t, p) => t + n(p.net), 0) + twice.reduce((t, r) => t + n(r.interest), 0) - movedNet)
    out.push({
      seq: i + 1,
      // THE DAY AFTER THE LAST ONE ENDED, which is what the payment screen
      // already records (see bdInterestWindow) and what the day count above
      // has always meant. Shown as the boundary itself, every period appeared
      // to start on the day the one before it finished — two stretches laying
      // claim to the same date, on a schedule whose whole job is that each day
      // is charged once.
      from_date: i === 0 ? start : addDays(start, 1),
      to_date: end,
      days,
      gross,
      tds,
      net: round2(gross - tds),
      last,
      paid_id: done ? n(done.id) : null,
      paid_date: done ? String(done.paid_date).slice(0, 10) : null,
      paid_gross: paidGross,
      paid_net: paidNet,
      // Interest also paid with a repayment on days already paid — shown so it is checked.
      paid_twice: twiceGross > 0.004 ? { gross: twiceGross, dates: twice.map((r) => String(r.repay_date).slice(0, 10)) } : null,
      // The paid stretches that make up this rest — payments and repayments.
      // The one paid twice is listed too, so the screen can show where the extra came from.
      paid_by: [
        ...onRest.map((p) => ({
          from: String(p.from_date).slice(0, 10),
          to: String(p.to_date).slice(0, 10),
          paid_on: String(p.paid_date || p.to_date).slice(0, 10),
          gross: n(p.gross),
          net: n(p.net),
          with_repayment: !!p.via_repayment,
          adjusted_from: p.via_adjust ? p.adjusted_from : null,
          adjust_id: p.via_adjust ? n(p.adjust_id) : null,
          twice: false
        })),
        ...twice.map((r) => {
          const mv = movedOf(n(r.id))
          const g = round2(n(r.interest) + n(r.tds_amount))
          const moved = round2(mv.reduce((t, m) => t + n(m.gross), 0))
          return {
            from: null,
            to: null,
            paid_on: String(r.repay_date).slice(0, 10),
            gross: g,
            net: n(r.interest),
            with_repayment: true,
            // Still paid twice once what was set against other bills is taken off.
            twice: g - moved > 0.5,
            moved_to: mv.map((m) => ({ id: n(m.id), bd_no: m.to_bd_no, gross: n(m.gross) }))
          }
        })
      ],
      // Whether a payment recorded against this slice actually reached the
      // ledger. A slice can be serviced without being posted, when the desk
      // chose to record it and post later — see payBdInterest's `post` flag.
      posted: done ? !!done.journal_entry_id : false,
      // Day stretches at each principal balance — the row's breakdown.
      parts: split.parts,
      reducing
    })
    start = end
  })
  return out
}

/**
 * INTEREST PAID WITH EACH REPAYMENT (Vanik's way).
 *
 * Some NBFCs take no monthly interest: every repayment carries the interest on
 * the whole outstanding up to and INCLUDING that day, and the repaid principal
 * stops costing from the day after. The bill is then serviced repayment by
 * repayment, not month by month. Recognised by what was entered — repayments
 * carrying interest and no separate interest payment — so no setting is
 * needed and nothing stored changes.
 *
 * The interest on a repayment is what the NBFC was paid, net of TDS; the TDS
 * is the one on the repayment, or worked off the gross (net x % / (100 - %))
 * for one entered before TDS was asked.
 *
 * One row per repayment day, due worked on the balance before that day's
 * repayment; a bill still open gets a last unpaid row to maturity. An NBFC can
 * spread the same total differently across repayments (V1 charged each part
 * from the receipt), so the rows are compared in total, not one by one.
 */
async function bdInterestWithRepayments(bd: Row, from: string, to: string, rate: number, daysYear: number): Promise<Row[] | null> {
  const r = await getClient().execute({
    sql: `SELECT substr(repay_date, 1, 10) AS d, COALESCE(SUM(amount), 0) AS amt,
                 COALESCE(SUM(interest), 0) AS net,
                 SUM(CASE WHEN COALESCE(interest, 0) > 0 AND tds_amount IS NULL THEN interest ELSE 0 END) AS net_no_tds,
                 COALESCE(SUM(tds_amount), 0) AS tds
            FROM bd_repayments WHERE bd_id = ? GROUP BY substr(repay_date, 1, 10) ORDER BY d`,
    args: [n(bd.id)]
  })
  const days = r.rows as unknown as Row[]
  if (!days.some((x) => n(x.net) > 0.004)) return null
  const pct = n(bd.tds_pct)
  const tdsOn = (net: number): number => (pct > 0 && pct < 100 ? round2((net * pct) / (100 - pct)) : 0)
  let balance = round2(n(bdCalc(bd).interestBase))
  let start = bd.days_incl_start ? from : addDays(from, 1)
  const out: Row[] = []
  const slice = (end: string, principal: number, paidNet: number, paidTds: number, repayDay: boolean): void => {
    const d = Math.max(0, daysBetween(start, end) + 1)
    const gross = round2((principal * rate * d) / (100 * daysYear))
    const paidGross = round2(paidNet + paidTds)
    out.push({
      seq: out.length + 1,
      from_date: start,
      to_date: end,
      days: d,
      gross,
      tds: round2((gross * pct) / 100),
      net: round2(gross - (gross * pct) / 100),
      last: false,
      paid_id: paidNet > 0.004 ? -1 : null,
      paid_date: paidNet > 0.004 ? end : null,
      paid_gross: paidGross,
      paid_net: round2(paidNet),
      paid_tds: round2(paidTds),
      posted: paidNet > 0.004,
      parts: [{ from_date: start, to_date: end, days: d, principal, interest: gross }],
      reducing: true,
      mode: 'with_repayment',
      repay_day: repayDay
    })
  }
  for (const x of days) {
    const d = String(x.d)
    if (d < start) continue
    const paidTds = round2(n(x.tds) + tdsOn(n(x.net_no_tds)))
    slice(d, balance, n(x.net), paidTds, true)
    balance = Math.max(0, round2(balance - n(x.amt)))
    start = addDays(d, 1)
  }
  if (balance > 0.004 && to >= start) slice(to, balance, 0, 0, false)
  if (out.length) out[out.length - 1].last = true
  return out
}

/** Interest already serviced on one bill, oldest first. */
export async function listBdInterestPayments(bdId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT p.*, je.vch_no FROM bd_interest_payments p
          LEFT JOIN journal_entries je ON je.id = p.journal_entry_id
          WHERE p.bd_id = ? ORDER BY p.to_date, p.id`,
    args: [n(bdId)]
  })
  return toPlain(res)
}

/**
 * Pay one rest's interest, and post it.
 *
 * The voucher is the upfront-interest one, per slice: the expense is ours, the
 * TDS is withheld and owed to the department, and the bank pays the difference.
 * It balances on its own, and the slices together come to exactly the interest
 * the bill would have been charged in one go.
 */
/* -------------------------------------------------------------------------- */
/* Interest paid up to a date the payer chooses                               */
/* -------------------------------------------------------------------------- */

/**
 * INTEREST HAS A WINDOW, AND THE WINDOW IS NOT A FREE CHOICE.
 *
 * Interest runs day by day from the moment the NBFC's money lands. Paying it
 * is therefore always "settle everything up to this date" — never "pay for a
 * date". Which means exactly one stretch of days is ever payable:
 *
 *   from  the day after the last interest payment ran to,
 *         or the receipt date itself the first time
 *   to    any day the payer picks, up to and including today
 *
 * The floor stops the same days being charged twice; the ceiling stops
 * interest being paid for days that have not happened. Both are refused here
 * as well as greyed out on the form, because a date can arrive from a stale
 * screen and only this side is the record.
 */
// The first day a bill's interest accrues: the receipt day itself only when the
// terms count it (days_incl_start), else the day after.
/**
 * EVERY STRETCH OF INTEREST PAID ON A BILL — the cumulative / per-bill interest
 * payments, AND the interest paid inside a repayment (Repay → "Paying the
 * interest with this repayment?"). The latter lives only on bd_repayments, so
 * Pay cumulative interest offered the same days again. A repayment's interest
 * covers from the first day not yet paid up to its repay date; gross = what was
 * paid (net) + its TDS.
 */
async function bdPaidStretches(bdId: number, bd: Row): Promise<Row[]> {
  const c = getClient()
  const paid = toPlain(
    await c.execute({ sql: 'SELECT from_date, to_date, gross, tds, net, paid_date FROM bd_interest_payments WHERE bd_id = ? ORDER BY from_date', args: [n(bdId)] })
  )
  const reps = toPlain(
    await c
      .execute({
        sql: 'SELECT repay_date, interest, tds_amount FROM bd_repayments WHERE bd_id = ? AND COALESCE(interest, 0) > 0.004 ORDER BY repay_date, id',
        args: [n(bdId)]
      })
      .catch(() => ({ rows: [] }) as never)
  )
  const received = String(bd.payment_received_date || '').slice(0, 10)
  const A = received ? accrualStart(bd, received) : '0000-00-00'
  const out = [...paid]
  for (const r of reps) {
    const on = String(r.repay_date || '').slice(0, 10)
    if (!on) continue
    const from = firstUnpaid(out, A).from
    if (from > on) continue
    const net = round2(n(r.interest))
    const tds =
      r.tds_amount != null && String(r.tds_amount) !== ''
        ? round2(n(r.tds_amount))
        : n(bd.tds_pct) > 0 && n(bd.tds_pct) < 100
          ? round2((net * n(bd.tds_pct)) / (100 - n(bd.tds_pct)))
          : 0
    out.push({ from_date: from, to_date: on, gross: round2(net + tds), tds, net, paid_date: on, via_repayment: 1 })
  }
  // INTEREST SET OVER FROM ANOTHER BILL (bd_interest_adjustments): counts on
  // the paid stretch it was set against, as if paid with it — it covers no days
  // of its own, so a stretch it cannot find is left out.
  for (const a of await bdAdjustmentsInto(n(bdId))) {
    const on = String(a.on_date).slice(0, 10)
    const host = out.find((p) => !p.via_adjust && String(p.from_date).slice(0, 10) <= on && on <= String(p.to_date).slice(0, 10))
    if (!host) continue
    out.push({ from_date: host.from_date, to_date: host.to_date, gross: n(a.gross), tds: n(a.tds), net: n(a.net), paid_date: on, via_adjust: 1, adjust_id: n(a.id), adjusted_from: a.from_bd_no })
  }
  return out.sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)))
}

/* -------------------------------------------------------------------------- */
/* Interest paid twice on one bill, set against another bill of the NBFC     */
/* -------------------------------------------------------------------------- */
// B4's ₹1.5 Cr repayment (23-11) carried ₹15,284 interest on days PAY/1603
// had already paid — while B5, under the same NBFC, was ₹21,028.63 short on
// those very days. The money is the NBFC's either way; this records which
// bill it is counted against. Record only: no voucher changes.
async function ensureBdAdjust(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS bd_interest_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repayment_id INTEGER NOT NULL,
    from_bd_id INTEGER NOT NULL,
    to_bd_id INTEGER NOT NULL,
    on_date TEXT NOT NULL,
    gross REAL NOT NULL DEFAULT 0,
    tds REAL NOT NULL DEFAULT 0,
    net REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`)
}

async function bdAdjustmentsInto(bdId: number): Promise<Row[]> {
  await ensureBdAdjust()
  return toPlain(
    await getClient().execute({
      sql: `SELECT a.*, b.bd_no AS from_bd_no FROM bd_interest_adjustments a JOIN bill_discountings b ON b.id = a.from_bd_id WHERE a.to_bd_id = ? ORDER BY a.id`,
      args: [n(bdId)]
    })
  )
}

async function bdAdjustmentsOutOf(bdId: number): Promise<Row[]> {
  await ensureBdAdjust()
  return toPlain(
    await getClient().execute({
      sql: `SELECT a.*, b.bd_no AS to_bd_no FROM bd_interest_adjustments a JOIN bill_discountings b ON b.id = a.to_bd_id WHERE a.from_bd_id = ? ORDER BY a.id`,
      args: [n(bdId)]
    })
  )
}

/**
 * Interest paid with a bill's repayments on days already paid, not yet set
 * against another bill — and the bills of the same NBFC still short on that
 * day, with what each would take (oldest bill first). Read only.
 */
export async function bdExcessInterest(bdId: number): Promise<Row[]> {
  const c = getClient()
  const bd = await loadBd(bdId)
  const stretches = await bdPaidStretches(n(bdId), bd)
  const reps = toPlain(
    await c.execute({
      sql: 'SELECT id, repay_date, interest, tds_amount FROM bd_repayments WHERE bd_id = ? AND COALESCE(interest, 0) > 0.004 ORDER BY repay_date, id',
      args: [n(bdId)]
    })
  )
  const moved = await bdAdjustmentsOutOf(n(bdId))
  const out: Row[] = []
  for (const r of reps) {
    const on = String(r.repay_date).slice(0, 10)
    // A repayment that paid new days is a stretch of its own, not paid twice.
    if (stretches.some((s) => s.via_repayment && String(s.to_date).slice(0, 10) === on)) continue
    const gross = round2(n(r.interest) + n(r.tds_amount))
    const left = round2(gross - moved.filter((m) => n(m.repayment_id) === n(r.id)).reduce((t, m) => t + n(m.gross), 0))
    if (left <= 0.5) continue
    const sibs = toPlain(
      await c.execute({
        sql: 'SELECT id, bd_no FROM bill_discountings WHERE company_id = ? AND nbfc_id = ? AND id <> ? ORDER BY id',
        args: [n(bd.company_id), n(bd.nbfc_id), n(bdId)]
      })
    )
    let room = left
    const targets: Row[] = []
    for (const s of sibs) {
      for (const rest of await bdInterestSchedule(n(s.id))) {
        if (!(String(rest.from_date) <= on && on <= String(rest.to_date))) continue
        // Only a rest already paid short has a payment to set it against.
        if (!rest.paid_id) continue
        const short = round2(n(rest.gross) - n(rest.paid_gross))
        if (short <= 0.5) continue
        const take = round2(Math.min(room, short))
        targets.push({ bd_id: n(s.id), bd_no: s.bd_no, from_date: rest.from_date, to_date: rest.to_date, short, take })
        room = round2(room - take)
      }
      if (room <= 0.5) break
    }
    out.push({ repayment_id: n(r.id), bd_id: n(bdId), bd_no: bd.bd_no, on_date: on, gross, tds: n(r.tds_amount), excess: left, targets, unplaced: round2(Math.max(0, room)) })
  }
  return out
}

/** Set a bill's paid-twice repayment interest against its NBFC's short bills, as bdExcessInterest proposes. */
export async function adjustBdExcessInterest(bdId: number): Promise<{ adjusted: number; gross: number }> {
  await ensureBdAdjust()
  const c = getClient()
  let adjusted = 0
  let total = 0
  for (const x of await bdExcessInterest(bdId)) {
    const ratio = n(x.gross) > 0 ? n(x.tds) / n(x.gross) : 0
    for (const t of (x.targets as Row[]) || []) {
      const gross = n(t.take)
      if (gross <= 0.004) continue
      const tds = round2(gross * ratio)
      await c.execute({
        sql: 'INSERT INTO bd_interest_adjustments (repayment_id, from_bd_id, to_bd_id, on_date, gross, tds, net) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [n(x.repayment_id), n(bdId), n(t.bd_id), String(x.on_date), gross, tds, round2(gross - tds)]
      })
      adjusted++
      total = round2(total + gross)
    }
  }
  return { adjusted, gross: total }
}

/** Take an adjustment back — the interest counts on the bill it was paid with again. */
export async function removeBdInterestAdjustment(id: number): Promise<void> {
  await ensureBdAdjust()
  await getClient().execute({ sql: 'DELETE FROM bd_interest_adjustments WHERE id = ?', args: [n(id)] })
}

/** Every bill's paid-twice repayment interest set against its NBFC's short bills (one-time startup pass). */
export async function adjustAllBdExcessInterest(): Promise<string[]> {
  const ids = toPlain(
    await getClient().execute('SELECT DISTINCT bd_id FROM bd_repayments WHERE COALESCE(interest, 0) > 0.004 ORDER BY bd_id')
  ).map((r) => n(r.bd_id))
  const done: string[] = []
  for (const id of ids) {
    const r = await adjustBdExcessInterest(id)
    if (r.adjusted) done.push(`bill ${id}: ${r.adjusted} (${r.gross})`)
  }
  return done
}

function accrualStart(bd: Row, received: string): string {
  return bd.days_incl_start ? received : addDays(received, 1)
}

// The first day not covered by any interest payment, from `start` on, and the
// day the next paid stretch begins after it (null when nothing is paid later).
function firstUnpaid(paid: Row[], start: string): { from: string; next: string | null } {
  let cur = start
  const spans = paid
    .map((p) => ({ from: String(p.from_date || '').slice(0, 10), to: String(p.to_date || '').slice(0, 10) }))
    .filter((p) => p.to)
    .sort((a, b) => a.from.localeCompare(b.from))
  for (const sp of spans) {
    const f = sp.from > start ? sp.from : start
    if (f > cur) return { from: cur, next: f }
    if (sp.to >= cur) cur = addDays(sp.to, 1)
  }
  return { from: cur, next: null }
}

/**
 * The interest on ONE stretch of a bill, chosen by the desk (Pay cumulative
 * interest) — paid whatever comes before it. Refused where any of its days is
 * already paid; says when days before it are still unpaid.
 */
// The last day interest may be worked to: today — or, asked for, the end of
// this month (Pay cumulative interest → Till month end).
function interestCap(monthEnd?: boolean): string {
  const t = todayISO()
  if (!monthEnd) return t
  const d = new Date(`${t.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

export async function bdInterestRange(bdId: number, fromIn: string, toIn: string, tillMonthEnd = false): Promise<Row> {
  const bd = await loadBd(bdId)
  const calc = bdCalc(bd)
  const received = String(bd.payment_received_date || '').slice(0, 10)
  const mode = String(bd.interest_mode || '') || (bd.interest_upfront ? 'upfront' : 'discounted')
  const today = interestCap(tillMonthEnd)
  const to = (String(toIn).slice(0, 10) > today ? today : String(toIn).slice(0, 10))
  const paid = await bdPaidStretches(n(bdId), bd)
  const daysYear = n(bd.days_year) || 360
  const out: Row = { bd_id: n(bdId), interest_base: calc.interestBase, open_amount: calc.openAmount, interest_pct: n(bd.interest_pct), tds_pct: n(bd.tds_pct), days_year: daysYear, to_date: to, parts: [], gross: 0, tds: 0, net: 0, days: 0 }
  if (!received) return { ...out, from_date: fromIn, blocked: 'This bill is not funded yet.' }
  if (mode === 'discounted') return { ...out, from_date: fromIn, blocked: 'Interest was taken out when the bill was funded.' }
  const A = accrualStart(bd, received)
  let from = String(fromIn).slice(0, 10) < A ? A : String(fromIn).slice(0, 10)
  // A REPAYMENT THAT PAID THE INTEREST covers the start of the period (B7
  // repaid 24-11 with its interest): the period runs on from the day after,
  // so the month's last days can still be paid, rather than the whole month
  // being refused as already paid.
  for (let moved = true; moved; ) {
    moved = false
    for (const p of paid) {
      const pf = String(p.from_date || '').slice(0, 10)
      const pt = String(p.to_date || '').slice(0, 10)
      if (p.via_repayment && pf <= from && pt >= from && pt < to) {
        from = addDays(pt, 1)
        moved = true
      }
    }
  }
  out.from_date = from
  if (from > to) return { ...out, blocked: received > to ? 'Funded after this period.' : 'Nothing in this period.' }
  const steps = n(bd.first_receipt_part) > 0.005 ? [] : await principalRepaidByDate(bdId)
  const worked = (f: string, t: string): { parts: Row[]; gross: number; days: number } => {
    const split = bdInterestParts(calc.interestBase, steps, f, t, n(bd.interest_pct), daysYear)
    const days = daysBetween(f, t) + 1
    return { parts: split.parts, days, gross: steps.length ? split.gross : round2((calc.interestBase * n(bd.interest_pct) * days) / (100 * daysYear)) }
  }
  // PAID SHORT LEAVES A BALANCE. Each paid stretch (all its payments together)
  // against what that stretch works out to — worked out live, nothing stored.
  const spans = shortSpans(paid, A, worked)
  out.short_before = spans.filter((s) => s.to < from && s.short > 1)
  // Already paid inside the range? Then it cannot be paid again — except the
  // very same stretch picked again while it was paid short: then its balance.
  for (const s of spans) {
    if (!(s.from <= to && s.to >= from)) continue
    if (s.from === from && s.to === to && s.short > 1) {
      const w = worked(from, to)
      const tds = round2((s.short * n(bd.tds_pct)) / 100)
      return { ...out, to_date: to, parts: w.parts, days: w.days, gross: s.short, tds, net: round2(s.short - tds), balance_of: { from: s.from, to: s.to, due: s.due, paid: s.paid }, short_before: out.short_before, blocked: '' }
    }
    // PAID SHORT, AND NOTHING AFTER IT IN THE RANGE: the balance is what this
    // range still owes, so it is offered straight away (B5 November: paid to
    // 24-11, repaid that day, ₹4,046.41 short — it read "PAID" with nothing in
    // Worked out / Actual paid).
    const repaidOn = String(bd.status) === 'repaid' ? String(bd.repaid_date || '').slice(0, 10) : ''
    const endEff = repaidOn && repaidOn < to ? repaidOn : to
    if (s.short > 1 && s.from >= from && s.to >= endEff) {
      const w = worked(s.from, s.to)
      const tds = round2((s.short * n(bd.tds_pct)) / 100)
      return { ...out, from_date: s.from, to_date: s.to, parts: w.parts, days: w.days, gross: s.short, tds, net: round2(s.short - tds), balance_of: { from: s.from, to: s.to, due: s.due, paid: s.paid }, short_before: out.short_before, blocked: '' }
    }
    const bal = spans.filter((x) => x.short > 1 && x.from <= to && x.to >= from)
    return { ...out, blocked: `Already paid ${s.from} → ${s.to}.` + (bal.length ? ` Balance ${inr(bal[0].short)} due — pick ${bal[0].from} → ${bal[0].to} alone to pay it.` : ''), paid_to: s.to }
  }
  // Days before the range still unpaid — overdue, said, but not in the way.
  const g = firstUnpaid(paid, A)
  if (g.from < from) out.unpaid_before = { from: g.from, to: addDays(from, -1) }
  const w = worked(from, to)
  const gross = w.gross
  const tds = round2((gross * n(bd.tds_pct)) / 100)
  return { ...out, parts: w.parts, days: w.days, gross, tds, net: round2(gross - tds), blocked: gross > 0.004 ? '' : 'Nothing has accrued.' }
}

// Paid stretches of a bill, the payments on the same days added together, each
// against what those days work out to: `short` is what is still to pay on it.
function shortSpans(
  paid: Row[],
  A: string,
  worked: (f: string, t: string) => { gross: number }
): { from: string; to: string; due: number; paid: number; short: number }[] {
  const m = new Map<string, { from: string; to: string; paid: number }>()
  for (const p of paid) {
    const f = String(p.from_date || '').slice(0, 10) < A ? A : String(p.from_date || '').slice(0, 10)
    const t = String(p.to_date || '').slice(0, 10)
    if (!t) continue
    const k = `${f}|${t}`
    const s = m.get(k) || { from: f, to: t, paid: 0 }
    s.paid = round2(s.paid + n(p.gross))
    m.set(k, s)
  }
  return Array.from(m.values())
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((s) => {
      const due = s.from <= s.to ? worked(s.from, s.to).gross : 0
      return { ...s, due, short: round2(Math.max(0, due - s.paid)) }
    })
}

/**
 * EDIT A CUMULATIVE INTEREST PAYMENT (Payments made → Edit). What was paid on
 * each bill, the date, the bank, the TDS ledger and the note — the voucher is
 * re-posted in place (same id, same PAY number), so every bill stays linked.
 */
export async function editBdCumulativePayment(v: {
  entry_id: number
  paid_date?: string
  bank_account?: string | null
  tds_ledger?: string | null
  note?: string | null
  // gross interest paid, keyed by the bd_interest_payments row id
  amounts?: Record<string, number | string>
  // Book through the NBFC (journal + payment) or as one payment; left out, as it was.
  via_nbfc?: boolean
}): Promise<{ entry_id: number; gross: number; tds: number; net: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const eid = n(v.entry_id)
    const rows = toPlain(
      await c.execute({
        sql: `SELECT p.*, b.bd_no, b.tds_pct, b.company_id, b.nbfc_id FROM bd_interest_payments p JOIN bill_discountings b ON b.id = p.bd_id
               WHERE p.journal_entry_id = ? ORDER BY p.id`,
        args: [eid]
      })
    )
    if (!rows.length) throw new Error('That payment no longer exists')
    const date = String(v.paid_date || rows[0].paid_date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the payment date')
    if (date > todayISO()) throw new Error('The payment cannot be dated in the future')
    const note = String(v.note ?? '').trim()
    if (v.note !== undefined && !note) throw new Error('Write a note — it goes into the voucher narration')
    // The ledgers the vouchers carry today, kept unless changed: the bank on the
    // payment, the TDS on the journal when booked through the NBFC.
    const linesOf = async (id: number): Promise<Row[]> =>
      toPlain(
        await c.execute({
          sql: `SELECT a.name, a.acc_group, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.id`,
          args: [id]
        })
      )
    const journalId = n(rows[0].interest_entry_id) || null
    const payLines = await linesOf(eid)
    const oldBank = String((payLines.find((l) => n(l.cr) > 0 && /bank/i.test(String(l.acc_group || ''))) || {}).name || rows[0].bank_account || '')
    const tdsLines = journalId ? await linesOf(journalId) : payLines
    const firstBd = await loadBd(n(rows[0].bd_id))
    // The TDS line: credited, not the bank, not the NBFC's own ledger (whatever group it sits in).
    const nbfcLedger = bdPayable(firstBd).toUpperCase()
    const oldTds = tdsLines.find((l) => n(l.cr) > 0 && !/bank/i.test(String(l.acc_group || '')) && String(l.name || '').toUpperCase() !== nbfcLedger)
    const bank = String(v.bank_account || '').trim() || oldBank
    if (!bank) throw new Error('Pick the bank the interest was paid from')
    const tdsLedger = String(v.tds_ledger || '').trim() || String(oldTds?.name || 'TDS ON INTEREST PAYABLE A/C')
    const tdsGroup = String(
      ((await c.execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?', args: [tdsLedger] })).rows[0] as Row | undefined)?.acc_group || 'Duties & Taxes'
    )
    const upd = rows.map((r) => {
      const typed = v.amounts && String(v.amounts[String(r.id)] ?? '').trim() !== '' ? round2(n(v.amounts[String(r.id)])) : n(r.gross)
      if (!(typed > 0.004)) throw new Error(`${r.bd_no}: the interest paid must be more than nil — delete the payment instead`)
      const tds = round2((typed * n(r.tds_pct)) / 100)
      return { r, gross: typed, tds, net: round2(typed - tds) }
    })
    const gross = round2(upd.reduce((t, x) => t + x.gross, 0))
    const tds = round2(upd.reduce((t, x) => t + x.tds, 0))
    const net = round2(gross - tds)
    const nos = rows.map((r) => String(r.bd_no)).join(', ')
    const to = String(rows.map((r) => String(r.to_date).slice(0, 10)).sort().pop() || '')
    const posted = await postCumulativeVouchers({
      via_nbfc: v.via_nbfc == null ? !!journalId : !!v.via_nbfc,
      date,
      to,
      first: firstBd,
      nos,
      count: rows.length,
      gross,
      tds,
      net,
      bank,
      tdsLedger,
      tdsGroup,
      note,
      ids: { payment: eid, journal: journalId }
    })
    for (const x of upd) {
      await c.execute({
        sql: 'UPDATE bd_interest_payments SET gross = ?, tds = ?, net = ?, paid_date = ?, bank_account = ?, interest_entry_id = ? WHERE id = ?',
        args: [x.gross, x.tds, x.net, date, bank, posted.journal, n(x.r.id)]
      })
    }
    return { entry_id: eid, gross, tds, net }
  })
}

/**
 * CONVERT OLD INTEREST PAYMENTS — one payment voucher ⇄ via the NBFC (journal +
 * payment). Each payment keeps its amounts, date, bank, TDS ledger, PAY number
 * and the note in its narration; only how it is booked changes. One at a time,
 * each in its own transaction, so one refusal does not stop the rest.
 */
export async function convertBdInterestPayments(entryIds: number[], viaNbfc: boolean): Promise<{ converted: number; skipped: number; failed: string[] }> {
  let converted = 0
  let skipped = 0
  const failed: string[] = []
  for (const eid of [...new Set((entryIds || []).map(n).filter((x) => x > 0))]) {
    const row = (
      await getClient().execute({
        sql: `SELECT p.interest_entry_id, je.narration, je.vch_no FROM bd_interest_payments p JOIN journal_entries je ON je.id = p.journal_entry_id WHERE p.journal_entry_id = ? LIMIT 1`,
        args: [eid]
      })
    ).rows[0] as unknown as Row | undefined
    if (!row) {
      skipped++
      continue
    }
    if (!!n(row.interest_entry_id) === viaNbfc) {
      skipped++
      continue
    }
    const narr = String(row.narration || '')
    const tail = narr.includes(' · ') ? narr.slice(narr.lastIndexOf(' · ') + 3).trim() : ''
    try {
      await editBdCumulativePayment({ entry_id: eid, via_nbfc: viaNbfc, ...(tail ? { note: tail } : {}) })
      converted++
    } catch (e) {
      failed.push(`${String(row.vch_no || eid)}: ${(e as Error).message}`)
    }
  }
  return { converted, skipped, failed }
}

/**
 * PAYMENTS MADE through Pay cumulative interest (the window's second tab): one
 * group per voucher, each bill on it against what was due on its days when it
 * was paid — the worked-out interest less anything paid on those same days
 * before it. Paid less is a shortfall, paid more an excess. Worked out live.
 */
export async function listBdCumulativePayments(nbfcId?: number | null): Promise<Row[]> {
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT p.*, b.bd_no, b.nbfc_id, nb.name AS nbfc_name, je.vch_no, je.narration,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = p.journal_entry_id) AS pay_code,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = p.interest_entry_id) AS journal_code
              FROM bd_interest_payments p
              JOIN bill_discountings b ON b.id = p.bd_id
              LEFT JOIN nbfcs nb ON nb.id = b.nbfc_id
              LEFT JOIN journal_entries je ON je.id = p.journal_entry_id
             WHERE b.company_id = ? AND p.journal_entry_id IS NOT NULL
               AND (? IS NULL OR b.nbfc_id = ?)
             ORDER BY p.paid_date DESC, p.journal_entry_id DESC, p.id`,
      args: [getActiveCompanyId(), nbfcId ? n(nbfcId) : null, nbfcId ? n(nbfcId) : null]
    })
  )
  // What each bill's days work out to, and every payment on the bill (for "paid before").
  const worker = new Map<number, { A: string; worked: (f: string, t: string) => number; paid: Row[] }>()
  for (const id of [...new Set(rows.map((r) => n(r.bd_id)))]) {
    const bd = await loadBd(id)
    const received = String(bd.payment_received_date || '').slice(0, 10)
    const calc = bdCalc(bd)
    const daysYear = n(bd.days_year) || 360
    const steps = n(bd.first_receipt_part) > 0.005 ? [] : await principalRepaidByDate(id)
    const paid = toPlain(
      await getClient().execute({
        sql: `SELECT p.id, p.from_date, p.to_date, p.gross, p.paid_date, je.vch_no FROM bd_interest_payments p
               LEFT JOIN journal_entries je ON je.id = p.journal_entry_id WHERE p.bd_id = ?`,
        args: [id]
      })
    )
    worker.set(id, {
      A: received ? accrualStart(bd, received) : '',
      paid,
      worked: (f, t) => {
        const days = daysBetween(f, t) + 1
        return steps.length ? bdInterestParts(calc.interestBase, steps, f, t, n(bd.interest_pct), daysYear).gross : round2((calc.interestBase * n(bd.interest_pct) * days) / (100 * daysYear))
      }
    })
  }
  const groups = new Map<number, Row>()
  for (const r of rows) {
    const w = worker.get(n(r.bd_id))!
    const clamp = (d: unknown): string => (String(d || '').slice(0, 10) < w.A ? w.A : String(d || '').slice(0, 10))
    const f = clamp(r.from_date)
    const t = String(r.to_date || '').slice(0, 10)
    const due = f <= t ? w.worked(f, t) : 0
    const onSpan = w.paid.filter((p) => clamp(p.from_date) === f && String(p.to_date).slice(0, 10) === t)
    const before = round2(onSpan.filter((p) => n(p.id) < n(r.id)).reduce((s, p) => s + n(p.gross), 0))
    const expected = round2(Math.max(0, due - before))
    // AT THE TIME: this payment against what was still due then.
    const paidDiff = round2(n(r.gross) - expected)
    // NOW: everything paid on these days against what they work out to. Only the
    // latest payment on the days carries it; an earlier one is adjusted by the later.
    const later = onSpan.filter((p) => n(p.id) > n(r.id)).sort((a, b) => n(a.id) - n(b.id))
    const spanPaid = round2(onSpan.reduce((s, p) => s + n(p.gross), 0))
    const latest = later.length === 0
    const diff = latest ? round2(spanPaid - due) : 0
    const je = n(r.journal_entry_id)
    if (!groups.has(je)) {
      groups.set(je, {
        journal_entry_id: je,
        vch_no: r.vch_no || '',
        paid_date: String(r.paid_date || '').slice(0, 10),
        nbfc_name: r.nbfc_name || '',
        nbfc_id: n(r.nbfc_id),
        // Booked through the NBFC: its journal beside the payment.
        via_nbfc: !!n(r.interest_entry_id),
        pay_code: r.pay_code || '',
        journal_code: r.journal_code || '',
        bank: r.bank_account || '',
        narration: r.narration || '',
        bills: [],
        gross: 0,
        tds: 0,
        net: 0,
        expected: 0,
        diff: 0
      })
    }
    const g = groups.get(je)!
    ;(g.bills as Row[]).push({
      id: n(r.id),
      bd_id: n(r.bd_id),
      bd_no: r.bd_no,
      from_date: f,
      to_date: t,
      due,
      before,
      expected,
      gross: n(r.gross),
      tds: n(r.tds),
      net: n(r.net),
      paid_diff: paidDiff,
      diff,
      latest,
      span_paid: spanPaid,
      adjusted_by: latest ? null : later.map((p) => `${String(p.vch_no || `#${p.id}`)} of ${String(p.paid_date || '').slice(0, 10).split('-').reverse().join('-')}`).join(', '),
      balance: /^Balance/.test(String(r.note || ''))
    })
    g.gross = round2(n(g.gross) + n(r.gross))
    g.tds = round2(n(g.tds) + n(r.tds))
    g.net = round2(n(g.net) + n(r.net))
    g.expected = round2(n(g.expected) + expected)
    g.diff = round2(n(g.diff) + diff)
  }
  // INTEREST PAID WITH A REPAYMENT on days a cumulative payment covers belongs
  // with that payment: PAY/1603 paid ₹1,25,235 for B5 + B4 to 24-11, and B4's
  // ₹1.5 Cr repayment on 23-11 carried another ₹15,284 — ₹1,40,519 paid in all.
  // Shown on the payment as its own token and set against its shortfall first.
  const ids = [...worker.keys()]
  const reps = ids.length
    ? toPlain(
        await getClient().execute({
          sql: `SELECT r.id, r.bd_id, r.repay_date, r.interest, r.tds_amount, b.bd_no,
                       (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = r.journal_entry_id) AS pay_code
                  FROM bd_repayments r JOIN bill_discountings b ON b.id = r.bd_id
                 WHERE r.bd_id IN (${ids.join(',')}) AND COALESCE(r.interest, 0) > 0.004`,
          args: []
        })
      )
    : []
  for (const g of groups.values()) {
    g.reps = []
    g.rep_gross = 0
    g.rep_net = 0
  }
  for (const r of reps) {
    const d = String(r.repay_date || '').slice(0, 10)
    const g = [...groups.values()].find((x) =>
      (x.bills as Row[]).some((b) => n(b.bd_id) === n(r.bd_id) && b.latest && String(b.from_date) <= d && d <= String(b.to_date))
    )
    if (!g) continue
    const gross = round2(n(r.interest) + n(r.tds_amount))
    ;(g.reps as Row[]).push({ id: n(r.id), bd_no: r.bd_no, repay_date: d, gross, tds: n(r.tds_amount), net: n(r.interest), pay_code: r.pay_code || '' })
    g.rep_gross = round2(n(g.rep_gross) + gross)
    g.rep_net = round2(n(g.rep_net) + n(r.interest))
  }
  // The payment's standing with that money counted: shortfall first, then excess.
  for (const g of groups.values()) {
    const bills = g.bills as Row[]
    const short0 = bills.reduce((t, b) => t + Math.min(0, n(b.diff)), 0)
    const over0 = bills.reduce((t, b) => t + Math.max(0, n(b.diff)), 0)
    const left = short0 + n(g.rep_gross)
    g.short = round2(Math.min(0, left))
    g.over = round2(over0 + Math.max(0, left))
    g.diff = round2(n(g.short) + n(g.over))
  }
  return [...groups.values()]
}

export async function bdInterestWindow(
  bdId: number,
  toDate?: string
): Promise<Row> {
  const bd = await loadBd(bdId)
  const calc = bdCalc(bd)
  const received = String(bd.payment_received_date || '').slice(0, 10)
  const mode = String(bd.interest_mode || '') || (bd.interest_upfront ? 'upfront' : 'discounted')
  // Repayment interest counts as paid too (bdPaidStretches); latest first.
  const paid = (await bdPaidStretches(n(bdId), bd)).sort((a, b) => String(b.to_date).localeCompare(String(a.to_date)))
  const lastTo = paid.length ? String(paid[0].to_date).slice(0, 10) : ''
  // The first stretch may count the receipt day itself, if that is the term.
  // Every stretch after it starts the day AFTER the last one ended, so each
  // calendar day is charged once and once only.
  // A RANGE CAN BE PAID OUT OF ORDER (Pay cumulative interest: October while
  // September is still overdue), so the stretch starts at the FIRST unpaid
  // day, and stops short of the next stretch already paid.
  const g = firstUnpaid(paid, received ? accrualStart(bd, received) : '')
  const first = !!received && g.from === accrualStart(bd, received)
  const from = first ? received : g.from
  const today = todayISO()
  const ceiling = g.next ? (addDays(g.next, -1) < today ? addDays(g.next, -1) : today) : today
  // WHY THERE MAY BE NOTHING TO PAY.
  //
  // Said in words rather than left as a disabled control: a bill whose
  // interest was discounted out of the receipt has already paid it, and one
  // whose money has not landed has not started accruing.
  //
  // Two parts, because they answer two different questions and they were
  // arriving as one sentence that answered neither quickly: WHAT is the case,
  // said flatly and first, and then WHY and what to do instead. The headline
  // is also what the server throws, so a refusal reads as plainly in a toast
  // as it does on the form.
  const blocked = !received
    ? 'This bill is not funded yet.'
    : mode === 'discounted'
      ? 'Interest repayment does not apply to this bill.'
      : from > ceiling
        ? 'Interest is paid up to date.'
        : ''
  const blockedNote = !received
    ? 'Interest starts accruing the day the money lands, so there is nothing to pay until this bill is received.'
    : mode === 'discounted'
      ? 'The NBFC took its interest out of the disbursement when the bill was opened, so only the principal is left — use Full repayment.'
      : from > today
        ? `Nothing has accrued since the last payment, which ran to ${lastTo}.`
        : ''
  const to = String(toDate || ceiling).slice(0, 10)
  const inclStart = first && bd.days_incl_start ? 1 : 1
  // daysBetween counts the gap; both ends of a stretch belong to it, except on
  // the very first one where the receipt day only counts if the terms say so.
  const span = first
    ? Math.max(0, daysBetween(from, to) + (bd.days_incl_start ? 1 : 0))
    : Math.max(0, daysBetween(from, to) + 1)
  const daysYear = n(bd.days_year) || 360
  const steps = n(bd.first_receipt_part) > 0.005 ? [] : await principalRepaidByDate(bdId)
  const split = bdInterestParts(calc.interestBase, steps, first && !bd.days_incl_start ? addDays(from, 1) : from, to, n(bd.interest_pct), daysYear)
  const gross = steps.length ? split.gross : round2((calc.interestBase * n(bd.interest_pct) * span) / (100 * daysYear))
  const tds = round2((gross * n(bd.tds_pct)) / 100)
  return {
    bd_id: n(bdId),
    parts: split.parts,
    blocked,
    blocked_note: blockedNote,
    mode,
    // What the date picker may offer.
    min_date: from,
    max_date: ceiling,
    from_date: from,
    to_date: to,
    first,
    incl_start: inclStart,
    days: span,
    open_amount: calc.openAmount,
    // What the interest runs on — the Open amount, or Open + Adj. when the
    // bill charges interest after its adjustment.
    interest_base: calc.interestBase,
    interest_pct: n(bd.interest_pct),
    tds_pct: n(bd.tds_pct),
    days_year: daysYear,
    gross,
    tds,
    net: round2(gross - tds),
    // So the form can say what has already gone.
    paid_count: paid.length,
    paid_to: lastTo,
    paid_total: round2(paid.reduce((t, x) => t + n(x.gross), 0))
  }
}

/**
 * Pay the interest that has run up to a chosen date.
 *
 * The journal is the one an interest payment always is: the cost is ours, the
 * TDS is withheld on the department's behalf rather than paid to the lender,
 * and the bank goes down by the difference.
 *
 *   Dr  Interest on Bill Discounting      gross
 *       Cr  TDS on Interest Payable             tds
 *       Cr  Bank                                gross − tds
 *
 * The principal is untouched: this is the cost of the money, not the money.
 */
export async function payBdInterestUpto(
  bdId: number,
  v: { to_date: string; note?: string | null; post?: boolean; bank_account?: string | null }
): Promise<{ id: number; gross: number; tds: number; net: number; days: number; posted: boolean }> {
  return withDbTransaction(async () => {
  const to = String(v.to_date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Pick the date the interest is paid up to')
  const w = await bdInterestWindow(bdId, to)
  if (w.blocked) throw new Error(String(w.blocked))
  if (to > String(w.max_date)) throw new Error('Interest cannot be paid for days that have not happened yet')
  if (to < String(w.min_date)) {
    throw new Error(
      w.first
        ? `Interest starts on ${String(w.min_date)}, the day this bill was funded — it cannot be paid from before that`
        : `Interest is already paid to ${String(w.paid_to)} — the next payment can only start from ${String(w.min_date)}`
    )
  }
  if (!(n(w.days) > 0)) throw new Error('That is no days of interest')
  if (!(n(w.gross) > 0.004)) throw new Error('That comes to no interest at all')

  const bd = await loadBd(bdId)
  const gross = n(w.gross)
  const tds = n(w.tds)
  const net = n(w.net)
  const bank = await bdBankFor(bd, v.bank_account)
  // WHETHER THE VOUCHER GOES IN NOW, OR THE DESK SAYS NOT YET.
  //
  // Interest is a cost this bill has genuinely incurred the moment the days
  // pass — recording that it was serviced should not have to wait on the
  // ledger being ready for it. Defaulting to posted keeps every existing
  // caller's behaviour exactly as it was; only a caller that explicitly asks
  // not to post gets the unposted row.
  const post = v.post !== false
  const jeId = post
    ? (
        await postJournal({
          date: to,
          vchType: 'PAYMENT',
          vchNo: String(bd.bd_no || ''),
          narration:
            `Bill Discounting ${bd.bd_no} — interest ${inr(gross)} for ${n(w.days)} days ` +
            `(${String(w.from_date)} to ${to}) paid to ${bd.nbfc_name || 'the NBFC'}` +
            (tds > 0.004 ? `, TDS ${inr(tds)} withheld` : ''),
          companyId: n(bd.company_id) || undefined,
          lines: [
            { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: gross },
            ...(tds > 0.004
              ? [{ account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: tds }]
              : []),
            { account: bank, group: 'Bank Accounts', cr: net }
          ]
        })
      ).id
    : null
  const res = await getClient().execute({
    sql: `INSERT INTO bd_interest_payments (bd_id, from_date, to_date, days, paid_date, gross, tds, net, note, journal_entry_id, bank_account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      n(bdId),
      String(w.from_date),
      to,
      n(w.days),
      to,
      gross,
      tds,
      net,
      v.note ? String(v.note) : null,
      jeId,
      bank
    ]
  })
  // No audit row written here: the IPC layer records one per channel, which is
  // why every other action on this bill reads as its channel name. Writing a
  // second would put the same payment in the trail twice.
  return { id: Number(res.lastInsertRowid), gross, tds, net, days: n(w.days), posted: post }
  })
}

export async function payBdInterest(
  bdId: number,
  v: {
    to_date: string
    paid_date?: string
    amount?: number | string | null
    note?: string | null
    post?: boolean
    bank_account?: string | null
  }
): Promise<{ id: number; gross: number; net: number; posted: boolean }> {
  return withDbTransaction(async () => {
  const bd = await loadBd(bdId)
  if (String(bd.interest_mode || '') !== 'serviced') {
    throw new Error('This bill does not service its interest — its interest was settled when the bill was opened')
  }
  const to = String(v.to_date || '').slice(0, 10)
  const sched = await bdInterestSchedule(bdId)
  const slice = sched.find((r) => String(r.to_date) === to)
  if (!slice) throw new Error('That is not one of this bill’s interest rests')
  if (slice.paid_id) throw new Error('That rest has already been paid')
  // Everything before it must be settled first, or the ledger would carry a
  // later period's interest while an earlier one is still open — and the plug
  // on the final slice would be computed against a gap.
  const earlier = sched.find((r) => String(r.to_date) < to && !r.paid_id)
  if (earlier) {
    throw new Error(`Pay the rest to ${String(earlier.to_date)} first — interest is serviced in order`)
  }
  const date = String(v.paid_date || todayISO()).slice(0, 10)
  if (date > todayISO()) throw new Error('Interest cannot be dated in the future')
  // A part payment of a rest is allowed — some NBFCs take what is available
  // and carry the rest — but never more than the rest is worth.
  const asked = v.amount == null || String(v.amount).trim() === '' ? n(slice.gross) : round2(n(v.amount))
  if (!(asked > 0.004)) throw new Error('Enter the interest being paid')
  if (asked > n(slice.gross) + 0.004) {
    throw new Error(`That rest is ${inr(n(slice.gross))} — it cannot take ${inr(asked)}`)
  }
  const tds = round2((asked * n(bd.tds_pct)) / 100)
  const net = round2(asked - tds)
  const bank = await bdBankFor(bd, v.bank_account)
  // See payBdInterestUpto for why this defaults to posted.
  const post = v.post !== false
  const jeId = post
    ? (
        await postJournal({
          date,
          vchType: 'PAYMENT',
          vchNo: String(bd.bd_no || ''),
          narration:
            `Bill Discounting ${bd.bd_no} — interest ${inr(asked)} for ${n(slice.days)} days ` +
            `(${String(slice.from_date)} to ${to}) paid to ${bd.nbfc_name || 'the NBFC'}` +
            (tds > 0.004 ? `, TDS ${inr(tds)} withheld` : ''),
          companyId: n(bd.company_id) || undefined,
          lines: [
            { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: asked },
            ...(tds > 0.004
              ? [{ account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: tds }]
              : []),
            { account: bank, group: 'Bank Accounts', cr: net }
          ]
        })
      ).id
    : null
  const res = await getClient().execute({
    sql: `INSERT INTO bd_interest_payments (bd_id, from_date, to_date, days, paid_date, gross, tds, net, note, journal_entry_id, bank_account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      n(bdId),
      String(slice.from_date),
      to,
      n(slice.days),
      date,
      asked,
      tds,
      net,
      v.note ? String(v.note) : null,
      jeId,
      bank
    ]
  })
  return { id: Number(res.lastInsertRowid), gross: asked, net, posted: post }
  })
}

/**
 * POST THE VOUCHER FOR AN INTEREST PAYMENT RECORDED WITHOUT ONE.
 *
 * The desk can choose, at the moment of recording, to hold a payment off the
 * books — the days are then serviced and the schedule moves on, but nothing
 * has hit the ledger yet. This is the other half of that choice: post it,
 * whenever the desk is ready, without re-entering the payment or disturbing
 * its place in the schedule.
 */
export async function postBdInterestPayment(payId: number): Promise<{ id: number; journal_entry_id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bd_interest_payments WHERE id = ?', args: [n(payId)] })
  if (!res.rows.length) throw new Error('That interest payment no longer exists')
  const row = toPlain(res)[0]
  if (row.journal_entry_id) throw new Error('This payment is already posted')
  const bd = await loadBd(n(row.bd_id))
  const gross = n(row.gross)
  const tds = n(row.tds)
  const net = n(row.net)
  const je = await postJournal({
    date: String(row.paid_date).slice(0, 10),
    vchType: 'PAYMENT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no} — interest ${inr(gross)} for ${n(row.days)} days ` +
      `(${String(row.from_date)} to ${String(row.to_date)}) paid to ${bd.nbfc_name || 'the NBFC'}` +
      (tds > 0.004 ? `, TDS ${inr(tds)} withheld` : ''),
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: gross },
      ...(tds > 0.004 ? [{ account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: tds }] : []),
      { account: await bdBankFor(bd, row.bank_account), group: 'Bank Accounts', cr: net }
    ]
  })
  await c.execute({
    sql: 'UPDATE bd_interest_payments SET journal_entry_id = ? WHERE id = ?',
    args: [je.id, n(payId)]
  })
  return { id: n(payId), journal_entry_id: je.id }
  })
}

/** Undo one interest payment — its voucher reverses with it. */
export async function deleteBdInterestPayment(payId: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bd_interest_payments WHERE id = ?', args: [n(payId)] })
  if (!res.rows.length) throw new Error('That interest payment no longer exists')
  const row = toPlain(res)[0]
  // Paid as one voucher with other bills (Pay cumulative interest): the bank
  // debit was one, so it goes back as one — every bill's row on it with it.
  if (n(row.journal_entry_id)) {
    await c.execute({ sql: 'DELETE FROM bd_interest_payments WHERE journal_entry_id = ? AND id <> ?', args: [n(row.journal_entry_id), n(payId)] })
  }
  await dropEntry(n(row.journal_entry_id) || null)
  // Booked through the NBFC: its interest JOURNAL goes with the payment.
  if (n(row.interest_entry_id)) await dropEntry(n(row.interest_entry_id))
  await c.execute({ sql: 'DELETE FROM bd_interest_payments WHERE id = ?', args: [n(payId)] })
  return { id: n(payId) }
  })
}

// The repayments made against one bill, oldest first, with a running balance
// so the screen can show the bill being worked down.
export async function listBdRepayments(bdId: number): Promise<Row[]> {
  const bd = await loadBd(bdId)
  const res = await getClient().execute({
    sql: `SELECT r.*, je.vch_no, je.entry_date AS voucher_date,
                 -- Every bill the same bank debit settled, this one included,
                 -- so an edit can show (and change) the whole debit.
                 (SELECT json_group_array(json_object('id', r2.id, 'bd_id', r2.bd_id, 'bd_no', b2.bd_no, 'amount', r2.amount, 'comm_charges', r2.comm_charges, 'bank_charges', r2.bank_charges, 'interest', r2.interest, 'charges', r2.charges))
                    FROM bd_repayments r2 JOIN bill_discountings b2 ON b2.id = r2.bd_id
                   WHERE r.journal_entry_id IS NOT NULL AND r2.journal_entry_id = r.journal_entry_id) AS group_json
          FROM bd_repayments r
          LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
          WHERE r.bd_id = ? ORDER BY r.repay_date, r.id`,
    args: [bdId]
  })
  let left = principalDrawn(bd)
  return toPlain(res).map((r) => {
    left = round2(left - n(r.amount))
    let group: Row[] = []
    try {
      group = r.group_json ? (JSON.parse(String(r.group_json)) as Row[]) : []
    } catch {
      group = []
    }
    return { ...r, group_json: undefined, debit_group: group, balance_after: left }
  })
}

// Every repayment in the active company, oldest first, for the Excel export's
// second sheet. Deliberately ONE query rather than listBdRepayments per bill:
// the export would otherwise fire a query per row, which is exactly the N+1 the
// rest of this module was cleaned up to avoid.
export async function listAllBdRepayments(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT r.*, bd.bd_no, bd.finance_type, bd.amount AS bill_amount, bd.nbfc_id,
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

// Every party on every bill in the active company, for the Excel export's
// grouped rows. One query, not one per bill.
export async function listAllBdParties(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT bd.bd_no, bp.party_id, bp.party_type, COALESCE(bp.amount, 0) AS amount,
                 COALESCE(s.name, cu.name) AS name
          FROM bd_parties bp
          JOIN bill_discountings bd ON bd.id = bp.bd_id
          LEFT JOIN suppliers s ON bp.party_type = 'supplier' AND s.id = bp.party_id
          LEFT JOIN customers cu ON bp.party_type = 'customer' AND cu.id = bp.party_id
          WHERE bd.company_id = ?
          ORDER BY bd.bd_no, bp.id`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

// Undo ONE part repayment — the wrong figure keyed, or a payment that did not
// clear — without disturbing the others. Its voucher goes with it, and a bill
// that was closed by this part reopens for the balance, giving back its margin
// release along with it since the margin is only released on closure.
export async function deleteBdRepayment(repaymentId: number): Promise<{ id: number; bd_id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE id = ?', args: [repaymentId] })
  if (!res.rows.length) throw new Error('That repayment no longer exists')
  const part = toPlain(res)[0]
  const bdId = Number(part.bd_id)
  const je = n(part.journal_entry_id) || 0

  /**
   * HALF A BANK DEBIT IS NOT A THING THAT HAPPENED.
   *
   * One payment can settle several bills — 47,00,000 out of the bank, part of
   * it this bill and part of it another — and they share the one voucher.
   * Removing this bill's share alone used to drop that voucher and leave the
   * other bill's repayment row pointing at nothing: the bill still read as
   * part-paid while the books had forgotten the money.
   *
   * Removing any share removes the payment. The bank was debited once; it was
   * either that debit or it was not.
   */
  const siblings = je
    ? toPlain(
        await c.execute({
          sql: 'SELECT id, bd_id FROM bd_repayments WHERE journal_entry_id = ?',
          args: [je]
        })
      )
    : [{ id: repaymentId, bd_id: bdId }]
  const touched = Array.from(new Set(siblings.map((x) => n(x.bd_id)).filter((x) => x > 0)))

  // Each share's interest journal goes with the payment.
  const interestJes = je
    ? toPlain(await c.execute({ sql: 'SELECT interest_entry_id FROM bd_repayments WHERE journal_entry_id = ? AND interest_entry_id IS NOT NULL', args: [je] }))
    : n(part.interest_entry_id) ? [{ interest_entry_id: part.interest_entry_id }] : []
  for (const x of interestJes) await dropEntry(n(x.interest_entry_id) || null)
  // And its charges journal.
  const chargeJes = je
    ? toPlain(await c.execute({ sql: 'SELECT charges_entry_id FROM bd_repayments WHERE journal_entry_id = ? AND charges_entry_id IS NOT NULL', args: [je] }))
    : n(part.charges_entry_id) ? [{ charges_entry_id: part.charges_entry_id }] : []
  for (const x of chargeJes) await dropEntry(n(x.charges_entry_id) || null)
  await dropEntry(je || null)
  await ensureBdAdjust()
  if (je) {
    await c.execute({ sql: 'DELETE FROM bd_interest_adjustments WHERE repayment_id IN (SELECT id FROM bd_repayments WHERE journal_entry_id = ?)', args: [je] })
    await c.execute({ sql: 'DELETE FROM bd_repayments WHERE journal_entry_id = ?', args: [je] })
  } else {
    await c.execute({ sql: 'DELETE FROM bd_interest_adjustments WHERE repayment_id = ?', args: [repaymentId] })
    await c.execute({ sql: 'DELETE FROM bd_repayments WHERE id = ?', args: [repaymentId] })
  }

  for (const oneId of touched.length ? touched : [bdId]) {
    const bd = await loadBd(oneId)
    const paid = await repaidSoFar({ ...bd, status: 'open' })
    const closed = principalDrawn(bd) - paid <= 0.004
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
        oneId
      ]
    })
  }
  return { id: repaymentId, bd_id: bdId }
  })
}

/**
 * EDIT A REPAYMENT — its date, the bank it left from, the charges, and what it
 * put against each bill it settled (the one debit can clear several).
 *
 * Done the way a desk would do it by hand, but as one act: the repayment and
 * the bank debit it belongs to are taken off (deleteBdRepayment — so every
 * bill it touched reopens as it should), and the corrected figures go back on
 * through repayBd, with every check a new repayment gets. Then the fresh
 * voucher is moved onto the OLD voucher's id, so it keeps its number
 * (PAY/467), its Tally link and its place in the day book; the same for a
 * margin release the closure re-posts. A repayment settled against a party is
 * removed and entered again instead — which party it named is not kept on the
 * row, and guessing would move money onto the wrong ledger.
 */
export async function editBdRepayment(
  repaymentId: number,
  v: {
    repay_date?: string
    bank_account?: string | null
    comm_charges?: number | string | null
    bank_charges?: number | string | null
    interest?: number | string | null
    // TDS on the interest — left out, it stays as it was.
    tds_ledger?: string | null
    tds_amount?: number | string | null
    charges?: { account?: string; amount?: string | number }[] | null
    note?: string | null
    // What the debit put against each bill — this repayment's bill and any
    // other bill sharing the voucher. A bill left out is no longer settled by it.
    shares?: { bd_id?: number | string; amount?: number | string }[]
    // OTHER REPAYMENTS FOLDED INTO THIS DEBIT — entered as separate payments
    // when the bank made one. Each is taken off (its voucher with it) and its
    // bills come back on through `shares`, so the bank book shows one line.
    merge_ids?: (number | string)[]
  }
): Promise<{ id: number; bd_id: number; entry_id: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const row = toPlain(await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE id = ?', args: [repaymentId] }))[0]
    if (!row) throw new Error('That repayment no longer exists')
    if (String(row.settle_via) === 'party') {
      throw new Error('A repayment settled against a party is changed by removing it and entering it again')
    }
    const bdId = n(row.bd_id)
    const oldJe = n(row.journal_entry_id)
    const siblings = oldJe
      ? toPlain(await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE journal_entry_id = ? ORDER BY id', args: [oldJe] }))
      : [row]
    // Which bill the debit was entered on — the one carrying the charges, else
    // this one — stays the bill it is entered on again.
    const primary = siblings.find((x) => n(x.comm_charges) > 0 || n(x.bank_charges) > 0 || n(x.interest) > 0 || n(x.penalty) > 0 || !!x.charges) || row
    const primaryId = n(primary.bd_id)
    const oldHead = oldJe
      ? toPlain(await c.execute({ sql: 'SELECT vch_type FROM journal_entries WHERE id = ?', args: [oldJe] }))[0]
      : null
    // The interest journal keeps its number too.
    const oldIntJe = n(primary.interest_entry_id)
    const oldChJe = n(primary.charges_entry_id)
    // The repayments being folded in — each a debit of its own today.
    const mergeRows: Row[] = []
    const seenJe = new Set<number>([oldJe])
    for (const mid of (v.merge_ids || []).map((x) => n(x)).filter(Boolean)) {
      const m = toPlain(await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE id = ?', args: [mid] }))[0]
      if (!m) throw new Error('A repayment picked to combine no longer exists — refresh and try again')
      if (String(m.settle_via) === 'party') throw new Error('A repayment settled against a party cannot be combined into a bank debit')
      const mb = await loadBd(n(m.bd_id))
      const pb = await loadBd(bdId)
      if (n(mb.nbfc_id) !== n(pb.nbfc_id)) throw new Error(`${mb.bd_no || 'That bill'} is with a different NBFC — one debit cannot settle both`)
      const mje = n(m.journal_entry_id)
      if (mje && seenJe.has(mje)) continue
      if (mje) seenJe.add(mje)
      // Its whole debit comes off: every bill it settled is in it.
      const group = mje ? toPlain(await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE journal_entry_id = ?', args: [mje] })) : [m]
      mergeRows.push(m, ...group.filter((g) => n(g.id) !== n(m.id)))
    }
    // Whose margin release this debit's closure had posted, to keep its number too.
    const touched = Array.from(new Set([...siblings, ...mergeRows].map((x) => n(x.bd_id))))
    const oldMargins = new Map<number, number>()
    for (const id of touched) {
      const b = await loadBd(id)
      if (n(b.margin_release_journal_entry_id)) oldMargins.set(id, n(b.margin_release_journal_entry_id))
    }

    // Only the bill the debit was entered on gets its margin back again on
    // closure; another bill's released margin would be lost by the re-entry.
    for (const id of oldMargins.keys()) {
      if (id !== primaryId) {
        const b = await loadBd(id)
        throw new Error(`${b.bd_no || 'Another bill'} on this debit has had its margin released — remove and re-enter the repayment instead`)
      }
    }
    // One line per bill: two repayments of the same bill folded together are
    // one figure off it.
    const byBill = new Map<number, number>()
    for (const x of v.shares && v.shares.length ? v.shares : [...siblings, ...mergeRows].map((y) => ({ bd_id: y.bd_id, amount: y.amount }))) {
      const id = n(x.bd_id)
      if (id) byBill.set(id, round2((byBill.get(id) || 0) + n(x.amount)))
    }
    const shares = [...byBill].map(([bd_id, amount]) => ({ bd_id, amount })).filter((x) => x.amount > 0.004)
    const own = shares.find((x) => x.bd_id === primaryId)
    if (!own) throw new Error('Keep an amount against the bill this repayment was entered on')
    const also = shares.filter((x) => x.bd_id !== primaryId)
    const comm = v.comm_charges === undefined ? round2(n(primary.comm_charges)) : round2(n(v.comm_charges))
    const bankCh = v.bank_charges === undefined ? round2(n(primary.bank_charges)) : round2(n(v.bank_charges))
    // A screen that does not carry interest (the phone) keeps what it was.
    const intr = v.interest === undefined || v.interest === null ? round2(n(primary.interest)) : round2(n(v.interest))
    // A screen that does not carry the ledger charges keeps what they were.
    const charges: { account?: string; amount?: string | number }[] = v.charges ?? JSON.parse(String(primary.charges || '[]'))
    const extra = round2(charges.reduce((t, x) => t + n(x.amount), 0))
    // The penalty is not edited here; it rides along as it was.
    const penalty = round2(n(primary.penalty))
    const debit = round2(own.amount + also.reduce((t, x) => t + x.amount, 0) + (also.length ? comm + bankCh + intr + penalty + extra : 0))

    await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
        repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    await c.execute({
      sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
      args: [`bd_repayment_edit:${repaymentId}:${Date.now()}`, oldJe, JSON.stringify({ siblings, merged: mergeRows })]
    })

    await deleteBdRepayment(repaymentId)
    for (const m of mergeRows) {
      if ((await c.execute({ sql: 'SELECT 1 FROM bd_repayments WHERE id = ?', args: [n(m.id)] })).rows.length) await deleteBdRepayment(n(m.id))
    }
    await repayBd(primaryId, {
      repay_date: String(v.repay_date || primary.repay_date).slice(0, 10),
      settle_via: 'bank',
      bank_account: v.bank_account === undefined ? (primary.bank_account ? String(primary.bank_account) : null) : v.bank_account,
      comm_charges: comm || null,
      bank_charges: bankCh || null,
      interest: intr || null,
      penalty: penalty || null,
      penalty_pct: primary.penalty_pct ?? null,
      penalty_days: primary.penalty_days ?? null,
      charges,
      amount: debit,
      note: v.note === undefined ? (primary.note ? String(primary.note) : null) : v.note,
      release_margin: oldMargins.has(primaryId) || undefined,
      also,
      tds_ledger: v.tds_ledger === undefined ? (primary.tds_ledger ? String(primary.tds_ledger) : null) : v.tds_ledger,
      tds_amount: v.tds_amount === undefined ? n(primary.tds_amount) || null : v.tds_amount
    })

    // THE NEW VOUCHER TAKES THE OLD ONE'S PLACE.
    const moveEntry = async (from: number, to: number, typeWas: string | null): Promise<number> => {
      if (!from || !to || from === to) return from
      const head = toPlain(await c.execute({ sql: 'SELECT vch_type FROM journal_entries WHERE id = ?', args: [from] }))[0]
      // A different kind of voucher would carry the wrong number series.
      if (!head || (typeWas && String(head.vch_type) !== typeWas)) {
        await c.execute({ sql: 'DELETE FROM voucher_numbers WHERE entry_id = ?', args: [to] }).catch(() => {})
        return from
      }
      await c.execute({
        sql: `INSERT INTO journal_entries (id, company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id)
              SELECT ?, company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id FROM journal_entries WHERE id = ?`,
        args: [to, from]
      })
      await c.execute({ sql: 'UPDATE journal_lines SET entry_id = ? WHERE entry_id = ?', args: [to, from] })
      await c.execute({ sql: 'UPDATE bd_repayments SET journal_entry_id = ? WHERE journal_entry_id = ?', args: [to, from] })
      await c.execute({ sql: 'UPDATE bd_repayments SET interest_entry_id = ? WHERE interest_entry_id = ?', args: [to, from] })
      await c.execute({ sql: 'UPDATE bd_repayments SET charges_entry_id = ? WHERE charges_entry_id = ?', args: [to, from] })
      await c.execute({ sql: 'UPDATE bill_discountings SET margin_release_journal_entry_id = ? WHERE margin_release_journal_entry_id = ?', args: [to, from] })
      await c.execute({ sql: 'DELETE FROM voucher_numbers WHERE entry_id = ?', args: [from] }).catch(() => {})
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [from] })
      return to
    }
    const fresh = toPlain(
      await c.execute({ sql: 'SELECT journal_entry_id FROM bd_repayments WHERE bd_id = ? ORDER BY id DESC LIMIT 1', args: [primaryId] })
    )[0]
    const entry = await moveEntry(n(fresh?.journal_entry_id), oldJe, oldHead ? String(oldHead.vch_type) : null)
    if (oldIntJe) {
      const ni = toPlain(await c.execute({ sql: 'SELECT interest_entry_id FROM bd_repayments WHERE journal_entry_id = ? AND interest_entry_id IS NOT NULL LIMIT 1', args: [entry] }))[0]
      if (n(ni?.interest_entry_id)) await moveEntry(n(ni.interest_entry_id), oldIntJe, 'JOURNAL')
    }
    if (oldChJe) {
      const nc = toPlain(await c.execute({ sql: 'SELECT charges_entry_id FROM bd_repayments WHERE journal_entry_id = ? AND charges_entry_id IS NOT NULL LIMIT 1', args: [entry] }))[0]
      if (n(nc?.charges_entry_id)) await moveEntry(n(nc.charges_entry_id), oldChJe, 'JOURNAL')
    }
    for (const [id, oldM] of oldMargins) {
      const b = await loadBd(id)
      const now = n(b.margin_release_journal_entry_id)
      if (now && now !== oldM && !(await c.execute({ sql: 'SELECT 1 FROM journal_entries WHERE id = ?', args: [oldM] })).rows.length) {
        await moveEntry(now, oldM, null)
      }
    }
    const mine = toPlain(
      await c.execute({ sql: 'SELECT id FROM bd_repayments WHERE bd_id = ? AND journal_entry_id = ? ORDER BY id DESC LIMIT 1', args: [bdId, entry] })
    )[0]
    return { id: n(mine?.id) || repaymentId, bd_id: bdId, entry_id: entry }
  })
}

// Stamp the day the NBFC's money actually landed. This is the point the bill
// goes live: the disbursement posts here (bank debited, margin held, interest
// taken, liability raised), and interest starts running from this date, which
// is why it is asked for when it happens rather than guessed at when the bill
// is opened. Re-marking simply moves the date and re-posts to match.
export async function markBdPaymentReceived(
  id: number,
  dateIn?: string,
  // WHERE THE MONEY WENT, asked when it arrives: into our bank (which one),
  // or straight to the supplier on a PID. Left out, the bill keeps the route
  // it already has.
  opts?: { route?: string; account?: string | null; firstPart?: number | null; firstReceipt?: number | null; legs?: Row[] | null; note?: string | null }
): Promise<{ id: number; date: string }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(id)
  // SEVERAL PARTS AT ONCE, each with its own maturity, interest % and margin
  // % (blank = the bill's). Part 1 is the Payment received; the rest are
  // posted after it, each on its own day, exactly as Receive part would.
  const plan: Row[] = Array.isArray(opts?.legs) ? (opts?.legs as Row[]).filter((l) => round2(n(l?.amount)) > 0.005) : []
  if (plan.length) {
    if ((bd.receipt_parts as Row[]).length && plan.length > 1) {
      throw new Error('Later parts have already been received on this bill — add more from Receive part')
    }
    const total = round2(plan.reduce((s, l) => s + round2(n(l.amount)), 0))
    if (total > n(bd.amount) + 0.005) throw new Error(`The parts come to ${inr(total)}, more than the ${inr(n(bd.amount))} drawn on this bill`)
    opts = { ...opts, firstReceipt: round2(n(plan[0].amount)) }
    const rate = (v: unknown): number | null => {
      if (v == null || String(v).trim() === '') return null
      const x = Number(v)
      if (!Number.isFinite(x) || x < 0) throw new Error('A part\'s interest or margin % must be a number, 0 or more')
      return x
    }
    const m1 = String(plan[0].maturity || '').slice(0, 10) || null
    await c.execute({
      sql: 'UPDATE bill_discountings SET first_receipt_maturity = ?, first_receipt_interest_pct = ?, first_receipt_margin_pct = ? WHERE id = ?',
      args: [m1, rate(plan[0].interest_pct), rate(plan[0].margin_pct), id]
    })
    bd.first_receipt_maturity = m1
    // The bill now runs to its last part's maturity.
    const last = plan.reduce((m, l) => (String(l.maturity || '').slice(0, 10) > m ? String(l.maturity).slice(0, 10) : m), '')
    if (last && last !== String(bd.maturity_date || '').slice(0, 10)) {
      await c.execute({ sql: 'UPDATE bill_discountings SET maturity_date = ? WHERE id = ?', args: [last, id] })
      bd.maturity_date = last
    }
  }
  // RECEIVED IN PARTS (SID): the first leg the NBFC released on this date.
  // The rest arrives leg by leg (receiveBdPart). Settable only while no later
  // leg has been recorded.
  if (opts && 'firstReceipt' in opts) {
    const fr = round2(n(opts.firstReceipt))
    const later = (bd.receipt_parts as Row[]).length
    if (fr > 0.005) {
      if (!(n(bd.invoice_amount) > 0)) throw new Error('Enter the invoice amount on the bill first — receiving in parts needs it')
      if (String(bd.interest_mode || '') === 'serviced') throw new Error('A bill whose interest is serviced month by month is received in one go')
      if (fr > n(bd.amount) + 0.005) throw new Error(`The first part (${inr(fr)}) is more than the ${inr(n(bd.amount))} drawn on this bill`)
    }
    if (later > 0 && Math.abs(fr - n(bd.first_receipt_part)) > 0.005) {
      throw new Error('Later parts have been received on this bill — take them back before changing the first part')
    }
    // A single part for the whole draw is "in full" — unless it carries a
    // maturity or rate of its own, which only a part can hold.
    const ownTerms = plan.length > 0 && (plan[0].maturity || String(plan[0].interest_pct ?? '').trim() !== '' || String(plan[0].margin_pct ?? '').trim() !== '')
    const keep = fr > 0.005 && (fr < n(bd.amount) - 0.005 || ownTerms) ? fr : null
    await c.execute({ sql: 'UPDATE bill_discountings SET first_receipt_part = ? WHERE id = ?', args: [keep, id] })
    bd.first_receipt_part = keep
    // Legs and the older paid-in-parts are one or the other.
    if (keep) await c.execute({ sql: 'UPDATE bill_discountings SET first_party_part = NULL WHERE id = ?', args: [id] })
    if (!keep) {
      await c.execute({
        sql: 'UPDATE bill_discountings SET first_receipt_maturity = NULL, first_receipt_interest_pct = NULL, first_receipt_margin_pct = NULL WHERE id = ?',
        args: [id]
      })
    }
  }
  // PAID IN PARTS: the first part, when the NBFC paid the supplier only some
  // of it on this date. Settable only while no later part has been paid.
  if (opts && 'firstPart' in opts) {
    const later = await c.execute({ sql: 'SELECT COUNT(*) AS k FROM bd_party_payments WHERE bd_id = ?', args: [id] })
    const fp = round2(n(opts.firstPart))
    const routeNow = String(opts.route || bd.disbursement_route || '')
    const net = round2(bdCalc(bd).receiptAmount)
    if (fp > 0.005) {
      if (routeNow !== 'supplier') throw new Error('Only a bill the NBFC pays straight to the supplier can be paid in parts')
      if (fp > net + 0.005) throw new Error(`The first part (${inr(fp)}) is more than the ${inr(net)} the NBFC releases on this bill`)
    }
    if (n(later.rows[0]?.k) > 0 && Math.abs(fp - n(bd.first_party_part)) > 0.005) {
      throw new Error('Later parts have been paid on this bill — take them back before changing the first part')
    }
    await c.execute({
      sql: 'UPDATE bill_discountings SET first_party_part = ? WHERE id = ?',
      args: [fp > 0.005 && fp < net - 0.005 ? fp : null, id]
    })
  }
  const route = String(opts?.route || '').trim()
  if (route) {
    if (!['bank', 'supplier'].includes(route)) throw new Error('Choose who received the NBFC disbursement')
    if (route === 'supplier' && String(bd.finance_type) !== 'PID') throw new Error('Only a PID can be paid straight to the supplier')
    const account = route === 'bank' ? String(opts?.account || '').trim() : ''
    if (route === 'bank' && !account) throw new Error('Choose the bank the money landed in')
    await c.execute({
      sql: 'UPDATE bill_discountings SET disbursement_route = ?, disbursement_account = ? WHERE id = ?',
      args: [route, account || null, id]
    })
  }
  if (String(bd.status) === 'repaid') throw new Error('This bill is already repaid — reopen it first if the receipt date needs correcting')
  const date = String(dateIn || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The payment received date')
  const maturity = String(bd.maturity_date || '').slice(0, 10)
  if (maturity && date > maturity) {
    throw new Error('The payment cannot be received after the maturity date — check the date')
  }
  const nextLeg = (bd.receipt_parts as Row[])[0]
  if (nextLeg && date > String(nextLeg.receipt_date).slice(0, 10)) {
    throw new Error(`Part 2 was received on ${String(nextLeg.receipt_date).slice(0, 10).split('-').reverse().join('-')} — the first part cannot be dated after it`)
  }
  const m1 = String(bd.first_receipt_maturity || '').slice(0, 10)
  if (m1 && m1 < date) throw new Error('Part 1 cannot mature before it was received')
  await c.execute({ sql: 'UPDATE bill_discountings SET payment_received_date = ? WHERE id = ?', args: [date, id] })
  if (opts && opts.note !== undefined) {
    await c.execute({ sql: 'UPDATE bill_discountings SET received_note = ? WHERE id = ?', args: [String(opts.note || '').trim() || null, id] })
  }
  await postBdOpening(id)
  // The later parts of the plan, each its own voucher on its own day.
  for (let i = 1; i < plan.length; i++) {
    const l = plan[i]
    await addReceiptLeg(id, {
      date: String(l.date || '').slice(0, 10),
      amount: l.amount,
      account: opts?.account ?? null,
      note: l.note ?? null,
      maturity: l.maturity,
      interest_pct: l.interest_pct,
      margin_pct: l.margin_pct
    })
  }
  return { id, date }
  })
}

// Undo the receipt — marked against the wrong bill, or the credit never landed.
// The disbursement voucher goes with it and the bill drops back to awaiting.
// Refused once anything has been repaid: money cannot have gone back on a bill
// that was never funded, so the repayments have to come off first.
export async function unmarkBdPaymentReceived(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — reopen it first')
  const paid = await repaidSoFar(bd)
  if (paid > 0.004) {
    throw new Error(`${inr(paid)} has already been repaid on this bill — remove the repayments before undoing the receipt`)
  }
  const later = await c.execute({ sql: 'SELECT COUNT(*) AS k FROM bd_party_payments WHERE bd_id = ?', args: [id] })
  if (n(later.rows[0]?.k) > 0) throw new Error('Later parts have been paid to the supplier on this bill — take them back before undoing the receipt')
  if ((bd.receipt_parts as Row[]).length) throw new Error('Later parts have been received on this bill — take them back before undoing the receipt')
  await dropEntry(n(bd.journal_entry_id) || null)
  await c.execute({
    sql: `UPDATE bill_discountings SET payment_received_date = NULL, journal_entry_id = NULL, first_party_part = NULL, first_receipt_part = NULL,
            first_receipt_maturity = NULL, first_receipt_interest_pct = NULL, first_receipt_margin_pct = NULL WHERE id = ?`,
    args: [id]
  })
  return { id }
  })
}

export async function reopenBd(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const bd = await loadBd(id)
  await dropRepayEntries(bd)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  await c.execute({
    sql: "UPDATE bill_discountings SET status = 'open', repaid_date = NULL, repaid_amount = NULL, repay_journal_entry_id = NULL, margin_release_journal_entry_id = NULL WHERE id = ?",
    args: [id]
  })
  return { id }
  })
}


/**
 * A PRINCIPAL REPAYMENT IS A CUT TO THE LINE, NOT A PAYMENT ON A BILL.
 *
 * Repaying a bill hands its money back and releases the limit it was holding,
 * so the same room can be drawn again tomorrow. A principal repayment is the
 * other thing entirely: the facility itself steps down. 35 sanctioned, 4 of
 * principal repaid, and 35 is not the limit any more — 31 is, permanently, and
 * no bill closing will bring it back.
 *
 * So it touches no bill's outstanding and posts no voucher of its own. The
 * money that moved is whatever actually moved, recorded where it moved; this is
 * the record of what it did to the drawing power, which is the thing a limit
 * screen has to know and could not work out for itself.
 */
/**
 * MOVE THE HISTORY OFF THE SHARED ACCOUNT AND ONTO EACH LENDER.
 *
 * Every discounted bill posted its liability to one BILLS DISCOUNTED A/C, so
 * eight NBFCs sat in a single figure. New postings now go to
 * BILLS DISCOUNTED - <NBFC> (see bdPayable); this carries the existing
 * postings across so the whole chart reads the same way and each lender's
 * outstanding stands on its own ledger.
 *
 * Only the shared account is touched, and only its lines that belong to a
 * discounted bill — an opening voucher (bill_discountings.journal_entry_id)
 * or a repayment (bd_repayments.journal_entry_id). A line that maps to no bill
 * is left exactly where it is: this reclassifies what it can name and never
 * guesses. Runs once; a book with nothing on the shared account is a no-op.
 */
export async function migrateBdPerNbfcLedgers(): Promise<{ moved: number; ledgers: number }> {
  const c = getClient()
  const shared = await c.execute(
    "SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = 'BILLS DISCOUNTED A/C' LIMIT 1"
  )
  if (!shared.rows.length) return { moved: 0, ledgers: 0 }
  const sharedId = n(shared.rows[0].id)

  // Every line on the shared account, with the NBFC it can be traced to.
  const rows = toPlain(
    await c.execute({
      sql: `SELECT l.id AS line_id,
                   COALESCE(
                     (SELECT bd.nbfc_id FROM bill_discountings bd WHERE bd.journal_entry_id = l.entry_id LIMIT 1),
                     (SELECT bd2.nbfc_id FROM bd_repayments r
                        JOIN bill_discountings bd2 ON bd2.id = r.bd_id
                       WHERE r.journal_entry_id = l.entry_id LIMIT 1)
                   ) AS nbfc_id
              FROM journal_lines l
             WHERE l.account_id = ?`,
      args: [sharedId]
    })
  )

  const targetByNbfc = new Map<number, number>()
  const nameOf = new Map<number, string>()
  let moved = 0
  for (const r of rows) {
    const nbfcId = n(r.nbfc_id)
    if (!nbfcId) continue // unmapped — leave it where it is
    let targetId = targetByNbfc.get(nbfcId)
    if (targetId == null) {
      if (!nameOf.has(nbfcId)) {
        const nb = await c.execute({ sql: 'SELECT name FROM nbfcs WHERE id = ? LIMIT 1', args: [nbfcId] })
        nameOf.set(nbfcId, String(nb.rows[0]?.name || '').trim().replace(/\s+/g, ' ').toUpperCase())
      }
      const nbName = nameOf.get(nbfcId) || ''
      if (!nbName) continue
      const ledgerName = `BILLS DISCOUNTED - ${nbName}`
      await c.execute({
        sql: "INSERT OR IGNORE INTO ledger_accounts (name, acc_group) VALUES (?, 'Loans (Liability)')",
        args: [ledgerName]
      })
      const got = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [ledgerName] })
      targetId = n(got.rows[0]?.id)
      targetByNbfc.set(nbfcId, targetId)
    }
    if (!targetId || targetId === sharedId) continue
    await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?', args: [targetId, n(r.line_id)] })
    moved++
  }
  return { moved, ledgers: targetByNbfc.size }
}

export async function listBdLimitReductions(nbfcId?: number): Promise<Row[]> {
  const where = ['lr.company_id = ?']
  const args: (number | string)[] = [getActiveCompanyId()]
  if (nbfcId) {
    where.push('lr.nbfc_id = ?')
    args.push(nbfcId)
  }
  const res = await getClient().execute({
    sql: `SELECT lr.*, nb.name AS nbfc_name, bd.bd_no
          FROM bd_limit_reductions lr
          LEFT JOIN nbfcs nb ON nb.id = lr.nbfc_id
          LEFT JOIN bill_discountings bd ON bd.id = lr.bd_id
          WHERE ${where.join(' AND ')}
          ORDER BY lr.reduce_date DESC, lr.id DESC`,
    args
  })
  return toPlain(res)
}

export async function addBdLimitReduction(v: {
  nbfc_id?: number | string | null
  bd_id?: number | string | null
  amount?: number | string | null
  reduce_date?: string | null
  note?: string | null
}): Promise<{ id: number; sanctioned: number; limit_now: number }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  // The bill it was entered from names the NBFC, since that is where the user
  // is standing when they record it; an NBFC given outright still wins.
  let nbfcId = n(v.nbfc_id)
  const bdId = n(v.bd_id)
  if (!nbfcId && bdId) {
    const own = await c.execute({ sql: 'SELECT nbfc_id FROM bill_discountings WHERE id = ? LIMIT 1', args: [bdId] })
    nbfcId = n(own.rows[0]?.nbfc_id)
  }
  if (!nbfcId) throw new Error('Choose the NBFC whose limit is coming down')
  const nb = await c.execute({
    sql: 'SELECT id, name, COALESCE(sanctioned_limit, 0) AS sanctioned FROM nbfcs WHERE id = ? AND company_id = ? LIMIT 1',
    args: [nbfcId, cid]
  })
  if (!nb.rows.length) throw new Error('That NBFC is not in this company')
  const sanctioned = round2(n(toPlain(nb)[0].sanctioned))
  if (sanctioned <= 0) {
    throw new Error(
      `No sanctioned limit is recorded for ${String(toPlain(nb)[0].name || 'this NBFC')} — set it first, or there is nothing to reduce`
    )
  }
  const amount = round2(n(v.amount))
  if (amount <= 0) throw new Error('Enter the principal being repaid')
  const date = String(v.reduce_date || todayISO()).slice(0, 10)
  assertNotFuture(date, 'The principal repayment date')
  const done = await c.execute({
    sql: 'SELECT COALESCE(SUM(amount), 0) AS q FROM bd_limit_reductions WHERE company_id = ? AND nbfc_id = ?',
    args: [cid, nbfcId]
  })
  const already = round2(n(done.rows[0]?.q))
  // A line cannot be cut below nothing. Refused rather than floored at zero, so
  // a figure typed with an extra digit is caught here and not discovered later
  // as a facility that quietly reads 0.
  if (round2(already + amount) - sanctioned > 0.004) {
    throw new Error(
      `${inr(sanctioned)} is sanctioned and ${inr(already)} of principal has already been repaid — only ${inr(round2(sanctioned - already))} is left to reduce`
    )
  }
  const res = await c.execute({
    sql: `INSERT INTO bd_limit_reductions (company_id, nbfc_id, bd_id, amount, reduce_date, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [cid, nbfcId, bdId || null, amount, date, v.note ? String(v.note).trim() : null]
  })
  return {
    id: Number(res.lastInsertRowid),
    sanctioned,
    limit_now: round2(sanctioned - already - amount)
  }
}

export async function deleteBdLimitReduction(id: number): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'DELETE FROM bd_limit_reductions WHERE id = ? AND company_id = ?',
    args: [id, getActiveCompanyId()]
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
                 COALESCE(nb.sanctioned_limit, 0) AS sanctioned_original,
                 COALESCE((SELECT SUM(lr.amount) FROM bd_limit_reductions lr
                           WHERE lr.nbfc_id = nb.id AND lr.company_id = ?), 0) AS principal_repaid,
                 COALESCE((SELECT SUM(${DRAWN_SQL} - COALESCE((SELECT SUM(r.amount) FROM bd_repayments r
                            WHERE r.bd_id = bd.id), 0))
                           FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid' AND bd.payment_received_date IS NOT NULL), 0) AS utilised,
                 -- Committed: bills not funded yet, and the part of a bill
                 -- received in parts that the NBFC has still to release.
                 COALESCE((SELECT SUM(CASE WHEN bd.payment_received_date IS NULL THEN bd.amount ELSE bd.amount - ${DRAWN_SQL} END)
                           FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid'), 0) AS committed,
                 COALESCE((SELECT COUNT(*) FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ? AND bd.status <> 'repaid'), 0) AS open_bills
          FROM nbfcs nb
          WHERE nb.company_id = ?
          ORDER BY nb.active DESC, nb.name COLLATE NOCASE`,
    args: [cid, cid, cid, cid, cid]
  })
  const perNbfc = toPlain(res).map((r) => {
    // WHAT IS SANCTIONED NOW, WHICH IS NOT WHAT WAS SANCTIONED.
    //
    // Principal repaid against this facility has cut the line by that much, so
    // the limit every other figure here is measured against is the reduced one.
    // Both are carried: a screen that shows only 31 cannot say it was 35.
    const original = round2(n(r.sanctioned_original))
    const repaid = round2(n(r.principal_repaid))
    const sanctioned = round2(Math.max(0, original - repaid))
    const utilised = round2(n(r.utilised))
    return {
      ...r,
      sanctioned_original: original,
      principal_repaid: repaid,
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
    // Before any principal was repaid, and what has been repaid against it, so
    // a screen can show the step down rather than only its result.
    sanctioned_original_sum: round2(perNbfc.reduce((t, r) => t + n(r.sanctioned_original), 0)),
    principal_repaid_total: round2(perNbfc.reduce((t, r) => t + n(r.principal_repaid), 0)),
    utilised_total: utilisedTotal,
    committed_total: round2(perNbfc.reduce((t, r) => t + n(r.committed), 0)),
    combined_limit: combined,
    combined_available: combined == null ? null : round2(combined - utilisedTotal),
    combined_used_pct: combined && combined > 0 ? Math.round((utilisedTotal / combined) * 1000) / 10 : null,
    // What can actually be drawn, from whichever limits have been recorded:
    //
    //   lines only    -> the sum of them
    //   combined only -> the combined ceiling
    //   both          -> the LOWER of the two. A group ceiling caps the lines,
    //                    and the lines cap the group in the other direction —
    //                    you cannot draw more than either allows.
    //   neither       -> nothing to report
    //
    // The basis is named alongside it, so the figure is never a number without
    // provenance. Reporting only the combined ceiling was wrong: per-NBFC limits
    // on their own are a real limit, and the screen said "not set" over them.
    ...(() => {
      const lines = sanctionedTotal > 0 ? sanctionedTotal : null
      if (combined == null && lines == null) {
        return { effective_limit: null, effective_basis: null, effective_available: null, effective_used_pct: null }
      }
      const limit =
        combined != null && lines != null ? Math.min(combined, lines) : combined != null ? combined : (lines as number)
      const basis =
        combined != null && lines != null
          ? combined <= lines
            ? 'combined'
            : 'lines'
          : combined != null
            ? 'combined'
            : 'lines'
      return {
        effective_limit: round2(limit),
        effective_basis: basis,
        effective_available: round2(limit - utilisedTotal),
        effective_used_pct: limit > 0 ? Math.round((utilisedTotal / limit) * 1000) / 10 : null
      }
    })(),
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

// ---------------------------------------------------------------------------
// THE NBFC PAYING THE SUPPLIER IN PARTS (PID, supplier direct).
//
// The NBFC does not always release a discounted bill's money to the supplier
// at once. The first part is recorded when the bill is marked Payment received
// (bill_discountings.first_party_part) and rides on the opening voucher, which
// carries the interest, margin and charges once, as it always has; each later
// part is its own JOURNAL on the day it was paid — Dr supplier / Cr Bills
// discounted — in bd_party_payments. Paid in full, the parts add up to exactly
// what the single opening voucher would have posted.
// ---------------------------------------------------------------------------

/** What the NBFC has paid the supplier so far, and what is left, for one bill. */
async function bdPartyState(bd: Row): Promise<{ net: number; paid: number; left: number; parts: Row[]; lastDate: string }> {
  const c = getClient()
  const calc = bdCalc(bd)
  const net = round2(calc.receiptAmount)
  const parts = toPlain(
    await c.execute({ sql: 'SELECT * FROM bd_party_payments WHERE bd_id = ? ORDER BY part_no', args: [n(bd.id)] })
  )
  const first = n(bd.first_party_part)
  const paid = round2((first > 0 ? first : 0) + parts.reduce((t, p) => t + n(p.amount), 0))
  const dates = [String(bd.payment_received_date || '').slice(0, 10), ...parts.map((p) => String(p.pay_date || '').slice(0, 10))].filter(Boolean).sort()
  return { net, paid, left: round2(Math.max(0, net - paid)), parts, lastDate: dates[dates.length - 1] || '' }
}

/** Every part the NBFC has paid the supplier on this bill — the first is the Payment received. */
export async function listBdPartyPayments(bdId: number): Promise<Row[]> {
  const bd = await loadBd(bdId)
  const st = await bdPartyState(bd)
  const first = n(bd.first_party_part)
  const out: Row[] = []
  if (bd.payment_received_date && String(bd.disbursement_route || '') === 'supplier') {
    out.push({ part_no: 1, pay_date: String(bd.payment_received_date).slice(0, 10), amount: first > 0 ? first : st.net, note: null, journal_entry_id: bd.journal_entry_id })
  }
  for (const p of st.parts) out.push({ part_no: n(p.part_no), pay_date: p.pay_date, amount: n(p.amount), note: p.note, journal_entry_id: p.journal_entry_id })
  return out
}

/** The next part the NBFC paid the supplier. */
export async function payBdParty(bdId: number, v: { date?: string; amount?: number | string; note?: string }): Promise<{ id: number; part_no: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const bd = await loadBd(bdId)
    if (String(bd.disbursement_route || '') !== 'supplier') throw new Error('Only a bill the NBFC pays straight to the supplier is paid in parts')
    if (!bd.payment_received_date) throw new Error('Mark Payment received first — that records the first part the NBFC paid')
    if (!(n(bd.first_party_part) > 0)) throw new Error('This bill was paid to the supplier in one go — there is nothing left to pay in parts')
    if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — no more parts can be paid on it')
    const amount = round2(n(v.amount))
    if (amount <= 0.005) throw new Error('Enter the amount the NBFC paid the supplier')
    const date = String(v.date || '').slice(0, 10)
    if (!date) throw new Error('Pick the date the NBFC paid it')
    assertNotFuture(date, 'The payment date')
    const st = await bdPartyState(bd)
    if (st.lastDate && date < st.lastDate) {
      throw new Error(`The last part was paid on ${st.lastDate.split('-').reverse().join('-')} — this one cannot be dated before it`)
    }
    if (st.left <= 0.005) throw new Error('The supplier has already been paid everything this bill releases')
    if (amount > st.left + 0.005) throw new Error(`Only ${inr(st.left)} is still to be paid to the supplier on this bill`)
    const party = partyName(bd)
    if (!party) throw new Error('This bill has no supplier to pay')
    const partNo = st.parts.reduce((m, p) => Math.max(m, n(p.part_no)), 1) + 1
    const je = await postJournal({
      date,
      vchType: 'JOURNAL',
      vchNo: String(bd.bd_no || ''),
      narration: `Bill Discounting ${bd.bd_no || ''} — ${bd.nbfc_name || 'the NBFC'} paid ${party} part ${partNo}: ${amount.toFixed(2)}${v.note ? ` (${String(v.note).trim()})` : ''}`,
      companyId: n(bd.company_id) || undefined,
      lines: [
        { account: party, group: 'Sundry Creditors', dr: amount },
        { account: bdPayable(bd), group: BD_PAYABLE_GROUP, cr: amount }
      ]
    })
    await allocAgainst(je.id, party, null, amount)
    await c.execute({
      sql: 'INSERT INTO bd_party_payments (bd_id, part_no, pay_date, amount, note, journal_entry_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [n(bdId), partNo, date, amount, String(v.note || '').trim() || null, je.id]
    })
    return { id: je.id, part_no: partNo }
  })
}

/** Take back the latest part — never the first, which is the Payment received itself. */
export async function deleteLastBdPartyPayment(bdId: number): Promise<{ part_no: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const bd = await loadBd(bdId)
    if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — reopen it first')
    const r = await c.execute({ sql: 'SELECT id, part_no, journal_entry_id FROM bd_party_payments WHERE bd_id = ? ORDER BY part_no DESC LIMIT 1', args: [n(bdId)] })
    if (!r.rows.length) throw new Error('The first part is the Payment received itself — undo the receipt to change it')
    const row = r.rows[0] as unknown as Row
    await dropEntry(n(row.journal_entry_id) || null)
    await c.execute({ sql: 'DELETE FROM bd_party_payments WHERE id = ?', args: [n(row.id)] })
    return { part_no: n(row.part_no) }
  })
}

// ---------------------------------------------------------------------------
// SID RECEIVED FROM THE NBFC IN PARTS.
//
// The NBFC does not always release a SID bill in one credit: 50 lakh today,
// the other 30 next week. Each leg is money lent from ITS day, so each carries
// its own interest to maturity — a leg that landed later costs less — and only
// what has landed is owed. The first leg is the Payment received itself (the
// bill's opening voucher, first_receipt_part); every later one is a Receipt of
// its own here, under an internal reference (GB10/R2) the bank book and the
// NBFC's advice can be matched against.
// ---------------------------------------------------------------------------

/** On a bill received in parts, what has landed so far; otherwise the whole draw. For SQL over `bd`. */
const DRAWN_SQL = `(CASE WHEN COALESCE(bd.first_receipt_part, 0) > 0
  THEN bd.first_receipt_part + COALESCE((SELECT SUM(rp.amount) FROM bd_receipt_parts rp WHERE rp.bd_id = bd.id), 0)
  ELSE bd.amount END)`

/** Every leg the NBFC released on this bill — the first is the Payment received. */
export async function listBdReceiptParts(bdId: number): Promise<Row[]> {
  const bd = await loadBd(bdId)
  const calc = bdCalc(bd)
  if (!calc.legs.length) return []
  const rows = bd.receipt_parts as Row[]
  return calc.legs.map((l) => {
    const row = l.part_no === 1 ? null : rows.find((r) => n(r.part_no) === l.part_no)
    return {
      ...l,
      ref: l.part_no === 1 ? receiptRef(bd, 1) : String(row?.ref || receiptRef(bd, l.part_no)),
      account: l.part_no === 1 ? String(bd.disbursement_account || '') : String(row?.account || ''),
      note: row?.note || null,
      journal_entry_id: l.part_no === 1 ? n(bd.journal_entry_id) || null : n(row?.journal_entry_id) || null
    }
  })
}

/** The next leg the NBFC released: posted as a Receipt into the bank, its own interest taken. */
export async function receiveBdPart(
  bdId: number,
  v: { date?: string; amount?: number | string; account?: string | null; note?: string | null; maturity?: string | null; interest_pct?: unknown; margin_pct?: unknown }
): Promise<{ id: number; part_no: number; ref: string; interest: number }> {
  return withDbTransaction(async () => addReceiptLeg(bdId, v))
}

async function addReceiptLeg(
  bdId: number,
  v: { date?: string; amount?: number | string; account?: string | null; note?: string | null; maturity?: string | null; interest_pct?: unknown; margin_pct?: unknown }
): Promise<{ id: number; part_no: number; ref: string; interest: number }> {
    const c = getClient()
    const bd = await loadBd(bdId)
    if (!bd.payment_received_date) throw new Error('Mark Payment received first — that records the first part the NBFC released')
    if (!(n(bd.first_receipt_part) > 0.005)) throw new Error('This bill was received in one go — there is nothing left to receive in parts')
    if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — no more parts can be received on it')
    if (n(bd.upfront_interest_journal_entry_id)) {
      throw new Error('The upfront interest has already been settled on this bill — take that back first, so the new part’s interest is in it')
    }
    const amount = round2(n(v.amount))
    if (amount <= 0.005) throw new Error('Enter the amount the NBFC released')
    const date = String(v.date || '').slice(0, 10)
    if (!date) throw new Error('Pick the date the money landed')
    assertNotFuture(date, 'The receipt date')
    // This part's own maturity, else the bill's.
    const maturity = String(v.maturity || '').slice(0, 10) || String(bd.maturity_date || '').slice(0, 10)
    if (maturity && date > maturity) throw new Error('A part cannot be received after its maturity date')
    const own = (x: unknown): number | null => {
      if (x == null || String(x).trim() === '') return null
      const k = Number(x)
      if (!Number.isFinite(k) || k < 0) throw new Error("A part's interest or margin % must be a number, 0 or more")
      return k
    }
    const ratePct = own(v.interest_pct)
    const marginPct = own(v.margin_pct)
    const calc = bdCalc(bd)
    const last = calc.legs[calc.legs.length - 1]
    if (last && date < last.date) {
      throw new Error(`Part ${last.part_no} was received on ${last.date.split('-').reverse().join('-')} — this one cannot be dated before it`)
    }
    if (calc.toReceive <= 0.005) throw new Error('Everything drawn on this bill has already been received')
    if (amount > calc.toReceive + 0.005) throw new Error(`Only ${inr(calc.toReceive)} is still to come on this bill`)
    // A PID paid straight to the supplier: this part goes to them, not to us.
    const toSupplier = String(bd.disbursement_route || '') === 'supplier'
    const account = toSupplier ? partyName(bd) : String(v.account || bd.disbursement_account || '').trim()
    if (!account) throw new Error(toSupplier ? 'Choose the funded supplier' : 'Choose the bank the money landed in')
    const partNo = (last?.part_no || 1) + 1
    const ref = receiptRef(bd, partNo)
    // This leg's own interest, from its day to its maturity, at its own rate
    // (the bill's where it has none) — the same sum bdCalc works.
    const days = maturity ? Math.max(0, daysBetween(date, maturity) + (bd.days_incl_start ? 1 : 0)) : 0
    const daysYear = n(bd.days_year) || 360
    const interest = round2((amount * (ratePct == null ? n(bd.interest_pct) : ratePct) * days) / (100 * daysYear))
    const deducted = !bd.interest_upfront && String(bd.interest_mode || '') !== 'serviced'
    const net = round2(deducted ? amount - interest : amount)
    const lines: JournalLine[] = [{ account, group: toSupplier ? 'Sundry Creditors' : 'Bank Accounts', dr: net }]
    if (deducted && interest > 0.005) lines.push({ account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: interest })
    lines.push({ account: bdPayable(bd), group: BD_PAYABLE_GROUP, cr: amount })
    const je = await postJournal({
      date,
      vchType: toSupplier ? 'JOURNAL' : 'RECEIPT',
      vchNo: ref,
      narration:
        `Bill Discounting ${bd.bd_no || ''} (${bd.finance_type}) — ${bd.nbfc_name || 'the NBFC'} ${toSupplier ? `paid ${account}` : 'released'} part ${partNo} (${ref}): ${amount.toFixed(2)}` +
        (deducted ? `, interest ${interest.toFixed(2)} for ${days} days` : '') +
        (v.note ? ` (${String(v.note).trim()})` : ''),
      companyId: n(bd.company_id) || undefined,
      lines
    })
    if (toSupplier) await allocAgainst(je.id, account, null, net)
    await c.execute({
      sql: `INSERT INTO bd_receipt_parts (bd_id, part_no, receipt_date, amount, interest, account, ref, note, journal_entry_id, maturity_date, interest_pct, margin_pct)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        n(bdId), partNo, date, amount, interest, account, ref, String(v.note || '').trim() || null, je.id,
        String(v.maturity || '').slice(0, 10) || null, ratePct, marginPct
      ]
    })
    return { id: je.id, part_no: partNo, ref, interest }
}

/** Take back the latest leg — never the first, which is the Payment received itself. */
export async function deleteLastBdReceiptPart(bdId: number): Promise<{ part_no: number; ref: string }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const bd = await loadBd(bdId)
    if (String(bd.status) === 'repaid') throw new Error('This bill is repaid — reopen it first')
    const rows = bd.receipt_parts as Row[]
    const row = rows[rows.length - 1]
    if (!row) throw new Error('The first part is the Payment received itself — undo the receipt to change it')
    if (n(bd.upfront_interest_journal_entry_id)) throw new Error('The upfront interest has been settled on this bill — take that back first')
    // What has gone back to the NBFC cannot be more than what it had lent.
    const paid = await repaidSoFar(bd)
    const after = round2(principalDrawn(bd) - n(row.amount))
    if (paid > after + 0.004) {
      throw new Error(`${inr(paid)} has been repaid on this bill — more than the ${inr(after)} that would be left received. Take a repayment back first`)
    }
    await dropEntry(n(row.journal_entry_id) || null)
    await c.execute({ sql: 'DELETE FROM bd_receipt_parts WHERE id = ?', args: [n(row.id)] })
    return { part_no: n(row.part_no), ref: String(row.ref || receiptRef(bd, n(row.part_no))) }
  })
}

// ---------------------------------------------------------------------------
// PAY CUMULATIVE INTEREST — one NBFC, every open bill, one bank voucher.
//
// An NBFC bills its interest for the month across all its bills at once, and it
// is paid with one bank debit. Each bill still services its own days (from the
// day after its last payment, or its receipt day) up to the period's end, at
// its own rate and TDS; the payment is ONE voucher —
//   Dr  Interest on Bill Discounting      Σ gross
//       Cr  TDS on Interest Payable             Σ tds
//       Cr  Bank                                Σ net
// — and every bill gets its own interest-payment row pointing at it, so each
// bill reads as serviced to that date and the voucher reads back to all of them.
// ---------------------------------------------------------------------------
/**
 * THE PERIOD AT A GLANCE (Pay cumulative interest): what the NBFC's bills'
 * interest works out to over the month / range — each bill from the day it
 * accrues, to the day it was repaid if sooner — what was paid for it
 * (interest payments running to a day in the range, and interest paid with a
 * repayment in the range, gross), and what is still pending.
 */
export async function bdPeriodInterestSummary(v: { nbfc_id: number; from_date: string; to_date: string; till_month_end?: boolean }): Promise<Row> {
  const c = getClient()
  const to0 = String(v.to_date || '').slice(0, 10)
  const from = String(v.from_date || '').slice(0, 10)
  if (!n(v.nbfc_id) || !/^\d{4}-\d{2}-\d{2}$/.test(to0) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return { due: 0, paid: 0, pending: 0, bills: [] }
  const cap = interestCap(!!v.till_month_end)
  const to = to0 > cap ? cap : to0
  const bills = (await listBd({ nbfc_id: n(v.nbfc_id) })).filter((b) => !!b.payment_received_date)
  const out: Row[] = []
  for (const b of bills) {
    const bd = await loadBd(n(b.id))
    const mode = String(bd.interest_mode || '') || (bd.interest_upfront ? 'upfront' : 'discounted')
    if (mode === 'discounted') continue
    const received = String(bd.payment_received_date || '').slice(0, 10)
    const A = accrualStart(bd, received)
    const repaid = String(bd.status) === 'repaid' ? String(bd.repaid_date || '').slice(0, 10) : ''
    const f = from < A ? A : from
    const t = repaid && repaid < to ? repaid : to
    let due = 0
    if (f <= t) {
      const calc = bdCalc(bd)
      const daysYear = n(bd.days_year) || 360
      const steps = n(bd.first_receipt_part) > 0.005 ? [] : await principalRepaidByDate(n(b.id))
      const days = daysBetween(f, t) + 1
      due = steps.length
        ? bdInterestParts(calc.interestBase, steps, f, t, n(bd.interest_pct), daysYear).gross
        : round2((calc.interestBase * n(bd.interest_pct) * days) / (100 * daysYear))
    }
    const p1 = await c.execute({
      sql: 'SELECT COALESCE(SUM(gross), 0) AS g FROM bd_interest_payments WHERE bd_id = ? AND substr(to_date, 1, 10) BETWEEN ? AND ?',
      args: [n(b.id), from, to0]
    })
    const p2 = await c.execute({
      sql: 'SELECT COALESCE(SUM(COALESCE(interest, 0) + COALESCE(tds_amount, 0)), 0) AS g FROM bd_repayments WHERE bd_id = ? AND substr(repay_date, 1, 10) BETWEEN ? AND ?',
      args: [n(b.id), from, to0]
    })
    const paid = round2(n(p1.rows[0]?.g) + n(p2.rows[0]?.g))
    if (due <= 0.004 && paid <= 0.004) continue
    out.push({ bd_id: n(b.id), bd_no: b.bd_no, due: round2(due), paid, pending: round2(due - paid) })
  }
  const due = round2(out.reduce((s, x) => s + n(x.due), 0))
  const paid = round2(out.reduce((s, x) => s + n(x.paid), 0))
  return { from, to, due, paid, pending: round2(due - paid), bills: out }
}

export async function bdCumulativeInterest(v: { nbfc_id: number; from_date?: string; to_date: string; till_month_end?: boolean }): Promise<Row[]> {
  const to = String(v.to_date || '').slice(0, 10)
  if (!n(v.nbfc_id) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return []
  const cap = interestCap(!!v.till_month_end)
  const capped = to > cap ? cap : to
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(v.from_date || '')) ? String(v.from_date).slice(0, 10) : '0000-00-00'
  // Repaid bills too: interest up to the day each was repaid is still owed for
  // the months it ran (B1 repaid 10-09 still owes August). A repaid bill with
  // nothing in the period (and nothing paid in it) is left off the list.
  const bills = (await listBd({ nbfc_id: n(v.nbfc_id) })).filter((b) => !!b.payment_received_date)
  const out: Row[] = []
  for (const b of bills) {
    const w = await bdInterestRange(n(b.id), from, capped, !!v.till_month_end)
    if (String(b.status) === 'repaid' && w.blocked && !/^Already paid/.test(String(w.blocked)) && !(w.short_before || []).length) continue
    out.push({
      bd_id: n(b.id),
      bd_no: b.bd_no,
      party: b.party_name || b.receivable_party_name || b.supplier_name || '',
      principal: n(w.interest_base),
      open_amount: n(w.open_amount),
      interest_pct: n(w.interest_pct),
      tds_pct: n(w.tds_pct),
      from_date: w.from_date,
      // A balance is for the stretch paid short, not the whole range.
      to_date: w.balance_of ? String(w.to_date || capped) : capped,
      days: n(w.days),
      gross: n(w.gross),
      tds: n(w.tds),
      net: n(w.net),
      paid_to: w.paid_to || null,
      parts: w.parts || [],
      unpaid_before: w.unpaid_before || null,
      // A stretch picked again that was paid short: this is its balance.
      balance_of: w.balance_of || null,
      // Earlier stretches paid short — their balance still due.
      short_before: w.short_before || [],
      days_year: n(w.days_year),
      blocked: w.blocked || ''
    })
  }
  return out
}

/**
 * POST A CUMULATIVE INTEREST PAYMENT — one PAYMENT voucher (Dr interest / Cr
 * TDS, Cr bank), or, booked through the NBFC, two: a JOURNAL that books the
 * interest as owed to the NBFC (Dr interest / Cr NBFC net, Cr TDS) and a
 * PAYMENT that pays the NBFC (Dr NBFC / Cr bank). With ids given, re-posts
 * them in place (Edit), keeping their numbers.
 */
async function postCumulativeVouchers(v: {
  via_nbfc: boolean
  date: string
  to: string
  first: Row
  nos: string
  count: number
  gross: number
  tds: number
  net: number
  bank: string
  tdsLedger: string
  tdsGroup: string
  note: string
  ids?: { payment: number; journal: number | null }
}): Promise<{ payment: number; journal: number | null }> {
  const head = `Bill Discounting interest to ${v.to} — ${v.first.nbfc_name || 'the NBFC'}, ${v.count} bill${v.count === 1 ? '' : 's'} (${v.nos})`
  const tail = v.note ? ` · ${v.note}` : ''
  const write = async (id: number | null | undefined, a: Parameters<typeof postJournal>[0]): Promise<number> =>
    id ? (await repostJournal(id, a)).id : (await postJournal(a)).id
  const companyId = n(v.first.company_id) || undefined
  if (!v.via_nbfc) {
    const payment = await write(v.ids?.payment, {
      date: v.date,
      vchType: 'PAYMENT',
      vchNo: v.nos.slice(0, 60),
      narration: `Bill Discounting interest to ${v.to} paid to ${v.first.nbfc_name || 'the NBFC'} on ${v.count} bill${v.count === 1 ? '' : 's'} (${v.nos}) — ${inr(v.gross)}` + (v.tds > 0.004 ? `, TDS ${inr(v.tds)} withheld` : '') + tail,
      companyId,
      lines: [
        { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: v.gross },
        ...(v.tds > 0.004 ? [{ account: v.tdsLedger, group: v.tdsGroup, cr: v.tds }] : []),
        { account: v.bank, group: 'Bank Accounts', cr: v.net }
      ]
    })
    // Was booked through the NBFC before: its journal goes.
    if (v.ids?.journal) await dropEntry(v.ids.journal)
    return { payment, journal: null }
  }
  const nbfc = bdPayable(v.first)
  const journal = await write(v.ids?.journal, {
    date: v.date,
    vchType: 'JOURNAL',
    vchNo: v.nos.slice(0, 60),
    narration: `${head} — interest ${inr(v.gross)} booked to the NBFC` + (v.tds > 0.004 ? `, TDS ${inr(v.tds)} to ${v.tdsLedger}` : '') + tail,
    companyId,
    lines: [
      { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: v.gross },
      { account: nbfc, group: BD_PAYABLE_GROUP, cr: v.net },
      ...(v.tds > 0.004 ? [{ account: v.tdsLedger, group: v.tdsGroup, cr: v.tds }] : [])
    ]
  })
  const payment = await write(v.ids?.payment, {
    date: v.date,
    vchType: 'PAYMENT',
    vchNo: v.nos.slice(0, 60),
    narration: `${head} — interest ${inr(v.net)} paid to the NBFC` + tail,
    companyId,
    lines: [
      { account: nbfc, group: BD_PAYABLE_GROUP, dr: v.net },
      { account: v.bank, group: 'Bank Accounts', cr: v.net }
    ]
  })
  return { payment, journal }
}

export async function payBdCumulativeInterest(v: {
  nbfc_id: number
  from_date?: string
  to_date: string
  paid_date?: string
  bank_account?: string | null
  bd_ids: number[]
  // The interest actually paid on a bill, where it is not the worked-out
  // figure (the NBFC's statement says more or less). Keyed by bill id.
  amounts?: Record<string, number | string>
  // The ledger the TDS goes to; blank keeps TDS ON INTEREST PAYABLE A/C.
  tds_ledger?: string | null
  note?: string | null
  // Booked through the NBFC in two vouchers: a JOURNAL (Dr interest / Cr NBFC,
  // Cr TDS) and a PAYMENT (Dr NBFC / Cr bank). Off = the one payment voucher.
  via_nbfc?: boolean
  // Paid up to the end of this month, ahead of today (the NBFC's month-end debit).
  till_month_end?: boolean
}): Promise<{ entry_id: number; bills: number; gross: number; tds: number; net: number }> {
  return withDbTransaction(async () => {
    const to = String(v.to_date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Pick the date the interest is paid up to')
    if (to > interestCap(!!v.till_month_end)) throw new Error(v.till_month_end ? 'Interest can be paid ahead only to the end of this month' : 'Interest cannot be paid for days that have not happened yet')
    const date = String(v.paid_date || to).slice(0, 10)
    if (date > todayISO()) throw new Error('The payment cannot be dated in the future')
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(v.from_date || '')) ? String(v.from_date).slice(0, 10) : '0000-00-00'
    const ids = Array.from(new Set((v.bd_ids || []).map(n).filter((x) => x > 0)))
    if (!ids.length) throw new Error('Tick at least one bill to pay')
    if (!String(v.note || '').trim()) throw new Error('Write a note — it goes into the voucher narration')
    const rows: { bd: Row; w: Row }[] = []
    for (const id of ids) {
      const bd = await loadBd(id)
      if (n(bd.nbfc_id) !== n(v.nbfc_id)) throw new Error(`${bd.bd_no} is with another NBFC`)
      const w = await bdInterestRange(id, from, to, !!v.till_month_end)
      if (w.blocked) throw new Error(`${bd.bd_no}: ${String(w.blocked)}`)
      const typed = v.amounts && String(v.amounts[String(id)] ?? '').trim() !== '' ? round2(n(v.amounts[String(id)])) : null
      if (typed != null) {
        if (!(typed > 0.004)) throw new Error(`${bd.bd_no}: enter the interest being paid`)
        const t = round2((typed * n(bd.tds_pct)) / 100)
        w.gross = typed
        w.tds = t
        w.net = round2(typed - t)
      }
      if (!(n(w.gross) > 0.004)) throw new Error(`${bd.bd_no}: that comes to no interest`)
      rows.push({ bd, w })
    }
    const gross = round2(rows.reduce((t, r) => t + n(r.w.gross), 0))
    const tds = round2(rows.reduce((t, r) => t + n(r.w.tds), 0))
    const net = round2(gross - tds)
    const first = rows[0].bd
    const bank = await bdBankFor(first, v.bank_account)
    const nos = rows.map((r) => String(r.bd.bd_no)).join(', ')
    const tdsLedger = String(v.tds_ledger || '').trim() || 'TDS ON INTEREST PAYABLE A/C'
    const tdsGroup = tdsLedger === 'TDS ON INTEREST PAYABLE A/C'
      ? 'Duties & Taxes'
      : String(((await getClient().execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?', args: [tdsLedger] })).rows[0] as Row | undefined)?.acc_group || 'Duties & Taxes')
    const posted = await postCumulativeVouchers({
      via_nbfc: !!v.via_nbfc,
      date,
      to,
      first,
      nos,
      count: rows.length,
      gross,
      tds,
      net,
      bank,
      tdsLedger,
      tdsGroup,
      note: String(v.note || '')
    })
    const je = { id: posted.payment }
    for (const r of rows) {
      await getClient().execute({
        sql: `INSERT INTO bd_interest_payments (bd_id, from_date, to_date, days, paid_date, gross, tds, net, note, journal_entry_id, bank_account, interest_entry_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [n(r.bd.id), String(r.w.from_date), String(r.w.to_date || to), n(r.w.days), date, n(r.w.gross), n(r.w.tds), n(r.w.net), (r.w.balance_of ? 'Balance of short-paid interest — ' : 'Cumulative interest — ') + `one voucher with ${nos}`, je.id, bank, posted.journal]
      })
    }
    return { entry_id: je.id, bills: rows.length, gross, tds, net }
  })
}

/* -------------------------------------------------------------------------- */
/* Interest refunds — one bank receipt from the NBFC, mapped over its bills    */
/* -------------------------------------------------------------------------- */

// Which receipt brought back how much of which bill's early-repayment interest.
// The receipt is already in the books (Tally / bank); this only links it.
async function ensureBdRefunds(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS bd_interest_refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bd_id INTEGER NOT NULL,
    journal_entry_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`)
  // A bill's refund closed fully — the NBFC paid less and the rest is let go.
  // journal_entry_id: the receipt it was closed with (unlinking that receipt reopens it).
  // The vouchers that go with a refund receipt: the interest-income journal
  // (NBFC Dr / income Cr) — posted here (journal_made) or found in the books —
  // and whether the receipt itself was booked here (New receipt, receipt_made).
  await getClient().execute(`CREATE TABLE IF NOT EXISTS bd_refund_vouchers (
    receipt_id INTEGER PRIMARY KEY,
    journal_id INTEGER,
    journal_made INTEGER NOT NULL DEFAULT 0,
    receipt_made INTEGER NOT NULL DEFAULT 0
  )`)
  await getClient().execute(`CREATE TABLE IF NOT EXISTS bd_refund_closures (
    bd_id INTEGER PRIMARY KEY,
    journal_entry_id INTEGER,
    note TEXT,
    closed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`)
}

/** Close bills' refunds fully: what came back is all that will; nothing more is due. */
export async function closeBdRefunds(v: { bd_ids: number[]; note?: string }): Promise<{ closed: number }> {
  await ensureBdRefunds()
  const ids = [...new Set((v.bd_ids || []).map(n).filter((x) => x > 0))]
  if (!ids.length) throw new Error('Pick the bill(s) to close')
  for (const id of ids) {
    await loadBd(id)
    await getClient().execute({
      sql: 'INSERT OR REPLACE INTO bd_refund_closures (bd_id, journal_entry_id, note, closed_at) VALUES (?, NULL, ?, CURRENT_TIMESTAMP)',
      args: [id, String(v.note || '').trim() || null]
    })
  }
  return { closed: ids.length }
}

/** Reopen a closed refund — its short part is due again. */
export async function reopenBdRefund(bdId: number): Promise<{ bd_id: number }> {
  await ensureBdRefunds()
  await getClient().execute({ sql: 'DELETE FROM bd_refund_closures WHERE bd_id = ?', args: [n(bdId)] })
  return { bd_id: n(bdId) }
}

/** Bank receipts that could be an NBFC's refund — the LC picker's search, money in. */
export async function bdRefundCandidates(v: { q?: string; since?: string; from?: string; to?: string; expected?: number; ledgerId?: number }): Promise<Row[]> {
  const { pickBankVouchers } = await import('./lc')
  // `since` (the earliest early repayment) only sets the browsing window — bank
  // receipts from a month before it; dates picked on the screen widen to every voucher.
  const list = await pickBankVouchers({
    lcId: 0,
    companyId: getActiveCompanyId(),
    from: String(v.since || '').slice(0, 10),
    dir: 'in',
    expected: n(v.expected),
    q: v.q,
    ledgerId: n(v.ledgerId) || undefined,
    range: { from: v.from, to: v.to }
  })
  // What of each receipt is already mapped to refunds.
  await ensureBdRefunds()
  const used = toPlain(await getClient().execute('SELECT journal_entry_id, ROUND(SUM(amount), 2) AS used FROM bd_interest_refunds GROUP BY journal_entry_id'))
  const usedOf = new Map<number, number>(used.map((r) => [n(r.journal_entry_id), n(r.used)]))
  return list.map((r) => ({ ...r, used: usedOf.get(n(r.id)) || 0 }))
}

/** Map one bank receipt over several bills' refunds. */
export async function linkBdRefund(v: { journal_entry_id: number; parts: { bd_id: number; amount: number }[]; close_ids?: number[]; note?: string; income_ledger?: string | null }): Promise<{ entry_id: number; bills: number; amount: number; journal?: { journal_id: number | null; adopted: boolean } }> {
  return withDbTransaction(async () => {
    await ensureBdRefunds()
    const c = getClient()
    const je = (await c.execute({ sql: 'SELECT id, company_id FROM journal_entries WHERE id = ?', args: [n(v.journal_entry_id)] })).rows[0] as unknown as Row | undefined
    if (!je) throw new Error('That bank receipt no longer exists')
    const parts = (v.parts || []).map((p) => ({ bd_id: n(p.bd_id), amount: round2(n(p.amount)) })).filter((p) => p.bd_id > 0 && p.amount > 0.004)
    if (!parts.length) throw new Error('Tick at least one bill and give it an amount')
    for (const p of parts) {
      const bd = await loadBd(p.bd_id)
      if (n(bd.company_id) !== n(je.company_id)) throw new Error(`${bd.bd_no} is in another company than the receipt`)
      await c.execute({ sql: 'INSERT INTO bd_interest_refunds (bd_id, journal_entry_id, amount) VALUES (?, ?, ?)', args: [p.bd_id, n(je.id), p.amount] })
    }
    // Received less and closed fully: these bills' refunds end with this receipt.
    for (const id of [...new Set((v.close_ids || []).map(n).filter((x) => parts.some((p) => p.bd_id === x)))]) {
      await c.execute({
        sql: 'INSERT OR REPLACE INTO bd_refund_closures (bd_id, journal_entry_id, note, closed_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        args: [id, n(je.id), String(v.note || '').trim() || null]
      })
    }
    // Stage 1 for a receipt from the books (asked for with income_ledger).
    const journal = v.income_ledger ? await bookBdRefundIncome(n(je.id), v.income_ledger) : undefined
    return { entry_id: n(je.id), bills: parts.length, amount: round2(parts.reduce((t, p) => t + p.amount, 0)), journal }
  })
}

/**
 * STAGE 1 FOR A RECEIPT ALREADY IN THE BOOKS. A refund receipt from Tally is
 * Bank Dr / NBFC Cr; the interest it brings back still has to reach income:
 * JOURNAL NBFC Dr / interest income Cr, for what is mapped off the receipt.
 * A journal already in the books for it (same company, NBFC Dr / an income
 * ledger Cr, the same amount, not tied to another receipt) is adopted rather
 * than posted twice. Only a receipt that credits the bills' NBFC ledger gets one.
 */
export async function bookBdRefundIncome(receiptId: number, incomeLedger?: string): Promise<{ journal_id: number | null; adopted: boolean; amount: number }> {
  await ensureBdRefunds()
  const c = getClient()
  const rid = n(receiptId)
  const je = (await c.execute({ sql: 'SELECT id, company_id, entry_date FROM journal_entries WHERE id = ?', args: [rid] })).rows[0] as unknown as Row | undefined
  if (!je) throw new Error('That bank receipt no longer exists')
  const parts = toPlain(await c.execute({ sql: 'SELECT bd_id, amount FROM bd_interest_refunds WHERE journal_entry_id = ?', args: [rid] }))
  const amount = round2(parts.reduce((t, p) => t + n(p.amount), 0))
  if (!parts.length || !(amount > 0.004)) return { journal_id: null, adopted: false, amount: 0 }
  const first = await loadBd(n(parts[0].bd_id))
  const nbfc = bdPayable(first)
  const creditsNbfc = (
    await c.execute({
      sql: `SELECT 1 FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? AND jl.cr > 0 AND UPPER(a.name) = ?`,
      args: [rid, nbfc.toUpperCase()]
    })
  ).rows.length > 0
  if (!creditsNbfc) return { journal_id: null, adopted: false, amount }
  const cur = (await c.execute({ sql: 'SELECT * FROM bd_refund_vouchers WHERE receipt_id = ?', args: [rid] })).rows[0] as unknown as Row | undefined
  const curJv = cur?.journal_id && (await c.execute({ sql: 'SELECT 1 FROM journal_entries WHERE id = ?', args: [n(cur.journal_id)] })).rows.length ? n(cur.journal_id) : 0
  const income = String(incomeLedger || '').trim().toUpperCase() || 'INTEREST INCOME'
  const incomeGroup = String((await c.execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE UPPER(name) = ?', args: [income] })).rows[0]?.acc_group || 'Indirect Incomes')
  const lines = [
    { account: nbfc, group: BD_PAYABLE_GROUP, dr: amount },
    { account: income, group: incomeGroup, cr: amount }
  ]
  const nos = (await Promise.all(parts.map(async (p) => String((await loadBd(n(p.bd_id))).bd_no)))).join(', ')
  const narration = `Interest refund on early repayment — ${first.nbfc_name || 'the NBFC'}, ${parts.length} bill${parts.length === 1 ? '' : 's'} (${nos}) ${inr(amount)} — booked to interest income`
  if (curJv) {
    // Ours: kept at what is mapped now. Adopted from the books: left as it is.
    if (n(cur!.journal_made)) await repostJournal(curJv, { date: String(je.entry_date).slice(0, 10), vchType: 'JOURNAL', vchNo: nos.slice(0, 60), narration, companyId: n(je.company_id), lines })
    return { journal_id: curJv, adopted: !n(cur!.journal_made), amount }
  }
  // One already in the books (keyed in Tally, or left behind by an unlink)?
  const found = (
    await c.execute({
      sql: `SELECT je.id FROM journal_entries je
             WHERE je.company_id = ? AND UPPER(je.vch_type) LIKE 'JOURNAL%'
               AND EXISTS (SELECT 1 FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                            WHERE jl.entry_id = je.id AND UPPER(a.name) = ? AND ABS(jl.dr - ?) < 0.01)
               AND EXISTS (SELECT 1 FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                            WHERE jl.entry_id = je.id AND jl.cr > 0 AND UPPER(COALESCE(a.acc_group, '')) LIKE '%INCOME%')
               AND NOT EXISTS (SELECT 1 FROM bd_refund_vouchers v WHERE v.journal_id = je.id AND v.receipt_id <> ?)
             ORDER BY ABS(julianday(je.entry_date) - julianday(?)), je.id LIMIT 1`,
      args: [n(je.company_id), nbfc.toUpperCase(), amount, rid, String(je.entry_date).slice(0, 10)]
    })
  ).rows[0] as unknown as Row | undefined
  if (found) {
    await c.execute({
      sql: `INSERT INTO bd_refund_vouchers (receipt_id, journal_id, journal_made, receipt_made) VALUES (?, ?, 0, COALESCE((SELECT receipt_made FROM bd_refund_vouchers WHERE receipt_id = ?), 0))
            ON CONFLICT(receipt_id) DO UPDATE SET journal_id = excluded.journal_id, journal_made = 0`,
      args: [rid, n(found.id), rid]
    })
    return { journal_id: n(found.id), adopted: true, amount }
  }
  const made = await postJournal({ date: String(je.entry_date).slice(0, 10), vchType: 'JOURNAL', vchNo: nos.slice(0, 60), narration, companyId: n(je.company_id), lines })
  await c.execute({
    sql: `INSERT INTO bd_refund_vouchers (receipt_id, journal_id, journal_made, receipt_made) VALUES (?, ?, 1, COALESCE((SELECT receipt_made FROM bd_refund_vouchers WHERE receipt_id = ?), 0))
          ON CONFLICT(receipt_id) DO UPDATE SET journal_id = excluded.journal_id, journal_made = 1`,
    args: [rid, made.id, rid]
  })
  return { journal_id: made.id, adopted: false, amount }
}

/**
 * The refund is not in the books yet: book it from here in two entries, the
 * way the desk does in Tally, then map the receipt over the bills.
 *   1. JOURNAL  — NBFC (BILLS DISCOUNTED - <NBFC>) Dr  /  interest income Cr
 *   2. RECEIPT  — bank Dr  /  NBFC Cr
 */
export async function createBdRefundReceipt(v: {
  date: string
  bank: string
  income_ledger: string
  note?: string
  parts: { bd_id: number; amount: number }[]
  close_ids?: number[]
}): Promise<{ entry_id: number; journal_id: number; bills: number; amount: number }> {
  return withDbTransaction(async () => {
    await ensureBdRefunds()
    const date = String(v.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the date the refund came in')
    if (date > todayISO()) throw new Error('The receipt cannot be dated in the future')
    const bank = String(v.bank || '').trim()
    if (!bank) throw new Error('Pick the bank it came into')
    const income = String(v.income_ledger || '').trim().toUpperCase()
    if (!income) throw new Error('Pick the interest income ledger')
    const parts = (v.parts || []).map((p) => ({ bd_id: n(p.bd_id), amount: round2(n(p.amount)) })).filter((p) => p.bd_id > 0 && p.amount > 0.004)
    if (!parts.length) throw new Error('Tick at least one bill and give it an amount')
    const bds = [] as Row[]
    for (const p of parts) bds.push(await loadBd(p.bd_id))
    const first = bds[0]
    if (bds.some((b) => n(b.nbfc_id) !== n(first.nbfc_id))) throw new Error('One receipt books one NBFC — tick bills of the same NBFC')
    if (bds.some((b) => n(b.company_id) !== n(first.company_id))) throw new Error('The bills are in different companies')
    const amount = round2(parts.reduce((t, p) => t + p.amount, 0))
    const nos = bds.map((b) => String(b.bd_no)).join(', ')
    const nbfc = bdPayable(first)
    const c = getClient()
    const groupOf = async (name: string, dflt: string): Promise<string> =>
      String((await c.execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE UPPER(name) = ?', args: [name.toUpperCase()] })).rows[0]?.acc_group || dflt)
    const bankGroup = await groupOf(bank, 'Bank Accounts')
    const incomeGroup = await groupOf(income, 'Indirect Incomes')
    const tail = String(v.note || '').trim() ? ` · ${String(v.note).trim()}` : ''
    const companyId = n(first.company_id) || undefined
    const head = `Interest refund on early repayment — ${first.nbfc_name || 'the NBFC'}, ${bds.length} bill${bds.length === 1 ? '' : 's'} (${nos}) ${inr(amount)}`
    const journal = await postJournal({
      date,
      vchType: 'JOURNAL',
      vchNo: nos.slice(0, 60),
      narration: `${head} — booked to interest income${tail}`,
      companyId,
      lines: [
        { account: nbfc, group: BD_PAYABLE_GROUP, dr: amount },
        { account: income, group: incomeGroup, cr: amount }
      ]
    })
    const receipt = await postJournal({
      date,
      vchType: 'RECEIPT',
      vchNo: nos.slice(0, 60),
      narration: `${head} — received from the NBFC${tail}`,
      companyId,
      lines: [
        { account: bank, group: bankGroup, dr: amount },
        { account: nbfc, group: BD_PAYABLE_GROUP, cr: amount }
      ]
    })
    await linkBdRefund({ journal_entry_id: receipt.id, parts, close_ids: v.close_ids, note: v.note })
    await getClient().execute({
      sql: 'INSERT OR REPLACE INTO bd_refund_vouchers (receipt_id, journal_id, journal_made, receipt_made) VALUES (?, ?, 1, 1)',
      args: [receipt.id, journal.id]
    })
    return { entry_id: receipt.id, journal_id: journal.id, bills: parts.length, amount }
  })
}

/** Unlink a receipt from every bill it was mapped to. Nothing in the books changes. */
export async function unlinkBdRefund(entryId: number): Promise<{ entry_id: number; dropped: number }> {
  await ensureBdRefunds()
  return withDbTransaction(async () => {
    const c = getClient()
    const rid = n(entryId)
    await c.execute({ sql: 'DELETE FROM bd_interest_refunds WHERE journal_entry_id = ?', args: [rid] })
    // A close made with this receipt goes with it.
    await c.execute({ sql: 'DELETE FROM bd_refund_closures WHERE journal_entry_id = ?', args: [rid] })
    // The vouchers this window booked for it go too: the income journal it
    // posted, and the receipt itself when New receipt made it. A receipt or
    // journal that came from the books stays.
    let dropped = 0
    const v = (await c.execute({ sql: 'SELECT * FROM bd_refund_vouchers WHERE receipt_id = ?', args: [rid] })).rows[0] as unknown as Row | undefined
    if (v) {
      if (n(v.journal_made) && n(v.journal_id)) {
        await dropEntry(n(v.journal_id))
        dropped++
      }
      if (n(v.receipt_made)) {
        await dropEntry(rid)
        dropped++
      }
      await c.execute({ sql: 'DELETE FROM bd_refund_vouchers WHERE receipt_id = ?', args: [rid] })
    }
    return { entry_id: rid, dropped }
  })
}

/** The receipts mapped so far, each with the bills it covered. */
export async function listBdRefunds(): Promise<Row[]> {
  await ensureBdRefunds()
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT f.*, b.bd_no, nb.name AS nbfc_name, je.entry_date, je.vch_no, je.narration,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
              FROM bd_interest_refunds f
              JOIN bill_discountings b ON b.id = f.bd_id
              JOIN journal_entries je ON je.id = f.journal_entry_id
              LEFT JOIN nbfcs nb ON nb.id = b.nbfc_id
             WHERE b.company_id = ?
             ORDER BY je.entry_date DESC, f.journal_entry_id DESC, f.id`,
      args: [getActiveCompanyId()]
    })
  )
  const groups = new Map<number, Row>()
  for (const r of rows) {
    const k = n(r.journal_entry_id)
    if (!groups.has(k)) groups.set(k, { journal_entry_id: k, date: String(r.entry_date || '').slice(0, 10), code: r.code || r.vch_no || '', narration: r.narration || '', nbfcs: [] as string[], bills: [] as Row[], amount: 0, income: null as Row | null, receipt_made: false })
    const g = groups.get(k)!
    ;(g.bills as Row[]).push({ bd_id: n(r.bd_id), bd_no: r.bd_no, amount: n(r.amount) })
    if (r.nbfc_name && !(g.nbfcs as string[]).includes(String(r.nbfc_name))) (g.nbfcs as string[]).push(String(r.nbfc_name))
    g.amount = round2(n(g.amount) + n(r.amount))
  }
  // Each receipt's income journal (stage 1), when it has one.
  for (const g of groups.values()) {
    const v = (
      await getClient().execute({
        sql: `SELECT v.journal_id, v.journal_made, v.receipt_made, (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = v.journal_id) AS code
                FROM bd_refund_vouchers v JOIN journal_entries je ON je.id = v.journal_id WHERE v.receipt_id = ?`,
        args: [n(g.journal_entry_id)]
      })
    ).rows[0] as unknown as Row | undefined
    g.income = v ? { journal_id: n(v.journal_id), code: v.code || '', made: !!n(v.journal_made) } : null
    g.receipt_made = !!(v && n(v.receipt_made))
  }
  return [...groups.values()]
}
