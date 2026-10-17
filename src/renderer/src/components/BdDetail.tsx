import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useDrawerEscape } from '@/lib/escape'
// THE BILL, OPENED OUT.
// -----------------------------------------------------------------------------
// Clicking a row used to unfold a strip of four cards underneath it. That was
// the right instinct — keep the answer beside the question — and the wrong
// shape: the four figures are the smallest part of what a bill is, and a strip
// wedged between two rows has nowhere to put the rest of it. Where the money
// actually went, when the bill moves, what was agreed, what has been repaid:
// none of that fits under a row, and all of it is what somebody opens a bill
// to find out.
//
// So it is a panel from the right, built to the Treasury canvas: a forest
// header carrying the bill's identity, a body of cards down the middle, and a
// footer holding the actions. The register stays visible behind the scrim, so
// the bill can still be read against the ones around it.
//
// On a phone it is the same panel full-width with the same order, because the
// order IS the explanation — identity, money, where it went, when, terms,
// repayment — and re-cutting it for a small screen would break the argument.
import { useEffect } from 'react'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  Check,
  CircleDollarSign,
  Info,
  Landmark,
  Pencil,
  Percent,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { adjKindsLabel, adjPostsTo } from '@/components/AdjChargePicker'
import { BdRepaymentEdit } from '@/components/BdRepaymentEdit'
import { isRefundDue } from '@/lib/refundDue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

// Days from today, local. Negative is overdue.
function daysTo(date: unknown): number | null {
  const d = s(date).slice(0, 10)
  if (!d) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((new Date(`${d}T00:00:00`).getTime() - today) / 86400000)
}

/* -------------------------------------------------------------------------- */
/* The pieces, exactly as the canvas draws them                               */
/* -------------------------------------------------------------------------- */

function Card({
  children,
  className,
  tone
}: {
  children: React.ReactNode
  className?: string
  tone?: 'plain' | 'green'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex-none overflow-hidden rounded-[4px] border bg-white',
        tone === 'green' ? 'border-[#BFE3CB]' : 'border-[#D6E2D6]',
        className
      )}
    >
      {children}
    </div>
  )
}

function CardHead({
  icon: Icon,
  children,
  tone
}: {
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  tone?: 'plain' | 'green'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b px-3.5 py-[11px]',
        tone === 'green' ? 'border-b-[#BFE3CB] bg-[#F4FBF6]' : 'border-b-[#E4ECE3] bg-[#F7FAF6]'
      )}
    >
      {Icon && <Icon className={cn('h-[17px] w-[17px] shrink-0', tone === 'green' ? 'text-[#0B6B45]' : 'text-[#33473E]')} />}
      <span
        className={cn(
          'text-[10.5px] font-extrabold uppercase tracking-[.13em]',
          tone === 'green' ? 'text-[#0B6B45]' : 'text-[#33473E]'
        )}
      >
        {children}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

// UPFRONT INTEREST, RECORDED WHEN IT IS ACTUALLY PAID.
//
// A bill opened with interest "settled upfront" leaves the interest out of its
// disbursement voucher, because the NBFC takes it separately — usually a debit
// on the bank statement. Until that payment is recorded the interest is in no
// ledger at all. It is recorded here, once, with the date and bank the
// statement shows; a second press returns the same voucher rather than
// charging the interest again, and it can be reversed if it was wrong.
function UpfrontInterestCard({ bill, onChanged }: { bill: Row; onChanged?: () => void }): React.JSX.Element | null {
  const [date, setDate] = useState(todayISO())
  const [bank, setBank] = useState('')
  const [banks, setBanks] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const recorded = n(bill.upfront_interest_journal_entry_id) > 0
  const funded = s(bill.payment_received_date).slice(0, 10)
  useEffect(() => {
    if (recorded) return
    let gone = false
    void window.api.journal
      .accounts()
      .then((a) => !gone && setBanks(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(s(x.acc_group)))))
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [recorded])
  if (!Number(bill.interest_upfront) || !funded) return null

  async function record(): Promise<void> {
    if (!bank) return void toast.error('Pick the bank the interest was paid from')
    setBusy(true)
    try {
      await window.api.billDiscounting.upfrontInterest(Number(bill.id), date, bank)
      toast.success('Upfront interest recorded')
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function reverse(): Promise<void> {
    if (!window.confirm('Reverse the recorded upfront interest? Its voucher is removed.')) return
    setBusy(true)
    try {
      await window.api.billDiscounting.reverseUpfrontInterest(Number(bill.id))
      toast.success('Upfront interest reversed')
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead icon={Percent}>Upfront interest</CardHead>
      <div className="flex flex-col gap-2.5 px-3.5 pb-[13px] pt-1.5">
        {recorded ? (
          <>
            <div className="text-[12.5px] font-semibold text-[#33473E]">
              Recorded on {formatDate(bill.upfront_interest_paid_date)}
              {bill.upfront_interest_account ? ` from ${s(bill.upfront_interest_account)}` : ''}.
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void reverse()}
              className="self-start rounded-[3px] border border-[#F0D6D4] bg-white px-3 py-1.5 text-[12px] font-extrabold text-[#B3261E] disabled:opacity-50"
            >
              Reverse
            </button>
          </>
        ) : (
          <>
            <div className="text-[12px] font-semibold leading-[1.45] text-[#8A5A00] [text-wrap:pretty]">
              Not recorded yet — this interest is in no ledger until it is. Record it with the date and bank the statement shows.
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
                Paid on
                <input
                  type="date"
                  value={date}
                  min={funded}
                  max={todayISO()}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-9 rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-[13px] font-semibold normal-case tracking-normal text-[#0A1F17]"
                />
              </label>
              <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
                From bank
                <select
                  value={bank}
                  onChange={(e) => setBank(e.target.value)}
                  className="h-9 rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-[13px] font-semibold normal-case tracking-normal text-[#0A1F17]"
                >
                  <option value="">Pick the bank</option>
                  {banks.map((a) => (
                    <option key={String(a.id)} value={s(a.name)}>
                      {s(a.name)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !bank}
                onClick={() => void record()}
                className="h-9 rounded-[3px] bg-[#0B3D2E] px-3.5 text-[12.5px] font-extrabold text-white disabled:opacity-50"
              >
                Record
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

// WHICH BANK EACH OF THIS BILL'S VOUCHERS WENT THROUGH — AND CHANGE IT.
//
// The disbursement, every repayment, every interest payment, the margin coming
// back: each is one voucher with one bank line, and which bank is a fact the
// statement settles, often only later. Every bill entered before the question
// was asked sits in BANK A/C. So each is listed with its bank and can be moved
// to the real account at any time — only that one line changes; the amount,
// the date and the voucher number stay as they are.
const CASH_BANK = ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand']

function BankCard({ bill, repayments, onChanged }: { bill: Row; repayments?: Row[]; onChanged?: () => void }): React.JSX.Element | null {
  const [posted, setPosted] = useState<Row[] | null>(null)
  const [banks, setBanks] = useState<Row[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const id = Number(bill.id)
  const load = async (): Promise<void> => {
    const d = await window.api.vouchers.forDocument('bd', id).catch(() => null)
    setPosted(((d?.posted as Row[]) || []).filter((p) => ((p.lines as Row[]) || []).some((l) => CASH_BANK.includes(s(l.acc_group)))))
  }
  useEffect(() => {
    void load()
    void window.api.journal
      .accounts()
      .then((a) => setBanks(a.filter((x) => CASH_BANK.includes(s(x.acc_group)))))
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, bill.journal_entry_id, bill.repaid_amount])
  if (!posted || !posted.length) return null

  async function change(entryId: number, account: string): Promise<void> {
    setBusy(entryId)
    try {
      await window.api.billDiscounting.setVoucherBank(id, entryId, account)
      toast.success(`Moved to ${account}`)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // WHAT EACH REPAYMENT DID TO THE BALANCE. In date order, the bill's open
  // amount comes down by each repayment's principal; whatever else was in the
  // same debit — interest, charges, and money paid OVER the balance that the
  // NBFC must give back — is said beside it, so 79 + 16 + 46 lakh against a
  // 1,38 lakh bill reads as 43 lakh settling it and 3 lakh paid over.
  const settle = new Map<number, { before: number; after: number; principal: number; interest: number; charges: number; refund: number }>()
  {
    let bal = round2(n(bill.amount))
    const reps = [...(repayments || [])].sort(
      (a, b) => String(a.repay_date || '').localeCompare(String(b.repay_date || '')) || n(a.id) - n(b.id)
    )
    for (const r of reps) {
      const je = n(r.journal_entry_id)
      if (!je) continue
      const rows = bdLedgerCharges(r)
      const refund = round2(rows.filter((x) => isRefundDue(String(x.account || ''))).reduce((t, x) => t + n(x.amount), 0))
      const charges = round2(
        rows.filter((x) => !isRefundDue(String(x.account || ''))).reduce((t, x) => t + n(x.amount), 0) + n(r.comm_charges) + n(r.bank_charges)
      )
      const principal = round2(n(r.amount))
      const cur = settle.get(je) || { before: bal, after: bal, principal: 0, interest: 0, charges: 0, refund: 0 }
      cur.principal = round2(cur.principal + principal)
      cur.interest = round2(cur.interest + n(r.interest))
      cur.charges = round2(cur.charges + charges)
      cur.refund = round2(cur.refund + refund)
      bal = round2(Math.max(0, bal - principal))
      cur.after = bal
      settle.set(je, cur)
    }
  }

  return (
    <Card>
      <CardHead icon={Landmark}>Bank</CardHead>
      <div className="px-3.5 pb-[13px] pt-1">
        {posted.map((p) => {
          const bankLines = ((p.lines as Row[]) || []).filter((l) => CASH_BANK.includes(s(l.acc_group)))
          const line = bankLines[0]
          const amt = n(line?.dr) || n(line?.cr)
          const inflow = n(line?.dr) > 0
          // ONE DEBIT THAT ALSO REPAID OTHER BILLS: what came off THIS bill is
          // the figure that belongs here; the whole debit and the other bills
          // are said beside it.
          const mine = (repayments || []).filter((x) => n(x.journal_entry_id) === Number(p.id))
          const group: Row[] = mine.length && Array.isArray(mine[0].debit_group) ? mine[0].debit_group : []
          const others = group.filter((g) => n(g.bd_id) !== Number(bill.id))
          const share = round2(mine.reduce((t, x) => t + n(x.amount), 0))
          const shared = others.length > 0 && share > 0
          return (
            <div key={String(p.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-b-[#EFF3EE] py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-bold text-[#0A1F17]">{s(p.role) || s(p.vch_type)}</div>
                <div className="text-[11px] font-semibold text-[#5A6B62]">
                  {formatDate(p.entry_date)} · {s(p.code) || s(p.vch_type)} ·{' '}
                  <span className={inflow ? 'text-[#0B6B45]' : 'text-[#8C2F26]'}>
                    {inflow ? 'in' : 'out'} {formatINR(shared ? share : amt)}
                  </span>
                  {shared && <span> towards {s(bill.bd_no) || 'this bill'}</span>}
                </div>
                {shared && (
                  <div className="text-[10.5px] font-semibold text-[#8CA396]">
                    of one {formatINR(amt)} debit — also {others.map((g) => `${s(g.bd_no)} ${formatINR(n(g.amount))}`).join(', ')}
                  </div>
                )}
                {(() => {
                  const st = settle.get(Number(p.id))
                  if (!st || inflow) return null
                  return (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] font-semibold">
                      <span className="rounded-[2px] bg-[#F1F5EF] px-1.5 py-[2px] tabular-nums text-[#33473E]">
                        Balance {formatINR(st.before)} → {st.after <= 0.004 ? <b className="text-[#0B6B45]">settled</b> : formatINR(st.after)}
                      </span>
                      <span className="tabular-nums text-[#0A1F17]">{formatINR(st.principal)} towards the bill</span>
                      {st.interest > 0.004 && <span className="tabular-nums text-[#5A6B62]">+ {formatINR(st.interest)} interest</span>}
                      {st.charges > 0.004 && <span className="tabular-nums text-[#5A6B62]">+ {formatINR(st.charges)} charges</span>}
                      {st.refund > 0.004 && (
                        <span
                          className="rounded-[2px] border border-[#F0C4C0] bg-[#FDECEA] px-1.5 py-[2px] font-extrabold tabular-nums text-[#B3261E]"
                          title="Paid over the balance — the NBFC owes it back (⋮ → Refund received)"
                        >
                          + {formatINR(st.refund)} paid over — refund due
                        </span>
                      )}
                    </div>
                  )
                })()}
              </div>
              {bankLines.length === 1 ? (
                <select
                  value={s(line.account)}
                  disabled={busy === Number(p.id)}
                  onChange={(e) => {
                    const to = e.target.value
                    if (to === s(line.account)) return
                    if (!window.confirm(`Move this ${formatINR(amt)}${shared ? ` debit (all its bills)` : ''} from ${s(line.account)} to ${to}? Only the bank line changes.`)) return
                    void change(Number(p.id), to)
                  }}
                  className={cn(
                    'h-9 min-w-[190px] rounded-[3px] border bg-white px-2 text-[12px] font-bold outline-none',
                    s(line.account) === 'BANK A/C' ? 'border-[#E3C58C] text-[#8A5A00]' : 'border-[#C3D2C6] text-[#0A1F17]'
                  )}
                  title={s(line.account) === 'BANK A/C' ? 'BANK A/C is not a real account — pick the bank this went through' : undefined}
                >
                  {!banks.some((b) => s(b.name) === s(line.account)) && <option value={s(line.account)}>{s(line.account)}</option>}
                  {banks.map((b) => (
                    <option key={String(b.id)} value={s(b.name)}>
                      {s(b.name)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[11px] font-semibold text-[#8CA396]">more than one bank line — change in Accounting</span>
              )}
            </div>
          )
        })}
        {posted.some((p) => ((p.lines as Row[]) || []).some((l) => s(l.account) === 'BANK A/C')) && (
          <div className="mt-2 text-[11px] font-semibold leading-[1.45] text-[#8A5A00] [text-wrap:pretty]">
            BANK A/C is where bills went before the bank was asked for. Move each to the account the statement shows.
          </div>
        )}
      </div>
    </Card>
  )
}

/** The charges a repayment put on ledgers the user picked (bd_repayments.charges). */
export function bdLedgerCharges(p: Record<string, unknown>): { account: string; amount: number }[] {
  try {
    return JSON.parse(String(p.charges || '[]'))
  } catch {
    return []
  }
}

/** Every charge on a repayment beyond its principal and interest. */
export function chargesOf(p: Record<string, unknown>): number {
  return Number(p.comm_charges || 0) + Number(p.bank_charges || 0) + bdLedgerCharges(p).reduce((t, c) => t + Number(c.amount || 0), 0)
}

export function BdDetail({
  bill,
  onClose,
  onEdit,
  onDelete,
  onPrimary,
  primaryLabel,
  interest,
  repayments,
  onChanged
}: {
  bill: Row | null
  onClose: () => void
  onEdit?: (r: Row) => void
  onDelete?: (r: Row) => void
  onPrimary?: (r: Row) => void
  primaryLabel?: string
  /** The serviced-interest schedule, when this bill has one. */
  interest?: Row[]
  /** Every repayment made against this bill, oldest first. */
  repayments?: Row[]
  /** Something on the bill was posted from inside the panel; re-read it. */
  onChanged?: () => void
}): React.JSX.Element | null {
  const drawerRef = useRef<HTMLDivElement>(null)
  // A repayment being edited (BdRepaymentEdit).
  const [editRep, setEditRep] = useState<Row | null>(null)
  // DELETE ONE REPAYMENT. Its voucher goes with it; one bank debit that also
  // cleared other bills goes as a whole (the bank was debited once), so the
  // question names every bill it takes off.
  async function removeRep(p: Row): Promise<void> {
    const group: Row[] = Array.isArray(p.debit_group) ? p.debit_group : []
    const others = group.filter((g) => Number(g.id) !== Number(p.id))
    const msg =
      `Delete the ${formatINR(n(p.amount))} repaid on ${formatDate(s(p.repay_date))}? Its voucher is removed and the bill reopens for it.` +
      (others.length
        ? `

This was one bank debit that also cleared ${others.map((g) => `${s(g.bd_no)} ${formatINR(n(g.amount))}`).join(', ')} — those come off too.`
        : '')
    if (!window.confirm(msg)) return
    try {
      await window.api.billDiscounting.deleteRepayment(Number(p.id))
      toast.success('Repayment deleted — its voucher is removed')
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  useDrawerEscape(!!bill, drawerRef, onClose)

  if (!bill) return null
  const r = bill
  const amt = n(r.amount)
  const marginAmt = n(r.marginAmount ?? r.margin_amount ?? (amt * n(r.margin_pct)) / 100)
  const interestAmt = n(r.interestAmount ?? r.interest_amount)
  const tds = n(r.tdsAmount ?? r.tds_amount)
  const receipt = n(r.receiptAmount ?? r.receipt_amount ?? amt - marginAmt - interestAmt - tds)
  const repaid = n(r.repaid_total)
  const outstanding = n(r.outstanding_amount ?? Math.max(0, amt - repaid))
  const isRepaid = s(r.status) === 'repaid'
  const awaiting = s(r.stage) === 'awaiting'
  const left = daysTo(r.maturity_date)
  // How much of the bill has been paid back. The canvas puts a bar under the
  // headline figure; this is what it measures.
  const pct = amt > 0 ? Math.max(0, Math.min(100, (repaid / amt) * 100)) : 0
  const barFg = isRepaid ? '#12855A' : left != null && left < 0 ? '#B3261E' : '#1B4E82'

  const kind = s(r.finance_type).toUpperCase() === 'SID' ? 'SID' : 'PID'
  const kindLong = kind === 'SID' ? 'Sales invoice discounting' : 'Purchase invoice discounting'

  // The four figures the row could not carry, in the canvas's small-cell grid.
  const cells: { k: string; v: string; fg?: string; bg?: string; bd?: string }[] = [
    { k: 'Margin held', v: formatINR(marginAmt), fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0' },
    String(r.interest_mode || '') === 'serviced'
      ? { k: 'Interest', v: 'serviced', fg: '#5A6B62', bg: '#F7FAF6', bd: '#E4ECE3' }
      : { k: 'Interest', v: formatINR(interestAmt), fg: '#8C2F26', bg: '#FDF8F7', bd: '#F0D6D4' },
    String(r.interest_mode || '') === 'serviced'
      ? { k: 'TDS withheld', v: '—', fg: '#5A6B62', bg: '#F7FAF6', bd: '#E4ECE3' }
      : { k: 'TDS withheld', v: formatINR(tds), fg: '#8C2F26', bg: '#FDF8F7', bd: '#F0D6D4' },
    { k: 'Interest days', v: `${formatNum(n(r.intDays))} d`, fg: '#33473E', bg: '#F7FAF6', bd: '#E4ECE3' }
  ]

  // WHERE THE MONEY WENT, as a waterfall. The register states a receipt; this
  // states why it is not the bill amount, one deduction at a time.
  // A bill whose interest is SERVICED over the tenor has nothing deducted for
  // it: the interest is paid across periodically while the bill runs, so the
  // whole sanctioned amount lands. The waterfall was still subtracting it —
  // two lines of "less" above a total that had not been reduced by either.
  const serviced = String(r.interest_mode || '') === 'serviced'
  const waterfall: { k: string; v: string; sub?: string; strong?: boolean; fg?: string }[] = [
    { k: 'Bill discounted', v: formatINR(amt), strong: true },
    { k: 'Less margin held', v: `− ${formatINR(marginAmt)}`, fg: '#1B4E82', sub: n(r.margin_pct) ? `${r.margin_pct}% of the bill — it comes back when the bill is repaid` : 'no margin on this bill' },
    serviced
      ? {
          k: 'Interest',
          v: 'serviced over the tenor',
          fg: '#5A6B62',
          sub: `${formatNum(n(r.interest_pct))}% ${String(r.interest_freq || 'monthly').replace('_', '-')} — paid across while the bill runs, not withheld here`
        }
      : { k: 'Less interest', v: `− ${formatINR(interestAmt)}`, fg: '#8C2F26', sub: `${formatNum(n(r.interest_pct))}% for ${formatNum(n(r.intDays))} days` },
    // TDS is withheld OUT OF the interest and owed to the department — the NBFC
    // still keeps the interest gross, so it is not a second deduction from
    // the payout (bdCalc). Stated, not subtracted, or the lines above the
    // total stop adding up to it.
    serviced
      ? { k: 'TDS', v: '—', fg: '#5A6B62', sub: 'withheld with each interest payment' }
      : { k: 'TDS on the interest', v: formatINR(tds), fg: '#5A6B62', sub: n(r.tds_pct) ? `${formatNum(n(r.tds_pct))}% of the interest — owed to the department, not taken off the payout` : '' },
    // The Adj. on a bill on the charge basis: the NBFC's own deduction from
    // (or addition to) the payout, posted to the ledger of its kind of charge.
    ...(n(r.open_adj) && n(r.open_adj_charge)
      ? [
          {
            k: n(r.open_adj) < 0 ? `Less ${adjKindsLabel(r.open_adj_ledger, r.open_adj_split).toLowerCase()} (Adj.)` : 'Add adjustment',
            v: `${n(r.open_adj) < 0 ? '−' : '+'} ${formatINR(Math.abs(n(r.open_adj)))}`,
            fg: n(r.open_adj) < 0 ? '#8C2F26' : '#0B6B45',
            sub: n(r.open_adj) < 0 ? `the NBFC’s deduction from the payout · ${adjPostsTo(r.open_adj_ledger, r.open_adj_split)}` : `added to the payout by the NBFC · ${adjPostsTo(r.open_adj_ledger, r.open_adj_split)}`
          }
        ]
      : []),
    { k: 'Reached your account', v: formatINR(receipt), strong: true, fg: '#0B6B45' }
  ]

  // WHEN IT MOVES. Only the steps this bill actually has — a date that has not
  // happened is not a step, it is a plan, and the last row says so.
  const steps: { k: string; v: string; sub?: string; done: boolean; icon: React.ComponentType<{ className?: string }> }[] = []
  steps.push({
    k: 'Bill opened',
    v: r.open_date ? formatDate(r.open_date) : '—',
    sub: `${kindLong} with ${s(r.disc_bank) || s(r.nbfc_name) || 'the NBFC'}`,
    done: !!r.open_date,
    icon: CircleDollarSign
  })
  steps.push({
    k: awaiting ? 'Payment awaited' : 'Money received',
    v: r.payment_received_date ? formatDate(r.payment_received_date) : 'not yet',
    sub: awaiting ? 'The NBFC has not funded this bill yet' : `${formatINR(receipt)} into the bank`,
    done: !!r.payment_received_date,
    icon: Banknote
  })
  if (repaid > 0.005) {
    steps.push({
      k: isRepaid ? 'Repaid in full' : 'Part repaid',
      v: formatINR(repaid),
      sub: n(r.repay_parts) ? `${n(r.repay_parts)} ${n(r.repay_parts) === 1 ? 'payment' : 'payments'} so far` : '',
      done: isRepaid,
      icon: Check
    })
  }
  steps.push({
    k: isRepaid ? 'Matured' : 'Falls due',
    v: r.maturity_date ? formatDate(r.maturity_date) : '—',
    sub: isRepaid
      ? 'Settled'
      : left == null
        ? ''
        : left < 0
          ? `${-left} days overdue — the full bill, not the figure that reached you`
          : `${left} days left — the full ${formatINR(amt)} falls due, not the figure that reached you`,
    done: isRepaid,
    icon: CalendarClock
  })

  // `name` marks the two that are text rather than a figure — see the card.
  const terms: { k: string; v: string; sub?: string; name?: boolean }[] = [
    { k: 'NBFC', v: s(r.nbfc_name) || s(r.disc_bank) || '—', name: true },
    { k: 'Party', v: s(r.party_name) || '—', sub: n(r.party_count) > 1 ? `and ${n(r.party_count) - 1} more` : '', name: true },
    { k: 'Interest', v: `${formatNum(n(r.interest_pct))}%`, sub: `${formatNum(n(r.intDays))} days` },
    { k: 'Margin', v: `${formatNum(n(r.margin_pct))}%`, sub: formatINR(marginAmt) },
    { k: 'TDS', v: `${formatNum(n(r.tds_pct))}%`, sub: formatINR(tds) },
    { k: 'Invoice', v: n(r.invoice_amount) > 0 ? formatINR(r.invoice_amount) : '—', sub: n(r.invoice_amount) > 0 ? 'the bill is drawn against it' : '' }
  ]

  const sched = Array.isArray(interest) ? interest : []
  const servicedPaid = sched.filter((x) => x.paid_id).length

  // WHAT WAS ACTUALLY PAID TO THE NBFC, PAYMENT BY PAYMENT.
  //
  // The card above says how much of the bill has come back; it does not say
  // how, and a bill is rarely repaid in one go. Four part payments over six
  // weeks, one of them settled against the party rather than out of the bank,
  // two of them carrying commission the NBFC kept — that is the answer to
  // "how was this repaid", and it was only readable by opening the repay
  // dialog, which is a place for entering the NEXT one.
  const parts = Array.isArray(repayments) ? repayments : []
  const partsTotal = parts.reduce((t, p) => t + n(p.amount), 0)
  // The charges ride beside the principal rather than inside it: they are this
  // event's cost, not part of what was borrowed. Summed separately for the
  // same reason.
  const partsCharges = parts.reduce((t, p) => t + chargesOf(p), 0)

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      {/* The register stays readable behind it — this is the canvas's own
          scrim, lighter than the app's default black.
          It is not drawn on a phone: there the panel is the whole screen, so
          there is no "behind" to look at and no outside to tap. Left in, it
          competed with the panel for the 375px and pushed it off the edge. */}
      <div
        onClick={onClose}
        className="hidden flex-1 sm:block"
        style={{ background: 'rgba(10,31,23,.44)' }}
        aria-hidden
      />
      {/* `min-w-0` is what lets it BE 375px wide.
          A flex item will not shrink below its content by default, and this
          one holds a 27px figure and two long company names — so on a phone it
          simply refused to fit and hung off the right-hand side. */}
      <div
        className="flex w-full min-w-0 flex-col bg-[#F1F5EF] sm:w-[min(100%,980px)]"
        style={{ boxShadow: '-16px 0 40px rgba(10,31,23,.24)' }}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
      >
        {/* ---------------------------------------------------------- head */}
        <div className="flex-none bg-[#0B3D2E] px-5 py-4 text-white">
          <div className="flex items-start justify-between gap-3.5">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Bill discounting
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <span
                  className={cn(
                    'doc-ref text-[18px] font-bold tracking-[-0.02em]',
                    !r.bd_no && 'italic opacity-70'
                  )}
                >
                  {s(r.bd_no) || 'No BD no'}
                </span>
                <span className="rounded-[2px] bg-white/[.14] px-2 py-1 text-[10px] font-extrabold tracking-[.06em] uppercase">
                  {isRepaid ? 'Repaid' : awaiting ? 'Awaiting payment' : 'Open'}
                </span>
                <span className="rounded-[2px] bg-[#C7F03F]/[.18] px-2 py-1 text-[10px] font-extrabold tracking-[.06em] text-[#C7F03F]">
                  {kind}
                </span>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[12px] font-bold text-[#DCEFE4]">
                <span className="flex min-w-0 max-w-full items-start gap-1.5">
                  <Landmark className="mt-px h-[17px] w-[17px] shrink-0 text-[#8FBFA8]" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s(r.nbfc_name) || s(r.disc_bank) || '—'}</span>
                </span>
                <span className="flex min-w-0 max-w-full items-start gap-1.5">
                  <Users className="mt-px h-[17px] w-[17px] shrink-0 text-[#8FBFA8]" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s(r.party_name) || '—'}</span>
                </span>
                <span className="flex items-center gap-1.5 capitalize">
                  <Percent className="h-[17px] w-[17px] text-[#8FBFA8]" />
                  {s(r.purpose) || 'manufacturing'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-[3px] bg-white/10 hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ---------------------------------------------------------- body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5 pt-4">
          {/* The headline figure, and how much of it is still owed. */}
          <Card>
            <div className="px-4 py-[15px]">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
                    Bill discounted
                  </div>
                  <div className="doc-ref mt-1.5 text-[23px] font-bold tracking-[-0.035em] text-[#0A1F17] sm:whitespace-nowrap sm:text-[27px]">
                    {formatINR(amt)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
                    {isRepaid ? 'Repaid' : 'Still owed'}
                  </div>
                  <div className="doc-ref mt-1.5 text-[19px] font-bold" style={{ color: barFg }}>
                    {formatINR(isRepaid ? amt : outstanding)}
                  </div>
                </div>
              </div>
              <div className="mt-[11px] h-2.5 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                <div className="h-full" style={{ width: `${isRepaid ? 100 : pct}%`, background: barFg }} />
              </div>
              <div className="mt-[13px] grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr))]">
                {cells.map((c) => (
                  <div
                    key={c.k}
                    className="rounded-[3px] border px-[11px] py-[9px]"
                    style={{ background: c.bg, borderColor: c.bd }}
                  >
                    <div className="text-[9px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">{c.k}</div>
                    <div
                      className="doc-ref mt-1 text-[13.5px] font-bold"
                      style={{ color: c.fg }}
                    >
                      {c.v}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* WHAT REACHED YOU, deduction by deduction. */}
          <Card tone="green">
            <CardHead icon={ArrowUpRight} tone="green">
              What reached your account
            </CardHead>
            <div className="px-3.5 pb-[13px] pt-1.5">
              {waterfall.map((w, i) => (
                <div
                  key={w.k}
                  className={cn(
                    'py-[9px]',
                    i < waterfall.length - 1 ? 'border-b border-b-[#EFF3EE]' : 'border-b border-b-transparent'
                  )}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={cn(
                        'min-w-0',
                        w.strong ? 'text-[12.5px] font-extrabold text-[#0A1F17]' : 'text-[12px] font-semibold text-[#5A6B62]'
                      )}
                    >
                      {w.k}
                    </span>
                    <span
                      className={cn(
                        'doc-ref flex-none whitespace-nowrap font-bold',
                        w.strong ? 'text-[15px]' : 'text-[13px]'
                      )}
                      style={{ color: w.fg || '#0A1F17' }}
                    >
                      {w.v}
                    </span>
                  </div>
                  {!!w.sub && (
                    <div className="mt-[3px] text-[11px] font-semibold text-[#5A6B62] [text-wrap:pretty]">{w.sub}</div>
                  )}
                </div>
              ))}
              <div className="mt-[11px] flex items-start gap-2">
                <Info className="h-[17px] w-[17px] shrink-0 text-[#5A6B62]" />
                <span className="text-[12px] font-semibold leading-[1.45] text-[#33473E] [text-wrap:pretty]">
                  The margin comes back when the bill is repaid; the interest and the TDS do not. You repay the full{' '}
                  {formatINR(amt)} at maturity, not the figure that reached you.
                </span>
              </div>
            </div>
          </Card>

          <UpfrontInterestCard bill={r} onChanged={onChanged} />
          <BankCard bill={r} repayments={parts} onChanged={onChanged} />

          {/* WHEN IT MOVES. */}
          <Card>
            <CardHead icon={CalendarClock}>Timeline</CardHead>
            <div className="p-3.5">
              {steps.map((t, i) => {
                const Ico = t.icon
                const last = i === steps.length - 1
                return (
                  <div key={t.k} className="flex items-stretch gap-[11px]">
                    <div className="flex w-6 flex-none flex-col items-center">
                      <div
                        className={cn(
                          'flex h-6 w-6 flex-none items-center justify-center rounded-full border-2',
                          t.done ? 'border-[#12855A] bg-[#E9F5EE]' : 'border-[#DCE7DB] bg-white'
                        )}
                      >
                        <Ico className={cn('h-3.5 w-3.5', t.done ? 'text-[#0B6B45]' : 'text-[#8CA396]')} />
                      </div>
                      {!last && <div className="min-h-4 w-0.5 flex-1 bg-[#DCE7DB]" />}
                    </div>
                    <div className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-3.5')}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
                        <span className={cn('text-[12.5px] font-extrabold', t.done ? 'text-[#0A1F17]' : 'text-[#5A6B62]')}>
                          {t.k}
                        </span>
                        <span
                          className={cn(
                            'doc-ref whitespace-nowrap text-[12.5px] font-bold',
                            t.done ? 'text-[#0A1F17]' : 'text-[#5A6B62]'
                          )}
                        >
                          {t.v}
                        </span>
                      </div>
                      {!!t.sub && (
                        <div className="mt-[3px] text-[11.5px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                          {t.sub}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* WHAT WAS AGREED.
              The names get a row of their own. Sharing the numbers' grid put
              a lender's full name into a 130px column, where it could only be
              cut to "GANGA BASE BAR…" — and a party you cannot read is the one
              field on this card nobody can guess from context. They wrap now,
              two to a row on any real width and one to a row on a phone; the
              percentages, which are three characters long, keep the tight
              auto-fit grid underneath. */}
          <Card>
            <div className="grid gap-[13px] px-[15px] py-[13px] sm:grid-cols-2">
              {terms
                .filter((t) => t.name)
                .map((t) => (
                  <div key={t.k} className="min-w-0">
                    <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{t.k}</div>
                    <div className="doc-ref mt-1 text-[13.5px] font-bold leading-[1.35] text-[#0A1F17] [overflow-wrap:anywhere] [text-wrap:pretty]">
                      {t.v}
                    </div>
                    {!!t.sub && <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">{t.sub}</div>}
                  </div>
                ))}
            </div>
            <div className="grid gap-[13px] border-t border-t-[#EFF3EE] px-[15px] py-[13px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr))]">
              {terms
                .filter((t) => !t.name)
                .map((t) => (
                  <div key={t.k} className="min-w-0">
                    <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{t.k}</div>
                    <div className="doc-ref mt-1 text-[13.5px] font-bold text-[#0A1F17]">{t.v}</div>
                    {!!t.sub && <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">{t.sub}</div>}
                  </div>
                ))}
            </div>
          </Card>

          {/* WHAT HAS BEEN PAID BACK. */}
          <Card>
            <div className="px-[15px] py-[13px]">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">Repayment</div>
              <div className="mt-2 flex items-start gap-2">
                {isRepaid ? (
                  <Check className="h-[18px] w-[18px] shrink-0 text-[#0B6B45]" />
                ) : left != null && left < 0 ? (
                  <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-[#B3261E]" />
                ) : (
                  <CalendarClock className="h-[18px] w-[18px] shrink-0 text-[#A8B8AE]" />
                )}
                <span className="min-w-0 text-[12.5px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                  {isRepaid
                    ? `Settled in full — ${formatINR(amt)} repaid, and the ${formatINR(marginAmt)} margin released.`
                    : repaid > 0.005
                      ? `${formatINR(repaid)} repaid of ${formatINR(amt)}; ${formatINR(outstanding)} still to go.`
                      : `Nothing repaid yet. The full ${formatINR(amt)} falls due${r.maturity_date ? ` on ${formatDate(r.maturity_date)}` : ''}.`}
                </span>
              </div>

              {/* Serviced interest, where the terms have it. Each rest is a
                  real voucher, so the panel says how many have been taken. */}
              {sched.length > 0 && (
                <div className="mt-[11px] overflow-hidden rounded-[4px] border border-[#E4ECE3]">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3 py-[9px]">
                    <Percent className="h-4 w-4 text-[#1A2C56]" />
                    <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#1A2C56]">
                      Interest serviced during the tenor
                    </span>
                    <span className="doc-ref ml-auto whitespace-nowrap rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-[7px] py-0.5 text-[11px] font-bold text-[#1B4E82]">
                      {servicedPaid} of {sched.length} paid
                    </span>
                  </div>
                  {sched.slice(0, 8).map((x, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 border-b border-b-[#EFF3EE] px-3 py-[11px] last:border-b-0"
                    >
                      {x.paid_id ? (
                        <ArrowDownLeft className="mt-px h-[17px] w-[17px] shrink-0 text-[#0B6B45]" />
                      ) : (
                        <CalendarClock className="mt-px h-[17px] w-[17px] shrink-0 text-[#A8B8AE]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="doc-ref min-w-0 text-[12.5px] font-extrabold text-[#0A1F17]">
                            {formatDate(s(x.from_date))} <span className="font-bold text-[#8CA396]">&rarr;</span>{' '}
                            {formatDate(s(x.to_date))}
                          </span>
                          <span
                            className={cn(
                              'flex-none rounded-[2px] border px-1.5 py-0.5 text-[9.5px] font-extrabold tracking-[.05em] uppercase',
                              x.paid_id
                                ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                // DUE IN RED. Interest that has not been paid
                                // is money owed on a date that is coming, and
                                // in the grey it wore it read as a column
                                // heading rather than as something to do.
                                : 'border-[#F0C9C4] bg-[#FDECEA] text-[#B3261E]'
                            )}
                          >
                            {x.paid_id ? 'Paid' : 'Due'}
                          </span>
                          <span className="doc-ref flex-none text-[10.5px] font-semibold text-[#5A6B62]">
                            {n(x.days)}d
                          </span>
                        </div>
                      </div>
                      <span className="doc-ref flex-none whitespace-nowrap text-[13.5px] font-bold text-[#0A1F17]">
                        {formatINR(n(x.gross))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* EVERY PAYMENT MADE TO THE NBFC, oldest first. Not truncated:
                  this list IS the answer somebody opened the bill for, and a
                  part payment hidden behind "and 3 more" is the one they were
                  looking for. It scrolls instead. */}
              {parts.length > 0 && (
                <div className="mt-[11px] overflow-hidden rounded-[4px] border border-[#E4ECE3]">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3 py-[9px]">
                    <ArrowUpRight className="h-4 w-4 text-[#0B3D2E]" />
                    <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">
                      Paid to {s(r.nbfc_name) || s(r.disc_bank) || 'the NBFC'}
                    </span>
                    <span className="doc-ref ml-auto whitespace-nowrap rounded-[2px] border border-[#BFE3CB] bg-[#E9F5EE] px-[7px] py-0.5 text-[11px] font-bold text-[#0B6B45]">
                      {parts.length} {parts.length === 1 ? 'payment' : 'payments'} — {formatINR(partsTotal)}
                      {partsCharges > 0.004 ? ` + ${formatINR(partsCharges)} charges` : ''}
                    </span>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto">
                    {parts.map((p, i) => {
                      const chg = round2(chargesOf(p))
                      const intr = round2(n(p.interest))
                      const outflow = round2(n(p.amount) + chg + intr)
                      const viaParty = s(p.settle_via) === 'party'
                      return (
                        <div
                          key={String(p.id ?? i)}
                          className="flex items-start gap-2.5 border-b border-b-[#EFF3EE] px-3 py-[11px] last:border-b-0"
                        >
                          <ArrowUpRight className="mt-px h-[17px] w-[17px] shrink-0 text-[#0B6B45]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="doc-ref min-w-0 text-[12.5px] font-extrabold text-[#0A1F17]">
                                {formatDate(s(p.repay_date))}
                              </span>
                              {/* HOW it was settled. Money out of the bank is
                                  the ordinary case; against the party is the
                                  one worth marking, because no cash moved. */}
                              <span
                                className={cn(
                                  'flex-none rounded-[2px] border px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[.05em]',
                                  viaParty
                                    ? 'border-[#C6DAF0] bg-[#EAF0FA] text-[#1B4E82]'
                                    : 'border-[#DCE7DB] bg-[#F7FAF6] text-[#5A6B62]'
                                )}
                              >
                                {viaParty ? 'Against the party' : 'From the bank'}
                              </span>
                              {/* THE REFERENCE THAT MATCHES A BANK STATEMENT
                                  — the UTR or cheque keyed on the payment. The
                                  voucher's own number stands in when there is
                                  none, but not when it is simply the bill's
                                  number again: this list is already under the
                                  bill, and repeating B1 on every line says
                                  nothing. */}
                              {(() => {
                                const ref = s(p.ref).trim() || (s(p.vch_no).trim() === s(r.bd_no).trim() ? '' : s(p.vch_no).trim())
                                return ref ? (
                                  <span className="doc-ref flex-none text-[10.5px] font-semibold text-[#5A6B62]">
                                    {ref}
                                  </span>
                                ) : null
                              })()}
                            </div>
                            {/* THE WHOLE DEBIT, where it is not the principal.
                                A statement shows one figure larger than the
                                bill came down by, and this is the line that
                                explains it. */}
                            {(chg > 0.004 || intr > 0.004) && (
                              <div className="mt-[3px] text-[11.5px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                                {formatINR(outflow)} left the account — {formatINR(n(p.amount))} off the bill
                                {intr > 0.004 ? `, ${formatINR(intr)} interest` : ''}
                                {chg > 0.004
                                  ? `, ${formatINR(chg)} in charges (${[
                                      n(p.comm_charges) > 0.004 ? `${formatINR(n(p.comm_charges))} commission` : '',
                                      n(p.bank_charges) > 0.004 ? `${formatINR(n(p.bank_charges))} bank` : '',
                                      ...bdLedgerCharges(p).map((c) => `${formatINR(c.amount)} ${c.account}`)
                                    ]
                                      .filter(Boolean)
                                      .join(', ')})`
                                  : ''}
                              </div>
                            )}
                            {!!s(p.note) && (
                              <div className="mt-[3px] text-[11.5px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                                {s(p.note)}
                              </div>
                            )}
                          </div>
                          <div className="flex-none text-right">
                            <div className="doc-ref whitespace-nowrap text-[13.5px] font-bold text-[#0A1F17]">
                              {formatINR(n(p.amount))}
                            </div>
                            {/* What the bill still stood at after it — the
                                point of a part payment is watching it come
                                down. */}
                            <div className="mt-[2px] whitespace-nowrap text-[10.5px] font-semibold text-[#5A6B62]">
                              {n(p.balance_after) > 0.004
                                ? `${formatINR(n(p.balance_after))} left`
                                : 'bill cleared'}
                            </div>
                            {onChanged && (
                              <div className="mt-1.5 flex justify-end gap-1">
                                {!viaParty && (
                                  <button
                                    type="button"
                                    onClick={() => setEditRep({ ...p, bd_no: r.bd_no })}
                                    title="Change the date, bank, charges or amount — the voucher keeps its number"
                                    className="inline-flex items-center gap-1 rounded-[3px] border border-[#C3D2C6] bg-white px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[.05em] text-[#0B3D2E] hover:bg-[#F3FBE2]"
                                  >
                                    <Pencil className="h-3 w-3" /> Edit
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void removeRep(p)}
                                  title="Delete this repayment — its voucher goes too, and the bill reopens for it"
                                  className="inline-flex items-center gap-1 rounded-[3px] border border-[#F0D6D4] bg-white px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[.05em] text-[#B3261E] hover:bg-[#FDF3F2]"
                                >
                                  <Trash2 className="h-3 w-3" /> Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        <BdRepaymentEdit repayment={editRep} onClose={() => setEditRep(null)} onSaved={() => onChanged?.()} />

        {/* -------------------------------------------------------- footer */}
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-t-[#D6E2D6] bg-white px-5 py-3.5">
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(r)}
              className="flex h-12 items-center gap-[7px] rounded-[4px] border-[1.5px] border-[#F0D6D4] bg-[#FDF3F2] px-[18px] text-[13px] font-extrabold uppercase text-[#B3261E] hover:bg-[#FBE9E7]"
            >
              <Trash2 className="h-[19px] w-[19px]" /> Delete
            </button>
          )}
          <div className="ml-auto flex flex-wrap gap-2.5">
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(r)}
                className="flex h-12 items-center gap-[7px] rounded-[4px] border-[1.5px] border-[#C3D2C6] bg-white px-[18px] text-[13px] font-extrabold uppercase text-[#33473E] hover:bg-[#F7FAF6]"
              >
                <Pencil className="h-[19px] w-[19px]" /> Edit
              </button>
            )}
            {onPrimary && !!primaryLabel && (
              <button
                type="button"
                onClick={() => onPrimary(r)}
                className="flex h-12 items-center gap-[7px] whitespace-nowrap rounded-[4px] bg-[#0B3D2E] px-[22px] text-[13px] font-extrabold uppercase text-[#C7F03F] hover:bg-[#0F4A38]"
              >
                <Banknote className="h-[19px] w-[19px]" />
                {primaryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
