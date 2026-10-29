/**
 * THE PAYMENT TRACKER — every rupee Treasury expects to move on a date, in one
 * list: what goes out to a bank or an NBFC, and what comes back in.
 *
 * It used to list LC bills and discounted bills and stop there, and on the LC
 * side it listed the wrong thing. An LC "bill" (lc_issuances) is the bank
 * paying the SUPPLIER, and it is marked settled the day that happens — so
 * every LC on the books showed as settled within a week of opening, and not
 * one rupee still owed to a bank at maturity appeared on the list at all.
 *
 * What is actually owed, and when:
 *
 *   LC maturity    the open amount back to the bank on the maturity date, for
 *                  every LC the bank has paid out on and nobody has repaid
 *   BD repayment   the bill's outstanding principal back to the NBFC on its
 *                  maturity date
 *   BD interest    a serviced bill's interest, rest by rest on the schedule
 *                  the lender bills it on; or an upfront bill's interest not
 *                  yet recorded
 *   Payment IN     money coming back on a facility — the resale invoices a
 *                  trading LC or bill financed, or the term the facility names
 *   Margin release a bill's margin, back once the bill is cleared
 *
 * Nothing here is stored. Every row is derived from the facility it belongs
 * to, so it cannot disagree with the LC and BD registers, and it settles
 * itself the moment the voucher that settles it is posted there — which is
 * why the tracker's buttons open those registers' own screens rather than
 * ticking a box of their own.
 */
import { todayISO } from './db'
import { listLCs } from './lc'
import { bdCalc, bdInterestSchedule, listBd, listBdInterestPayments } from './billDiscounting'
import { listBdOpenTradingInvoices, listLcOpenTradingInvoices } from './treasury'

type Row = Record<string, unknown>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100
const day10 = (v: unknown): string => String(v ?? '').slice(0, 10)
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((b - a) / 86400000)
}

function shiftDay(iso: string, by: number): string {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + by)
  return t.toISOString().slice(0, 10)
}

const fmt = (iso: string): string => (isDay(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '')
const inr = (v: number): string =>
  '₹' + r2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// The facility's start plus its agreed days — payInDueDate on the screens and
// in the daily position, restated here so the three agree.
function payInDue(r: Row): string | null {
  const days = n(r.payment_in_days)
  if (!(days > 0)) return null
  const from = day10(r.opened_date || r.payment_received_date || r.open_date || r.created_at)
  return isDay(from) ? shiftDay(from, days) : null
}

export type TrackerKind = 'lc_mat' | 'bd_mat' | 'bd_int' | 'pay_in' | 'margin'
// What the row's button opens. The tracker never settles anything itself.
export type TrackerAction = 'repay' | 'preclose' | 'interest' | 'payin' | 'open'

type Item = {
  key: string
  kind: TrackerKind
  dir: 'out' | 'in'
  ref: string
  party: string
  lender: string
  detail: string
  amount: number
  due_date: string | null
  settled: boolean
  settled_date: string | null
  src: 'lc' | 'bd'
  src_id: number
  action: TrackerAction
}

// ── LETTERS OF CREDIT ─────────────────────────────────────────────────────
async function lcItems(): Promise<Item[]> {
  const out: Item[] = []
  const lcs = await listLCs().catch(() => [] as Row[])
  for (const l of lcs) {
    if (String(l.facility_type || 'lc') !== 'lc') continue
    // Only once the bank has paid under the credit is anything owed to it.
    if (String(l.stage || '') !== 'payment_received') continue
    const id = n(l.id)
    const ref = String(l.lc_no || '').trim() || 'LC (no number)'
    const lender = String(l.bank_name || l.bank || '').trim()
    const supplier = String(l.supplier_name || '').trim()
    const maturity = day10(l.expiry_date)
    const drawn = day10(l.payment_received_date)
    const principal = r2(n(l.amount))
    const repaid = r2(n(l.repaid_principal))
    const preclosed = day10(l.preclosed_date)

    // What the bank wants back: the open amount, less any principal already
    // repaid. Interest and commission were taken when the bank paid out (or
    // paid upfront from our account), so nothing else falls due here.
    const owed = r2(principal - repaid)
    if (preclosed || owed > 0.5) {
      const usance = n(l.usance_days)
      out.push({
        key: `lc-mat-${id}`,
        kind: 'lc_mat',
        dir: 'out',
        ref,
        party: supplier,
        lender,
        detail:
          (usance > 0 && drawn ? `Usance ${usance} days from ${fmt(drawn)}` : drawn ? `Paid out ${fmt(drawn)}` : 'LC') +
          (repaid > 0.5 && !preclosed ? ` · ${inr(repaid)} already repaid` : '') +
          (String(l.purpose || '') === 'trading' ? ' · trading' : ''),
        amount: preclosed ? principal : owed,
        due_date: isDay(maturity) ? maturity : null,
        settled: !!preclosed,
        settled_date: preclosed || null,
        src: 'lc',
        src_id: id,
        // Same action either way: before maturity it is called Preclose.
        action: !preclosed && isDay(maturity) && todayISO() < maturity ? 'preclose' : preclosed ? 'open' : 'repay'
      })
    }

    // Money back on the LC. A trading LC is paid back by the resale invoices
    // it financed; any other LC only if it names a term for it.
    const trading = String(l.purpose || '') === 'trading'
    const back = r2(n(l.payment_in_total))
    if (trading) {
      const open: Row[] = await listLcOpenTradingInvoices(id).catch(() => [])
      const due = r2(open.reduce((t, x) => t + n(x.due), 0))
      if (due > 0.5 || back > 0.5) {
        const names = Array.from(new Set(open.map((x) => String(x.customer_name || '').trim()).filter(Boolean)))
        const invs = open.map((x) => String(x.invoice_no || '')).filter(Boolean)
        out.push({
          key: `lc-in-${id}`,
          kind: 'pay_in',
          dir: 'in',
          ref,
          party: names.join(', ') || String(l.receivable_party_name || '').trim() || supplier,
          lender,
          detail:
            due > 0.5
              ? `Resale ${invs.length === 1 ? 'invoice' : 'invoices'} ${invs.slice(0, 3).join(', ')}${invs.length > 3 ? ` +${invs.length - 3}` : ''} still owe this` +
                (back > 0.5 ? ` · ${inr(back)} in so far` : '')
              : `Resale paid in full · ${inr(back)} received`,
          amount: due > 0.5 ? due : back,
          due_date: payInDue(l),
          settled: !(due > 0.5),
          settled_date: null,
          src: 'lc',
          src_id: id,
          action: due > 0.5 ? 'payin' : 'open'
        })
      }
    } else if (n(l.payment_in_expected)) {
      const still = r2(Math.max(0, principal - back))
      out.push({
        key: `lc-in-${id}`,
        kind: 'pay_in',
        dir: 'in',
        ref,
        party: String(l.receivable_party_name || '').trim() || supplier,
        lender,
        detail: back > 0.5 ? `${inr(back)} in so far` : n(l.payment_in_days) > 0 ? `${n(l.payment_in_days)} days from the LC` : 'No term set for the money back',
        amount: still > 0.5 ? still : back,
        due_date: payInDue(l),
        settled: !(still > 0.5),
        settled_date: null,
        src: 'lc',
        src_id: id,
        action: still > 0.5 ? 'payin' : 'open'
      })
    }
  }
  return out
}

// ── BILL DISCOUNTING ──────────────────────────────────────────────────────
async function bdItems(): Promise<Item[]> {
  const out: Item[] = []
  const bills = await listBd().catch(() => [] as Row[])
  for (const b of bills) {
    const id = n(b.id)
    const received = day10(b.payment_received_date)
    // Awaiting the NBFC's money: nothing is owed on it yet.
    if (!received) continue
    const ref = String(b.bd_no || '').trim() || `BD ${id}`
    const lender = String(b.nbfc_name || '').trim()
    const party = String(b.party_names || b.party_name || '').trim()
    const maturity = day10(b.maturity_date)
    const repaid = String(b.status) === 'repaid'
    const calc = bdCalc(b)
    const mode = String(b.interest_mode || '') || (b.interest_upfront ? 'upfront' : 'discounted')
    const type = String(b.finance_type || '').trim()
    const modeWord = mode === 'serviced' ? 'interest serviced' : mode === 'upfront' ? 'interest upfront' : 'interest discounted'

    // The principal back to the NBFC.
    const owed = r2(n(b.outstanding_amount))
    if (repaid || owed > 0.5) {
      out.push({
        key: `bd-mat-${id}`,
        kind: 'bd_mat',
        dir: 'out',
        ref,
        party,
        lender,
        detail:
          [type, modeWord, calc.intDays > 0 ? `${calc.intDays} days from ${fmt(received)}` : ''].filter(Boolean).join(' · ') +
          (n(b.repaid_total) > 0.5 && !repaid ? ` · ${inr(n(b.repaid_total))} already repaid` : ''),
        amount: repaid ? r2(n(b.repaid_total) || n(b.amount)) : owed,
        due_date: isDay(maturity) ? maturity : null,
        settled: repaid,
        settled_date: repaid ? day10(b.repaid_date) || day10(b.last_repay_date) || null : null,
        src: 'bd',
        src_id: id,
        action: repaid ? 'open' : 'repay'
      })
    }

    // Interest paid up front, per the bill's terms, but not recorded yet.
    if (mode === 'upfront' && calc.interestAmount > 0.005) {
      const paid = !!n(b.upfront_interest_journal_entry_id)
      out.push({
        key: `bd-upint-${id}`,
        kind: 'bd_int',
        dir: 'out',
        ref,
        party,
        lender,
        detail: `Upfront interest · gross ${inr(calc.interestAmount)}, TDS ${inr(calc.tdsAmount)}` + (paid ? '' : ' · not recorded yet'),
        amount: r2(calc.netInterest),
        due_date: received,
        settled: paid,
        settled_date: paid ? day10(b.upfront_interest_paid_date) || null : null,
        src: 'bd',
        src_id: id,
        action: 'open'
      })
    }

    // A serviced bill's interest, rest by rest. Interest is paid "up to a
    // date", not per rest, so a rest is settled once the payments reach its
    // last day, and one they reach into is owed only for the days after.
    if (mode === 'serviced') {
      const sched = await bdInterestSchedule(id).catch(() => [] as Row[])
      const pays = sched.length ? await listBdInterestPayments(id).catch(() => [] as Row[]) : []
      const paidTo = day10(b.interest_paid_to)
      const open = n(calc.interestBase)
      const rate = n(b.interest_pct)
      const year = n(b.days_year) || 360
      const tdsPct = n(b.tds_pct)
      const repaidOn = day10(b.repaid_date)
      for (const s of sched) {
        const from = day10(s.from_date)
        const to = day10(s.to_date)
        // Repaid early: rests that start after the money went back are not owed.
        if (repaid && repaidOn && from > repaidOn) continue
        // Paid with a repayment (bdInterestWithRepayments) is settled too.
        const covered = (!!paidTo && paidTo >= to) || (s.mode === 'with_repayment' && !!s.paid_id)
        let gross = n(s.gross)
        let days = n(s.days)
        if (!covered && paidTo && paidTo >= from) {
          days = Math.max(0, daysBetween(paidTo, to))
          gross = r2((open * rate * days) / (100 * year))
        }
        const tds = r2((gross * tdsPct) / 100)
        const net = r2(gross - tds)
        if (!covered && net < 0.5) continue
        const settledBy = covered ? pays.find((p) => day10(p.to_date) >= to) : undefined
        out.push({
          key: `bd-int-${id}-${n(s.seq)}`,
          kind: 'bd_int',
          dir: 'out',
          ref,
          party,
          lender,
          detail:
            `Rest ${n(s.seq)} of ${sched.length} · ${fmt(from)} → ${fmt(to)}, ${days} days · gross ${inr(gross)}, TDS ${inr(tds)}` +
            (repaid && !covered ? ' · bill repaid, interest not recorded' : ''),
          amount: covered ? r2(n(s.net)) : net,
          due_date: to,
          settled: covered,
          settled_date: settledBy ? day10(settledBy.paid_date) || null : null,
          src: 'bd',
          src_id: id,
          action: covered ? 'open' : 'interest'
        })
      }
    }

    // Money back on the bill.
    const back = r2(n(b.payment_in_total))
    if (String(b.purpose || '') === 'trading') {
      const openInv: Row[] = await listBdOpenTradingInvoices(id).catch(() => [])
      const due = r2(openInv.reduce((t, x) => t + n(x.due), 0))
      if (due > 0.5 || back > 0.5) {
        const invs = openInv.map((x) => String(x.invoice_no || '')).filter(Boolean)
        out.push({
          key: `bd-in-${id}`,
          kind: 'pay_in',
          dir: 'in',
          ref,
          party: String(b.receivable_party_name || '').trim() || party,
          lender,
          detail:
            due > 0.5
              ? `Resale ${invs.length === 1 ? 'invoice' : 'invoices'} ${invs.slice(0, 3).join(', ')}${invs.length > 3 ? ` +${invs.length - 3}` : ''} still owe this` +
                (back > 0.5 ? ` · ${inr(back)} in so far` : '')
              : `Resale paid in full · ${inr(back)} received`,
          amount: due > 0.5 ? due : back,
          due_date: payInDue(b),
          settled: !(due > 0.5),
          settled_date: due > 0.5 ? null : day10(b.payment_in_last_date) || null,
          src: 'bd',
          src_id: id,
          action: due > 0.5 ? 'payin' : 'open'
        })
      }
    } else if (n(b.payment_in_expected)) {
      // What comes back is what was DRAWN on the bill, not its invoice value.
      const still = r2(Math.max(0, n(b.amount) - back))
      out.push({
        key: `bd-in-${id}`,
        kind: 'pay_in',
        dir: 'in',
        ref,
        party: String(b.receivable_party_name || '').trim() || party,
        lender,
        detail:
          back > 0.5 && still > 0.5
            ? `${inr(back)} in so far`
            : still > 0.5
              ? n(b.payment_in_days) > 0
                ? `${n(b.payment_in_days)} days from the bill`
                : 'No term set for the money back'
              : `${inr(back)} received`,
        amount: still > 0.5 ? still : back,
        due_date: payInDue(b),
        settled: !(still > 0.5),
        settled_date: still > 0.5 ? null : day10(b.payment_in_last_date) || null,
        src: 'bd',
        src_id: id,
        action: still > 0.5 ? 'payin' : 'open'
      })
    }

    // The margin the NBFC held back, released once the bill is cleared.
    if (n(calc.marginAmount) > 0.5) {
      const released = !!n(b.margin_release_journal_entry_id)
      out.push({
        key: `bd-margin-${id}`,
        kind: 'margin',
        dir: 'in',
        ref,
        party,
        lender,
        detail: `${n(b.margin_pct)}% margin comes back once ${ref} is repaid`,
        amount: r2(n(calc.marginAmount)),
        due_date: isDay(maturity) ? maturity : null,
        settled: released,
        settled_date: released ? day10(b.repaid_date) || null : null,
        src: 'bd',
        src_id: id,
        action: repaid ? 'open' : 'repay'
      })
    }
  }
  return out
}

export async function listPaymentTracker(): Promise<Row[]> {
  const today = todayISO()
  const items = [...(await lcItems()), ...(await bdItems())]
  const rows = items.map((x) => {
    const daysLeft = x.due_date ? daysBetween(today, x.due_date) : null
    return { ...x, days_left: daysLeft, overdue: !x.settled && daysLeft != null && daysLeft < 0 }
  })
  rows.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1
    const ad = a.days_left ?? Infinity
    const bd = b.days_left ?? Infinity
    return ad - bd || b.amount - a.amount
  })
  return rows
}
