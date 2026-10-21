// TODAY'S POSITION — the band at the top of the Dashboard.
// -----------------------------------------------------------------------------
// The rest of the board is the month: what was bought and sold, what is owed.
// This is the morning question instead — what is in the tanks, what went out
// and came in yesterday, which tankers are still on the road, what money is
// still to come back, and whether the plant is making what it planned to.
//
// It loads its own figures (dashboard:position and productionPlan:get) rather
// than riding on dashboard:stats, so the monthly board is not held up by it and
// either can fail without blanking the other. Drawn with the board's own theme
// tokens, so it sits on the dark wall-screen board and on the light one alike,
// and on the desktop app, which passes the light palette.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { setPageIntent } from '@/lib/pageIntent'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Factory,
  HandCoins,
  Landmark,
  Pencil,
  Plus,
  Save,
  Trash2,
  Truck,
  Warehouse,
  X,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import type { Page } from '@/components/Sidebar'
import type { DashTheme } from '@/lib/dashTheme'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const r3 = (v: number): number => Math.round(v * 1000) / 1000

function money(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

// Which side of the books a balance sits on — Dr what is owed to us, Cr what
// we owe — as a small tag after the figure, the way a ledger prints it.
function DrCr({ side, fg, small }: { side: 'Dr' | 'Cr'; fg: string; small?: boolean }): React.JSX.Element {
  return (
    <span
      className={`ml-1.5 inline-block rounded-[3px] px-1 align-middle font-sans font-extrabold leading-[1.5] tracking-[.02em] ${small ? 'text-[8.5px]' : 'text-[9.5px]'}`}
      style={{ color: fg, border: `1px solid ${fg}`, opacity: 0.85 }}
      title={side === 'Dr' ? 'Debit — receivable, owed to us' : 'Credit — payable, we owe'}
    >
      {side}
    </span>
  )
}

function shiftDay(iso: string, by: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + by)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// Days from today, negative once it has passed.
function daysTo(iso: unknown): number | null {
  const d = s(iso).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  return Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

export type PositionProps = {
  t: DashTheme
  dark: boolean
  isMobile: boolean
  // The book stock by category the board already has — the Stock inventory
  // tile reads it rather than asking again, so it cannot disagree with the
  // "Book stock by category" card further down.
  cats: Record<string, { qty: number; products: number }>
  onNavigate: (p: Page) => void
  // Which of the band's pieces this person has chosen to see (Customize).
  isOn?: (key: string) => boolean
  // Every company's position together (the dashboard's All companies).
  allCompanies?: boolean
  // Open the one record a row is about — the LC, the discounted bill, the
  // trading deal — rather than just its page.
  onOpenRecord?: (target: 'lc' | 'bd' | 'trading', id: number) => void
}

const ALL_ON = (): boolean => true
// Each tile's key in the Customize list.
const TILE_KEY: Record<string, string> = {
  stock: 'pos.stock',
  disp: 'pos.dispatch',
  rec: 'pos.receipts',
  payin: 'pos.payin',
  trade: 'pos.trade'
}

export function DailyPosition({ t, dark, isMobile, cats, onNavigate, isOn = ALL_ON, allCompanies = false, onOpenRecord }: PositionProps): React.JSX.Element | null {
  // A stage cell opens Purchases on the tankers at that stage.
  const openStage = (stage: string): void => {
    setPageIntent('orders', { kind: 'stage', stage })
    onNavigate('orders')
  }
  const [pos, setPos] = useState<Row | null>(null)
  const [failed, setFailed] = useState('')
  const [planDate, setPlanDate] = useState(todayISO())
  const [plan, setPlan] = useState<Row | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      setPos(await window.api.dashboard.position(allCompanies))
      setFailed('')
    } catch (e) {
      setFailed((e as Error).message || 'Could not read the position')
    }
  }, [allCompanies])
  const loadPlan = useCallback(async (d: string) => {
    try {
      setPlan(await window.api.productionPlan.get(d))
    } catch {
      setPlan({ date: d, rows: [], canEdit: false })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadPlan(planDate)
  }, [loadPlan, planDate])
  useLiveRefresh(
    useCallback(async () => {
      await Promise.all([load(), loadPlan(planDate)])
    }, [load, loadPlan, planDate])
  )

  // ------------------------------------------------------------- figures --
  const stockTotal = Object.values(cats).reduce((a, c) => a + n(c.qty), 0)
  const catLine = ['raw', 'intermediate', 'finished']
    .filter((k) => cats[k])
    .map((k) => `${k === 'intermediate' ? 'Int.' : k === 'finished' ? 'Fin.' : 'Raw'} ${formatNum(r3(n(cats[k].qty)))}`)
    .join(' · ')
  const disp = (pos?.dispatch as Row) || {}
  const rec = (pos?.receipts as Row) || {}
  const payIn = ((pos?.payIn as Row[]) || []) as Row[]
  const payInLc = payIn.filter((x) => x.kind === 'LC')
  const payInBd = payIn.filter((x) => x.kind === 'BD')
  const payInTotal = payIn.reduce((a, x) => a + n(x.amount), 0)
  const trading = ((pos?.trading as Row[]) || []) as Row[]
  const tradeRecv = trading.reduce((a, x) => a + n(x.receivable), 0)
  const tradePay = trading.reduce((a, x) => a + n(x.payable), 0)
  const moving = ((pos?.movement as Row[]) || []) as Row[]
  const yLabel = pos?.yesterday ? formatDate(pos.yesterday) : 'yesterday'

  type Tile = { key: string; label: string; icon: LucideIcon; fg: string; value: string; unit?: string; sub: string; page: Page; wide?: boolean; extra?: React.ReactNode }
  const openDeals = trading.length
  const tiles: Tile[] = [
    {
      key: 'stock',
      label: 'Stock inventory',
      icon: Warehouse,
      fg: t.accent,
      value: formatNum(r3(stockTotal)),
      unit: 'MT',
      sub: catLine || 'book stock, all categories',
      page: 'stock'
    },
    {
      key: 'disp',
      label: 'Yesterday dispatch',
      icon: ArrowUpFromLine,
      fg: t.blue,
      value: formatNum(r3(n(disp.mt))),
      unit: 'MT',
      sub: `${n(disp.count)} dispatch${n(disp.count) === 1 ? '' : 'es'} · ${yLabel}`,
      page: 'sales'
    },
    {
      key: 'rec',
      label: 'Yesterday receipts',
      icon: ArrowDownToLine,
      fg: t.green,
      value: formatNum(r3(n(rec.mt))),
      unit: 'MT',
      sub: `${n(rec.count)} receipt${n(rec.count) === 1 ? '' : 's'} · ${yLabel}`,
      page: 'orders'
    },
    {
      key: 'payin',
      label: 'Payment IN pending',
      icon: Landmark,
      fg: t.amber,
      value: money(payInTotal),
      sub: `${payInLc.length} LC${payInLc.length === 1 ? '' : 's'} · ${payInBd.length} BD${payInBd.length === 1 ? '' : 's'} awaiting`,
      page: 'treasury'
    },
    {
      key: 'trade',
      label: 'Trading payments pending',
      icon: HandCoins,
      fg: t.violet,
      value: money(tradeRecv),
      unit: 'Dr · customers',
      sub: `${openDeals} deal${openDeals === 1 ? '' : 's'} with money outstanding`,
      page: 'trading',
      extra: (
        <span className="doc-ref mt-[5px] block text-[13px] font-bold" style={{ color: t.red }}>
          {money(tradePay)}
          <DrCr side="Cr" fg={t.red} small />
          <span className="ml-1.5 font-sans text-[10.5px] font-semibold" style={{ color: t.muted }}>
            suppliers
          </span>
        </span>
      )
    }
  ]

  // A tile opens its page ON the figures it counts: yesterday's dispatch lands
  // on yesterday's dispatches in Sales, yesterday's receipts on the purchases
  // received yesterday — not on the whole register.
  function openTile(k: Tile): void {
    const day = String(pos?.yesterday || '').slice(0, 10)
    if (day && k.key === 'disp') setPageIntent('sales', { kind: 'dispatched', date: day })
    if (day && k.key === 'rec') setPageIntent('orders', { kind: 'received', date: day })
    onNavigate(k.page)
  }

  // ----------------------------------------------------------- fragments --
  const Card = ({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }): React.JSX.Element => (
    <div className={className} style={{ background: t.card, border: `1px solid ${t.bd}`, boxShadow: t.shadow, borderRadius: isMobile ? 5 : 6, ...style }}>
      {children}
    </div>
  )
  const Head = ({ icon: Ico, title, fg, right }: { icon: LucideIcon; title: string; fg: string; right?: React.ReactNode }): React.JSX.Element => (
    <div className="flex flex-none flex-wrap items-center gap-[9px]">
      <Ico className="h-[18px] w-[18px] flex-none" style={{ color: fg }} />
      <span className="min-w-0 flex-1 text-[12.5px] font-extrabold">{title}</span>
      {right}
    </div>
  )
  const Empty = ({ text }: { text: string }): React.JSX.Element => (
    <div className="py-4 text-center text-[11.5px] font-semibold" style={{ color: t.faint }}>
      {text}
    </div>
  )
  const Chip = ({ children, fg, bg }: { children: React.ReactNode; fg: string; bg?: string }): React.JSX.Element => (
    <span
      className="inline-flex flex-none items-center rounded-[3px] px-1.5 py-[2px] text-[9.5px] font-extrabold uppercase tracking-[.06em]"
      style={{ color: fg, background: bg || t.track }}
    >
      {children}
    </span>
  )
  const DueTag = ({ iso }: { iso: unknown }): React.JSX.Element => {
    const d = daysTo(iso)
    if (d == null) return <span style={{ color: t.faint }}>no term</span>
    const late = d < 0
    return (
      <span style={{ color: late ? t.red : d <= 7 ? t.amber : t.muted, fontWeight: late ? 800 : 700 }}>
        {late ? `${-d}d overdue` : d === 0 ? 'due today' : `in ${d}d`}
      </span>
    )
  }

  // The stage a moving tanker is at, in the order they happen.
  const stages = useMemo(() => {
    const by = new Map<string, { label: string; count: number; mt: number; order: number }>()
    for (const m of moving) {
      const k = s(m.status)
      const cur = by.get(k) || { label: s(m.stage_label) || k, count: 0, mt: 0, order: n(m.stage_order) }
      cur.count += 1
      cur.mt += n(m.qty_mt)
      by.set(k, cur)
    }
    return [...by.entries()].sort((a, b) => a[1].order - b[1].order)
  }, [moving])

  // ------------------------------------------------------------- blocks --
  // Only the tiles this person keeps, spread across the row they leave — a
  // hidden tile must not leave a hole where it stood. On a phone they pair
  // up, and an odd one out takes the whole width.
  const shownTiles = tiles
    .filter((k) => isOn(TILE_KEY[k.key]))
    .map((k, i, arr) => ({ ...k, wide: isMobile && i === arr.length - 1 && arr.length % 2 === 1 }))
  const tileGrid = shownTiles.length ? (
    <div
      className="grid flex-none"
      style={{
        gap: isMobile ? 10 : 14,
        gridTemplateColumns: isMobile ? 'repeat(2,minmax(0,1fr))' : `repeat(${shownTiles.length},minmax(0,1fr))`
      }}
    >
      {shownTiles.map((k) => {
        const Ico = k.icon
        return (
          <button
            key={k.key}
            type="button"
            onClick={() => openTile(k)}
            className={`relative overflow-hidden text-left transition-transform duration-300 ${isMobile ? 'px-[13px] py-3' : 'px-[15px] pb-3.5 pt-3.5 hover:-translate-y-1'}`}
            style={{
              gridColumn: k.wide ? '1 / -1' : undefined,
              background: t.card,
              border: `1px solid ${t.bd}`,
              boxShadow: t.shadow,
              borderRadius: isMobile ? 5 : 6
            }}
          >
            <span className="flex items-center gap-[7px]">
              <Ico className="h-4 w-4 flex-none" style={{ color: k.fg }} />
              <span className="min-w-0 text-[9px] font-extrabold uppercase leading-[1.3] tracking-[.12em]" style={{ color: t.muted }}>
                {k.label}
              </span>
            </span>
            <span className={`doc-ref mt-2 block font-bold tracking-[-0.035em] ${isMobile ? 'text-[19px]' : 'text-[24px]'}`} style={{ color: t.ink }}>
              {pos || k.key === 'stock' ? k.value : '…'}
              {k.unit && (
                <span className="ml-1 font-sans text-[11px] font-bold tracking-normal" style={{ color: t.faint }}>
                  {k.unit}
                </span>
              )}
            </span>
            {k.extra && pos ? k.extra : null}
            <span
              className={`mt-[5px] block text-[10.5px] font-semibold ${isMobile ? 'leading-[1.4]' : 'truncate'}`}
              style={{ color: t.muted }}
              title={k.sub}
            >
              {k.sub}
            </span>
          </button>
        )
      })}
    </div>
  ) : null

  // THE MOVEMENT MATRIX. One row per oil, one column per stage in the order
  // they happen, each cell the tankers of that oil at that stage (and their
  // MT) — the position at a glance, which a tanker-by-tanker list buried under
  // its own length. The tankers themselves are one line underneath, and only
  // the ones running late.
  //
  // Late is the same line the list drew in amber: more than DELAY_DAYS at the
  // stage they are at.
  const DELAY_DAYS = 5
  const matrix = (() => {
    const oils = new Map<string, { cells: Map<string, { count: number; mt: number }>; count: number; mt: number }>()
    for (const m of moving) {
      const oil = s(m.product_name) || '—'
      const k = s(m.status)
      const row = oils.get(oil) || { cells: new Map<string, { count: number; mt: number }>(), count: 0, mt: 0 }
      const c = row.cells.get(k) || { count: 0, mt: 0 }
      c.count += 1
      c.mt += n(m.qty_mt)
      row.cells.set(k, c)
      row.count += 1
      row.mt += n(m.qty_mt)
      oils.set(oil, row)
    }
    return [...oils.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })()
  const delayed = moving.filter((m) => n(m.days) > DELAY_DAYS).sort((a, b) => n(b.days) - n(a.days))
  const movingMt = moving.reduce((a, m) => a + n(m.qty_mt), 0)
  // A cell: the count, and the MT beside it (under it on a phone, so the
  // stage columns fit the width). Blank stays a quiet dash.
  const cell = (count: number, mt: number, strong = false): React.JSX.Element =>
    count > 0 ? (
      <span
        className={
          isMobile
            ? 'inline-flex flex-col items-end whitespace-nowrap leading-[1.25]'
            : 'inline-flex items-baseline justify-end gap-1.5 whitespace-nowrap'
        }
      >
        <span className="doc-ref text-[13.5px] font-extrabold" style={{ color: strong ? t.ink : t.accent }}>
          {count}
        </span>
        <span className="doc-ref text-[10.5px] font-semibold" style={{ color: t.muted }}>
          {formatNum(r3(mt))} MT
        </span>
      </span>
    ) : (
      <span style={{ color: t.faint }}>—</span>
    )

  const movementCard = (
    <Card className={isMobile ? 'flex-none px-3.5 py-3.5' : 'min-w-0 px-[18px] py-4'}>
      <Head
        icon={Truck}
        title="Oil movement position"
        fg={t.accent}
        right={
          <span className="doc-ref text-[11.5px] font-bold" style={{ color: t.muted }}>
            {moving.length} tanker{moving.length === 1 ? '' : 's'} · {formatNum(r3(movingMt))} MT
          </span>
        }
      />
      {moving.length === 0 ? (
        <Empty text={pos ? 'No tanker on the road — everything loaded has been received.' : 'Reading…'} />
      ) : (
        <>
          <div className="mt-3 overflow-x-auto rounded-[4px]" style={{ border: `1px solid ${t.hair}` }}>
            <table className="w-full text-[12px]">
              <thead style={{ background: dark ? '#0B2A20' : '#EEF4EC' }}>
                <tr className="text-[9.5px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
                  <th className="px-2.5 py-2 text-left">Oil</th>
                  {stages.map(([k, v]) => (
                    <th key={k} className={isMobile ? 'px-2 py-2 text-right leading-[1.3]' : 'whitespace-nowrap px-2.5 py-2 text-right'}>
                      {v.label}
                    </th>
                  ))}
                  <th className="px-2.5 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map(([oil, row]) => (
                  <tr
                    key={oil}
                    onClick={() => onNavigate('orders')}
                    className="cursor-pointer"
                    style={{ borderTop: `1px solid ${t.hair}` }}
                    title={`${oil} — open Purchases`}
                  >
                    <td className="px-2.5 py-2 font-extrabold" style={{ color: t.ink }}>
                      {oil}
                    </td>
                    {stages.map(([k, v]) => {
                      const c = row.cells.get(k)
                      return (
                        <td
                          key={k}
                          className={isMobile ? 'px-2 py-2 text-right' : 'px-2.5 py-2 text-right'}
                          title={c?.count ? `${oil} · ${v.label} — open these tankers` : undefined}
                          onClick={(e) => {
                            if (!c?.count) return
                            e.stopPropagation()
                            openStage(k)
                          }}
                        >
                          {cell(c?.count || 0, c?.mt || 0)}
                        </td>
                      )
                    })}
                    <td className={isMobile ? 'px-2 py-2 text-right' : 'px-2.5 py-2 text-right'}>{cell(row.count, row.mt, true)}</td>
                  </tr>
                ))}
              </tbody>
              {matrix.length > 1 && (
                <tfoot>
                  <tr style={{ borderTop: `1px solid ${t.hair}`, background: t.inset }}>
                    <td className="px-2.5 py-2 text-[10px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
                      Total
                    </td>
                    {stages.map(([k, v]) => (
                      <td
                        key={k}
                        className={isMobile ? 'cursor-pointer px-2 py-2 text-right' : 'cursor-pointer px-2.5 py-2 text-right'}
                        title={`${v.label} — open these tankers`}
                        onClick={() => openStage(k)}
                      >
                        {cell(v.count, v.mt, true)}
                      </td>
                    ))}
                    <td className={isMobile ? 'px-2 py-2 text-right' : 'px-2.5 py-2 text-right'}>{cell(moving.length, movingMt, true)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {/* The one line about individual tankers: which are late. */}
          <div
            className="mt-2.5 min-w-0 rounded-[4px] px-3 py-2 text-[11.5px] font-semibold leading-[1.5] [overflow-wrap:anywhere]"
            style={
              delayed.length
                ? { background: `${t.amber}1A`, border: `1px solid ${t.amber}55`, color: t.ink2 }
                : { background: t.inset, border: `1px solid ${t.hair}`, color: t.muted }
            }
          >
            {delayed.length ? (
              <>
                <span className="font-extrabold" style={{ color: t.amber }}>
                  {delayed.length} tanker{delayed.length === 1 ? '' : 's'} delayed
                </span>{' '}
                (over {DELAY_DAYS} days at their stage):{' '}
                {delayed.map((m, i) => (
                  <span key={String(m.id)}>
                    {i > 0 ? ' · ' : ''}
                    <span className="doc-ref font-bold" style={{ color: t.ink }}>
                      {s(m.tanker_no) || 'no number'}
                    </span>{' '}
                    {s(m.product_name) || '—'}, {s(m.stage_label).toLowerCase()}{' '}
                    <span className="doc-ref font-extrabold" style={{ color: t.amber }}>
                      {n(m.days)}d
                    </span>
                  </span>
                ))}
              </>
            ) : (
              <>No tanker delayed — every one has moved within {DELAY_DAYS} days.</>
            )}
          </div>
        </>
      )}
    </Card>
  )

  // Production plan against what was actually recorded for the day.
  const planRows = ((plan?.rows as Row[]) || []) as Row[]
  const planTot = planRows.reduce((a, r) => a + n(r.planned_qty), 0)
  const actTot = planRows.reduce((a, r) => a + n(r.actual_qty), 0)
  const planCard = (
    <Card className={isMobile ? 'flex-none px-3.5 py-3.5' : 'min-w-0 px-[18px] py-4'}>
      <Head
        icon={Factory}
        title="Production plan vs actual"
        fg={t.blue}
        right={
          plan?.canEdit ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] px-2.5 text-[11.5px] font-extrabold"
              style={{ color: t.accent, background: t.accentSoft, border: `1px solid ${t.accentBd}` }}
            >
              <Pencil className="h-3.5 w-3.5" />{' '}
              {planRows.some((r) => n(r.planned_qty) > 0) ? (isMobile ? 'Edit' : 'Edit plan') : isMobile ? 'Plan' : 'Plan the day'}
            </button>
          ) : null
        }
      />
      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => setPlanDate((d) => shiftDay(d, -1))}
          className="flex h-8 w-8 items-center justify-center rounded-[4px]"
          style={{ background: t.inset, border: `1px solid ${t.hair}`, color: t.ink2 }}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <label
          className="relative flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[4px] text-[12px] font-extrabold"
          style={{ background: t.inset, border: `1px solid ${t.hair}`, color: t.ink }}
        >
          <CalendarDays className="h-3.5 w-3.5" style={{ color: t.muted }} />
          <span className="doc-ref">{formatDate(planDate)}</span>
          {planDate === todayISO() && <span style={{ color: t.accent }}>· today</span>}
          <input
            type="date"
            value={planDate}
            onChange={(e) => e.target.value && setPlanDate(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Plan date"
          />
        </label>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => setPlanDate((d) => shiftDay(d, 1))}
          className="flex h-8 w-8 items-center justify-center rounded-[4px]"
          style={{ background: t.inset, border: `1px solid ${t.hair}`, color: t.ink2 }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {planRows.length === 0 ? (
        <Empty text={plan ? 'Nothing planned or produced on this day.' : 'Reading…'} />
      ) : (
        <div className="mt-3 overflow-hidden rounded-[4px]" style={{ border: `1px solid ${t.hair}` }}>
          <div
            className="grid px-2.5 py-2 text-[9.5px] font-extrabold uppercase tracking-[.1em]"
            style={{ gridTemplateColumns: 'minmax(0,1fr) 64px 64px 64px', color: t.muted, background: dark ? '#0B2A20' : '#EEF4EC' }}
          >
            <span>Product</span>
            <span className="text-right">Plan</span>
            <span className="text-right">Actual</span>
            <span className="text-right">Gap</span>
          </div>
          {[...planRows, { product_name: 'Total', planned_qty: planTot, actual_qty: actTot, _total: true }].map((r, i) => {
            const gap = r3(n(r.actual_qty) - n(r.planned_qty))
            const planned = n(r.planned_qty) > 0
            const pct = planned ? Math.min(100, (n(r.actual_qty) / n(r.planned_qty)) * 100) : 0
            return (
              <div
                key={r._total ? 'total' : String(r.product_id ?? i)}
                className="px-2.5 py-2"
                style={{ borderTop: `1px solid ${t.hair}`, background: r._total ? t.inset : undefined }}
              >
                <div className="grid items-baseline text-[12px]" style={{ gridTemplateColumns: 'minmax(0,1fr) 64px 64px 64px' }}>
                  <span className="min-w-0 truncate font-bold" style={{ color: r._total ? t.ink : t.ink2, fontWeight: r._total ? 800 : 700 }}>
                    {s(r.product_name) || '—'}
                  </span>
                  <span className="doc-ref text-right font-bold" style={{ color: t.muted }}>
                    {planned ? formatNum(r3(n(r.planned_qty))) : '—'}
                  </span>
                  <span className="doc-ref text-right font-bold" style={{ color: t.ink }}>
                    {n(r.actual_qty) ? formatNum(r3(n(r.actual_qty))) : '—'}
                  </span>
                  <span
                    className="doc-ref text-right font-bold"
                    style={{ color: !planned ? t.faint : Math.abs(gap) < 0.0005 ? t.green : gap < 0 ? t.red : t.green }}
                  >
                    {!planned ? 'unplanned' : `${gap > 0 ? '+' : ''}${formatNum(gap)}`}
                  </span>
                </div>
                {planned && !r._total && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-[2px]" style={{ background: t.track }}>
                    <div className="h-full" style={{ width: `${pct}%`, background: pct >= 99.5 ? t.green : t.blue }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-2 text-[10.5px] font-semibold leading-[1.45]" style={{ color: t.faint }}>
        Gap = Actual − Plan, in MT. Actual is the production recorded for the day; recirculation is left out.
      </div>
    </Card>
  )

  const payInCard = (
    <Card className={isMobile ? 'flex-none px-3.5 py-3.5' : 'min-w-0 px-[18px] py-4'}>
      <Head
        icon={Landmark}
        title="Payment IN pending — LCs & BDs"
        fg={t.amber}
        right={
          <span className="doc-ref text-[12.5px] font-bold" style={{ color: t.amber }}>
            {money(payInTotal)}
          </span>
        }
      />
      {payIn.length === 0 ? (
        <Empty text={pos ? 'Nothing awaiting a Payment IN.' : 'Reading…'} />
      ) : (
        <div className={`mt-2.5 flex flex-col ${isMobile ? '' : 'max-h-[300px] overflow-y-auto pr-1'}`}>
          {payIn.map((x, i) => (
            <button
              key={`${x.kind}-${x.id}`}
              type="button"
              onClick={() => (onOpenRecord && n(x.id) ? onOpenRecord(x.kind === 'LC' ? 'lc' : 'bd', n(x.id)) : onNavigate('treasury'))}
              className="flex items-center gap-2.5 py-2 text-left"
              style={{ borderTop: i ? `1px dotted ${t.hair}` : 'none' }}
            >
              <Chip fg={x.kind === 'LC' ? t.blue : t.violet}>{s(x.kind)}</Chip>
              <span className="min-w-0 flex-1">
                <span className="doc-ref block truncate text-[12px] font-bold" style={{ color: t.ink }}>
                  {s(x.ref_no) || 'No number yet'}
                </span>
                <span className="block truncate text-[10.5px] font-semibold" style={{ color: t.muted }}>
                  {s(x.party) || 'the customer'}
                  {/* Part of it already back: the figure is what is still to come. */}
                  {n(x.received) > 0.5 && <span style={{ color: t.green }}> · {money(n(x.received))} back</span>}
                </span>
              </span>
              <span className="flex-none text-right">
                <span className="doc-ref block text-[12px] font-bold" style={{ color: t.ink }} title="Still to come back: drawn less what has come back">
                  {money(n(x.amount))}
                </span>
                <span className="block text-[10.5px]">
                  <DueTag iso={x.due_date} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  )

  const tradingCard = (
    <Card className={isMobile ? 'flex-none px-3.5 py-3.5' : 'min-w-0 px-[18px] py-4'}>
      <Head icon={HandCoins} title="Trading — payments pending" fg={t.violet} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-[4px] px-3 py-2" style={{ background: t.inset, border: `1px solid ${t.hair}` }}>
          <div className="text-[9px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
            Customers · Dr
          </div>
          <div className="doc-ref mt-0.5 text-[15px] font-bold" style={{ color: t.green }}>
            {money(tradeRecv)}
            <DrCr side="Dr" fg={t.green} />
          </div>
        </div>
        <div className="rounded-[4px] px-3 py-2" style={{ background: t.inset, border: `1px solid ${t.hair}` }}>
          <div className="text-[9px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
            Suppliers · Cr
          </div>
          <div className="doc-ref mt-0.5 text-[15px] font-bold" style={{ color: t.red }}>
            {money(tradePay)}
            <DrCr side="Cr" fg={t.red} />
          </div>
        </div>
      </div>
      {trading.length === 0 ? (
        <Empty text={pos ? 'Every trading deal is settled both ways.' : 'Reading…'} />
      ) : (
        <div className={`mt-2 flex flex-col ${isMobile ? '' : 'max-h-[300px] overflow-y-auto pr-1'}`}>
          {trading.map((d, i) => (
            <button
              key={String(d.id)}
              type="button"
              onClick={() => (onOpenRecord && n(d.id) ? onOpenRecord('trading', n(d.id)) : onNavigate('trading'))}
              className="py-2 text-left"
              style={{ borderTop: i ? `1px dotted ${t.hair}` : 'none' }}
            >
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="min-w-0 truncate text-[12px] font-bold" style={{ color: t.ink }}>
                  {s(d.product) || 'Trade'}{' '}
                  <span className="doc-ref text-[10.5px] font-semibold" style={{ color: t.faint }}>
                    {d.deal_date ? formatDate(d.deal_date) : ''}
                  </span>
                </span>
                <span className="flex-none text-[10.5px]">
                  <DueTag iso={d.due_date} />
                </span>
              </div>
              {isMobile ? (
                <div className="mt-1.5 flex flex-col gap-1 text-[11.5px]">
                  {[
                    { role: 'Customer', who: s(d.buyers), v: n(d.receivable), fg: t.green, none: 'settled', side: 'Dr' as const },
                    { role: 'Supplier', who: s(d.supplier), v: n(d.payable), fg: t.red, none: 'paid', side: 'Cr' as const }
                  ].map((x, k) => (
                    <div key={k} className="flex items-start justify-between gap-2.5">
                      <span className="min-w-0 leading-[1.35] [overflow-wrap:anywhere]">
                        <span className="block text-[9px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.faint }}>
                          {x.role}
                        </span>
                        <span className="font-semibold" style={{ color: t.muted }}>
                          {x.who || '—'}
                        </span>
                      </span>
                      <span className="doc-ref flex-none whitespace-nowrap font-bold" style={{ color: x.v > 0.5 ? x.fg : t.faint }}>
                        {x.v > 0.5 ? (
                          <>
                            {money(x.v)}
                            <DrCr side={x.side} fg={x.fg} small />
                          </>
                        ) : (
                          x.none
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
              <div className="mt-1 grid grid-cols-2 gap-2.5 text-[11px]">
                <span className="min-w-0">
                  <span className="block truncate font-semibold" style={{ color: t.muted }}>
                    <span className="text-[9px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.faint }}>Customer · </span>
                    {s(d.buyers) || '—'}
                  </span>
                  <span className="doc-ref font-bold" style={{ color: n(d.receivable) > 0.5 ? t.green : t.faint }}>
                    {n(d.receivable) > 0.5 ? (
                      <>
                        {money(n(d.receivable))}
                        <DrCr side="Dr" fg={t.green} small />
                      </>
                    ) : (
                      'settled'
                    )}
                  </span>
                </span>
                <span className="min-w-0 text-right">
                  <span className="block truncate font-semibold" style={{ color: t.muted }}>
                    <span className="text-[9px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.faint }}>Supplier · </span>
                    {s(d.supplier) || '—'}
                  </span>
                  <span className="doc-ref font-bold" style={{ color: n(d.payable) > 0.5 ? t.red : t.faint }}>
                    {n(d.payable) > 0.5 ? (
                      <>
                        {money(n(d.payable))}
                        <DrCr side="Cr" fg={t.red} small />
                      </>
                    ) : (
                      'paid'
                    )}
                  </span>
                </span>
              </div>
              )}
            </button>
          ))}
        </div>
      )}
    </Card>
  )

  // The cards this person keeps. A row with one card left gives it the width;
  // a band with nothing left is not drawn at all, heading included.
  const showMove = isOn('pos.movement')
  const showPlan = isOn('pos.plan')
  const showPayIn = isOn('pos.payinList')
  const showTrade = isOn('pos.tradeList')
  if (!shownTiles.length && !showMove && !showPlan && !showPayIn && !showTrade) return null

  return (
    <div className="flex flex-none flex-col" style={{ gap: isMobile ? 11 : 14 }}>
      <div className="flex items-center gap-2.5">
        <span className="text-[10.5px] font-extrabold uppercase tracking-[.16em]" style={{ color: t.accent }}>
          Today&rsquo;s position
        </span>
        <span className="h-px flex-1" style={{ background: t.hair }} />
        {failed && (
          <span className="text-[11px] font-bold" style={{ color: t.red }} title={failed}>
            could not read — {failed.slice(0, 60)}
          </span>
        )}
      </div>
      {tileGrid}
      {isMobile ? (
        <>
          {showPlan && planCard}
          {showMove && movementCard}
          {showPayIn && payInCard}
          {showTrade && tradingCard}
        </>
      ) : (
        <>
          {(showMove || showPlan) && (
            <div
              className="grid gap-3.5"
              style={{ gridTemplateColumns: showMove && showPlan ? 'minmax(0,1.62fr) minmax(0,1fr)' : 'minmax(0,1fr)' }}
            >
              {showMove && movementCard}
              {showPlan && planCard}
            </div>
          )}
          {(showPayIn || showTrade) && (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(${showPayIn && showTrade ? 2 : 1},minmax(0,1fr))` }}>
              {showPayIn && payInCard}
              {showTrade && tradingCard}
            </div>
          )}
        </>
      )}
      {editing && plan && (
        <PlanEditor
          t={t}
          dark={dark}
          isMobile={isMobile}
          date={planDate}
          rows={planRows}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            await loadPlan(planDate)
          }}
        />
      )}
    </div>
  )
}

// ================================================================ the editor
// The day's plan, product by product. Opened from the Dashboard card — the
// plan lives nowhere else, by the desk's choice — and saved as the whole day at
// once, so a row taken out here is taken out of the plan.
function PlanEditor({
  t,
  dark,
  isMobile,
  date,
  rows,
  onClose,
  onSaved
}: {
  t: DashTheme
  dark: boolean
  isMobile: boolean
  date: string
  rows: Row[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [products, setProducts] = useState<Row[]>([])
  const [lines, setLines] = useState<{ product_id: string; qty: string; note: string }[]>(() => {
    const planned = rows.filter((r) => n(r.planned_qty) > 0)
    return planned.length
      ? planned.map((r) => ({ product_id: String(r.product_id), qty: String(r3(n(r.planned_qty))), note: s(r.note) }))
      : [{ product_id: '', qty: '', note: '' }]
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.data
      .list('products')
      .then((p: Row[]) =>
        setProducts(
          p
            // What the plant makes — the finished and intermediate products the
            // production register is ever written against. Raw oil is bought,
            // and scrap or packaging is not planned.
            .filter((x) => x.active !== 0 && x.active !== false && ['finished', 'intermediate'].includes(s(x.category)))
            .sort((a, b) => s(a.name).localeCompare(s(b.name)))
        )
      )
      .catch(() => setProducts([]))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (i: number, patch: Partial<{ product_id: string; qty: string; note: string }>): void =>
    setLines((p) => p.map((l, k) => (k === i ? { ...l, ...patch } : l)))
  const taken = new Set(lines.map((l) => l.product_id).filter(Boolean))
  const total = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)

  async function save(): Promise<void> {
    const out = lines
      .filter((l) => l.product_id && Number(l.qty) > 0)
      .map((l) => ({ product_id: Number(l.product_id), planned_qty: Number(l.qty), note: l.note.trim() || null }))
    const bad = lines.find((l) => l.product_id && !(Number(l.qty) > 0))
    if (bad) {
      toast.error('Every product on the plan needs a quantity above 0 MT — or take the row out.')
      return
    }
    setSaving(true)
    try {
      await window.api.productionPlan.save(date, out)
      toast.success(out.length ? `Plan for ${formatDate(date)} saved — ${out.length} product${out.length === 1 ? '' : 's'}` : `Plan for ${formatDate(date)} cleared`)
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const field = { background: dark ? 'rgba(255,255,255,.06)' : '#fff', border: `1px solid ${t.bd}`, color: t.ink }
  // Portalled to the page root. The desktop board sets a 3D perspective on its
  // container, and that makes any fixed-position child sit inside the board
  // rather than on the screen — the dialog opened halfway down a long page,
  // with the sidebar left undimmed.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" style={{ background: 'rgba(4,21,15,.55)' }} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Production plan"
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden ${isMobile ? 'rounded-t-[8px]' : 'max-w-[640px] rounded-[8px]'}`}
        style={{ background: dark ? '#07211A' : '#fff', border: `1px solid ${t.bd}`, color: t.ink, boxShadow: '0 20px 60px rgba(0,0,0,.35)' }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ borderBottom: `1px solid ${t.hair}` }}>
          <Factory className="h-5 w-5" style={{ color: t.blue }} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-extrabold">Production plan</div>
            <div className="doc-ref text-[11.5px] font-semibold" style={{ color: t.muted }}>
              {formatDate(date)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[4px]" style={{ color: t.muted }}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-[4px] p-2.5" style={{ background: t.inset, border: `1px solid ${t.hair}` }}>
              <span className="doc-ref w-5 flex-none text-center text-[11px] font-extrabold" style={{ color: t.faint }}>
                {i + 1}
              </span>
              <select
                value={l.product_id}
                onChange={(e) => set(i, { product_id: e.target.value })}
                aria-label="Product"
                className={`min-w-0 flex-1 rounded-[4px] px-2 font-bold outline-none ${isMobile ? 'h-11 text-[16px]' : 'h-10 text-[13px]'}`}
                style={{ ...field, minWidth: isMobile ? 0 : 200, flexBasis: isMobile ? 'calc(100% - 28px)' : undefined }}
              >
                <option value="">Choose product…</option>
                {products.map((p) => (
                  <option key={String(p.id)} value={String(p.id)} disabled={taken.has(String(p.id)) && l.product_id !== String(p.id)}>
                    {s(p.name)}
                  </option>
                ))}
              </select>
              <div className="flex min-w-0 items-center gap-1.5" style={{ flex: isMobile ? '1 1 0%' : 'none', paddingLeft: isMobile ? 28 : 0 }}>
                <input
                  value={l.qty}
                  onChange={(e) => set(i, { qty: e.target.value.replace(/[^\d.]/g, '') })}
                  inputMode="decimal"
                  placeholder="0.000"
                  aria-label="Planned MT"
                  className={`doc-ref rounded-[4px] px-2 text-right font-bold outline-none ${isMobile ? 'h-11 min-w-0 flex-1 text-[16px]' : 'h-10 w-[110px] text-[13px]'}`}
                  style={field}
                />
                <span className="text-[11px] font-bold" style={{ color: t.muted }}>
                  MT
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLines((p) => (p.length === 1 ? [{ product_id: '', qty: '', note: '' }] : p.filter((_, k) => k !== i)))}
                aria-label="Remove this product"
                className={`flex flex-none items-center justify-center rounded-[4px] ${isMobile ? 'h-11 w-11' : 'h-10 w-10'}`}
                style={{ color: t.red, border: `1px solid ${t.bd}` }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <input
                value={l.note}
                onChange={(e) => set(i, { note: e.target.value })}
                placeholder={isMobile ? 'Note (optional)' : 'Note (optional) — batch, tank, shift…'}
                aria-label="Note"
                className={`w-full rounded-[4px] px-2 font-semibold outline-none ${isMobile ? 'ml-7 h-11 text-[16px]' : 'h-9 text-[12px]'}`}
                style={{ ...field, width: isMobile ? 'calc(100% - 28px)' : undefined }}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines((p) => [...p, { product_id: '', qty: '', note: '' }])}
            className="flex h-10 items-center justify-center gap-1.5 rounded-[4px] text-[12.5px] font-extrabold"
            style={{ border: `1px dashed ${t.bd}`, color: t.accent }}
          >
            <Plus className="h-4 w-4" /> Add product
          </button>
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderTop: `1px solid ${t.hair}` }}>
          <span className="min-w-0 flex-1 text-[12px] font-bold" style={{ color: t.muted }}>
            Planned <span className="doc-ref" style={{ color: t.ink }}>{formatNum(r3(total))} MT</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[4px] px-3.5 text-[12.5px] font-extrabold"
            style={{ border: `1px solid ${t.bd}`, color: t.ink2 }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="inline-flex h-10 items-center gap-1.5 rounded-[4px] px-4 text-[12.5px] font-extrabold disabled:opacity-60"
            style={{ background: '#C7F03F', color: '#0B3D2E' }}
          >
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
