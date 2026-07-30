import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Droplets,
  FileText,
  Landmark,
  RefreshCw,
  Scale,
  ShoppingCart,
  Tag,
  Truck,
  Warehouse
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import type { Page } from '@/components/Sidebar'
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

export function Dashboard({ onNavigate }: Props): React.JSX.Element {
  const [stats, setStats] = useState<Row | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async () => {
    setChecking(true)
    try {
      setStats(await window.api.dashboard.stats())
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])
  useLiveRefresh(refresh)

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

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Money, stock and movement at a glance for the active company"
        hint="Every card is live and most are clickable — they take you to the page where the underlying entries live. Payables and receivables come straight from the double-entry books, so they agree with the Trial Balance in Accounting."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      <div className="space-y-4 px-4 py-4">
        {/* KPI row */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label="Purchases this month"
            value={inr(n(buyM?.v))}
            sub={`${formatNum(n(buyM?.qty))} MT · ${n(buyM?.cnt)} invoices`}
            icon={ShoppingCart}
            tone="bg-sky-100 text-sky-700"
            onClick={() => onNavigate('orders')}
          />
          <Kpi
            label="Sales this month"
            value={inr(n(sellM?.v))}
            sub={`${formatNum(n(sellM?.qty))} MT · ${n(sellM?.cnt)} invoices`}
            icon={Tag}
            tone="bg-emerald-100 text-emerald-700"
            onClick={() => onNavigate('sales')}
          />
          <Kpi
            label="Payable to suppliers"
            value={inr(payables.reduce((s, x) => s + x.v, 0))}
            sub={`${payables.length} parties with balances`}
            icon={Landmark}
            tone="bg-rose-100 text-rose-700"
            onClick={() => onNavigate('accounts')}
          />
          <Kpi
            label="Receivable from customers"
            value={inr(receivables.reduce((s, x) => s + x.v, 0))}
            sub={`${receivables.length} parties with balances`}
            icon={Scale}
            tone="bg-indigo-100 text-indigo-700"
            onClick={() => onNavigate('accounts')}
          />
        </div>

        {/* Trend row */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-4 lg:col-span-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">Purchases vs sales — last 6 months</span>
              <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-sky-600" /> Purchases</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> Sales</span>
              </span>
            </div>
            <PairedBars months={months} />
          </Card>
          <Card className="space-y-3 p-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1 font-medium"><ArrowDownRight className="h-3.5 w-3.5 text-sky-600" /> Purchases · 30 days</span>
                <span className="tabular-nums text-muted-foreground">
                  {inr(((stats?.purchaseDays as Row[]) || []).reduce((s, x) => s + n(x.v), 0))}
                </span>
              </div>
              <Spark days={((stats?.purchaseDays as Row[]) || []) as { d: string; v: number }[]} tone="sky" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1 font-medium"><ArrowUpRight className="h-3.5 w-3.5 text-emerald-600" /> Sales · 30 days</span>
                <span className="tabular-nums text-muted-foreground">
                  {inr(((stats?.saleDays as Row[]) || []).reduce((s, x) => s + n(x.v), 0))}
                </span>
              </div>
              <Spark days={((stats?.saleDays as Row[]) || []) as { d: string; v: number }[]} tone="emerald" />
            </div>
          </Card>
        </div>

        {/* Parties + books */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Top suppliers by value</div>
            <RankBars rows={((stats?.topSuppliers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Top customers by value</div>
            <RankBars rows={((stats?.topCustomers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))} />
          </Card>
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
        </div>

        {/* Stock + operations */}
        <div className="grid gap-3 lg:grid-cols-3">
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

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Open exposure</span>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-2 text-[13px]">
              <div className="flex items-baseline justify-between border-b border-dotted pb-1.5">
                <span>Purchase bargains open</span>
                <span className="font-semibold tabular-nums">
                  {n((stats?.purBargains as Row)?.cnt)} · {formatNum(n((stats?.purBargains as Row)?.qty))} MT
                </span>
              </div>
              <div className="flex items-baseline justify-between border-b border-dotted pb-1.5">
                <span>Sales bargains open</span>
                <span className="font-semibold tabular-nums">
                  {n((stats?.saleBargains as Row)?.cnt)} · {formatNum(n((stats?.saleBargains as Row)?.qty))} MT
                </span>
              </div>
              <div className="pt-1">
                <div className="mb-1 flex items-center gap-1 text-[12px] font-medium"><Truck className="h-3.5 w-3.5" /> Tankers on the move</div>
                {(((stats?.tankers as Row[]) || []).length === 0 && (
                  <p className="text-xs text-muted-foreground">None in transit.</p>
                )) ||
                  ((stats?.tankers as Row[]) || []).map((t) => (
                    <div key={String(t.status)} className="flex items-baseline justify-between text-[12.5px]">
                      <span>{STATUS_LABEL[String(t.status)] || t.status}</span>
                      <span className="font-semibold tabular-nums">{n(t.cnt)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </Card>

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
        </div>

        {/* Payables / receivables detail */}
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
      </div>
    </>
  )
}
