import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Inbox, Landmark, Search, Wallet } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { formatDate, formatINR, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Channel = 'lc' | 'bd' | 'bank' | 'adjustment'
type Side = 'all' | 'purchase' | 'sale'
type StatusFilter = 'all' | 'open' | 'part' | 'settled' | 'overdue'

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round3 = (v: number): number => Math.round(v * 1000) / 1000
// A tonnage only where the bill is in MT — a carton count is not a tonnage.
const isMt = (r: Row): boolean => String(r.uom || 'MT').trim().toUpperCase() === 'MT'

// One colour per way money moves, used for the bar, the chips and the
// movement list alike, so a colour means the same thing everywhere on the page.
const CH: Record<Channel, { label: string; fg: string; bg: string; bar: string }> = {
  lc: { label: 'LC', fg: '#1F4E8C', bg: '#EAF1FB', bar: '#2F6FC0' },
  bd: { label: 'BD', fg: '#6B3FA0', bg: '#F2ECFA', bar: '#8A5CC4' },
  bank: { label: 'Bank', fg: '#0B6B45', bg: '#E9F5EE', bar: '#12855A' },
  adjustment: { label: 'Adj', fg: '#8A5A00', bg: '#FFF4DE', bar: '#D9A21B' }
}
const CHANNELS: Channel[] = ['lc', 'bd', 'bank', 'adjustment']

const byChannel = (r: Row): Record<Channel, number> => ({
  lc: n(r.settled_lc),
  bd: n(r.settled_bd),
  bank: n(r.settled_bank),
  adjustment: n(r.settled_adjustment)
})

function ChannelChip({ kind, text }: { kind: Channel; text?: string }): React.JSX.Element {
  const c = CH[kind]
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[2px] px-1.5 py-0.5 text-[10.5px] font-extrabold tracking-[.04em]"
      style={{ color: c.fg, background: c.bg }}
    >
      {c.label}
      {text ? <span className="font-bold opacity-80">{text}</span> : null}
    </span>
  )
}

// How much of the bill is settled, and by what — one segment per channel,
// the empty track being what is still open.
function SettleBar({ row }: { row: Row }): React.JSX.Element {
  const amt = n(row.amount)
  const by = byChannel(row)
  return (
    <div className="flex h-[7px] w-full overflow-hidden rounded-[2px] bg-[#EAF0E9]">
      {amt > 0 &&
        CHANNELS.map((k) =>
          by[k] > 0 ? (
            <div
              key={k}
              title={`${CH[k].label} ${formatINR(by[k])}`}
              style={{ width: `${Math.min(100, (by[k] / amt) * 100)}%`, background: CH[k].bar }}
            />
          ) : null
        )}
    </div>
  )
}

function StatusPill({ row }: { row: Row }): React.JSX.Element {
  const s = row.overdue ? 'overdue' : String(row.status)
  const m: Record<string, { t: string; fg: string; bg: string }> = {
    settled: { t: 'Settled', fg: '#0B6B45', bg: '#E9F5EE' },
    part: { t: 'Part paid', fg: '#8A5A00', bg: '#FFF4DE' },
    pending: { t: 'Pending', fg: '#5A6B62', bg: '#EEF2EC' },
    overdue: { t: 'Overdue', fg: '#B3261E', bg: '#FDF3F2' }
  }
  const x = m[s] ?? m.pending
  return (
    <span className="rounded-[2px] px-2 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[.06em]" style={{ color: x.fg, background: x.bg }}>
      {x.t}
    </span>
  )
}

function DueCell({ row }: { row: Row }): React.JSX.Element {
  if (row.status === 'settled') return <span className="text-[#9AA89F]">—</span>
  if (!row.due_date) return <span className="text-[11.5px] text-[#9AA89F]">No credit term</span>
  const d = n(row.days_left)
  return (
    <div className="leading-tight">
      <div className="text-[12.5px] font-bold tabular-nums text-[#0A1F17]">{formatDate(row.due_date)}</div>
      <div className={cn('text-[11px] font-bold', d < 0 ? 'text-[#B3261E]' : d <= 7 ? 'text-[#8A5A00]' : 'text-[#5A6B62]')}>
        {d < 0 ? `${-d} d overdue` : d === 0 ? 'due today' : `in ${d} d`}
      </div>
    </div>
  )
}

export function TradingPayments({
  range,
  onOpenDeal
}: {
  range: { from: string; to: string } | null
  onOpenDeal?: (dealId: number) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [side, setSide] = useState<Side>('all')
  const [status, setStatus] = useState<StatusFilter>('open')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(async (background?: boolean) => {
    if (!background) setLoading(true)
    try {
      setRows(await window.api.trading.payments())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  // The period and the search narrow everything, tiles included; side and
  // status only narrow the list, so the chips can keep their counts honest.
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (range) {
        const dd = String(r.deal_date || '').slice(0, 10)
        if (dd < range.from || dd > range.to) return false
      }
      if (!q) return true
      const refs = [...(r.financed_by ?? []), ...(r.settled_via ?? [])].map((x: Row) => x.ref)
      return [r.invoice_no, r.ref_key, r.party_name, r.product_code, r.product_name, ...refs].some((f) =>
        String(f || '').toLowerCase().includes(q)
      )
    })
  }, [rows, range, search])

  const sideRows = useMemo(() => (side === 'all' ? scoped : scoped.filter((r) => r.side === side)), [scoped, side])
  const matches = (r: Row, s: StatusFilter): boolean =>
    s === 'all'
      ? true
      : s === 'open'
        ? r.status !== 'settled'
        : s === 'overdue'
          ? !!r.overdue
          : s === 'part'
            ? r.status === 'part'
            : r.status === 'settled'
  const visible = useMemo(() => sideRows.filter((r) => matches(r, status)), [sideRows, status])

  const kpi = useMemo(() => {
    const t = {
      payable: 0,
      payableN: 0,
      payableMt: 0,
      receivable: 0,
      receivableN: 0,
      receivableMt: 0,
      overdue: 0,
      overdueN: 0,
      by: { lc: 0, bd: 0, bank: 0, adjustment: 0 } as Record<Channel, number>
    }
    for (const r of scoped) {
      // Tonnes only where the bill is in MT — a carton count is not a tonnage.
      const mt = isMt(r) ? n(r.pending_qty) : 0
      if (r.side === 'purchase') {
        t.payable += n(r.pending)
        t.payableMt += mt
        if (n(r.pending) > 0.005) t.payableN++
      } else {
        t.receivable += n(r.pending)
        t.receivableMt += mt
        if (n(r.pending) > 0.005) t.receivableN++
      }
      if (r.overdue) {
        t.overdue += n(r.pending)
        t.overdueN++
      }
      const b = byChannel(r)
      for (const k of CHANNELS) t.by[k] += b[k]
    }
    return t
  }, [scoped])
  const settledAll = CHANNELS.reduce((a, k) => a + kpi.by[k], 0)

  // Invoices under the deal they belong to, in the order the server sent the
  // deals (newest first) — a trade is read as one round trip, both sides at once.
  const groups = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const r of visible) {
      const id = n(r.deal_id)
      m.set(id, [...(m.get(id) ?? []), r])
    }
    return Array.from(m.entries())
  }, [visible])

  const toggle = (k: string): void =>
    setOpen((s) => {
      const x = new Set(s)
      if (x.has(k)) x.delete(k)
      else x.add(k)
      return x
    })

  const statusChips: Array<{ v: StatusFilter; label: string }> = [
    { v: 'open', label: 'Open' },
    { v: 'part', label: 'Part paid' },
    { v: 'overdue', label: 'Overdue' },
    { v: 'settled', label: 'Settled' },
    { v: 'all', label: 'All' }
  ]

  const tile = (
    label: string,
    value: string,
    sub: string,
    accent: string,
    Icon: typeof Wallet,
    iconBg: string,
    iconFg: string,
    vFg = '#0A1F17'
  ): React.JSX.Element => (
    <div className="flex items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[3px]" style={{ background: iconBg, color: iconFg }}>
        <Icon className="h-[21px] w-[21px]" />
      </div>
      <div className="min-w-0">
        <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{label}</div>
        <div className="mt-0.5 truncate text-[19px] font-bold leading-tight tracking-[-0.035em] tabular-nums" style={{ color: vFg }} title={value}>
          {value}
        </div>
        <div className="mt-0.5 text-[11.5px] font-bold text-[#5A6B62]">{sub}</div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {tile(
          'Payable to suppliers',
          formatINR(kpi.payable),
          `${kpi.payableN} purchase invoice${kpi.payableN === 1 ? '' : 's'} open${kpi.payableMt > 0.0005 ? ` · ${formatNum(round3(kpi.payableMt))} MT` : ''}`,
          '#B3261E',
          ArrowUpRight,
          '#FDF3F2',
          '#B3261E'
        )}
        {tile(
          'Receivable from buyers',
          formatINR(kpi.receivable),
          `${kpi.receivableN} sale invoice${kpi.receivableN === 1 ? '' : 's'} open${kpi.receivableMt > 0.0005 ? ` · ${formatNum(round3(kpi.receivableMt))} MT` : ''}`,
          '#12855A',
          ArrowDownLeft,
          '#E9F5EE',
          '#0B6B45'
        )}
        {/* Where the settled money came through. */}
        <div className="flex flex-col justify-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3" style={{ borderTop: '3px solid #0B3D2E' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Settled through</div>
            <div className="text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatINR(settledAll)}</div>
          </div>
          <div className="flex h-[7px] w-full overflow-hidden rounded-[2px] bg-[#EAF0E9]">
            {settledAll > 0 &&
              CHANNELS.map((k) =>
                kpi.by[k] > 0 ? <div key={k} style={{ width: `${(kpi.by[k] / settledAll) * 100}%`, background: CH[k].bar }} /> : null
              )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {CHANNELS.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 text-[11px] font-bold text-[#33473E]">
                <span className="h-2 w-2 rounded-[1px]" style={{ background: CH[k].bar }} />
                {CH[k].label}
                <span className="tabular-nums text-[#5A6B62]">{formatINR(kpi.by[k])}</span>
              </span>
            ))}
          </div>
        </div>
        {tile(
          'Overdue',
          formatINR(kpi.overdue),
          kpi.overdueN ? `${kpi.overdueN} invoice${kpi.overdueN === 1 ? '' : 's'} past due` : 'nothing past its due date',
          kpi.overdueN ? '#B3261E' : '#C7F03F',
          AlertTriangle,
          kpi.overdueN ? '#FDF3F2' : '#EEF2EC',
          kpi.overdueN ? '#B3261E' : '#5A6B62',
          kpi.overdueN ? '#B3261E' : '#0A1F17'
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5A6B62]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice no, party, product, LC / BD no…"
            className="!h-[42px] !rounded-[4px] !border-[#C3D2C6] !pl-9 !text-[13px]"
          />
        </div>
        <div className="flex shrink-0 items-center gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
          {(
            [
              { v: 'all', label: 'Both sides' },
              { v: 'purchase', label: 'Payable' },
              { v: 'sale', label: 'Receivable' }
            ] as Array<{ v: Side; label: string }>
          ).map((c) => (
            <button
              key={c.v}
              type="button"
              onClick={() => setSide(c.v)}
              className={cn(
                'flex h-[34px] items-center rounded-[2px] px-3 text-[12px] font-extrabold transition-colors',
                side === c.v ? 'bg-[#0B3D2E] text-white' : 'text-[#5A6B62] hover:bg-white/70'
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
          {statusChips.map((c) => {
            const on = status === c.v
            const count = sideRows.filter((r) => matches(r, c.v)).length
            return (
              <button
                key={c.v}
                type="button"
                onClick={() => setStatus(c.v)}
                className={cn(
                  'flex h-[34px] items-center gap-1.5 rounded-[2px] px-3 text-[12px] font-extrabold transition-colors',
                  on ? 'bg-[#0B3D2E] text-white' : 'text-[#5A6B62] hover:bg-white/70'
                )}
              >
                {c.label}
                <span
                  className={cn(
                    'rounded-[2px] px-1.5 py-0.5 text-[10.5px] tabular-nums',
                    on ? 'bg-[#C7F03F]/20 text-[#C7F03F]' : c.v === 'overdue' && count ? 'bg-[#FDF3F2] text-[#B3261E]' : 'bg-[#DCE7DB] text-[#33473E]'
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="flex h-32 items-center justify-center text-sm text-[#B3261E]">{error}</div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {rows.length === 0 ? 'No trading invoices yet.' : status === 'open' ? 'Every invoice here is settled.' : 'No invoices match your filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-[#0B3D2E] text-left text-[12px] font-extrabold uppercase tracking-[.07em] text-[#DCEFE4]">
                  <th className="h-11 whitespace-nowrap px-3">Invoice</th>
                  <th className="whitespace-nowrap px-3">Party</th>
                  <th className="whitespace-nowrap px-3 text-right">Bill amount</th>
                  <th className="w-[230px] whitespace-nowrap px-3">Paid via</th>
                  <th className="whitespace-nowrap px-3 text-right">Settled</th>
                  <th className="whitespace-nowrap bg-[#1A4D2E] px-3 text-right text-[#C7F03F]">Pending</th>
                  <th className="whitespace-nowrap bg-[#1A4D2E] px-3 text-right text-[#C7F03F]" title="The pending amount in tonnes, at the invoice's own price: qty × pending ÷ bill amount">
                    Pending (MT)
                  </th>
                  <th className="whitespace-nowrap px-3">Status</th>
                  <th className="whitespace-nowrap px-3">Due</th>
                  <th className="whitespace-nowrap px-3">Financed by</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([dealId, list]) => {
                  const f = list[0]
                  const payable = list.filter((r) => r.side === 'purchase').reduce((a, r) => a + n(r.pending), 0)
                  const receivable = list.filter((r) => r.side === 'sale').reduce((a, r) => a + n(r.pending), 0)
                  const payableMt = list.filter((r) => r.side === 'purchase' && isMt(r)).reduce((a, r) => a + n(r.pending_qty), 0)
                  const receivableMt = list.filter((r) => r.side === 'sale' && isMt(r)).reduce((a, r) => a + n(r.pending_qty), 0)
                  return (
                    <React.Fragment key={dealId}>
                      {/* The deal the invoices below belong to. */}
                      <tr className="border-t border-[#D6E2D6] bg-[#F4F8F3]">
                        <td colSpan={10} className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <button
                              type="button"
                              onClick={() => onOpenDeal?.(dealId)}
                              className="text-[12.5px] font-extrabold text-[#0A1F17] underline-offset-2 hover:underline"
                              title="Open this deal"
                            >
                              Deal · {formatDate(f.deal_date)}
                            </button>
                            <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-0.5 text-[11px] font-extrabold tracking-[.06em] text-[#33473E]">
                              {String(f.product_code || f.product_name || '—')}
                            </span>
                            {f.deal_lc && <ChannelChip kind="lc" text={f.deal_lc.ref} />}
                            <span className="ml-auto flex items-center gap-4 text-[11.5px] font-bold text-[#5A6B62]">
                              {payable > 0.005 && (
                                <span>
                                  To pay <span className="tabular-nums text-[#B3261E]">{formatINR(payable)}</span>
                                  {payableMt > 0.0005 && <span className="tabular-nums text-[#B3261E]"> · {formatNum(round3(payableMt))} MT</span>}
                                </span>
                              )}
                              {receivable > 0.005 && (
                                <span>
                                  To receive <span className="tabular-nums text-[#0B6B45]">{formatINR(receivable)}</span>
                                  {receivableMt > 0.0005 && <span className="tabular-nums text-[#0B6B45]"> · {formatNum(round3(receivableMt))} MT</span>}
                                </span>
                              )}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {list.map((r) => {
                        const k = String(r.key)
                        const isOpen = open.has(k)
                        const by = byChannel(r)
                        const buy = r.side === 'purchase'
                        const moves: Row[] = Array.isArray(r.movements) ? r.movements : []
                        return (
                          <React.Fragment key={k}>
                            <tr
                              className={cn(
                                'cursor-pointer border-t border-[#EAF0E9] border-l-[3px] hover:bg-[#F7FAF6]',
                                buy ? 'border-l-[#B3261E]' : 'border-l-[#12855A]',
                                isOpen && 'bg-[#F7FAF6]'
                              )}
                              onClick={() => toggle(k)}
                            >
                              <td className="whitespace-nowrap px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  {isOpen ? (
                                    <ChevronDown className="h-4 w-4 shrink-0 text-[#5A6B62]" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0 text-[#5A6B62]" />
                                  )}
                                  <span
                                    className={cn(
                                      'rounded-[2px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em]',
                                      buy ? 'bg-[#FDF3F2] text-[#B3261E]' : 'bg-[#E9F5EE] text-[#0B6B45]'
                                    )}
                                  >
                                    {buy ? 'Buy' : 'Sell'}
                                  </span>
                                  <div className="leading-tight">
                                    <div className="font-bold text-[#0A1F17]">{r.invoice_no || '—'}</div>
                                    <div className="text-[11px] tabular-nums text-[#5A6B62]">{formatDate(r.invoice_date)}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="max-w-[220px] truncate px-3 font-semibold text-[#33473E]" title={r.party_name}>
                                {r.party_name || '—'}
                              </td>
                              <td className="whitespace-nowrap px-3 text-right tabular-nums font-semibold text-[#0A1F17]">{formatINR(r.amount)}</td>
                              <td className="px-3">
                                <SettleBar row={r} />
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {CHANNELS.filter((c) => by[c] > 0).map((c) => (
                                    <ChannelChip key={c} kind={c} text={formatINR(by[c])} />
                                  ))}
                                  {CHANNELS.every((c) => by[c] <= 0) && <span className="text-[11px] text-[#9AA89F]">Nothing paid yet</span>}
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-3 text-right tabular-nums text-[#33473E]">
                                {formatINR(r.settled_total)}
                                {n(r.excess) > 0.005 && (
                                  <div className="text-[10.5px] font-bold text-[#8A5A00]">+{formatINR(r.excess)} over</div>
                                )}
                              </td>
                              <td className={cn('whitespace-nowrap bg-[#FBFDF6] px-3 text-right font-bold tabular-nums', n(r.pending) > 0.005 ? (buy ? 'text-[#B3261E]' : 'text-[#0B6B45]') : 'text-[#9AA89F]')}>
                                {n(r.pending) > 0.005 ? formatINR(r.pending) : '—'}
                              </td>
                              <td
                                className={cn('whitespace-nowrap bg-[#FBFDF6] px-3 text-right font-bold tabular-nums', n(r.pending_qty) > 0.0005 ? (buy ? 'text-[#B3261E]' : 'text-[#0B6B45]') : 'text-[#9AA89F]')}
                                title={n(r.qty) ? `${formatNum(r.qty)} ${String(r.uom || 'MT')} billed` : undefined}
                              >
                                {n(r.pending_qty) > 0.0005 ? (
                                  <>
                                    {formatNum(r.pending_qty)}
                                    <span className="ml-1 text-[10.5px] font-semibold text-[#7C9188]">{String(r.uom || 'MT')}</span>
                                  </>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="px-3">
                                <StatusPill row={r} />
                              </td>
                              <td className="whitespace-nowrap px-3">
                                <DueCell row={r} />
                              </td>
                              <td className="px-3">
                                <div className="flex flex-wrap gap-1">
                                  {(r.financed_by ?? []).map((x: Row) => (
                                    <ChannelChip key={`${x.kind}${x.id}`} kind={x.kind} text={x.ref} />
                                  ))}
                                  {!(r.financed_by ?? []).length && <span className="text-[11px] text-[#9AA89F]">Own funds</span>}
                                </div>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-[#F7FAF6]">
                                <td colSpan={10} className="px-3 pb-3 pl-[46px] pt-0">
                                  {moves.length === 0 ? (
                                    <div className="rounded-[3px] border border-dashed border-[#C3D2C6] bg-white px-3 py-2.5 text-[12px] text-[#5A6B62]">
                                      No {buy ? 'payment' : 'receipt'} has been allocated against this bill yet. Record one in Accounts with
                                      “Agst Ref” on <b>{r.invoice_no}</b>
                                      {r.ref_key && r.ref_key !== r.invoice_no ? <> (ref {r.ref_key})</> : null} and it will show here.
                                    </div>
                                  ) : (
                                    <table className="w-full max-w-[860px] border-collapse overflow-hidden rounded-[3px] border border-[#D6E2D6] bg-white text-[12.5px]">
                                      <thead>
                                        <tr className="bg-[#EEF2EC] text-left text-[10.5px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
                                          <th className="px-3 py-1.5">Date</th>
                                          <th className="px-3 py-1.5">Voucher</th>
                                          <th className="px-3 py-1.5">Through</th>
                                          <th className="px-3 py-1.5 text-right">Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {moves.map((m, i) => (
                                          <tr key={i} className="border-t border-[#EAF0E9]">
                                            <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{formatDate(m.date)}</td>
                                            <td className="whitespace-nowrap px-3 py-1.5">
                                              <span className="font-semibold capitalize text-[#33473E]">{String(m.vch_type || '').toLowerCase()}</span>
                                              {m.vch_no ? <span className="text-[#5A6B62]"> · {m.vch_no}</span> : null}
                                              {m.fifo ? (
                                                <span
                                                  className="ml-1.5 rounded-[2px] bg-[#EAF0FA] px-1 py-px text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#1B4E82]"
                                                  title="Paid with no Agst Ref — applied to this party's oldest open bills first"
                                                >
                                                  FIFO
                                                </span>
                                              ) : null}
                                            </td>
                                            <td className="px-3 py-1.5">
                                              <span className="inline-flex items-center gap-1.5">
                                                <ChannelChip kind={m.channel} text={m.instrument?.ref || undefined} />
                                                {m.channel === 'bank' && <Landmark className="h-3.5 w-3.5 text-[#5A6B62]" />}
                                              </span>
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums">{formatINR(m.amount)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// THE PHONE. The same register — api.trading.payments(), the same filters and
// the same figures — as cards: payable / receivable / overdue at the top,
// side and status as chips, and under each deal its invoices, each one
// opening on the receipts and payments that settled it (FIFO ones tagged).
export function TradingPaymentsMobile({
  range,
  onOpenDeal
}: {
  range: { from: string; to: string } | null
  onOpenDeal?: (dealId: number) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [side, setSide] = useState<Side>('all')
  const [status, setStatus] = useState<StatusFilter>('open')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(async (background?: boolean) => {
    if (!background) setLoading(true)
    try {
      setRows(await window.api.trading.payments())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (range) {
        const dd = String(r.deal_date || '').slice(0, 10)
        if (dd < range.from || dd > range.to) return false
      }
      if (!q) return true
      const refs = [...(r.financed_by ?? []), ...(r.settled_via ?? [])].map((x: Row) => x.ref)
      return [r.invoice_no, r.ref_key, r.party_name, r.product_code, r.product_name, ...refs].some((f) =>
        String(f || '').toLowerCase().includes(q)
      )
    })
  }, [rows, range, search])
  const sideRows = useMemo(() => (side === 'all' ? scoped : scoped.filter((r) => r.side === side)), [scoped, side])
  const matches = (r: Row, s: StatusFilter): boolean =>
    s === 'all' ? true : s === 'open' ? r.status !== 'settled' : s === 'overdue' ? !!r.overdue : s === 'part' ? r.status === 'part' : r.status === 'settled'
  const visible = useMemo(() => sideRows.filter((r) => matches(r, status)), [sideRows, status])

  const kpi = useMemo(() => {
    const t = { payable: 0, payableN: 0, receivable: 0, receivableN: 0, overdue: 0, overdueN: 0 }
    for (const r of scoped) {
      if (r.side === 'purchase') {
        t.payable += n(r.pending)
        if (n(r.pending) > 0.005) t.payableN++
      } else {
        t.receivable += n(r.pending)
        if (n(r.pending) > 0.005) t.receivableN++
      }
      if (r.overdue) {
        t.overdue += n(r.pending)
        t.overdueN++
      }
    }
    return t
  }, [scoped])

  const groups = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const r of visible) m.set(n(r.deal_id), [...(m.get(n(r.deal_id)) ?? []), r])
    return Array.from(m.entries())
  }, [visible])

  const toggle = (k: string): void =>
    setOpen((s) => {
      const x = new Set(s)
      if (x.has(k)) x.delete(k)
      else x.add(k)
      return x
    })

  const statusChips: Array<{ v: StatusFilter; label: string }> = [
    { v: 'open', label: 'Open' },
    { v: 'part', label: 'Part paid' },
    { v: 'overdue', label: 'Overdue' },
    { v: 'settled', label: 'Settled' },
    { v: 'all', label: 'All' }
  ]
  const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`
  const dueText = (r: Row): string => {
    const d = n(r.days_left)
    return d < 0 ? `${-d} d overdue` : d === 0 ? 'due today' : `due in ${d} d`
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-10 pt-3">
      {/* The three figures. */}
      <div className="grid shrink-0 grid-cols-2 gap-2">
        <div className="min-w-0 rounded-[4px] border border-[#D6E2D6] border-t-[3px] border-t-[#B3261E] bg-white px-3 py-2.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Payable</div>
          <div className="mt-0.5 truncate text-[15px] font-bold tabular-nums text-[#B3261E]">{formatINR(kpi.payable)}</div>
          <div className="text-[10.5px] font-bold text-[#5A6B62]">{plural(kpi.payableN, 'bill')} open</div>
        </div>
        <div className="min-w-0 rounded-[4px] border border-[#D6E2D6] border-t-[3px] border-t-[#12855A] bg-white px-3 py-2.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Receivable</div>
          <div className="mt-0.5 truncate text-[15px] font-bold tabular-nums text-[#0B6B45]">{formatINR(kpi.receivable)}</div>
          <div className="text-[10.5px] font-bold text-[#5A6B62]">{plural(kpi.receivableN, 'bill')} open</div>
        </div>
        <div
          className={cn(
            'col-span-2 flex items-center justify-between gap-2 rounded-[4px] border px-3 py-2',
            kpi.overdueN ? 'border-[#F0C8C4] bg-[#FDF3F2]' : 'border-[#D6E2D6] bg-white'
          )}
        >
          <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
            <AlertTriangle className={cn('h-4 w-4', kpi.overdueN ? 'text-[#B3261E]' : 'text-[#9AA89F]')} />
            Overdue
          </span>
          <span className={cn('text-[13px] font-bold tabular-nums', kpi.overdueN ? 'text-[#B3261E]' : 'text-[#5A6B62]')}>
            {kpi.overdueN ? formatINR(kpi.overdue) + ' · ' + plural(kpi.overdueN, 'bill') : 'nothing past due'}
          </span>
        </div>
      </div>

      {/* Search, side, status. */}
      <div className="flex h-11 shrink-0 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
        <Search className="h-[18px] w-[18px] shrink-0 text-[#5A6B62]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Invoice, party, product, LC / BD no"
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
        />
      </div>
      <div className="flex shrink-0 gap-1 rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-1">
        {(
          [
            { v: 'all', label: 'Both' },
            { v: 'purchase', label: 'Payable' },
            { v: 'sale', label: 'Receivable' }
          ] as Array<{ v: Side; label: string }>
        ).map((c) => (
          <button
            key={c.v}
            type="button"
            onClick={() => setSide(c.v)}
            className={cn('h-9 flex-1 rounded-[3px] text-[12px] font-extrabold', side === c.v ? 'bg-[#0B3D2E] text-white' : 'text-[#5A6B62]')}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="-mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {statusChips.map((c) => {
          const on = status === c.v
          const count = sideRows.filter((r) => matches(r, c.v)).length
          return (
            <button
              key={c.v}
              type="button"
              onClick={() => setStatus(c.v)}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-3 text-[12px] font-extrabold',
                on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#DCE7DB] bg-white text-[#33473E]'
              )}
            >
              {c.label}
              <span
                className={cn(
                  'rounded-[2px] px-1.5 py-0.5 text-[10.5px] tabular-nums',
                  on ? 'bg-white/15 text-[#C7F03F]' : c.v === 'overdue' && count ? 'bg-[#FDF3F2] text-[#B3261E]' : 'bg-[#EAF0E9] text-[#5A6B62]'
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="py-14 text-center text-[12.5px] font-bold text-[#5A6B62]">Loading…</div>
      ) : error ? (
        <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">{error}</div>
      ) : groups.length === 0 ? (
        <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
          <Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />
          <p className="mt-2.5 text-[12.5px] font-bold text-[#5A6B62]">
            {rows.length === 0 ? 'No trading invoices yet.' : status === 'open' ? 'Every invoice here is settled.' : 'No invoices match your filters.'}
          </p>
        </div>
      ) : (
        groups.map(([dealId, list]) => {
          const f = list[0]
          const payable = list.filter((r) => r.side === 'purchase').reduce((a, r) => a + n(r.pending), 0)
          const receivable = list.filter((r) => r.side === 'sale').reduce((a, r) => a + n(r.pending), 0)
          return (
            <div key={dealId} className="flex shrink-0 flex-col gap-1.5">
              {/* The deal the invoices below belong to — tap to open it. */}
              <button
                type="button"
                onClick={() => onOpenDeal?.(dealId)}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[4px] bg-[#0B3D2E] px-3 py-2 text-left text-white"
              >
                <span className="text-[12.5px] font-extrabold">Deal · {formatDate(f.deal_date)}</span>
                <span className="rounded-[2px] bg-white/10 px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#C7F03F]">
                  {String(f.product_code || f.product_name || '—')}
                </span>
                <span className="ml-auto flex gap-2.5 text-[11px] font-bold tabular-nums">
                  {payable > 0.005 && <span className="text-[#FFC4BE]">Pay {formatINR(payable)}</span>}
                  {receivable > 0.005 && <span className="text-[#C7F03F]">Get {formatINR(receivable)}</span>}
                </span>
              </button>
              {list.map((r) => {
                const k = String(r.key)
                const isOpen = open.has(k)
                const by = byChannel(r)
                const buy = r.side === 'purchase'
                const moves: Row[] = Array.isArray(r.movements) ? r.movements : []
                const pend = n(r.pending)
                return (
                  <div
                    key={k}
                    className={cn('overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white', buy ? 'border-l-[#B3261E]' : 'border-l-[#12855A]')}
                  >
                    <button type="button" onClick={() => toggle(k)} className="block w-full px-3 py-2.5 text-left">
                      <div className="flex items-start gap-2">
                        {isOpen ? (
                          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[#5A6B62]" />
                        ) : (
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[#5A6B62]" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                'rounded-[2px] px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-[.06em]',
                                buy ? 'bg-[#FDF3F2] text-[#B3261E]' : 'bg-[#E9F5EE] text-[#0B6B45]'
                              )}
                            >
                              {buy ? 'Buy' : 'Sell'}
                            </span>
                            <span className="text-[13px] font-extrabold text-[#0A1F17]">{r.invoice_no || '—'}</span>
                            <span className="text-[11px] font-semibold tabular-nums text-[#5A6B62]">{formatDate(r.invoice_date)}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11.5px] font-bold text-[#33473E]">{r.party_name || '—'}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[8.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Pending</div>
                          <div className={cn('text-[14px] font-bold tabular-nums', pend > 0.005 ? (buy ? 'text-[#B3261E]' : 'text-[#0B6B45]') : 'text-[#9AA89F]')}>
                            {pend > 0.005 ? formatINR(pend) : '—'}
                          </div>
                          {n(r.pending_qty) > 0.0005 && (
                            <div className="text-[10.5px] font-bold tabular-nums text-[#5A6B62]">
                              {formatNum(r.pending_qty)} {String(r.uom || 'MT')}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 pl-6">
                        <SettleBar row={r} />
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          <StatusPill row={r} />
                          {CHANNELS.filter((c) => by[c] > 0).map((c) => (
                            <ChannelChip key={c} kind={c} text={formatINR(by[c])} />
                          ))}
                          {(r.financed_by ?? []).map((x: Row) => (
                            <ChannelChip key={'f' + x.kind + x.id} kind={x.kind} text={x.ref} />
                          ))}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold text-[#5A6B62]">
                          <span>
                            Bill <b className="tabular-nums text-[#0A1F17]">{formatINR(r.amount)}</b> · settled{' '}
                            <b className="tabular-nums text-[#0A1F17]">{formatINR(r.settled_total)}</b>
                          </span>
                          {r.status !== 'settled' && r.due_date && (
                            <span className={cn('shrink-0 font-bold', n(r.days_left) < 0 ? 'text-[#B3261E]' : n(r.days_left) <= 7 ? 'text-[#8A5A00]' : '')}>
                              {dueText(r)}
                            </span>
                          )}
                        </div>
                        {n(r.excess) > 0.005 && <div className="mt-0.5 text-[10.5px] font-bold text-[#8A5A00]">+{formatINR(r.excess)} over</div>}
                      </div>
                    </button>
                    {isOpen && (
                      <div className="border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-3 py-2">
                        {moves.length === 0 ? (
                          <div className="text-[11.5px] font-semibold text-[#5A6B62]">No {buy ? 'payment' : 'receipt'} against this bill yet.</div>
                        ) : (
                          moves.map((m, i) => (
                            <div key={i} className="flex items-center gap-2 border-b border-b-[#EAF0E9] py-1.5 last:border-b-0">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1 text-[11.5px] font-bold text-[#33473E]">
                                  <span className="tabular-nums">{formatDate(m.date)}</span>
                                  <span className="capitalize">· {String(m.vch_type || '').toLowerCase()}</span>
                                  {m.vch_no ? <span className="text-[#5A6B62]">{m.vch_no}</span> : null}
                                  {m.fifo ? (
                                    <span className="rounded-[2px] bg-[#EAF0FA] px-1 py-px text-[9px] font-extrabold uppercase text-[#1B4E82]">FIFO</span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5">
                                  <ChannelChip kind={m.channel} text={m.instrument?.ref || undefined} />
                                </div>
                              </div>
                              <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-[#0A1F17]">{formatINR(m.amount)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })
      )}
    </div>
  )
}
