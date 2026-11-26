import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, Landmark, ListOrdered, Loader2, Percent, Plus, Wallet } from 'lucide-react'
import { PrincipalSplit } from '@/components/BdDetail'
import { BdCumulativePayments } from '@/components/BdCumulativePayments'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { HelpTip } from '@/components/ui/tooltip'

// PAY CUMULATIVE INTEREST (billDiscounting.ts payBdCumulativeInterest): one
// NBFC, a month or a date range, every open bill's interest to the period's
// end — ticked bills paid with ONE bank voucher, linked to each bill.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
// 12,34,567.89 — Indian grouping in a box that is not being typed in.
const inIN = (v: unknown): string => n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r2 = (v: number): number => Math.round(v * 100) / 100
// One look for every dropdown in the window: left-aligned, normal case, small text, an icon chip.
const FIELD =
  '!h-10 !w-full !justify-between !rounded-[7px] !border-[#C9DCCF] !bg-white !px-2.5 !text-[12px] !font-semibold !normal-case !tracking-normal !text-[#0A1F17] !shadow-[0_1px_2px_rgba(10,31,23,.06)] hover:!border-[#0B6B45] focus:!ring-2 focus:!ring-[#0B6B45]/15'
// ← → WALK A ROW OF CONTROLS (dropdowns, toggles, dates, buttons). A text box
// keeps its arrows until the caret reaches its end; an open list keeps them.
function arrowsAcross(e: React.KeyboardEvent<HTMLElement>): void {
  if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  if (document.querySelector('[data-slot="select-option"]')) return
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.type === 'text' || t instanceof HTMLTextAreaElement) {
    const el = t as HTMLInputElement
    const len = el.value.length
    if (e.key === 'ArrowRight' ? el.selectionEnd !== len : el.selectionStart !== 0) return
  }
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea')).filter((x) => x.offsetParent !== null)
  const at = all.findIndex((x) => x === t || x.contains(t))
  const next = all[at + (e.key === 'ArrowRight' ? 1 : -1)]
  if (at < 0 || !next) return
  e.preventDefault()
  next.focus()
}
const FICON = 'flex h-6 w-6 flex-none items-center justify-center rounded-[5px] bg-[#EEF5EF] text-[#0B6B45]'
// The interest whose net after TDS (TDS rounded to the paisa) is exactly `net`.
const grossFromNet = (net: number, pct: number): number => {
  if (!(net > 0)) return 0
  const g = r2(net / (1 - pct / 100))
  for (const d of [0, -0.01, 0.01, -0.02, 0.02]) {
    const x = r2(g + d)
    if (r2(x - r2((x * pct) / 100)) === net) return x
  }
  return g
}

const monthEnd = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function BdCumulativeInterest({ open, onClose, nbfcs, onDone }: { open: boolean; onClose: () => void; nbfcs: Row[]; onDone?: () => void }): React.JSX.Element {
  const today = todayISO()
  const [nbfc, setNbfc] = useState('')
  const [tab, setTab] = useState<'pay' | 'paid'>('pay')
  const [mode, setMode] = useState<'month' | 'range'>('month')
  const [month, setMonth] = useState(today.slice(0, 7))
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(today)
  // TILL TODAY or TILL MONTH END — the current month's interest to date, or the
  // whole month (what the NBFC debits at its end). Only a choice while the
  // period runs past today.
  const [tillEnd, setTillEnd] = useState(false)
  // The PAID banner's payment table, folded to one line until asked for.
  const [paidOpen, setPaidOpen] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [paidList, setPaidList] = useState<Row[]>([])
  // The period at a glance: interest worked out, paid, pending.
  const [period, setPeriod] = useState<Row | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [banks, setBanks] = useState<Row[]>([])
  // The ledger the TDS goes to — blank keeps TDS ON INTEREST PAYABLE A/C.
  const [tdsLedgers, setTdsLedgers] = useState<Row[]>([])
  const [tdsLedger, setTdsLedger] = useState('')
  const [bank, setBank] = useState('')
  const [paidOn, setPaidOn] = useState(today)
  // Required — it goes into the voucher's narration.
  const [note, setNote] = useState('')
  // One payment voucher, or two through the NBFC (journal: Dr interest / Cr NBFC, Cr TDS; payment: Dr NBFC / Cr bank).
  const [viaNbfc, setViaNbfc] = useState(false)
  const [busy, setBusy] = useState(false)
  // The split calculator open on one bill's stretch (the same one as on a bill).
  const [splitRow, setSplitRow] = useState<Row | null>(null)
  // The bill whose legs (how its interest is worked out) are open.
  const [openId, setOpenId] = useState<number | null>(null)

  // The period's last day is what each bill is paid up to — never past today.
  const periodEnd = mode === 'month' ? monthEnd(month) : to
  const runsAhead = periodEnd > today
  const upto = useMemo(() => {
    const cap = tillEnd ? monthEnd(today.slice(0, 7)) : today
    return periodEnd > cap ? cap : periodEnd
  }, [periodEnd, today, tillEnd])
  const start = mode === 'month' ? `${month}-01` : from

  useEffect(() => {
    if (!open) return
    void window.api.journal
      .accountNames()
      .then((a) => {
        setBanks(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(String(x.acc_group || ''))))
        setTdsLedgers(a.filter((x) => /TDS/i.test(String(x.name || '')) && !/RECE|RECOV|RECIA|RECEV/i.test(String(x.name || ''))))
      })
      .catch(() => setBanks([]))
  }, [open])

  useEffect(() => {
    setRows(null)
    // Read again each time the Pay tab is shown: a payment deleted or edited on
    // Payments made must not leave the bills here as they were.
    if (!open || tab !== 'pay' || !nbfc || !/^\d{4}-\d{2}-\d{2}$/.test(upto)) return
    let live = true
    void window.api.billDiscounting
      .cumulativeInterest({ nbfc_id: Number(nbfc), from_date: start, to_date: upto, till_month_end: tillEnd && runsAhead })
      .then((r) => {
        if (!live) return
        setRows(r)
        setLumpTotal(null)
        // A balance of an earlier short payment is shown, but ticked only on purpose.
        setPicked(new Set(r.filter((x) => !x.blocked && !x.balance_of).map((x) => n(x.bd_id))))
      })
      .catch((e) => toast.error((e as Error).message))
    // The payments already made to this NBFC — the PAID banner names the ones
    // that covered this period (date, voucher, amount, bills).
    void window.api.billDiscounting
      .cumulativePayments(Number(nbfc))
      .then((p) => live && setPaidList(p))
      .catch(() => live && setPaidList([]))
    setPeriod(null)
    void window.api.billDiscounting
      // The whole month / range picked, whatever Till today says for paying.
      .periodInterestSummary({ nbfc_id: Number(nbfc), from_date: start, to_date: periodEnd, till_month_end: true })
      .then((p) => live && setPeriod(p))
      .catch(() => live && setPeriod(null))
    return () => {
      live = false
    }
  }, [open, nbfc, upto, start, tab, periodEnd])

  // A LUMP SUM, shared over the ticked bills the way the desk chooses — oldest
  // first (FIFO), newest first, in proportion to each bill's interest, or
  // equally. Worked out live from the sum, the method and the ticks; a bill
  // whose share comes to nothing is simply not paid. Typing on one bill turns
  // the shares into plain figures that can then be changed one by one.
  const [lump, setLump] = useState<string | null>(null)
  const [lumpTotal, setLumpTotal] = useState<number | null>(null)
  const [how, setHow] = useState<'fifo' | 'lifo' | 'pro' | 'equal'>('fifo')
  // What the lump sum is: the NET out of the bank (what the statement shows), or the interest before TDS.
  const [lumpAs, setLumpAs] = useState<'net' | 'gross'>('net')
  const payable = (rows || []).filter((r) => !r.blocked)
  const pool = payable.filter((r) => picked.has(n(r.bd_id)))
  const shares = useMemo(() => {
    const m = new Map<number, number>()
    if (lumpTotal == null || !pool.length) return m
    const oldest = (r: Row): string => String(r.unpaid_before?.from || r.from_date || '')
    const byAge = [...pool].sort((a, b) => oldest(a).localeCompare(oldest(b)) || String(a.bd_no).localeCompare(String(b.bd_no), undefined, { numeric: true }))
    const order = how === 'lifo' ? byAge.reverse() : byAge
    // Shared in the lump sum's own terms (net or interest), each bill capped at its own figure.
    const own = (r: Row): number => n(lumpAs === 'net' ? r.net : r.gross)
    let left = r2(lumpTotal)
    const base = order.reduce((t, r) => t + own(r), 0)
    order.forEach((r, i) => {
      const last = i === order.length - 1
      const share = last
        ? left
        : how === 'pro'
          ? r2(base > 0 ? (lumpTotal * own(r)) / base : lumpTotal / order.length)
          : how === 'equal'
            ? r2(lumpTotal / order.length)
            : r2(Math.min(left, own(r)))
      const s2 = r2(Math.max(0, Math.min(share, left)))
      left = r2(left - s2)
      // A share equal to the bill's own net keeps its worked-out interest (two grosses can net the same).
      m.set(n(r.bd_id), lumpAs === 'net' ? (Math.abs(s2 - n(r.net)) < 0.005 ? n(r.gross) : grossFromNet(s2, n(r.tds_pct))) : s2)
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lumpTotal, how, rows, picked, lumpAs])

  // A bill's figures as they will be paid: its lump-sum share, else the
  // typed interest, else the worked-out one; TDS at the bill's own %.
  const fig = (r: Row): { gross: number; tds: number; net: number; edited: boolean } => {
    const id = n(r.bd_id)
    const e = lumpTotal != null && shares.has(id) ? String(shares.get(id)) : undefined
    if (e == null || e.trim() === '' || Math.abs(n(e) - n(r.gross)) < 0.005) return { gross: n(r.gross), tds: n(r.tds), net: n(r.net), edited: false }
    const g = r2(n(e))
    const t = r2((g * n(r.tds_pct)) / 100)
    return { gross: g, tds: t, net: r2(g - t), edited: true }
  }
  // What is actually paid: the ticked bills with something on them.
  const sel = pool.filter((r) => fig(r).gross > 0.004)
  const tot = {
    gross: r2(sel.reduce((t, r) => t + fig(r).gross, 0)),
    tds: r2(sel.reduce((t, r) => t + fig(r).tds, 0)),
    net: r2(sel.reduce((t, r) => t + fig(r).net, 0))
  }
  const resetAll = (): void => {
    setLumpTotal(null)
    setLump(null)
  }

  async function pay(): Promise<void> {
    if (!sel.length) return
    if (!note.trim()) {
      toast.error('Write a note — it goes into the voucher narration')
      document.getElementById('bdcum-note')?.focus()
      return
    }
    setBusy(true)
    try {
      const res = await window.api.billDiscounting.payCumulativeInterest({
        nbfc_id: Number(nbfc),
        from_date: start,
        to_date: upto,
        paid_date: paidOn,
        bank_account: bank || null,
        bd_ids: sel.map((r) => n(r.bd_id)),
        tds_ledger: tdsLedger || null,
        via_nbfc: viaNbfc,
        till_month_end: tillEnd && runsAhead,
        note: note.trim(),
        amounts: Object.fromEntries(sel.filter((r) => fig(r).edited).map((r) => [String(n(r.bd_id)), fig(r).gross]))
      })
      toast.success(`Interest on ${res.bills} bill${res.bills === 1 ? '' : 's'} paid to ${formatDate(upto)} — one voucher, ${formatINR(res.net)} out of the bank`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex h-[98dvh] max-h-[98dvh] w-[98vw] max-w-[98vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[98vw] [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 pb-0 pt-3.5 pr-12 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <Percent className="h-3.5 w-3.5" /> Bill discounting
          </div>
          <DialogTitle className="text-[16px] font-extrabold text-white">Pay cumulative interest</DialogTitle>
          {/* Two views: pay, and what has been paid through here. */}
          <div className="mt-2.5 flex gap-1">
            {(
              [
                ['pay', 'Pay interest'],
                ['paid', 'Payments made']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={cn(
                  'rounded-t-[5px] px-3.5 py-1.5 text-[12px] font-extrabold',
                  tab === k ? 'bg-white text-[#0B3D2E]' : 'text-[#C7F03F]/80 hover:bg-white/10 hover:text-[#C7F03F]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'paid' ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
            <BdCumulativePayments
              nbfcId={nbfc ? Number(nbfc) : null}
              onChanged={onDone}
              onPayBalance={(v) => {
                // To the Pay tab on exactly those days: a short bill offers its balance.
                setNbfc(String(v.nbfc_id))
                setMode('range')
                setFrom(v.from)
                setTo(v.to)
                setTab('pay')
              }}
              toolbar={
                <span className="flex items-center gap-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">NBFC</span>
                  <Select searchable value={nbfc || 'all'} onValueChange={(v) => setNbfc(v === 'all' ? '' : v)}>
                    <SelectTrigger className={cn(FIELD, '!w-[280px]')}>
                      <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><Landmark className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue /></span></span>
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      <SelectItem value="all">All NBFCs</SelectItem>
                      {nbfcs.map((x) => (
                        <SelectItem key={String(x.id)} value={String(x.id)}>
                          {String(x.name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              }
            />
          </div>
        ) : (
        <>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="grid gap-3 md:grid-cols-[1.3fr_auto_1.4fr]" onKeyDown={arrowsAcross}>
            <div>
              <span className={lbl}>NBFC</span>
              <Select searchable value={nbfc} onValueChange={setNbfc}>
                <SelectTrigger className={FIELD}>
                  <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><Landmark className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue placeholder="Choose the NBFC" /></span></span>
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {nbfcs.map((x) => (
                    <SelectItem key={String(x.id)} value={String(x.id)}>
                      {String(x.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className={lbl}>Period</span>
              <div className="flex h-9 rounded-[4px] border border-[#C9DCCF] p-0.5">
                {(['month', 'range'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn('rounded-[3px] px-3 text-[12px] font-extrabold', mode === m ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
                  >
                    {m === 'month' ? 'By month' : 'Date range'}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'month' ? (
              <div>
                <span className={lbl}>Month</span>
                <input
                  type="month"
                  // The whole box opens the picker, not only its calendar icon.
                  onClick={(e) => {
                    try {
                      e.currentTarget.showPicker?.()
                    } catch {
                      /* a browser without showPicker keeps the icon */
                    }
                  }}
                  value={month}
                  max={today.slice(0, 7)}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                  className="cursor-pointer h-10 w-full rounded-[7px] border border-[#C9DCCF] bg-white px-3 text-[12px] font-semibold text-[#0A1F17] shadow-[0_1px_2px_rgba(10,31,23,.06)] outline-none hover:border-[#0B6B45] focus:border-[#0B6B45] focus:ring-2 focus:ring-[#0B6B45]/15"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className={lbl}>From</span>
                  <DatePicker value={from} onChange={(v) => v && setFrom(v)} />
                </div>
                <div>
                  <span className={lbl}>To</span>
                  <DatePicker value={to} onChange={(v) => v && setTo(v)} />
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] font-semibold text-[#5A6B62]">
            <span>
              Interest <b className="text-[#0A1F17]">{formatDate(start)} → {formatDate(upto)}</b> on each bill
              {runsAhead ? (tillEnd ? ' — to the month end, ahead of today' : ' — to today') : ''}
            </span>
            {/* TILL TODAY / TILL MONTH END — while the period is still running. */}
            {runsAhead && (
              <span className="inline-flex rounded-[4px] border border-[#C9DCCF] p-0.5">
                {[
                  { v: false, t: 'Till today' },
                  { v: true, t: 'Till month end' }
                ].map((o) => (
                  <button
                    key={o.t}
                    type="button"
                    onClick={() => setTillEnd(o.v)}
                    className={cn('rounded-[3px] px-2 py-0.5 text-[11px] font-extrabold', tillEnd === o.v ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
                  >
                    {o.t}
                  </button>
                ))}
              </span>
            )}
            <HelpTip text="From the day a bill was funded, if later. Earlier unpaid days and balances still due are flagged on the bill; a period paid short can be picked again to pay just its balance. Click a bill to see how its interest is worked out. Till month end works the current month to its last day — what the NBFC debits at month end." />
          </div>

          {/* THE PERIOD AT A GLANCE — every bill of the NBFC over the month / range. */}
          {nbfc && period && (n(period.due) > 0.004 || n(period.paid) > 0.004) && (
            <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-4">
              {[
                {
                  k: 'Interest for the period',
                  v: formatINR(n(period.due)),
                  sub: `${formatDate(String(period.from))} → ${formatDate(String(period.to))} · ${((period.bills as Row[]) || []).length} bill${((period.bills as Row[]) || []).length === 1 ? '' : 's'}, worked out`,
                  tone: 'text-[#0A1F17]'
                },
                // WITH THE BILLS TICKED NOW: paid and pending move as bills are
                // ticked, so the tiles say where the month stands after this payment.
                { k: 'Paid till now', v: formatINR(n(period.paid)), sub: 'Interest paid (incl. TDS)', tone: 'text-[#0B6B45]' },
                {
                  k: 'Paid, with this payment',
                  v: formatINR(n(period.paid) + tot.gross),
                  sub: tot.gross > 0.004 ? `+ ${formatINR(tot.gross)} ticked now (gross)` : 'nothing ticked yet',
                  tone: tot.gross > 0.004 ? 'text-[#0B6B45]' : 'text-[#9AAFA2]'
                },
                (() => {
                  // BILL BY BILL: one bill paid over (B7's repayment interest) is
                  // not a reason to read another bill's days as paid — the excess
                  // is said apart, against the bill it is on.
                  let pend = 0
                  const over: string[] = []
                  for (const b of (period.bills as Row[]) || []) {
                    const tick = sel.filter((r) => n(r.bd_id) === n(b.bd_id)).reduce((t, r) => t + fig(r).gross, 0)
                    const rem = n(b.due) - n(b.paid) - tick
                    if (rem > 0.5) pend += rem
                    else if (rem < -0.5) over.push(`${String(b.bd_no)} paid ${formatINR(-rem)} more`)
                  }
                  return {
                    k: tot.gross > 0.004 ? 'Pending after this payment' : 'Pending',
                    v: formatINR(pend),
                    sub: over.length ? `${over.join(' · ')} — check with the NBFC` : pend > 0.5 ? 'still to pay for the period' : 'nothing pending',
                    tone: pend > 0.5 ? 'text-[#B3261E]' : 'text-[#9AAFA2]'
                  }
                })()
              ].map((t, i) => (
                <div
                  key={t.k}
                  title={((period.bills as Row[]) || []).map((b) => `${String(b.bd_no)}: worked out ${formatINR(n(b.due))} · paid ${formatINR(n(b.paid))} · pending ${formatINR(n(b.pending))}`).join('\n')}
                  className={cn('min-w-0 px-3.5 py-2', i % 2 === 1 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0', i === 2 && 'lg:border-l')}
                >
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">{t.k}</div>
                  <div className={cn('truncate text-[16px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
                  <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>
                </div>
              ))}
            </div>
          )}
          {/* What this payment comes to, before the bill-by-bill detail. */}
          {nbfc && rows && payable.length > 0 && (
            <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-4">
              {[
                { k: 'Bills', v: `${sel.length} of ${payable.length}`, sub: rows.length - payable.length ? `${rows.length - payable.length} already paid up` : 'ticked to pay', tone: 'text-[#0A1F17]' },
                { k: 'Interest', v: formatINR(tot.gross), sub: `${formatDate(start)} → ${formatDate(upto)}`, tone: 'text-[#0A1F17]' },
                { k: 'TDS withheld', v: formatINR(tot.tds), sub: tdsLedger || 'TDS on interest payable', tone: 'text-[#8A5300]' },
                { k: 'Out of the bank', v: formatINR(tot.net), sub: 'one voucher', tone: 'text-[#0B6B45]' }
              ].map((t, i) => (
                <div key={t.k} className={cn('min-w-0 px-3.5 py-2', i % 2 === 1 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0', i === 2 && 'lg:border-l')}>
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">{t.k}</div>
                  <div className={cn('truncate text-[16px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
                  <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>
                </div>
              ))}
            </div>
          )}
          {!nbfc ? (
            <div className="rounded-[4px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">Choose the NBFC to see its bills.</div>
          ) : rows == null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-[4px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">No open, funded bill with this NBFC.</div>
          ) : (
            <div className="space-y-3">
              {/* PAID FOR THIS PERIOD — said in words, where the eye lands first. */}
              {(() => {
                const paidRows = rows.filter((r) => /^Already paid/.test(String(r.blocked || '')))
                if (!paidRows.length) return null
                const label =
                  mode === 'month'
                    ? new Date(`${month}-01T00:00:00`).toLocaleString('en-IN', { month: 'long', year: 'numeric' })
                    : `${formatDate(start)} → ${formatDate(upto)}`
                const all = paidRows.length === rows.length
                return (
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-2.5 rounded-[6px] border px-3 py-2',
                      all ? 'border-[#0B6B45] bg-[#E6F5EC]' : 'border-[#BFE3CB] bg-[#F1FAF4]'
                    )}
                  >
                    <CheckCircle2 className="h-5 w-5 flex-none text-[#0B6B45]" />
                    <div className="flex flex-wrap items-center gap-2">
                      <div className={cn('font-extrabold text-[#0B5E3C]', all ? 'text-[14px]' : 'text-[13px]')}>
                        {all ? `${label} interest is PAID on all ${rows.length} bill${rows.length === 1 ? '' : 's'}` : `${label}: ${paidRows.length} of ${rows.length} bills already PAID`}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {paidRows.map((r) => (
                          <span key={String(r.bd_id)} className="rounded-[4px] bg-[#0B6B45] px-1.5 py-0.5 text-[11px] font-extrabold text-white">
                            {String(r.bd_no)}
                          </span>
                        ))}
                      </div>
                    </div>
                    {all && <span className="text-[12px] font-bold text-[#0B6B45]">Nothing left to pay for this period</span>}
                    <button
                      type="button"
                      onClick={() => setPaidOpen((v) => !v)}
                      className="ml-auto rounded-[4px] border border-[#BFE3CB] bg-white px-2 py-0.5 text-[11px] font-bold text-[#0B5E3C] hover:bg-[#F1FAF4]"
                    >
                      {paidOpen ? 'Hide payments' : 'Show payments'}
                    </button>
                    {/* HOW IT WAS PAID — each payment that covered this period. */}
                    {(() => {
                      const ids = new Set(paidRows.map((r) => n(r.bd_id)))
                      const tokens = paidList
                        .map((g) => {
                          const bills = ((g.bills as Row[]) || []).filter(
                            (b) => ids.has(n(b.bd_id)) && String(b.from_date) <= upto && String(b.to_date) >= start
                          )
                          return {
                            g,
                            rep: null as Row | null,
                            date: String(g.paid_date),
                            bills,
                            gross: bills.reduce((t, b) => t + n(b.gross), 0),
                            tds: bills.reduce((t, b) => t + n(b.tds), 0),
                            net: bills.reduce((t, b) => t + n(b.net), 0)
                          }
                        })
                        .filter((x) => x.bills.length)
                        // Interest paid WITH A REPAYMENT on these days is a payment too
                        // (B4's ₹15,284 in its 23-11 debit) — a line of its own.
                        .concat(
                          paidList.flatMap((g) =>
                            ((g.reps as Row[]) || [])
                              .filter((r) => String(r.repay_date) >= start && String(r.repay_date) <= upto && (g.bills as Row[]).some((b) => ids.has(n(b.bd_id))))
                              .map((r) => ({
                                g,
                                rep: r,
                                date: String(r.repay_date),
                                bills: [{ id: `rep${String(r.id)}`, bd_no: r.bd_no, gross: n(r.gross), from_date: r.repay_date, to_date: r.repay_date }] as Row[],
                                gross: n(r.gross),
                                tds: n(r.tds),
                                net: n(r.net)
                              }))
                          )
                        )
                        .sort((a, b) => a.date.localeCompare(b.date) || (a.rep ? 1 : 0) - (b.rep ? 1 : 0))
                      if (!tokens.length || !paidOpen) return null
                      const tNet = tokens.reduce((t, x) => t + x.net, 0)
                      const tGross = tokens.reduce((t, x) => t + x.gross, 0)
                      return (
                        <div className="basis-full overflow-hidden rounded-[6px] border border-[#BFE3CB] bg-white">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#E4F0E6] bg-[#F4FBF6] px-3 py-2">
                            <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#0B5E3C]">
                              Paid in {tokens.length} payment{tokens.length === 1 ? '' : 's'}
                            </span>
                            <span className="text-[12px] font-bold text-[#33473E]">
                              {formatINR(tNet)} out of the bank <span className="font-semibold text-[#7A8C82]">· interest {formatINR(tGross)}</span>
                            </span>
                          </div>
                          <table className="w-full text-[12px]">
                            <thead className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                              <tr>
                                <th className="px-3 py-1.5 text-left">#</th>
                                <th className="px-2 py-1.5 text-left">Paid on</th>
                                <th className="px-2 py-1.5 text-left">Voucher</th>
                                <th className="px-2 py-1.5 text-left">Bills · period</th>
                                <th className="px-2 py-1.5 text-right">Interest</th>
                                <th className="px-2 py-1.5 text-right">TDS</th>
                                <th className="px-3 py-1.5 text-right">Out of the bank</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tokens.map((x, i) => (
                                <tr key={x.rep ? `rep${String(x.rep.id)}` : String(x.g.journal_entry_id)} className={cn('border-t border-[#F1F5F0] align-top', x.rep && 'bg-[#F6F9FD]')}>
                                  <td className="px-3 py-1.5">
                                    <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#0B6B45] px-1.5 text-[10.5px] font-extrabold text-white">{i + 1}</span>
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-1.5 font-extrabold tabular-nums text-[#0A1F17]">{formatDate(x.date)}</td>
                                  <td className="whitespace-nowrap px-2 py-1.5">
                                    {x.rep ? (
                                      <>
                                        <span className="font-bold text-[#33473E]">{String(x.rep.pay_code || '')}</span>
                                        <span className="ml-1 text-[10.5px] font-bold text-[#1B4E82]">with {String(x.rep.bd_no)}&rsquo;s repayment</span>
                                      </>
                                    ) : (
                                      <>
                                        <span className="font-bold text-[#33473E]">{String(x.g.pay_code || x.g.vch_no || '')}</span>
                                        {x.g.via_nbfc && <span className="ml-1 text-[10.5px] font-bold text-[#1B4E82]">via NBFC · {String(x.g.journal_code || '')}</span>}
                                      </>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <span className="flex flex-wrap gap-1">
                                      {x.bills.map((b) => (
                                        <span
                                          key={String(b.id)}
                                          className="rounded-[4px] border border-[#D6E2D6] bg-[#F7FAF6] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-[#33473E]"
                                          title={`${String(b.bd_no)}: ${formatDate(String(b.from_date))} → ${formatDate(String(b.to_date))} · interest ${formatINR(n(b.gross))}`}
                                        >
                                          <b className="text-[#0B3D2E]">{String(b.bd_no)}</b> {formatINR(n(b.gross))}
                                          {b.balance ? <span className="ml-1 text-[#8A5300]">balance</span> : null}
                                        </span>
                                      ))}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(x.gross)}</td>
                                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#7A8C82]">{formatINR(x.tds)}</td>
                                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-extrabold tabular-nums text-[#0B6B45]">{formatINR(x.net)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    })()}
                  </div>
                )
              })()}
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-[6px] border border-[#DCE6DC] bg-[#F7FAF6] px-3 py-2">
                {/* THE ONE ACTUAL PAID BOX — shared over the ticked bills below. */}
                <div>
                  <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">Actual paid</div>
                  <div className="flex h-9 w-[210px] items-center rounded-[6px] border-[1.5px] border-[#0B3D2E] bg-white shadow-[0_1px_2px_rgba(10,31,23,.06)] focus-within:ring-2 focus-within:ring-[#0B6B45]/20">
                    <span className="pl-3 text-[15px] font-bold text-[#8CA396]">₹</span>
                    <input
                      inputMode="decimal"
                      aria-label={lumpAs === 'net' ? 'Net paid from the bank for the ticked bills' : 'Lump sum of interest for the ticked bills'}
                      title="Type a lump sum — it is shared over the ticked bills by the method chosen here"
                      disabled={!sel.length}
                      value={lump ?? inIN(lumpTotal ?? (lumpAs === 'net' ? tot.net : tot.gross))}
                      onFocus={(e) => {
                        setLump(String(lumpTotal ?? (lumpAs === 'net' ? tot.net : tot.gross)))
                        const el = e.currentTarget
                        setTimeout(() => el.select(), 0)
                      }}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/g, '')
                        setLump(v)
                        // Shared out as it is typed.
                        setLumpTotal(n(v) > 0 ? r2(n(v)) : null)
                      }}
                      onBlur={() => setLump(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      className="h-full min-w-0 flex-1 bg-transparent pr-3 text-right text-[15px] font-extrabold tabular-nums text-[#0A1F17] outline-none disabled:opacity-60"
                    />
                  </div>
                  <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">
                    {lumpAs === 'net' ? (lumpTotal != null ? 'Net from the bank — shared below' : 'Type the net that left the bank') : lumpTotal != null ? 'Interest before TDS — shared below' : 'Type the interest before TDS'}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Lump sum is</div>
                  <Select
                    value={lumpAs}
                    onValueChange={(v) => {
                      if (v === lumpAs) return
                      setLumpAs(v as 'net' | 'gross')
                      setLumpTotal(null)
                      setLump(null)
                    }}
                  >
                    <SelectTrigger className={cn(FIELD, '!h-9 !w-[210px]')}>
                      <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><Wallet className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue /></span></span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="net">Net from bank (after TDS)</SelectItem>
                      <SelectItem value="gross">Interest (before TDS)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Shared</div>
                  <Select value={how} onValueChange={(v) => setHow(v as 'fifo' | 'lifo' | 'pro' | 'equal')}>
                    <SelectTrigger className={cn(FIELD, '!h-9 !w-[210px]')}>
                      <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><ListOrdered className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue /></span></span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fifo">Oldest first (FIFO)</SelectItem>
                      <SelectItem value="lifo">Newest first</SelectItem>
                      <SelectItem value="pro">In proportion</SelectItem>
                      <SelectItem value="equal">Equally</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {lumpTotal != null && (
                  <button type="button" onClick={resetAll} className="mt-[30px] text-[12px] font-extrabold text-[#8A5300] hover:underline">
                    Reset all to worked out
                  </button>
                )}
              </div>
            <div className="overflow-x-auto rounded-[6px] border border-[#DCE6DC] bg-white">
              <table className="w-full min-w-[900px] text-[12.5px]">
                <thead className="border-b border-[#DCE6DC] bg-[#F5F8F4] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                  <tr>
                    <th className="w-10 px-3 py-1.5 text-left">
                      <input
                        type="checkbox"
                        aria-label="Tick every bill"
                        checked={payable.length > 0 && pool.length === payable.length}
                        onChange={(e) => setPicked(e.target.checked ? new Set(payable.map((r) => n(r.bd_id))) : new Set())}
                      />
                    </th>
                    <th className="px-2 py-1.5 text-left">Bill</th>
                    <th className="px-2 py-1.5 text-right">Principal</th>
                    <th className="px-2 py-1.5 text-left">Period</th>
                    <th className="px-2 py-1.5 text-right">Worked out</th>
                    <th className="px-2 py-1.5 text-right text-[#0B3D2E]">Actual paid</th>
                    <th className="px-2 py-1.5 text-right">Remaining</th>
                    <th className="px-2 py-1.5 text-right">TDS</th>
                    <th className="px-3 py-1.5 text-right">Net</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const id = n(r.bd_id)
                    const on = picked.has(id)
                    const isOpen = openId === id
                    const parts: Row[] = Array.isArray(r.parts) ? r.parts : []
                    const shortBefore: Row[] = Array.isArray(r.short_before) ? r.short_before : []
                    return (
                      <Fragment key={id}>
                        <tr
                          onClick={(e) => {
                            // Inputs and buttons inside the row keep their own clicks.
                            if ((e.target as HTMLElement).closest('input,button,label')) return
                            if (!r.blocked) setOpenId(isOpen ? null : id)
                          }}
                          className={cn(
                            'border-t border-[#EFF3EE] transition-colors',
                            r.blocked ? 'bg-[#FAFBF9] text-[#9AAAA0]' : 'cursor-pointer hover:bg-[#F7FBF5]',
                            !r.blocked && (isOpen ? 'bg-[#F3F9F1]' : on ? 'bg-white' : 'bg-[#FBFCFA] text-[#7A8C82]')
                          )}
                        >
                          <td className="px-3 py-1.5 align-top">
                            <input
                              type="checkbox"
                              disabled={!!r.blocked}
                              checked={on && !r.blocked}
                              aria-label={`Pay ${String(r.bd_no)}`}
                              onChange={(e) =>
                                setPicked((p) => {
                                  const next = new Set(p)
                                  if (e.target.checked) next.add(id)
                                  else next.delete(id)
                                  return next
                                })
                              }
                            />
                          </td>
                          <td className="px-2 py-1.5 align-top">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('rounded-[4px] px-1.5 py-0.5 text-[11.5px] font-extrabold', r.blocked ? 'bg-[#EEF2EE] text-[#8CA396]' : 'bg-[#0B3D2E] text-[#C7F03F]')}>{String(r.bd_no)}</span>
                              {r.balance_of && (
                                <span className="rounded-[3px] border border-[#F0C9C5] bg-[#FDF0EE] px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[.05em] text-[#B3261E]">Balance</span>
                              )}
                            </div>
                            <div className="mt-1 max-w-[230px] truncate text-[11px] font-semibold text-[#7A8C82]">{String(r.party || '')}</div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums">
                            <div className="font-semibold text-[#0A1F17]">{formatINR(n(r.principal))}</div>
                            <div className="mt-1 text-[10.5px] font-bold text-[#7A8C82]">@ {n(r.interest_pct)}% p.a.</div>
                          </td>
                          <td className="px-2 py-1.5 align-top">
                            {r.blocked ? (
                              /^Already paid/.test(String(r.blocked)) ? (
                                (() => {
                                  const m = /(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/.exec(String(r.blocked))
                                  const rest = String(r.blocked).replace(/^Already paid [^.]*\.\s*/, '')
                                  return (
                                    <span className="flex flex-col items-start gap-1">
                                      <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#0B6B45] px-2 py-1 text-[12px] font-extrabold text-white">
                                        <CheckCircle2 className="h-3.5 w-3.5" /> PAID{m ? ` ${formatDate(m[1])} → ${formatDate(m[2])}` : ''}
                                      </span>
                                      {rest && <span className="text-[11px] font-bold text-[#B3261E]">{rest}</span>}
                                    </span>
                                  )
                                })()
                              ) : (
                                <span className="text-[11.5px] font-bold">{String(r.blocked)}</span>
                              )
                            ) : (
                              <>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="whitespace-nowrap font-semibold tabular-nums text-[#0A1F17]">
                                    {formatDate(String(r.from_date))} → {formatDate(String(r.to_date))}
                                  </span>
                                  <span className="whitespace-nowrap rounded-full bg-[#EEF3EE] px-2 py-0.5 text-[10.5px] font-extrabold tabular-nums text-[#33473E]">{n(r.days)} days</span>
                                </div>
                                {/* Days before this period still unpaid: overdue, said, not paid here. */}
                                {r.unpaid_before && (
                                  <span className="mt-1.5 flex w-fit items-center gap-1 whitespace-nowrap rounded-[4px] border border-[#F3D0CC] bg-[#FDF3F2] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-[#B3261E]" title="These earlier days are still unpaid — pay them with a range that covers them">
                                    <span className="h-1.5 w-1.5 rounded-full bg-[#B3261E]" /> <span className="tracking-[.06em]">UNPAID</span> {formatDate(String(r.unpaid_before.from))} → {formatDate(String(r.unpaid_before.to))}
                                  </span>
                                )}
                                {/* Earlier stretches paid short: their balance is still due. */}
                                {shortBefore.map((s) => (
                                  <span
                                    key={`${s.from}|${s.to}`}
                                    className="mt-1.5 flex w-fit items-center gap-1 whitespace-nowrap rounded-[4px] border border-[#F3D0CC] bg-[#FDF3F2] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-[#B3261E]"
                                    title={`Worked out ${formatINR(n(s.due))}, paid ${formatINR(n(s.paid))} — pick ${formatDate(String(s.from))} → ${formatDate(String(s.to))} to pay the balance`}
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-[#B3261E]" /> <span className="tracking-[.06em]">BALANCE</span> {formatINR(n(s.short))} for {formatDate(String(s.from))} → {formatDate(String(s.to))}
                                  </span>
                                ))}
                              </>
                            )}
                          </td>
                          {/* WORKED OUT (fixed) · ACTUAL PAID (typed) · REMAINING (fixed). */}
                          <td className="whitespace-nowrap px-2 py-1.5 text-right align-top font-semibold tabular-nums text-[#33473E]">{r.blocked ? '—' : formatINR(n(r.gross))}</td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right align-top">
                            {r.blocked ? (
                              '—'
                            ) : (
                              <>
                                {/* Its share of the one Actual paid box below. */}
                                <span className={cn('text-[13px] font-extrabold tabular-nums', !on && 'opacity-50', fig(r).edited ? 'text-[#8A5300]' : 'text-[#0A1F17]')}>
                                  {formatINR(fig(r).gross)}
                                </span>
                                {lumpTotal != null && on && !(fig(r).gross > 0.004) && (
                                  <span className="mt-0.5 block text-right text-[10px] font-bold text-[#8CA396]">nothing left for this bill</span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums">
                            {r.blocked || !on ? (
                              '—'
                            ) : (() => {
                              const left = r2(n(r.gross) - fig(r).gross)
                              return Math.abs(left) < 0.005 ? (
                                <span className="text-[#9AAFA2]">nil</span>
                              ) : left > 0 ? (
                                <span className="font-bold text-[#B3261E]" title="Stays due on this period — pick it again later to pay it">{formatINR(left)}</span>
                              ) : (
                                <span className="font-bold text-[#8A5300]" title="Paid more than worked out">+{formatINR(-left)} over</span>
                              )
                            })()}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums">{r.blocked ? '—' : formatINR(fig(r).tds)}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right align-top font-bold tabular-nums text-[#0B6B45]">{r.blocked ? '—' : formatINR(fig(r).net)}</td>
                          <td className="py-1.5 pr-3 align-top">
                            {!r.blocked && <ChevronDown className={cn('mt-0.5 h-4 w-4 text-[#8CA396] transition-transform', isOpen && 'rotate-180')} />}
                          </td>
                        </tr>
                        {/* HOW THE INTEREST IS WORKED OUT — leg by leg, each at the principal outstanding then. */}
                        {isOpen && !r.blocked && (
                          <tr className="bg-[#F3F9F1]">
                            <td />
                            <td colSpan={9} className="px-2 pb-3 pt-0.5">
                              <div className="rounded-[6px] border border-[#DCE6DC] bg-white">
                                <div className="flex flex-wrap items-center gap-2 border-b border-[#EEF3EE] px-3 py-2">
                                  <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">How {String(r.bd_no)}&apos;s interest is worked out</span>
                                  <span className="text-[11px] font-semibold text-[#7A8C82]">
                                    principal × {n(r.interest_pct)}% × days ÷ {n(r.days_year) || 360}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setSplitRow(r)}
                                    className="ml-auto inline-flex h-7 items-center gap-1 rounded-[4px] border border-[#C9DCCF] bg-white px-2.5 text-[11px] font-extrabold text-[#0B6B45] hover:border-[#0B6B45] hover:bg-[#E9F5EE]"
                                  >
                                    <Plus className="h-3 w-3" /> Split calculator
                                  </button>
                                </div>
                                <table className="w-full text-[12px]">
                                  <thead className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                                    <tr>
                                      <th className="px-3 py-1.5 text-left">Leg</th>
                                      <th className="px-2 py-1.5 text-left">From → to</th>
                                      <th className="px-2 py-1.5 text-right">Days</th>
                                      <th className="px-2 py-1.5 text-right">Principal outstanding</th>
                                      <th className="px-2 py-1.5 text-left">Working</th>
                                      <th className="px-3 py-1.5 text-right">Interest</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {parts.map((p, i) => (
                                      <tr key={i} className="border-t border-[#F1F5F0]">
                                        <td className="px-3 py-1.5">
                                          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#E9F5EE] px-1.5 text-[10.5px] font-extrabold text-[#0B6B45]">{i + 1}</span>
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular-nums text-[#0A1F17]">
                                          {formatDate(String(p.from_date))} → {formatDate(String(p.to_date))}
                                        </td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">{n(p.days)}</td>
                                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(n(p.principal))}</td>
                                        <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-[#7A8C82] tabular-nums">
                                          {inIN(n(p.principal))} × {n(r.interest_pct)}% × {n(p.days)} ÷ {n(r.days_year) || 360}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(n(p.interest))}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-[#DCE6DC] bg-[#FAFCF9] font-extrabold">
                                      <td colSpan={2} className="px-3 py-1.5 text-[11px] uppercase tracking-[.08em] text-[#5A6B62]">
                                        {parts.length > 1 ? `${parts.length} legs — principal repaid inside the period` : 'One leg — principal unchanged'}
                                      </td>
                                      <td className="px-2 py-1.5 text-right tabular-nums">{n(r.days)}</td>
                                      <td colSpan={2} />
                                      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                                        {formatINR(r.balance_of ? n(r.balance_of.due) : n(r.gross))}
                                      </td>
                                    </tr>
                                    {r.balance_of && (
                                      <>
                                        <tr className="text-[#5A6B62]">
                                          <td colSpan={5} className="px-3 py-1 text-right text-[11px] font-bold">Already paid on these days</td>
                                          <td className="whitespace-nowrap px-3 py-1 text-right font-bold tabular-nums">− {formatINR(n(r.balance_of.paid))}</td>
                                        </tr>
                                        <tr className="text-[#B3261E]">
                                          <td colSpan={5} className="px-3 py-1 text-right text-[11px] font-extrabold">Balance to pay now</td>
                                          <td className="whitespace-nowrap px-3 py-1 text-right font-extrabold tabular-nums">{formatINR(n(r.gross))}</td>
                                        </tr>
                                      </>
                                    )}
                                    <tr className="text-[#5A6B62]">
                                      <td colSpan={5} className="px-3 py-1 text-right text-[11px] font-bold">TDS {n(r.tds_pct)}% withheld</td>
                                      <td className="whitespace-nowrap px-3 py-1 text-right font-bold tabular-nums">− {formatINR(fig(r).tds)}</td>
                                    </tr>
                                    <tr className="text-[#0B6B45]">
                                      <td colSpan={5} className="px-3 pb-2 pt-1 text-right text-[11px] font-extrabold">Net paid to the NBFC{fig(r).edited ? ' (as typed)' : ''}</td>
                                      <td className="whitespace-nowrap px-3 pb-2 pt-1 text-right font-extrabold tabular-nums">{formatINR(fig(r).net)}</td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#DCE6DC] bg-[#F5F8F4] font-extrabold">
                    <td colSpan={4} className="px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
                      Total · {sel.length} of {payable.length} bill{payable.length === 1 ? '' : 's'} paid
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#33473E]">{formatINR(r2(pool.reduce((t, r) => t + n(r.gross), 0)))}</td>
                    <td className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', lumpTotal != null ? 'text-[#8A5300]' : 'text-[#0A1F17]')}>{formatINR(tot.gross)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#B3261E]">
                      {(() => {
                        const left = r2(pool.reduce((t, r) => t + n(r.gross) - fig(r).gross, 0))
                        return Math.abs(left) < 0.005 ? <span className="text-[#9AAFA2]">nil</span> : left > 0 ? formatINR(left) : <span className="text-[#8A5300]">+{formatINR(-left)} over</span>
                      })()}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(tot.tds)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-[#0B6B45]">{formatINR(tot.net)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            </div>
          )}

        </div>
        <div className="flex flex-none flex-wrap items-end gap-2.5 border-t border-[#E4ECE3] bg-[#FBFCFA] px-3 py-3 sm:gap-3 sm:px-5" onKeyDown={arrowsAcross}>
          <div className="min-w-[200px] flex-1 basis-[220px]">
            <span className={lbl}>Paid from bank</span>
            <Select searchable value={bank} onValueChange={setBank}>
              <SelectTrigger className={FIELD}>
                <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><Landmark className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue placeholder="The first bill’s own bank" /></span></span>
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {banks.map((b) => (
                  <SelectItem key={String(b.name)} value={String(b.name)}>
                    {String(b.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[200px] flex-1 basis-[220px]">
            <span className={lbl}>TDS ledger</span>
            <Select searchable value={tdsLedger} onValueChange={setTdsLedger}>
              <SelectTrigger className={FIELD}>
                <span className="flex min-w-0 items-center gap-2 text-left"><span className={FICON}><Percent className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate"><SelectValue placeholder="TDS on interest payable (usual)" /></span></span>
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {tdsLedgers.map((b) => (
                  <SelectItem key={String(b.name)} value={String(b.name)}>
                    {String(b.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[220px] flex-[1.4] basis-[260px]">
            <label htmlFor="bdcum-note" className={lbl}>
              Note <span className="text-[#B3261E]">*</span> <span className="normal-case tracking-normal text-[#8CA396]">— goes into the narration</span>
            </label>
            <input
              id="bdcum-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Blacksoil interest Oct-26, debit advice no."
              className={cn(
                'h-9 w-full rounded-[4px] border bg-white px-2.5 text-[13px] font-semibold outline-none focus:border-[#0B6B45] focus:ring-2 focus:ring-[#0B6B45]/15',
                note.trim() ? 'border-[#C9DCCF]' : 'border-[#E3B66B] bg-[#FFFBF3]'
              )}
            />
          </div>
          <div>
            <span className={lbl}>Post as</span>
            <span className="flex h-10 rounded-[7px] border border-[#C9DCCF] bg-white p-0.5">
              {(
                [
                  [false, 'One payment', 'Dr Interest · Cr TDS · Cr Bank — one voucher'],
                  [true, 'Via NBFC (2 vouchers)', 'Journal: Dr Interest · Cr NBFC · Cr TDS — then Payment: Dr NBFC · Cr Bank']
                ] as const
              ).map(([k, label, tip]) => (
                <button
                  key={String(k)}
                  type="button"
                  title={tip}
                  onClick={() => setViaNbfc(k)}
                  className={cn('whitespace-nowrap rounded-[5px] px-3 text-[12px] font-semibold', viaNbfc === k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div className="w-full sm:w-[170px]">
            <span className={lbl}>Payment date</span>
            <DatePicker value={paidOn} max={today} onChange={(v) => v && setPaidOn(v)} />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-ctrl-a
            disabled={busy || !sel.length || !note.trim()}
            title={`One bank voucher: Dr Interest ${formatINR(tot.gross)} · Cr TDS ${formatINR(tot.tds)} · Cr bank ${formatINR(tot.net)} — linked to every ticked bill`}
            onClick={() => void pay()}
            className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Pay {sel.length ? `${formatINR(tot.net)} · ${sel.length} bill${sel.length === 1 ? '' : 's'}` : ''}
          </button>
        </div>
        </>
        )}
      </DialogContent>
      {splitRow && (
        <PrincipalSplit
          leg={!(Array.isArray(splitRow.parts) && splitRow.parts.length > 1)}
          x={{
            from_date: splitRow.from_date,
            to_date: splitRow.to_date,
            days: splitRow.days,
            principal: n(splitRow.parts?.[0]?.principal) || n(splitRow.principal),
            gross: fig(splitRow).gross,
            parts: splitRow.parts
          }}
          onClose={() => setSplitRow(null)}
        />
      )}
    </Dialog>
  )
}
