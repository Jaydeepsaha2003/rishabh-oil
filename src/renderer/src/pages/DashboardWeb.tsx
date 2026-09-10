// The website's dashboard — desktop and phone.
// -----------------------------------------------------------------------------
// Built to the handoff. Every figure on it is real: Dashboard.tsx already reads
// dashboard:stats and treasury:alerts, and this component only renders what it
// derived — nothing here is a placeholder or a demo series. The three panels
// the design shows that the API does not answer (a per-KPI month-on-month
// trend, an axis scale, and the sparkline day labels) are computed here from
// the same rows rather than invented.
//
// It takes the derived values as props instead of loading again. One data path,
// one refresh, and the Electron build keeps the render it has — see the
// __WEB__ fork at the bottom of Dashboard.tsx.
import React, { useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Contact,
  Droplets,
  Factory,
  Landmark,
  Minus,
  Moon,
  Receipt,
  RefreshCw,
  ShoppingCart,
  Sun,
  Tag,
  Truck,
  Warehouse,
  type LucideIcon
} from 'lucide-react'
import { MobileBar } from '@/components/MobileBar'
import type { Page } from '@/components/Sidebar'
import { useCompany } from '@/lib/companyContext'
import { DASH_KEYFRAMES, DASH_THEMES, storeDashTheme, storedDashTheme, type DashTheme } from '@/lib/dashTheme'
import { formatNum } from '@/lib/format'
import { useIsMobile } from '@/lib/useIsMobile'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Crore for anything over a lakh, lakh below that. The dashboard is read at a
// glance and eight digits of rupees cannot be.
function money(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
const crore = (v: number): string => (v / 1e7).toFixed(2)

function monthLabel(m: string): string {
  const [y, mm] = String(m || '').split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return mm ? `${names[Number(mm) - 1]} ${String(y).slice(2)}` : String(m)
}

export type DashProps = {
  stats: Row | null
  treasury: Row | null
  months: { m: string; buy: number; sell: number }[]
  payables: { name: string; v: number }[]
  receivables: { name: string; v: number }[]
  duty: (name: string) => number
  negatives: Row[]
  cats: Record<string, { qty: number; products: number }>
  buyM: Row | undefined
  sellM: Row | undefined
  checking: boolean
  onRefresh: () => void | Promise<void>
  onNavigate: (p: Page) => void
}

export function DashboardWeb(props: DashProps): React.JSX.Element {
  const { stats, treasury, months, payables, receivables, duty, negatives, cats, buyM, sellM, checking } = props
  const isMobile = useIsMobile()
  const { companies, companyId } = useCompany()
  const [theme, setTheme] = useState<'dark' | 'light'>(storedDashTheme)
  const t: DashTheme = DASH_THEMES[theme]

  function flip(v: 'dark' | 'light'): void {
    setTheme(v)
    storeDashTheme(v)
  }

  const activeCompany = companies.find((c) => Number(c.id) === Number(companyId))
  const todayLabel = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  const payTotal = payables.reduce((s, x) => s + x.v, 0)
  const recTotal = receivables.reduce((s, x) => s + x.v, 0)

  // Month on month, from the same series the chart draws. The design shows a
  // trend chip on every KPI; only purchases and sales have a previous month to
  // compare against, so the other two say what they are instead of inventing a
  // percentage.
  const prev = months.length >= 2 ? months[months.length - 2] : null
  const pct = (now: number, before: number): number | null =>
    before > 0 ? ((now - before) / before) * 100 : null
  const buyTrend = pct(n(buyM?.v), n(prev?.buy))
  const sellTrend = pct(n(sellM?.v), n(prev?.sell))

  const maxMonth = Math.max(1, ...months.flatMap((x) => [x.buy, x.sell]))

  type Kpi = {
    key: string
    label: string
    short: string
    value: string
    sub: string
    icon: LucideIcon
    fg: string
    glow: string
    trend: number | null
    page: Page
  }
  const kpis: Kpi[] = [
    {
      key: 'buy',
      label: 'Purchases this month',
      short: 'Purchases',
      value: money(n(buyM?.v)),
      sub: `${formatNum(n(buyM?.qty))} MT · ${n(buyM?.cnt)} invoices`,
      icon: ShoppingCart,
      fg: t.blue,
      glow: theme === 'dark' ? 'rgba(127,178,232,.22)' : 'rgba(78,140,203,.14)',
      trend: buyTrend,
      page: 'orders'
    },
    {
      key: 'sell',
      label: 'Sales this month',
      short: 'Sales',
      value: money(n(sellM?.v)),
      sub: `${formatNum(n(sellM?.qty))} MT · ${n(sellM?.cnt)} invoices`,
      icon: Tag,
      fg: t.accent,
      glow: theme === 'dark' ? 'rgba(199,240,63,.2)' : 'rgba(143,184,36,.18)',
      trend: sellTrend,
      page: 'sales'
    },
    {
      key: 'pay',
      label: 'Payable to suppliers',
      short: 'Payable',
      value: money(payTotal),
      sub: `${payables.length} ${payables.length === 1 ? 'party' : 'parties'} with balances`,
      icon: Landmark,
      fg: t.red,
      glow: theme === 'dark' ? 'rgba(240,175,170,.18)' : 'rgba(179,38,30,.1)',
      trend: null,
      page: 'accounts'
    },
    {
      key: 'rec',
      label: 'Receivable from customers',
      short: 'Receivable',
      value: money(recTotal),
      sub: `${receivables.length} ${receivables.length === 1 ? 'party' : 'parties'} with balances`,
      icon: Contact,
      fg: t.green,
      glow: theme === 'dark' ? 'rgba(159,227,191,.18)' : 'rgba(11,107,69,.1)',
      trend: null,
      page: 'accounts'
    }
  ]

  // The 30-day strips. The API gives one row per day that had activity, so the
  // gaps are filled here — a sparkline with the quiet days missing compresses
  // the busy ones together and reads as steadier than the month was.
  const sparkDays = useMemo(() => {
    const build = (rows: Row[]): { d: string; v: number }[] => {
      const by = new Map<string, number>()
      for (const r of rows) by.set(String(r.d).slice(0, 10), n(r.v))
      const out: { d: string; v: number }[] = []
      const day = new Date()
      day.setDate(day.getDate() - 29)
      for (let i = 0; i < 30; i++) {
        const p2 = (x: number): string => String(x).padStart(2, '0')
        const iso = `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}`
        out.push({ d: iso, v: by.get(iso) || 0 })
        day.setDate(day.getDate() + 1)
      }
      return out
    }
    return {
      buy: build((stats?.purchaseDays as Row[]) || []),
      sell: build((stats?.saleDays as Row[]) || [])
    }
  }, [stats])

  const sparks = [
    {
      key: 'buy',
      label: 'Purchases · 30 days',
      icon: ShoppingCart,
      fg: t.blue,
      barBg: t.sparkBuy,
      days: sparkDays.buy,
      total: money(sparkDays.buy.reduce((s, x) => s + x.v, 0))
    },
    {
      key: 'sell',
      label: 'Sales · 30 days',
      icon: Tag,
      fg: t.accent,
      barBg: t.sparkSell,
      days: sparkDays.sell,
      total: money(sparkDays.sell.reduce((s, x) => s + x.v, 0))
    }
  ]

  const rankCards = [
    {
      key: 'sup',
      title: 'Top suppliers',
      icon: Building2,
      fg: t.blue,
      barBg: t.rankBuy,
      rows: ((stats?.topSuppliers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))
    },
    {
      key: 'cus',
      title: 'Top customers',
      icon: Contact,
      fg: t.accent,
      barBg: t.rankSell,
      rows: ((stats?.topCustomers as Row[]) || []).map((x) => ({ name: String(x.name), v: n(x.v) }))
    }
  ]

  const duties = [
    { label: 'TDS payable', hint: 'withheld, not yet paid', value: duty('TDS PAYABLE A/C'), fg: t.amber },
    { label: 'GST input', hint: 'credit available', value: duty('GST INPUT A/C'), fg: t.blue },
    { label: 'GST output', hint: 'collected on sales', value: duty('GST OUTPUT A/C'), fg: t.violet },
    {
      label: 'Net GST',
      hint: 'output less input',
      value: duty('GST OUTPUT A/C') - duty('GST INPUT A/C'),
      fg: t.accent
    }
  ]

  const stockCats = Object.entries(cats)
    .filter(([, v]) => Math.abs(v.qty) > 1e-9)
    .sort((a, b) => Math.abs(b[1].qty) - Math.abs(a[1].qty))
  const maxCat = Math.max(1, ...stockCats.map(([, v]) => Math.abs(v.qty)))

  const tankerRows = ((stats?.tankers as Row[]) || []).map((x) => ({
    label: String(x.status || '—').replace(/_/g, ' '),
    count: n(x.cnt)
  }))
  const purBg = (stats?.purBargains as Row) || {}
  const saleBg = (stats?.saleBargains as Row) || {}
  const exposure = [
    { label: 'Purchase bargains open', v: `${n(purBg.cnt)} · ${formatNum(n(purBg.qty))} MT` },
    { label: 'Sales bargains open', v: `${n(saleBg.cnt)} · ${formatNum(n(saleBg.qty))} MT` }
  ]

  const treasuryCards = [
    {
      key: 'lc',
      title: 'LCs expiring',
      fg: t.amber,
      rows: ((treasury?.lcExpiring as Row[]) || []).slice(0, 3).map((l) => ({
        name: `${String(l.lc_no || '')} · ${String(l.bank || '')}`,
        days: n(l.days_left) < 0 ? 'expired' : `${n(l.days_left)}d`,
        late: n(l.days_left) < 0
      }))
    },
    {
      key: 'lcb',
      title: 'LC bills maturing',
      fg: t.blue,
      rows: ((treasury?.lcBillsDue as Row[]) || []).slice(0, 3).map((b) => ({
        name: `${String(b.lc_no || '')} ${String(b.bill_no || '')}`.trim(),
        days: n(b.days_left) < 0 ? `${-n(b.days_left)}d late` : `${n(b.days_left)}d`,
        late: n(b.days_left) < 0
      }))
    },
    {
      key: 'bd',
      title: 'Discounted bills due',
      fg: t.violet,
      rows: ((treasury?.billsDue as Row[]) || []).slice(0, 3).map((b) => ({
        name: `${String(b.bill_nos || '')} ${String(b.party_name || '')}`.trim(),
        days: n(b.days_left) < 0 ? `${-n(b.days_left)}d late` : `${n(b.days_left)}d`,
        late: n(b.days_left) < 0
      }))
    }
  ]

  // ------------------------------------------------------------- fragments --
  const Sheen = (): React.JSX.Element => (
    <span className="pointer-events-none absolute inset-0 overflow-hidden">
      <span
        className="absolute bottom-0 top-0 w-[70px]"
        style={{ background: t.sheen, animation: 'dash-sheen 7s ease-in-out infinite' }}
      />
    </span>
  )

  const TrendChip = ({ v }: { v: number | null }): React.JSX.Element => {
    if (v == null) {
      return (
        <span
          className="doc-ref inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-bold"
          style={{ color: t.faint, background: t.track }}
        >
          <Minus className="h-3.5 w-3.5" />
          from the books
        </span>
      )
    }
    const up = v >= 0
    const Ico = up ? ArrowUpRight : ArrowDownRight
    return (
      <span
        className="doc-ref inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-bold"
        style={{
          color: up ? t.green : t.red,
          background: up ? 'rgba(18,133,90,.14)' : 'rgba(179,38,30,.13)'
        }}
      >
        <Ico className="h-3.5 w-3.5" />
        {Math.abs(v) >= 999 ? '>999%' : `${up ? '+' : ''}${v.toFixed(0)}%`}
      </span>
    )
  }

  const Card = ({
    children,
    className,
    style
  }: {
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
  }): React.JSX.Element => (
    <div
      className={className}
      style={{ background: t.card, border: `1px solid ${t.bd}`, boxShadow: t.shadow, borderRadius: 6, ...style }}
    >
      {children}
    </div>
  )

  const CardHead = ({
    icon: Ico,
    title,
    fg,
    right
  }: {
    icon: LucideIcon
    title: string
    fg: string
    right?: React.ReactNode
  }): React.JSX.Element => (
    <div className="flex flex-none items-center gap-[9px]">
      <Ico className="h-[18px] w-[18px] flex-none" style={{ color: fg }} />
      <span className="min-w-0 flex-1 text-[12.5px] font-extrabold">{title}</span>
      {right}
    </div>
  )

  const Deeper = ({ label, page, fg }: { label: string; page: Page; fg: string }): React.JSX.Element => (
    <button
      type="button"
      onClick={() => props.onNavigate(page)}
      className="mt-[11px] flex flex-none items-center gap-1.5 text-[11px] font-extrabold tracking-[.04em] hover:underline"
      style={{ color: fg }}
    >
      {label}
      <ArrowRight className="h-4 w-4" />
    </button>
  )

  const MonthChart = ({ height, barW, gap, labels }: { height: number; barW: number; gap: number; labels: boolean }): React.JSX.Element => (
    <div
      className="relative flex w-full items-end justify-between"
      style={{ height, borderBottom: `1px solid ${t.axis}`, transformStyle: 'preserve-3d' }}
    >
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <span
          key={f}
          className="pointer-events-none absolute left-0 right-0"
          style={{ bottom: `${f * 100}%`, height: 1, background: t.gridline }}
        />
      ))}
      {months.length === 0 && (
        <span className="w-full text-center text-[11.5px] font-semibold" style={{ color: t.faint }}>
          No purchases or sales yet.
        </span>
      )}
      {months.map((m, mi) => (
        <div key={m.m} className="flex min-w-0 flex-1 flex-col items-center gap-[9px]" style={{ transformStyle: 'preserve-3d' }}>
          <div className="flex w-full items-end justify-center" style={{ gap, height: height - 42, transformStyle: 'preserve-3d' }}>
            {([
              { k: 'buy', v: m.buy, face: t.barBuyFace, top: t.barBuyTop, side: t.barBuySide, fg: t.blue },
              { k: 'sell', v: m.sell, face: t.barSellFace, top: t.barSellTop, side: t.barSellSide, fg: t.accent }
            ] as const).map((b, bi) => {
              const h = Math.max(v0(b.v), (b.v / maxMonth) * (height - 52))
              return (
                <div
                  key={b.k}
                  title={`${monthLabel(m.m)} ${b.k === 'buy' ? 'purchases' : 'sales'} — ${money(b.v)}`}
                  className="relative"
                  style={{
                    width: barW,
                    height: h,
                    transformStyle: 'preserve-3d',
                    transition: `height .9s cubic-bezier(.2,.8,.25,1) ${(mi * 2 + bi) * 55}ms`
                  }}
                >
                  <span className="absolute inset-0 rounded-t-[2px]" style={{ background: b.face, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.25)' }} />
                  <span
                    className="absolute left-0 right-0 top-0 rounded-[2px]"
                    style={{ height: Math.min(11, barW / 2.4), background: b.top, transform: 'rotateX(72deg)', transformOrigin: 'top' }}
                  />
                  <span
                    className="absolute bottom-0 right-0 top-0"
                    style={{ width: Math.min(11, barW / 2.4), background: b.side, transform: 'rotateY(72deg)', transformOrigin: 'right' }}
                  />
                  {labels && b.v > 0 && (
                    <span
                      className="doc-ref absolute left-0 right-0 whitespace-nowrap text-center text-[10px] font-bold"
                      style={{ top: -22, color: b.fg }}
                    >
                      {crore(b.v)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {labels ? (
            <span className="whitespace-nowrap text-[10.5px] font-extrabold tracking-[.06em]" style={{ color: t.muted }}>
              {monthLabel(m.m)}
            </span>
          ) : (
            <span className="whitespace-nowrap text-[9.5px] font-extrabold" style={{ color: t.muted }}>
              {monthLabel(m.m).split(' ')[0]}
            </span>
          )}
        </div>
      ))}
    </div>
  )

  const Spark = ({ sp, height }: { sp: (typeof sparks)[number]; height: number }): React.JSX.Element => {
    const max = Math.max(1, ...sp.days.map((d) => d.v))
    return (
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {sp.days.map((d, i) => (
          <span
            key={d.d}
            title={`${d.d} — ${money(d.v)}`}
            className="min-w-0 flex-1 rounded-t-[1px]"
            style={{
              height: d.v > 0 ? `${Math.max(6, (d.v / max) * 100)}%` : 2,
              background: d.v > 0 ? sp.barBg : t.track,
              transition: `height .8s cubic-bezier(.2,.8,.25,1) ${i * 18}ms`
            }}
          />
        ))}
      </div>
    )
  }

  const Attention = ({ compact }: { compact?: boolean }): React.JSX.Element => (
    <div
      className="relative flex flex-col overflow-hidden"
      style={{
        borderRadius: compact ? 5 : 6,
        background: `linear-gradient(160deg,${t.redBgA},${t.redBgB})`,
        border: `1px solid ${t.redBd}`,
        boxShadow: t.shadow,
        padding: compact ? '13px 14px' : '15px 17px'
      }}
    >
      <span
        className="pointer-events-none absolute left-0 right-0 top-0"
        style={{ height: 70, background: `linear-gradient(180deg,${t.redScan},transparent)`, animation: 'dash-scan 6s linear infinite' }}
      />
      <div className="relative flex flex-none items-center gap-[9px]">
        <Droplets className="h-[19px] w-[19px] flex-none" style={{ color: t.red }} />
        <span className="min-w-0 flex-1 text-[12.5px] font-extrabold">Attention</span>
        <span
          className="doc-ref rounded-full px-[9px] py-[3px] text-[11px] font-extrabold"
          style={{ color: t.onRed, background: t.red }}
        >
          {negatives.length}
        </span>
      </div>
      <div className="relative mt-2.5 text-[11.5px] font-semibold leading-[1.5]" style={{ color: t.redSoft }}>
        {negatives.length === 0
          ? 'No product is below nil. Every balance the register carries is one it can account for.'
          : 'A product below nil means more has gone out than was ever booked in — usually production that has not been recorded, or an opening balance still to be struck.'}
      </div>
      <div className="relative mt-3 flex flex-1 flex-col gap-2">
        {negatives.slice(0, compact ? 4 : 5).map((ng) => (
          <div key={String(ng.name)} className="flex items-center gap-[9px]">
            <Droplets className="h-[15px] w-[15px] flex-none" style={{ color: t.red }} />
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold" style={{ color: t.redSoft }}>
              {String(ng.name)}
            </span>
            <span className="doc-ref flex-none text-[12px] font-bold" style={{ color: t.red }}>
              {formatNum(n(ng.stock))} MT
            </span>
          </div>
        ))}
      </div>
      {negatives.length > 0 && <Deeper label="Record production" page="production" fg={t.red} />}
    </div>
  )

  // Phone. After every hook, so the order cannot change between renders.
  if (isMobile) {
    return (
      <div className="dash-anim relative flex min-h-[100dvh] flex-col" style={{ background: t.page, color: t.ink }}>
        <style>{DASH_KEYFRAMES}</style>
        <span
          className="pointer-events-none absolute"
          style={{
            top: -120,
            right: -90,
            width: 380,
            height: 380,
            borderRadius: '50%',
            background: `radial-gradient(circle,${t.haloA},transparent 68%)`,
            animation: 'dash-halo 9s ease-in-out infinite'
          }}
        />
        {/* The shared strip first — menu, company, refresh in the same place
            as every other mobile page — then the dashboard's own title row.
            Both sit on forest so they read as one header. */}
        <div className="relative z-[1] flex-none bg-[#0B3D2E] px-4 pb-3.5 pt-2.5">
          <MobileBar onRefresh={props.onRefresh} />
          <div className="flex items-end justify-between gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[21px] font-extrabold tracking-[-0.03em] text-white">Dashboard</div>
              <div className="mt-[5px] flex items-center gap-[7px]">
                <span className="inline-flex flex-none items-center gap-[5px] rounded-full border border-[#C7F03F]/40 bg-[#C7F03F]/[.14] px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#C7F03F]">
                  <span
                    className="h-[5px] w-[5px] rounded-full bg-[#C7F03F]"
                    style={{ animation: 'dash-pulse 2s ease-in-out infinite' }}
                  />
                  Live
                </span>
                <span className="doc-ref min-w-0 truncate text-[11px] font-bold text-white/65">as at {todayLabel}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => flip(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} board`}
              className="flex h-10 w-10 flex-none items-center justify-center rounded-[4px] bg-white/[.12] text-[#C7F03F] active:bg-white/25"
            >
              {theme === 'dark' ? <Sun className="h-[21px] w-[21px]" /> : <Moon className="h-[21px] w-[21px]" />}
            </button>
          </div>
        </div>

        <div className="relative z-[1] flex flex-1 flex-col gap-[11px] overflow-y-auto px-4 pb-[96px] pt-0.5">
          <div className="grid flex-none grid-cols-2 gap-2.5">
            {kpis.map((k) => {
              const Ico = k.icon
              return (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => props.onNavigate(k.page)}
                  className="relative overflow-hidden px-[13px] py-3 text-left"
                  style={{ borderRadius: 5, background: t.card, border: `1px solid ${t.bd}`, boxShadow: t.shadow }}
                >
                  <span
                    className="pointer-events-none absolute"
                    style={{ top: -34, right: -34, width: 100, height: 100, borderRadius: '50%', background: `radial-gradient(circle,${k.glow},transparent 70%)` }}
                  />
                  <span className="relative flex items-center gap-[7px]">
                    <Ico className="h-4 w-4 flex-none" style={{ color: k.fg }} />
                    <span
                      className="min-w-0 text-[8.5px] font-extrabold uppercase leading-[1.3] tracking-[.11em]"
                      style={{ color: t.muted }}
                    >
                      {k.short}
                    </span>
                  </span>
                  <span className="doc-ref relative mt-2 block text-[19px] font-bold tracking-[-0.035em]" style={{ color: t.ink }}>
                    {k.value}
                  </span>
                  <span className="relative mt-[7px] block">
                    <TrendChip v={k.trend} />
                  </span>
                </button>
              )
            })}
          </div>

          <Card className="flex-none overflow-hidden px-3.5 pb-2 pt-3.5" style={{ borderRadius: 5 }}>
            <div className="flex items-start justify-between gap-2.5">
              <div className="min-w-0 flex-1">
                <div className="whitespace-nowrap text-[12.5px] font-extrabold">Purchases vs sales</div>
                <div className="mt-[3px] text-[10.5px] font-semibold" style={{ color: t.muted }}>
                  6 months · ₹ crore
                </div>
              </div>
              <div className="flex flex-none flex-col items-end gap-[5px]">
                <span className="inline-flex items-center gap-[5px] text-[10px] font-bold" style={{ color: t.blue }}>
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: t.barBuyTop }} />
                  Buy
                </span>
                <span className="inline-flex items-center gap-[5px] text-[10px] font-bold" style={{ color: t.accent }}>
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: t.barSellTop }} />
                  Sell
                </span>
              </div>
            </div>
            <div className="mt-1 overflow-hidden" style={{ perspective: 700 }}>
              <MonthChart height={158} barW={13} gap={4} labels={false} />
            </div>
          </Card>

          {sparks.map((sp) => {
            const Ico = sp.icon
            return (
              <Card key={sp.key} className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Ico className="h-[17px] w-[17px] flex-none" style={{ color: sp.fg }} />
                    <span className="text-[12px] font-extrabold">{sp.label}</span>
                  </div>
                  <span className="doc-ref whitespace-nowrap text-[15px] font-bold tracking-[-0.03em]" style={{ color: sp.fg }}>
                    {sp.total}
                  </span>
                </div>
                <div className="mt-[11px]">
                  <Spark sp={sp} height={44} />
                </div>
              </Card>
            )
          })}

          <div className="flex-none">
            <Attention compact />
          </div>

          {rankCards.map((c) => {
            const Ico = c.icon
            const max = Math.max(1, ...c.rows.map((r) => r.v))
            return (
              <Card key={c.key} className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
                <CardHead icon={Ico} title={c.title} fg={c.fg} />
                <div className="mt-3 flex flex-col gap-2.5">
                  {c.rows.length === 0 && (
                    <span className="text-[11.5px] font-semibold" style={{ color: t.faint }}>
                      Nothing booked yet.
                    </span>
                  )}
                  {c.rows.map((r, ri) => (
                    <div key={r.name}>
                      <div className="flex items-baseline justify-between gap-2.5">
                        <span className="min-w-0 truncate text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                          {r.name}
                        </span>
                        <span className="doc-ref flex-none whitespace-nowrap text-[11.5px] font-bold" style={{ color: c.fg }}>
                          {money(r.v)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px]" style={{ background: t.track }}>
                        <div
                          className="h-full rounded-[3px]"
                          style={{
                            width: `${(r.v / max) * 100}%`,
                            background: c.barBg,
                            transition: `width .9s cubic-bezier(.2,.8,.25,1) ${ri * 70}ms`
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )
          })}

          <Card className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
            <CardHead icon={Warehouse} title="Book stock by category" fg={t.accent} />
            <div className="mt-3 flex flex-col gap-2.5">
              {stockCats.map(([name, v], ci) => (
                <div key={name} className="rounded-[4px] px-3 py-2.5" style={{ border: `1px solid ${t.hair}`, background: t.inset }}>
                  <div className="flex items-baseline justify-between gap-2.5">
                    <span className="text-[11.5px] font-extrabold" style={{ color: t.ink2 }}>
                      <span className="capitalize">{name}</span>{' '}
                      <span className="text-[10px] font-semibold" style={{ color: t.faint }}>
                        ({v.products} products)
                      </span>
                    </span>
                    <span className="doc-ref whitespace-nowrap text-[13px] font-bold" style={{ color: v.qty < 0 ? t.red : t.green }}>
                      {formatNum(v.qty)}
                      <span className="text-[9.5px]" style={{ color: t.faint }}> MT</span>
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-[2px]" style={{ background: t.track }}>
                    <div
                      className="h-full"
                      style={{
                        width: `${(Math.abs(v.qty) / maxCat) * 100}%`,
                        background: v.qty < 0 ? t.stockNeg : t.stockOk,
                        transition: `width .9s cubic-bezier(.2,.8,.25,1) ${ci * 70}ms`
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2.5 pt-1">
                <span className="text-[11.5px] font-bold" style={{ color: t.muted }}>
                  MNC / consignment deposited
                </span>
                <span className="doc-ref whitespace-nowrap text-[12.5px] font-bold" style={{ color: t.violet }}>
                  {formatNum(n(stats?.consignmentBalance))}
                  <span className="text-[9.5px]" style={{ color: t.faint }}> MT</span>
                </span>
              </div>
            </div>
            <Deeper label="Open Stock" page="stock" fg={t.accent} />
          </Card>

          <Card className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
            <CardHead icon={Factory} title="Open exposure" fg={t.blue} />
            <div className="mt-2.5 flex flex-col">
              {exposure.map((e) => (
                <div
                  key={e.label}
                  className="flex items-baseline justify-between gap-2.5 py-2"
                  style={{ borderBottom: `1px dotted ${t.hair}` }}
                >
                  <span className="text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                    {e.label}
                  </span>
                  <span className="doc-ref flex-none whitespace-nowrap text-[12px] font-bold">{e.v}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Truck className="h-[16px] w-[16px]" style={{ color: t.accent }} />
              <span className="text-[10.5px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
                Tankers on the move
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-[7px]">
              {tankerRows.length === 0 && (
                <span className="text-[11.5px] font-semibold" style={{ color: t.faint }}>
                  Nothing in transit.
                </span>
              )}
              {tankerRows.map((tk) => (
                <div key={tk.label} className="flex items-center gap-2.5">
                  <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: t.accent }} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold capitalize" style={{ color: t.ink2 }}>
                    {tk.label}
                  </span>
                  <span className="doc-ref flex-none text-[12.5px] font-bold" style={{ color: t.accent }}>
                    {tk.count}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
            <CardHead icon={Landmark} title="Treasury watch" fg={t.accent} />
            <div className="mt-3 flex flex-col gap-2.5">
              {treasuryCards.map((tr) => (
                <div key={tr.key} className="rounded-[4px] px-3 py-2.5" style={{ border: `1px solid ${t.hair}`, background: t.inset }}>
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em]" style={{ color: tr.fg }}>
                    {tr.title}
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {tr.rows.length === 0 && (
                      <span className="text-[11px] font-semibold" style={{ color: t.faint }}>
                        none
                      </span>
                    )}
                    {tr.rows.map((rw, i) => (
                      <div key={`${rw.name}-${i}`} className="flex items-baseline justify-between gap-2.5">
                        <span className="doc-ref min-w-0 truncate text-[11.5px] font-semibold" style={{ color: t.ink2 }}>
                          {rw.name || '—'}
                        </span>
                        <span
                          className="doc-ref flex-none whitespace-nowrap text-[11.5px]"
                          style={{ color: rw.late ? t.red : t.ink2, fontWeight: rw.late ? 800 : 600 }}
                        >
                          {rw.days}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <Deeper label="Open Treasury" page="treasury" fg={t.accent} />
          </Card>

          <Card className="flex-none px-3.5 py-3.5" style={{ borderRadius: 5 }}>
            <CardHead icon={Receipt} title="Duties & taxes" fg={t.blue} />
            <div className="mt-2 flex flex-col">
              {duties.map((d) => (
                <div
                  key={d.label}
                  className="flex items-baseline justify-between gap-2.5 py-2"
                  style={{ borderBottom: `1px dotted ${t.hair}` }}
                >
                  <span className="min-w-0 text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                    {d.label}{' '}
                    <span className="text-[10px] font-semibold" style={{ color: t.faint }}>
                      ({d.hint})
                    </span>
                  </span>
                  <span className="doc-ref flex-none whitespace-nowrap text-[12px] font-bold" style={{ color: d.fg }}>
                    {money(d.value)}
                  </span>
                </div>
              ))}
            </div>
            <Deeper label="Open Trial Balance" page="accounts" fg={t.accent} />
          </Card>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- desktop --
  return (
    <div className="dash-anim relative min-h-full" style={{ background: t.page, color: t.ink }}>
      <style>{DASH_KEYFRAMES}</style>
      <span
        className="pointer-events-none fixed"
        style={{
          top: -140,
          left: 240,
          width: 620,
          height: 620,
          borderRadius: '50%',
          background: `radial-gradient(circle,${t.haloA},transparent 68%)`,
          animation: 'dash-halo 9s ease-in-out infinite'
        }}
      />
      <span
        className="pointer-events-none fixed"
        style={{
          bottom: -200,
          right: 60,
          width: 680,
          height: 680,
          borderRadius: '50%',
          background: `radial-gradient(circle,${t.haloB},transparent 66%)`,
          animation: 'dash-halo 11s ease-in-out infinite 1.5s'
        }}
      />

      <div
        className="sticky top-0 z-10 flex h-[74px] items-center justify-between gap-[18px] px-[26px]"
        style={{ background: t.head, borderBottom: `1px solid ${t.bd2}`, backdropFilter: 'blur(10px)' }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-[11px]">
            <span className="text-[24px] font-extrabold tracking-[-0.03em]">Dashboard</span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[.12em]"
              style={{ color: t.accent, background: t.accentSoft, border: `1px solid ${t.accentBd}` }}
            >
              <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: t.accent, animation: 'dash-pulse 2s ease-in-out infinite' }}
            />
              Live
            </span>
          </div>
          <div className="mt-[3px] text-[11.5px] font-semibold" style={{ color: t.muted }}>
            Money, stock and movement at a glance for {String(activeCompany?.name || 'the active company')}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <div className="flex items-center gap-[3px] rounded-[4px] p-[3px]" style={{ background: t.inset, border: `1px solid ${t.bd}` }}>
            {([
              { v: 'dark' as const, label: 'Dark', icon: Moon },
              { v: 'light' as const, label: 'Light', icon: Sun }
            ]).map((th) => {
              const on = theme === th.v
              const Ico = th.icon
              return (
                <button
                  key={th.v}
                  type="button"
                  onClick={() => flip(th.v)}
                  title={`${th.label} theme`}
                  className="flex h-8 items-center gap-1.5 rounded-[3px] px-2.5 text-[11.5px] font-extrabold"
                  style={on ? { background: t.accent, color: theme === 'dark' ? '#0A1F17' : '#fff' } : { color: t.muted }}
                >
                  <Ico className="h-4 w-4" />
                  {th.label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => void props.onRefresh()}
            className="flex h-10 items-center gap-2 rounded-[4px] px-[15px] text-[12.5px] font-extrabold"
            style={{ color: t.accent, background: t.accentSoft, border: `1px solid ${t.accentBd}` }}
          >
            <RefreshCw className="h-[18px] w-[18px]" style={{ animation: checking ? 'spin 1s linear infinite' : undefined }} />
            Refresh
          </button>
        </div>
      </div>

      <div className="relative flex flex-col gap-4 px-[26px] pb-[26px] pt-[18px]" style={{ perspective: 1800 }}>
        <div className="grid flex-none gap-3.5" style={{ gridTemplateColumns: 'repeat(4,minmax(0,1fr))', transformStyle: 'preserve-3d' }}>
          {kpis.map((k, ki) => {
            const Ico = k.icon
            return (
              <button
                key={k.key}
                type="button"
                onClick={() => props.onNavigate(k.page)}
                className="group relative overflow-hidden px-[17px] pb-[15px] pt-4 text-left transition-transform duration-300 hover:-translate-y-1.5"
                style={{ borderRadius: 6, background: t.card, border: `1px solid ${t.bd}`, boxShadow: t.shadow }}
              >
                <Sheen />
                <span
                  className="pointer-events-none absolute"
                  style={{ top: -46, right: -46, width: 130, height: 130, borderRadius: '50%', background: `radial-gradient(circle,${k.glow},transparent 70%)` }}
                />
                <span className="relative flex items-start justify-between gap-2.5">
                  <span
                    className="min-w-0 text-[9.5px] font-extrabold uppercase tracking-[.14em]"
                    style={{ color: t.muted }}
                  >
                    {k.label}
                  </span>
                  <span
                    className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px]"
                    style={{
                      background: t.accentSoft,
                      border: `1px solid ${t.bd}`,
                      animation: `dash-float 6s ease-in-out infinite ${ki * 240}ms`
                    }}
                  >
                    <Ico className="h-5 w-5" style={{ color: k.fg }} />
                  </span>
                </span>
                <span className="doc-ref relative mt-[11px] block text-[30px] font-bold tracking-[-0.04em]" style={{ color: t.ink }}>
                  {k.value}
                </span>
                <span className="relative mt-[5px] block text-[11.5px] font-semibold" style={{ color: t.muted }}>
                  {k.sub}
                </span>
                <span className="relative mt-[11px] flex items-center gap-[7px]">
                  <TrendChip v={k.trend} />
                  {k.trend != null && (
                    <span className="text-[10.5px] font-semibold" style={{ color: t.faint }}>
                      vs last month
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        <div className="grid flex-none gap-3.5" style={{ gridTemplateColumns: 'minmax(0,1.62fr) minmax(0,1fr)' }}>
          <Card className="overflow-hidden px-[18px] pb-2 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3.5">
              <div className="min-w-0">
                <div className="text-[13.5px] font-extrabold tracking-[-0.01em]">Purchases vs sales</div>
                <div className="mt-[3px] text-[11px] font-semibold" style={{ color: t.muted }}>
                  Last 6 months · ₹ crore
                </div>
              </div>
              <div className="flex items-center gap-3.5">
                <span className="inline-flex items-center gap-[7px] text-[11px] font-bold" style={{ color: t.blue }}>
                  <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: t.barBuyTop }} />
                  Purchases
                </span>
                <span className="inline-flex items-center gap-[7px] text-[11px] font-bold" style={{ color: t.accent }}>
                  <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: t.barSellTop }} />
                  Sales
                </span>
              </div>
            </div>
            <div className="mt-1.5 flex items-end justify-center overflow-hidden" style={{ height: 296, perspective: 1200 }}>
              <MonthChart height={256} barW={26} gap={9} labels />
            </div>
          </Card>

          <div className="flex flex-col gap-3.5">
            {sparks.map((sp) => {
              const Ico = sp.icon
              return (
                <Card key={sp.key} className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3.5">
                  <div className="flex flex-none items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Ico className="h-[18px] w-[18px] flex-none" style={{ color: sp.fg }} />
                      <span className="text-[12px] font-extrabold">{sp.label}</span>
                    </div>
                    <div className="flex-none text-right">
                      <div className="doc-ref text-[17px] font-bold tracking-[-0.03em]" style={{ color: sp.fg }}>
                        {sp.total}
                      </div>
                      <div className="mt-0.5 text-[10px] font-bold" style={{ color: t.faint }}>
                        30 days
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 min-h-0 flex-1">
                    <Spark sp={sp} height={82} />
                  </div>
                </Card>
              )
            })}
          </div>
        </div>

        <div className="grid flex-none gap-3.5" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          {rankCards.map((c) => {
            const Ico = c.icon
            const max = Math.max(1, ...c.rows.map((r) => r.v))
            return (
              <Card key={c.key} className="px-[17px] py-[15px]">
                <CardHead icon={Ico} title={c.title} fg={c.fg} />
                <div className="mt-[13px] flex flex-col gap-[11px]">
                  {c.rows.length === 0 && (
                    <span className="text-[11.5px] font-semibold" style={{ color: t.faint }}>
                      Nothing booked yet.
                    </span>
                  )}
                  {c.rows.map((r, ri) => (
                    <div key={r.name}>
                      <div className="flex items-baseline justify-between gap-2.5">
                        <span className="min-w-0 truncate text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                          {r.name}
                        </span>
                        <span className="doc-ref flex-none whitespace-nowrap text-[11.5px] font-bold" style={{ color: c.fg }}>
                          {money(r.v)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px]" style={{ background: t.track }}>
                        <div
                          className="h-full rounded-[3px]"
                          style={{ width: `${(r.v / max) * 100}%`, background: c.barBg, transition: `width .9s cubic-bezier(.2,.8,.25,1) ${ri * 70}ms` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )
          })}

          <Card className="flex flex-col px-[17px] py-[15px]">
            <CardHead
              icon={Receipt}
              title="Duties & taxes"
              fg={t.blue}
              right={
                <span className="text-[9.5px] font-bold" style={{ color: t.faint }}>
                  books
                </span>
              }
            />
            <div className="mt-[11px] flex flex-1 flex-col gap-0.5">
              {duties.map((d) => (
                <div
                  key={d.label}
                  className="flex items-baseline justify-between gap-2.5 py-2"
                  style={{ borderBottom: `1px dotted ${t.hair}` }}
                >
                  <span className="min-w-0 text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                    {d.label}{' '}
                    <span className="text-[10px] font-semibold" style={{ color: t.faint }}>
                      ({d.hint})
                    </span>
                  </span>
                  <span className="doc-ref flex-none whitespace-nowrap text-[12.5px] font-bold" style={{ color: d.fg }}>
                    {money(d.value)}
                  </span>
                </div>
              ))}
            </div>
            <Deeper label="Open Trial Balance" page="accounts" fg={t.accent} />
          </Card>
        </div>

        <div className="grid flex-none gap-3.5" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          <Card className="flex flex-col px-[17px] py-[15px]">
            <CardHead icon={Warehouse} title="Book stock by category" fg={t.accent} />
            <div className="mt-[13px] flex flex-1 flex-col gap-[9px]" style={{ perspective: 900 }}>
              {stockCats.map(([name, v], ci) => (
                <div
                  key={name}
                  className="relative rounded-[4px] px-3 py-2.5 transition-transform duration-300 hover:translate-x-[3px]"
                  style={{ border: `1px solid ${t.hair}`, background: t.inset }}
                >
                  <div className="flex items-baseline justify-between gap-2.5">
                    <span className="text-[11.5px] font-extrabold" style={{ color: t.ink2 }}>
                      <span className="capitalize">{name}</span>{' '}
                      <span className="text-[10px] font-semibold" style={{ color: t.faint }}>
                        ({v.products} products)
                      </span>
                    </span>
                    <span className="doc-ref whitespace-nowrap text-[13px] font-bold" style={{ color: v.qty < 0 ? t.red : t.green }}>
                      {formatNum(v.qty)}
                      <span className="text-[9.5px]" style={{ color: t.faint }}> MT</span>
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-[2px]" style={{ background: t.track }}>
                    <div
                      className="h-full"
                      style={{
                        width: `${(Math.abs(v.qty) / maxCat) * 100}%`,
                        background: v.qty < 0 ? t.stockNeg : t.stockOk,
                        transition: `width .9s cubic-bezier(.2,.8,.25,1) ${ci * 70}ms`
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2.5 pt-1">
                <span className="text-[11.5px] font-bold" style={{ color: t.muted }}>
                  MNC / consignment deposited
                </span>
                <span className="doc-ref whitespace-nowrap text-[12.5px] font-bold" style={{ color: t.violet }}>
                  {formatNum(n(stats?.consignmentBalance))}
                  <span className="text-[9.5px]" style={{ color: t.faint }}> MT</span>
                </span>
              </div>
            </div>
            <Deeper label="Open Stock" page="stock" fg={t.accent} />
          </Card>

          <Card className="flex flex-col px-[17px] py-[15px]">
            <CardHead icon={Factory} title="Open exposure" fg={t.blue} />
            <div className="mt-[13px] flex flex-none flex-col gap-0.5">
              {exposure.map((e) => (
                <div
                  key={e.label}
                  className="flex items-baseline justify-between gap-2.5 py-2"
                  style={{ borderBottom: `1px dotted ${t.hair}` }}
                >
                  <span className="text-[11.5px] font-bold" style={{ color: t.ink2 }}>
                    {e.label}
                  </span>
                  <span className="doc-ref flex-none whitespace-nowrap text-[12.5px] font-bold">{e.v}</span>
                </div>
              ))}
            </div>
            <div className="mt-[13px] min-h-0 flex-1">
              <div className="flex items-center gap-2">
                <Truck className="h-[17px] w-[17px]" style={{ color: t.accent }} />
                <span className="text-[11px] font-extrabold uppercase tracking-[.1em]" style={{ color: t.muted }}>
                  Tankers on the move
                </span>
              </div>
              <div className="mt-2.5 flex flex-col gap-[7px]">
                {tankerRows.length === 0 && (
                  <span className="text-[11.5px] font-semibold" style={{ color: t.faint }}>
                    Nothing in transit.
                  </span>
                )}
                {tankerRows.map((tk) => (
                  <div key={tk.label} className="flex items-center gap-2.5">
                    <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: t.accent }} />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold capitalize" style={{ color: t.ink2 }}>
                      {tk.label}
                    </span>
                    <span className="doc-ref flex-none text-[12.5px] font-bold" style={{ color: t.accent }}>
                      {tk.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Attention />
        </div>

        <Card className="flex-none px-[18px] py-[15px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <Landmark className="h-[19px] w-[19px]" style={{ color: t.accent }} />
            <span className="min-w-0 flex-1 text-[12.5px] font-extrabold">Treasury watch — LCs &amp; discounted bills</span>
            <button
              type="button"
              onClick={() => props.onNavigate('treasury')}
              className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-[.04em] hover:underline"
              style={{ color: t.accent }}
            >
              Open Treasury
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3.5 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
            {treasuryCards.map((tr) => (
              <div key={tr.key} className="rounded-[4px] px-[13px] py-3" style={{ border: `1px solid ${t.hair}`, background: t.inset }}>
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em]" style={{ color: tr.fg }}>
                  {tr.title}
                </div>
                <div className="mt-2.5 flex flex-col gap-2">
                  {tr.rows.length === 0 && (
                    <span className="text-[11px] font-semibold" style={{ color: t.faint }}>
                      none
                    </span>
                  )}
                  {tr.rows.map((rw, i) => (
                    <div key={`${rw.name}-${i}`} className="flex items-baseline justify-between gap-2.5">
                      <span className="doc-ref min-w-0 truncate text-[11.5px] font-semibold" style={{ color: t.ink2 }}>
                        {rw.name || '—'}
                      </span>
                      <span
                        className="doc-ref flex-none whitespace-nowrap text-[11.5px]"
                        style={{ color: rw.late ? t.red : t.ink2, fontWeight: rw.late ? 800 : 600 }}
                      >
                        {rw.days}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}

// A bar with no value still needs a hairline, or a month with one side at nil
// looks like a rendering fault rather than a quiet month.
function v0(v: number): number {
  return v > 0 ? 3 : 2
}
