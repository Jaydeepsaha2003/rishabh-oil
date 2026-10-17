import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpRight,
  CalendarCheck2,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Eye,
  FilterX,
  Landmark,
  LockOpen,
  Percent,
  ReceiptText,
  Scale,
  Search,
  Timer,
  CalendarCheck,
  BookOpen,
  CircleHelp,
  Lightbulb,
  ListChecks,
  MousePointerClick,
  X
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatINR } from '@/lib/format'
import { useDrawerEscape } from '@/lib/escape'
import { cn } from '@/lib/utils'

type Row = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────────
// THE PAYMENT TRACKER — built to the Treasury canvas (Payment Tracker.dc).
//
// One list of everything that moves money on a date: what goes out to a bank
// or an NBFC, and what comes back in. The rows come from paymentTracker.ts,
// which derives every one of them from the LC and BD registers — so a row is
// never "marked paid" here. Its button opens the register's own screen (Repay,
// Pay interest, Mark received), the voucher is posted there, and the row
// settles itself because the register now says so.
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'lc_mat' | 'bd_mat' | 'bd_int' | 'pay_in' | 'margin'
const KIND: Record<Kind, { label: string; Icon: typeof Landmark; fg: string; bg: string; bd: string; dot: string }> = {
  lc_mat: { label: 'LC maturity', Icon: Landmark, fg: '#0B3D2E', bg: '#EAF0E9', bd: '#C3D2C6', dot: '#0B3D2E' },
  bd_mat: { label: 'BD repayment', Icon: ReceiptText, fg: '#1A2C56', bg: '#EAF0FA', bd: '#C6DAF0', dot: '#1A2C56' },
  bd_int: { label: 'BD interest', Icon: Percent, fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', dot: '#C2700A' },
  pay_in: { label: 'Payment in', Icon: ArrowDownLeft, fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', dot: '#12855A' },
  margin: { label: 'Margin release', Icon: LockOpen, fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', dot: '#5B8FCC' }
}
const KIND_ORDER: Kind[] = ['lc_mat', 'bd_mat', 'bd_int', 'pay_in', 'margin']

type Win = 'all' | 'overdue' | 'today' | '3d' | '7d' | '30d'
type Dir = 'all' | 'out' | 'in'

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const crore = (v: number): string => {
  const a = Math.abs(v)
  const s = v < 0 ? '−₹' : '₹'
  if (a >= 1e7) return s + (a / 1e7).toFixed(2).replace(/\.00$/, '') + ' Cr'
  if (a >= 1e5) return s + (a / 1e5).toFixed(2).replace(/\.00$/, '') + ' L'
  if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + ' K'
  return formatINR(v)
}
const signed = (v: number): string => (v < 0 ? '−' + formatINR(-v) : formatINR(v))
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function dueLabel(iso: unknown): string {
  const s = String(iso || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—'
  const d = new Date(`${s}T00:00:00`)
  return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)} · ${WD[d.getDay()]}`
}
const dmy = (iso: unknown): string => {
  const s = String(iso || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : ''
}
function isoPlus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`
}

// Days from today, or null for a row with no date to measure.
const dOf = (r: Row): number | null => (r.days_left == null ? null : n(r.days_left))

function inWin(r: Row, w: Win): boolean {
  if (w === 'all') return true
  const d = dOf(r)
  if (d == null) return false
  // A settled row is not overdue, however long ago it fell due; only one
  // still ahead of its date belongs in a window.
  if (r.settled && d < 0) return false
  if (w === 'overdue') return d < 0
  if (w === 'today') return d === 0
  return d <= (w === '3d' ? 3 : w === '7d' ? 7 : 30)
}

// The button a row carries. None of them settle anything here — see the head.
function actionOf(r: Row): { label: string; Icon: typeof Check; primary: boolean } {
  if (r.settled) return { label: 'View', Icon: Eye, primary: false }
  switch (String(r.action)) {
    case 'repay':
      return { label: 'Repay', Icon: Check, primary: true }
    case 'preclose':
      return { label: 'Preclose', Icon: Check, primary: true }
    case 'interest':
      return { label: 'Pay interest', Icon: Check, primary: true }
    case 'payin':
      return { label: 'Mark received', Icon: Check, primary: true }
    default:
      return { label: 'Record', Icon: Check, primary: true }
  }
}

const GRID = '150px minmax(260px,1.6fr) minmax(170px,1fr) 150px 140px 132px 150px'

// The filters and everything derived from them — one set of rules for the
// desktop table and the phone cards, so the two cannot count differently.
function useTrackerView(rows: Row[]) {
  const [win, setWin] = useState<Win>('all')
  const [dir, setDir] = useState<Dir>('all')
  const [kinds, setKinds] = useState<Kind[]>([])
  const [lender, setLender] = useState('all')
  const [lenderOpen, setLenderOpen] = useState(false)
  const [q, setQ] = useState('')
  const [showSettled, setShowSettled] = useState(false)
  const [sort, setSort] = useState<'due' | 'amount'>('due')

  const v = useMemo(() => {
    const all = rows
    const query = q.trim().toLowerCase()
    // Every filter except the one being counted, so each chip says what it
    // would show if it were picked.
    const base = (skip: 'win' | 'dir' | 'kind' | 'lender' | null): Row[] =>
      all.filter(
        (x) =>
          (showSettled || !x.settled) &&
          (skip === 'win' || inWin(x, win)) &&
          (skip === 'dir' || dir === 'all' || x.dir === dir) &&
          (skip === 'kind' || !kinds.length || kinds.includes(x.kind as Kind)) &&
          (skip === 'lender' || lender === 'all' || x.lender === lender) &&
          (!query || `${x.ref} ${x.party} ${x.lender} ${x.detail}`.toLowerCase().includes(query))
      )
    const shown = base(null)
      .slice()
      .sort((a, b) =>
        sort === 'amount'
          ? n(b.amount) - n(a.amount)
          : (dOf(a) ?? Infinity) - (dOf(b) ?? Infinity) || n(b.amount) - n(a.amount)
      )
    const sum = (arr: Row[]): number => arr.reduce((t, x) => t + n(x.amount), 0)
    const outSum = (arr: Row[]): number => sum(arr.filter((x) => x.dir === 'out'))
    const inSum = (arr: Row[]): number => sum(arr.filter((x) => x.dir === 'in'))

    // The buckets a due-date list is read in. Settled last: switching it on
    // is a look back, and should not push today's work down the page.
    const BUCKETS: { key: string; label: string; Icon: typeof Clock; test: (x: Row) => boolean; fg: string; bg: string; bd: string }[] = [
      { key: 'late', label: 'Overdue', Icon: CircleAlert, test: (x) => !x.settled && (dOf(x) ?? 0) < 0 && dOf(x) != null, fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4' },
      { key: 'today', label: 'Due today', Icon: CalendarCheck, test: (x) => !x.settled && dOf(x) === 0, fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6' },
      { key: 'soon', label: 'Maturing in the next 3 days', Icon: Timer, test: (x) => !x.settled && (dOf(x) ?? -1) >= 1 && (dOf(x) ?? 99) <= 3, fg: '#8A5300', bg: '#FFFBF2', bd: '#F0E4CB' },
      { key: 'week', label: 'Later this week', Icon: CalendarRange, test: (x) => !x.settled && (dOf(x) ?? -1) >= 4 && (dOf(x) ?? 99) <= 7, fg: '#33473E', bg: '#F7FAF6', bd: '#E4ECE3' },
      { key: 'later', label: 'Later', Icon: CalendarDays, test: (x) => !x.settled && (dOf(x) ?? -1) > 7, fg: '#33473E', bg: '#F7FAF6', bd: '#E4ECE3' },
      { key: 'nodate', label: 'No due date set', Icon: CalendarX2, test: (x) => !x.settled && dOf(x) == null, fg: '#5A6B62', bg: '#F7FAF6', bd: '#E4ECE3' },
      { key: 'settled', label: 'Settled', Icon: CircleCheck, test: (x) => !!x.settled, fg: '#0B6B45', bg: '#F4FBF6', bd: '#BFE3CB' }
    ]
    const order =
      sort === 'amount'
        ? [{ key: 'all', label: 'Largest first', Icon: ArrowDownWideNarrow, test: () => true, fg: '#33473E', bg: '#F7FAF6', bd: '#E4ECE3' }]
        : BUCKETS
    const placed = new Set<string>()
    const groups = order
      .map((bk) => {
        const list = shown.filter((x) => !placed.has(String(x.key)) && bk.test(x))
        list.forEach((x) => placed.add(String(x.key)))
        return { ...bk, rows: list, out: outSum(list.filter((x) => !x.settled)), in: inSum(list.filter((x) => !x.settled)) }
      })
      .filter((g) => g.rows.length)

    const live = all.filter((x) => !x.settled)
    const late = live.filter((x) => dOf(x) != null && (dOf(x) as number) < 0)
    const soon = live.filter((x) => dOf(x) != null && (dOf(x) as number) >= 0 && (dOf(x) as number) <= 3)
    const month = live.filter((x) => dOf(x) != null && (dOf(x) as number) <= 30)
    const liveShown = shown.filter((x) => !x.settled)
    const lenders = Array.from(new Set(all.map((x) => String(x.lender || '')).filter(Boolean))).sort()
    const presentKinds = KIND_ORDER.filter((k) => all.some((x) => x.kind === k))
    return {
      shown,
      groups,
      late,
      soon,
      month,
      outSum,
      inSum,
      lenders,
      presentKinds,
      winBase: base('win'),
      kindBase: base('kind'),
      lenderBase: base('lender'),
      total: all.filter((x) => showSettled || !x.settled).length,
      footOut: outSum(liveShown),
      footIn: inSum(liveShown)
    }
  }, [rows, q, win, dir, kinds, lender, showSettled, sort])

  const filtered = win !== 'all' || dir !== 'all' || kinds.length > 0 || lender !== 'all' || !!q.trim()
  const clear = (): void => {
    setWin('all')
    setDir('all')
    setKinds([])
    setLender('all')
    setQ('')
  }
  return { win, setWin, dir, setDir, kinds, setKinds, lender, setLender, lenderOpen, setLenderOpen, q, setQ, showSettled, setShowSettled, sort, setSort, v, filtered, clear }
}

export function PaymentTracker({
  rows,
  onAction,
  canAct
}: {
  rows: Row[]
  // Opens the register screen that settles the row (or shows a settled one).
  onAction: (r: Row) => void
  // Whether this viewer may open that register at all.
  canAct: (r: Row) => boolean
}): React.JSX.Element {
  const { win, setWin, dir, setDir, kinds, setKinds, lender, setLender, lenderOpen, setLenderOpen, q, setQ, showSettled, setShowSettled, sort, setSort, v, filtered, clear } =
    useTrackerView(rows)
  const [helpOpen, setHelpOpen] = useState(false)
  const net = v.footIn - v.footOut
  const monthNet = v.inSum(v.month) - v.outSum(v.month)

  const tiles: { k: string; Icon: typeof Clock; v: string; sub: string; accent: string; fg: string; win: Win }[] = [
    {
      k: 'Overdue',
      Icon: CircleAlert,
      v: formatINR(v.late.reduce((t, x) => t + n(x.amount), 0)),
      sub: `${v.late.length} item${v.late.length === 1 ? '' : 's'} past the due date`,
      accent: '#B3261E',
      fg: v.late.length ? '#B3261E' : '#0A1F17',
      win: 'overdue'
    },
    {
      k: 'Paying out · 3 days',
      Icon: Timer,
      v: formatINR(v.outSum(v.soon)),
      sub: `${v.soon.filter((x) => x.dir === 'out').length} to pay · today to ${isoPlus(3)}`,
      accent: '#C2700A',
      fg: '#8A5300',
      win: '3d'
    },
    {
      k: 'Coming in · 3 days',
      Icon: ArrowDownLeft,
      v: formatINR(v.inSum(v.soon)),
      sub: `${v.soon.filter((x) => x.dir === 'in').length} receipts and releases`,
      accent: '#12855A',
      fg: '#0B6B45',
      win: '3d'
    },
    {
      k: 'Net · next 30 days',
      Icon: Scale,
      v: signed(monthNet),
      sub: `in ${crore(v.inSum(v.month))} · out ${crore(v.outSum(v.month))}`,
      accent: '#0B3D2E',
      fg: monthNet < 0 ? '#8C2F26' : '#0B6B45',
      win: '30d'
    }
  ]

  const WINS: [Win, string][] = [
    ['all', 'All'],
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['3d', '≤ 3 days'],
    ['7d', '≤ 7 days'],
    ['30d', '≤ 30 days']
  ]
  const DIRS: [Dir, string, typeof Clock][] = [
    ['all', 'In & out', ArrowUpDown],
    ['out', 'Paying out', ArrowUpRight],
    ['in', 'Coming in', ArrowDownLeft]
  ]

  return (
    <div className="flex flex-col gap-3">
      {/* THE FOUR FIGURES. Each is also a filter: a click narrows the list
          to the window it counts, and a second click lets it go. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {tiles.map((k) => {
          const on = win === k.win
          return (
            <button
              key={k.k}
              type="button"
              onClick={() => setWin(on ? 'all' : k.win)}
              className="min-w-0 rounded-[4px] border bg-white px-3.5 py-3 text-left transition-shadow"
              style={{ borderColor: on ? k.accent : '#D6E2D6', borderTop: `3px solid ${k.accent}`, boxShadow: on ? `0 0 0 2px ${k.accent}22` : 'none' }}
            >
              <div className="flex items-center gap-[7px]">
                <k.Icon className="h-[17px] w-[17px] flex-none" style={{ color: k.accent }} />
                <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{k.k}</span>
              </div>
              <div className="mt-[7px] truncate text-[20px] font-bold tabular-nums tracking-[-0.03em]" style={{ color: k.fg }}>
                {k.v}
              </div>
              <div className="mt-[3px] truncate text-[11.5px] font-semibold text-[#5A6B62]">{k.sub}</div>
            </button>
          )
        })}
      </div>

      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
        <div className="flex flex-col gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <label
              className="flex h-9 min-w-0 max-w-[340px] flex-[1_1_240px] items-center gap-2 rounded-[4px] border bg-white px-2.5"
              style={{ borderColor: q.trim() ? '#12855A' : '#C3D2C6' }}
            >
              <Search className="h-[18px] w-[18px] flex-none text-[#5A6B62]" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Reference, party or lender"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8CA396]"
              />
            </label>
            <div className="flex gap-0.5 rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-0.5">
              {WINS.map(([k, label]) => {
                const on = win === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setWin(k)}
                    className={cn('flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[3px] px-2.5 text-[11.5px] font-extrabold', on ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-white/60')}
                  >
                    {label}
                    <span className={cn('text-[10px] font-bold tabular-nums', on ? 'text-[#C7F03F]' : 'text-[#5A6B62]')}>
                      {v.winBase.filter((x) => inWin(x, k)).length}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="flex gap-0.5 rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-0.5">
              {DIRS.map(([k, label, Icon]) => {
                const on = dir === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDir(k)}
                    className={cn('flex h-[30px] items-center gap-[5px] whitespace-nowrap rounded-[3px] px-2.5 text-[11.5px] font-extrabold', on ? 'text-white' : 'text-[#33473E] hover:bg-white/60')}
                    style={on ? { background: k === 'in' ? '#0B6B45' : k === 'out' ? '#8C2F26' : '#0B3D2E' } : undefined}
                  >
                    <Icon className="h-[15px] w-[15px]" />
                    {label}
                  </button>
                )
              })}
            </div>
            <Popover open={lenderOpen} onOpenChange={setLenderOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-9 max-w-[280px] items-center gap-2 whitespace-nowrap rounded-[4px] border bg-white px-[11px] text-[12px] font-extrabold text-[#0A1F17]"
                  style={{ borderColor: lender === 'all' ? '#C3D2C6' : '#12855A' }}
                >
                  <Landmark className="h-[17px] w-[17px] flex-none text-[#5A6B62]" />
                  <span className="min-w-0 truncate">{lender === 'all' ? 'All banks & NBFCs' : lender}</span>
                  <ChevronDown className="h-[17px] w-[17px] flex-none text-[#5A6B62]" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="!w-[290px] !rounded-[4px] !border-[#C3D2C6] !p-1 !shadow-[0_12px_30px_rgba(10,31,23,.18)]">
                {['all', ...v.lenders].map((l) => {
                  const on = lender === l
                  const count = l === 'all' ? v.lenderBase.length : v.lenderBase.filter((x) => x.lender === l).length
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => {
                        setLender(l)
                        setLenderOpen(false)
                      }}
                      className={cn('flex min-h-9 w-full items-center gap-[9px] rounded-[3px] px-2.5 text-left text-[12px] hover:bg-[#F7FAF6]', on ? 'bg-[#F3FBE2] font-extrabold' : 'font-semibold')}
                    >
                      <Check className={cn('h-4 w-4 flex-none text-[#0B3D2E]', !on && 'invisible')} />
                      <span className="min-w-0 flex-1 truncate">{l === 'all' ? 'All banks & NBFCs' : l}</span>
                      <span className="text-[10.5px] tabular-nums text-[#5A6B62]">{count}</span>
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setSort((s) => (s === 'amount' ? 'due' : 'amount'))}
              className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] text-[12px] font-extrabold text-[#0A1F17]"
            >
              <ArrowDownWideNarrow className="h-[17px] w-[17px] text-[#5A6B62]" />
              {sort === 'amount' ? 'Largest first' : 'By due date'}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={showSettled}
              onClick={() => setShowSettled((s) => !s)}
              className="flex h-9 items-center gap-2 whitespace-nowrap rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] text-[12px] font-extrabold text-[#33473E]"
            >
              <span
                className="flex h-[18px] w-[30px] rounded-[9px] p-0.5"
                style={{ background: showSettled ? '#12855A' : '#C3D2C6', justifyContent: showSettled ? 'flex-end' : 'flex-start' }}
              >
                <span className="h-[14px] w-[14px] rounded-full bg-white" />
              </span>
              Show settled
            </button>
            <button
              type="button"
              title="How to use this page — every figure, filter, row type and button"
              onClick={() => setHelpOpen(true)}
              className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] text-[12px] font-extrabold text-[#0B3D2E] hover:bg-[#F3FBE2]"
            >
              <CircleHelp className="h-[17px] w-[17px]" />
              Help
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-[7px]">
            <span className="mr-0.5 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Type</span>
            {v.presentKinds.map((k) => {
              const on = kinds.includes(k)
              const m = KIND[k]
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKinds((p) => (on ? p.filter((x) => x !== k) : [...p, k]))}
                  className="flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-[4px] border px-[11px] text-[12px] font-extrabold"
                  style={{ borderColor: on ? m.fg : '#DCE7DB', background: on ? m.bg : '#fff', color: on ? m.fg : '#33473E' }}
                >
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: m.dot }} />
                  {m.label}
                  <span className="text-[10.5px] font-bold tabular-nums" style={{ color: on ? m.fg : '#8CA396' }}>
                    {v.kindBase.filter((x) => x.kind === k).length}
                  </span>
                </button>
              )
            })}
            {filtered && (
              <button
                type="button"
                onClick={clear}
                className="flex h-[34px] items-center gap-[5px] px-2 text-[11.5px] font-extrabold text-[#0B6B45]"
              >
                <FilterX className="h-4 w-4" />
                CLEAR FILTERS
              </button>
            )}
          </div>
        </div>

        <div className="sc overflow-x-auto">
          <div className="min-w-[1080px]">
            <div
              className="grid h-9 items-center bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.12em] text-white"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="px-3.5">Type</span>
              <span className="px-2.5">Reference · party</span>
              <span className="px-2.5">Bank / NBFC</span>
              <span className="px-2.5 text-right">Amount</span>
              <span className="px-2.5">Due</span>
              <span className="px-2.5">Status</span>
              <span className="px-3.5 text-right">Action</span>
            </div>
            {v.groups.map((g) => (
              <div key={g.key}>
                <div className="flex h-[34px] items-center gap-2.5 border-b px-3.5" style={{ background: g.bg, borderColor: g.bd }}>
                  <g.Icon className="h-4 w-4" style={{ color: g.fg }} />
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em]" style={{ color: g.fg }}>
                    {g.label}
                  </span>
                  <span className="rounded-[9px] border bg-white px-[7px] py-px text-[10.5px] font-bold tabular-nums" style={{ color: g.fg, borderColor: g.bd }}>
                    {g.rows.length}
                  </span>
                  <span className="flex-1" />
                  {g.out > 0.004 && <span className="whitespace-nowrap text-[11.5px] font-bold tabular-nums text-[#8C2F26]">out {formatINR(g.out)}</span>}
                  {g.in > 0.004 && <span className="whitespace-nowrap text-[11.5px] font-bold tabular-nums text-[#0B6B45]">in {formatINR(g.in)}</span>}
                </div>
                {g.rows.map((r) => (
                  <TrackerRow key={String(r.key)} r={r} onAction={onAction} canAct={canAct(r)} />
                ))}
              </div>
            ))}
            {v.groups.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-[34px]">
                <CalendarCheck2 className="h-7 w-7 text-[#C3D2C6]" />
                <span className="text-[12.5px] font-bold text-[#5A6B62]">Nothing due under these filters.</span>
              </div>
            )}
            <div className="grid min-h-11 items-center border-t-2 border-t-[#C7F03F] bg-[#EFF5EC]" style={{ gridTemplateColumns: GRID }}>
              <span className="col-span-3 px-3.5 text-[11px] font-extrabold uppercase tracking-[.06em] text-[#0B3D2E]">
                Showing {v.shown.length} of {v.total}
              </span>
              <span className="whitespace-nowrap px-2.5 text-right text-[12px] font-bold tabular-nums text-[#8C2F26]">out {formatINR(v.footOut)}</span>
              <span className="col-span-3 flex items-center justify-end gap-3.5 whitespace-nowrap px-3.5 text-[12px] font-bold tabular-nums">
                <span className="text-[#0B6B45]">in {formatINR(v.footIn)}</span>
                <span style={{ color: net < 0 ? '#8C2F26' : '#0B6B45' }}>net {signed(net)}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <TrackerHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}

function TrackerRow({ r, onAction, canAct }: { r: Row; onAction: (r: Row) => void; canAct: boolean }): React.JSX.Element {
  const m = KIND[(r.kind as Kind) || 'lc_mat'] || KIND.lc_mat
  const d = dOf(r)
  const settled = !!r.settled
  const late = !settled && d != null && d < 0
  const today = !settled && d === 0
  const soon = !settled && d != null && d >= 1 && d <= 3
  const out = r.dir === 'out'
  const amtFg = out ? '#8C2F26' : '#0B6B45'
  const when = settled
    ? r.settled_date
      ? `settled ${dmy(r.settled_date)}`
      : 'settled'
    : d == null
      ? 'no date set'
      : late
        ? `${Math.abs(d)} ${Math.abs(d) === 1 ? 'day' : 'days'} overdue`
        : today
          ? 'due today'
          : `in ${d} ${d === 1 ? 'day' : 'days'}`
  const tone = settled ? 'good' : late ? 'bad' : today || soon ? 'warn' : 'none'
  const whenFg = tone === 'good' ? '#0B6B45' : tone === 'bad' ? '#B3261E' : tone === 'warn' ? '#8A5300' : '#5A6B62'
  const edge = settled ? '#12855A' : late ? '#B3261E' : today || soon ? '#C2700A' : 'transparent'
  const bg = settled ? '#FBFDFA' : late ? '#FFF8F7' : today ? '#FFFBF2' : '#fff'
  const status = settled
    ? { label: 'Settled', Icon: CircleCheck }
    : late
      ? { label: 'Overdue', Icon: CircleAlert }
      : today
        ? { label: 'Due today', Icon: CalendarCheck }
        : soon
          ? { label: 'Maturing', Icon: Timer }
          : d == null
            ? { label: 'No date', Icon: CalendarX2 }
            : { label: 'Upcoming', Icon: Clock }
  const stStyle =
    tone === 'good'
      ? { color: '#0B6B45', background: '#E9F5EE', borderColor: '#BFE3CB' }
      : tone === 'bad'
        ? { color: '#B3261E', background: '#FDF3F2', borderColor: '#F0D6D4' }
        : tone === 'warn'
          ? { color: '#8A5300', background: '#FFF4DD', borderColor: '#F1D9A6' }
          : { color: '#5A6B62', background: '#F1F5EF', borderColor: '#DCE7DB' }
  const act = actionOf(r)
  return (
    <div
      className="grid min-h-[52px] items-center border-b border-b-[#EAF0E9] hover:!bg-[#F7FAF6]"
      style={{ gridTemplateColumns: GRID, background: bg, boxShadow: `inset 3px 0 0 ${edge}`, opacity: settled ? 0.72 : 1 }}
    >
      <div className="pl-3.5 pr-2.5">
        <span
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[3px] border px-[7px] py-1 text-[10px] font-extrabold uppercase tracking-[.05em]"
          style={{ color: m.fg, background: m.bg, borderColor: m.bd }}
        >
          <m.Icon className="h-[13px] w-[13px]" />
          {m.label}
        </span>
      </div>
      <div className="min-w-0 px-2.5 py-1.5">
        <div className="truncate text-[12.5px] font-extrabold text-[#0A1F17]">
          <span className="tabular-nums">{String(r.ref || '')}</span>
          {r.party ? ` · ${String(r.party)}` : ''}
        </div>
        <div className="mt-[3px] truncate text-[11px] font-semibold text-[#5A6B62]" title={String(r.detail || '')}>
          {String(r.detail || '')}
        </div>
      </div>
      <span className="truncate px-2.5 text-[11.5px] font-bold text-[#33473E]" title={String(r.lender || '')}>
        {String(r.lender || '—')}
      </span>
      <div className="px-2.5 text-right">
        <div className="whitespace-nowrap text-[13px] font-bold tabular-nums" style={{ color: amtFg }}>
          {formatINR(n(r.amount))}
        </div>
        <div className="mt-0.5 text-[10px] font-extrabold tracking-[.06em]" style={{ color: amtFg }}>
          {out ? 'PAY OUT' : 'COMING IN'}
        </div>
      </div>
      <div className="px-2.5">
        <div className="whitespace-nowrap text-[12.5px] font-bold tabular-nums text-[#0A1F17]">{dueLabel(r.due_date)}</div>
        <div className="mt-0.5 whitespace-nowrap text-[11px] font-extrabold" style={{ color: whenFg }}>
          {when}
        </div>
      </div>
      <div className="px-2.5">
        <span className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[3px] border px-[7px] py-1 text-[10px] font-extrabold uppercase tracking-[.05em]" style={stStyle}>
          <status.Icon className="h-[13px] w-[13px]" />
          {status.label}
        </span>
      </div>
      <div className="flex justify-end pl-2 pr-3.5">
        {canAct && (
          <button
            type="button"
            onClick={() => onAction(r)}
            className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-[11px] text-[11.5px] font-extrabold"
            style={
              act.primary
                ? { background: out ? '#0B3D2E' : '#0B6B45', color: '#fff', borderColor: 'transparent' }
                : { background: '#fff', color: '#33473E', borderColor: '#C3D2C6' }
            }
          >
            <act.Icon className="h-4 w-4" />
            {act.label}
          </button>
        )}
      </div>
    </div>
  )
}

// ── THE PHONE ─────────────────────────────────────────────────────────────
// The canvas's mobile screen: the three figures for the Treasury header, then
// the filters as rows that scroll sideways, then a card per payment in the
// same buckets as the desktop table.

/** The Treasury header's three figures while the tracker tab is open. */
export function trackerHeadline(rows: Row[]): { k: string; v: string; go: string }[] {
  const live = rows.filter((x) => !x.settled)
  const sum = (arr: Row[]): number => arr.reduce((t, x) => t + n(x.amount), 0)
  const late = live.filter((x) => dOf(x) != null && (dOf(x) as number) < 0)
  const soon = live.filter((x) => dOf(x) != null && (dOf(x) as number) >= 0 && (dOf(x) as number) <= 3)
  return [
    // `go` is what tapping the card shows: the window, then the direction.
    { k: `Late · ${late.length}`, v: crore(sum(late)), go: 'tr:overdue:all' },
    { k: 'Out · 3d', v: crore(sum(soon.filter((x) => x.dir === 'out'))), go: 'tr:3d:out' },
    { k: 'In · 3d', v: crore(sum(soon.filter((x) => x.dir === 'in'))), go: 'tr:3d:in' }
  ]
}

export function PaymentTrackerMobile({
  rows,
  loading,
  onAction,
  canAct,
  preset
}: {
  rows: Row[]
  loading?: boolean
  onAction: (r: Row) => void
  canAct: (r: Row) => boolean
  /** A header card tapped: show this window and direction. `n` makes a repeat tap count. */
  preset?: { win: string; dir: string; n: number } | null
}): React.JSX.Element {
  const { win, setWin, dir, setDir, kinds, setKinds, q, setQ, v, filtered, clear } = useTrackerView(rows)
  useEffect(() => {
    if (!preset) return
    setWin(preset.win as Win)
    setDir(preset.dir as Dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.n])
  const [helpOpen, setHelpOpen] = useState(false)
  const WINS: [Win, string][] = [
    ['all', 'All'],
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['3d', '≤ 3 days'],
    ['7d', '≤ 7 days'],
    ['30d', '≤ 30 days']
  ]
  const DIRS: [Dir, string, typeof Clock][] = [
    ['all', 'In & out', ArrowUpDown],
    ['out', 'Paying out', ArrowUpRight],
    ['in', 'Coming in', ArrowDownLeft]
  ]
  const scrollRow = 'flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
  return (
    <>
      <div className="flex flex-none flex-col gap-2 border-b border-b-[#D6E2D6] bg-white px-4 py-2.5">
        <div className="flex gap-2">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-[9px] rounded-[4px] border border-[#C3D2C6] px-3">
            <Search className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Reference, party or lender"
              className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#0A1F17] outline-none placeholder:text-[#8FA79B]"
            />
          </label>
          <button
            type="button"
            aria-label="How to use this page"
            onClick={() => setHelpOpen(true)}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-[4px] border border-[#C3D2C6] bg-white text-[#0B3D2E]"
          >
            <CircleHelp className="h-5 w-5" />
          </button>
        </div>
        <div className={scrollRow}>
          {WINS.map(([k, label]) => {
            const on = win === k
            return (
              <button
                key={k}
                type="button"
                onClick={() => setWin(k)}
                className="flex h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-3 text-[12px] font-extrabold"
                style={{ borderColor: on ? '#0B3D2E' : '#DCE7DB', background: on ? '#0B3D2E' : '#fff', color: on ? '#fff' : '#33473E' }}
              >
                {label}
                <span className="text-[10.5px] font-bold tabular-nums" style={{ color: on ? '#C7F03F' : '#5A6B62' }}>
                  {v.winBase.filter((x) => inWin(x, k)).length}
                </span>
              </button>
            )
          })}
        </div>
        <div className={scrollRow}>
          {DIRS.map(([k, label, Icon]) => {
            const on = dir === k
            return (
              <button
                key={k}
                type="button"
                onClick={() => setDir(k)}
                className="flex h-10 flex-none items-center gap-[5px] whitespace-nowrap rounded-[4px] border px-3 text-[12px] font-extrabold"
                style={{
                  borderColor: on ? 'transparent' : '#DCE7DB',
                  background: on ? (k === 'in' ? '#0B6B45' : k === 'out' ? '#8C2F26' : '#0B3D2E') : '#fff',
                  color: on ? '#fff' : '#33473E'
                }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            )
          })}
          {v.presentKinds.map((k) => {
            const on = kinds.includes(k)
            const m = KIND[k]
            return (
              <button
                key={k}
                type="button"
                onClick={() => setKinds((p) => (on ? p.filter((x) => x !== k) : [...p, k]))}
                className="flex h-10 flex-none items-center gap-[7px] whitespace-nowrap rounded-[4px] border px-3 text-[12px] font-extrabold"
                style={{ borderColor: on ? m.fg : '#DCE7DB', background: on ? m.bg : '#fff', color: on ? m.fg : '#33473E' }}
              >
                <span className="h-2 w-2 rounded-[2px]" style={{ background: m.dot }} />
                {m.label}
              </button>
            )
          })}
          {filtered && (
            <button type="button" onClick={clear} className="flex h-10 flex-none items-center gap-[5px] whitespace-nowrap px-2 text-[11.5px] font-extrabold text-[#0B6B45]">
              <FilterX className="h-4 w-4" />
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pb-6 pt-3">
        {loading && rows.length === 0 ? (
          <div className="py-16 text-center text-[13px] font-semibold text-[#5A6B62]">Reading the tracker…</div>
        ) : (
          <>
            {v.groups.map((g) => (
              <div key={g.key} className="flex flex-none flex-col gap-2">
                <div className="flex items-center gap-2 px-0.5 pt-1">
                  <g.Icon className="h-4 w-4" style={{ color: g.fg }} />
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em]" style={{ color: g.fg }}>
                    {g.label}
                  </span>
                  <span className="text-[10.5px] font-bold tabular-nums" style={{ color: g.fg }}>
                    {g.rows.length}
                  </span>
                  <span className="h-px flex-1" style={{ background: g.bd }} />
                </div>
                {g.rows.map((r) => (
                  <TrackerCard key={String(r.key)} r={r} onAction={onAction} canAct={canAct(r)} />
                ))}
              </div>
            ))}
            {v.groups.length === 0 && (
              <div className="flex flex-none flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-[26px]">
                <CalendarCheck2 className="h-7 w-7 text-[#C3D2C6]" />
                <span className="text-[12.5px] font-bold text-[#5A6B62]">Nothing due under these filters.</span>
              </div>
            )}
          </>
        )}
      </div>
      <TrackerHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  )
}

function TrackerCard({ r, onAction, canAct }: { r: Row; onAction: (r: Row) => void; canAct: boolean }): React.JSX.Element {
  const m = KIND[(r.kind as Kind) || 'lc_mat'] || KIND.lc_mat
  const d = dOf(r)
  const settled = !!r.settled
  const late = !settled && d != null && d < 0
  const today = !settled && d === 0
  const soon = !settled && d != null && d >= 1 && d <= 3
  const out = r.dir === 'out'
  const edge = settled ? '#12855A' : late ? '#B3261E' : today || soon ? '#C2700A' : '#D6E2D6'
  const whenFg = settled ? '#0B6B45' : late ? '#B3261E' : today || soon ? '#8A5300' : '#5A6B62'
  const when = settled
    ? r.settled_date
      ? `settled ${dmy(r.settled_date)}`
      : 'settled'
    : d == null
      ? 'no date set'
      : late
        ? `${Math.abs(d)} ${Math.abs(d) === 1 ? 'day' : 'days'} overdue`
        : today
          ? 'due today'
          : `in ${d} ${d === 1 ? 'day' : 'days'}`
  const act = actionOf(r)
  return (
    <div
      className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white"
      style={{ borderLeft: `3px solid ${edge}`, opacity: settled ? 0.72 : 1 }}
    >
      <div className="flex flex-col gap-[7px] px-3 py-[11px]">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[3px] border px-[7px] py-[3px] text-[10px] font-extrabold uppercase tracking-[.05em]"
            style={{ color: m.fg, background: m.bg, borderColor: m.bd }}
          >
            <m.Icon className="h-[13px] w-[13px]" />
            {m.label}
          </span>
          <span className="ml-auto whitespace-nowrap text-[14px] font-bold tabular-nums" style={{ color: out ? '#8C2F26' : '#0B6B45' }}>
            {(out ? '−' : '+') + formatINR(n(r.amount))}
          </span>
        </div>
        <div className="text-[12.5px] font-extrabold leading-[1.35] text-[#0A1F17] [text-wrap:pretty]">
          <span className="tabular-nums">{String(r.ref || '')}</span>
          {r.party ? ` · ${String(r.party)}` : ''}
        </div>
        <div className="text-[11px] font-semibold leading-[1.4] text-[#5A6B62] [text-wrap:pretty]">
          {[r.lender, r.detail].filter(Boolean).map(String).join(' · ')}
        </div>
      </div>
      <div className="flex items-center gap-[9px] border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold tabular-nums text-[#0A1F17]">{dueLabel(r.due_date)}</div>
          <div className="mt-px text-[11px] font-extrabold" style={{ color: whenFg }}>
            {when}
          </div>
        </div>
        {canAct && (
          <button
            type="button"
            onClick={() => onAction(r)}
            className="flex h-11 flex-none items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-[13px] text-[12px] font-extrabold"
            style={
              act.primary
                ? { background: out ? '#0B3D2E' : '#0B6B45', color: '#fff', borderColor: 'transparent' }
                : { background: '#fff', color: '#33473E', borderColor: '#C3D2C6' }
            }
          >
            <act.Icon className="h-[17px] w-[17px]" />
            {act.label}
          </button>
        )}
      </div>
    </div>
  )
}

// ── HELP ───────────────────────────────────────────────────────────────────
// Everything on the page, explained where it is used: what each figure, filter,
// row type, status and button means, and what a button actually posts. Drawn
// with the page's own chips and buttons, so what is read here is what is seen
// there.

function HelpSection({ id, Icon, title, children }: { id: string; Icon: typeof Clock; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section id={id} className="flex-none scroll-mt-3 overflow-hidden rounded-[10px] border border-[#DCE7DB] bg-white">
      <div className="flex items-center gap-2 border-b border-b-[#EAF0E9] bg-[#F7FAF6] px-3.5 py-2.5">
        <Icon className="h-4 w-4 text-[#0B3D2E]" />
        <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#0A1F17]">{title}</span>
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

function HelpRow({ sample, title, children }: { sample?: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 border-b border-b-[#EFF3EE] px-3.5 py-2.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-3">
      {sample && <div className="flex-none sm:w-[150px]">{sample}</div>}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-extrabold text-[#0A1F17]">{title}</div>
        <div className="mt-0.5 text-[11.5px] font-semibold leading-[1.55] text-[#5A6B62] [text-wrap:pretty]">{children}</div>
      </div>
    </div>
  )
}

const kindChip = (k: Kind): React.JSX.Element => {
  const m = KIND[k]
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[3px] border px-[7px] py-1 text-[10px] font-extrabold uppercase tracking-[.05em]"
      style={{ color: m.fg, background: m.bg, borderColor: m.bd }}
    >
      <m.Icon className="h-[13px] w-[13px]" />
      {m.label}
    </span>
  )
}
const statusChip = (label: string, Icon: typeof Clock, tone: 'good' | 'bad' | 'warn' | 'none'): React.JSX.Element => {
  const st =
    tone === 'good'
      ? { color: '#0B6B45', background: '#E9F5EE', borderColor: '#BFE3CB' }
      : tone === 'bad'
        ? { color: '#B3261E', background: '#FDF3F2', borderColor: '#F0D6D4' }
        : tone === 'warn'
          ? { color: '#8A5300', background: '#FFF4DD', borderColor: '#F1D9A6' }
          : { color: '#5A6B62', background: '#F1F5EF', borderColor: '#DCE7DB' }
  return (
    <span className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[3px] border px-[7px] py-1 text-[10px] font-extrabold uppercase tracking-[.05em]" style={st}>
      <Icon className="h-[13px] w-[13px]" />
      {label}
    </span>
  )
}
const btnSample = (label: string, Icon: typeof Clock, kind: 'out' | 'in' | 'ghost'): React.JSX.Element => (
  <span
    className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-[11px] text-[11.5px] font-extrabold"
    style={
      kind === 'ghost'
        ? { background: '#fff', color: '#33473E', borderColor: '#C3D2C6' }
        : { background: kind === 'out' ? '#0B3D2E' : '#0B6B45', color: '#fff', borderColor: 'transparent' }
    }
  >
    <Icon className="h-4 w-4" />
    {label}
  </span>
)
const ctlSample = (label: string, Icon?: typeof Clock, on = false): React.JSX.Element => (
  <span
    className="inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-2.5 text-[11.5px] font-extrabold"
    style={on ? { background: '#0B3D2E', color: '#fff', borderColor: '#0B3D2E' } : { background: '#fff', color: '#33473E', borderColor: '#C3D2C6' }}
  >
    {Icon && <Icon className="h-[15px] w-[15px]" />}
    {label}
  </span>
)

const HELP_TOC: { id: string; label: string }[] = [
  { id: 'h-what', label: 'What this page is' },
  { id: 'h-figures', label: 'The four figures' },
  { id: 'h-filters', label: 'Finding rows' },
  { id: 'h-types', label: 'Row types' },
  { id: 'h-status', label: 'Status' },
  { id: 'h-buttons', label: 'Buttons' },
  { id: 'h-reading', label: 'Reading a row' },
  { id: 'h-tips', label: 'Good to know' }
]

function TrackerHelp({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useDrawerEscape(open, ref, onClose)
  if (!open) return null
  const jump = (id: string): void => {
    ref.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="flex-1" style={{ background: 'rgba(7,43,32,.42)' }} onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="How to use the Payment tracker"
        data-escape-layer="drawer"
        className="flex flex-none flex-col"
        style={{ width: 'min(100%,620px)', background: '#F4F7F2', boxShadow: '-18px 0 40px rgba(7,43,32,.28)' }}
      >
        <div className="flex-none text-white" style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', padding: '16px 20px' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Treasury · help</div>
              <div className="mt-[5px] text-[18px] font-extrabold tracking-[-0.02em]">How to use the Payment tracker</div>
              <div className="mt-1 text-[11.5px] font-semibold text-[#8FBFA8]">Every figure, filter, row and button on this page — and what each one does.</div>
            </div>
            <button
              type="button"
              title="Close (Esc)"
              onClick={onClose}
              className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[7px]"
              style={{ background: 'rgba(255,255,255,.1)' }}
            >
              <X className="h-[19px] w-[19px]" />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {HELP_TOC.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => jump(t.id)}
                className="rounded-[5px] px-2 py-1 text-[10.5px] font-extrabold text-[#DCEFE4] hover:bg-white/15"
                style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.12)' }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: '14px 16px 20px' }}>
          <HelpSection id="h-what" Icon={BookOpen} title="What this page is">
            <HelpRow title="One list of every payment Treasury expects">
              Money going <b className="text-[#8C2F26]">out</b> to banks and NBFCs — LCs falling due, bills to repay, interest to pay — and money coming{' '}
              <b className="text-[#0B6B45]">in</b>, sorted by the date it is due.
            </HelpRow>
            <HelpRow title="Nothing is typed here">
              Every row is read from the Letters of credit and Bill discounting registers. Add or change an LC or a bill there and this list follows on its own.
            </HelpRow>
            <HelpRow title="Rows settle themselves">
              A row&rsquo;s button opens the register&rsquo;s own screen. Post the voucher there and the row moves to <b>Settled</b> — there is no tick box to forget,
              and the tracker can never disagree with the books.
            </HelpRow>
            <HelpRow title="One company at a time">The list is for the company picked at the top right. Switch company there to see the other one.</HelpRow>
          </HelpSection>

          <HelpSection id="h-figures" Icon={Scale} title="The four figures">
            <HelpRow sample={ctlSample('Overdue', CircleAlert)} title="Overdue">
              Everything still open whose due date has passed — to pay or to receive. The line under it says how many.
            </HelpRow>
            <HelpRow sample={ctlSample('Paying out · 3 days', Timer)} title="Paying out · 3 days">
              What has to leave the bank from today to three days ahead.
            </HelpRow>
            <HelpRow sample={ctlSample('Coming in · 3 days', ArrowDownLeft)} title="Coming in · 3 days">
              What should arrive from today to three days ahead — Payment IN and margin releases.
            </HelpRow>
            <HelpRow sample={ctlSample('Net · next 30 days', Scale)} title="Net · next 30 days">
              Money in minus money out over the next 30 days, overdue included. Red means more is going out than coming in.
            </HelpRow>
            <HelpRow title="Click a figure to filter">
              Clicking a figure shows only the rows it counts. Click it again to show everything.
            </HelpRow>
          </HelpSection>

          <HelpSection id="h-filters" Icon={Search} title="Finding rows">
            <HelpRow sample={ctlSample('Search', Search)} title="Search box">
              Type any part of a reference (LC no, BD no), a party, a bank or NBFC, or the detail line.
            </HelpRow>
            <HelpRow sample={ctlSample('≤ 7 days', undefined, true)} title="Time window — All · Overdue · Today · ≤ 3 · ≤ 7 · ≤ 30 days">
              How far ahead to look. The windows include what is already overdue, so &ldquo;≤ 7 days&rdquo; is everything due by a week from today. The small number
              on each is how many rows it would show.
            </HelpRow>
            <HelpRow sample={ctlSample('Paying out', ArrowUpRight)} title="In & out · Paying out · Coming in">
              Show both directions, only what we pay, or only what we receive.
            </HelpRow>
            <HelpRow sample={ctlSample('All banks & NBFCs', Landmark)} title="Bank / NBFC picker">
              Narrow the list to one lender. The number beside each name is how many rows it has.
            </HelpRow>
            <HelpRow sample={ctlSample('By due date', ArrowDownWideNarrow)} title="By due date · Largest first">
              By due date groups the rows by when they fall due. Largest first lists them by amount, biggest at the top, in one group.
            </HelpRow>
            <HelpRow sample={ctlSample('Show settled')} title="Show settled">
              Brings back rows that are already done, at the bottom in a Settled group, for looking back.
            </HelpRow>
            <HelpRow sample={kindChip('bd_int')} title="Type chips">
              Tick one or more types to see only those. None ticked means all types.
            </HelpRow>
            <HelpRow sample={ctlSample('Clear filters', FilterX)} title="Clear filters">Appears once anything is filtered; puts every filter back to All.</HelpRow>
          </HelpSection>

          <HelpSection id="h-types" Icon={ListChecks} title="Row types">
            <HelpRow sample={kindChip('lc_mat')} title="LC maturity — pay out">
              The LC&rsquo;s open amount, owed back to the bank on its maturity date, for every LC the bank has paid out on. Any principal already repaid is taken
              off. Interest and charges were taken when the bank paid, so they are not added here.
            </HelpRow>
            <HelpRow sample={kindChip('bd_mat')} title="BD repayment — pay out">
              A discounted bill&rsquo;s outstanding principal, owed to the NBFC on its maturity date. Part-repayments are taken off.
            </HelpRow>
            <HelpRow sample={kindChip('bd_int')} title="BD interest — pay out">
              For a bill whose interest is paid as it runs: one row per interest period (&ldquo;Rest 2 of 4&rdquo;), due on the last day of the period. For a
              bill whose interest is paid upfront: one row until that payment is recorded. The amount is what leaves the bank — interest less TDS; the gross and
              the TDS are on the detail line.
            </HelpRow>
            <HelpRow sample={kindChip('pay_in')} title="Payment in — coming in">
              Money due back on an LC or bill: what the resale invoices of a trading deal still owe, or the drawn amount when the LC or bill names a term for it.
            </HelpRow>
            <HelpRow sample={kindChip('margin')} title="Margin release — coming in">
              A bill&rsquo;s margin the NBFC held back, due back once the bill is repaid. Only appears on bills that have a margin.
            </HelpRow>
          </HelpSection>

          <HelpSection id="h-status" Icon={Clock} title="Status">
            <HelpRow sample={statusChip('Overdue', CircleAlert, 'bad')} title="Overdue">Past its due date and still open. Red edge on the left of the row.</HelpRow>
            <HelpRow sample={statusChip('Due today', CalendarCheck, 'warn')} title="Due today">Falls due today. Amber edge.</HelpRow>
            <HelpRow sample={statusChip('Maturing', Timer, 'warn')} title="Maturing">Due in the next one to three days. Amber edge.</HelpRow>
            <HelpRow sample={statusChip('Upcoming', Clock, 'none')} title="Upcoming">Due later than three days from now.</HelpRow>
            <HelpRow sample={statusChip('No date', CalendarX2, 'none')} title="No date">
              A Payment in with no agreed term. Give the LC or bill a &ldquo;days&rdquo; term and it gets a date.
            </HelpRow>
            <HelpRow sample={statusChip('Settled', CircleCheck, 'good')} title="Settled">
              Done — the voucher that settles it is in the books. Only shown with Show settled on; the &ldquo;when&rdquo; line says the date it settled.
            </HelpRow>
          </HelpSection>

          <HelpSection id="h-buttons" Icon={MousePointerClick} title="Buttons">
            <HelpRow sample={btnSample('Repay', Check, 'out')} title="Repay — on an LC maturity">
              Opens the LC&rsquo;s Repay dialog (Letters of credit). Enter the date and what the bank debited; it posts the repayment from your bank and closes the
              LC. Shown once the LC has reached its maturity date.
            </HelpRow>
            <HelpRow sample={btnSample('Preclose', Check, 'out')} title="Preclose — on an LC not yet due">
              The same dialog for closing an LC early. The interest is recalculated over the days it actually ran.
            </HelpRow>
            <HelpRow sample={btnSample('Repay', Check, 'out')} title="Repay — on a BD repayment">
              Opens the bill&rsquo;s Repay screen (Bill discounting) on <b>Full repayment</b>: the principal back to the NBFC, all of it or an instalment.
            </HelpRow>
            <HelpRow sample={btnSample('Pay interest', Check, 'out')} title="Pay interest — on a BD interest period">
              Opens the bill&rsquo;s Repay screen on <b>Interest repayment</b>. Pick the date the interest is paid up to — from the day after the last payment, up to
              today. It posts Dr Interest on bill discounting, Cr TDS payable, Cr your bank.
            </HelpRow>
            <HelpRow sample={btnSample('Record', Check, 'out')} title="Record — on upfront interest not yet recorded">
              Opens the bill. Record the upfront interest payment there with the date and the bank it went from.
            </HelpRow>
            <HelpRow sample={btnSample('Mark received', Check, 'in')} title="Mark received — on a Payment in">
              Opens the Payment IN screen for that LC or bill. Pick the invoices the money is for and the date; it posts the receipt against them.
            </HelpRow>
            <HelpRow sample={btnSample('View', Eye, 'ghost')} title="View — on a settled row">Opens the LC or the bill to see what was posted.</HelpRow>
            <HelpRow title="No button on a row">
              Your login does not have access to the Letters of credit or Bill discounting register that row belongs to. On the phone, a bill&rsquo;s Payment in is
              recorded from the desktop.
            </HelpRow>
          </HelpSection>

          <HelpSection id="h-reading" Icon={Eye} title="Reading a row">
            <HelpRow title="Type · Reference · party">What it is, the LC or BD number and the party, with a detail line underneath — the period, the term, what is already paid.</HelpRow>
            <HelpRow title="Bank / NBFC">Who the money goes to or comes from.</HelpRow>
            <HelpRow title="Amount">
              <b className="text-[#8C2F26]">Red · PAY OUT</b> leaves the bank, <b className="text-[#0B6B45]">green · COMING IN</b> arrives.
            </HelpRow>
            <HelpRow title="Due">The date and weekday, and under it how many days overdue or how many days to go.</HelpRow>
            <HelpRow title="Group bars and the footer">
              Rows are grouped Overdue · Due today · Next 3 days · Later this week · Later · No due date · Settled, each bar showing its own out and in. The green
              footer adds up what is on screen: how many rows, total out, total in, and the net.
            </HelpRow>
          </HelpSection>

          <HelpSection id="h-tips" Icon={Lightbulb} title="Good to know">
            <HelpRow title="“bill repaid, interest not recorded”">
              The bill has gone back to the NBFC but its interest periods were never recorded. Use Pay interest to put them in the books.
            </HelpRow>
            <HelpRow title="The list refreshes when you come back">Settle something on the LC or BD tab, return here, and the row has already moved.</HelpRow>
            <HelpRow title="Figures follow the registers">
              If an amount looks wrong, open the LC or bill (View or its button) — the row is only ever what that record says.
            </HelpRow>
            <HelpRow title="Esc closes this help">Or click anywhere outside it.</HelpRow>
          </HelpSection>
        </div>
      </div>
    </div>
  )
}
