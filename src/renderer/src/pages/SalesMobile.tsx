// Mobile Sales screen — website only (see __WEB__ in Sales.tsx's fork point).
//
// Built to the "design_handoff_erp_sales_mobile" spec: rowStyle=cards,
// nav=tabs, emphasis=status (the shipped default the handoff itself names).
// Colours, type and spacing are taken from that handoff's design tokens
// table, not guessed. Material Symbols in the reference are substituted with
// the lucide-react icons this codebase already uses everywhere else — the
// handoff itself says to substitute the target platform's icon set.
//
// Data is real, not the handoff's fixture rows: sales.list(), salesBargains.list(),
// data.list('customers'|'products') and stock.list() — the same IPC channels
// the desktop Sales page uses. One deliberate scope cut for the New Sale flow:
// it creates LOOSE, EX-works lines only (no packaging picker, no DLD freight,
// no bargain picker yet) — the common case, not every case the desktop form
// handles. See the comments on NewSaleScreen for exactly what that excludes.
import { useEffect, useMemo, useState } from 'react'
import { MobileBar } from '@/components/MobileBar'
import type { LucideIcon } from 'lucide-react'
import {
  Search,
  SlidersHorizontal,
  Bell,
  AlertTriangle,
  Calendar,
  Package,
  Truck,
  ArrowRight,
  ChevronRight,
  Plus,
  Minus,
  X,
  CheckCircle2,
  Pencil,
  Circle,
  User,
  ClipboardCheck
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Design tokens — from the handoff's own table, verbatim.
const T = {
  forest: '#0B3D2E',
  forestDeep: '#072B20',
  lime: '#C7F03F',
  limeText: '#12280B',
  limeTextAlt: '#2E4A0B',
  limeTextAlt2: '#3F5A12',
  green: '#12855A',
  greenMuted: '#8FBFA8',
  greenDim: '#6E9484',
  surface: '#F1F5EF',
  card: '#FFFFFF',
  border: '#D6E2D6',
  divider: '#EAF0E9',
  divider2: '#E4ECE3',
  chipFill: '#EAF0E9',
  ink: '#0A1F17',
  inkMuted: '#5A6B62',
  inkFaint: '#7C9188',
  inkFaint2: '#8AA096',
  warnFill: '#FFEDD0',
  warnText: '#8A5300',
  warnText2: '#7A5410',
  warnRule: '#C2700A',
  alert: '#D7263D'
} as const

// The website's Sales screens use the app's own type, not the handoff's
// Manrope + IBM Plex Mono — the desktop register reads in the app font and a
// phone showing the same invoice in a different face looked like a different
// product. Kept as empty style objects so the call sites stay put.
const mono: React.CSSProperties = {}
const sans: React.CSSProperties = {}

// ---------------------------------------------------------------------------
// Data shaping — real rows from sales.list(), grouped into invoices the same
// way the desktop page's own `invoices` memo does (by invoice_group).
type Row = Record<string, unknown>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
// Lakhs and crores, because that is how the mill quotes its own figures and
// because a header chip cannot hold ₹1,58,84,232.50. Matches TreasuryMobile's.
const fmtINRShort = (v: number): string => {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
const fmtINR = (v: number): string =>
  '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtQty = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
const fmtDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso
}
const todayISO = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Invoice = {
  key: string
  invoiceNo: string
  hasInvoiceNo: boolean
  date: string
  customer: string
  customerId: number | null
  lines: Row[]
  qty: number
  // Pre-rendered per unit, e.g. "18.289 MT" or "30 MT · 162 PCS".
  qtyLabel: string
  total: number
  itemsLabel: string
  itemCount: number
  category: string
  dispatched: boolean
  offStock: boolean
  freightTerm: 'EX' | 'DLD'
  bargainId: number | null
}

function groupInvoices(rows: Row[]): Invoice[] {
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.invoice_group ? s(r.invoice_group) : `single-${s(r.id)}`
    const arr = map.get(key)
    if (arr) arr.push(r)
    else map.set(key, [r])
  }
  const out: Invoice[] = []
  for (const [key, lines] of map) {
    const first = lines[0]
    const qty = lines.reduce((a, l) => a + n(l.qty), 0)
    // The unit each line is actually in. A carton is not a tonne, so an
    // invoice carrying both has no single quantity — `qty` stays for the one
    // place that wants one number (the register total), and anything naming a
    // unit reads this instead of assuming MT.
    const byUom = new Map<string, number>()
    for (const l of lines) {
      const u = s(l.uom || 'MT').toUpperCase()
      byUom.set(u, (byUom.get(u) || 0) + n(l.qty))
    }
    const qtyLabel = [...byUom.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([u, q]) => `${fmtQty(q)} ${u}`)
      .join(' · ')
    const total = lines.reduce((a, l) => a + n(l.amount) + n(l.gst_amount) + n(l.round_off) - n(l.tds_amount), 0)
    const items = lines.map((l) => s(l.product_name)).filter(Boolean)
    out.push({
      key,
      invoiceNo: s(first.invoice_no) || '—',
      hasInvoiceNo: !!first.invoice_no,
      date: s(first.sale_date),
      customer: s(first.customer) || s(first.customer_master),
      customerId: first.customer_id ? n(first.customer_id) : null,
      lines,
      qty,
      qtyLabel,
      total,
      itemsLabel: items.join(', '),
      itemCount: lines.length,
      category: s(first.product_category),
      dispatched: lines.every((l) => s(l.status) === 'done'),
      offStock: lines.some((l) => !l.is_trading && n(l.track_stock) === 0),
      freightTerm: s(first.freight_term) === 'DLD' ? 'DLD' : 'EX',
      bargainId: first.sales_bargain_id ? n(first.sales_bargain_id) : null
    })
  }
  return out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
}

// FY 26-27 style label + bounds — April-start fiscal year, matching the rest
// of this app's own FY convention.
function fyBounds(d = new Date()): { from: string; to: string; label: string } {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  const short = (yy: number): string => String(yy).slice(-2)
  return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${short(y)}-${short(y + 1)}` }
}

type RangeKey = 'Today' | 'This week' | 'This month' | string
function rangeBounds(key: RangeKey): { from: string; to: string } {
  const now = new Date()
  const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (key === 'Today') return { from: iso(now), to: iso(now) }
  if (key === 'This week') {
    const day = (now.getDay() + 6) % 7 // Monday = 0
    const start = new Date(now)
    start.setDate(now.getDate() - day)
    return { from: iso(start), to: iso(now) }
  }
  if (key === 'This month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: iso(start), to: iso(now) }
  }
  const fy = fyBounds(now)
  return { from: fy.from, to: fy.to }
}

// ---------------------------------------------------------------------------
// Icon helper — mirrors the handoff's `mi` sizing convention closely enough
// without pulling in a second icon system.
function Icon({ as: As, size = 20, color }: { as: LucideIcon; size?: number; color?: string }): React.JSX.Element {
  return <As size={size} color={color} strokeWidth={2} />
}

// ---------------------------------------------------------------------------
export function SalesMobile(): React.JSX.Element {
  const fy = useMemo(() => fyBounds(), [])
  const [screen, setScreen] = useState<'list' | 'detail' | 'new'>('list')
  const [rows, setRows] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [range, setRange] = useState<RangeKey>(fy.label)
  const [ptype, setPtype] = useState('All')
  const [missingOnly, setMissingOnly] = useState(false)

  const api = (window as unknown as { api: Record<string, any> }).api

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const [salesRows, custRows, prodRows] = await Promise.all([
        api.sales.list(),
        api.data.list('customers'),
        api.data.list('products')
      ])
      setRows(Array.isArray(salesRows) ? salesRows : [])
      setCustomers(Array.isArray(custRows) ? custRows.filter((c: Row) => n(c.active) !== 0) : [])
      setProducts(Array.isArray(prodRows) ? prodRows.filter((p: Row) => n(p.active) !== 0 && s(p.category) === 'finished') : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const invoices = useMemo(() => groupInvoices(rows), [rows])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.product_category) set.add(s(r.product_category))
    return ['All', ...Array.from(set).sort()]
  }, [rows])

  const filtered = useMemo(() => {
    const { from, to } = rangeBounds(range)
    const q = query.trim().toLowerCase()
    return invoices.filter((inv) => {
      if (inv.date && (inv.date < from || inv.date > to)) return false
      if (ptype !== 'All' && inv.category !== ptype) return false
      if (missingOnly && inv.hasInvoiceNo) return false
      if (q && !(inv.invoiceNo.toLowerCase().includes(q) || inv.customer.toLowerCase().includes(q) || inv.itemsLabel.toLowerCase().includes(q))) {
        return false
      }
      return true
    })
  }, [invoices, range, ptype, missingOnly, query])

  const totals = useMemo(
    () => ({
      count: filtered.length,
      qty: filtered.reduce((a, i) => a + i.qty, 0),
      value: filtered.reduce((a, i) => a + i.total, 0)
    }),
    [filtered]
  )

  const selected = filtered.find((i) => i.key === selectedKey) || invoices.find((i) => i.key === selectedKey) || null

  if (screen === 'detail' && selected) {
    return (
      <DetailScreen
        inv={selected}
        onBack={() => {
          setScreen('list')
        }}
      />
    )
  }

  if (screen === 'new') {
    return (
      <NewSaleScreen
        customers={customers}
        products={products}
        onCancel={() => setScreen('list')}
        onSaved={async () => {
          await load()
        }}
        onDone={() => setScreen('list')}
      />
    )
  }

  return (
    <ListScreen
      loading={loading}
      rows={filtered}
      totals={totals}
      categories={categories}
      query={query}
      setQuery={setQuery}
      filtersOpen={filtersOpen}
      setFiltersOpen={setFiltersOpen}
      range={range}
      setRange={setRange}
      fyLabel={fy.label}
      ptype={ptype}
      setPtype={setPtype}
      missingOnly={missingOnly}
      setMissingOnly={setMissingOnly}
      totalCount={invoices.length}
      onOpen={(key) => {
        setSelectedKey(key)
        setScreen('detail')
      }}
      onNew={() => setScreen('new')}
      onRefresh={load}
    />
  )
}

// ---------------------------------------------------------------------------
function ListScreen(props: {
  loading: boolean
  rows: Invoice[]
  totals: { count: number; qty: number; value: number }
  categories: string[]
  query: string
  setQuery: (v: string) => void
  filtersOpen: boolean
  setFiltersOpen: (v: boolean) => void
  range: RangeKey
  setRange: (v: RangeKey) => void
  fyLabel: string
  ptype: string
  setPtype: (v: string) => void
  missingOnly: boolean
  setMissingOnly: (v: boolean) => void
  totalCount: number
  onOpen: (key: string) => void
  onNew: () => void
  onRefresh: () => void | Promise<void>
}): React.JSX.Element {
  const { rows, totals } = props
  const quickRanges = ['Today', 'This week', 'This month', props.fyLabel]

  return (
    <div style={{ ...sans, height: '100%', display: 'flex', flexDirection: 'column', background: T.surface, color: T.ink, overflow: 'hidden' }}>
      <div style={{ background: T.forest, color: '#fff', padding: '10px 16px 0', flex: 'none' }}>
        <MobileBar onRefresh={props.onRefresh} />
        {/* The 44px left inset that used to be here is gone with the sidebar's
            floating button — the menu is in the bar above now, so the title has
            nothing to clear and gets the full width. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 }}>Sales</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* New sale lives here now rather than in a bar along the bottom —
                one tap from the list, and the list keeps the whole screen. */}
            <div
              onClick={props.onNew}
              title="New sale"
              style={{
                width: 34,
                height: 34,
                borderRadius: 3,
                background: T.lime,
                color: T.forest,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer'
              }}
            >
              <Icon as={Plus} size={21} color={T.forest} />
            </div>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 3,
                background: 'rgba(255,255,255,.11)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative'
              }}
            >
              <Icon as={Bell} size={20} color="#DCEFE4" />
              <span style={{ position: 'absolute', top: 7, right: 8, width: 6, height: 6, borderRadius: '50%', background: T.lime }} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          {[
            { k: 'Invoices', v: String(totals.count), lime: false },
            // Unlabelled on purpose: this adds every invoice in view and they
            // are not all in one unit, so no single unit is true of it. Same
            // rule as the desktop register's total.
            { k: 'Quantity', v: fmtQty(totals.qty), lime: false },
            { k: 'Value', v: fmtINRShort(totals.value), lime: true }
          ].map((c) => (
            <div
              key={c.k}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'rgba(255,255,255,.08)',
                borderRadius: 3,
                padding: '8px 9px'
              }}
            >
              <div style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: T.greenMuted }}>
                {c.k}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 13.5,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  whiteSpace: 'nowrap',
                  color: c.lime ? T.lime : '#fff',
                  ...mono
                }}
              >
                {c.v}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255,255,255,.1)',
              border: '1px solid rgba(199,240,63,.18)',
              borderRadius: 4,
              padding: '0 11px',
              height: 46
            }}
          >
            <Icon as={Search} size={20} color={T.greenMuted} />
            <input
              value={props.query}
              onChange={(e) => props.setQuery(e.target.value)}
              placeholder="Invoice no, customer, product"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 0, color: '#fff', fontSize: 14.5, ...sans, fontWeight: 500 }}
            />
          </div>
          <div
            onClick={() => props.setFiltersOpen(!props.filtersOpen)}
            style={{
              width: 46,
              height: 46,
              borderRadius: 4,
              background: props.filtersOpen ? T.lime : 'rgba(255,255,255,.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer'
            }}
          >
            <Icon as={SlidersHorizontal} size={20} color={props.filtersOpen ? T.forest : '#DCEFE4'} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto' }}>
          {quickRanges.map((r) => {
            const active = props.range === r
            return (
              <div
                key={r}
                onClick={() => props.setRange(r)}
                style={{
                  flex: 'none',
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  borderRadius: 3,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: active ? T.lime : 'transparent',
                  color: active ? T.limeText : T.greenMuted,
                  border: `1px solid ${active ? T.lime : 'rgba(199,240,63,.25)'}`
                }}
              >
                {r}
              </div>
            )
          })}
        </div>

        {props.filtersOpen && (
          <div
            style={{
              marginTop: 12,
              background: 'rgba(0,0,0,.18)',
              border: '1px solid rgba(199,240,63,.16)',
              borderRadius: 4,
              padding: 13,
              display: 'flex',
              flexDirection: 'column',
              gap: 11
            }}
          >
            <div style={{ fontSize: 10, letterSpacing: '.13em', textTransform: 'uppercase', color: T.lime, fontWeight: 800 }}>Product type</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {props.categories.map((p) => {
                const active = props.ptype === p
                return (
                  <div
                    key={p}
                    onClick={() => props.setPtype(p)}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 3,
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: `1px solid ${active ? T.lime : 'rgba(255,255,255,.18)'}`,
                      background: active ? T.lime : 'transparent',
                      color: active ? T.limeText : '#DCEFE4'
                    }}
                  >
                    {p || 'Other'}
                  </div>
                )
              })}
            </div>
            <div
              onClick={() => props.setMissingOnly(!props.missingOnly)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 3,
                paddingTop: 12,
                borderTop: '1px solid rgba(255,255,255,.1)',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>Missing invoice nos only</span>
              <div
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 3,
                  background: props.missingOnly ? T.lime : 'rgba(255,255,255,.2)',
                  padding: 3,
                  display: 'flex',
                  justifyContent: props.missingOnly ? 'flex-end' : 'flex-start'
                }}
              >
                <div style={{ width: 20, height: 20, borderRadius: 2, background: '#fff' }} />
              </div>
            </div>
          </div>
        )}
        <div style={{ height: 13 }} />
      </div>

      <div
        style={{
          flex: 'none',
          background: T.lime,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `2px solid ${T.forest}`
        }}
      >
        <div style={{ fontSize: 11, color: T.limeTextAlt, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>
          Total · {totals.count} invoice{totals.count === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, ...mono }}>
          <div style={{ fontSize: 11.5, color: T.limeTextAlt2, fontWeight: 600 }}>{fmtQty(totals.qty)}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.limeText, letterSpacing: '-0.02em' }}>{fmtINR(totals.value)}</div>
        </div>
      </div>

      {/* 20px at the foot, not 96 — that clearance existed to keep the list
          clear of the floating New sale button, which is now in the header. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px 20px' }}>
        {props.loading ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: T.inkFaint, fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: T.inkFaint, fontSize: 13 }}>No invoices in this range.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {rows.map((r) => (
              <InvoiceCard key={r.key} r={r} onOpen={() => props.onOpen(r.key)} />
            ))}
          </div>
        )}
        <div style={{ textAlign: 'center', fontSize: 11, color: T.inkFaint, fontWeight: 600, padding: '16px 0 4px', letterSpacing: '.04em' }}>
          SHOWING {rows.length} OF {props.totalCount}
        </div>
      </div>

      {/* Nothing along the bottom. The handoff had a tab bar here (Sales /
          Bargains / Stock / More) offering three destinations this screen
          doesn't have, and later a New sale bar — both were taking a strip of
          a phone screen permanently. New sale is a + in the header instead,
          and navigation belongs to the sidebar. */}
    </div>
  )
}

function InvoiceCard({ r, onOpen }: { r: Invoice; onOpen: () => void }): React.JSX.Element {
  return (
    <div
      onClick={onOpen}
      style={{ background: T.card, border: `1px solid ${T.border}`, borderLeft: `4px solid ${T.green}`, borderRadius: 4, padding: '12px 13px', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, ...mono, letterSpacing: '-0.01em' }}>{r.invoiceNo}</div>
          <div style={{ fontSize: 11.5, color: T.inkMuted, marginTop: 2, ...mono }}>{fmtDate(r.date)}</div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: T.forest,
            color: T.lime,
            borderRadius: 3,
            padding: '5px 9px',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '.03em',
            textTransform: 'uppercase',
            flex: 'none'
          }}
        >
          <Icon as={Truck} size={15} color={T.lime} />
          {r.dispatched ? 'Done' : 'Pending'}
        </div>
      </div>

      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 9, letterSpacing: '-0.015em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.customer}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
        <Icon as={Package} size={15} color={T.inkFaint2} />
        <div style={{ fontSize: 11.5, color: T.inkMuted, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.itemCount} item{r.itemCount === 1 ? '' : 's'} · {r.itemsLabel}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginTop: 11,
          paddingTop: 10,
          borderTop: `1px solid ${T.divider}`
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, background: T.chipFill, color: '#33473E', borderRadius: 2, padding: '4px 6px', ...mono }}>
            QTY {r.qtyLabel}
          </span>
          <span style={{ fontSize: 11, fontWeight: 800, background: T.chipFill, color: '#33473E', borderRadius: 2, padding: '4px 6px', letterSpacing: '.05em' }}>
            {r.freightTerm}
          </span>
          {r.offStock && (
            <span style={{ fontSize: 11, fontWeight: 800, background: T.warnFill, color: T.warnText, borderRadius: 2, padding: '4px 6px', letterSpacing: '.04em' }}>
              OFF-STOCK
            </span>
          )}
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-0.03em', ...mono }}>{fmtINR(r.total)}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
function DetailScreen({
  inv,
  onBack
}: {
  inv: Invoice
  onBack: () => void
}): React.JSX.Element {
  // The ⋮ sheet is gone with its four placeholder actions (Edit sale, Print
  // invoice, Mark dispatched, Cancel invoice). None of them did anything —
  // they only closed the sheet. Print has no implementation anywhere in the
  // app; Edit needs a form this screen doesn't have; and Mark dispatched and
  // Cancel both write to live invoices, so they want the desktop's guard
  // rails (a cancellation reason, the freight and stock prompts) rather than
  // a one-tap version of themselves on a phone.

  // The same trail the desktop drawer shows: the audit log keyed by this
  // invoice's group, plus the gate register's own in/out entries. Same two
  // sources, same merge — so a phone and a laptop tell the same story.
  const [activity, setActivity] = useState<{ what: string; when: string; kind: 'created' | 'in' | 'out' | 'edit' }[]>([])
  const [activityOpen, setActivityOpen] = useState(true)
  useEffect(() => {
    let alive = true
    void (async () => {
      const api = (window as unknown as { api: Record<string, any> }).api
      const group = s(inv.lines[0]?.invoice_group)
      if (!group) return
      const [hist, gate] = await Promise.all([
        api.access?.entityHistory?.('Sale', { key: group, limit: 100 }).catch(() => []) ?? [],
        api.gate?.forRecord?.({ invoiceGroup: group }).catch(() => ({ rows: [] })) ?? { rows: [] }
      ])
      if (!alive) return
      const out: { what: string; when: string; kind: 'created' | 'in' | 'out' | 'edit' }[] = []
      for (const h of (hist || []) as Row[]) {
        const action = s(h.action)
        out.push({
          what: `${action}${h.username ? ` by ${s(h.username)}` : ''}`,
          when: s(h.created_at),
          kind: /^created/i.test(action) ? 'created' : 'edit'
        })
      }
      for (const g of ((gate?.rows || []) as Row[])) {
        const dir = s(g.direction) === 'out' ? 'out' : 'in'
        out.push({
          what: `Tanker gate ${dir}${g.tanker_no ? ` — ${s(g.tanker_no)}` : ''}`,
          when: [s(g.entry_date), s(g.entry_time)].filter(Boolean).join(' '),
          kind: dir
        })
      }
      out.sort((a, b) => a.when.localeCompare(b.when))
      setActivity(out)
    })()
    return () => {
      alive = false
    }
  }, [inv.key])

  return (
    <div style={{ ...sans, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.card }}>
      <div style={{ flex: 'none', background: T.forest, color: '#fff', padding: '6px 8px 11px' }}>
        {/* No "← Sales" control here. It sat in the top-left corner, which is
            where the sidebar's own tap-to-open button is fixed — the two
            overlapped and the word read as "ales". The ✕ closes back to the
            list, so nothing is lost by dropping it. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: 38 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {/* Closes back to the list — the drawer on the desktop has the
                same ✕ in the same corner. */}
            <div
              onClick={onBack}
              title="Close"
              style={{
                width: 34,
                height: 34,
                borderRadius: 3,
                background: 'rgba(255,255,255,.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer'
              }}
            >
              <Icon as={X} size={19} />
            </div>
          </div>
        </div>
        <div style={{ padding: '4px 8px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em', ...mono }}>{inv.invoiceNo}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: T.lime,
                color: T.limeText,
                borderRadius: 3,
                padding: '3px 7px',
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '.05em'
              }}
            >
              <Icon as={Truck} size={14} color={T.limeText} />
              {inv.dispatched ? 'Dispatched' : 'Pending'}
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: T.greenMuted, marginTop: 3, fontWeight: 600 }}>
            {fmtDate(inv.date)} · {inv.customer}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: T.surface, padding: '10px 12px 16px' }}>
        {/* Three cards, same set the desktop drawer shows. */}
        <div style={{ display: 'flex', gap: 7 }}>
          {[
            { k: 'Qty', v: inv.qtyLabel },
            { k: 'Freight', v: inv.freightTerm },
            { k: 'Items', v: `${inv.itemCount} item${inv.itemCount > 1 ? 's' : ''}` }
          ].map((st) => (
            <div key={st.k} style={{ flex: 1, minWidth: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, padding: '8px 9px' }}>
              <div style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800 }}>{st.k}</div>
              <div style={{ fontSize: 15.5, fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.v}</div>
            </div>
          ))}
        </div>

        {inv.offStock && (
          <div style={{ background: T.warnFill, borderLeft: `4px solid ${T.warnRule}`, borderRadius: 4, padding: '8px 10px', marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icon as={AlertTriangle} size={17} color={T.warnRule} />
            <div style={{ fontSize: 11, color: T.warnText2, fontWeight: 600, lineHeight: 1.35 }}>
              <b style={{ color: T.warnText }}>Off-stock dispatch.</b> No matching finished-goods stock at dispatch time.
            </div>
          </div>
        )}

        <div style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800, margin: '12px 0 6px' }}>Line items</div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
          {inv.lines.map((li, i) => (
            <div key={i} style={{ padding: '8px 10px', borderBottom: `1px solid ${T.divider}`, display: 'flex', justifyContent: 'space-between', gap: 9 }}>
              <div style={{ minWidth: 0 }}>
                {/* Packed lines are sold as their SKU, same as the desktop. */}
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s(li.packaging_name) || s(li.product_name)}
                </div>
                <div style={{ fontSize: 10.5, color: T.inkMuted, marginTop: 1, ...mono }}>
                  {fmtQty(n(li.qty))} × {fmtINR(n(li.rate))}
                </div>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, ...mono, flex: 'none' }}>
                {fmtINR(n(li.amount) + n(li.gst_amount) + n(li.round_off) - n(li.tds_amount))}
              </div>
            </div>
          ))}
          <div style={{ padding: '9px 10px', background: T.lime, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: T.limeTextAlt, textTransform: 'uppercase', letterSpacing: '.08em' }}>Invoice total</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: T.limeText, ...mono, letterSpacing: '-0.02em' }}>{fmtINR(inv.total)}</span>
          </div>
        </div>

        {/* Collapsible: the trail grows with every edit and gate movement, and
            on a phone a long one buries everything above it. */}
        <div
          onClick={() => setActivityOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            margin: '12px 0 6px',
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          <span style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800 }}>
            Activity
          </span>
          {activity.length > 0 && (
            <span style={{ fontSize: 9.5, fontWeight: 800, color: T.inkFaint, background: T.chipFill, borderRadius: 2, padding: '1px 5px' }}>
              {activity.length}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', transform: activityOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>
            <Icon as={ChevronRight} size={16} color={T.inkFaint} />
          </span>
        </div>
        {activityOpen && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, padding: '2px 10px' }}>
          {activity.length === 0 ? (
            <div style={{ padding: '14px 0', textAlign: 'center', fontSize: 11.5, color: T.inkFaint }}>
              Nothing recorded against this invoice yet.
            </div>
          ) : (
            activity.map((a, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 9,
                  padding: '8px 0',
                  borderBottom: i === activity.length - 1 ? 'none' : `1px solid ${T.divider}`
                }}
              >
                <Icon
                  as={a.kind === 'created' ? CheckCircle2 : a.kind === 'in' ? ArrowRight : a.kind === 'out' ? Truck : Pencil}
                  size={17}
                  color={T.green}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{a.what}</div>
                  <div style={{ fontSize: 10.5, color: T.inkFaint, fontWeight: 600, marginTop: 1, ...mono }}>{a.when || '—'}</div>
                </div>
              </div>
            ))
          )}
        </div>
        )}
      </div>

      {/* No PRINT / SHARE INVOICE bar. The handoff drew one, but neither
          action exists on this screen — they were buttons that did nothing,
          taking up the most valuable strip on a phone. */}
    </div>
  )
}

// ---------------------------------------------------------------------------
// New sale — scoped to the common case: LOOSE lines, EX works, GST defaulted
// from the customer's own gst_pct (matching how the desktop form defaults it
// off a picked bargain/customer). No packaging picker, no DLD freight rate
// entry, no bargain link picker yet — the desktop app remains the complete
// tool for those; this covers the everyday phone-side sale.
type CartLine = { productId: number; name: string; qty: number; rate: number }

function NewSaleScreen({
  customers,
  products,
  onCancel,
  onSaved,
  onDone
}: {
  customers: Row[]
  products: Row[]
  onCancel: () => void
  onSaved: () => Promise<void>
  onDone: () => void
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [customerId, setCustomerId] = useState<number | null>(customers[0] ? n(customers[0].id) : null)
  const [invoiceDate] = useState(todayISO())
  const [cart, setCart] = useState<CartLine[]>([])
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the server refuses the save for lack of finished-goods stock —
  // exactly the check the desktop form hits (assertFinishedStock), and the
  // same escape hatch it offers: a deliberate off-stock override, not a
  // client-side guess at "available" (that number can't be trusted — it
  // doesn't match the server's own per-company, point-in-time figure).
  const [offStockError, setOffStockError] = useState<string | null>(null)

  const customer = customers.find((c) => n(c.id) === customerId) || null
  const cartTotal = cart.reduce((a, i) => a + i.qty * i.rate, 0)
  const cartQty = cart.reduce((a, i) => a + i.qty, 0)

  const steps = [
    { label: 'Customer', icon: User },
    { label: 'Items', icon: Package },
    { label: 'Review', icon: ClipboardCheck }
  ]

  async function save(force = false): Promise<void> {
    if (!customer || !cart.length) return
    setSaving(true)
    setError(null)
    setOffStockError(null)
    try {
      const gstPct = n(customer.gst_pct) || 0
      const res = await (window as unknown as { api: Record<string, any> }).api.sales.createInvoice({
        sale_date: invoiceDate,
        customer: s(customer.name),
        customer_id: n(customer.id),
        freight_term: 'EX',
        gst_type: 'CGST_SGST',
        sale_type: 'LOOSE',
        force_no_stock: force,
        items: cart.map((it) => ({
          product_id: it.productId,
          qty: it.qty,
          rate: it.rate,
          gst_pct: gstPct
        }))
      })
      setSaved(s(res?.ids?.length ? `Sale saved` : ''))
    } catch (e) {
      const msg = (e as Error).message || 'Could not save the sale'
      if (/not enough .* stock/i.test(msg)) setOffStockError(msg)
      else setError(msg)
    } finally {
      setSaving(false)
    }
  }

  async function nextStep(): Promise<void> {
    if (saved) {
      await onSaved()
      onDone()
      return
    }
    if (step === 2) {
      await save()
      return
    }
    setStep((v) => v + 1)
  }

  const ctaLabel = saved ? 'DONE' : step === 2 ? (saving ? 'SAVING…' : 'SAVE SALE') : 'CONTINUE'
  const footerHint = step === 0 ? s(customer?.name) || 'Pick a customer' : step === 1 ? `${cart.length} item${cart.length === 1 ? '' : 's'} · ${fmtINR(cartTotal)}` : 'Review before saving'

  return (
    <div style={{ ...sans, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.card }}>
      <div style={{ flex: 'none', background: T.forest, color: '#fff', padding: '8px 10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div onClick={onCancel} style={{ height: 44, padding: '0 10px', display: 'flex', alignItems: 'center', fontSize: 13.5, fontWeight: 700, color: T.greenMuted, cursor: 'pointer' }}>
            CANCEL
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 800, letterSpacing: '.01em' }}>New sale</div>
          <div style={{ height: 44, padding: '0 10px', display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: 700, color: T.greenMuted }}>DRAFT</div>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '8px 8px 0' }}>
          {steps.map((st, i) => {
            const reached = i <= step
            return (
              <div key={st.label} style={{ flex: 1 }}>
                <div style={{ height: 4, background: reached ? T.lime : 'rgba(255,255,255,.18)' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 7 }}>
                  <Icon as={st.icon} size={15} color={reached ? T.lime : T.greenDim} />
                  <span style={{ fontSize: 10.5, color: reached ? T.lime : T.greenDim, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>{st.label}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: T.surface, padding: 16 }}>
        {error && (
          <div style={{ background: T.warnFill, color: T.warnText, borderRadius: 4, padding: '10px 12px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>{error}</div>
        )}

        {offStockError && (
          <div style={{ background: T.warnFill, borderLeft: `4px solid ${T.warnRule}`, borderRadius: 4, padding: '11px 12px', marginBottom: 12, display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <Icon as={AlertTriangle} size={20} color={T.warnRule} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: T.warnText }}>{offStockError}</div>
              <div
                onClick={() => void save(true)}
                style={{
                  marginTop: 9,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: T.warnRule,
                  color: '#fff',
                  borderRadius: 4,
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '.03em',
                  cursor: 'pointer'
                }}
              >
                DISPATCH OFF-STOCK ANYWAY
              </div>
            </div>
          </div>
        )}

        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 9.5, fontWeight: 800, color: T.inkMuted, marginBottom: 7, textTransform: 'uppercase', letterSpacing: '.12em' }}>Customer</div>
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
                {customers.map((c) => {
                  const active = n(c.id) === customerId
                  return (
                    <div
                      key={n(c.id)}
                      onClick={() => setCustomerId(n(c.id))}
                      style={{
                        padding: '14px 13px',
                        borderBottom: `1px solid ${T.divider}`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        background: active ? T.surface : T.card,
                        borderLeft: `3px solid ${active ? T.green : 'transparent'}`,
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ flex: 1, fontSize: 14, fontWeight: active ? 800 : 500 }}>{s(c.name)}</div>
                      <Icon as={active ? CheckCircle2 : Circle} size={20} color={active ? T.green : '#C3D2C6'} />
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9.5, fontWeight: 800, color: T.inkMuted, marginBottom: 7, textTransform: 'uppercase', letterSpacing: '.12em' }}>Invoice date</div>
                <div style={{ height: 50, background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 7, padding: '0 11px', fontSize: 14, ...mono, fontWeight: 500 }}>
                  <Icon as={Calendar} size={19} color={T.inkFaint2} />
                  {fmtDate(invoiceDate)}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9.5, fontWeight: 800, color: T.inkMuted, marginBottom: 7, textTransform: 'uppercase', letterSpacing: '.12em' }}>Freight</div>
                <div style={{ height: 50, background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 7, padding: '0 11px', fontSize: 14, fontWeight: 600 }}>
                  <Icon as={Truck} size={19} color={T.inkFaint2} />
                  EX works
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {cart.map((it, i) => {
              return (
                <div key={i} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{it.name}</div>
                    <div
                      onClick={() => setCart((c) => c.filter((_, j) => j !== i))}
                      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '-4px -4px 0 0', cursor: 'pointer' }}
                    >
                      <Icon as={X} size={19} color={T.inkFaint2} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 11 }}>
                    <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
                      <div
                        onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}
                        style={{ width: 46, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.surface, cursor: 'pointer' }}
                      >
                        <Icon as={Minus} size={20} color={T.forest} />
                      </div>
                      <div style={{ minWidth: 56, textAlign: 'center', fontSize: 15, fontWeight: 700, ...mono }}>{it.qty}</div>
                      <div
                        onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))}
                        style={{ width: 46, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.surface, cursor: 'pointer' }}
                      >
                        <Icon as={Plus} size={20} color={T.forest} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <input
                        type="number"
                        value={it.rate || ''}
                        onChange={(e) => setCart((c) => c.map((x, j) => (j === i ? { ...x, rate: n(e.target.value) } : x)))}
                        placeholder="Rate"
                        style={{ width: 110, textAlign: 'right', fontSize: 14, fontWeight: 700, ...mono, border: `1px solid ${T.border}`, borderRadius: 4, padding: '6px 8px' }}
                      />
                      <div style={{ fontSize: 16, fontWeight: 700, ...mono, letterSpacing: '-0.02em', marginTop: 4 }}>{fmtINR(it.qty * it.rate)}</div>
                    </div>
                  </div>
                </div>
              )
            })}

            {picking ? (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
                {products.map((p) => (
                  <div
                    key={n(p.id)}
                    onClick={() => {
                      setCart((c) => [...c, { productId: n(p.id), name: s(p.name), qty: 1, rate: 0 }])
                      setPicking(false)
                    }}
                    style={{ padding: '12px 13px', borderBottom: `1px solid ${T.divider}`, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {s(p.name)}
                  </div>
                ))}
              </div>
            ) : (
              <div
                onClick={() => setPicking(true)}
                style={{
                  height: 50,
                  border: `1.5px dashed #A8C0B2`,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 13.5,
                  fontWeight: 800,
                  color: T.forest,
                  background: T.card,
                  letterSpacing: '.03em',
                  cursor: 'pointer'
                }}
              >
                <Icon as={Plus} size={20} color={T.forest} />
                ADD ITEM
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
            {[
              { k: 'Customer', v: s(customer?.name) || '—' },
              { k: 'Invoice date', v: fmtDate(invoiceDate) },
              { k: 'Items', v: `${cart.length} items` },
              { k: 'Total qty', v: String(cartQty) },
              { k: 'Freight', v: 'EX works' }
            ].map((rr) => (
              <div key={rr.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: 13, borderBottom: `1px solid ${T.divider}` }}>
                <span style={{ fontSize: 12, color: T.inkMuted, fontWeight: 600 }}>{rr.k}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, textAlign: 'right' }}>{rr.v}</span>
              </div>
            ))}
            <div style={{ padding: 14, background: T.lime, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: T.limeTextAlt, textTransform: 'uppercase', letterSpacing: '.08em' }}>Invoice total</span>
              <span style={{ fontSize: 21, fontWeight: 700, color: T.limeText, ...mono, letterSpacing: '-0.03em' }}>{fmtINR(cartTotal)}</span>
            </div>
          </div>
        )}

        {saved && (
          <div style={{ marginTop: 14, background: T.forest, borderRadius: 4, padding: 13, fontSize: 13, color: T.lime, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon as={CheckCircle2} size={20} color={T.lime} />
            {saved}
          </div>
        )}
      </div>

      <div style={{ flex: 'none', background: T.card, borderTop: `1px solid ${T.border}`, padding: '10px 16px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 11.5, color: T.inkMuted, fontWeight: 600 }}>{footerHint}</div>
        <div
          onClick={() => {
            if (saving) return
            if (step === 0 && !customer) return
            if (step === 1 && !cart.length) return
            void nextStep()
          }}
          style={{
            minWidth: 150,
            height: 50,
            borderRadius: 4,
            background: T.forest,
            color: T.lime,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontSize: 13.5,
            fontWeight: 800,
            letterSpacing: '.03em',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.7 : 1
          }}
        >
          {ctaLabel}
          {!saving && <Icon as={ArrowRight} size={20} color={T.lime} />}
        </div>
      </div>
    </div>
  )
}
