import { useCallback, useEffect, useMemo, useState } from 'react'
import { setPageIntent } from '@/lib/pageIntent'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Droplets,
  FileText,
  Landmark,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  ShoppingCart,
  Tag,
  Truck,
  Warehouse
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import type { Page } from '@/components/Sidebar'
import { DashboardWeb } from './DashboardWeb'
import { DailyPosition } from '@/components/DailyPosition'
import { DASH_THEMES } from '@/lib/dashTheme'
import { dashItemsHere, useDashLayout } from '@/lib/dashLayout'
import { DashCustomize } from '@/components/DashCustomize'
import { cn } from '@/lib/utils'
import { formatINR, formatNum } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { STATUS_LABEL } from '@/lib/orderCalc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface Props {
  onNavigate: (page: Page) => void
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// ₹ in lakh/crore shorthand for tight KPI tiles.
function inr(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return formatINR(v)
}

function monthLabel(m: string): string {
  const [y, mo] = String(m).split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(mo) - 1] || mo} ${String(y).slice(2)}`
}

// Paired vertical bars — purchases vs sales per month. Pure SVG, no library.
function PairedBars({ months }: { months: { m: string; buy: number; sell: number }[] }): React.JSX.Element {
  const W = 560
  const H = 190
  const pad = 24
  const max = Math.max(1, ...months.flatMap((x) => [x.buy, x.sell]))
  const bw = months.length ? (W - pad * 2) / months.length : 1
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label="Purchases vs sales by month">
      {months.map((x, i) => {
        const x0 = pad + i * bw
        const hBuy = ((H - 46) * x.buy) / max
        const hSell = ((H - 46) * x.sell) / max
        return (
          <g key={x.m}>
            <rect x={x0 + bw * 0.16} y={H - 28 - hBuy} width={bw * 0.28} height={hBuy} rx={2} className="fill-sky-600" />
            <rect x={x0 + bw * 0.52} y={H - 28 - hSell} width={bw * 0.28} height={hSell} rx={2} className="fill-emerald-500" />
            <text x={x0 + bw / 2} y={H - 12} textAnchor="middle" className="fill-slate-500 text-[10px]">
              {monthLabel(x.m)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// 30-day sparkline area for one series.
function Spark({ days, tone }: { days: { d: string; v: number }[]; tone: 'sky' | 'emerald' }): React.JSX.Element {
  const W = 240
  const H = 56
  const map = new Map(days.map((x) => [String(x.d), n(x.v)]))
  const series: number[] = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    series.push(map.get(iso) || 0)
  }
  const max = Math.max(1, ...series)
  const pts = series.map((v, i) => `${(i / 29) * W},${H - 6 - (v / max) * (H - 12)}`)
  const line = pts.join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const cls = tone === 'sky' ? ['fill-sky-100', 'stroke-sky-600'] : ['fill-emerald-100', 'stroke-emerald-600']
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full">
      <polygon points={area} className={cls[0]} />
      <polyline points={line} fill="none" strokeWidth={1.6} className={cls[1]} />
    </svg>
  )
}

// Horizontal ranked bars (top suppliers / customers / payables).
function RankBars({ rows, unit }: { rows: { name: string; v: number }[]; unit?: (v: number) => string }): React.JSX.Element {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.v)))
  const fmt = unit || inr
  return (
    <div className="space-y-1.5">
      {rows.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">Nothing yet.</p>}
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[1fr_auto] items-center gap-2">
          <div className="min-w-0">
            <div className="mb-0.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px] font-medium">{r.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmt(r.v)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted">
              <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${(Math.abs(r.v) / max) * 100}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  onClick
}: {
  label: string
  value: string
  sub?: string
  icon: React.ComponentType<{ className?: string }>
  tone: string
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-card p-3.5 text-left shadow-sm transition-colors',
        onClick && 'cursor-pointer hover:border-slate-300 hover:bg-muted/40'
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={cn('inline-flex h-7 w-7 items-center justify-center rounded-md', tone)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </button>
  )
}

// The rows of the desktop app's board, by the Customize keys they carry.
const MONTH_KPIS = ['m.buy', 'm.sell', 'm.pay', 'm.rec']
const PARTY_ROW = ['m.topSup', 'm.topCus', 'm.duties']
const OPS_ROW = ['m.stock', 'm.exposure', 'm.attention']

export function Dashboard({ onNavigate }: Props): React.JSX.Element {
  const [stats, setStats] = useState<Row | null>(null)
  const [treasury, setTreasury] = useState<Row | null>(null)
  const [checking, setChecking] = useState(false)
  // ALL COMPANIES: the board reads every company's books together. A way of
  // looking at the dashboard, kept on this browser — it does not change the
  // active company, which every other page still works in.
  const [allCos, setAllCos] = useState(() => {
    try {
      return localStorage.getItem('dash.allCompanies') === '1'
    } catch {
      return false
    }
  })
  const setAllCompanies = useCallback((v: boolean) => {
    setAllCos(v)
    try {
      localStorage.setItem('dash.allCompanies', v ? '1' : '0')
    } catch {
      // Not remembered then; the choice still holds for this visit.
    }
  }, [])

  const refresh = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setChecking(true)
    try {
      const [st, tr] = await Promise.all([window.api.dashboard.stats(allCos), window.api.treasury.alerts(allCos).catch(() => null)])
      setStats(st)
      setTreasury(tr)
    } finally {
      setChecking(false)
    }
  }, [allCos])

  useEffect(() => {
    refresh()
  }, [refresh])
  useLiveRefresh(refresh)
  // Which KPIs and cards this person keeps on the board — one layout for the
  // website's board and the desktop app's, kept on their account.
  const layout = useDashLayout()
  const on = layout.isOn
  const [customizing, setCustomizing] = useState(false)

  const thisMonth = new Date().toISOString().slice(0, 7)
  const buyM = ((stats?.purchaseMonths as Row[]) || []).find((x) => x.m === thisMonth)
  const sellM = ((stats?.saleMonths as Row[]) || []).find((x) => x.m === thisMonth)
  const months = useMemo(() => {
    const keys = new Set<string>()
    for (const x of (stats?.purchaseMonths as Row[]) || []) keys.add(String(x.m))
    for (const x of (stats?.saleMonths as Row[]) || []) keys.add(String(x.m))
    return Array.from(keys)
      .sort()
      .slice(-6)
      .map((m) => ({
        m,
        buy: n(((stats?.purchaseMonths as Row[]) || []).find((x) => x.m === m)?.v),
        sell: n(((stats?.saleMonths as Row[]) || []).find((x) => x.m === m)?.v)
      }))
  }, [stats])

  const payables = ((stats?.payables as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.bal) }))
  const receivables = ((stats?.receivables as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.bal) }))
  const duty = (name: string): number => n(((stats?.duties as Row[]) || []).find((x) => x.name === name)?.bal)
  const negatives = (stats?.negatives as Row[]) || []
  const cats = (stats?.stockCats as Record<string, { qty: number; products: number }>) || {}

  // The website gets its own board — dark by default, animated, and with a
  // phone layout. Everything above is the single data path both share, so the
  // figures cannot drift between the two; only the drawing differs. The desktop
  // app keeps the render below untouched, and this whole branch is compiled out
  // of it.
  if (__WEB__) {
    return (
      <DashboardWeb
        stats={stats}
        treasury={treasury}
        months={months}
        payables={payables}
        receivables={receivables}
        duty={duty}
        negatives={negatives}
        cats={cats}
        buyM={buyM}
        sellM={sellM}
        checking={checking}
        // Wrapped for the same reason the button below is: passed bare, the
        // click event lands in `background` and the spinner never shows.
        onRefresh={() => refresh()}
        onNavigate={onNavigate}
        layout={layout}
        allCompanies={allCos}
        onAllCompanies={setAllCompanies}
      />
    )
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Money, stock and movement at a glance for the active company"
        hint="Every card is live and most are clickable — they take you to the page where the underlying entries live. Payables and receivables come straight from the double-entry books, so they agree with the Trial Balance in Accounting."
        // refresh is WRAPPED, not passed: as a handler the click event would
        // arrive as its `background` argument — truthy — and a refresh
        // somebody asked for would come back without its spinner.
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCustomizing(true)} title="Choose which KPIs and cards the dashboard shows">
              <SlidersHorizontal className="h-4 w-4" /> Customize
              {dashItemsHere().filter((i) => layout.hidden.has(i.key)).length > 0 && (
                <span className="rounded-full bg-emerald-100 px-1.5 text-[10.5px] font-bold text-emerald-800">
                  {dashItemsHere().filter((i) => layout.hidden.has(i.key)).length} hidden
                </span>
              )}
            </Button>
            {/* Every company's books together — the company picker beside
                this still sets the company every other page works in. */}
            <Button
              variant={allCos ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAllCompanies(!allCos)}
              title={allCos ? 'Showing every company together — click for the active company only' : 'Show every company together'}
            >
              All companies
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} /> Refresh
            </Button>
          </div>
        }
      />

      <div className="space-y-4 px-4 py-4">
        {/* The morning's position — the same band the website carries, drawn
            in the board's light palette. */}
        {dashItemsHere().some((i) => i.group === 'position' && on(i.key)) && (
          <div className="rounded-md bg-[#F1F5EF] p-3">
            <DailyPosition t={DASH_THEMES.light} dark={false} isMobile={false} cats={cats} onNavigate={onNavigate} isOn={on} allCompanies={allCos} />
          </div>
        )}
        {dashItemsHere().every((i) => !on(i.key)) && (
          <Card className="flex flex-col items-center gap-2 p-8 text-center">
            <SlidersHorizontal className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-semibold">Every card is hidden</span>
            <Button size="sm" variant="outline" onClick={() => setCustomizing(true)}>
              Customize the dashboard
            </Button>
          </Card>
        )}
        {/* KPI row — only the tiles kept, spread across the row. */}
        {MONTH_KPIS.some(on) && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${MONTH_KPIS.filter(on).length},minmax(0,1fr))` }}>
          {on('m.buy') && <Kpi
            label="Purchases this month"
            value={inr(n(buyM?.v))}
            sub={`${formatNum(n(buyM?.qty))} MT · ${n(buyM?.cnt)} invoices`}
            icon={ShoppingCart}
            tone="bg-sky-100 text-sky-700"
            onClick={() => onNavigate('orders')}
          />}
          {on('m.sell') && <Kpi
            label="Sales this month"
            value={inr(n(sellM?.v))}
            sub={`${formatNum(n(sellM?.qty))} MT · ${n(sellM?.cnt)} invoices`}
            icon={Tag}
            tone="bg-emerald-100 text-emerald-700"
            onClick={() => onNavigate('sales')}
          />}
          {on('m.pay') && <Kpi
            label="Payable to suppliers"
            value={inr(payables.reduce((s, x) => s + x.v, 0))}
            sub={`${payables.length} parties with balances`}
            icon={Landmark}
            tone="bg-rose-100 text-rose-700"
            onClick={() => onNavigate('accounts')}
          />}
          {on('m.rec') && <Kpi
            label="Receivable from customers"
            value={inr(receivables.reduce((s, x) => s + x.v, 0))}
            sub={`${receivables.length} parties with balances`}
            icon={Scale}
            tone="bg-indigo-100 text-indigo-700"
            onClick={() => onNavigate('accounts')}
          />}
        </div>
        )}

        {/* Trend row */}
        {(on('m.chart') || on('m.sparkBuy') || on('m.sparkSell')) && (
        <div className={cn('grid gap-3', on('m.chart') && (on('m.sparkBuy') || on('m.sparkSell')) && 'lg:grid-cols-3')}>
          {on('m.chart') && (
          <Card className={cn('p-4', (on('m.sparkBuy') || on('m.sparkSell')) && 'lg:col-span-2')}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">Purchases vs sales — last 6 months</span>
              <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-600" /> Purchases</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> Sales</span>
              </span>
            </div>
            <PairedBars months={months} />
          </Card>
          )}
          {(on('m.sparkBuy') || on('m.sparkSell')) && (
          <Card className="space-y-3 p-4">
            {on('m.sparkBuy') && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1 font-medium"><ArrowDownRight className="h-3.5 w-3.5 text-sky-600" /> Purchases · 30 days</span>
                <span className="tabular-nums text-muted-foreground">
                  {inr(((stats?.purchaseDays as Row[]) || []).reduce((s, x) => s + n(x.v), 0))}
                </span>
              </div>
              <Spark days={((stats?.purchaseDays as Row[]) || []) as { d: string; v: number }[]} tone="sky" />
            </div>
            )}
            {on('m.sparkSell') && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1 font-medium"><ArrowUpRight className="h-3.5 w-3.5 text-emerald-600" /> Sales · 30 days</span>
                <span className="tabular-nums text-muted-foreground">
                  {inr(((stats?.saleDays as Row[]) || []).reduce((s, x) => s + n(x.v), 0))}
                </span>
              </div>
              <Spark days={((stats?.saleDays as Row[]) || []) as { d: string; v: number }[]} tone="emerald" />
            </div>
            )}
          </Card>
          )}
        </div>
        )}

        {/* Parties + books */}
        {PARTY_ROW.some(on) && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${PARTY_ROW.filter(on).length},minmax(0,1fr))` }}>
          {on('m.topSup') && (
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Top suppliers by value</div>
            <RankBars rows={((stats?.topSuppliers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))} />
          </Card>
          )}
          {on('m.topCus') && (
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Top customers by value</div>
            <RankBars rows={((stats?.topCustomers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))} />
          </Card>
          )}
          {on('m.duties') && (
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Duties &amp; taxes (books)</div>
            <div className="space-y-2 text-[13px]">
              {[
                { l: 'TDS payable', v: -duty('TDS PAYABLE A/C'), hint: 'to deposit' },
                { l: 'GST input credit', v: duty('GST INPUT A/C'), hint: 'claimable' },
                { l: 'GST output', v: -duty('GST OUTPUT A/C'), hint: 'collected on sales' },
                { l: 'GST net position', v: duty('GST INPUT A/C') + duty('GST OUTPUT A/C'), hint: 'input − output' }
              ].map((x) => (
                <div key={x.l} className="flex items-baseline justify-between border-b border-dotted pb-1.5 last:border-0">
                  <span>
                    {x.l} <span className="text-[10px] text-muted-foreground">({x.hint})</span>
                  </span>
                  <span className="font-semibold tabular-nums">{inr(x.v)}</span>
                </div>
              ))}
              <button
                type="button"
                className="cursor-pointer pt-1 text-[11px] font-medium text-indigo-600 hover:underline"
                onClick={() => onNavigate('accounts')}
              >
                Open Trial Balance →
              </button>
            </div>
          </Card>
          )}
        </div>
        )}

        {/* Stock + operations */}
        {OPS_ROW.some(on) && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${OPS_ROW.filter(on).length},minmax(0,1fr))` }}>
          {on('m.stock') && (
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Book stock by category</span>
              <Warehouse className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-2 text-[13px]">
              {(['raw', 'intermediate', 'finished'] as const).map((c) => (
                <div key={c} className="flex items-baseline justify-between border-b border-dotted pb-1.5 last:border-0">
                  <span className="capitalize">{c} <span className="text-[10px] text-muted-foreground">({cats[c]?.products || 0} products)</span></span>
                  <span className={cn('font-semibold tabular-nums', (cats[c]?.qty || 0) < 0 && 'text-red-600')}>
                    {formatNum(cats[c]?.qty || 0)} MT
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between pt-1">
                <span>MNC / consignment deposited</span>
                <span className="font-semibold tabular-nums">{formatNum(n(stats?.consignmentBalance))} MT</span>
              </div>
              <button
                type="button"
                className="cursor-pointer pt-1 text-[11px] font-medium text-indigo-600 hover:underline"
                onClick={() => onNavigate('stock')}
              >
                Open Stock →
              </button>
            </div>
          </Card>
          )}

          {on('m.exposure') && (
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Open exposure</span>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-2 text-[13px]">
              <button
                type="button"
                onClick={() => {
                  // Every category — the register opens on OIL otherwise.
                  setPageIntent('bargains', { category: 'ALL' })
                  onNavigate('bargains')
                }}
                className="flex w-full cursor-pointer items-baseline justify-between border-b border-dotted pb-1.5 text-left hover:text-primary"
              >
                <span>Purchase bargains open</span>
                <span className="font-semibold tabular-nums">
                  {n((stats?.purBargains as Row)?.cnt)} · {formatNum(n((stats?.purBargains as Row)?.qty))} MT
                </span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('salesBargains')}
                className="flex w-full cursor-pointer items-baseline justify-between border-b border-dotted pb-1.5 text-left hover:text-primary"
              >
                <span>Sales bargains open</span>
                <span className="font-semibold tabular-nums">
                  {n((stats?.saleBargains as Row)?.cnt)} · {formatNum(n((stats?.saleBargains as Row)?.qty))} MT
                </span>
              </button>
              <div className="pt-1">
                <div className="mb-1 flex items-center gap-1 text-[12px] font-medium"><Truck className="h-3.5 w-3.5" /> Tankers on the move</div>
                {(((stats?.tankers as Row[]) || []).length === 0 && (
                  <p className="text-xs text-muted-foreground">None in transit.</p>
                )) ||
                  ((stats?.tankers as Row[]) || []).map((t) => (
                    <button
                      key={String(t.status)}
                      type="button"
                      onClick={() => onNavigate('orders')}
                      className="flex w-full cursor-pointer items-baseline justify-between text-left text-[12.5px] hover:text-primary"
                    >
                      <span>{STATUS_LABEL[String(t.status)] || t.status}</span>
                      <span className="font-semibold tabular-nums">{n(t.cnt)}</span>
                    </button>
                  ))}
              </div>
            </div>
          </Card>
          )}

          {on('m.attention') && (
          <Card className={cn('p-4', negatives.length && 'border-red-300 bg-red-50/40')}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Attention</span>
              <AlertTriangle className={cn('h-4 w-4', negatives.length ? 'text-red-500' : 'text-muted-foreground')} />
            </div>
            {negatives.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing negative — the books look healthy.</p>
            ) : (
              <div className="space-y-1.5 text-[13px]">
                <p className="text-[11px] text-red-700">
                  {negatives.length} product{negatives.length > 1 ? 's' : ''} dispatched or consumed beyond booked stock —
                  production entries are probably missing.
                </p>
                {negatives.slice(0, 5).map((x) => (
                  <div key={String(x.name)} className="flex items-baseline justify-between">
                    <span className="flex items-center gap-1"><Droplets className="h-3 w-3 text-red-400" /> {x.name}</span>
                    <span className="font-semibold tabular-nums text-red-600">{formatNum(x.stock)} MT</span>
                  </div>
                ))}
                <button
                  type="button"
                  className="cursor-pointer pt-1 text-[11px] font-medium text-red-700 hover:underline"
                  onClick={() => onNavigate('production')}
                >
                  Record production →
                </button>
              </div>
            )}
          </Card>
          )}
        </div>
        )}

        {/* Treasury watch */}
        {on('m.treasury') && treasury && (((treasury.lcExpiring as Row[]) || []).length > 0 || ((treasury.lcBillsDue as Row[]) || []).length > 0 || ((treasury.billsDue as Row[]) || []).length > 0) && (
          <Card className={cn('p-4', n(treasury.overdue) > 0 && 'border-red-300 bg-red-50/40')}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Treasury watch — LCs &amp; discounted bills</span>
              <button type="button" className="cursor-pointer text-[11px] font-medium text-indigo-600 hover:underline" onClick={() => onNavigate('treasury')}>
                Open Treasury →
              </button>
            </div>
            <div className="grid gap-2 text-[12.5px] sm:grid-cols-3">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">LCs expiring</div>
                {((treasury.lcExpiring as Row[]) || []).slice(0, 3).map((l) => (
                  <div key={String(l.id)} className="flex justify-between gap-2"><span className="truncate">{l.lc_no} · {l.bank}</span><span className="shrink-0 tabular-nums">{l.days_left < 0 ? 'expired' : `${l.days_left}d`}</span></div>
                ))}
                {((treasury.lcExpiring as Row[]) || []).length === 0 && <span className="text-muted-foreground">none</span>}
              </div>
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-sky-700">LC bills maturing</div>
                {((treasury.lcBillsDue as Row[]) || []).slice(0, 3).map((b) => (
                  <div key={String(b.id)} className="flex justify-between gap-2"><span className="truncate">{b.lc_no} {b.bill_no || ''}</span><span className={cn('shrink-0 tabular-nums', b.days_left < 0 && 'font-semibold text-red-600')}>{b.days_left < 0 ? `${-b.days_left}d late` : `${b.days_left}d`}</span></div>
                ))}
                {((treasury.lcBillsDue as Row[]) || []).length === 0 && <span className="text-muted-foreground">none</span>}
              </div>
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-indigo-700">Discounted bills due</div>
                {((treasury.billsDue as Row[]) || []).slice(0, 3).map((b) => (
                  <div key={String(b.id)} className="flex justify-between gap-2"><span className="truncate">{b.bill_nos || ''} {b.party_name || ''}</span><span className={cn('shrink-0 tabular-nums', b.days_left < 0 && 'font-semibold text-red-600')}>{b.days_left < 0 ? `${-b.days_left}d late` : `${b.days_left}d`}</span></div>
                ))}
                {((treasury.billsDue as Row[]) || []).length === 0 && <span className="text-muted-foreground">none</span>}
              </div>
            </div>
          </Card>
        )}

        {/* Payables / receivables detail */}
        {on('m.balances') && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Largest supplier balances (payable)</div>
            <RankBars rows={payables} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Largest customer balances (receivable)</div>
            <RankBars rows={receivables} />
          </Card>
        </div>
        )}
      </div>
      {customizing && (
        <DashCustomize t={DASH_THEMES.light} dark={false} isMobile={false} layout={layout} onClose={() => setCustomizing(false)} />
      )}
    </>
  )
}
