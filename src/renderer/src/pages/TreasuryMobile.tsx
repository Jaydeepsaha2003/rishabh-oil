// Treasury on a phone — website only (see the fork point in Treasury.tsx).
//
// Built to the mobile screen in Treasury.dc.html (its `isMobileView` branch,
// 390x844): forest header carrying the company and three figures, LC/BD tabs
// with counts, one search row, then a facility summary grid and a card per
// instrument. Colours, type sizes and spacing are that handoff's, not guessed;
// its Material Symbols are substituted with the lucide icons this codebase
// already uses, which the handoff itself says to do.
//
// Data is real, off the same channels the desktop page uses — lc.list(),
// billDiscounting.list(), lc.getLimit(), bd.kpis() — so nothing here can
// disagree with the desktop view about what is outstanding.
//
// READ-ONLY, deliberately. The handoff draws a primary action and a Preclose
// button on each card; opening an LC, precloseing one or logging a repayment
// are money-moving flows with their own validation, and a button that fires
// one from a half-built screen is worse than no button. This screen answers
// "what is out, with whom, and when is it due" — which is what Treasury is
// opened for away from a desk. The actions come next, on top of this.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Banknote,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Landmark,
  Search,
  SlidersHorizontal
} from 'lucide-react'
import { formatDate, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

// Rupees, short. A phone header cannot hold ₹24,24,83,660 — and at a glance
// "24.25 Cr" is the figure being read anyway. Lakhs and crores because that is
// how the mill's own books are quoted.
function inrShort(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

function inrFull(v: number): string {
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Days from today, negative meaning it has already passed.
function daysTo(iso: unknown): number | null {
  const d = s(iso).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const then = new Date(`${d}T00:00:00`)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((then.getTime() - now.getTime()) / 86400000)
}

const T = {
  forest: '#0B3D2E',
  lime: '#C7F03F',
  limeInk: '#12280B',
  muted: '#8FBFA8',
  ground: '#F1F5EF',
  card: '#FFFFFF',
  border: '#D6E2D6',
  rule: '#EAF0E9',
  head: '#F7FAF6',
  ink: '#0A1F17',
  inkMid: '#33473E',
  inkSoft: '#5A6B62',
  inkFaint: '#A8B8AE',
  green: '#0B6B45',
  warnBg: '#FFF4E0',
  warnInk: '#8A5300',
  warnRule: '#F0E4CB',
  alert: '#B3261E',
  alertBg: '#FDF3F2',
  alertRule: '#F0D6D4'
} as const

// ---------------------------------------------------------------- pieces ---

function Chip({
  k,
  v,
  bg,
  kFg,
  vFg
}: {
  k: string
  v: string
  bg: string
  kFg: string
  vFg: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 rounded-[3px] px-2.5 py-2" style={{ background: bg }}>
      <div className="text-[8.5px] font-extrabold uppercase tracking-[.1em]" style={{ color: kFg }}>
        {k}
      </div>
      <div
        className="mt-0.5 whitespace-nowrap text-[13.5px] font-bold tracking-[-0.03em] tabular-nums"
        style={{ color: vFg }}
      >
        {v}
      </div>
    </div>
  )
}

// One cell of the facility grid. Two to a row, hairlines between, so six
// figures fit a phone without a table.
function Cell({
  k,
  v,
  bg,
  kFg,
  fg
}: {
  k: string
  v: string
  bg?: string
  kFg?: string
  fg?: string
}): React.JSX.Element {
  return (
    <div
      className="border-b border-r px-3 py-2"
      style={{ background: bg || T.card, borderColor: T.rule }}
    >
      <div
        className="text-[8.5px] font-extrabold uppercase tracking-[.11em]"
        style={{ color: kFg || T.inkSoft }}
      >
        {k}
      </div>
      <div
        className="mt-0.5 whitespace-nowrap text-[12.5px] font-bold tabular-nums"
        style={{ color: fg || T.ink }}
      >
        {v}
      </div>
    </div>
  )
}

function Pill({
  children,
  bg,
  fg,
  bd
}: {
  children: React.ReactNode
  bg: string
  fg: string
  bd?: string
}): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-[2px] px-1.5 py-[3px] text-[9px] font-extrabold uppercase tracking-[.05em]"
      style={{ background: bg, color: fg, border: bd ? `1px solid ${bd}` : undefined }}
    >
      {children}
    </span>
  )
}

// ------------------------------------------------------------------ screen ---

export function TreasuryMobile(): React.JSX.Element {
  const [tab, setTab] = useState<'lc' | 'bd'>('lc')
  const [query, setQuery] = useState('')
  const [lcs, setLcs] = useState<Row[]>([])
  const [bills, setBills] = useState<Row[]>([])
  const [limit, setLimit] = useState<Row>({})
  const [company, setCompany] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
    try {
      const [l, bd, lim, act, comps] = await Promise.all([
        window.api.lc.list(),
        // Bill Discounting has thrown on a database missing bd_parties before
        // now, and this screen must not go blank because of it — the LCs above
        // are still worth showing. See bootstrap.ts's table repair.
        window.api.billDiscounting.list().catch(() => [] as Row[]),
        window.api.lc.getLimit().catch(() => ({}) as Row),
        window.api.company.getActive().catch(() => ({ id: 0 })),
        window.api.company.list().catch(() => [] as Row[])
      ])
      setLcs(l.filter((x) => s(x.facility_type || 'lc') === 'lc'))
      setBills(bd)
      setLimit(lim || {})
      setCompany(s(comps.find((c) => Number(c.id) === Number(act?.id))?.name))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  // One box, both lists. Someone looking for "SBI" or a party does not want to
  // pick the instrument first.
  const terms = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  )
  const match = useCallback(
    (hay: string) => {
      if (!terms.length) return true
      const h = hay.toLowerCase()
      return terms.every((t) => h.includes(t))
    },
    [terms]
  )

  const openLcs = useMemo(
    () =>
      lcs.filter((l) =>
        match(
          [l.lc_no, l.supplier_name, l.receivable_party_name, l.bank_name, l.our_bank_name, l.display_status, l.status]
            .map(s)
            .join(' ')
        )
      ),
    [lcs, match]
  )
  const openBills = useMemo(
    () =>
      bills.filter((b) =>
        match(
          [b.bd_no, b.party_names, b.supplier_name, b.customer_name, b.nbfc_name, b.finance_type, b.status]
            .map(s)
            .join(' ')
        )
      ),
    [bills, match]
  )

  // The three figures the header carries, per instrument — the same arrays the
  // cards below are drawn from, so the header cannot contradict them.
  const kpis = useMemo(() => {
    if (tab === 'bd') {
      const open = openBills.filter((b) => s(b.status) !== 'repaid')
      return [
        { k: 'Bills open', v: String(open.length) },
        { k: 'Outstanding', v: inrShort(open.reduce((t, b) => t + n(b.amount) - n(b.repaid_amount), 0)) },
        { k: 'Received', v: inrShort(openBills.reduce((t, b) => t + n(b.payment_in_total), 0)) }
      ]
    }
    const live = openLcs.filter((l) => !l.preclosed_date && s(l.status) !== 'closed')
    return [
      { k: 'LCs open', v: String(live.length) },
      { k: 'Outstanding', v: inrShort(live.reduce((t, l) => t + n(l.outstanding), 0)) },
      { k: 'Received', v: inrShort(openLcs.reduce((t, l) => t + n(l.payment_in_amount), 0)) }
    ]
  }, [tab, openLcs, openBills])

  return (
    <div className="flex min-h-[100dvh] flex-col" style={{ background: T.ground, color: T.ink }}>
      {/* Header. Pinned, because the three figures are the reason the page is
          opened and scrolling a list should not cost them. */}
      <div className="sticky top-0 z-20 flex-none px-3.5 pb-3 pt-3" style={{ background: T.forest, color: '#fff' }}>
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Landmark className="h-[22px] w-[22px] shrink-0" style={{ color: T.lime }} />
            <div className="min-w-0">
              <div className="text-[17px] font-extrabold tracking-[-0.02em]">Treasury</div>
              <div className="truncate text-[10.5px] font-bold" style={{ color: T.muted }}>
                {company || '—'}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex gap-2">
          {kpis.map((k, i) => (
            <Chip
              key={k.k}
              k={k.k}
              v={k.v}
              bg="rgba(255,255,255,.08)"
              kFg={T.muted}
              vFg={i === 1 ? T.lime : '#fff'}
            />
          ))}
        </div>
      </div>

      {/* Instrument tabs. Two, so they take half the width each and are a
          thumb's reach apart. */}
      <div className="sticky top-[104px] z-10 flex flex-none border-b" style={{ background: T.card, borderColor: T.border }}>
        {([
          { key: 'lc' as const, label: 'Letters of credit', short: 'LC', count: openLcs.length },
          { key: 'bd' as const, label: 'Bill discounting', short: 'BD', count: openBills.length }
        ]).map((t) => {
          const on = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-selected={on}
              className="flex h-12 min-w-0 flex-1 items-center justify-center gap-1.5 text-[12.5px] font-extrabold"
              style={{
                borderBottom: `3px solid ${on ? T.forest : 'transparent'}`,
                background: on ? T.head : T.card,
                color: on ? T.ink : T.inkSoft
              }}
            >
              {t.short}
              <span
                className="rounded-[2px] px-1.5 py-[2px] text-[10px] font-bold tabular-nums"
                style={{
                  background: on ? T.forest : T.rule,
                  color: on ? T.lime : T.inkSoft
                }}
              >
                {t.count}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-none items-center gap-2 border-b px-3 py-2.5" style={{ background: T.card, borderColor: T.border }}>
        <div
          className="flex h-[38px] min-w-0 flex-1 items-center gap-2 rounded-[3px] px-2.5"
          style={{ border: `1px solid #C3D2C6` }}
        >
          <Search className="h-[18px] w-[18px] shrink-0" style={{ color: T.inkSoft }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search no, bank, party…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium outline-none placeholder:text-[#8FA79B]"
          />
        </div>
        {/* The filter row the handoff draws. Nothing is wired behind it yet, so
            it says so on press rather than looking broken. */}
        <button
          type="button"
          title="Filters are on the desktop view for now"
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[3px]"
          style={{ border: `1px solid #C3D2C6`, color: T.inkMid }}
        >
          <SlidersHorizontal className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-6 pt-3">
        {loading ? (
          <div className="py-16 text-center text-[13px] font-semibold" style={{ color: T.inkSoft }}>
            Reading the treasury…
          </div>
        ) : tab === 'lc' ? (
          <>
            {/* The facility, before the LCs drawn on it — the question "is
                there room" comes before "what is out". */}
            <div className="overflow-hidden rounded-[4px] border" style={{ background: T.card, borderColor: T.border }}>
              <div
                className="border-b px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-[.13em]"
                style={{ background: T.head, borderColor: '#E4ECE3' }}
              >
                LC facility limit
              </div>
              <div className="grid grid-cols-2 [&>*:nth-child(2n)]:border-r-0">
                <Cell k="Sanctioned" v={inrShort(n(limit.limit_amount ?? limit.fixed_limit))} />
                <Cell k="Utilised" v={inrShort(n(limit.utilized))} fg={T.warnInk} />
                <Cell k="Available" v={inrShort(n(limit.available ?? limit.lc_net_available))} bg="#F4FBF6" kFg={T.green} fg={T.green} />
                <Cell k="Margin held" v={inrShort(n(limit.margin_total ?? limit.margin))} />
                <Cell k="LCs open" v={String(openLcs.filter((l) => !l.preclosed_date).length)} />
                <Cell k="Outstanding" v={inrShort(openLcs.reduce((t, l) => t + n(l.outstanding), 0))} />
              </div>
            </div>

            {openLcs.length === 0 ? (
              <Empty what={query ? 'No LC matches that search.' : 'No letters of credit yet.'} />
            ) : (
              openLcs.map((l) => <LcCard key={String(l.id)} l={l} />)
            )}
          </>
        ) : (
          <>
            <div className="overflow-hidden rounded-[4px] border" style={{ background: T.card, borderColor: T.border }}>
              <div
                className="border-b px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-[.13em]"
                style={{ background: T.head, borderColor: '#E4ECE3' }}
              >
                Bill discounting · {openBills.filter((b) => s(b.status) !== 'repaid').length} open
              </div>
              <div className="grid grid-cols-2 [&>*:nth-child(2n)]:border-r-0">
                <Cell k="Bills" v={String(openBills.length)} />
                <Cell
                  k="Outstanding"
                  v={inrShort(openBills.reduce((t, b) => t + n(b.amount) - n(b.repaid_amount), 0))}
                  fg={T.warnInk}
                />
                <Cell
                  k="Received"
                  v={inrShort(openBills.reduce((t, b) => t + n(b.payment_in_total), 0))}
                  bg="#F4FBF6"
                  kFg={T.green}
                  fg={T.green}
                />
                <Cell k="Repaid" v={inrShort(openBills.reduce((t, b) => t + n(b.repaid_amount), 0))} />
              </div>
            </div>

            {openBills.length === 0 ? (
              <Empty
                what={
                  query
                    ? 'No bill matches that search.'
                    : 'No bills discounted yet.'
                }
              />
            ) : (
              openBills.map((b) => <BillCard key={String(b.id)} b={b} />)
            )}
          </>
        )}

        <div className="flex items-start gap-2 px-1 pt-1">
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" style={{ color: T.inkFaint }} />
          <span className="text-[11.5px] font-semibold leading-relaxed" style={{ color: T.inkSoft }}>
            Opening an LC, preclosing one and logging a repayment are on the desktop view — this
            screen is for reading what is out and when it is due.
          </span>
        </div>
      </div>
    </div>
  )
}

function Empty({ what }: { what: string }): React.JSX.Element {
  return (
    <div
      className="rounded-[4px] border px-4 py-12 text-center text-[13px] font-semibold"
      style={{ background: T.card, borderColor: '#C3D2C6', color: T.inkSoft }}
    >
      {what}
    </div>
  )
}

// ------------------------------------------------------------------ cards ---

function LcCard({ l }: { l: Row }): React.JSX.Element {
  const preclosed = !!l.preclosed_date
  const closed = preclosed || s(l.status) === 'closed'
  const outstanding = n(l.outstanding)
  const due = daysTo(l.next_due_date)
  // A mark down the left edge: settled, overdue, due soon, or simply open.
  const mark = closed ? '#C3D2C6' : due != null && due < 0 ? T.alert : due != null && due <= 7 ? '#C2700A' : T.green
  const status = s(l.display_status || l.status || 'open')
  const received = n(l.payment_in_amount)
  const expected = n(l.paid_expected)

  return (
    <div
      className="rounded-[4px] border p-3"
      style={{ background: T.card, borderColor: T.border, borderLeft: `4px solid ${mark}` }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold tracking-[-0.01em] tabular-nums">
            {s(l.lc_no) || 'No LC number'}
          </div>
          <div className="mt-0.5 truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
            {s(l.supplier_name || l.receivable_party_name) || '—'}
          </div>
        </div>
        <Pill
          bg={closed ? T.rule : outstanding > 0 ? T.warnBg : '#E9F5EE'}
          fg={closed ? T.inkSoft : outstanding > 0 ? T.warnInk : T.green}
          bd={closed ? T.border : outstanding > 0 ? T.warnRule : '#BFE3CB'}
        >
          {preclosed ? 'Preclosed' : status}
        </Pill>
      </div>

      {/* The one thing on an LC that is a problem rather than a fact. */}
      {!closed && Number(l.linked_invoice_count) === 0 && (
        <div
          className="mt-2 inline-flex items-center gap-1.5 rounded-[2px] px-2 py-1 text-[9.5px] font-extrabold"
          style={{ background: T.warnBg, color: T.warnInk, border: `1px solid ${T.warnRule}` }}
        >
          <AlertTriangle className="h-3 w-3" /> No invoice linked
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] font-bold" style={{ color: T.inkSoft }}>
          {s(l.bank_name || l.our_bank_name || l.bank) || 'Bank not set'}
        </span>
        {n(l.margin_pct) > 0 && (
          <span
            className="rounded-[2px] px-1.5 py-[2px] text-[9.5px] font-extrabold tabular-nums"
            style={{ background: '#EFF5EC', color: T.inkSoft }}
          >
            M {formatNum(l.margin_pct)}%
          </span>
        )}
        {!closed && due != null && (
          <span
            className="rounded-[2px] px-1.5 py-[3px] text-[10px] font-extrabold tabular-nums"
            style={{
              background: due < 0 ? T.alertBg : due <= 7 ? T.warnBg : '#EFF5EC',
              color: due < 0 ? T.alert : due <= 7 ? T.warnInk : T.inkSoft
            }}
          >
            {due < 0 ? `${Math.abs(due)}d overdue` : due === 0 ? 'due today' : `${due}d left`}
          </span>
        )}
      </div>

      <div
        className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5"
        style={{ borderColor: T.rule }}
      >
        <CalendarDays className="h-3.5 w-3.5 shrink-0" style={{ color: T.inkFaint }} />
        <span className="text-[11.5px] font-bold tabular-nums">{formatDate(l.opened_date || l.open_date)}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: '#C3D2C6' }} />
        <span className="text-[11.5px] font-semibold tabular-nums" style={{ color: T.inkSoft }}>
          {formatDate(l.next_due_date || l.expiry_date)}
        </span>
        {n(l.usance_days) > 0 && (
          <span className="ml-auto text-[11px] font-semibold tabular-nums" style={{ color: T.inkSoft }}>
            {formatNum(l.usance_days)}d usance
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2.5">
        <div className="min-w-0">
          <div className="text-[8.5px] font-extrabold uppercase tracking-[.11em]" style={{ color: T.inkSoft }}>
            {closed ? 'LC amount' : 'Open amount'}
          </div>
          <div className="whitespace-nowrap text-[14px] font-bold tracking-[-0.02em] tabular-nums">
            {inrFull(closed ? n(l.amount) : outstanding)}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[8.5px] font-extrabold uppercase tracking-[.11em]" style={{ color: T.inkSoft }}>
            Payment rec
          </div>
          <div
            className="whitespace-nowrap text-[14px] font-bold tracking-[-0.02em] tabular-nums"
            style={{ color: received > 0 ? T.green : T.inkFaint }}
          >
            {received > 0 ? inrFull(received) : '—'}
          </div>
          {expected > 0 && received < expected - 0.5 && (
            <div className="mt-0.5 text-[10px] font-semibold" style={{ color: T.warnInk }}>
              {inrShort(expected - received)} still due
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BillCard({ b }: { b: Row }): React.JSX.Element {
  const repaid = s(b.status) === 'repaid'
  const open = n(b.amount) - n(b.repaid_amount)
  const due = daysTo(b.maturity_date)
  const mark = repaid ? '#C3D2C6' : due != null && due < 0 ? T.alert : due != null && due <= 7 ? '#C2700A' : '#1B4E82'
  const received = n(b.payment_in_total)

  return (
    <div
      className="rounded-[4px] border p-3"
      style={{ background: T.card, borderColor: T.border, borderLeft: `4px solid ${mark}` }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold tabular-nums">{s(b.bd_no) || 'No number'}</div>
          <div className="mt-0.5 truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
            {s(b.party_names || b.supplier_name || b.customer_name) || '—'}
          </div>
        </div>
        <Pill
          bg={repaid ? '#E9F5EE' : '#EAF0FA'}
          fg={repaid ? T.green : '#1B4E82'}
          bd={repaid ? '#BFE3CB' : '#C6DAF0'}
        >
          {s(b.finance_type) || 'PID'}
        </Pill>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-[10.5px] font-bold" style={{ color: T.inkSoft }}>
          <Building2 className="h-3.5 w-3.5" />
          {s(b.nbfc_name) || 'NBFC not set'}
        </span>
        {n(b.margin_pct) > 0 && (
          <span
            className="rounded-[2px] px-1.5 py-[2px] text-[9.5px] font-extrabold tabular-nums"
            style={{ background: '#EFF5EC', color: T.inkSoft }}
          >
            M {formatNum(b.margin_pct)}%
          </span>
        )}
        {n(b.interest_pct) > 0 && (
          <span
            className="rounded-[2px] px-1.5 py-[2px] text-[9.5px] font-extrabold tabular-nums"
            style={{ background: '#EFF5EC', color: T.inkSoft }}
          >
            {formatNum(b.interest_pct)}%
          </span>
        )}
        {!repaid && due != null && (
          <span
            className="rounded-[2px] px-1.5 py-[3px] text-[10px] font-extrabold tabular-nums"
            style={{
              background: due < 0 ? T.alertBg : T.warnBg,
              color: due < 0 ? T.alert : T.warnInk
            }}
          >
            {due < 0 ? `${Math.abs(due)}d overdue` : due === 0 ? 'matures today' : `${due}d left`}
          </span>
        )}
        {repaid && (
          <span className="flex items-center gap-1 text-[10px] font-extrabold" style={{ color: T.green }}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Repaid {formatDate(b.repaid_date)}
          </span>
        )}
      </div>

      <div
        className="mt-2.5 flex items-end justify-between gap-2.5 border-t pt-2.5"
        style={{ borderColor: T.rule }}
      >
        <div className="min-w-0">
          <div className="text-[8.5px] font-extrabold uppercase tracking-[.11em]" style={{ color: T.inkSoft }}>
            {repaid ? 'Bill amount' : 'Open amount'}
          </div>
          <div className="whitespace-nowrap text-[14px] font-bold tracking-[-0.02em] tabular-nums">
            {inrFull(repaid ? n(b.amount) : open)}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div
            className="flex items-center justify-end gap-1 text-[8.5px] font-extrabold uppercase tracking-[.11em]"
            style={{ color: T.green }}
          >
            <Banknote className="h-3.5 w-3.5" /> Received
          </div>
          <div
            className="whitespace-nowrap text-[14px] font-bold tracking-[-0.02em] tabular-nums"
            style={{ color: received > 0 ? T.green : T.inkFaint }}
          >
            {received > 0 ? inrFull(received) : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}
