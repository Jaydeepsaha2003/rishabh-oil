import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Undo2, ArrowLeft, AlertTriangle, BarChart3, Boxes, Building2, CalendarDays, DoorOpen, Eye,
  FileText, History, IndianRupee, Pencil, Plus, ScrollText, Search, Trash2, Truck, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { FyPicker } from '@/components/FyPicker'
import { ExcelButton } from '@/components/ExcelButton'
import { Pagination, usePaged } from '@/components/Pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { Tooltip, TooltipContent, TooltipTrigger, InfoTip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnFilter } from '@/components/ui/column-filter'
import { RowActions } from '@/components/ui/row-actions'
import { HistoryDialog, useHistoryDialog } from '@/components/HistoryDialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { computeMoney, computeShortage } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { isManufacturingParty } from '@/lib/constants'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TANKER_STAGES = ['supplier_factory', 'loaded', 'transit', 'outside_factory', 'inside_factory', 'empty']
const TANKER_LABEL: Record<string, string> = {
  supplier_factory: 'To be loaded',
  loaded: 'Loaded',
  transit: 'In transit',
  outside_factory: 'Outside factory',
  inside_factory: 'Inside factory',
  empty: 'Empty'
}

// Read an image file and return a downscaled JPEG data URL so weighment-slip
// photos stay small enough to live in the cloud DB (works for all users).
function fileToCompressedDataUrl(file: File, maxDim = 1280, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('That file is not a valid image'))
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Image processing is not supported'))
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function nextTankerStage(status: string): string | null {
  const i = TANKER_STAGES.indexOf(status)
  return i >= 0 && i < TANKER_STAGES.length - 1 ? TANKER_STAGES[i + 1] : null
}

// Whole days between two YYYY-MM-DD dates (toISO − fromISO).
function dayDiff(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO.slice(0, 10)}T00:00:00`).getTime()
  const b = new Date(`${toISO.slice(0, 10)}T00:00:00`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

// Delay status for a tanker that hasn't reached Empty yet, based on the
// expected delivery date computed from the port's transit days. Once the
// tanker has actually reached Outside factory, the delay is FIXED to how long
// that outward trip really took (outside factory date − loaded date, against
// the source's transit-day benchmark) — it stops growing with today's date,
// so a tanker sitting Inside factory doesn't keep racking up "delayed" days
// for time that was never spent in transit. Only a tanker still en route
// (no outside factory date yet) falls back to comparing against today.
function tankerDelay(row: Row): { label: string; tone: string } | null {
  if (!['transit', 'outside_factory', 'inside_factory'].includes(String(row.status))) return null
  const exp = String(row.expected_delivery_date || '').slice(0, 10)
  if (!exp) {
    // No ETA without a source to carry transit days — say why, rather than
    // just showing nothing under the stage badge.
    return row.source_id
      ? null
      : { label: 'No ETA — set a source (Edit)', tone: 'text-muted-foreground italic' }
  }
  const outsideDate = String(row.outside_factory_date || '').slice(0, 10)
  const days = dayDiff(exp, outsideDate || todayISO())
  if (days > 0) return { label: `Delayed ${days} day${days === 1 ? '' : 's'}`, tone: 'text-red-600' }
  if (days === 0) return outsideDate ? { label: 'On time', tone: 'text-emerald-600' } : { label: 'Due today', tone: 'text-amber-600' }
  return outsideDate
    ? { label: `Arrived ${-days}d early`, tone: 'text-emerald-600' }
    : { label: `ETA ${formatDate(exp)} · ${-days}d`, tone: 'text-muted-foreground' }
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant = status === 'empty' || status === 'received' ? 'success' : status === 'loaded' ? 'warning' : 'secondary'
  return <Badge variant={variant}>{TANKER_LABEL[status] ?? (status === 'received' ? 'Completed' : status)}</Badge>
}

// Movement-overview columns. Confirming loading jumps straight to transit, so
// 'loaded' looks transient — but Undo from In transit parks a tanker there and
// refuses to go back further, so it IS a resting state. Without a column of its
// own such a tanker was counted under "To be loaded" while its own row badge
// said Loaded.
const PIVOT_STAGES = [
  { key: 'supplier_factory', label: 'To be loaded' },
  { key: 'loaded', label: 'Loaded' },
  { key: 'transit', label: 'In transit' },
  { key: 'outside_factory', label: 'Outside factory' },
  { key: 'inside_factory', label: 'Inside factory' },
  { key: 'empty', label: 'Empty' }
]

// The stage a tanker is in as of `asOf` (its current/last stage on that date),
// so each tanker is counted once — a tanker in transit is NOT also "to be loaded".
// First day of the current month, YYYY-MM-DD.
function monthStartISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function stageAsOf(t: Row, asOf: string): string {
  const on = (d: unknown): boolean => {
    const s = String(d || '').slice(0, 10)
    return !!s && s <= asOf
  }
  if (on(t.empty_date)) return 'empty'
  if (on(t.inside_factory_date)) return 'inside_factory'
  if (on(t.outside_factory_date)) return 'outside_factory'
  if (on(t.transit_date)) return 'transit'
  // Loaded but not yet sent on its way — reached by undoing In transit, which
  // clears transit_date and leaves loaded_date standing. loaded_date alone will
  // not do: the column is NOT NULL and is stamped when the tanker is first sent
  // to the supplier, so a tanker that has never been loaded has one too. A
  // confirmed loaded_qty is what actually marks loading as done.
  if (on(t.loaded_date) && Number(t.loaded_qty) > 0) return 'loaded'
  return 'supplier_factory'
}

function MoneyRow({ label, value, strong, title }: { label: string; value: string; strong?: boolean; title?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm" title={title}>
      <span className={cn(strong ? 'font-semibold text-foreground' : 'text-muted-foreground', title && 'cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4')}>{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

// Small labeled fact card for a detail dialog's key figures — an icon +
// muted caption + the value, so a handful of facts read at a glance instead
// of as a stack of plain label/value lines.
function InfoTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-medium" title={value}>{value}</div>
      </div>
    </div>
  )
}

// Label-over-value, for a fact sitting inside a grid alongside others — a
// row-style label-left/value-right control (MoneyRow) squeezed into a narrow
// grid cell wraps its label and value onto separate lines that no longer
// line up with the cell next to it. Stacking removes that fight for width.
function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-sm" title={value}>{value}</div>
    </div>
  )
}

interface OrdersProps {
  focusId?: number | null
  onFocusHandled?: () => void
  onBack?: () => void
  backLabel?: string
}

export function Orders({ focusId, onFocusHandled, onBack, backLabel }: OrdersProps = {}): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('orders')
  const [tab, setTab] = useState('tankers')
  // Invoices with no live bargain link, and the mapping dialog state.
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCompany, setActiveCompany] = useState<number>(0)
  const [unmapped, setUnmapped] = useState<Row[]>([])
  const unmappedPaged = usePaged(unmapped)
  const [mapRow, setMapRow] = useState<Row | null>(null)
  const [mapLines, setMapLines] = useState<Row[]>([])
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapWarn, setMapWarn] = useState<string | null>(null)
  const [mapping, setMapping] = useState(false)

  const [rows, setRows] = useState<Row[]>([])
  // The purchase already booked under this invoice number, if any. Trimmed and
  // case-insensitive, scoped to the loaded register (already this company), so
  // the warning and the refusal on save agree on what a duplicate is.
  function invoiceClash(no: unknown, selfId: unknown): Row | null {
    const want = String(no || '').trim().toUpperCase()
    if (!want) return null
    return (
      rows.find(
        (r) => String(r.invoice_no || '').trim().toUpperCase() === want && Number(r.id) !== Number(selfId || 0)
      ) || null
    )
  }
  const [tankers, setTankers] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [sources, setSources] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pivotStart, setPivotStart] = useState(monthStartISO())
  const [pivotEnd, setPivotEnd] = useState(todayISO())
  // Clicking a pivot count filters the tanker list below to that oil × stage.
  const [pivotSel, setPivotSel] = useState<{ oil: string; stage: string } | null>(null)
  // Category filter for the whole tab — the pivot and the tanker list below it.
  // Empty = every category.
  const [tmCategory, setTmCategory] = useState<string[]>([])
  const tmCategories = useMemo(
    () => Array.from(new Set(tankers.map((t) => String(t.product_category || '')).filter(Boolean))).sort(),
    [tankers]
  )
  // The movement views can look across companies: 'active' shows the company
  // you are in, 'all' or a company id widens the lens.
  const [moveCompany, setMoveCompany] = useState('active')
  const [allTankers, setAllTankers] = useState<Row[]>([])
  // Free-text search over the movement views. Applied to moveTankers rather
  // than to one table, so the pivot counts, its Excel and the lists under it
  // all answer the same question — a count you cannot reconcile with the list
  // below it is worse than no search at all.
  const [moveSearch, setMoveSearch] = useState('')
  const moveTankers = useMemo(() => {
    const base = allTankers.length ? allTankers : tankers
    const cid = moveCompany === 'active' ? String(activeCompany) : moveCompany
    // A tanker only belongs to a company once an invoice books it there —
    // until then it is just a vehicle in the yard, and which set of books it
    // will be billed into is exactly what has not been decided yet. So an
    // unbilled tanker shows under EVERY company; once billed it settles into
    // the invoice's company and shows only there.
    const scoped =
      moveCompany === 'all' ? base : base.filter((t) => !t.order_id || String(t.company_id) === cid)
    const q = moveSearch.trim().toLowerCase()
    if (!q) return scoped
    // Every term has to match somewhere, so "rj09 mahuwa" narrows instead of
    // widening — the way anyone types two things they remember about a load.
    const terms = q.split(/\s+/)
    return scoped.filter((t) => {
      const hay = [
        t.tanker_no, t.gate_tanker_no, t.supplier_name, t.bargain_no, t.extra_bargain_no,
        t.oil_code, t.oil_name, t.invoice_no, t.transporter_name, t.source_name, t.gate_entry_no
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return terms.every((w) => hay.includes(w))
    })
  }, [moveCompany, tankers, allTankers, activeCompany, moveSearch])

  const inCategory = useCallback(
    (t: Row): boolean => !tmCategory.length || tmCategory.includes(String(t.product_category || '')),
    [tmCategory]
  )

  const [loadingOpen, setLoadingOpen] = useState(false)
  const [loadingForm, setLoadingForm] = useState<Row>({ tanker_count: 1, factory_entry_date: todayISO() })
  const [loadingRows, setLoadingRows] = useState<Row[]>([{}])
  const [actionRow, setActionRow] = useState<Row | null>(null)
  const [actionForm, setActionForm] = useState<Row>({})
  // Loading more than the bargain balance: the excess is either booked as a new
  // bargain (optional rate) or allocated to an existing next bargain.
  const [excess, setExcess] = useState<
    { qty: number; balance: number; mode: 'new' | 'existing' | 'expand'; diffRate: boolean; rate: string; targetBargainId: string } | null
  >(null)
  const [detailRow, setDetailRow] = useState<Row | null>(null)
  const [viewTankerRow, setViewTankerRow] = useState<Row | null>(null)
  // Tanker-count + quantity report, grouped by product/oil.
  const [reportOpen, setReportOpen] = useState(false)
  const [repFrom, setRepFrom] = useState('')
  const [repTo, setRepTo] = useState('')
  const [gateEntries, setGateEntries] = useState<Row[]>([])
  const [editTanker, setEditTanker] = useState<Row | null>(null)
  const [editTankerForm, setEditTankerForm] = useState<Row>({})

  const [formPage, setFormPage] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [products, setProducts] = useState<Row[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, pt, ptAll, b, s, src, tr, cfg, ge, um, co, act, prod] = await Promise.all([
      window.api.orders.list(),
      window.api.tankers.list(),
      // Every company's tankers, always — an unbilled tanker isn't tied to a
      // company yet, so both the movement register and the booking picker
      // need to see across all of them (each filters down its own way).
      window.api.tankers.list(true),
      window.api.bargains.list(undefined, undefined, undefined, 'orders'),
      window.api.data.list('suppliers'),
      window.api.data.list('sources'),
      window.api.data.list('transporters'),
      window.api.settings.all(),
      window.api.gate.list(),
      window.api.orders.unmapped(),
      window.api.company.list(),
      window.api.company.getActive(),
      window.api.data.list('products')
    ])
    setRows(o)
    setTankers(pt)
    setAllTankers(ptAll)
    setBargains(b)
    setSuppliers(s)
    setSources(src.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    setSettings(cfg)
    setGateEntries(ge)
    setUnmapped(um)
    setCompanies(co.filter((x) => x.active))
    setActiveCompany(Number(act?.id) || 0)
    setProducts(prod.filter((x) => x.active))
    setLoading(false)
  }, [])

  const [mapConfirm, setMapConfirm] = useState(false)
  // Bargains this invoice could be mapped to: same supplier, same product.
  const mapBargains = useMemo(
    () =>
      mapRow
        ? bargains.filter(
            (b) =>
              String(b.supplier_id) === String(mapRow.supplier_id) &&
              String(b.oil_type_id) === String(mapRow.oil_type_id)
          )
        : [],
    [bargains, mapRow]
  )
  const mapAllocated = mapLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
  const mapRemaining = (Number(mapRow?.ordered_qty) || 0) - mapAllocated
  const mapBargainValue = mapLines.reduce((sum, l) => {
    const b = bargains.find((x) => String(x.id) === String(l.bargain_id))
    return sum + (Number(b?.rate_per_uom) || 0) * (Number(l.qty) || 0)
  }, 0)
  const mapValueDiff = (Number(mapRow?.taxable_value) || 0) - mapBargainValue

  function openMap(row: Row): void {
    setMapRow(row)
    // Start with the whole invoice on one bargain; more can be added.
    setMapLines([{ bargain_id: '', qty: String(Number(row.ordered_qty) || 0), top_up: false }])
    setMapError(null)
    setMapWarn(null)
    setMapConfirm(false)
  }

  async function saveMapping(force: boolean): Promise<void> {
    if (!mapRow) return
    setMapError(null)
    if (mapLines.some((l) => !l.bargain_id)) return setMapError('Every line needs a bargain')
    if (mapLines.some((l) => (Number(l.qty) || 0) <= 0)) return setMapError('Every line needs a quantity')
    if (Math.abs(mapRemaining) > 0.0001) {
      return setMapError(
        mapRemaining > 0
          ? `${formatNum(mapRemaining)} ${mapRow.uom} of this invoice is still unallocated`
          : `The bargain quantities are ${formatNum(-mapRemaining)} ${mapRow.uom} more than the invoice`
      )
    }
    // Value mismatch is a warning, not a block: confirm on the second press.
    if (Math.abs(mapValueDiff) > 1 && !force && !mapConfirm) {
      setMapConfirm(true)
      setMapWarn(
        `The bargains price this invoice ${formatINR(Math.abs(mapValueDiff))} ${mapValueDiff > 0 ? 'lower' : 'higher'} than it was booked. Press Assign again to map it anyway.`
      )
      return
    }
    setMapping(true)
    try {
      const res = await window.api.orders.map(
        Number(mapRow.id),
        mapLines.map((l) => ({
          bargain_id: Number(l.bargain_id),
          qty: Number(l.qty) || 0,
          top_up: !!l.top_up
        })),
        true
      )
      const topped = (res.toppedUp || [])
        .map((t) => `${t.bargain_no} +${formatNum(t.qty)}`)
        .join(', ')
      toast.success(`Invoice ${mapRow.invoice_no} mapped${topped ? ` · raised ${topped}` : ''}`)
      setMapRow(null)
      await load()
    } catch (e) {
      const msg = (e as Error).message
      setMapError(msg.startsWith('VALUE_MISMATCH') ? 'The invoice value does not match the chosen bargains' : msg)
    } finally {
      setMapping(false)
    }
  }

  // Total gate-received qty for a tanker — completed weighments only; a pending
  // arrival (no weight yet) doesn't count. Null when nothing is completed.
  function gateQtyFor(tankerId: unknown): number | null {
    const list = gateEntries.filter(
      (g) => Number(g.tanker_id) === Number(tankerId) && String(g.status || 'completed') === 'completed'
    )
    if (!list.length) return null
    return list.reduce((s, g) => s + (Number(g.received_qty) || 0), 0)
  }

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Deep-link from Ledgers: open the booking invoice view for a specific order
  // once its data has loaded.
  useEffect(() => {
    if (!focusId) return
    const row = rows.find((r) => Number(r.id) === Number(focusId))
    if (!row) return
    openEditPurchase(row)
    setTab('purchases')
    onFocusHandled?.()
  }, [focusId, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // Oil-type × stage status matrix — each tanker counted ONCE in its current
  // stage as of the "To" date. Empty (finished) tankers are shown only if they
  // were emptied within [From, To]; in-progress tankers always show current stage.
  const pivot = useMemo(() => {
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    const dstr = (d: unknown): string => String(d || '').slice(0, 10)
    type Item = { bargain_no: string; supplier_name: string; tanker_no: string }
    type Cell = { count: number; qty: number; items: Item[] }
    const map = new Map<string, { label: string; cells: Record<string, Cell>; total: number }>()
    const totals: Record<string, number> = {}
    let grand = 0
    for (const t of moveTankers) {
      if (!inCategory(t)) continue
      const created = dstr(t.created_at)
      if (created && created > end) continue // didn't exist yet
      const stage = stageAsOf(t, end)
      // finished tankers only count if emptied within the window
      if (stage === 'empty') {
        const ed = dstr(t.empty_date)
        if (!(ed >= start && ed <= end)) continue
      }
      const key = String(t.oil_code || t.oil_name || '—')
      const label = key
      if (!map.has(key)) map.set(key, { label, cells: {}, total: 0 })
      const row = map.get(key)!
      const cell = (row.cells[stage] ??= { count: 0, qty: 0, items: [] })
      cell.count += 1
      cell.qty += Number(t.loaded_qty) || Number(t.received_qty) || 0
      cell.items.push({
        bargain_no: String(t.bargain_no || '—'),
        supplier_name: String(t.supplier_name || '—'),
        tanker_no: String(t.tanker_no || '')
      })
      row.total += 1
      totals[stage] = (totals[stage] || 0) + 1
      grand += 1
    }
    const rows = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
    return { rows, totals, grand }
  }, [moveTankers, pivotStart, pivotEnd, inCategory])

  // The pivot as Excel rows: one line per oil with its stage counts, then a line
  // per party under it — the breakdown the UI only shows on hover. Detail rows
  // are put on outline level 1 so Excel can collapse each oil.
  const pivotSheetRows = useMemo(() => {
    const out: Row[] = []
    for (const row of pivot.rows) {
      const r: Row = { oil: row.label, is_group: true, total: row.total }
      for (const st of PIVOT_STAGES) r[st.key] = row.cells[st.key]?.count || 0
      out.push(r)
      // party × stage under this oil
      const byParty = new Map<string, Row>()
      for (const st of PIVOT_STAGES) {
        for (const it of row.cells[st.key]?.items || []) {
          const k = it.supplier_name
          if (!byParty.has(k)) {
            const blank: Row = { oil: row.label, party: k, is_group: false, total: 0, tankers: [] as string[] }
            for (const x of PIVOT_STAGES) blank[x.key] = 0
            byParty.set(k, blank)
          }
          const pr = byParty.get(k) as Row
          pr[st.key] = (Number(pr[st.key]) || 0) + 1
          pr.total = (Number(pr.total) || 0) + 1
          ;(pr.tankers as string[]).push(`${it.tanker_no || '—'} (${it.bargain_no})`)
        }
      }
      for (const pr of Array.from(byParty.values()).sort((a, b) => String(a.party).localeCompare(String(b.party)))) {
        out.push({ ...pr, tanker_list: (pr.tankers as string[]).join(', ') })
      }
    }
    const grand: Row = { oil: 'GRAND TOTAL', is_group: true, total: pivot.grand }
    for (const st of PIVOT_STAGES) grand[st.key] = pivot.totals[st.key] || 0
    out.push(grand)
    return out
  }, [pivot])

  // The tanker list below the pivot follows the same date range — a tanker
  // belongs to the window if its loaded (or gate-entry) date falls within it.
  // When a pivot count is clicked, the list instead shows EXACTLY the tankers
  // that count includes (same oil × stage-as-of-window-end membership rule).
  const visibleTankers = useMemo(() => {
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    if (pivotSel) {
      return moveTankers.filter((t) => {
        if (!inCategory(t)) return false
        const created = String(t.created_at || '').slice(0, 10)
        if (created && created > end) return false
        const stage = stageAsOf(t, end)
        if (stage !== pivotSel.stage) return false
        if (stage === 'empty') {
          const ed = String(t.empty_date || '').slice(0, 10)
          if (!(ed >= start && ed <= end)) return false
        }
        return String(t.oil_code || t.oil_name || '—') === pivotSel.oil
      })
    }
    return moveTankers.filter((t) => {
      if (!inCategory(t)) return false
      // A tanker still short of Empty is outstanding work, not "history" —
      // it stays visible regardless of the date window (and so does its
      // delay flag) until it actually reaches Empty.
      if (String(t.status) !== 'empty') return true
      // Same rule the pivot above it uses: a finished tanker belongs to the
      // window by the day it was actually EMPTIED (received), not the day it
      // was loaded — filtering by loaded_date here let the pivot's count
      // include a tanker (loaded before the window, received inside it)
      // while this list silently dropped it, so the two disagreed.
      const d = String(t.empty_date || '').slice(0, 10)
      return !!d && d >= start && d <= end
    })
  }, [moveTankers, pivotStart, pivotEnd, pivotSel, inCategory])
  // Split of the SAME set above — not a wider query — by whether the tanker
  // was also LOADED inside the window. Together these two always add up to
  // visibleTankers.length; nothing outside that count is pulled in.
  const [inLoadedRangeTankers, outOfRangeTankers] = useMemo(() => {
    if (pivotSel) return [visibleTankers, [] as Row[]]
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    const inR: Row[] = []
    const outR: Row[] = []
    for (const t of visibleTankers) {
      const d = String(t.loaded_date || '').slice(0, 10)
      const loadedInRange = !!d && d >= start && d <= end
      ;(loadedInRange ? inR : outR).push(t)
    }
    return [inR, outR]
  }, [visibleTankers, pivotStart, pivotEnd, pivotSel])
  const tankerPaged = usePaged(inLoadedRangeTankers)
  const outOfRangePaged = usePaged(outOfRangeTankers)

  // Shared row markup for the tanker list — used for both the in-range table
  // and the out-of-range one below it, so the two stay visually identical.
  function renderTankerRow(row: Row): React.JSX.Element {
    const next = nextTankerStage(row.status)
    return <TableRow key={row.id}>
      <TableCell><div className={cn('font-medium', !String(row.tanker_no || '').trim() && 'italic text-muted-foreground')}>{String(row.tanker_no || '').trim() || 'No number yet'}</div><div className="text-xs text-muted-foreground">{row.status === 'supplier_factory' ? `Entered ${formatDate(row.loaded_date)}` : `Loaded ${formatDate(row.loaded_date)}`}</div>{!!row.gate_entry_no && (
          <div className="mt-0.5 text-[11px] text-sky-700">
            Gate {row.gate_entry_no}
            {row.gate_tanker_no && String(row.gate_tanker_no).trim() !== String(row.tanker_no || '').trim()
              ? ` · vehicle ${row.gate_tanker_no}`
              : ''}
            {Number(row.gate_qty) > 0 ? ` · weighed ${formatNum(row.gate_qty)}` : ''}
          </div>
        )}{!!row.last_replacement && (
          <div className="mt-0.5 text-[11px] text-amber-700" title="Tanker replaced en route">
            Replaced: {row.last_replacement}
          </div>
        )}</TableCell>
      <TableCell>
        <div>{row.supplier_name}</div>
        <div className="text-xs text-muted-foreground">
          {row.bargain_no}
          {row.extra_bargain_no && (
            <span title={`Split: ${formatNum((Number(row.loaded_qty) || 0) - (Number(row.extra_qty) || 0))} ${row.uom} + ${formatNum(row.extra_qty)} ${row.uom} excess`}>
              {' '}+ {row.extra_bargain_no} <span className="text-sky-600">(split)</span>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{Number(row.loaded_qty) > 0 ? `${formatNum(row.loaded_qty)} ${row.uom}` : 'Not loaded'}</TableCell>
      <TableCell>{row.payment_mode === 'pending' ? <span className="text-muted-foreground">Not decided</span> : row.payment_mode === 'supplier_finance' ? <Badge variant="warning">Supplier financed</Badge> : <Badge variant="muted">Paid by us</Badge>}</TableCell>
      <TableCell>{row.invoice_no || <span className="text-muted-foreground">Not entered</span>}</TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
        {(() => {
          const d = tankerDelay(row)
          return d ? <div className={cn('mt-1 text-[11px] font-medium', d.tone)}>{d.label}</div> : null
        })()}
      </TableCell>
      {/* Moving the tanker on is the only action worth a real button — undo,
          edit, replace and delete all sit behind the ⋮, which keeps this
          column narrow and gives the table's own data the width. */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {next && (
            <Button size="sm" variant="outline" onClick={() => openTankerAction(row)}>
              {TANKER_LABEL[next]}
            </Button>
          )}
          <RowActions
            actions={[
              { label: 'View tanker', icon: Eye, onClick: () => setViewTankerRow(row) },
              ...(TANKER_STAGES.indexOf(String(row.status)) > TANKER_STAGES.indexOf('loaded')
                ? [{
                    label: `Undo — back to ${TANKER_LABEL[TANKER_STAGES[TANKER_STAGES.indexOf(String(row.status)) - 1]]}`,
                    icon: Undo2,
                    onClick: () => void revertTanker(row)
                  }]
                : []),
              { label: 'Edit stage entries', icon: Pencil, onClick: () => openEditTanker(row) },
              ...(row.status === 'transit'
                ? [{ label: 'Replace tanker', icon: Truck, onClick: () => openReplaceTanker(row) }]
                : []),
              {
                label: 'Delete tanker',
                icon: Trash2,
                danger: true,
                onClick: () => void deleteTanker(row),
                disabled: !!row.order_id,
                disabledReason: 'Billed on a purchase invoice — delete that invoice first'
              }
            ]}
          />
        </div>
      </TableCell>
    </TableRow>
  }

  function tankerTableHeader(): React.JSX.Element {
    return <TableHeader><TableRow className="bg-muted/60">
      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Tanker</TableHead><TableHead className="text-[10px] font-semibold uppercase tracking-wide">Supplier / bargain</TableHead><TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Loaded qty</TableHead>
      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Payment</TableHead><TableHead className="text-[10px] font-semibold uppercase tracking-wide">Invoice</TableHead><TableHead className="text-[10px] font-semibold uppercase tracking-wide">Stage</TableHead><TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Action</TableHead>
    </TableRow></TableHeader>
  }
  // A tanker's governing EX/DLD condition — its own choice when one was made
  // when it was sent to the supplier, otherwise its bargain's. Mirrors
  // tankerIsEx() in the backend, which is what actually posts the freight and
  // the shortage penalty.
  function condIsEx(t: Row): boolean {
    const own = String(t.condition ?? '').trim().toUpperCase()
    if (own) return own !== 'DLD' && own !== 'DELIVERED'
    return !['DLD', 'DELIVERED'].includes(String(t.bargain_type || '').toUpperCase())
  }

  // What to show as the invoice's condition. A tanker-based purchase is
  // governed per tanker, so it's read off the tankers rather than off the
  // invoice's own frozen bargain_type — that copy is taken when the invoice is
  // booked and can end up disagreeing with the bargain it points at.
  function invoiceCondition(row: Row): string {
    const list = tankers.filter((t) => Number(t.order_id) === Number(row.id))
    if (!list.length) {
      return ['DLD', 'DELIVERED'].includes(String(row.bargain_type || '').toUpperCase())
        ? 'DLD — delivered'
        : 'EX — ex-works'
    }
    const ex = list.filter((t) => condIsEx(t)).length
    if (ex === list.length) return 'EX — ex-works'
    if (ex === 0) return 'DLD — delivered'
    return `Mixed — ${ex} EX, ${list.length - ex} DLD`
  }

  // Purchase entries filters: a date range on the invoice date, and the product
  // category. Both narrow the list the page shows and exports.
  const [poFrom, setPoFrom] = useState('')
  const [poTo, setPoTo] = useState('')
  // Empty = every category.
  const [poCategory, setPoCategory] = useState<string[]>([])
  // ON by default: also pull in a purchase whose invoice date is outside the
  // window but a tanker on it was received inside it. Switching it off goes
  // back to strictly the invoice date.
  const [poIncludeReceipt, setPoIncludeReceipt] = useState(true)
  // Excel-style per-column filters on the Purchase entries table. Empty = that
  // column isn't filtering. Keyed by the column's own field so one state object
  // covers every column instead of a useState each.
  const [poCols, setPoCols] = useState<Record<string, string[]>>({})
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (!globalRangeAppliesTo(globalRange, 'orders')) return
    setPoFrom(globalRange.from); setPoTo(globalRange.to)
    setRepFrom(globalRange.from); setRepTo(globalRange.to)
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const poCategories = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.product_category || '')).filter(Boolean))).sort(),
    [rows]
  )
  // The Purchase entries columns that carry an Excel-style header filter, and
  // how each one reads its value off a row. Money/quantity columns format the
  // same way the cell does, so the dropdown lists exactly what's on screen.
  // The deductible on one tanker: shortage beyond the agreed tolerance, valued
  // at the tanker's own bargain rate. Computed live rather than read from the
  // stored shortage_charge_amount, because that column is only written when a
  // tanker is emptied through the current code path — tankers emptied earlier
  // carry 0 and would silently read as "nothing to deduct".
  //
  // Shared by the invoice View and the Purchases list so the two can never
  // disagree: the list used to read the stored figure while the View computed
  // it, which is exactly how a purchase could show a deductible in its detail
  // and an unflagged EX chip in the table.
  function tankerDeduct(t: Row, orderRow: Row): {
    t: Row
    loaded: number
    rec: number | null
    shortage: number | null
    allowedAmt: number
    deductible: number | null
    extraQty: number
    primaryQty: number
    primaryRate: number
    extraRate: number
    bargainRate: number
    deductibleValue: number | null
  } {
    const loaded = Number(t.loaded_qty) || 0
    const rec = t.status === 'empty' && t.received_qty != null ? Number(t.received_qty) : null
    const shortage = rec != null ? Math.max(0, loaded - rec) : null
    // Per tanker, matching the backend: its own EX/DLD choice when one was
    // made, else its bargain's. Deliberately NOT the invoice's frozen
    // bargain_type, which can disagree with the bargain it points at.
    const rowIsEx = condIsEx(t)
    // An order- or bargain-specific override wins if set, otherwise the
    // company-wide default — NOT a bare 0%, which would flag any shortage at
    // all as deductible whenever neither override was set.
    const pct = Number(
      t.order_allowed_shortage_pct ?? orderRow.allowed_shortage_pct ?? t.allowed_shortage_pct ?? settings.allowed_shortage_pct ?? 0
    )
    const allowedAmt = loaded > 0 ? (loaded * pct) / 100 : 0
    const deductible = rowIsEx && shortage != null && shortage > allowedAmt ? shortage - allowedAmt : null
    // Priced at the tanker's own bargain rate, not the invoice rate. A tanker
    // split across two bargains blends both by the qty each carries, so the
    // second bargain's rate is not silently dropped.
    const extraQty = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
    const primaryQty = Math.max(0, loaded - extraQty)
    const primaryRate = Number(t.bargain_rate) || 0
    const extraRate = Number(t.extra_bargain_rate) || 0
    const bargainRate = loaded > 0 ? (primaryQty * primaryRate + extraQty * extraRate) / loaded : primaryRate
    return {
      t, loaded, rec, shortage, allowedAmt, deductible,
      extraQty, primaryQty, primaryRate, extraRate, bargainRate,
      deductibleValue: deductible != null ? deductible * bargainRate : null
    }
  }

  // Summed across an invoice's tankers.
  function orderDeductValue(r: Row): number {
    return tankers
      .filter((t) => Number(t.order_id) === Number(r.id))
      .reduce((sum, t) => sum + (tankerDeduct(t, r).deductibleValue ?? 0), 0)
  }

  // Freight on a purchase, and the part of it to be taken back by debit note.
  // Two figures only: what the transporter earned, and what comes off it for
  // the shortage beyond tolerance. The netting itself is unchanged — the ledger
  // already carries freight less shortage — so this is the paperwork view of the
  // same deduction.
  // Who carried this invoice and at what rate. Per tanker, because every
  // vehicle is priced on its own rate.
  function poCarriers(r: Row): { tanker: string; name: string; rate: number }[] {
    return tankers
      .filter((t) => Number(t.order_id) === Number(r.id))
      .map((t) => ({
        tanker: String(t.tanker_no || ''),
        name: String(t.transporter_name || ''),
        rate: Number(t.transport_rate_per_ton) || 0
      }))
  }

  function poFreight(r: Row): { freight: number; deduct: number } {
    return {
      freight: Math.round((Number(r.tanker_freight_total) || 0) * 100) / 100,
      deduct: Math.round(orderDeductValue(r) * 100) / 100
    }
  }

  const PO_COLUMNS: { key: string; label: string; of: (r: Row) => string }[] = useMemo(
    () => [
      { key: 'invoice_no', label: 'Invoice', of: (r) => String(r.invoice_no || '') },
      { key: 'supplier_name', label: 'Supplier', of: (r) => String(r.supplier_name || '') },
      { key: 'product_category', label: 'Category', of: (r) => String(r.product_category || '') },
      { key: 'oil_label', label: 'Product', of: (r) => String(r.oil_code || r.oil_name || '') },
      { key: 'tanker_count', label: 'Tankers', of: (r) => String(Number(r.tanker_count) || 0) },
      { key: 'ordered_qty', label: 'Quantity', of: (r) => `${formatNum(r.ordered_qty)} ${r.uom || ''}`.trim() },
      { key: 'net_amount', label: 'Net amount', of: (r) => formatINR(r.net_amount) },
      {
        // Matches exactly what the cell shows — the condition, flagged when a
        // debit note is due. A filter offering values the column never displays
        // hides rows that visibly say otherwise.
        key: 'shortage',
        label: 'Freight',
        of: (r) => {
          const cond = invoiceCondition(r).split(' — ')[0].split(' ')[0]
          return Number(r.tanker_shortage_charged) > 0 ? `${cond} · Dr note due` : cond
        }
      },
      { key: 'status', label: 'Status', of: (r) => (r.status === 'received' ? 'Completed' : 'In process') }
    ],
    // The Freight column reads the tankers behind each invoice, so the memo has
    // to rebuild when they load — otherwise the dropdown offers a condition
    // worked out from an empty tanker list while the cell shows the real one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tankers]
  )

  // Rows that pass every filter EXCEPT this column's own — so each dropdown
  // lists the values still reachable given the other filters, the way Excel
  // narrows its lists, instead of always offering the whole table.
  function poColOptions(key: string): { value: string; label: string }[] {
    const col = PO_COLUMNS.find((c) => c.key === key)
    if (!col) return []
    const seen = new Set<string>()
    for (const r of poBaseRows) {
      let ok = true
      for (const other of PO_COLUMNS) {
        if (other.key === key) continue
        const sel = poCols[other.key]
        if (sel?.length && !sel.includes(other.of(r))) { ok = false; break }
      }
      if (ok) seen.add(col.of(r))
    }
    return Array.from(seen)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((v) => ({ value: v, label: v || '(blank)' }))
  }

  // Everything the date/category/trading rules allow — the pool the column
  // filters then narrow, and the pool their dropdowns are built from.
  const poBaseRows = useMemo(
    () =>
      rows
        .map((r): Row => {
          const d = String(r.order_date || '').slice(0, 10)
          const invoicedInRange = (!poFrom || d >= poFrom) && (!poTo || d <= poTo)
          // The invoice date alone can sit days before the tanker actually
          // arrives and gets weighed — so a purchase also belongs to the
          // window if any of its tankers was RECEIVED (reached Empty) inside
          // it, even when the invoice itself was raised outside the range.
          const receivedInRange =
            poIncludeReceipt &&
            !invoicedInRange &&
            tankers.some((t) => {
              if (Number(t.order_id) !== Number(r.id)) return false
              const rd = String(t.empty_date || '').slice(0, 10)
              if (!rd) return false
              if (poFrom && rd < poFrom) return false
              if (poTo && rd > poTo) return false
              return true
            })
          return { ...r, _shownForReceipt: receivedInRange, _inWindow: invoicedInRange || receivedInRange }
        })
        .filter((r) => {
          if (!r._inWindow) return false
          // Trading is a pass-through deal booked and tracked on its own page —
          // it never touches this supplier's regular purchase relationship, so
          // it does not belong in this register.
          if (Number(r.is_trading) === 1) return false
          if (poCategory.length && !poCategory.includes(String(r.product_category || ''))) return false
          return true
        }),
    [rows, tankers, poFrom, poTo, poCategory, poIncludeReceipt]
  )

  const filteredOrders = useMemo(
    () =>
      poBaseRows.filter((r) =>
        PO_COLUMNS.every((c) => {
          const sel = poCols[c.key]
          return !sel?.length || sel.includes(c.of(r))
        })
      ),
    [poBaseRows, poCols, PO_COLUMNS]
  )
  const orderPaged = usePaged(filteredOrders)

  // Row fields derived from a bargain (auto or manual pick).
  function bargainDefaults(b: Row): Row {
    return {
      bargain_id: b.id,
      supplier_id: b.supplier_id,
      oil_type_id: b.oil_type_id,
      supplier_name: b.supplier_name,
      oil_label: String(b.oil_code || b.oil_name || ''),
      uom: b.uom,
      balance_qty: b.balance_qty,
      // default the condition (EX/DLD) from the bargain; user can toggle it
      condition: ['DLD', 'Delivered'].includes(String(b.bargain_type)) ? 'DLD' : 'EX'
    }
  }

  function selectLoadingBargain(index: number, id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    setLoadingRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...bargainDefaults(b) } : row))
    )
  }

  // Distinct oils that actually have bargains (route step 1).
  const bargainOils = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bargains) {
      const id = String(b.oil_type_id)
      if (!m.has(id)) m.set(id, String(b.oil_code || b.oil_name || '—'))
    }
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [bargains])

  // Suppliers with bargains for the picked oil (route step 2). Suppliers marked
  // "Direct purchase" in the master never receive a tanker, so they are left out.
  function suppliersForOil(oilId: string): { id: string; name: string }[] {
    const m = new Map<string, string>()
    const direct = new Set(
      suppliers.filter((s) => s.skip_tanker_stages).map((s) => String(s.id))
    )
    for (const b of bargains.filter((x) => String(x.oil_type_id) === oilId)) {
      if (direct.has(String(b.supplier_id))) continue
      m.set(String(b.supplier_id), String(b.supplier_name || '—'))
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // Bargains matching the dialog-level oil + supplier picks, oldest first.
  function routeBargains(picks: Row): Row[] {
    if (!picks.oil_pick || !picks.supplier_pick) return []
    return bargains
      .filter((b) => String(b.oil_type_id) === picks.oil_pick && String(b.supplier_id) === picks.supplier_pick)
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }

  // Oil picked once for the whole dialog — reset supplier and row bargains.
  function pickOil(oilId: string): void {
    setLoadingForm((p) => ({ ...p, oil_pick: oilId, supplier_pick: '', auto_bargain_id: '' }))
    setLoadingRows((current) =>
      current.map((row) => ({ ...row, bargain_id: '', supplier_name: '', balance_qty: undefined }))
    )
  }

  // Supplier picked once — auto-select the OLDEST bargain (preferring balance
  // left) and apply it to every tanker row; each row stays changeable.
  function pickSupplier(supplierId: string): void {
    const candidates = routeBargains({ oil_pick: loadingForm.oil_pick, supplier_pick: supplierId })
    const pick = candidates.find((b) => Number(b.balance_qty) > 0.005) || candidates[0]
    setLoadingForm((p) => ({ ...p, supplier_pick: supplierId, auto_bargain_id: pick ? String(pick.id) : '' }))
    if (pick) {
      setLoadingRows((current) => current.map((row) => ({ ...row, ...bargainDefaults(pick) })))
    }
  }

  function setTankerCount(value: string): void {
    const count = Math.max(1, Math.min(20, Number(value) || 1))
    // new rows inherit the dialog's auto-picked bargain
    const auto = bargains.find((b) => String(b.id) === String(loadingForm.auto_bargain_id))
    setLoadingForm((p) => ({ ...p, tanker_count: count }))
    setLoadingRows((current) =>
      Array.from({ length: count }, (_, i) => current[i] || (auto ? bargainDefaults(auto) : {}))
    )
  }

  async function createTanker(): Promise<void> {
    if (loadingRows.some((row) => !row.bargain_id)) {
      toast.error('Select the bargain for every tanker (the tanker number can be set at loading)')
      return
    }
    try {
      for (const row of loadingRows) {
        await window.api.tankers.create({
          ...row,
          condition: row.condition || 'EX',
          transporter_id: row.transporter_id ? Number(row.transporter_id) : null,
          factory_entry_date: loadingForm.factory_entry_date
        })
      }
      toast.success(`${loadingRows.length} tanker${loadingRows.length === 1 ? '' : 's'} sent to supplier — ready to be loaded`)
      setLoadingOpen(false)
      setLoadingForm({ tanker_count: 1, factory_entry_date: todayISO() })
      setLoadingRows([{}])
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function deleteTanker(row: Row): Promise<void> {
    if (!window.confirm(`Delete tanker ${row.tanker_no}?`)) return
    try {
      await window.api.tankers.remove(row.id)
      toast.success('Tanker deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openTankerAction(row: Row): void {
    const target = nextTankerStage(row.status)
    if (!target) return
    // Invoice gate: after loading, billing is mandatory before moving further.
    if (target === 'outside_factory' && !row.order_id) {
      toast.error(`Tanker ${row.tanker_no} is not billed yet — create the purchase invoice first`)
      return
    }
    const next: Row = {}
    if (target === 'loaded') Object.assign(next, {
      loaded_date: todayISO(),
      loaded_qty: '',
      payment_mode: 'paid_by_us',
      source_id: row.source_id ? String(row.source_id) : '',
      tanker_no: String(row.tanker_no || ''),
      bargain_id: String(row.bargain_id || '')
    })
    if (target === 'transit')
      Object.assign(next, {
        transit_date: todayISO(),
        // Whatever was picked at loading, so this step confirms rather than asks
        // again — and an untouched field can no longer blank it.
        source_id: row.source_id ? String(row.source_id) : '',
        transporter_id: row.transporter_id ? String(row.transporter_id) : '',
        // Whatever is already on the tanker wins; otherwise the transporter
        // master's default rate, so the common case is one keystroke.
        transport_rate_per_ton:
          row.transport_rate_per_ton ??
          transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton ??
          ''
      })
    if (target === 'outside_factory') next.outside_factory_date = todayISO()
    if (target === 'inside_factory') next.inside_factory_date = todayISO()
    if (target === 'empty') Object.assign(next, {
      empty_date: todayISO(),
      // prefill with the gate-received qty so the gate cross-check passes
      received_qty: gateQtyFor(row.id) ?? row.loaded_qty,
      transporter_id: row.transporter_id || '',
      // What was agreed when the tanker set off wins. Only fall back to the
      // transporter master's default for a tanker that reached transit before
      // the rate was asked for there — otherwise this asked again from blank
      // and the freight came out at zero.
      transport_rate_per_ton:
        Number(row.transport_rate_per_ton) > 0
          ? row.transport_rate_per_ton
          : transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton || ''
    })
    setActionForm(next)
    setExcess(null)
    setActionRow(row)
  }

  // Step a tanker BACK one stage (mistake correction, e.g. Outside factory
  // pressed too early). The abandoned stage's date is cleared server-side.
  async function revertTanker(row: Row): Promise<void> {
    const idx = TANKER_STAGES.indexOf(String(row.status))
    const prev = idx > 0 ? TANKER_STAGES[idx - 1] : null
    if (!prev) return
    if (!confirm(`Move tanker ${row.tanker_no || ''} back from ${TANKER_LABEL[String(row.status)]} to ${TANKER_LABEL[prev]}?`)) return
    try {
      await window.api.tankers.revert(Number(row.id))
      toast.success(`Back to ${TANKER_LABEL[prev]}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Swap the physical vehicle mid-transit (accident, breakdown) — the bargain
  // and financials on this tanker stay put, only the number changes and
  // whatever quantity was lost comes off what it's now expected to deliver.
  const [replaceRow, setReplaceRow] = useState<Row | null>(null)
  const [replaceForm, setReplaceForm] = useState<Row>({})
  const [replaceSaving, setReplaceSaving] = useState(false)
  const [replaceError, setReplaceError] = useState<string | null>(null)

  function openReplaceTanker(row: Row): void {
    setReplaceRow(row)
    setReplaceForm({ new_tanker_no: '', loss_qty: '', reason: '', date: todayISO() })
    setReplaceError(null)
  }

  async function saveReplaceTanker(): Promise<void> {
    if (!replaceRow) return
    if (!String(replaceForm.new_tanker_no || '').trim()) return setReplaceError('Enter the replacement tanker number')
    setReplaceSaving(true)
    setReplaceError(null)
    try {
      await window.api.tankers.replace(Number(replaceRow.id), {
        new_tanker_no: replaceForm.new_tanker_no,
        loss_qty: Number(replaceForm.loss_qty) || 0,
        reason: replaceForm.reason || null,
        date: replaceForm.date || todayISO()
      })
      toast.success(`Tanker replaced with ${replaceForm.new_tanker_no}`)
      setReplaceRow(null)
      load()
    } catch (e) {
      setReplaceError((e as Error).message)
    } finally {
      setReplaceSaving(false)
    }
  }

  function openEditTanker(row: Row): void {
    setEditTanker(row)
    setEditTankerForm({
      tanker_no: row.tanker_no || '',
      bargain_id: String(row.bargain_id || ''),
      loaded_date: row.loaded_date || '',
      loaded_qty: row.loaded_qty ?? '',
      payment_mode: row.payment_mode || 'pending',
      transit_date: row.transit_date || '',
      source_id: row.source_id ? String(row.source_id) : '',
      outside_factory_date: row.outside_factory_date || '',
      inside_factory_date: row.inside_factory_date || '',
      empty_date: row.empty_date || '',
      received_qty: row.received_qty ?? '',
      transporter_id: row.transporter_id ? String(row.transporter_id) : '',
      transport_rate_per_ton: row.transport_rate_per_ton ?? '',
      krfl_weighment_doc_no: row.krfl_weighment_doc_no || '',
      outside_weighment_doc_no: row.outside_weighment_doc_no || '',
      // Blank = follow the bargain, which is what an un-overridden tanker does.
      condition: row.condition || ''
    })
  }

  // Within the 1 MT gate buffer a shortfall is allowed, but only after the user
  // explicitly confirms the variance. Returns false when the user backs out.
  function confirmGateVariance(tankerId: unknown, receivedQty: number): boolean {
    const gq = gateQtyFor(tankerId)
    if (gq == null || !(receivedQty > 0)) return true
    const diff = Math.abs(gq - receivedQty)
    if (diff <= 0.005 || diff > 1) return true // exact match, or blocked by the backend anyway
    return window.confirm(
      `Received qty (${formatNum(receivedQty)}) differs from the gate weighment (${formatNum(gq)}) by ${formatNum(diff)} MT.\n\nThis is within the allowed 1 MT buffer — save anyway?`
    )
  }

  async function saveEditTanker(): Promise<void> {
    if (!editTanker) return
    const recv = Number(editTankerForm.received_qty)
    if (recv > 0 && !confirmGateVariance(editTanker.id, recv)) return
    try {
      await window.api.tankers.update(editTanker.id, {
        ...editTankerForm,
        bargain_id: editTankerForm.bargain_id ? Number(editTankerForm.bargain_id) : null,
        source_id: editTankerForm.source_id ? Number(editTankerForm.source_id) : null,
        transporter_id: editTankerForm.transporter_id ? Number(editTankerForm.transporter_id) : null
      })
      toast.success('Tanker updated')
      setEditTanker(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function onWeighmentPhoto(field: string, file: File | undefined): Promise<void> {
    if (!file) return
    try {
      const url = await fileToCompressedDataUrl(file)
      setActionForm((p) => ({ ...p, [field]: url }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function advanceTanker(): Promise<void> {
    if (!actionRow) return
    const target = nextTankerStage(actionRow.status)
    if (!target) return
    if (target === 'loaded' && !String(actionForm.tanker_no || '').trim()) {
      toast.error('Enter the tanker number')
      return
    }
    if (target === 'loaded' && Number(actionForm.loaded_qty) <= 0) {
      toast.error('Enter the actual loaded quantity')
      return
    }
    if (target === 'transit' && !actionForm.source_id) {
      toast.error('Select the source / port')
      return
    }
    if (target === 'empty' && !confirmGateVariance(actionRow.id, Number(actionForm.received_qty))) {
      return
    }
    if (target === 'empty' && !['DLD', 'Delivered'].includes(String(actionRow.bargain_type)) && !actionForm.transporter_id) {
      toast.error('Select a transporter')
      return
    }
    // More qty on the truck than the bargain has left: pause and ask before
    // booking the excess as a fresh bargain line (rate confirmed by the user).
    if (target === 'loaded' && !excess) {
      const b = bargains.find((x) => String(x.id) === String(actionForm.bargain_id))
      const balance = Math.max(Number(b?.balance_qty) || 0, 0)
      const over = (Number(actionForm.loaded_qty) || 0) - balance
      if (b && over > 1e-6) {
        setExcess({
          qty: Math.round(over * 1000) / 1000,
          balance,
          mode: 'new',
          diffRate: false,
          rate: String(b.rate_per_uom ?? ''),
          targetBargainId: ''
        })
        return
      }
    }
    // Excess allocated to an existing bargain requires that choice.
    if (target === 'loaded' && excess && excess.mode === 'existing' && !excess.targetBargainId) {
      toast.error('Select the next bargain for the excess quantity')
      return
    }
    try {
      await window.api.tankers.advance(actionRow.id, target, {
        ...actionForm,
        loaded_qty: Number(actionForm.loaded_qty) || 0,
        allow_excess: !!excess,
        expand_bargain: !!excess && excess.mode === 'expand',
        excess_rate: excess && excess.mode === 'new' && excess.diffRate && Number(excess.rate) > 0 ? Number(excess.rate) : null,
        extra_bargain_id: excess && excess.mode === 'existing' && excess.targetBargainId ? Number(excess.targetBargainId) : null,
        bargain_id: actionForm.bargain_id ? Number(actionForm.bargain_id) : null,
        source_id: actionForm.source_id ? Number(actionForm.source_id) : null,
        transporter_id: actionForm.transporter_id ? Number(actionForm.transporter_id) : null,
        received_qty: Number(actionForm.received_qty) || 0,
        transport_rate_per_ton: Number(actionForm.transport_rate_per_ton) || 0,
        krfl_weighment_doc_no: actionForm.krfl_weighment_doc_no || null,
        krfl_weighment_photo: actionForm.krfl_weighment_photo || null,
        outside_weighment_doc_no: actionForm.outside_weighment_doc_no || null,
        outside_weighment_photo: actionForm.outside_weighment_photo || null
      })
      if (target === 'loaded' && excess) {
        toast.success(
          excess.mode === 'existing'
            ? `Loading confirmed — extra ${formatNum(excess.qty)} allocated to the selected bargain`
            : excess.mode === 'expand'
              ? `Loading confirmed — bargain increased by ${formatNum(excess.qty)}`
              : `Loading confirmed — extra ${formatNum(excess.qty)} added as a new bargain`
        )
      } else {
        toast.success(target === 'loaded' ? 'Loading confirmed — mark it In transit when it sets off' : `Tanker moved to ${TANKER_LABEL[target]}`)
      }
      setActionRow(null)
      setExcess(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Supplier-first invoice booking: pick the supplier, then choose from ALL its
  // unbilled loaded tankers. The bargain details follow from the chosen tankers.
  function choosePurchaseSupplier(id: string): void {
    const s = suppliers.find((x) => String(x.id) === id)
    if (!s) return
    setForm((p) => ({
      ...p,
      supplier_id: s.id,
      supplier_name: s.name,
      bargain_id: '',
      bargain_type: '',
      bargain_rate: '',
      oil_type_id: '',
      oil_label: '',
      invoice_rate: '',
      invoice_rate_touched: false,
      gst_pct: s.gst_pct ?? 0,
      tds_pct: s.tds_pct ?? 0,
      tds_threshold: s.tds_threshold ?? 0,
      tds_above_only: !!s.tds_above_only,
      adds_interest: !!s.adds_interest,
      interest_pct: s.interest_pct ?? 0,
      interest_days: s.interest_days ?? 0
    }))
    setSelected([])
    setLotIds([])
    setLotBargains({})
    setBgLines([{ bargain_id: '', qty: '' }])
    setBgTouched(false)
  }

  function choosePurchaseBargain(id: string, keepSelection = false): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    const supplier = suppliers.find((x) => x.id === b.supplier_id)
    setForm((p) => ({
      ...p,
      bargain_id: b.id,
      supplier_id: b.supplier_id,
      oil_type_id: b.oil_type_id,
      bargain_type: b.bargain_type,
      bargain_rate: b.rate_per_uom,
      supplier_name: b.supplier_name,
      oil_label: String(b.oil_code || b.oil_name || ''),
      uom: b.uom,
      // follow the bargain's rate unless the user typed one themselves
      invoice_rate: p.invoice_rate_touched && p.invoice_rate ? p.invoice_rate : b.rate_per_uom,
      gst_pct: supplier?.gst_pct ?? 0,
      tds_pct: supplier?.tds_pct ?? 0,
      tds_threshold: supplier?.tds_threshold ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      adds_interest: !!supplier?.adds_interest,
      interest_pct: supplier?.interest_pct ?? 0,
      interest_days: supplier?.interest_days ?? 0
    }))
    if (!keepSelection) setSelected([])
  }

  function openNewPurchase(): void {
    setEditing(null)
    setForm({ company_id: String(activeCompany || ''), invoice_no: '', order_date: todayISO(), is_registered_transporter: true, transporter_id: '', gst_type: 'CGST_SGST', allowed_shortage_pct: '', round_off: '', round_off_manual: false, rate_round_off: '0', charge_interest: false, interest_touched: false, remarks: '', freight_paid_to_supplier: false, bargain_interest: {} })
    setSelected([])
    setLotIds([])
    setLotBargains({})
    setBgLines([{ bargain_id: '', qty: '' }])
    setBgTouched(false)
    setError(null)
    setFormPage(true)
    setTab('purchases')
  }

  // Whatever has been written against the bargains this invoice was drawn
  // against -- the bargain's own remarks and every quantity adjustment note.
  // Fetched when the details dialog opens, not with the register, so a page
  // refresh does not pay for notes nobody has asked to see.
  const [bargainNotes, setBargainNotes] = useState<Row[] | null>(null)
  useEffect(() => {
    if (!detailRow?.id) {
      setBargainNotes(null)
      return
    }
    let live = true
    setBargainNotes(null)
    window.api.orders
      .bargainNotes(Number(detailRow.id))
      .then((r) => { if (live) setBargainNotes(r) })
      .catch(() => { if (live) setBargainNotes([]) })
    return () => { live = false }
  }, [detailRow?.id])

  // Who did what to one purchase invoice.
  const hist = useHistoryDialog()
  const openHistory = (row: Row): void =>
    hist.open({
      entity: 'Purchase',
      id: Number(row.id),
      title: String(row.invoice_no || 'this purchase'),
      subtitle: `${row.supplier_name || '—'} · ${formatDate(row.invoice_date || row.order_date)} · ${formatINR(row.total_amount ?? row.amount)}`
    })

  function openEditPurchase(row: Row): void {
    const supplier = suppliers.find((x) => x.id === row.supplier_id)
    setEditing(row)
    setForm({
      company_id: String(row.company_id || activeCompany || ''),
      bargain_id: row.bargain_id,
      supplier_id: row.supplier_id,
      oil_type_id: row.oil_type_id,
      bargain_type: row.bargain_type,
      bargain_rate: row.bargain_rate,
      supplier_name: row.supplier_name,
      oil_label: String(row.oil_code || row.oil_name || ''),
      uom: row.uom,
      // direct/consignment invoices carry their own quantity (no tankers)
      ordered_qty: row.ordered_qty,
      invoice_no: row.invoice_no,
      order_date: row.order_date,
      invoice_rate: row.invoice_rate,
      gst_pct: row.gst_pct,
      gst_type: row.gst_type || 'CGST_SGST',
      tds_pct: supplier?.tds_pct ?? row.tds_pct,
      tds_threshold: supplier?.tds_threshold ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      adds_interest: !!supplier?.adds_interest,
      // prefer the values stored on the invoice; fall back to the supplier's
      interest_pct: Number(row.interest_pct) > 0 ? row.interest_pct : (supplier?.interest_pct ?? 0),
      interest_days: Number(row.interest_days) > 0 ? row.interest_days : (supplier?.interest_days ?? 0),
      additional_interest: row.additional_interest ?? '',
      // Replaced by the saved per-bargain overrides once they load, if any.
      bargain_interest: {},
      charge_interest: Number(row.interest_pct) > 0 && Number(row.interest_days) > 0,
      interest_touched: true,
      transporter_id: row.transporter_id || '',
      is_registered_transporter: !!row.is_registered_transporter,
      allowed_shortage_pct: row.allowed_shortage_pct ?? '',
      // Blank when the row predates the field — that reproduces the whole-rupee
      // ceiling it was actually struck on, so opening an old purchase to look
      // at it cannot re-price it.
      rate_round_off: row.rate_round_off ?? '',
      round_off: row.round_off ?? '',
      // Whether it was typed by hand is RECORDED on the invoice, not guessed
      // from "the value isn't zero" — that old guess froze a figure correct
      // for the OLD totals the moment anything else was edited, so the net
      // stopped landing on a whole rupee. Auto now keeps itself right, and a
      // real manual override is both respected and visibly flagged.
      round_off_manual: Number(row.round_off_manual) === 1,
      remarks: row.remarks ?? '',
      freight_paid_to_supplier: !!row.freight_paid_to_supplier,
      // the saved invoice rate is a deliberate choice — never auto-overwrite it
      invoice_rate_touched: true
    })
    setSelected(tankers.filter((x) => x.order_id === row.id).map((x) => Number(x.id)))
    setError(null)
    setFormPage(true)
    setTab('purchases')
  }

  useEffect(() => {
    if (!form.supplier_id || !form.order_date) return
    let active = true
    window.api.orders.fyTaxable(Number(form.supplier_id), String(form.order_date), Number(editing?.id || 0))
      .then((value) => active && setForm((p) => ({ ...p, tds_prior: value })))
    return () => { active = false }
  }, [form.supplier_id, form.order_date, editing])

  // Booking sees EVERY company's tankers, not just the one being booked into.
  // Which company a tanker ends up in is decided by the invoice that bills it
  // ("Book into company" moves it), so pre-filtering the picker by company
  // would hide the very tankers the user is choosing between. Tankers already
  // billed elsewhere are excluded downstream in selectableTankers, so only
  // genuinely unbilled ones cross over.
  const tankersForBooking = allTankers.length ? allTankers : tankers

  const selectableTankers = useMemo(
    () => tankersForBooking.filter((x) =>
      String(x.supplier_id) === String(form.supplier_id || '') &&
      x.status !== 'supplier_factory' &&
      Number(x.loaded_qty) > 0 &&
      (x.order_id == null || x.order_id === editing?.id)
    ),
    [tankersForBooking, form.supplier_id, editing]
  )
  // Only suppliers that actually have billable tankers appear in the picker
  // (plus the invoice's own supplier when editing). Trading suppliers are left
  // out — a pass-through deal is booked on the Trading screen, not here — but
  // the invoice's own supplier always stays listed, so an invoice already
  // booked against one still opens and edits normally.
  const invoiceSuppliers = useMemo(() => {
    const billable = new Set(
      tankersForBooking
        .filter((x) =>
          x.status !== 'supplier_factory' &&
          Number(x.loaded_qty) > 0 &&
          (x.order_id == null || x.order_id === editing?.id))
        .map((x) => String(x.supplier_id))
    )
    return suppliers.filter((s) => {
      const isCurrent = String(s.id) === String(form.supplier_id || '')
      if (!isCurrent && !isManufacturingParty(s)) return false
      return billable.has(String(s.id)) || !!s.skip_tanker_stages || isCurrent
    })
  }, [suppliers, tankersForBooking, editing, form.supplier_id])
  // A supplier flagged "Direct purchase" in the master keeps its goods at our
  // site already, so there is no send-to-supplier → transit → outside → inside
  // → empty cycle: the invoice is booked in one step against a bargain with the
  // quantity typed in by hand. Invoices already booked that way stay in this
  // mode when reopened.
  const directMode = useMemo(
    () =>
      !!editing?.is_consignment ||
      !!suppliers.find((s) => String(s.id) === String(form.supplier_id || ''))?.skip_tanker_stages,
    [suppliers, form.supplier_id, editing]
  )
  // Trading: bought from one party and sold straight to another. No bargain,
  // no tanker, and (on the backend) never counted in stock — a standalone mode,
  // not a variant of the direct/consignment flow above (that one still assumes
  // real consignment stock, which a Trading purchase has none of).
  const isTrading = !!(editing ? editing.is_trading : form.is_trading)
  // Consignment tankers logged for this supplier that no purchase has drawn yet
  // — the purchase form offers these first, then a bargain is assigned to them.
  const [lots, setLots] = useState<Row[]>([])
  const [lotIds, setLotIds] = useState<number[]>([])
  useEffect(() => {
    if (!formPage || !directMode || !form.supplier_id) { setLots([]); return }
    let active = true
    window.api.consignment
      .lots(Number(form.supplier_id))
      .then((rows) => { if (active) setLots(rows) })
      .catch(() => { if (active) setLots([]) })
    return () => { active = false }
  }, [formPage, directMode, form.supplier_id, editing])
  // Reopening a direct purchase: restore how its quantity was drawn.
  useEffect(() => {
    if (!formPage || !editing?.is_consignment) { setBgLines([{ bargain_id: '', qty: '' }]); return }
    let active = true
    window.api.orders
      .bargainLines(Number(editing.id))
      .then((rows) => {
        if (!active) return
        setBgLines(
          rows.length
            ? rows.map((r) => ({ bargain_id: String(r.bargain_id), qty: String(r.qty) }))
            : [{ bargain_id: String(editing.bargain_id || ''), qty: String(editing.ordered_qty || '') }]
        )
      })
      .catch(() => {})
    return () => { active = false }
  }, [formPage, editing])
  // Per-bargain interest overrides saved on the invoice being edited, so an
  // edit doesn't silently drop them back to the invoice-wide figures.
  useEffect(() => {
    if (!formPage || !editing?.id) return
    let active = true
    window.api.orders
      .bargainInterest(Number(editing.id))
      .then((rows) => {
        if (!active || !rows.length) return
        const map: Record<string, { additional_interest?: string; interest_days?: string }> = {}
        for (const r of rows) {
          map[String(r.bargain_id)] = {
            additional_interest: Number(r.additional_interest) ? String(r.additional_interest) : '',
            interest_days: Number(r.interest_days) ? String(r.interest_days) : ''
          }
        }
        setForm((p) => ({ ...p, bargain_interest: map }))
      })
      .catch(() => {})
    return () => { active = false }
  }, [formPage, editing])
  // Tankers already on the invoice being edited are not "pending", so pull the
  // invoice's own lots in separately and pre-tick them.
  const [ownLots, setOwnLots] = useState<Row[]>([])
  useEffect(() => {
    if (!formPage || !editing?.is_consignment) { setOwnLots([]); return }
    let active = true
    window.api.consignment
      .list()
      .then((rows) => {
        if (!active) return
        const mine = rows.filter((r) => Number(r.order_id) === Number(editing.id))
        setOwnLots(mine)
        setLotIds(mine.map((r) => Number(r.id)))
        // Bring back each tanker's saved bargain split.
        const saved: Record<number, Row> = {}
        for (const r of mine) {
          saved[Number(r.id)] = {
            bargain_id: r.bargain_id ? String(r.bargain_id) : '',
            extra_bargain_id: r.extra_bargain_id ? String(r.extra_bargain_id) : '',
            extra_qty: r.extra_qty != null ? String(r.extra_qty) : '',
            split: !!r.extra_bargain_id
          }
        }
        setLotBargains(saved)
      })
      .catch(() => { if (active) setOwnLots([]) })
    return () => { active = false }
  }, [formPage, editing])
  // What this party is holding with us, per product — shown the moment the
  // party is picked so the user knows how much can be invoiced.
  const [partyStockAll, setPartyStockAll] = useState<Row[]>([])
  useEffect(() => {
    if (!formPage || !directMode) { setPartyStockAll([]); return }
    let active = true
    window.api.consignment
      .summary()
      .then((rows) => { if (active) setPartyStockAll(rows) })
      .catch(() => { if (active) setPartyStockAll([]) })
    return () => { active = false }
  }, [formPage, directMode, editing])
  const partyStock = useMemo(
    () =>
      partyStockAll
        .filter((r) => String(r.supplier_id) === String(form.supplier_id || '') && Number(r.balance) > 1e-6)
        .sort((a, b) => Number(b.balance) - Number(a.balance)),
    [partyStockAll, form.supplier_id]
  )
  // Available balance of the product being invoiced.
  const directAvailable = useMemo(() => {
    if (!directMode || !form.oil_type_id) return null
    const row = partyStockAll.find(
      (r) =>
        String(r.supplier_id) === String(form.supplier_id || '') &&
        String(r.product_id) === String(form.oil_type_id)
    )
    return row ? Number(row.balance) || 0 : 0
  }, [directMode, partyStockAll, form.supplier_id, form.oil_type_id])

  // How the typed quantity is drawn from bargains: one line per bargain, the
  // same bargain twice simply means more quantity on it.
  const [bgLines, setBgLines] = useState<Row[]>([{ bargain_id: '', qty: '' }])
  // Once the user changes a line by hand the FIFO fill stops overwriting it.
  const [bgTouched, setBgTouched] = useState(false)
  const editBgLines: typeof setBgLines = (next) => {
    setBgTouched(true)
    setBgLines(next)
  }
  const bgAllocated = bgLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
  const bgAlloc = useMemo(() => {
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    for (const l of bgLines) {
      const qty = Number(l.qty) || 0
      if (!l.bargain_id || qty <= 0) continue
      const b = bargains.find((x) => String(x.id) === String(l.bargain_id))
      const k = String(l.bargain_id)
      const cur = m.get(k) || { bargain_id: Number(l.bargain_id), bargain_no: String(b?.bargain_no || '—'), rate: Number(b?.rate_per_uom) || 0, qty: 0 }
      cur.qty += qty
      m.set(k, cur)
    }
    return Array.from(m.values())
  }, [bgLines, bargains])

  // Picking a product from the stock panel sets it on the invoice and clears any
  // bargain lines that belonged to the previous product.
  function chooseDirectProduct(p: Row): void {
    setForm((f) => ({
      ...f,
      oil_type_id: p.product_id,
      oil_label: String(p.product_code || p.product_name || ''),
      uom: p.uom || f.uom || 'MT',
      bargain_id: '',
      bargain_rate: '',
      invoice_rate: f.invoice_rate_touched ? f.invoice_rate : ''
    }))
    setBgLines([{ bargain_id: '', qty: '' }])
  }

  // Every pending tanker of the supplier — the tankers come first and the
  // bargain is assigned afterwards, so these are NOT pre-filtered by product.
  const pickableLots = useMemo(
    () =>
      [...ownLots, ...lots.filter((l) => !ownLots.some((o) => Number(o.id) === Number(l.id)))].sort((a, b) =>
        String(a.deposit_date || '').localeCompare(String(b.deposit_date || ''))
      ),
    [lots, ownLots]
  )
  const chosenLots = useMemo(
    () => pickableLots.filter((l) => lotIds.includes(Number(l.id))),
    [pickableLots, lotIds]
  )
  const lotQty = chosenLots.reduce((s, l) => s + Number(l.qty || 0), 0)
  // Per-tanker bargain assignment, keyed by lot id: a tanker draws on one
  // bargain, or is split across two (extra_qty on the second).
  const [lotBargains, setLotBargains] = useState<Record<number, Row>>({})
  const setLotBargain = (id: number, patch: Row): void =>
    setLotBargains((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch } }))
  // What each bargain ends up drawing across every ticked tanker.
  const lotAlloc = useMemo(() => {
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    const add = (id: unknown, qty: number): void => {
      if (!id || qty <= 1e-9) return
      const b = bargains.find((x) => String(x.id) === String(id))
      const k = String(id)
      const cur = m.get(k) || {
        bargain_id: Number(id),
        bargain_no: String(b?.bargain_no || '—'),
        rate: Number(b?.rate_per_uom) || 0,
        qty: 0
      }
      cur.qty += qty
      m.set(k, cur)
    }
    for (const l of chosenLots) {
      const a = lotBargains[Number(l.id)] || {}
      const qty = Number(l.qty) || 0
      const extra = a.extra_bargain_id ? Number(a.extra_qty) || 0 : 0
      add(a.bargain_id, qty - extra)
      add(a.extra_bargain_id, extra)
    }
    return Array.from(m.values())
  }, [chosenLots, lotBargains, bargains])
  // Tankers still missing a bargain, or with an impossible split.
  const lotIssues = useMemo(
    () =>
      chosenLots
        .filter((l) => {
          const a = lotBargains[Number(l.id)] || {}
          const qty = Number(l.qty) || 0
          const extra = a.extra_bargain_id ? Number(a.extra_qty) || 0 : 0
          if (!a.bargain_id && extra < qty - 1e-6) return true
          if (extra > qty + 1e-6) return true
          if (a.extra_bargain_id && String(a.extra_bargain_id) === String(a.bargain_id)) return true
          return false
        })
        .map((l) => String(l.tanker_no || l.id)),
    [chosenLots, lotBargains]
  )
  // One invoice covers one product; the ticked tankers decide which bargains fit.
  const lotProducts = useMemo(
    () => Array.from(new Set(chosenLots.map((l) => String(l.product_id)))),
    [chosenLots]
  )
  const lotProductId = lotProducts.length === 1 ? lotProducts[0] : ''
  const mixedLotProducts = lotProducts.length > 1
  // Open bargains of that supplier (plus whichever one this invoice already
  // uses), narrowed to the product of the tankers that have been ticked.
  // Bargains of this party + product with balance left, oldest first — the
  // order the quantity is drawn in.
  const fifoBargains = useMemo(() => {
    const pid = String(form.oil_type_id || '')
    return bargains
      .filter(
        (b) =>
          String(b.supplier_id) === String(form.supplier_id || '') &&
          (!pid || String(b.oil_type_id) === pid) &&
          Number(b.balance_qty) > 1e-6
      )
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }, [bargains, form.supplier_id, form.oil_type_id])
  const fifoKey = fifoBargains.map((b) => `${b.id}:${b.balance_qty}`).join('|')

  // Fill the quantity from the oldest bargains first. Anything the balances
  // cannot cover is left on the last line, where it shows as over-balance.
  const fifoFill = useCallback((qty: number): Row[] => {
    const out: Row[] = []
    let left = qty
    for (const b of fifoBargains) {
      if (left <= 1e-6) break
      const take = Math.min(left, Number(b.balance_qty) || 0)
      if (take <= 1e-6) continue
      out.push({ bargain_id: String(b.id), qty: String(Math.round(take * 1000) / 1000) })
      left -= take
    }
    if (left > 1e-6 && out.length) {
      const last = out[out.length - 1]
      last.qty = String(Math.round(((Number(last.qty) || 0) + left) * 1000) / 1000)
    }
    return out
  }, [fifoBargains])

  useEffect(() => {
    if (!formPage || !directMode || bgTouched || editing) return
    const q = Number(form.ordered_qty) || 0
    const next = q > 0 ? fifoFill(q) : []
    setBgLines(next.length ? next : [{ bargain_id: '', qty: '' }])
  }, [formPage, directMode, bgTouched, editing, form.ordered_qty, form.oil_type_id, fifoKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const directBargains = useMemo(() => {
    const pid = lotProductId || String(form.oil_type_id || '')
    return bargains
      .filter(
        (b) =>
          String(b.supplier_id) === String(form.supplier_id || '') &&
          (!pid || String(b.oil_type_id) === pid) &&
          (Number(b.balance_qty) > 0 ||
            String(b.id) === String(form.bargain_id || '') ||
            bgLines.some((l) => String(l.bargain_id) === String(b.id)))
      )
      // Oldest first: the same order the quantity is drawn in.
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }, [bargains, form.supplier_id, form.bargain_id, form.oil_type_id, form.ordered_qty, lotProductId, bgLines])
  const chosenTankers = useMemo(() => tankers.filter((x) => selected.includes(Number(x.id))), [tankers, selected])
  // The invoice's bargain follows the first selected tanker automatically.
  useEffect(() => {
    if (!formPage) return
    const first = chosenTankers[0]
    if (!first) return
    if (String(form.bargain_id || '') !== String(first.bargain_id)) {
      choosePurchaseBargain(String(first.bargain_id), true)
    }
  }, [formPage, chosenTankers, form.bargain_id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Same for a consignment invoice: it follows the first tanker's bargain.
  const firstLotBargain =
    chosenLots
      .map((l) => {
        const a = lotBargains[Number(l.id)] || {}
        return a.bargain_id || a.extra_bargain_id || ''
      })
      .find((x) => !!x) || bgLines.find((l) => !!l.bargain_id)?.bargain_id || ''
  useEffect(() => {
    if (!formPage || !directMode || !firstLotBargain) return
    if (String(form.bargain_id || '') !== String(firstLotBargain)) {
      choosePurchaseBargain(String(firstLotBargain), true)
    }
  }, [formPage, directMode, firstLotBargain, form.bargain_id]) // eslint-disable-line react-hooks/exhaustive-deps
  const mixedRates = useMemo(
    () => new Set(chosenTankers.map((x) => Number(x.bargain_rate) || 0)).size > 1,
    [chosenTankers]
  )
  // Per-bargain quantity shares across the selected tankers — a split tanker
  // contributes to BOTH its primary and its excess bargain. More than one entry
  // means the invoice spans multiple bargain rates.
  const rateAlloc = useMemo(() => {
    // Consignment tankers carry their own per-bargain split; a typed-quantity
    // invoice carries it on the invoice itself.
    if (directMode && chosenLots.length) return lotAlloc
    if (directMode && bgAlloc.length) return bgAlloc
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    const add = (id: unknown, no: unknown, rate: number, qty: number): void => {
      if (!id || qty <= 0) return
      const k = String(id)
      const cur = m.get(k) || { bargain_id: Number(id), bargain_no: String(no || '—'), rate, qty: 0 }
      cur.qty += qty
      m.set(k, cur)
    }
    for (const t of chosenTankers) {
      const loaded = Number(t.loaded_qty) || 0
      const extra = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
      add(t.bargain_id, t.bargain_no, Number(t.bargain_rate) || 0, loaded - extra)
      if (extra > 0) add(t.extra_bargain_id, t.extra_bargain_no, Number(t.extra_bargain_rate) || 0, extra)
    }
    return Array.from(m.values())
  }, [chosenTankers, directMode, chosenLots, lotAlloc, bgAlloc])
  const bgRemaining = (Number(form.ordered_qty) || 0) - bgAllocated
  const directBalance = useMemo(() => {
    if (!directMode || !form.bargain_id) return null
    const b = bargains.find((x) => String(x.id) === String(form.bargain_id))
    return b ? Number(b.balance_qty) || 0 : null
  }, [directMode, bargains, form.bargain_id])
  // Direct purchases add up the consignment tankers they draw; with no tankers
  // logged the quantity is typed in instead.
  const totalQty = directMode || isTrading
    ? Number(form.ordered_qty) || 0
    : chosenTankers.reduce((sum, x) => sum + Number(x.loaded_qty || 0), 0)
  // Quantity-weighted average bargain rate across the allocation. Rounded to
  // paise — it is written into the rate FIELDS, and a raw float average put
  // something like 128781.58844765343 in front of the user. The taxable value
  // is summed from each bargain's own line rate, not from this, so rounding
  // it changes nothing that is actually billed.
  const blendedRate = useMemo(() => {
    const q = rateAlloc.reduce((s, a) => s + a.qty, 0)
    if (q <= 0) return 0
    return Math.round((rateAlloc.reduce((s, a) => s + a.rate * a.qty, 0) / q) * 100) / 100
  }, [rateAlloc])
  // Multi-bargain invoices price at the blended (weighted-average) rate — both
  // the bargain rate (interest/final basis) and the default invoice rate.
  useEffect(() => {
    if (!formPage || rateAlloc.length < 2 || blendedRate <= 0) return
    setForm((p) => {
      const next: Row = { ...p }
      let changed = false
      if (Math.abs((Number(p.bargain_rate) || 0) - blendedRate) > 1e-6) {
        next.bargain_rate = blendedRate
        changed = true
      }
      if (!p.invoice_rate_touched && Math.abs((Number(p.invoice_rate) || 0) - blendedRate) > 1e-6) {
        next.invoice_rate = blendedRate
        changed = true
      }
      return changed ? next : p
    })
  }, [formPage, rateAlloc.length, blendedRate])
  const financedCount = chosenTankers.filter((x) => x.payment_mode === 'supplier_finance').length
  // Transporter is already chosen during tanker movement — reuse it here.
  const tankerTransporterIds = Array.from(
    new Set(chosenTankers.map((x) => x.transporter_id).filter(Boolean).map(String))
  )
  const tankerTransporterId = tankerTransporterIds.length === 1 ? tankerTransporterIds[0] : ''
  const tankerTransporterName =
    chosenTankers.find((x) => String(x.transporter_id) === tankerTransporterId)?.transporter_name || ''
  useEffect(() => {
    if (tankerTransporterId && String(form.transporter_id || '') !== tankerTransporterId) {
      setForm((p) => ({ ...p, transporter_id: tankerTransporterId }))
    }
  }, [tankerTransporterId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Per-bargain additional interest / interest days, keyed by bargain id. An
  // entry left blank simply inherits the invoice-wide figure, so this stays
  // empty for the ordinary single-rate invoice.
  const bargainInterest: Record<string, { additional_interest?: string; interest_days?: string }> =
    form.bargain_interest || {}
  function setBargainInterest(bargainId: number, field: 'additional_interest' | 'interest_days', value: string): void {
    setForm((p) => ({
      ...p,
      bargain_interest: {
        ...(p.bargain_interest || {}),
        [String(bargainId)]: { ...((p.bargain_interest || {})[String(bargainId)] || {}), [field]: value }
      }
    }))
  }
  // The per-line figures actually used for pricing — a blank override falls
  // back to the invoice-wide value, matching applyBargainInterestOverrides in
  // the main process.
  const lineInterestOf = useCallback(
    (bargainId: number): { additionalInterest: number; interestDays: number } => {
      const o = (form.bargain_interest || {})[String(bargainId)] || {}
      const addl = o.additional_interest != null && o.additional_interest !== ''
        ? Number(o.additional_interest) || 0
        : Number(form.additional_interest) || 0
      const days = o.interest_days != null && o.interest_days !== ''
        ? Number(o.interest_days) || 0
        : Number(form.interest_days) || 0
      return { additionalInterest: addl, interestDays: days }
    },
    [form.bargain_interest, form.additional_interest, form.interest_days]
  )
  // Anything the invoice rate carries above the blended bargain rate is
  // supplier freight billed inside the rate — it lands on every bargain line.
  // Mirrors computeMoney, paisa guard included.
  const ratePremium = useMemo(() => {
    if (rateAlloc.length < 2 || blendedRate <= 0) return 0
    const d = Math.round(((Number(form.invoice_rate) || 0) - blendedRate) * 100) / 100
    return Math.abs(d) < 0.01 ? 0 : d
  }, [rateAlloc.length, blendedRate, form.invoice_rate])
  // Blank means the figure was never stated, which is the old always-round-up
  // rule — every purchase entered before this was struck that way, so they
  // reproduce exactly. A typed 0 is the new default: bill the exact rate.
  const rateRoundOff =
    form.rate_round_off != null && form.rate_round_off !== '' ? Number(form.rate_round_off) : null
  const billedRate = useCallback(
    (raw: number): number =>
      rateRoundOff == null ? Math.ceil(raw) : Math.round((raw + rateRoundOff) * 100) / 100,
    [rateRoundOff]
  )
  // What one bargain's line actually prices at, per unit: its own rate, its own
  // interest (shared %, its own days), its own additional interest and any
  // freight premium, at whatever the rate is billed at.
  // Shared by the form panel and the summary so the two can never disagree.
  const lineFiguresOf = useCallback(
    (bargainId: number, rate: number): { perUnitInterest: number; additionalInterest: number; lineRate: number } => {
      const eff = lineInterestOf(bargainId)
      const perUnitInterest = form.charge_interest
        ? rate * (1 + (Number(form.gst_pct) || 0) / 100) * ((Number(form.interest_pct) || 0) / 100) * (eff.interestDays / 365)
        : 0
      return {
        perUnitInterest,
        additionalInterest: eff.additionalInterest,
        lineRate: billedRate(rate + perUnitInterest + eff.additionalInterest + ratePremium)
      }
    },
    [lineInterestOf, form.charge_interest, form.gst_pct, form.interest_pct, ratePremium, billedRate]
  )
  const calc = useMemo(() => computeMoney({
    orderedQty: totalQty,
    rateRoundOff,
    invoiceRate: Number(form.invoice_rate) || 0,
    bargainRate: Number(form.bargain_rate) || 0,
    gstPct: Number(form.gst_pct) || 0,
    tdsPct: form.tds_above_only ? 0 : Number(form.tds_pct) || 0,
    addsInterest: !!form.charge_interest,
    interestPct: Number(form.interest_pct) || 0,
    interestDays: Number(form.interest_days) || 0,
    additionalInterest: Number(form.additional_interest) || 0,
    tdsThreshold: Number(form.tds_threshold) || 0,
    tdsPctAbove: Number(form.tds_pct) || 0,
    tdsPrior: Number(form.tds_prior) || 0,
    lines: rateAlloc.map((a) => ({ rate: a.rate, qty: a.qty, ...lineInterestOf(a.bargain_id) })),
    roundOff: Number(form.round_off) || 0
  }), [form, totalQty, rateAlloc, lineInterestOf])

  // Default the per-invoice interest toggle: ON when the supplier charges
  // interest AND the purchase is supplier-financed. A manual flip sticks.
  useEffect(() => {
    if (!formPage || editing || form.interest_touched) return
    const on = !!form.adds_interest && selected.length > 0 && financedCount === selected.length
    if (!!form.charge_interest !== on) {
      setForm((p) => ({ ...p, charge_interest: on }))
    }
  }, [formPage, editing, form.interest_touched, form.adds_interest, form.charge_interest, financedCount, selected.length])

  // Auto round-off to the nearest rupee (Tally style). It rounds the total
  // excluding TDS — the figure on the supplier's physical invoice — which does
  // not depend on the round off itself. Deriving it from the net (as before)
  // fed the value back into its own TDS base and oscillated without settling,
  // so whichever value the loop was passing through at Save got stored. A
  // manual edit overrides it; clearing the field brings the auto value back.
  useEffect(() => {
    if (!formPage || form.round_off_manual) return
    // Round the base to PAISA first. GST can carry a third decimal (5% of an
    // odd taxable value lands on .xx5), and deriving the round off from that
    // un-rounded figure leaves a half-paisa tail — which then surfaced as an
    // invoice total one paisa off a whole rupee.
    const total = Math.round(calc.totalExclTds * 100) / 100
    if (!Number.isFinite(total) || total <= 0) return
    const auto = Math.round(total) - total
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(form.round_off ?? '') !== val) {
      setForm((p) => ({ ...p, round_off: val }))
    }
  }, [calc.totalExclTds, form.round_off_manual, form.round_off, formPage])

  // Tally's accept shortcut, on the purchase form only.
  useEffect(() => {
    if (!formPage) return
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        if (!saving) void savePurchase()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, saving, form, selected, bgLines])

  async function savePurchase(): Promise<void> {
    if (!form.company_id) return setError('Choose the company this purchase belongs to')
    if (!form.supplier_id) return setError('Select the supplier')
    if (isTrading) {
      if (!form.oil_type_id) return setError('Choose the product being invoiced')
      if (totalQty <= 0) return setError('Enter the quantity being invoiced')
    } else if (directMode) {
      if (!form.oil_type_id) return setError('Choose the product being invoiced')
      if (totalQty <= 0) return setError('Enter the quantity being invoiced')
      if (directAvailable != null && totalQty > directAvailable + 1e-6) {
        return setError(
          `Only ${formatNum(directAvailable)} ${form.uom || 'MT'} is available from this party for that product`
        )
      }
      if (bgLines.some((l) => !l.bargain_id)) return setError('Every bargain line needs a bargain')
      if (Math.abs(bgRemaining) > 1e-6) {
        return setError(
          bgRemaining > 0
            ? `${formatNum(bgRemaining)} ${form.uom || 'MT'} of this invoice is not drawn from any bargain`
            : `The bargain quantities are ${formatNum(-bgRemaining)} ${form.uom || 'MT'} more than the invoice`
        )
      }
      if (!form.bargain_id) return setError('Choose the bargain this quantity is drawn from')
    } else {
      if (!selected.length) return setError('Select at least one loaded tanker')
      if (!form.bargain_id) return setError('Select at least one loaded tanker')
    }
    if (!String(form.invoice_no || '').trim()) return setError('Invoice number is required')
    {
      const hit = invoiceClash(form.invoice_no, editing?.id)
      if (hit) {
        return setError(
          `Purchase invoice ${String(form.invoice_no).trim()} is already booked — ` +
            `${String(hit.supplier_name || hit.supplier || 'another supplier')}` +
            `${hit.order_date ? `, ${formatDate(hit.order_date)}` : ''}.`
        )
      }
    }
    if (Number(form.invoice_rate) <= 0) return setError('Invoice rate must be greater than zero')
    setSaving(true)
    setError(null)
    const payload: Row = {
      ...form,
      ordered_qty: totalQty,
      invoice_rate: Number(form.invoice_rate),
      bargain_rate: Number(form.bargain_rate),
      gst_pct: Number(form.gst_pct) || 0,
      tds_pct: Number(form.tds_pct) || 0,
      company_id: Number(form.company_id) || undefined,
      tanker_ids: directMode || isTrading ? [] : selected,
      is_consignment: !isTrading && directMode,
      is_trading: isTrading,
      bargain_id: isTrading ? null : form.bargain_id,
      consignment_lot_ids: [],
      bargain_lines: !isTrading && directMode
        ? bgLines
            .filter((l) => l.bargain_id && (Number(l.qty) || 0) > 0)
            .map((l) => ({ bargain_id: Number(l.bargain_id), qty: Number(l.qty) || 0 }))
        : [],
      // Only meaningful once the invoice spans more than one bargain; a single
      // bargain uses the invoice-wide figures alone.
      bargain_interest: rateAlloc.length > 1
        ? rateAlloc
            .map((a) => {
              const o = (form.bargain_interest || {})[String(a.bargain_id)] || {}
              return {
                bargain_id: a.bargain_id,
                additional_interest: o.additional_interest ?? '',
                interest_days: o.interest_days ?? ''
              }
            })
            .filter((o) => o.additional_interest !== '' || o.interest_days !== '')
        : [],
      transporter_id: directMode || isTrading || !form.transporter_id ? null : Number(form.transporter_id),
      allowed_shortage_pct:
        form.allowed_shortage_pct === '' || form.allowed_shortage_pct == null
          ? null
          : Number(form.allowed_shortage_pct),
      round_off: Number(form.round_off) || 0,
      // Sent through as-is: '' keeps the legacy whole-rupee ceiling on a record
      // that was struck that way, a number states the adjustment.
      rate_round_off: form.rate_round_off ?? '',
      round_off_manual: form.round_off_manual ? 1 : 0,
      financed_by_party: !directMode && !isTrading && selected.length > 0 && financedCount === selected.length,
      payment_date: form.order_date
    }
    try {
      if (editing) {
        await window.api.orders.update(editing.id, payload)
        toast.success('Purchase updated')
      } else {
        await window.api.orders.create(payload)
        toast.success('Purchase invoice created')
      }
      setFormPage(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function deletePurchase(row: Row): Promise<void> {
    if (!window.confirm(`Delete purchase ${row.invoice_no}? Its tankers will return to the loaded queue.`)) return
    try {
      await window.api.orders.remove(row.id)
      toast.success('Purchase deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Tanker count + quantity per product (oil), within an optional loaded-date range.
  const tankerReport = useMemo(() => {
    const inRange = tankers.filter((t) => {
      const d = String(t.loaded_date || '').slice(0, 10)
      if (repFrom && (!d || d < repFrom)) return false
      if (repTo && (!d || d > repTo)) return false
      return Number(t.loaded_qty) > 0 || !!d
    })
    const m = new Map<string, { count: number; loaded: number; received: number }>()
    for (const t of inRange) {
      const k = String(t.oil_code || t.oil_name || '—')
      if (!m.has(k)) m.set(k, { count: 0, loaded: 0, received: 0 })
      const g = m.get(k)!
      g.count += 1
      g.loaded += Number(t.loaded_qty) || 0
      g.received += Number(t.received_qty) || 0
    }
    const rows = [...m.entries()]
      .map(([oil, g]) => ({ oil, ...g }))
      .sort((a, b) => a.oil.localeCompare(b.oil))
    const grand = rows.reduce(
      (s, r) => ({ count: s.count + r.count, loaded: s.loaded + r.loaded, received: s.received + r.received }),
      { count: 0, loaded: 0, received: 0 }
    )
    return { rows, grand }
  }, [tankers, repFrom, repTo])

  const target = actionRow ? nextTankerStage(actionRow.status) : null
  const shortage = actionRow ? computeShortage({
    orderedQty: Number(actionRow.loaded_qty) || 0,
    receivedQty: Number(actionForm.received_qty) || 0,
    allowedPct: Number(
      actionRow.order_allowed_shortage_pct ??
        actionRow.allowed_shortage_pct ??
        settings.allowed_shortage_pct ??
        0
    ),
    bargainRate: Number(actionRow.bargain_rate) || 0,
    transportRatePerTon: Number(actionForm.transport_rate_per_ton) || 0
  }) : null

  return (
    <>
      {!formPage && (
        <PageHeader
          title="Purchases"
          hint="Tanker lifecycle: To be loaded → Loaded → In transit → Outside factory → Inside factory → Empty. Pick the transporter when sending tankers to the supplier. At Empty, record received qty plus the KRFL and outside-factory weighment slips."
          actions={
            <div className="flex gap-2">
              <ExcelButton
                filename={`purchases-tankers-${todayISO()}`}
                sheetName="Purchases"
                title="Purchase tankers"
                columns={[
                  { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
                  { header: 'Loaded date', key: 'loaded_date', value: (r) => formatDate(r.loaded_date) },
                  { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                  { header: 'Bargain', key: 'bargain_no', value: (r) => r.bargain_no || '' },
                  { header: 'Loaded qty', key: 'loaded_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.loaded_qty) || 0 },
                  { header: 'Received qty', key: 'received_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.received_qty) || 0 },
                  { header: 'UOM', key: 'uom', value: (r) => r.uom || '' },
                  { header: 'Payment', key: 'payment_mode', value: (r) => (r.payment_mode === 'supplier_finance' ? 'Supplier financed' : r.payment_mode === 'paid_by_us' ? 'Paid by us' : 'Not decided') },
                  { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                  { header: 'Stage', key: 'status', value: (r) => r.status || '' }
                ]}
                rows={visibleTankers}
              />
              <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
                <BarChart3 className="h-4 w-4" /> Report
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLoadingOpen(true)}>
                <Truck className="h-4 w-4" /> Send tankers to supplier
              </Button>
              <Button size="sm" onClick={openNewPurchase}>
                <Plus className="h-4 w-4" /> New purchase
              </Button>
            </div>
          }
        />
      )}

      {formPage ? (
        <div className="px-4 py-4">
          <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
            <button className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline" onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}>
              <ArrowLeft className="h-3.5 w-3.5" /> {onBack ? `Back to ${backLabel || 'previous page'}` : 'Back'}
            </button>
            <div className="h-4 border-l border-[#1a2c56]/30" />
            <h2 className="text-[13px] font-bold uppercase tracking-widest">
              {editing ? 'Alter purchase invoice' : 'Purchase invoice'}
            </h2>
            <span className="ml-auto text-[11px] font-medium">
              {form.invoice_no ? `No ${form.invoice_no}` : 'No: not yet given'}
              {form.order_date ? ` · ${formatDate(form.order_date)}` : ''}
              {isTrading ? ' · trading, no bargain/stock' : directMode ? ' · direct, no tanker movement' : ''}
            </span>
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <section className="rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Invoice details
                </h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Book into company *</Label>
                    <Select
                      value={String(form.company_id || '')}
                      onValueChange={(v) => setForm((p) => ({ ...p, company_id: v }))}
                    >
                      <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                      <SelectContent>
                        {companies.map((cm) => (
                          <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {String(form.company_id || '') !== String(activeCompany) && !!form.company_id && (
                      <span className="text-[11px] font-medium text-amber-700">
                        This invoice and its tankers will move to{' '}
                        {companies.find((cm) => String(cm.id) === String(form.company_id))?.name}.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label>Supplier *</Label>
                    <Select
                      value={String(form.supplier_id || '')}
                      onValueChange={(v) => choosePurchaseSupplier(v)}
                      disabled={!!editing}
                    >
                      <SelectTrigger><SelectValue placeholder="Select the supplier — its loaded tankers appear below" /></SelectTrigger>
                      <SelectContent>
                        {invoiceSuppliers.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.name}
                            {s.skip_tanker_stages ? ' · direct' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-[11px] text-muted-foreground">
                      {isTrading
                        ? 'Trading purchase — no bargain, no tanker; not counted in stock.'
                        : directMode
                          ? 'Direct-purchase supplier — pick the bargain and quantity below; no tankers are involved.'
                          : form.bargain_id
                            ? `Bargain ${bargains.find((b) => String(b.id) === String(form.bargain_id))?.bargain_no || ''} — taken from the selected tankers.`
                            : 'The bargain is picked up automatically from the tankers you select.'}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <label className={cn('flex items-center gap-2 text-[13px]', !!editing && 'opacity-50')}>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={isTrading}
                        disabled={!!editing}
                        onChange={(e) => setForm((p) => ({ ...p, is_trading: e.target.checked }))}
                      />
                      Trading purchase — bought to resell straight through, no bargain, does not affect stock
                    </label>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Invoice number *</Label>
                    {(() => {
                      const hit = invoiceClash(form.invoice_no, editing?.id)
                      return (
                        <>
                          <Input
                            className={cn('doc-ref', hit && 'border-rose-400 focus-visible:ring-rose-300')}
                            value={form.invoice_no || ''}
                            onChange={(e) => setForm((p) => ({ ...p, invoice_no: e.target.value }))}
                          />
                          {hit && (
                            <span className="text-[11px] font-medium leading-snug text-rose-600">
                              Already booked — {String(hit.supplier_name || hit.supplier || 'another supplier')}
                              {hit.order_date ? `, ${formatDate(hit.order_date)}` : ''}. Two purchases cannot share one
                              invoice number.
                            </span>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Purchase date *</Label>
                    <DatePicker min={minDate} value={form.order_date || ''} onChange={(v) => setForm((p) => ({ ...p, order_date: v }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Invoice rate *</Label>
                    <Input type="number" step="0.01" value={form.invoice_rate ?? ''} onChange={(e) => setForm((p) => ({ ...p, invoice_rate: e.target.value, invoice_rate_touched: true }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST (intra-state)</SelectItem>
                        <SelectItem value="IGST">IGST (inter-state)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>TDS %</Label>
                    <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
                      {tankerTransporterName || (
                        <span className="text-muted-foreground">
                          {directMode || isTrading
                            ? 'Not applicable — direct purchase'
                            : chosenTankers.length
                              ? 'Supplier-delivered / from tankers'
                              : 'Select tankers first'}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {directMode || isTrading ? 'No tanker movement, so no transporter.' : 'Taken from the selected tankers.'}
                    </span>
                  </div>
                  {/* Freight per vehicle. Every tanker carries its own rate, so
                      one field on the invoice could never show it — this lists
                      them, and the pencil opens that tanker to change it. Only
                      an EX tanker has freight of ours to price. */}
                  {!directMode && !isTrading && chosenTankers.length > 0 && (
                    <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
                      <Label>Transporter rate per {form.uom || 'MT'} (EX tankers)</Label>
                      <div className="overflow-hidden rounded-md border">
                        {chosenTankers.map((t, i) => {
                          const ex = condIsEx(t)
                          const rate = Number(t.transport_rate_per_ton) || 0
                          const basis = t.received_qty != null ? Number(t.received_qty) : Number(t.loaded_qty) || 0
                          return (
                            <div
                              key={String(t.id)}
                              className={cn(
                                'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]',
                                i % 2 === 1 && 'bg-muted/30'
                              )}
                            >
                              <span className="min-w-0 shrink-0 font-medium">{t.tanker_no || '—'}</span>
                              <span
                                className={cn(
                                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                                  ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                                )}
                              >
                                {ex ? 'EX' : 'DLD'}
                              </span>
                              <span className="min-w-0 truncate text-muted-foreground">{t.transporter_name || (ex ? 'No transporter set' : '—')}</span>
                              <span className="ml-auto shrink-0 tabular-nums">
                                {ex ? (
                                  rate > 0 ? (
                                    <>
                                      {formatINR(rate)}/{t.uom || 'MT'}
                                      <span className="ml-2 text-[11px] text-muted-foreground">
                                        ≈ {formatINR(rate * basis)}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="font-semibold text-rose-700">Rate not set</span>
                                  )
                                ) : (
                                  <span className="text-muted-foreground">supplier pays</span>
                                )}
                              </span>
                              <button
                                type="button"
                                title={`Edit ${t.tanker_no || 'this tanker'}`}
                                className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() => openEditTanker(t)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        Agreed when the tanker goes In transit. Freight is priced on the received quantity.
                      </span>
                    </div>
                  )}
                  <div className={cn('flex flex-col gap-1.5', !tankerTransporterId && 'opacity-50')}>
                    <Label>Allowed shortage %</Label>
                    <Input
                      type="number"
                      value={form.allowed_shortage_pct ?? ''}
                      disabled={!tankerTransporterId}
                      placeholder={tankerTransporterId ? `default ${settings.allowed_shortage_pct ?? '0.2'}` : 'No transporter — N/A'}
                      onChange={(e) => setForm((p) => ({ ...p, allowed_shortage_pct: e.target.value }))}
                    />
                    <span className="text-[11px] text-muted-foreground">Shortage tolerance before the transporter is charged.</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 rounded-lg border px-3 py-2 md:col-span-3">
                    <div className="flex items-center gap-2.5">
                      <Switch
                        checked={!!form.charge_interest}
                        onCheckedChange={(v) =>
                          setForm((p) => ({ ...p, charge_interest: v, interest_touched: true }))
                        }
                      />
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">Supplier interest</span>
                        <InfoTip text="Interest = BG rate incl. GST × Int% × days ÷ 365; the adjusted invoice rate is BG rate + interest. Defaults ON when the supplier charges interest and the tankers are supplier-financed." />
                      </div>
                    </div>
                    <div className={cn('ml-auto flex items-center gap-2', !form.charge_interest && 'opacity-50')}>
                      <Label className="text-xs">Int %</Label>
                      <Input
                        type="number"
                        className="h-8 w-20 text-right"
                        disabled={!form.charge_interest}
                        value={form.interest_pct ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, interest_pct: e.target.value }))}
                      />
                      {/* Days and additional interest move into the per-bargain
                          panel below once the invoice spans several bargains —
                          shown in both places they read as duplicates. */}
                      {rateAlloc.length < 2 && (
                        <>
                          <Label className="text-xs">Days</Label>
                          <Input
                            type="number"
                            className="h-8 w-20 text-right"
                            disabled={!form.charge_interest}
                            value={form.interest_days ?? ''}
                            onChange={(e) => setForm((p) => ({ ...p, interest_days: e.target.value }))}
                          />
                        </>
                      )}
                    </div>
                    {rateAlloc.length < 2 ? (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <Label className="text-xs">Additional interest (₹/{form.uom || 'MT'})</Label>
                          <InfoTip text="A manual per-unit interest you can add on top; it is included in the adjusted invoice rate (and therefore the taxable value, GST and net)." />
                        </div>
                        <Input
                          type="number"
                          className="h-8 w-24 text-right"
                          placeholder="0"
                          value={form.additional_interest ?? ''}
                          onChange={(e) => setForm((p) => ({ ...p, additional_interest: e.target.value }))}
                        />
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Days &amp; additional interest are set per bargain below.
                      </span>
                    )}
                  </div>

                  {/* Two bargains on one invoice are two different deals — each
                      can carry its own additional interest and its own days,
                      added straight into THAT bargain's rate. Left blank, a
                      bargain just inherits the invoice-wide figures above. */}
                  {rateAlloc.length > 1 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 md:col-span-3">
                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                          Per-bargain interest
                        </span>
                        <InfoTip text="Set against one bargain, these replace the invoice-wide additional interest / days for that bargain's quantity only. Leave a box empty to inherit the shared value." />
                      </div>
                      <div className="grid gap-2">
                        {rateAlloc.map((a) => {
                          const { lineRate } = lineFiguresOf(a.bargain_id, a.rate)
                          return (
                            <div key={a.bargain_id} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-2">
                              <div className="min-w-[13rem] flex-1">
                                <div className="text-xs font-medium">{a.bargain_no}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {formatINR(a.rate)} · {formatNum(a.qty)} {form.uom || 'MT'}
                                </div>
                              </div>
                              <Label className="text-[11px] text-muted-foreground">Addl. int (₹/{form.uom || 'MT'})</Label>
                              <Input
                                type="number"
                                className="h-8 w-24 text-right"
                                placeholder={String(Number(form.additional_interest) || 0)}
                                value={bargainInterest[String(a.bargain_id)]?.additional_interest ?? ''}
                                onChange={(e) => setBargainInterest(a.bargain_id, 'additional_interest', e.target.value)}
                              />
                              <Label className="text-[11px] text-muted-foreground">Days</Label>
                              <Input
                                type="number"
                                className="h-8 w-20 text-right"
                                disabled={!form.charge_interest}
                                placeholder={String(Number(form.interest_days) || 0)}
                                value={bargainInterest[String(a.bargain_id)]?.interest_days ?? ''}
                                onChange={(e) => setBargainInterest(a.bargain_id, 'interest_days', e.target.value)}
                              />
                              <div className="ml-auto text-right">
                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Line rate</div>
                                <div className="text-xs font-semibold tabular-nums">{formatINR(lineRate)}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {Number(form.bargain_rate) > 0 && Number(form.invoice_rate) > Number(form.bargain_rate) && (
                    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 md:col-span-3">
                      <div className="flex items-center gap-2.5">
                        <Switch
                          checked={!!form.freight_paid_to_supplier}
                          onCheckedChange={(v) => setForm((p) => ({ ...p, freight_paid_to_supplier: v }))}
                        />
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">Transporter charges paid to supplier</span>
                          <InfoTip text={`Invoice rate is ${formatINR(Number(form.invoice_rate) - Number(form.bargain_rate))}/${form.uom || 'MT'} above the bargain rate. ON: that difference is kept as per-${form.uom || 'MT'} freight data on this invoice's tankers and NO transporter ledger is posted — the supplier already paid the transporter.`} />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <Label>Remarks</Label>
                    <textarea
                      rows={2}
                      className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Optional notes about this invoice"
                      value={form.remarks ?? ''}
                      onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Saving the purchase automatically posts its payable amount to the supplier ledger.
                </div>
              </section>

              {isTrading ? (
                <section className="rounded border border-teal-300 bg-teal-50/40 p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                  <div className="mb-3 flex items-center justify-between gap-3 border-b border-dotted border-teal-200 pb-1.5">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-teal-900">Trading — no bargain, no stock</h3>
                    <Badge className="bg-teal-600 hover:bg-teal-600">Trading</Badge>
                  </div>
                  {!form.supplier_id ? (
                    <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                      Select the supplier first.
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Product *</Label>
                        <Select
                          value={String(form.oil_type_id || '')}
                          onValueChange={(v) => setForm((p) => ({ ...p, oil_type_id: v }))}
                          disabled={!!editing}
                        >
                          <SelectTrigger><SelectValue placeholder="Select the product" /></SelectTrigger>
                          <SelectContent className="max-h-64">
                            {products.map((p) => (
                              <SelectItem key={String(p.id)} value={String(p.id)}>{p.code || p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Quantity to invoice * ({form.uom || 'MT'})</Label>
                        <Input
                          type="number"
                          value={form.ordered_qty ?? ''}
                          placeholder="0.000"
                          onChange={(e) => setForm((p) => ({ ...p, ordered_qty: e.target.value }))}
                        />
                      </div>
                      <div className="md:col-span-2 rounded-md border border-teal-200 bg-white/60 px-3 py-2 text-xs text-teal-900">
                        Bought from this supplier, resold straight to a customer — no bargain is drawn and this quantity never enters or leaves stock.
                      </div>
                    </div>
                  )}
                </section>
              ) : directMode ? (
                <section className="rounded border border-violet-300 bg-violet-50/40 p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                  <div className="mb-3 flex items-center justify-between gap-3 border-b border-dotted border-violet-200 pb-1.5">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-violet-900">Direct purchase — no tanker movement</h3>
                    <Badge className="bg-violet-600 hover:bg-violet-600">Direct</Badge>
                  </div>
                  {!form.supplier_id ? (
                    <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                      Select the supplier first.
                    </div>
                  ) : (
                    <>
                    {/* Available stock as chips, then product + quantity. */}
                    {partyStock.length === 0 ? (
                      <div className="mb-3 rounded-lg border border-dashed bg-white/60 px-3 py-3 text-center text-xs text-muted-foreground">
                        No stock logged for this party yet.
                      </div>
                    ) : (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-violet-900/70">
                          Available
                        </span>
                        {partyStock.map((p) => {
                          const picked = String(form.oil_type_id || '') === String(p.product_id)
                          return (
                            <button
                              key={String(p.product_id)}
                              type="button"
                              onClick={() => chooseDirectProduct(p)}
                              className={cn(
                                'rounded-md border bg-white px-2.5 py-1 text-[12px] transition',
                                picked ? 'border-violet-500 ring-1 ring-violet-300' : 'hover:bg-muted/40'
                              )}
                            >
                              <span className="font-medium">{p.product_code || p.product_name}</span>
                              <span className="ml-1.5 font-bold tabular-nums text-emerald-700">
                                {formatNum(p.balance)}
                              </span>
                              <span className="ml-0.5 text-[10px] text-muted-foreground">{p.uom || 'MT'}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    <div className="mb-3 grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Product *</Label>
                        <Select
                          value={String(form.oil_type_id || '')}
                          onValueChange={(v) => {
                            const p = partyStock.find((x) => String(x.product_id) === v)
                            if (p) chooseDirectProduct(p)
                          }}
                          disabled={!!editing}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={partyStock.length ? 'Select the product' : 'No stock for this party'} />
                          </SelectTrigger>
                          <SelectContent>
                            {partyStock.map((p) => (
                              <SelectItem key={String(p.product_id)} value={String(p.product_id)}>
                                {p.product_code || p.product_name} · {formatNum(p.balance)} {p.uom || 'MT'} available
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Quantity to invoice * ({form.uom || 'MT'})</Label>
                        <Input
                          type="number"
                          value={form.ordered_qty ?? ''}
                          placeholder="0.000"
                          onChange={(e) => setForm((p) => ({ ...p, ordered_qty: e.target.value }))}
                        />
                        {directAvailable != null && (
                          <span
                            className={cn(
                              'text-[11px]',
                              totalQty > directAvailable + 1e-6 ? 'font-medium text-red-600' : 'text-muted-foreground'
                            )}
                          >
                            {totalQty > directAvailable + 1e-6
                              ? `Only ${formatNum(directAvailable)} available`
                              : `${formatNum(directAvailable - totalQty)} ${form.uom || 'MT'} left after this`}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Step 3 — which bargains that quantity is drawn from. */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-violet-900">Draw it from</span>
                      {!bgTouched && bgAlloc.length > 0 && (
                        <Badge variant="secondary" className="font-normal">oldest bargain first</Badge>
                      )}
                      {totalQty > 0 && (
                        <span className="text-[11px] text-violet-800/80">
                          {formatNum(bgAllocated)} of {formatNum(totalQty)} {form.uom || 'MT'} allocated
                          {Math.abs(bgRemaining) > 1e-6 && (
                            <b>
                              {' '}
                              · {bgRemaining > 0 ? `${formatNum(bgRemaining)} still to allocate` : `${formatNum(-bgRemaining)} over`}
                            </b>
                          )}
                        </span>
                      )}
                    </div>
                    {totalQty <= 0 ? (
                      <div className="rounded-lg border border-dashed bg-white/60 px-3 py-3 text-center text-xs text-muted-foreground">
                        Enter a quantity to see the bargains.
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {bgLines.map((line, index) => {
                          const bg = bargains.find((b) => String(b.id) === String(line.bargain_id))
                          const bal = bg ? Number(bg.balance_qty) || 0 : 0
                          const qty = Number(line.qty) || 0
                          return (
                            <div
                              key={index}
                              className="grid gap-2 rounded-lg border bg-white p-2.5 md:grid-cols-[minmax(0,1fr)_7rem_auto]"
                            >
                              <div className="flex min-w-0 flex-col gap-1">
                                <Label className="text-[11px] text-muted-foreground">Bargain</Label>
                                <Select
                                  value={String(line.bargain_id || '')}
                                  onValueChange={(v) =>
                                    editBgLines((p) => p.map((x, i) => (i === index ? { ...x, bargain_id: v } : x)))
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue
                                      placeholder={directBargains.length ? 'Select bargain' : 'No open bargain for this product'}
                                    />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {directBargains.map((b) => (
                                      <SelectItem key={b.id} value={String(b.id)}>
                                        {b.bargain_no} · {formatDate(b.bargain_date)} · bal {formatNum(b.balance_qty)}{' '}
                                        {b.uom} @ {formatINR(b.rate_per_uom)}
                                        {Number(b.balance_qty) + 1e-6 >= totalQty ? ' · covers it' : ''}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <Label className="text-[11px] text-muted-foreground">Qty</Label>
                                <Input
                                  type="number"
                                  className="h-8 text-right text-xs"
                                  value={line.qty ?? ''}
                                  onChange={(e) =>
                                    editBgLines((p) => p.map((x, i) => (i === index ? { ...x, qty: e.target.value } : x)))
                                  }
                                />
                              </div>
                              <div className="flex items-end gap-2">
                                <div className="min-w-[8.5rem] pb-1 text-[11px] leading-tight">
                                  {bg ? (
                                    <>
                                      <div className="tabular-nums text-muted-foreground">
                                        {formatINR(Number(bg.rate_per_uom) * qty)}
                                      </div>
                                      <div className={cn(qty > bal + 1e-6 ? 'font-medium text-red-600' : 'text-muted-foreground')}>
                                        {qty > bal + 1e-6
                                          ? `${formatNum(qty - bal)} over its balance`
                                          : `balance left ${formatNum(bal - qty)}`}
                                      </div>
                                    </>
                                  ) : (
                                    <span className="text-muted-foreground">pick a bargain</span>
                                  )}
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive"
                                  disabled={bgLines.length === 1}
                                  onClick={() => editBgLines((p) => p.filter((_, i) => i !== index))}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => editBgLines((p) => [...p, { bargain_id: '', qty: '' }])}
                          >
                            <Plus className="h-4 w-4" /> Add another bargain
                          </Button>
                          {bgTouched && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() => {
                                const next = fifoFill(Number(form.ordered_qty) || 0)
                                setBgLines(next.length ? next : [{ bargain_id: '', qty: '' }])
                                setBgTouched(false)
                              }}
                            >
                              Refill oldest first
                            </Button>
                          )}
                          {Math.abs(bgRemaining) > 1e-6 && bgLines.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() =>
                                editBgLines((p) =>
                                  p.map((x, i) =>
                                    i === p.length - 1 ? { ...x, qty: String((Number(x.qty) || 0) + bgRemaining) } : x
                                  )
                                )
                              }
                            >
                              Put the remaining {formatNum(Math.abs(bgRemaining))} on the last line
                            </Button>
                          )}
                          {bgAlloc.length > 1 && (
                            <span className="text-[11px] text-muted-foreground">
                              {bgAlloc.length} bargains — the invoice prices at the weighted-average rate{' '}
                              {formatINR(Number(form.bargain_rate) || 0)}/{form.uom || 'MT'}.
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    </>
                  )}
                </section>
              ) : (
              <section className="rounded border border-[#e5dfc8] bg-white p-4">
                <div className="mb-3 flex items-center justify-between border-b border-dotted border-[#e5dfc8] pb-1.5">
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Tankers on this invoice</h3>
                    <p className="text-xs text-muted-foreground">All the supplier&apos;s unbilled loaded tankers — tick the ones covered by this invoice.</p>
                  </div>
                  <Badge variant="secondary">{selected.length} selected</Badge>
                </div>
                {!form.supplier_id ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">Select the supplier to see all its loaded tankers.</div>
                ) : selectableTankers.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No unbilled loaded tankers for this supplier.</div>
                ) : (
                  <div className="grid gap-2">
                    {mixedRates && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        The selected tankers come from bargains with different rates — the invoice uses the first tanker&apos;s bargain rate, so adjust the invoice rate if needed.
                      </div>
                    )}
                    {selectableTankers.map((tanker) => {
                      const checked = selected.includes(Number(tanker.id))
                      return (
                        <label key={tanker.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition ${checked ? 'border-amber-400 bg-amber-50' : 'hover:bg-muted/40'}`}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-amber-500"
                            checked={checked}
                            onChange={(e) => setSelected((p) => e.target.checked ? [...p, Number(tanker.id)] : p.filter((id) => id !== Number(tanker.id)))}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{tanker.tanker_no}</div>
                            <div className="text-xs text-muted-foreground">
                              {tanker.bargain_no} · {tanker.oil_code || tanker.oil_name} · Loaded {formatDate(tanker.loaded_date)} · {tanker.payment_mode === 'supplier_finance' ? 'Supplier financed' : 'Paid by us'}
                            </div>
                          </div>
                          <div className="font-medium tabular-nums">{formatNum(tanker.loaded_qty)} {tanker.uom}</div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>
              )}
            </div>

            <aside className="h-fit rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4 xl:sticky xl:top-6">
              <h3 className="mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                Purchase summary
              </h3>
              {isTrading ? (
                <>
                  <MoneyRow label="Purchase type" value="Trading — no bargain, no stock" />
                  <MoneyRow label="Quantity invoiced" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                </>
              ) : directMode ? (
                <>
                  <MoneyRow label="Purchase type" value="Direct — no tanker movement" />
                  {directAvailable != null && (
                    <MoneyRow
                      label="Available from party"
                      value={`${formatNum(directAvailable)} ${form.uom || 'MT'}`}
                    />
                  )}
                  {bgAlloc.length > 1 && <MoneyRow label="Bargains drawn" value={String(bgAlloc.length)} />}
                  <MoneyRow label="Quantity invoiced" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                </>
              ) : (
                <>
                  <MoneyRow label="Tankers" value={String(selected.length)} />
                  <MoneyRow label="Total loaded quantity" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                  <MoneyRow label="Paid by us" value={String(selected.length - financedCount)} />
                  <MoneyRow label="Supplier financed" value={String(financedCount)} />
                </>
              )}
              <div className="my-3 border-t" />
              {rateAlloc.length > 1 ? (
                rateAlloc.map((a, i) => (
                  <MoneyRow
                    key={a.bargain_no}
                    label={`Bargain rate ${i + 1}`}
                    title={`${a.bargain_no} · ${formatNum(a.qty)} ${form.uom || 'MT'}`}
                    value={formatINR(a.rate)}
                  />
                ))
              ) : (
                <MoneyRow label="Bargain rate" value={formatINR(Number(form.bargain_rate) || 0)} />
              )}
              {/* Interest, per bargain when the invoice spans more than one.
                  Quoted PER UNIT like every other rate row in this block — the
                  line total is on hover. Hidden entirely when it works out to
                  nothing, so a 0%/0-day invoice carries no empty row. */}
              {rateAlloc.length > 1
                ? rateAlloc.map((a, i) => {
                    const { perUnitInterest } = lineFiguresOf(a.bargain_id, a.rate)
                    if (perUnitInterest <= 0) return null
                    const eff = lineInterestOf(a.bargain_id)
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-int`}
                        label={`Interest ${i + 1} @ ${Number(form.interest_pct) || 0}% · ${eff.interestDays}d`}
                        title={`${a.bargain_no} — per ${form.uom || 'MT'} · ${formatNum(a.qty)} ${form.uom || 'MT'} = ${formatINR(perUnitInterest * a.qty)}`}
                        value={formatINR(perUnitInterest)}
                      />
                    )
                  })
                : !!form.charge_interest && calc.interestPerUnit > 0 && (
                    <MoneyRow
                      label={`Interest @ ${Number(form.interest_pct) || 0}% · ${Number(form.interest_days) || 0}d`}
                      title={`Per ${form.uom || 'MT'} · ${formatNum(totalQty)} ${form.uom || 'MT'} = ${formatINR(calc.interestPerUnit * totalQty)}`}
                      value={formatINR(calc.interestPerUnit)}
                    />
                  )}
              {/* Additional interest — the value shown is that bargain's rate
                  WITH its own additional interest folded in, so the running
                  per-unit rate is readable line by line. */}
              {rateAlloc.length > 1
                ? rateAlloc.map((a, i) => {
                    const { additionalInterest } = lineFiguresOf(a.bargain_id, a.rate)
                    if (additionalInterest <= 0) return null
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-addl`}
                        label={`Additional interest ${i + 1} (${formatINR(additionalInterest)}/${form.uom || 'MT'})`}
                        title={`${a.bargain_no} — bargain rate ${formatINR(a.rate)} plus ${formatINR(additionalInterest)}/${form.uom || 'MT'}`}
                        value={formatINR(a.rate + additionalInterest)}
                      />
                    )
                  })
                : Number(form.additional_interest) > 0 && (
                    <MoneyRow
                      label={`Additional interest (${formatINR(Number(form.additional_interest))}/${form.uom || 'MT'})`}
                      title={`Bargain rate ${formatINR(Number(form.bargain_rate) || 0)} plus ${formatINR(Number(form.additional_interest))}/${form.uom || 'MT'}`}
                      value={formatINR((Number(form.bargain_rate) || 0) + (Number(form.additional_interest) || 0))}
                    />
                  )}
              {/* Freight the supplier billed inside the rate — shown on its own
                  row so a premium that reaches every line is never invisible. */}
              {ratePremium !== 0 && (
                <MoneyRow
                  label={`Freight in invoice rate (${formatINR(ratePremium)}/${form.uom || 'MT'})`}
                  title={`Invoice rate ${formatINR(Number(form.invoice_rate) || 0)} less the blended bargain rate ${formatINR(blendedRate)} — applied to every bargain line`}
                  value={formatINR(ratePremium * totalQty)}
                />
              )}
              {/* T1, T2 … — each bargain's finished per-unit rate (whole rupee,
                  as the supplier bills it). The average below is these
                  weighted by quantity, which is what the invoice charges. */}
              {rateAlloc.length > 1 && (
                <>
                  <div className="border-t" />
                  {rateAlloc.map((a, i) => {
                    const { lineRate } = lineFiguresOf(a.bargain_id, a.rate)
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-t`}
                        label={`T${i + 1} (${a.bargain_no})`}
                        title={`Final rate per ${form.uom || 'MT'} · ${formatNum(a.qty)} ${form.uom || 'MT'} = ${formatINR(lineRate * a.qty)}`}
                        value={formatINR(lineRate)}
                        strong
                      />
                    )
                  })}
                </>
              )}
              {/* The adjusted rate is billed at the whole rupee, rounded UP —
                  that is how the supplier invoices it, and the taxable value is
                  struck on the rounded figure. Rounding it silently made the
                  column stop adding up: bargain 1,28,100.00 plus interest
                  829.14 read as 1,28,930.00, with the 86 paise nowhere. The
                  rounding now has its own line, so the arithmetic on screen is
                  the arithmetic that was done. */}
              {/* The rate used to be rounded UP to the whole rupee, always,
                  because that is how the supplier bills — but not every
                  supplier does, and it moved the invoice by a few rupees with
                  nothing to argue with. It is a figure now: nil unless somebody
                  says otherwise, typed if the supplier billed some other
                  adjustment, and one click away if they did round up. */}
              {(() => {
                const r2 = (v: number): number => Math.round(v * 100) / 100
                const exact = r2(
                  (Number(form.bargain_rate) || 0) +
                    (Number(calc.interestPerUnit) || 0) +
                    (Number(form.additional_interest) || 0) +
                    ratePremium
                )
                if (exact <= 0) return null
                const toWhole = r2(Math.ceil(exact) - exact)
                const applied = r2((Number(calc.adjustedRate) || 0) - exact)
                const legacy = rateRoundOff == null
                return (
                  <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span
                      className="min-w-0 text-muted-foreground"
                      title={`Exact ${formatINR(exact)} per ${form.uom || 'MT'}. Nil bills that rate as it stands. Type an amount, or use ↑ to round up to the whole rupee the way the supplier does.`}
                    >
                      Rate adjustment{' '}
                      <span className="text-[11px]">
                        {legacy
                          ? `(rounded up, +${formatINR(applied)})`
                          : `per ${form.uom || 'MT'}`}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {toWhole > 0.004 && r2(rateRoundOff ?? -1) !== toWhole && (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-7 bg-white px-1.5 text-[11px]"
                          title={`Round up to ${formatINR(Math.ceil(exact))} — the whole rupee`}
                          onClick={() => setForm((p) => ({ ...p, rate_round_off: String(toWhole) }))}
                        >
                          ↑ {formatINR(toWhole)}
                        </Button>
                      )}
                      <Input
                        type="number"
                        className="h-7 w-24 text-right"
                        placeholder="0.00"
                        value={form.rate_round_off ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, rate_round_off: e.target.value }))}
                      />
                    </div>
                  </div>
                )
              })()}
              <MoneyRow
                label={rateAlloc.length > 1 ? 'Adjusted invoice rate (avg)' : 'Adjusted invoice rate'}
                title={
                  rateAlloc.length > 1
                    ? `Quantity-weighted average across ${rateAlloc.length} bargains`
                    : `x ${formatNum(totalQty)} ${form.uom || 'MT'} = ${formatINR(calc.taxableValue)}`
                }
                value={formatINR(calc.adjustedRate)}
                strong
              />
              <div className="my-2 border-t" />
              <MoneyRow label="Taxable value" value={formatINR(calc.taxableValue)} />
              {form.gst_type === 'IGST' ? (
                <MoneyRow label={`IGST${form.gst_pct ? ` @ ${form.gst_pct}%` : ''}`} value={formatINR(calc.gstAmount)} />
              ) : (
                <>
                  <MoneyRow label={`CGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                  <MoneyRow label={`SGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                </>
              )}
              <div className="border-t" />
              <MoneyRow label="Total value (excl. TDS)" value={formatINR(calc.taxableValue + calc.gstAmount)} strong />
              <div className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-muted-foreground" title="Applied to the total excluding TDS. TDS is then deducted on the rounded figure. Auto-rounds to the nearest rupee; type to override, clear to go back to auto.">
                  Round off {form.round_off_manual ? '(manual)' : '(auto)'}
                </span>
                <Input
                  type="number"
                  className="h-7 w-28 text-right"
                  placeholder="0.00"
                  value={form.round_off ?? ''}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      round_off: e.target.value,
                      round_off_manual: e.target.value !== ''
                    }))
                  }
                />
              </div>
              <MoneyRow label="Total after round off" value={formatINR(calc.roundedTotal)} strong />
              <MoneyRow label="TDS (on the rounded total)" value={`− ${formatINR(calc.tdsAmount)}`} />
              <div className="my-2 border-t-2 border-[#1a2c56]" />
              <div className="flex items-center justify-between text-[15px] font-bold text-[#1a2c56]">
                <span>Net purchase amount</span>
                <span className="tabular-nums">{formatINR(calc.netAmount)}</span>
              </div>
              {error && <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button variant="outline" className="bg-white" onClick={() => setFormPage(false)} disabled={saving}>Cancel</Button>
                <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={savePurchase} disabled={saving}>
                  {saving ? 'Saving…' : editing ? 'Save changes' : 'Accept purchase'}
                </Button>
              </div>
              <p className="mt-2 text-center text-[10px] text-muted-foreground">Ctrl+A accepts, like Tally.</p>
            </aside>
          </div>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-6 pt-3">
          <Tabs value={tab} onValueChange={setTab}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <TabsList>
              <TabsTrigger value="tankers">Tanker movement</TabsTrigger>
              <TabsTrigger value="purchases">Purchase entries</TabsTrigger>
              <TabsTrigger value="unmapped">
                Unmapped invoices
                {unmapped.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">
                    {unmapped.length}
                  </span>
                )}
              </TabsTrigger>
              </TabsList>
              {/* Filters live on the tab row, for the entries tab only. */}
              {tab === 'purchases' && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-2.5 py-1">
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Date
                    </span>
                    <FyPicker from={poFrom} to={poTo} onRange={(f, t) => { setPoFrom(f); setPoTo(t) }} className="h-8 w-28 shrink-0 text-[11px]" />
                    <DatePicker value={poFrom} onChange={(v) => setPoFrom(v || '')} max={poTo || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                    <span className="shrink-0 text-[10px] text-muted-foreground">to</span>
                    <DatePicker value={poTo} onChange={(v) => setPoTo(v || '')} min={poFrom || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                  </div>
                  <div className="h-5 border-l" />
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Category
                    </span>
                    <MultiSelectFilter
                      options={poCategories.map((cat) => ({ value: cat, label: cat.toUpperCase() }))}
                      value={poCategory}
                      onApply={setPoCategory}
                      allLabel="All categories"
                      className="h-7 w-[11.5rem] shrink-0 text-[11px]"
                    />
                  </div>
                  <div className="h-5 shrink-0 border-l" />
                  <div className="flex shrink-0 items-center gap-1.5" title="When on, a purchase also shows if a tanker on it was received in this window — even if the invoice itself was raised outside it.">
                    <Switch checked={poIncludeReceipt} onCheckedChange={setPoIncludeReceipt} className="shrink-0" />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Include by receipt date
                    </span>
                  </div>
                  {(poFrom || poTo || poCategory.length > 0) && (
                    <>
                      <div className="h-5 shrink-0 border-l" />
                      <button
                        type="button"
                        className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                        onClick={() => { setPoFrom(''); setPoTo(''); setPoCategory([]) }}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <TabsContent value="tankers" className="space-y-5">
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h3 className="font-medium">Tanker movement by oil type</h3>
                    <p className="text-xs text-muted-foreground">
                      Status as of {formatDate(pivotEnd)} · each tanker in its current stage · hover a count for tankers &amp; qty
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative w-full sm:w-60">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="search"
                        className="h-8 pl-8 text-[11px]"
                        placeholder="Search tanker, party, bargain, invoice…"
                        value={moveSearch}
                        onChange={(e) => setMoveSearch(e.target.value)}
                      />
                    </div>
                    <div className="h-5 shrink-0 border-l" />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Company
                    </span>
                    <Select value={moveCompany} onValueChange={setMoveCompany} showCheckbox>
                      <SelectTrigger className="h-8 w-[11rem] text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active company</SelectItem>
                        <SelectItem value="all">All companies</SelectItem>
                        {companies.map((cm) => (
                          <SelectItem key={String(cm.id)} value={String(cm.id)}>{cm.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="h-5 shrink-0 border-l" />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Category
                    </span>
                    <MultiSelectFilter
                      options={tmCategories.map((c) => ({ value: c, label: c.toUpperCase() }))}
                      value={tmCategory}
                      onApply={setTmCategory}
                      allLabel="All categories"
                      className="h-8 w-[10.5rem] text-[11px]"
                    />
                    <div className="h-5 shrink-0 border-l" />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">From</span>
                    <DatePicker max={pivotEnd} value={pivotStart} onChange={(v) => setPivotStart(v || todayISO())} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <DatePicker min={pivotStart} max={todayISO()} value={pivotEnd} onChange={(v) => setPivotEnd(v || todayISO())} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
                    {(pivotStart !== monthStartISO() || pivotEnd !== todayISO()) && (
                      <Button variant="ghost" size="sm" onClick={() => { setPivotStart(monthStartISO()); setPivotEnd(todayISO()) }}>This month</Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 text-[11px]"
                      title="Widen the range to browse old (already Empty) tankers too — in-progress tankers show regardless"
                      onClick={() => { setPivotStart('2000-01-01'); setPivotEnd(todayISO()) }}
                    >
                      View all history
                    </Button>
                    <ExcelButton
                      filename={`tanker-movement-${pivotEnd}`}
                      sheetName="Tanker movement"
                      title={`Tanker movement by oil type — as on ${formatDate(pivotEnd)}`}
                      columns={[
                        { header: 'Oil type', key: 'oil' },
                        { header: 'Party', key: 'party', value: (r) => r.party || '' },
                        ...PIVOT_STAGES.map((st) => ({
                          header: st.label,
                          key: st.key,
                          align: 'right' as const,
                          numFmt: '#,##0',
                          value: (r: Row) => Number(r[st.key]) || 0
                        })),
                        { header: 'Total', key: 'total', align: 'right' as const, numFmt: '#,##0', value: (r) => Number(r.total) || 0 },
                        { header: 'Tankers', key: 'tanker_list', value: (r) => r.tanker_list || '' }
                      ]}
                      rows={pivotSheetRows}
                      isGroup={(r) => !!r.is_group}
                      outlineDetail
                    />
                  </div>
                </div>
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                  <TableHeader className="bg-amber-50"><TableRow>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Oil type</TableHead>
                    {PIVOT_STAGES.map((s) => <TableHead key={s.key} className="text-center text-[10px] font-semibold uppercase tracking-wide text-amber-900">{s.label}</TableHead>)}
                    <TableHead className="text-center text-[10px] font-semibold uppercase tracking-wide text-amber-900">Total</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {pivot.rows.length === 0 ? (
                      <TableRow><TableCell colSpan={PIVOT_STAGES.length + 2} className="py-8 text-center text-muted-foreground">
                        {moveSearch.trim()
                          ? `Nothing matches “${moveSearch.trim()}” in this period.`
                          : 'No tankers to show for this period.'}
                      </TableCell></TableRow>
                    ) : (
                      <>
                        {pivot.rows.map((row) => (
                          <TableRow key={row.label}>
                            <TableCell className="font-medium">{row.label}</TableCell>
                            {PIVOT_STAGES.map((s) => {
                              const cell = row.cells[s.key]
                              return (
                                <TableCell key={s.key} className="text-center tabular-nums">
                                  {cell && cell.count > 0 ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setPivotSel((p) =>
                                              p && p.oil === row.label && p.stage === s.key ? null : { oil: row.label, stage: s.key }
                                            )
                                          }
                                          className={cn(
                                            'cursor-pointer rounded px-1.5 py-0.5 font-medium underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:bg-sky-100',
                                            pivotSel && pivotSel.oil === row.label && pivotSel.stage === s.key && 'bg-sky-600 text-white no-underline hover:bg-sky-600'
                                          )}
                                          title="Show these tankers below"
                                        >
                                          {cell.count}
                                        </button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className="mb-1 font-semibold">{row.label} · {s.label}</div>
                                        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                                          <span className="text-muted-foreground">Tankers</span>
                                          <span className="text-right font-medium">{cell.count}</span>
                                          <span className="text-muted-foreground">Qty</span>
                                          <span className="text-right font-medium">{formatNum(cell.qty)}</span>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              )
                            })}
                            <TableCell className="text-center font-semibold tabular-nums">{row.total}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/40">
                          <TableCell className="font-semibold">Total</TableCell>
                          {PIVOT_STAGES.map((s) => (
                            <TableCell key={s.key} className="text-center font-semibold tabular-nums">{pivot.totals[s.key] || 0}</TableCell>
                          ))}
                          <TableCell className="text-center font-semibold tabular-nums">{pivot.grand}</TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
              {pivotSel && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                  <span>
                    Showing <b>{visibleTankers.length}</b> tanker{visibleTankers.length === 1 ? '' : 's'} — <b>{pivotSel.oil}</b> · {PIVOT_STAGES.find((s) => s.key === pivotSel.stage)?.label || pivotSel.stage}
                  </span>
                  <Button variant="outline" size="sm" className="h-7 border-sky-300 bg-white text-sky-900" onClick={() => setPivotSel(null)}>
                    Clear
                  </Button>
                </div>
              )}
              <div className="overflow-hidden rounded-xl border bg-card">
                {/* This card + the "Loaded outside" one below it split the
                    SAME pivot total between them by loaded date — their two
                    badge counts always add up to the pivot's grand total,
                    never more. */}
                {!pivotSel && (
                  <div className="flex items-center gap-1.5 border-b bg-emerald-50 px-3 py-2">
                    <CalendarDays className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="text-xs font-semibold text-emerald-800">
                      Loaded & received within {formatDate(pivotStart)} – {formatDate(pivotEnd)}
                    </span>
                    <Badge variant="success" className="text-[10px]">{inLoadedRangeTankers.length}</Badge>
                  </div>
                )}
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                  {tankerTableHeader()}
                  <TableBody>
                    {loading ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : inLoadedRangeTankers.length === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{tankers.length === 0 ? 'No tankers yet. Add the first loaded tanker.' : pivotSel ? 'No tankers match the selected cell.' : 'No tankers in this date range.'}</TableCell></TableRow>
                        : tankerPaged.pageRows.map(renderTankerRow)}
                  </TableBody>
                </Table>
                <Pagination {...tankerPaged} label="tankers" className="border-t px-3" />
              </div>
              {/* The rest of the SAME pivot-counted set — received in this
                  window, but loaded before/after it. Not a wider historical
                  query: card above + this card always total the pivot's own
                  grand total, no more. */}
              {outOfRangeTankers.length > 0 && (
                <div className="overflow-hidden rounded-xl border bg-card">
                  <div className="flex items-center gap-1.5 border-b bg-amber-50 px-3 py-2">
                    <CalendarDays className="h-3.5 w-3.5 text-amber-600" />
                    <span className="text-xs font-semibold text-amber-800">
                      Loaded outside {formatDate(pivotStart)} – {formatDate(pivotEnd)}
                    </span>
                    <Badge variant="warning" className="text-[10px]">{outOfRangeTankers.length}</Badge>
                  </div>
                  <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                    {tankerTableHeader()}
                    <TableBody>{outOfRangePaged.pageRows.map(renderTankerRow)}</TableBody>
                  </Table>
                  <Pagination {...outOfRangePaged} label="tankers" className="border-t px-3" />
                </div>
              )}
            </TabsContent>

            <TabsContent value="purchases">
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">
                  {/* Dark fill on the THEAD, not the row — see Sales.tsx. */}
                  <TableHeader className="bg-[#1a2c56] [&_th]:text-white"><TableRow className="border-b-2 border-[#1a2c56]/30">
                    {PO_COLUMNS.map((c) => (
                      <TableHead
                        key={c.key}
                        className={cn(
                          c.key === 'tanker_count' && 'text-center',
                          (c.key === 'ordered_qty' || c.key === 'net_amount') && 'text-right',
                          c.key === 'shortage' && 'w-[130px]'
                        )}
                      >
                        <ColumnFilter
                          label={c.label}
                          options={poColOptions(c.key)}
                          value={poCols[c.key] ?? []}
                          onDark
                          onApply={(v) => setPoCols((p) => ({ ...p, [c.key]: v }))}
                          align={c.key === 'net_amount' || c.key === 'ordered_qty' ? 'end' : 'start'}
                        />
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {/* Totals for exactly the rows the filters left — sits under
                        the header so the figure is read before scrolling. */}
                    {!loading && filteredOrders.length > 0 && (
                      <TableRow className="border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50">
                        <TableCell className="font-semibold text-amber-900">
                          Total
                          <span className="ml-1.5 font-normal text-amber-800/70">
                            ({filteredOrders.length} invoice{filteredOrders.length === 1 ? '' : 's'})
                          </span>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                        <TableCell className="text-center font-semibold tabular-nums text-amber-900">
                          {filteredOrders.reduce((t, r) => t + (Number(r.tanker_count) || 0), 0)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-900">
                          {formatNum(filteredOrders.reduce((t, r) => t + (Number(r.ordered_qty) || 0), 0))}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-900">
                          {formatINR(filteredOrders.reduce((t, r) => t + (Number(r.net_amount) || 0), 0))}
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    )}
                    {loading ? <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : filteredOrders.length === 0 ? <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">{rows.length ? 'No purchase entry matches these filters.' : 'No purchase entries yet.'}</TableCell></TableRow>
                        : orderPaged.pageRows.map((row) => <TableRow key={row.id} className="hover:bg-amber-50">
                          <TableCell>
                            <div className="font-medium">{row.invoice_no}</div>
                            <div className="text-[11px] text-muted-foreground">{formatDate(row.order_date)}</div>
                            {row._shownForReceipt && (
                              <div
                                className="text-[10px] text-sky-600"
                                title="Invoiced outside this date range, but a tanker on it was received within it"
                              >
                                shown for receipt date
                              </div>
                            )}
                          </TableCell>
                          <TableCell>{row.supplier_name}</TableCell>
                          <TableCell className="uppercase text-muted-foreground">{row.product_category || '—'}</TableCell>
                          <TableCell className="font-medium">{row.oil_code || row.oil_name || '—'}</TableCell>
                          <TableCell className="text-center"><Badge variant="secondary">{row.tanker_count || 0}</Badge></TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(row.ordered_qty)} {row.uom}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatINR(row.net_amount)}</TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {(() => {
                              const f = poFreight(row)
                              const cond = invoiceCondition(row)
                              const label = cond.split(' — ')[0]
                              const due = f.deduct > 0
                              if (f.freight <= 0 && f.deduct <= 0 && !cond) return <span className="text-muted-foreground">—</span>
                              return (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={due ? 'Debit note due — click for the figures' : 'Click for the freight figures'}
                                      className={cn(
                                        'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                                        due
                                          ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300 hover:bg-rose-200'
                                          : label.startsWith('EX')
                                            ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                                            : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                                      )}
                                    >
                                      {label}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="end" className="w-64 p-3 text-[12px]">
                                    <div className="mb-1.5 border-b pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                                      {cond}
                                    </div>
                                    {poCarriers(row).map((cr, i) => (
                                      <div key={i} className="flex items-baseline justify-between gap-3 py-0.5">
                                        <span className="min-w-0 truncate">{cr.name || 'No transporter set'}</span>
                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                          {cr.rate > 0 ? `${formatINR(cr.rate)}/${row.uom || 'MT'}` : '—'}
                                        </span>
                                      </div>
                                    ))}
                                    <div className="mt-1 flex justify-between border-t pt-1.5 font-semibold">
                                      <span>Deductible</span>
                                      <span className={cn('tabular-nums', due && 'text-rose-700')}>
                                        {due ? formatINR(f.deduct) : '—'}
                                      </span>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )
                            })()}
                          </TableCell>
                          <TableCell>
                            <Badge variant={row.status === 'received' ? 'success' : 'warning'}>
                              {row.status === 'received' ? 'Completed' : 'In process'}
                            </Badge>
                          </TableCell>
                          <TableCell><div className="flex justify-end">
                            <RowActions
                              actions={[
                                { label: 'View details', icon: Eye, onClick: () => setDetailRow(row) },
                                { label: 'Edit purchase', icon: Pencil, onClick: () => openEditPurchase(row) },
                                { label: 'History — who did what', icon: History, onClick: () => openHistory(row) },
                                { label: 'Delete purchase', icon: Trash2, danger: true, onClick: () => deletePurchase(row) }
                              ]}
                            />
                          </div></TableCell>
                        </TableRow>)}
                  </TableBody>
                </Table>
                <Pagination {...orderPaged} label="invoices" className="border-t px-3" />
              </div>
            </TabsContent>

            <TabsContent value="unmapped" className="space-y-4">
              <div className="overflow-hidden rounded-xl border-2 border-red-200 bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-3">
                  <div>
                    <h3 className="font-medium text-red-900">Unmapped invoices</h3>
                    <p className="text-xs text-red-800/80">
                      Purchase invoices with no live bargain behind them — usually because the bargain was deleted.
                      Assign one or more bargains so the bargain register counts them again.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ExcelButton
                      filename={`unmapped-invoices-${todayISO()}`}
                      sheetName="Unmapped"
                      title="Unmapped purchase invoices"
                      columns={[
                        { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                        { header: 'Date', key: 'order_date', value: (r) => formatDate(r.order_date) },
                        { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                        { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
                        { header: 'Qty', key: 'ordered_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.ordered_qty) || 0 },
                        { header: 'Rate', key: 'invoice_rate', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.invoice_rate) || 0 },
                        { header: 'Taxable value', key: 'taxable_value', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.taxable_value) || 0 },
                        { header: 'Tankers', key: 'tanker_nos', value: (r) => r.tanker_nos || '' },
                        { header: 'Reason', key: 'reason', value: (r) => (Number(r.was_linked) === 1 ? 'Bargain deleted' : 'Never linked') }
                      ]}
                      rows={unmapped}
                    />
                    <Badge variant={unmapped.length ? 'destructive' : 'success'}>
                      {unmapped.length ? `${unmapped.length} to map` : 'All mapped'}
                    </Badge>
                  </div>
                </div>
                <Table
                  className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3"
                  wrapperClassName="max-h-[65vh] overflow-auto"
                >
                  <TableHeader className="sticky top-0 z-10">
                    <TableRow className="bg-muted">
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Invoice</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Date</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Supplier</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Product</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Qty</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Rate</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Taxable value</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Tankers</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Why</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={10} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                    ) : unmapped.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                          Every purchase invoice is linked to a bargain.
                        </TableCell>
                      </TableRow>
                    ) : (
                      unmappedPaged.pageRows.map((r, i) => (
                        <TableRow key={r.id as number} className={cn('border-b', i % 2 === 1 && 'bg-muted/30')}>
                          <TableCell className="font-medium">{r.invoice_no}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(r.order_date)}</TableCell>
                          <TableCell>{r.supplier_name}</TableCell>
                          <TableCell>{r.product_code || r.product_name}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatNum(r.ordered_qty)} {r.uom}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(r.invoice_rate)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatINR(r.taxable_value)}</TableCell>
                          <TableCell className="max-w-[160px] truncate text-muted-foreground">
                            {r.tanker_nos || (Number(r.is_trading) === 1 ? 'trading' : Number(r.is_consignment) === 1 ? 'consignment' : '—')}
                          </TableCell>
                          <TableCell>
                            <Badge variant={Number(r.was_linked) === 1 ? 'destructive' : 'warning'}>
                              {Number(r.was_linked) === 1 ? 'Bargain deleted' : 'Never linked'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" onClick={() => openMap(r)}>Assign bargains</Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <Pagination {...unmappedPaged} label="invoices" className="border-t px-3" />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={loadingOpen} onOpenChange={setLoadingOpen}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>Send tankers to supplier — to be loaded</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Pick the oil and supplier once — the oldest open bargain is auto-selected for every tanker (changeable per tanker). Loaded quantity and payment are entered after loading.
          </p>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label>Oil *</Label>
              <Select value={String(loadingForm.oil_pick || '')} onValueChange={pickOil}>
                <SelectTrigger><SelectValue placeholder="Select oil" /></SelectTrigger>
                <SelectContent>
                  {bargainOils.map(([id, label]) => (
                    <SelectItem key={id} value={id}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(loadingForm.supplier_pick || '')} onValueChange={pickSupplier} disabled={!loadingForm.oil_pick}>
                <SelectTrigger><SelectValue placeholder={loadingForm.oil_pick ? 'Select supplier' : 'Pick oil first'} /></SelectTrigger>
                <SelectContent>
                  {suppliersForOil(String(loadingForm.oil_pick || '')).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Number of tankers</Label>
              <Input type="number" min="1" max="20" value={loadingForm.tanker_count} onChange={(e) => setTankerCount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Tanker placement date</Label>
              <DatePicker value={loadingForm.factory_entry_date || ''} onChange={(v) => setLoadingForm((p) => ({ ...p, factory_entry_date: v }))} />
            </div>
          </div>
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {loadingRows.map((row, index) => (
              <div
                key={index}
                className="grid items-start gap-3 rounded-lg border p-3 md:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.5fr)_5.5rem_minmax(0,1.2fr)]"
              >
                <div className="flex h-9 items-center justify-center rounded-md bg-muted text-sm font-semibold md:mt-[26px]">
                  {index + 1}
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Tanker number</Label>
                  <Input placeholder="optional — set at loading" value={row.tanker_no || ''} onChange={(e) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, tanker_no: e.target.value } : item))} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Bargain (oldest auto) *</Label>
                  <Select
                    value={String(row.bargain_id || '')}
                    onValueChange={(value) => selectLoadingBargain(index, value)}
                    disabled={!loadingForm.oil_pick || !loadingForm.supplier_pick}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={loadingForm.supplier_pick ? 'Select bargain' : 'Pick oil & supplier above'} />
                    </SelectTrigger>
                    <SelectContent className="w-[min(30rem,85vw)]">
                      {routeBargains(loadingForm).map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Condition</Label>
                  <div className="flex h-9 rounded-md border p-0.5">
                    {['EX', 'DLD'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, condition: c } : item))}
                        className={cn(
                          'flex-1 rounded text-xs font-semibold transition-colors',
                          (row.condition || 'EX') === c ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Transporter</Label>
                  <Select value={String(row.transporter_id || '')} onValueChange={(value) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, transporter_id: value } : item))}>
                    <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                    <SelectContent>
                      {transporters.map((tr) => (
                        <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setLoadingOpen(false)}>Cancel</Button><Button onClick={createTanker}>Send {loadingRows.length} tanker{loadingRows.length === 1 ? '' : 's'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!actionRow} onOpenChange={(open) => { if (!open) { setActionRow(null); setExcess(null) } }}>
        <DialogContent
          className={cn(
            'max-h-[92vh] w-[calc(100vw-2rem)] overflow-y-auto',
            target === 'empty' ? 'sm:max-w-3xl' : 'sm:max-w-2xl'
          )}
        >
          <DialogHeader><DialogTitle>{target ? `Move ${String(actionRow?.tanker_no || '').trim() || 'tanker'} to ${TANKER_LABEL[target]}` : 'Update tanker'}</DialogTitle></DialogHeader>
          {target === 'loaded' && actionRow && <div className="grid gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Tanker number *{String(actionRow.tanker_no || '').trim() ? '' : ' (set it now)'}</Label>
              <Input
                placeholder="e.g. RJ04GD0469"
                value={actionForm.tanker_no ?? ''}
                onChange={(e) => setActionForm((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Bargain (auto-selected — change if needed)</Label>
              <Select
                value={String(actionForm.bargain_id || '')}
                onValueChange={(v) => { setExcess(null); setActionForm((p) => ({ ...p, bargain_id: v })) }}
              >
                <SelectTrigger><SelectValue placeholder="Select bargain" /></SelectTrigger>
                <SelectContent>
                  {bargains
                    .filter(
                      (b) =>
                        String(b.supplier_id) === String(actionRow.supplier_id) &&
                        String(b.oil_type_id) === String(actionRow.oil_type_id)
                    )
                    .sort((a, b) => String(a.bargain_no || '').localeCompare(String(b.bargain_no || '')))
                    .map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">{actionRow.supplier_name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Loaded date</Label><DatePicker value={actionForm.loaded_date || ''} onChange={(v) => setActionForm((p) => ({ ...p, loaded_date: v }))} /></div>
              <div className="flex flex-col gap-1.5"><Label>Actual loaded quantity *</Label><Input type="number" value={actionForm.loaded_qty || ''} onChange={(e) => { setExcess(null); setActionForm((p) => ({ ...p, loaded_qty: e.target.value })) }} /></div>
            </div>
            {excess && (() => {
              // Other open bargains (same supplier + oil) that can absorb the excess.
              const nextBargains = bargains.filter(
                (b) =>
                  String(b.supplier_id) === String(actionRow.supplier_id) &&
                  String(b.oil_type_id) === String(actionRow.oil_type_id) &&
                  String(b.id) !== String(actionForm.bargain_id) &&
                  Number(b.balance_qty) >= excess.qty - 1e-6
              )
              return (
                <div className="space-y-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  <p>
                    This bargain has only <b>{formatNum(excess.balance)} {actionRow.uom}</b> left. Choose where the extra{' '}
                    <b>{formatNum(excess.qty)} {actionRow.uom}</b> should go:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'new' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'new' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Book as a new bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'existing' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'existing' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Use the next available bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'expand' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'expand' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Add to this bargain
                    </button>
                  </div>

                  {excess.mode === 'expand' ? (
                    <p className="text-[11px]">
                      This bargain will be increased by <b>{formatNum(excess.qty)} {actionRow.uom}</b> (at its own rate) so the full load stays on it. The top-up is logged as an Addition on the bargain.
                    </p>
                  ) : excess.mode === 'new' ? (
                    <>
                      <p className="text-[11px]">A new bargain line will be created for {actionRow.supplier_name}.</p>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={excess.diffRate}
                          onCheckedChange={(v) => setExcess((p) => (p ? { ...p, diffRate: v } : p))}
                        />
                        <span>A different rate applies to the extra quantity</span>
                      </div>
                      {excess.diffRate && (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-amber-900">Rate for the extra qty (per {actionRow.uom})</Label>
                          <Input
                            type="number"
                            className="bg-white"
                            value={excess.rate}
                            onChange={(e) => setExcess((p) => (p ? { ...p, rate: e.target.value } : p))}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-amber-900">Next bargain for the excess</Label>
                      {nextBargains.length === 0 ? (
                        <p className="text-[11px]">
                          No other open bargain for {actionRow.supplier_name} has {formatNum(excess.qty)} {actionRow.uom} free — book it as a new bargain instead.
                        </p>
                      ) : (
                        <Select
                          value={excess.targetBargainId}
                          onValueChange={(v) => setExcess((p) => (p ? { ...p, targetBargainId: v } : p))}
                        >
                          <SelectTrigger className="bg-white"><SelectValue placeholder="Select bargain" /></SelectTrigger>
                          <SelectContent>
                            {nextBargains
                              .sort((a, b) => String(a.bargain_date || '').localeCompare(String(b.bargain_date || '')))
                              .map((b) => (
                                <SelectItem key={b.id} value={String(b.id)}>
                                  {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label>Source / port</Label>
              <Select value={String(actionForm.source_id || '')} onValueChange={(value) => setActionForm((p) => ({ ...p, source_id: value }))}>
                <SelectTrigger><SelectValue placeholder="Where it loads from" /></SelectTrigger>
                <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)]">
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={String(source.id)}>
                      <span className="block truncate">{source.name} · {source.transit_days}d</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><Label>Payment arrangement</Label>
              <Select value={actionForm.payment_mode || 'paid_by_us'} onValueChange={(value) => setActionForm((p) => ({ ...p, payment_mode: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                  <SelectItem value="supplier_finance">Supplier financed — pay later</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              This records the loading only. Sending it on its way is the next step, In transit, which asks for the transporter
              rate and works the expected delivery out from the source&rsquo;s transit days. A purchase invoice is not required
              first.
            </p>
          </div>}
          {target === 'transit' && actionRow && (() => {
            // The freight rate is agreed when the tanker sets off, so it is
            // asked for here rather than weeks later at Empty. Only an EX load
            // is ours to pay, so only EX makes it compulsory.
            const ex = condIsEx(actionRow)
            return (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5"><Label>Transit date</Label><DatePicker value={actionForm.transit_date || ''} min={actionRow?.loaded_date || undefined} onChange={(v) => setActionForm((p) => ({ ...p, transit_date: v }))} /></div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>Source / port</Label>
                    <Select value={String(actionForm.source_id || '')} onValueChange={(v) => setActionForm((p) => ({ ...p, source_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)]">
                        {sources.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            <span className="block truncate">{s.name} · {s.transit_days}d</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
                  <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700')}>
                      {ex ? 'EX' : 'DLD'}
                    </span>
                    <span className="text-muted-foreground">
                      {ex
                        ? 'We pay the freight on this tanker, so the rate is required.'
                        : 'The supplier carries the freight — the rate is only for the record.'}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    <Select
                      value={String(actionForm.transporter_id || '')}
                      onValueChange={(v) => {
                        const tr = transporters.find((x) => String(x.id) === v)
                        setActionForm((p) => ({
                          ...p,
                          transporter_id: v,
                          transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || ''
                        }))
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Transporter rate / {actionRow.uom || 'MT'}
                      {ex && <span className="ml-1 text-rose-600">*</span>}
                    </Label>
                    <Input
                      type="number"
                      className={cn(ex && !(Number(actionForm.transport_rate_per_ton) > 0) && 'border-rose-400')}
                      placeholder={ex ? 'Required' : 'Optional'}
                      value={actionForm.transport_rate_per_ton ?? ''}
                      onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))}
                    />
                    {Number(actionForm.transport_rate_per_ton) > 0 && Number(actionRow.loaded_qty) > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        ≈ {formatINR(Number(actionForm.transport_rate_per_ton) * Number(actionRow.loaded_qty))} on{' '}
                        {formatNum(actionRow.loaded_qty)} {actionRow.uom || 'MT'} loaded — settles on the received qty.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
          {target === 'outside_factory' && <div className="flex flex-col gap-1.5"><Label>Outside factory date</Label><DatePicker value={actionForm.outside_factory_date || ''} min={actionRow?.transit_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm({ outside_factory_date: v })} /></div>}
          {target === 'inside_factory' && <div className="flex flex-col gap-1.5"><Label>Inside factory date</Label><DatePicker value={actionForm.inside_factory_date || ''} min={actionRow?.outside_factory_date || actionRow?.transit_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm({ inside_factory_date: v })} /></div>}
          {target === 'empty' && actionRow && shortage && <div className="grid gap-4">
            {(() => {
              const gq = gateQtyFor(actionRow.id)
              const hasPending = gateEntries.some(
                (g) => Number(g.tanker_id) === Number(actionRow.id) && g.status === 'pending'
              )
              return gq == null ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {hasPending
                    ? `Tanker ${actionRow.tanker_no} arrived at the gate but its weight is still pending. Complete the weighment in Gate Entry first — this step is blocked until then.`
                    : `No gate entry recorded for tanker ${actionRow.tanker_no}. Record the gate receipt in Gate Entry first — this step is blocked until then.`}
                </div>
              ) : (
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  Gate received qty: <span className="font-semibold tabular-nums">{formatNum(gq)} {actionRow.uom}</span>
                  <span className="text-muted-foreground"> — the received quantity must match this.</span>
                </div>
              )
            })()}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Empty date</Label><DatePicker value={actionForm.empty_date || ''} min={actionRow?.inside_factory_date || actionRow?.outside_factory_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm((p) => ({ ...p, empty_date: v }))} /></div>
              <div className="flex flex-col gap-1.5"><Label>Received quantity</Label><Input type="number" value={actionForm.received_qty || ''} onChange={(e) => setActionForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            {(() => {
              // Both of these are settled when the tanker is sent In transit, so
              // here they are a read-back rather than a question. A tanker that
              // reached transit before the rate was asked for there has nothing
              // to show, so those stay editable — otherwise the load could never
              // be completed.
              const agreed = Number(actionRow.transport_rate_per_ton) > 0
              const tName = transporters.find((x) => String(x.id) === String(actionForm.transporter_id))?.name || ''
              return (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    {agreed ? (
                      <div className="flex h-10 items-center rounded-md border bg-muted/50 px-3 text-sm">{tName || '—'}</div>
                    ) : (
                      <Select value={String(actionForm.transporter_id || '')} onValueChange={(v) => {
                        const tr = transporters.find((x) => String(x.id) === v)
                        setActionForm((p) => ({ ...p, transporter_id: v, transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || '' }))
                      }}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent></Select>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transport rate / {actionRow.uom}</Label>
                    {agreed ? (
                      <>
                        <div className="flex h-10 items-center justify-between rounded-md border bg-muted/50 px-3 text-sm tabular-nums">
                          <span>{formatINR(actionRow.transport_rate_per_ton)}</span>
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">set at In transit</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground">Change it on the tanker&apos;s Edit form if it was agreed differently.</span>
                      </>
                    ) : (
                      <>
                        <Input type="number" value={actionForm.transport_rate_per_ton || ''} onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} />
                        <span className="text-[11px] text-muted-foreground">No rate was captured at In transit for this tanker — enter it here.</span>
                      </>
                    )}
                  </div>
                </div>
              )
            })()}
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="text-sm font-medium">KRFL weighment slip</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label>Doc number</Label><Input value={actionForm.krfl_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} /></div>
                <div className="flex flex-col gap-1.5">
                  <Label>Photo upload</Label>
                  <input type="file" accept="image/*" className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1.5 file:text-xs file:font-medium" onChange={(e) => onWeighmentPhoto('krfl_weighment_photo', e.target.files?.[0])} />
                </div>
              </div>
              {actionForm.krfl_weighment_photo && <img src={actionForm.krfl_weighment_photo} alt="KRFL weighment slip" className="max-h-32 w-fit rounded-md border" />}
            </div>
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="text-sm font-medium">Outside factory weighment slip</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label>Doc number</Label><Input value={actionForm.outside_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, outside_weighment_doc_no: e.target.value }))} /></div>
                <div className="flex flex-col gap-1.5">
                  <Label>Photo upload</Label>
                  <input type="file" accept="image/*" className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1.5 file:text-xs file:font-medium" onChange={(e) => onWeighmentPhoto('outside_weighment_photo', e.target.files?.[0])} />
                </div>
              </div>
              {actionForm.outside_weighment_photo && <img src={actionForm.outside_weighment_photo} alt="Outside factory weighment slip" className="max-h-32 w-fit rounded-md border" />}
            </div>
            <div className="rounded-lg border bg-muted/30 p-3"><MoneyRow label="Loaded" value={`${formatNum(actionRow.loaded_qty)} ${actionRow.uom}`} /><MoneyRow label="Shortage" value={`${formatNum(shortage.actualShortage)} ${actionRow.uom}`} /><MoneyRow label="Freight" value={formatINR(shortage.transportAmount)} /></div>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => { setActionRow(null); setExcess(null) }}>Cancel</Button><Button
            onClick={advanceTanker}
            disabled={target === 'transit' && !!actionRow && condIsEx(actionRow) && !(Number(actionForm.transport_rate_per_ton) > 0)}
            title={
              target === 'transit' && !!actionRow && condIsEx(actionRow) && !(Number(actionForm.transport_rate_per_ton) > 0)
                ? 'Enter the transporter rate — it is required on an EX tanker'
                : undefined
            }
          >{excess ? (excess.mode === 'existing' ? 'Allocate & confirm' : 'Add bargain & confirm') : 'Confirm'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign bargains to an unmapped invoice */}
      <Dialog open={!!mapRow} onOpenChange={(o) => !o && setMapRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Assign bargains — invoice {mapRow?.invoice_no}</DialogTitle>
          </DialogHeader>
          {mapRow && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-muted/40 p-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-[11px] text-muted-foreground">Supplier</div>
                  <div className="font-medium">{mapRow.supplier_name}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Product</div>
                  <div className="font-medium">{mapRow.product_code || mapRow.product_name}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Invoice quantity</div>
                  <div className="font-medium tabular-nums">
                    {formatNum(mapRow.ordered_qty)} {mapRow.uom}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Taxable value</div>
                  <div className="font-medium tabular-nums">{formatINR(mapRow.taxable_value)}</div>
                </div>
              </div>

              {/* One line per bargain. The same bargain can be added twice — the
                  quantities are merged when it is saved. */}
              <div className="space-y-2">
                {mapLines.map((line, index) => {
                  const bg = bargains.find((b) => String(b.id) === String(line.bargain_id))
                  const balance = bg ? Number(bg.balance_qty) || 0 : 0
                  const qty = Number(line.qty) || 0
                  const short = qty - balance
                  return (
                    <div key={index} className="grid gap-2 rounded-lg border p-2.5 md:grid-cols-[minmax(0,1fr)_7rem_auto]">
                      <div className="flex min-w-0 flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">Bargain</Label>
                        <Select
                          value={String(line.bargain_id || '')}
                          onValueChange={(v) =>
                            setMapLines((p) => p.map((x, i) => (i === index ? { ...x, bargain_id: v } : x)))
                          }
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder={mapBargains.length ? 'Select bargain' : 'No bargain for this supplier & product'} />
                          </SelectTrigger>
                          <SelectContent>
                            {mapBargains.map((b) => (
                              <SelectItem key={b.id} value={String(b.id)}>
                                {b.bargain_no} · {formatDate(b.bargain_date)} · bal {formatNum(b.balance_qty)} {b.uom} @{' '}
                                {formatINR(b.rate_per_uom)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">Qty ({mapRow.uom})</Label>
                        <Input
                          type="number"
                          className="h-9 text-right"
                          value={line.qty ?? ''}
                          onChange={(e) =>
                            setMapLines((p) => p.map((x, i) => (i === index ? { ...x, qty: e.target.value } : x)))
                          }
                        />
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="min-w-[9rem] pb-1 text-[11px] leading-tight">
                          {bg ? (
                            <>
                              <div className="tabular-nums text-muted-foreground">
                                {formatINR(Number(bg.rate_per_uom) * qty)}
                              </div>
                              {short > 0.0001 ? (
                                <label className="mt-0.5 flex cursor-pointer items-start gap-1.5 text-amber-800">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5 h-3 w-3 accent-amber-600"
                                    checked={!!line.top_up}
                                    onChange={(e) =>
                                      setMapLines((p) =>
                                        p.map((x, i) => (i === index ? { ...x, top_up: e.target.checked } : x))
                                      )
                                    }
                                  />
                                  <span>
                                    {formatNum(short)} over balance — add it to the bargain
                                  </span>
                                </label>
                              ) : (
                                <div className="text-muted-foreground">
                                  balance left {formatNum(balance - qty)}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">pick a bargain</span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive"
                          disabled={mapLines.length === 1}
                          onClick={() => setMapLines((p) => p.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMapLines((p) => [...p, { bargain_id: '', qty: '', top_up: false }])}
                >
                  <Plus className="h-4 w-4" /> Add another bargain
                </Button>
              </div>

              {/* Quantity and value reconciliation */}
              <div className="rounded-lg border">
                <MoneyRow
                  label="Allocated quantity"
                  value={`${formatNum(mapAllocated)} of ${formatNum(mapRow.ordered_qty)} ${mapRow.uom}`}
                  strong
                />
                {Math.abs(mapRemaining) > 0.0001 && (
                  <MoneyRow
                    label={mapRemaining > 0 ? 'Still to allocate' : 'Over-allocated by'}
                    value={`${formatNum(Math.abs(mapRemaining))} ${mapRow.uom}`}
                  />
                )}
                <div className="mx-3 border-t" />
                <MoneyRow label="Value at bargain rates" value={formatINR(mapBargainValue)} />
                <MoneyRow label="Invoice taxable value" value={formatINR(mapRow.taxable_value)} />
                <MoneyRow label="Difference" value={formatINR(mapValueDiff)} strong />
              </div>

              {Math.abs(mapValueDiff) > 1 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Values do not match.</span> The invoice was booked at{' '}
                  {formatINR(mapRow.taxable_value)} but these bargains price it at {formatINR(mapBargainValue)} — a
                  difference of {formatINR(mapValueDiff)}. That is normal when the invoice carries interest or freight;
                  check it before saving.
                </div>
              )}
              {mapWarn && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {mapWarn}
                </div>
              )}
              {mapError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {mapError}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMapRow(null)} disabled={mapping}>
              Cancel
            </Button>
            <Button onClick={() => saveMapping(false)} disabled={mapping}>
              {mapping ? 'Saving…' : Math.abs(mapValueDiff) > 1 ? 'Check and assign' : 'Assign bargains'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace a tanker mid-transit (accident/breakdown) */}
      <Dialog open={!!replaceRow} onOpenChange={(open) => !open && setReplaceRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace tanker {replaceRow?.tanker_no}</DialogTitle>
          </DialogHeader>
          {replaceRow && (
            <div className="grid gap-3">
              <p className="text-[12px] text-muted-foreground">
                Bargain, financials and the invoice link stay on this record — only the vehicle number changes, and
                any quantity lost comes off what it's now expected to deliver ({formatNum(replaceRow.loaded_qty)} {replaceRow.uom} loaded so far).
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>Replacement tanker number *</Label>
                <Input value={replaceForm.new_tanker_no ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, new_tanker_no: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity lost ({replaceRow.uom})</Label>
                  <Input type="number" value={replaceForm.loss_qty ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, loss_qty: e.target.value })} placeholder="0" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={replaceForm.date || ''} onChange={(v) => setReplaceForm({ ...replaceForm, date: v })} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Reason</Label>
                <Input value={replaceForm.reason ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, reason: e.target.value })} placeholder="e.g. accident en route" />
              </div>
              {Number(replaceForm.loss_qty) > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  New expected quantity: {formatNum(Math.max(0, Number(replaceRow.loaded_qty) - Number(replaceForm.loss_qty)))} {replaceRow.uom}
                </div>
              )}
              {replaceError && <p className="text-sm text-destructive">{replaceError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceRow(null)} disabled={replaceSaving}>Cancel</Button>
            <Button onClick={() => void saveReplaceTanker()} disabled={replaceSaving}>{replaceSaving ? 'Saving…' : 'Replace tanker'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <HistoryDialog target={hist.target} onClose={hist.close} />

      {/* Edit all stage entries of a tanker */}
      <Dialog open={!!editTanker} onOpenChange={(open) => !open && setEditTanker(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit tanker {editTanker?.tanker_no} — {TANKER_LABEL[String(editTanker?.status)] ?? editTanker?.status}</DialogTitle>
          </DialogHeader>
          {editTanker && (() => {
            const eIdx = TANKER_STAGES.indexOf(String(editTanker.status))
            const eGate = gateQtyFor(editTanker.id)
            return (
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Tanker number</Label>
                    <Input value={editTankerForm.tanker_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, tanker_no: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>{editTanker.extra_bargain_id ? 'Bargain (primary)' : 'Bargain'}</Label>
                    <Select value={String(editTankerForm.bargain_id || '')} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, bargain_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select bargain" /></SelectTrigger>
                      <SelectContent>
                        {bargains
                          .filter((b) => String(b.supplier_id) === String(editTanker.supplier_id) && String(b.oil_type_id) === String(editTanker.oil_type_id))
                          .map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · BAL {formatNum(b.balance_qty)}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* EX/DLD decides who bears the freight and who carries the
                    shortage beyond tolerance, so it's correctable here rather
                    than only at send-to-supplier time. */}
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1">
                    Condition
                    <InfoTip text="EX — we bear the freight and the supplier owes us shortage beyond tolerance. DLD — the supplier delivers, so no freight of ours and no shortage deduction. 'Follow bargain' uses whatever this tanker's bargain says." />
                  </Label>
                  <div className="flex h-9 w-fit rounded-md border p-0.5">
                    {[
                      { v: '', label: 'Follow bargain' },
                      { v: 'EX', label: 'EX' },
                      { v: 'DLD', label: 'DLD' }
                    ].map((c) => (
                      <button
                        key={c.v || 'inherit'}
                        type="button"
                        onClick={() => setEditTankerForm((p) => ({ ...p, condition: c.v }))}
                        className={cn(
                          'rounded px-3 text-xs font-semibold transition-colors',
                          String(editTankerForm.condition || '') === c.v
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {!String(editTankerForm.condition || '') && (
                    <span className="text-[11px] text-muted-foreground">
                      Following the bargain — currently{' '}
                      <b>{['DLD', 'DELIVERED'].includes(String(editTanker.bargain_type || '').toUpperCase()) ? 'DLD' : 'EX'}</b>
                    </span>
                  )}
                </div>

                {!!editTanker.extra_bargain_id && (() => {
                  const loaded = Number(editTankerForm.loaded_qty ?? editTanker.loaded_qty) || 0
                  const extra = Number(editTanker.extra_qty) || 0
                  const primary = Math.max(0, loaded - extra)
                  return (
                    <div className="overflow-hidden rounded-md border border-sky-200">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-sky-50 text-left text-sky-900">
                            <th className="px-3 py-1.5 font-semibold">Bargain</th>
                            <th className="px-3 py-1.5 font-semibold">Share</th>
                            <th className="px-3 py-1.5 text-right font-semibold">Qty ({editTanker.uom})</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b bg-card">
                            <td className="px-3 py-1.5 font-medium">{editTanker.bargain_no}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">Primary</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(primary)}</td>
                          </tr>
                          <tr className="border-b bg-card">
                            <td className="px-3 py-1.5 font-medium">{editTanker.extra_bargain_no || `Bargain #${editTanker.extra_bargain_id}`}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">Excess</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(extra)}</td>
                          </tr>
                          <tr className="bg-sky-50/60 font-semibold text-sky-900">
                            <td className="px-3 py-1.5" colSpan={2}>Total loaded</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(loaded)}</td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="border-t bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900">
                        The excess allocation stays on {editTanker.extra_bargain_no || 'its bargain'} when you edit — changing the loaded qty adjusts only the primary share.
                      </p>
                    </div>
                  )
                })()}

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>{eIdx <= 0 ? 'Tanker placement date' : 'Loaded date'}</Label>
                    <DatePicker value={editTankerForm.loaded_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, loaded_date: v }))} />
                  </div>
                  {eIdx >= 2 && (
                    <div className="flex flex-col gap-1.5">
                      <Label>Loaded qty ({editTanker.uom})</Label>
                      <Input type="number" value={editTankerForm.loaded_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, loaded_qty: e.target.value }))} />
                    </div>
                  )}
                </div>

                {eIdx >= 2 && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Payment</Label>
                      <Select value={editTankerForm.payment_mode || 'paid_by_us'} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, payment_mode: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                          <SelectItem value="supplier_finance">Supplier financed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Transit date</Label>
                      <DatePicker value={editTankerForm.transit_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, transit_date: v }))} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Source / port</Label>
                      <Select value={String(editTankerForm.source_id || '')} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, source_id: v }))}>
                        <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          {sources.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} · {s.transit_days}d</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {eIdx >= 2 && (
                  <div className="grid gap-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      <span className="font-medium">Freight</span>
                      <span className="text-muted-foreground">
                        Agreed when the tanker goes In transit; change it here if it was settled differently. Priced on the
                        received quantity.
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label>Transporter</Label>
                        <Select value={String(editTankerForm.transporter_id || '')} onValueChange={(v) => {
                          const tr = transporters.find((x) => String(x.id) === v)
                          setEditTankerForm((p) => ({
                            ...p,
                            transporter_id: v,
                            transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || ''
                          }))
                        }}>
                          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent className="max-h-72">
                            {transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label>Transport rate / {editTanker.uom}</Label>
                        <Input type="number" value={editTankerForm.transport_rate_per_ton ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} />
                        {Number(editTankerForm.transport_rate_per_ton) > 0 && (
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            ≈ {formatINR(
                              Number(editTankerForm.transport_rate_per_ton) *
                                (Number(editTankerForm.received_qty) > 0
                                  ? Number(editTankerForm.received_qty)
                                  : Number(editTanker.loaded_qty) || 0)
                            )}
                            {Number(editTankerForm.received_qty) > 0 ? ' on the received qty' : ' on the loaded qty (until weighed in)'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {eIdx >= 3 && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Outside factory date</Label>
                      <DatePicker value={editTankerForm.outside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, outside_factory_date: v }))} />
                    </div>
                    {eIdx >= 4 && (
                      <div className="flex flex-col gap-1.5">
                        <Label>Inside factory date</Label>
                        <DatePicker value={editTankerForm.inside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, inside_factory_date: v }))} />
                      </div>
                    )}
                  </div>
                )}

                {eIdx >= 5 && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label>Empty date</Label>
                        <DatePicker value={editTankerForm.empty_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, empty_date: v }))} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Received qty {eGate != null ? `(gate: ${formatNum(eGate)})` : ''}</Label>
                        <Input type="number" value={editTankerForm.received_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, received_qty: e.target.value }))} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label>KRFL weighment doc no</Label>
                        <Input value={editTankerForm.krfl_weighment_doc_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Outside factory weighment doc no</Label>
                        <Input value={editTankerForm.outside_weighment_doc_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, outside_weighment_doc_no: e.target.value }))} />
                      </div>
                    </div>
                  </>
                )}

                <p className="text-[11px] text-muted-foreground">
                  Changing quantities revalidates the bargain balance{eIdx >= 5 ? ', re-matches the gate weight and recalculates freight/shortage on the linked purchase' : ''}.
                </p>
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTanker(null)}>Cancel</Button>
            <Button onClick={saveEditTanker}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewTankerRow} onOpenChange={(open) => !open && setViewTankerRow(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>{String(viewTankerRow?.tanker_no || '').trim() || 'Tanker'}</span>
              {viewTankerRow && <StatusBadge status={String(viewTankerRow.status || '')} />}
            </DialogTitle>
          </DialogHeader>
          {viewTankerRow && (() => {
            const t = viewTankerRow
            const invoiceCompany = t.order_id
              ? companies.find((c) => Number(c.id) === Number(t.invoice_company_id))
              : null
            return (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <InfoTile icon={Building2} label="Supplier" value={t.supplier_name || '—'} />
                  <InfoTile icon={Boxes} label="Product" value={t.oil_code || t.oil_name || '—'} />
                  <InfoTile
                    icon={ScrollText}
                    label="Bargain"
                    value={t.bargain_no ? `${t.bargain_no}${t.extra_bargain_no ? ` + ${t.extra_bargain_no}` : ''}` : '—'}
                  />
                  <InfoTile icon={CalendarDays} label="Source" value={t.source_name || '—'} />
                </div>

                <div className="rounded-xl border">
                  <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                    <Boxes className="h-3.5 w-3.5 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Quantity</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-4">
                    <Fact label="Loaded" value={`${formatNum(t.loaded_qty)} ${t.uom || 'MT'}`} />
                    <Fact label="Received" value={t.received_qty != null ? `${formatNum(t.received_qty)} ${t.uom || 'MT'}` : '—'} />
                    {Number(t.extra_qty) > 0 && (
                      <Fact label="Split to extra bargain" value={`${formatNum(t.extra_qty)} ${t.uom || 'MT'}`} />
                    )}
                    {Number(t.loss_qty) > 0 && (
                      <Fact label="Lost (replaced)" value={`${formatNum(t.loss_qty)} ${t.uom || 'MT'}`} />
                    )}
                  </div>
                </div>

                <div className="rounded-xl border">
                  <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                    <CalendarDays className="h-3.5 w-3.5 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Timeline</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
                    <Fact label="Loaded" value={t.loaded_date ? formatDate(t.loaded_date) : '—'} />
                    <Fact label="In transit" value={t.transit_date ? formatDate(t.transit_date) : '—'} />
                    <Fact label="Expected delivery" value={t.expected_delivery_date ? formatDate(t.expected_delivery_date) : '—'} />
                    <Fact label="Outside factory" value={t.outside_factory_date ? formatDate(t.outside_factory_date) : '—'} />
                    <Fact label="Inside factory" value={t.inside_factory_date ? formatDate(t.inside_factory_date) : '—'} />
                    <Fact label="Empty" value={t.empty_date ? formatDate(t.empty_date) : '—'} />
                  </div>
                </div>

                {(() => {
                  // Read-only freight picture for this tanker. Shown for every EX
                  // load even before a transporter is attached, so a missing rate
                  // is visible here rather than only surfacing at Empty.
                  const ex = condIsEx(t)
                  const rate = Number(t.transport_rate_per_ton) || 0
                  const rec = t.received_qty != null ? Number(t.received_qty) : null
                  const basisQty = rec != null ? rec : Number(t.loaded_qty) || 0
                  if (!ex && !t.transporter_name && !(Number(t.transport_amount) > 0)) return null
                  return (
                    <div className="rounded-xl border">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-slate-50 px-3 py-2">
                        <Truck className="h-3.5 w-3.5 text-slate-500" />
                        <span className="text-xs font-semibold text-slate-700">Transport</span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700')}>
                          {ex ? 'EX — ours to pay' : 'DLD — supplier pays'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3 p-3">
                        <Fact label="Transporter" value={t.transporter_name || (ex ? 'Not set' : '—')} />
                        <Fact
                          label={`Rate / ${t.uom || 'MT'}`}
                          value={rate > 0 ? formatINR(rate) : ex ? 'Not set' : '—'}
                        />
                        <Fact
                          label="Freight amount"
                          value={Number(t.transport_amount) > 0 ? formatINR(t.transport_amount) : '—'}
                        />
                        {Number(t.shortage_charge_amount) > 0 && (
                          <Fact label="Less shortage charged" value={formatINR(t.shortage_charge_amount)} />
                        )}
                        {rate > 0 && (
                          <div className="col-span-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                            {/* Spelling out the basis, since freight is priced on
                                what arrived and that is not obvious from a total. */}
                            {formatNum(basisQty)} {t.uom || 'MT'} {rec != null ? 'received' : 'loaded'} × {formatINR(rate)} ={' '}
                            <span className="font-semibold tabular-nums text-foreground">{formatINR(basisQty * rate)}</span>
                            {rec == null && ' — settles on the received qty once weighed in'}
                            {rec != null && Number(t.shortage_charge_amount) > 0 && (
                              <> , less {formatINR(t.shortage_charge_amount)} shortage = <span className="font-semibold tabular-nums text-foreground">{formatINR(basisQty * rate - Number(t.shortage_charge_amount))}</span> earned</>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {t.gate_entry_no && (
                  <div className="rounded-xl border">
                    <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                      <DoorOpen className="h-3.5 w-3.5 text-slate-500" />
                      <span className="text-xs font-semibold text-slate-700">Gate</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 p-3">
                      <Fact label="Gate entry" value={t.gate_entry_no} />
                      <Fact label="Gate date" value={t.gate_date ? formatDate(t.gate_date) : '—'} />
                      {t.gate_tanker_no && String(t.gate_tanker_no).trim() !== String(t.tanker_no || '').trim() && (
                        <Fact label="Vehicle at gate" value={t.gate_tanker_no} />
                      )}
                      {Number(t.gate_qty) > 0 && <Fact label="Weighed" value={`${formatNum(t.gate_qty)} ${t.uom || 'MT'}`} />}
                    </div>
                  </div>
                )}

                {t.last_replacement && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <span className="font-semibold">Replaced:</span> {t.last_replacement}
                  </p>
                )}

                {/* Whether — and under which company — this tanker has actually
                    been billed. A tanker isn't anyone's company until an
                    invoice books it there, so this is the one place that
                    matters, not the raw company_id column. */}
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                    t.order_id ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-dashed bg-muted/30 text-muted-foreground'
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  {t.order_id ? (
                    <span>
                      Invoiced as <span className="font-semibold">{t.invoice_no}</span>
                      {t.invoice_date && <> on {formatDate(t.invoice_date)}</>}
                      {invoiceCompany && <> under <span className="font-semibold">{invoiceCompany.name}</span></>}
                    </span>
                  ) : (
                    <span>Not yet invoiced — not tied to any company until it is.</span>
                  )}
                </div>
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
        {/* min-w-0 down this whole chain, not just max-w-2xl on the dialog
            itself — a plain grid/flex item defaults to min-width:auto (its
            content's own preferred width), so the wide nowrap tanker table
            deep inside was pushing every ancestor open past the dialog's
            edge instead of triggering its own overflow-x-auto scrollbar. */}
        <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-4xl min-w-0 overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>Purchase {detailRow?.invoice_no}</span>
              {detailRow && (
                <Badge variant={detailRow.status === 'received' ? 'success' : 'warning'} className="text-[10px]">
                  {detailRow.status === 'received' ? 'Completed' : 'In process'}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailRow && <div className="grid min-w-0 gap-3">
            {/* The bargain this invoice was drawn against, and everything
                written against it. A note explaining why a bargain's quantity
                moved is the reason the invoice looks the way it does, and it
                used to be readable only from the bargain register. */}
            {!!bargainNotes?.length && (
              <div className="rounded-xl border">
                <div className="flex items-center gap-1.5 border-b bg-amber-50 px-3 py-2">
                  <ScrollText className="h-3.5 w-3.5 text-amber-700" />
                  <span className="text-xs font-semibold text-amber-900">
                    Bargain{bargainNotes.length > 1 ? 's' : ''} &amp; notes
                  </span>
                </div>
                <div className="divide-y">
                  {bargainNotes.map((b) => {
                    const adj = (b.adjustments || []) as Row[]
                    // The bargain's remarks accumulate each adjustment note as
                    // it is made, so showing both would print every note twice.
                    // The adjustments below are the dated, signed record, so the
                    // remarks line keeps only what is not already in one.
                    const noteTexts = new Set(adj.map((a) => String(a.note || '').trim()).filter(Boolean))
                    const extra = String(b.remarks || '')
                      .split('\n')
                      .map((l) => l.trim())
                      .filter((l) => l && !noteTexts.has(l))
                    return (
                      <div key={String(b.id)} className="px-3 py-2 text-[13px]">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="font-medium">{b.bargain_no || 'No bargain no'}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatDate(b.bargain_date)} · {formatNum(b.qty)} {b.uom || 'MT'} @ {formatINR(b.rate_per_uom)}
                          </span>
                          {b.rate_expiry_date && (
                            <span className="text-[11px] text-muted-foreground">
                              expires {formatDate(b.rate_expiry_date)}
                            </span>
                          )}
                        </div>
                        {extra.length > 0 && (
                          <div className="mt-1 text-[12px] text-muted-foreground">{extra.join(' · ')}</div>
                        )}
                        {adj.length > 0 && (
                          <div className="mt-1.5 space-y-1">
                            {adj.map((a, i) => (
                              <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                                <span className="shrink-0 tabular-nums text-muted-foreground">{formatDate(a.adj_date)}</span>
                                <span
                                  className={cn(
                                    'shrink-0 font-semibold tabular-nums',
                                    Number(a.delta) < 0 ? 'text-rose-700' : 'text-emerald-700'
                                  )}
                                >
                                  {Number(a.delta) > 0 ? '+' : ''}
                                  {formatNum(a.delta)} {b.uom || 'MT'}
                                </span>
                                <span className="min-w-0 text-muted-foreground">{a.note || 'No reason given'}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {!extra.length && !adj.length && (
                          <div className="mt-1 text-[12px] text-muted-foreground">Nothing written against this bargain.</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {(() => {
              // Who carried it and at what rate — nothing else. The amounts live
              // on each tanker's own Transport panel further down.
              const carriers = poCarriers(detailRow)
              if (!carriers.length) return null
              return (
                <div className="rounded-xl border">
                  <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                    <Truck className="h-3.5 w-3.5 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Transporter</span>
                  </div>
                  <div className="divide-y">
                    {carriers.map((cr, i) => (
                      <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                        {carriers.length > 1 && (
                          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{cr.tanker || '—'}</span>
                        )}
                        <span className="min-w-0 truncate">{cr.name || 'Not set'}</span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {cr.rate > 0 ? (
                            <>
                              {formatINR(cr.rate)}
                              <span className="text-[11px] text-muted-foreground">/{detailRow.uom || 'MT'}</span>
                            </>
                          ) : (
                            <span className="text-[12px] font-semibold text-rose-700">Rate not set</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
            <div className="grid grid-cols-3 gap-2">
              <InfoTile icon={Building2} label="Supplier" value={detailRow.supplier_name || '—'} />
              <InfoTile icon={CalendarDays} label="Purchase date" value={formatDate(detailRow.order_date)} />
              <InfoTile icon={Truck} label="Tankers" value={detailRow.tanker_nos || '—'} />
              <InfoTile icon={Boxes} label="Total quantity" value={`${formatNum(detailRow.ordered_qty)} ${detailRow.uom}`} />
              <InfoTile icon={IndianRupee} label="Invoice rate" value={`${formatINR(detailRow.invoice_rate)} / ${detailRow.uom}`} />
              {/* EX vs DLD decides who carries the shortage beyond tolerance —
                  the same flag the deductible column below is driven by, so
                  it's named here rather than left to be inferred from it. */}
              <InfoTile icon={FileText} label="Condition" value={invoiceCondition(detailRow)} />
            </div>
            <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-3 text-white shadow-sm">
              <span className="flex items-center gap-1.5 text-sm font-medium text-indigo-50">
                <IndianRupee className="h-4 w-4" /> Net amount
              </span>
              <span className="text-lg font-bold tabular-nums">{formatINR(detailRow.net_amount)}</span>
            </div>
            {detailRow.remarks && (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Remarks:</span> {detailRow.remarks}
              </p>
            )}
            {(() => {
              // Same "deductible" rule shown on the Pur BG tanker breakdown —
              // an EX bargain puts shortage beyond the allowed tolerance on
              // the supplier, so it's surfaced here too rather than only
              // being visible by going back to the bargain screen.
              const list = tankers.filter((t) => Number(t.order_id) === Number(detailRow.id))
              if (!list.length) return null
              // Whether ANY tanker on the invoice is EX decides whether the
              // Deductible columns appear at all; each row then uses its own
              // condition (see condIsEx) for its own figure.
              const isEx = list.some((t) => condIsEx(t))
              const invoiceRate = Number(detailRow.invoice_rate) || 0
              const rows = list.map((t) => tankerDeduct(t, detailRow))
              const anyPending = rows.some((r) => r.t.status !== 'empty')
              const tot = rows.reduce(
                (s, r) => ({
                  loaded: s.loaded + r.loaded,
                  rec: s.rec + (r.rec ?? 0),
                  shortage: s.shortage + (r.shortage ?? 0),
                  allowed: s.allowed + r.allowedAmt,
                  deductibleValue: s.deductibleValue + (r.deductibleValue ?? 0)
                }),
                { loaded: 0, rec: 0, shortage: 0, allowed: 0, deductibleValue: 0 }
              )
              const totDeductible = isEx && tot.shortage > tot.allowed ? tot.shortage - tot.allowed : null
              return (
                <div className="min-w-0">
                  <div className="min-w-0 overflow-hidden rounded-xl border">
                    <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                      <Truck className="h-4 w-4 text-slate-500" />
                      <span className="text-[13px] font-semibold text-slate-700">Tanker-wise shortage</span>
                    </div>
                    <div className="min-w-0 overflow-x-auto">
                      <table className="w-full whitespace-nowrap text-[13px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
                        <thead>
                          <tr className="border-b bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <th>Tanker</th>
                            <th>Loaded date</th>
                            <th>Received date</th>
                            <th className="text-right">Loaded</th>
                            <th className="text-right">Received</th>
                            <th className="text-right">Shortage</th>
                            <th className="text-right">Allowed MT</th>
                            <th>Cond.</th>
                            <th className="text-right">Bargain rate</th>
                            <th className="text-right">Invoice rate</th>
                            {isEx && <th className="text-right">Deductible</th>}
                            {isEx && <th className="text-right">Deductible ₹</th>}
                            {anyPending && <th>Stage</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr
                              key={r.t.id as number}
                              className={cn('border-b last:border-0', r.deductible != null ? 'bg-red-50/70' : 'hover:bg-muted/20')}
                            >
                              <td className="font-medium">
                                {r.t.tanker_no}
                                {r.t.transporter_name && (
                                  <div className="text-[11px] font-normal text-muted-foreground">{r.t.transporter_name}</div>
                                )}
                                {r.t.gate_entry_no && (
                                  <div className="text-[11px] font-normal text-muted-foreground">Gate {r.t.gate_entry_no}</div>
                                )}
                              </td>
                              <td className="text-slate-700">{r.t.loaded_date ? formatDate(r.t.loaded_date) : '—'}</td>
                              <td className="text-slate-700">{r.t.empty_date ? formatDate(r.t.empty_date) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{formatNum(r.loaded)}</td>
                              <td className="text-right tabular-nums text-foreground">{r.rec != null ? formatNum(r.rec) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{r.shortage != null ? formatNum(r.shortage) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{formatNum(r.allowedAmt)}</td>
                              <td>
                                <span
                                  className={cn(
                                    'rounded px-2 py-0.5 text-[11px] font-semibold',
                                    condIsEx(r.t) ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'
                                  )}
                                  title={
                                    String(r.t.condition ?? '').trim()
                                      ? 'Set on this tanker when it was sent to the supplier'
                                      : `From the bargain (${r.t.bargain_no || 'its bargain'}) — not overridden on this tanker`
                                  }
                                >
                                  {condIsEx(r.t) ? 'EX' : 'DLD'}
                                </span>
                              </td>
                              <td className="text-right tabular-nums text-foreground">
                                {formatINR(r.bargainRate)}
                                {r.extraQty > 0 && (
                                  <div className="text-[11px] font-normal text-muted-foreground">
                                    {formatNum(r.primaryQty)} @ {formatINR(r.primaryRate)}
                                    {r.t.bargain_no ? ` (${r.t.bargain_no})` : ''} + {formatNum(r.extraQty)} @ {formatINR(r.extraRate)}
                                    {r.t.extra_bargain_no ? ` (${r.t.extra_bargain_no})` : ''}
                                  </div>
                                )}
                              </td>
                              <td className="text-right tabular-nums text-foreground">{formatINR(invoiceRate)}</td>
                              {isEx && (
                                <td className="text-right font-semibold tabular-nums text-red-600">
                                  {r.deductible != null ? formatNum(r.deductible) : ''}
                                </td>
                              )}
                              {isEx && (
                                <td className="text-right font-semibold tabular-nums text-red-600">
                                  {r.deductibleValue != null ? formatINR(r.deductibleValue) : ''}
                                </td>
                              )}
                              {anyPending && (
                                <td><StatusBadge status={String(r.t.status || '')} /></td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                        {rows.length > 1 && (
                          <tfoot>
                            <tr className="border-t-2 border-amber-400 bg-amber-50 font-semibold text-amber-900">
                              <td colSpan={3}>Total</td>
                              <td className="text-right tabular-nums">{formatNum(tot.loaded)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.rec)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.shortage)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.allowed)}</td>
                              <td />
                              <td />
                              <td />
                              {isEx && (
                                <td className="text-right tabular-nums text-red-600">
                                  {totDeductible != null ? formatNum(totDeductible) : ''}
                                </td>
                              )}
                              {isEx && (
                                <td className="text-right tabular-nums text-red-600">
                                  {totDeductible != null ? formatINR(tot.deductibleValue) : ''}
                                </td>
                              )}
                              {anyPending && <td />}
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                  {isEx && totDeductible != null && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <span className="font-semibold">
                          {formatNum(totDeductible)} {detailRow.uom || 'MT'} deductible — {formatINR(tot.deductibleValue)}
                        </span>{' '}
                        — shortage beyond the allowed tolerance, valued at each tanker&apos;s own bargain rate; deduct
                        from what&apos;s owed to the supplier.
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-muted-foreground" /> Tankers by product</DialogTitle>
          </DialogHeader>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Loaded from</Label>
              <DatePicker value={repFrom} onChange={setRepFrom} max={repTo || undefined} className="w-40" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">To</Label>
              <DatePicker value={repTo} onChange={setRepTo} min={repFrom || undefined} className="w-40" />
            </div>
            {(repFrom || repTo) && (
              <Button variant="ghost" size="sm" onClick={() => { setRepFrom(''); setRepTo('') }}>Clear</Button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Tankers</TableHead>
                  <TableHead className="text-right">Loaded qty</TableHead>
                  <TableHead className="text-right">Received qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tankerReport.rows.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No tankers in this range.</TableCell></TableRow>
                ) : (
                  <>
                    {tankerReport.rows.map((r) => (
                      <TableRow key={r.oil}>
                        <TableCell className="font-medium">{r.oil}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(r.loaded)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(r.received)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                      <TableCell className="font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{tankerReport.grand.count}</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tankerReport.grand.loaded)}</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tankerReport.grand.received)}</TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Counts every tanker (any stage) for the active company; filter by loaded date. Loaded = dispatched quantity, Received = weighed-in at gate.</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
