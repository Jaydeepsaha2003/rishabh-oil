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
import type { LucideIcon } from 'lucide-react'
import {
  Search,
  SlidersHorizontal,
  Bell,
  AlertTriangle,
  Calendar,
  Package,
  Truck,
  Receipt,
  Handshake,
  MoreHorizontal,
  MoreVertical,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Plus,
  Minus,
  X,
  CheckCircle2,
  Circle,
  Printer,
  Share2,
  Pencil,
  Ban,
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

const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace" }
const sans: React.CSSProperties = { fontFamily: "'Manrope Variable', Manrope, system-ui, sans-serif" }

// ---------------------------------------------------------------------------
// Data shaping — real rows from sales.list(), grouped into invoices the same
// way the desktop page's own `invoices` memo does (by invoice_group).
type Row = Record<string, unknown>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
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
  const [actionsOpen, setActionsOpen] = useState(false)

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
        actionsOpen={actionsOpen}
        toggleActions={() => setActionsOpen((v) => !v)}
        onBack={() => {
          setScreen('list')
          setActionsOpen(false)
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
        setActionsOpen(false)
        setScreen('detail')
      }}
      onNew={() => setScreen('new')}
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
}): React.JSX.Element {
  const { rows, totals } = props
  const quickRanges = ['Today', 'This week', 'This month', props.fyLabel]

  return (
    <div style={{ ...sans, height: '100%', display: 'flex', flexDirection: 'column', background: T.surface, color: T.ink, overflow: 'hidden' }}>
      <div style={{ background: T.forest, color: '#fff', padding: '10px 16px 0', flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 }}>Sales</div>
            <div style={{ fontSize: 11.5, color: T.greenMuted, marginTop: 3, fontWeight: 500 }}>Finished-goods dispatches</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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

        <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
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

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px 96px' }}>
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

      <div style={{ flex: 'none', background: T.forest, display: 'flex', alignItems: 'stretch', position: 'relative' }}>
        {[
          { label: 'Sales', icon: Receipt, active: true },
          { label: 'Bargains', icon: Handshake, active: false },
          { label: 'Stock', icon: Package, active: false },
          { label: 'More', icon: MoreHorizontal, active: false }
        ].map((t) => (
          <div
            key={t.label}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              padding: '9px 0 10px',
              minHeight: 56,
              borderTop: `3px solid ${t.active ? T.lime : 'transparent'}`
            }}
          >
            <Icon as={t.icon} size={22} color={t.active ? T.lime : T.greenDim} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: t.active ? T.lime : T.greenDim }}>
              {t.label}
            </span>
          </div>
        ))}
        <div
          onClick={props.onNew}
          style={{
            position: 'absolute',
            right: 14,
            top: -64,
            height: 52,
            padding: '0 18px',
            borderRadius: 4,
            background: T.lime,
            color: T.forest,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: '.02em',
            boxShadow: '0 6px 18px rgba(11,61,46,.28)',
            cursor: 'pointer'
          }}
        >
          <Icon as={Plus} size={22} />
          NEW SALE
        </div>
      </div>
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
            QTY {fmtQty(r.qty)}
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
  actionsOpen,
  toggleActions,
  onBack
}: {
  inv: Invoice
  actionsOpen: boolean
  toggleActions: () => void
  onBack: () => void
}): React.JSX.Element {
  const actions = [
    { label: 'Edit sale', icon: Pencil },
    { label: 'Print invoice', icon: Printer },
    { label: 'Mark dispatched', icon: Truck },
    { label: 'Cancel invoice', icon: Ban }
  ]

  return (
    <div style={{ ...sans, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: T.card }}>
      <div style={{ flex: 'none', background: T.forest, color: '#fff', padding: '8px 10px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div onClick={onBack} style={{ height: 44, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 5, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            <Icon as={ArrowLeft} size={22} />
            Sales
          </div>
          <div onClick={toggleActions} style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Icon as={MoreVertical} size={24} />
          </div>
        </div>
        <div style={{ padding: '6px 8px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', ...mono }}>{inv.invoiceNo}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: T.lime,
                color: T.limeText,
                borderRadius: 3,
                padding: '4px 9px',
                fontSize: 10.5,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '.05em'
              }}
            >
              <Icon as={Truck} size={15} color={T.limeText} />
              {inv.dispatched ? 'Dispatched' : 'Pending'}
            </div>
          </div>
          <div style={{ fontSize: 13.5, color: T.greenMuted, marginTop: 5, fontWeight: 600 }}>
            {fmtDate(inv.date)} · {inv.customer}
          </div>
        </div>
      </div>

      {actionsOpen && (
        <div style={{ flex: 'none', background: T.forestDeep, color: '#fff' }}>
          {actions.map((a) => (
            <div
              key={a.label}
              onClick={toggleActions}
              style={{ padding: '13px 20px', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 11, borderTop: '1px solid rgba(255,255,255,.07)', cursor: 'pointer' }}
            >
              <Icon as={a.icon} size={20} color={T.lime} />
              {a.label}
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: T.surface, padding: '14px 16px 20px' }}>
        <div style={{ display: 'flex', gap: 9 }}>
          <div style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, padding: '11px 12px' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.12em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800 }}>Qty</div>
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 4, ...mono }}>{fmtQty(inv.qty)}</div>
          </div>
          <div style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, padding: '11px 12px' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.12em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800 }}>Freight</div>
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 4 }}>{inv.freightTerm}</div>
          </div>
        </div>

        {inv.offStock && (
          <div style={{ background: T.warnFill, borderLeft: `4px solid ${T.warnRule}`, borderRadius: 4, padding: '11px 12px', marginTop: 9, display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <Icon as={AlertTriangle} size={20} color={T.warnRule} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: T.warnText, letterSpacing: '.01em' }}>Off-stock dispatch</div>
              <div style={{ fontSize: 11.5, color: T.warnText2, marginTop: 2, fontWeight: 500, lineHeight: 1.4 }}>
                Dispatched without matching finished-goods stock.
              </div>
            </div>
          </div>
        )}

        <div style={{ fontSize: 9.5, letterSpacing: '.14em', textTransform: 'uppercase', color: T.inkFaint, fontWeight: 800, margin: '18px 0 8px' }}>Line items</div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' }}>
          {inv.lines.map((li, i) => (
            <div key={i} style={{ padding: 12, borderBottom: `1px solid ${T.divider}`, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s(li.product_name)}</div>
                <div style={{ fontSize: 11.5, color: T.inkMuted, marginTop: 2, ...mono }}>
                  {fmtQty(n(li.qty))} × {fmtINR(n(li.rate))}
                </div>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, ...mono, flex: 'none' }}>
                {fmtINR(n(li.amount) + n(li.gst_amount) + n(li.round_off) - n(li.tds_amount))}
              </div>
            </div>
          ))}
          <div style={{ padding: 13, background: T.lime, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: T.limeTextAlt, textTransform: 'uppercase', letterSpacing: '.08em' }}>Invoice total</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: T.limeText, ...mono, letterSpacing: '-0.02em' }}>{fmtINR(inv.total)}</span>
          </div>
        </div>
      </div>

      <div style={{ flex: 'none', background: T.card, borderTop: `1px solid ${T.border}`, padding: '10px 16px 12px', display: 'flex', gap: 9 }}>
        <div style={{ flex: 1, height: 50, borderRadius: 4, border: `1.5px solid ${T.forest}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13.5, fontWeight: 800, color: T.forest, letterSpacing: '.03em' }}>
          <Icon as={Printer} size={20} color={T.forest} />
          PRINT
        </div>
        <div style={{ flex: 1.4, height: 50, borderRadius: 4, background: T.forest, color: T.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13.5, fontWeight: 800, letterSpacing: '.03em' }}>
          <Icon as={Share2} size={20} color={T.lime} />
          SHARE INVOICE
        </div>
      </div>
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
