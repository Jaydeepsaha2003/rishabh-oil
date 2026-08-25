import { Fragment, useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Ban, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Tags, Trash2, Truck, Upload } from 'lucide-react'
import { moduleScope } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { loadUser } from '@/lib/session'

// The unloading desk: a user granted the 'unload' scope on Sales reaches this
// page to record one thing — what a delivery actually weighed in at. The rows
// and columns it never gets are filtered in the main process (see
// listSalesForUnloadDesk), so this flag shapes the page to match what the data
// already is rather than being the restriction itself.
const UNLOAD_DESK = (): boolean => moduleScope(loadUser(), 'sales') === 'unload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnFilter } from '@/components/ui/column-filter'
import { RowActions } from '@/components/ui/row-actions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/PageHeader'
import { FyPicker } from '@/components/FyPicker'
import { UomSelect } from '@/components/UomSelect'
import { DatePicker } from '@/components/ui/date-picker'
import { convertQty, errText, formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { downloadSkuRateExcel, parseSkuRateExcel, caseMT } from '@/lib/skuRateExcel'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { isManufacturingParty } from '@/lib/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A rate contract past its expiry date. Still a real open bargain — it is
// offered and labelled rather than hidden.
const rateExpired = (b: Row): boolean => !!b.rate_expiry_date && String(b.rate_expiry_date) < todayISO()

// Dispatch lifecycle: a sale is a pending commitment until the tanker is
// loaded, then tracked in transit and finally unloaded at the customer. Any
// dispatched stage means the finished stock has left the factory.
const DISPATCH_STAGES = [
  { value: 'pending', label: 'Pending', badge: 'warning' as const },
  { value: 'loaded', label: 'Loaded', badge: 'default' as const },
  { value: 'transit', label: 'In transit', badge: 'default' as const },
  { value: 'unloaded', label: 'Unloaded', badge: 'success' as const }
]
function stageInfo(row: Row): (typeof DISPATCH_STAGES)[number] {
  const s = String(row.dispatch_stage || (row.status === 'done' ? 'unloaded' : 'pending'))
  return DISPATCH_STAGES.find((x) => x.value === s) || DISPATCH_STAGES[0]
}

// Sale-bargain type classification (mirrors the purchase-bargain type tabs).
// The five below are the codes already stored on existing bargains, so they stay
// as the base list whatever the master says; the Category master decides which
// of them are OFFERED, and can add its own on top.
const SALE_CATS_BASE: { v: string; label: string }[] = [
  { v: 'FINISHED_OIL', label: 'Finished Oil' },
  { v: 'FATTY', label: 'Fatty' },
  { v: 'SCRAP', label: 'Scrap' },
  { v: 'SPENT_EARTH', label: 'Spent Earth' },
  { v: 'MISC', label: 'Misc' }
]
// A category's master NAME does not always spell its stored code: MISC is
// filed as MISCELLANEOUS. Normalising both ends lets the master switch the
// right option off without renaming anything.
const catKey = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/^MISCELLANEOUS$/, 'MISC')
const saleCatLabel = (v: unknown): string => {
  const hit = SALE_CATS_BASE.find((c) => c.v === String(v))
  if (hit) return hit.label
  const raw = String(v ?? '').trim()
  if (!raw) return 'Finished Oil'
  // A master-added category: title-case its own name back out of the code.
  return raw
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

// The sale categories to OFFER: the master's active sales-side rows, plus
// whatever is already stored on a record so an old bargain never becomes
// unreadable. `rows` is the Category master.
function saleCatsFrom(rows: Row[], stored: unknown[]): { v: string; label: string }[] {
  const live = new Set<string>()
  let sawMaster = false
  for (const r of rows) {
    const side = String(r.applies_to || 'both').toLowerCase()
    if (side !== 'both' && side !== 'sales') continue
    sawMaster = true
    if (Number(r.active) === 0) continue
    live.add(catKey(r.name))
  }
  // No master rows for this side at all (first run, or it failed to load) —
  // fall back to the built-in list rather than emptying the dropdown.
  const out = SALE_CATS_BASE.filter((c) => !sawMaster || live.has(c.v))
  const have = new Set(out.map((c) => c.v))
  for (const extra of [...live, ...stored.map((x) => catKey(x))]) {
    if (extra && !have.has(extra)) {
      have.add(extra)
      out.push({ v: extra, label: saleCatLabel(extra) })
    }
  }
  return out
}

// First day of the current month, YYYY-MM-DD.
function monthStartISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// SUM() over many dispatch/adjustment rows can carry floating-point residue
// past a real zero (e.g. 0.00002) — round every register figure to 3 decimals
// so `inRegister`'s zero-balance check actually lands on exact zero, same fix
// already applied to adjustSalesBargainQty's balance_qty rounding.
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

// Period register figures for a bargain, relative to [from,to].
// opening (b/f) + addition (created in period) + adjusted (manual add/remove
// in period) − dispatch (in period) = closing. `futureAdjusted` is any
// adjustment dated after `to` — excluded from the period math (it hasn't
// happened yet as of `to`) but surfaced separately so it isn't just dropped.
function bargainRegister(r: Row, from: string, to: string): { opening: number; addition: number; adjusted: number; dispatch: number; ret: number; closing: number; futureAdjusted: number } {
  const qty = Number(r.qty) || 0
  const before = Number(r.disp_before) || 0
  const inP = Number(r.disp_period) || 0
  const adjBefore = Number(r.adj_before) || 0
  const adjIn = Number(r.adj_in) || 0
  const adjAfter = Number(r.adj_after) || 0
  // Goods that came back on a customer credit note. Dated by the note, so a
  // return sits in the month it was raised — and the opening balance carries
  // whatever came back before the period, the same way dispatches do.
  const retBefore = Number(r.ret_before) || 0
  const retIn = Number(r.ret_in) || 0
  const bdate = String(r.bargain_date || '').slice(0, 10)
  const createdInRange = bdate >= from && bdate <= to
  const createdBefore = bdate < from
  // Original booked qty minus every dated top-up (top-ups get their own
  // Adjusted figure in the month they were made, not folded into Opening or
  // blended into Addition).
  const baseQty = qty - adjBefore - adjIn - adjAfter
  const opening = round3(createdBefore ? Math.max(0, baseQty + adjBefore - before + retBefore) : 0)
  const addition = round3(createdInRange ? baseQty : 0)
  const adjusted = round3(adjIn)
  const dispatch = round3(inP)
  const ret = round3(retIn)
  const closing = round3(opening + addition + adjusted - dispatch + ret)
  return { opening, addition, adjusted, dispatch, ret, closing, futureAdjusted: round3(adjAfter) }
}

// Whether a bargain belongs in the register for [from,to]: created on/before the
// period, and either still open at period end OR finished within the period.
// A bargain shows in the register when it still has an open balance. Fully
// settled (0-balance) bargains are hidden unless `showZero` is on, in which case
// they show only if they belong to the selected range (created / finished /
// had activity in it).
function inRegister(r: Row, from: string, to: string, showZero = false): boolean {
  const bdate = String(r.bargain_date || '').slice(0, 10)
  if (bdate > to) return false
  const reg = bargainRegister(r, from, to)
  if (reg.closing > 1e-6) return true
  if (!showZero) return false
  const fin = String(r.last_dispatch_date || '').slice(0, 10)
  const finishedInRange = !!fin && fin >= from && fin <= to
  const createdInRange = bdate >= from && bdate <= to
  // Each figure checked on its own, not summed — an addition and a same-size
  // removal in the same period (e.g. a bargain booked then cancelled) net to
  // zero, but it is still real activity that happened in this period. Opening
  // is deliberately excluded: it is the balance carried IN from before the
  // period, not something that happened during it.
  const activityInRange =
    Math.abs(reg.addition) > 1e-6 || Math.abs(reg.adjusted) > 1e-6 || Math.abs(reg.dispatch) > 1e-6
  return finishedInRange || createdInRange || activityInRange
}

// ---------------- Sales tab ----------------

function SalesTab({
  focusId,
  onFocusHandled,
  onRegister,
  onBack,
  backLabel
}: {
  focusId?: number | null
  onFocusHandled?: () => void
  onRegister?: (a: { open: () => void; canAdd: boolean; formOpen: boolean }) => void
  onBack?: () => void
  backLabel?: string
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [packagings, setPackagings] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [stock, setStock] = useState<Record<number, Row>>({})
  const [loading, setLoading] = useState(true)

  // The invoice form is a full-screen page (room for many line items + freight/GST).
  const [formPage, setFormPage] = useState(false)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [header, setHeader] = useState<Row>({})
  const [items, setItems] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  // The desk opens with no lower bound: a load that went out last month and is
  // still not unloaded has to be on the list, not behind a date change.
  const [dateFrom, setDateFrom] = useState(UNLOAD_DESK() ? '' : monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  // Empty = every product type.
  const [productType, setProductType] = useState<string[]>([])
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'sales')) { setDateFrom(globalRange.from); setDateTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true)
    // The desk needs the deliveries and nothing else. Sales bargains carry
    // contract rates and the masters are of no use without the invoice form, so
    // they are not even fetched — the thin row set is the whole point.
    if (UNLOAD_DESK()) {
      setRows(await window.api.sales.list())
      setLoading(false)
      return
    }
    const [s, pr, sb, st, cu, pk, tr] = await Promise.all([
      window.api.sales.list(),
      window.api.data.list('products'),
      window.api.salesBargains.list(),
      window.api.stock.list(),
      window.api.data.list('customers'),
      window.api.data.list('packagings'),
      window.api.data.list('transporters')
    ])
    setRows(s)
    setProducts(pr.filter((x) => x.active && x.category === 'finished'))
    setBargains(sb)
    setCustomers(cu.filter((x) => x.active))
    setPackagings(pk.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    const sm: Record<number, Row> = {}
    for (const l of st) sm[l.id as number] = l
    setStock(sm)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Trading customers are left out — a pass-through deal is booked on the
  // Trading screen, not here. The invoice's own customer always stays listed,
  // so an invoice already raised on one still opens and edits normally.
  const invoiceCustomers = useMemo(
    () =>
      customers.filter(
        (c) => isManufacturingParty(c) || String(c.id) === String(header.customer_id || '')
      ),
    [customers, header.customer_id]
  )

  // Sales grouped into invoices (line items sharing an invoice_group).
  const unloadOnly = UNLOAD_DESK()
  // Columns rendered + the Actions column, for the empty/loading colSpan.
  const colCount = unloadOnly ? 4 : 8
  const invoices = useMemo(() => {
    const m = new Map<string, Row[]>()
    // The unloading desk is FOR-only, and only what is still out. The main
    // process already hands back nothing else (listSalesForUnloadDesk), but the
    // page decides its own layout from the cached grant while the data is
    // scoped by the signed-in session — so if those two ever disagree (a
    // session not yet registered, say) this makes sure an Ex sale or an
    // already-unloaded one still cannot appear on the desk.
    const deskRows = !unloadOnly
      ? rows
      : rows.filter(
          (r) =>
            String(r.freight_term || 'FREIGHT_ON_GOODS') === 'DLD' &&
            String(r.dispatch_stage || (r.status === 'done' ? 'unloaded' : 'pending')) !== 'unloaded' &&
            !r.rejected_at &&
            Number(r.is_trading) !== 1
        )
    for (const r of deskRows) {
      const g = String(r.invoice_group || `LEGACY-${r.id}`)
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(r)
    }
    return Array.from(m.entries())
      .map(([group, lines]) => {
        const first = lines[0]
        const amount = lines.reduce((s, r) => s + (Number(r.amount) || 0), 0)
        // Freight moves the invoice total: recovered adds it, deducted takes it
        // off. Same rule the sale voucher's customer leg is posted on.
        const freight = lines.reduce((s, r) => s + (Number(r.transport_amount) || 0), 0)
        const net =
          lines.reduce((s, r) => s + (Number(r.amount) || 0) + (Number(r.gst_amount) || 0) + (Number(r.round_off) || 0), 0) -
          (Number(first.deduct_freight) === 1 ? freight : 0)
        const qty = lines.reduce((s, r) => s + (Number(r.qty) || 0), 0)
        return { group, lines, first, amount, net, qty }
      })
      .sort((a, b) => Number(b.first.id) - Number(a.first.id))
  }, [rows, unloadOnly])

  // Invoice list filtered by the sale date range and a free-text search over
  // invoice no, customer and product names.
  // Product types present across the dispatched lines, for the filter beside the
  // date range. An invoice matches when any of its lines is of that type.
  const productTypes = useMemo(
    () =>
      Array.from(
        new Set(
          invoices.flatMap((inv) => inv.lines.map((r) => String(r.product_category || '')).filter(Boolean))
        )
      ).sort(),
    [invoices]
  )
  // Rejected invoices (the customer refused the consignment) stay right in
  // the main list — they're still sales, just flagged with a badge. Narrowing
  // by dispatch state is done from the "Dispatch" column's own header filter,
  // which lists exactly the states the column actually shows (including
  // "Done" and "Cancelled") — so there's no separate Status dropdown.
  // Excel-style per-column filters on the invoice register. Empty = that
  // column isn't filtering. Keyed by column so one state object covers them all.
  const [invCols, setInvCols] = useState<Record<string, string[]>>({})

  // Everything the date/type/status/search rules allow — the pool the column
  // filters then narrow, and the pool their dropdowns are built from.
  const invBaseRows = useMemo(() => {
    const f = dateFrom || '0000-01-01'
    const t = dateTo || '9999-12-31'
    const q = search.trim().toLowerCase()
    return invoices.filter((inv) => {
      // Trading is a pass-through deal booked and tracked on its own page — it
      // never touches this customer's regular sales relationship, so it does
      // not belong in this register. Same rule the Purchases register uses.
      if (Number(inv.first.is_trading) === 1) return false
      const d = String(inv.first.sale_date || '').slice(0, 10)
      if (d < f || d > t) return false
      if (productType.length && !inv.lines.some((r) => productType.includes(String(r.product_category || '')))) {
        return false
      }
      if (!q) return true
      const hay = [
        inv.first.invoice_no,
        inv.first.customer,
        ...inv.lines.map((r) => r.product_name)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [invoices, dateFrom, dateTo, search, productType])

  // The invoice-register columns that carry a header filter, and how each one
  // reads its value off a grouped invoice. Money/qty format the same way the
  // cell does, so the dropdown lists exactly what's on screen.

  const INV_COLUMNS: { key: string; label: string; of: (inv: Row) => string }[] = useMemo(() => {
    const all: { key: string; label: string; of: (inv: Row) => string }[] = [
      { key: 'invoice_no', label: 'Date / Invoice', of: (inv) => String(inv.first.invoice_no || '') },
      { key: 'customer', label: 'Customer', of: (inv) => String(inv.first.customer || '') },
      {
        key: 'items',
        label: 'Items',
        of: (inv) =>
          Array.from(new Set((inv.lines as Row[]).map((r) => String(r.product_name || '')).filter(Boolean)))
            .sort()
            .join(', ')
      },
      { key: 'qty', label: 'Qty', of: (inv) => formatNum(inv.qty) },
      { key: 'net', label: 'Invoice total', of: (inv) => formatINR(inv.net) },
      {
        // Filters on the TERM (the dropdown then lists exactly FOR and Ex)
        // while the cell also shows what the freight came to, so the column
        // answers both "which ones do we carry?" and "how much?".
        key: 'freight',
        label: 'Freight',
        of: (inv) => (String(inv.first.freight_term || 'FREIGHT_ON_GOODS') === 'DLD' ? 'FOR' : 'Ex')
      },
      {
        key: 'dispatch',
        label: 'Dispatch',
        // Must match exactly what the Dispatch cell RENDERS, or the dropdown
        // offers values the column never shows. An ex-term invoice (customer
        // lifts, so there is no dispatch to track) displays "Done" rather than
        // a stage — filtering on its underlying stage instead was hiding rows
        // that visibly said Done.
        of: (inv) => {
          if (inv.first.rejected_at) return 'Cancelled'
          if (String(inv.first.freight_term || 'FREIGHT_ON_GOODS') !== 'DLD') return 'Done'
          return String(stageInfo(inv.first).label || '')
        }
      }
    ]
    // The desk gets Date/Invoice, Customer, Item and Dispatch status — nothing
    // else. Qty, invoice value and the freight term are not its business.
    return all.filter((c) => !unloadOnly || ['invoice_no', 'customer', 'items', 'dispatch'].includes(c.key))
  }, [unloadOnly])

  // Rows that pass every filter EXCEPT this column's own — so each dropdown
  // lists the values still reachable given the other filters, the way Excel
  // narrows its lists, instead of always offering the whole table.
  function invColOptions(key: string): { value: string; label: string }[] {
    const col = INV_COLUMNS.find((c) => c.key === key)
    if (!col) return []
    const seen = new Set<string>()
    for (const inv of invBaseRows) {
      let ok = true
      for (const other of INV_COLUMNS) {
        if (other.key === key) continue
        const sel = invCols[other.key]
        if (sel?.length && !sel.includes(other.of(inv))) { ok = false; break }
      }
      if (ok) seen.add(col.of(inv))
    }
    return Array.from(seen)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((v) => ({ value: v, label: v || '(blank)' }))
  }

  const filteredInvoices = useMemo(
    () =>
      invBaseRows.filter((inv) =>
        INV_COLUMNS.every((c) => {
          const sel = invCols[c.key]
          return !sel?.length || sel.includes(c.of(inv))
        })
      ),
    [invBaseRows, invCols, INV_COLUMNS]
  )

  function blankHeader(): Row {
    return {
      sale_date: todayISO(),
      invoice_no: '',
      customer: '',
      customer_id: '',
      freight_term: 'FREIGHT_ON_GOODS',
      transporter_id: '',
      transport_rate: '',
      dispatch_stage: 'pending',
      loaded_date: '',
      transit_date: '',
      unloaded_date: '',
      round_off: '',
      round_off_manual: false,
      tds_pct: ''
    }
  }
  function blankItem(): Row {
    return { product_id: '', sales_bargain_id: '', sale_type: 'LOOSE', packaging_id: '', boxes: '', pouches: '', qty: '', rate: '', gst_pct: '', gst_type: 'CGST_SGST' }
  }

  function openAdd(): void {
    setEditingGroup(null)
    setHeader(blankHeader())
    setItems([blankItem()])
    setFormPage(true)
  }
  useEffect(() => {
    onRegister?.({ open: openAdd, canAdd: products.length > 0 && !unloadOnly, formOpen: formPage })
  }, [products.length, formPage]) // eslint-disable-line react-hooks/exhaustive-deps

  function openEditInvoice(inv: { group: string; lines: Row[]; first: Row }): void {
    setEditingGroup(inv.group)
    const f = inv.first
    setHeader({
      sale_date: f.sale_date ?? todayISO(),
      invoice_no: f.invoice_no ?? '',
      customer: f.customer ?? '',
      customer_id: f.customer_id ? String(f.customer_id) : '',
      freight_term: f.freight_term ?? 'FREIGHT_ON_GOODS',
      transporter_id: f.transporter_id ? String(f.transporter_id) : '',
      transport_rate: f.transport_rate ?? '',
      deduct_freight: !!f.deduct_freight,
      is_trading: !!f.is_trading,
      dispatch_stage: f.dispatch_stage ?? (f.status === 'done' ? 'unloaded' : 'pending'),
      loaded_date: f.loaded_date ?? '',
      transit_date: f.transit_date ?? '',
      unloaded_date: f.unloaded_date ?? '',
      // Round off lives on the first line of the group; sum is safe either way.
      round_off: inv.lines.reduce((s, r) => s + (Number(r.round_off) || 0), 0) || '',
      // Whether it was typed by hand is RECORDED on the invoice, not guessed
      // from "the value isn't zero" — that old guess froze a figure correct
      // for the OLD totals the moment anything else was edited, so the total
      // stopped landing on a whole rupee. Auto now keeps itself right, and a
      // real manual override is both respected and visibly flagged.
      round_off_manual: !!inv.lines.some((r) => Number(r.round_off_manual) === 1),
      tds_pct: f.tds_pct ?? ''
    })
    setItems(inv.lines.map((r) => ({
      product_id: String(r.product_id ?? ''),
      sales_bargain_id: r.sales_bargain_id ? String(r.sales_bargain_id) : '',
      sale_type: r.sale_type ?? 'LOOSE',
      packaging_id: r.packaging_id ? String(r.packaging_id) : '',
      boxes: r.boxes ?? '',
      pouches: r.pouches ?? '',
      qty: r.qty ?? '',
      rate: r.rate ?? '',
      // The per-case rate the line was billed on, so reopening an invoice shows
      // and re-saves the same figure rather than deriving one back through the
      // MT conversion.
      rate_case: r.rate_per_case == null ? '' : String(r.rate_per_case),
      gst_pct: r.gst_pct ?? '',
      gst_type: r.gst_type ?? 'CGST_SGST'
    })))
    setFormPage(true)
  }

  // Deep-link from Ledgers: open the invoice containing the given sale line.
  useEffect(() => {
    if (!focusId) return
    const inv = invoices.find((v) => v.lines.some((r) => Number(r.id) === Number(focusId)))
    if (!inv) return
    openEditInvoice(inv)
    onFocusHandled?.()
  }, [focusId, invoices]) // eslint-disable-line react-hooks/exhaustive-deps

  function setHeaderField(key: string, value: unknown): void {
    setHeader((p) => ({ ...p, [key]: value }))
  }
  function setItem(idx: number, patch: Row): void {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }
  function addItem(): void {
    setItems((prev) => [...prev, blankItem()])
  }
  function removeItem(idx: number): void {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  // Customer bargain matching (by master id, else name).
  const custId = String(header.customer_id || '')
  const custName = String(header.customer || '').trim().toLowerCase()
  const matchesCustomer = (b: Row): boolean => {
    if (!custId && !custName) return true
    if (custId && b.customer_id != null && String(b.customer_id) !== '') return String(b.customer_id) === custId
    return String(b.customer || '').trim().toLowerCase() === custName
  }
  // As-of date for rate validity: the invoice's own date. A bargain that
  // lapsed on 27-07 was still live for an invoice dated 16-07, so a back-dated
  // entry must not be told its rate has expired.
  const asOfDate = String(header.sale_date || '').slice(0, 10) || todayISO()
  const notExpired = (b: Row): boolean => !b.rate_expiry_date || String(b.rate_expiry_date) >= asOfDate
  // A contract whose rate date has passed is still a real open bargain — the
  // office decides whether to sell against it. Hiding it just left the picker
  // saying "no bargain" with no reason, so it is offered and labelled instead,
  // with the live ones first.
  const bargainsFor = (item: Row): Row[] =>
    bargains
      .filter(
        (b) =>
          String(b.id) === String(item.sales_bargain_id) ||
          (String(b.product_id) === String(item.product_id) && matchesCustomer(b) && Number(b.balance_qty) > 0)
      )
      .sort((a, b) => Number(notExpired(b)) - Number(notExpired(a)))

  // How much of the sale unit one case holds — the bridge between a case
  // rate and the per-unit rate the invoice actually charges on.
  // NOT rounded. This factor divides the per-case rate to get the per-MT rate
  // that is actually stored, so any rounding here lands straight on the money.
  // A 13.395 KG case is 0.013395 MT — six decimals — and rounding to five gave
  // 0.0134, a 0.037% error that understated a ₹20 lakh line by ₹760. A 15 KG
  // case (0.015 MT) survived it, which is why only some lines looked wrong.
  function mtPerCase(c: { selPack: Row | undefined; packBaseUom: string; saleUom: string }): number {
    if (!c.selPack) return 0
    const perCase = (Number(c.selPack.pouches_per_box) || 0) * (Number(c.selPack.base_per_pouch) || 0)
    return convertQty(perCase, c.packBaseUom, c.saleUom)
  }

  // Per-item computed quantity (packaging → sale unit), amount and GST.
  function calc(item: Row): {
    isPacked: boolean; selPack: Row | undefined; saleUom: string; packBaseUom: string
    packBaseQty: number; effQty: number; amount: number; gstPct: number; gstAmt: number; net: number
  } {
    const isPacked = item.sale_type === 'PACKED'
    const selPack = isPacked && item.packaging_id ? packagings.find((p) => String(p.id) === String(item.packaging_id)) : undefined
    const b = bargains.find((x) => String(x.id) === String(item.sales_bargain_id))
    const saleUom = b?.uom || 'MT'
    const packBaseUom = selPack ? String(selPack.base_uom || 'KG') : saleUom
    const packBaseQty = selPack
      ? (Number(item.boxes) || 0) * (Number(selPack.pouches_per_box) || 0) * (Number(selPack.base_per_pouch) || 0) +
        (Number(item.pouches) || 0) * (Number(selPack.base_per_pouch) || 0)
      : 0
    const packQty = selPack ? convertQty(packBaseQty, packBaseUom, saleUom) : 0
    const effQty = isPacked ? packQty : Number(item.qty) || 0
    // Packed: cases x rate-per-case, the figure the deal was struck on. Loose:
    // rate x quantity. Converting a case weight to MT is not always exact, so
    // the money must never be taken through that conversion.
    const perCaseBase = selPack
      ? (Number(selPack.pouches_per_box) || 0) * (Number(selPack.base_per_pouch) || 0)
      : 0
    const casesEq = selPack && perCaseBase > 0 ? packBaseQty / perCaseBase : 0
    // The per-case rate is STATED — off the bargain's rate card, or typed. It is
    // never worked back out of the per-MT rate, because that derivation moves
    // with the conversion factor. A line with none (saved before the per-case
    // rate was stored) keeps its original rate x quantity value, exactly as the
    // main process values it.
    const statedCase = Number(item.rate_case)
    const perCaseRate = isPacked && Number.isFinite(statedCase) && statedCase > 0 ? statedCase : 0
    const amount =
      isPacked && perCaseRate > 0 && casesEq > 0
        ? Math.round(casesEq * perCaseRate * 100) / 100
        : effQty * (Number(item.rate) || 0)
    const gstPct = Number(item.gst_pct) || 0
    const gstAmt = Math.round(amount * (gstPct / 100) * 100) / 100
    return { isPacked, selPack, saleUom, packBaseUom, packBaseQty, effQty, amount, gstPct, gstAmt, net: amount + gstAmt }
  }

  const isDld = header.freight_term === 'DLD'
  const totals = items.reduce(
    (acc, it) => {
      const c = calc(it)
      acc.amount += c.amount
      acc.gst += c.gstAmt
      acc.qty += c.effQty
      return acc
    },
    { amount: 0, gst: 0, qty: 0 }
  )

  // Auto round-off to the nearest rupee, same idiom as the purchase form. The
  // base (taxable + GST) does not depend on the round off, so this cannot
  // loop. A manual edit overrides it; clearing the field brings auto back.
  // Rounded to PAISA first. GST can carry a third decimal (5% of an odd
  // taxable value lands on .xx5), and deriving the round off from that
  // un-rounded figure leaves a half-paisa tail — which then surfaced as an
  // invoice total one paisa off a whole rupee.
  const invoiceRawTotal = Math.round((totals.amount + totals.gst) * 100) / 100
  useEffect(() => {
    if (header.round_off_manual) return
    if (!Number.isFinite(invoiceRawTotal) || invoiceRawTotal <= 0) return
    const auto = Math.round(invoiceRawTotal) - invoiceRawTotal
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(header.round_off ?? '') !== val) setHeaderField('round_off', val)
  }, [invoiceRawTotal, header.round_off_manual, header.round_off])

  // TDS preview, on the customer master's own terms — the same slab the main
  // process applies on save. Below the FY threshold nothing is withheld when
  // the master says "no TDS below the slab"; above it the invoice's rate runs.
  // Freight on this invoice, on the same basis the main process uses: the rate
  // per case for a packed line, per MT for a loose one.
  const freightPreview = !isDld
    ? 0
    : Math.round(
        items.reduce((t, it) => {
          const c = calc(it)
          const rate = Number(header.transport_rate) || 0
          if (rate <= 0) return t
          const units = c.isPacked ? Number(it.boxes) || 0 : c.effQty
          return t + units * rate
        }, 0) * 100
      ) / 100
  // Only the deduction moves the invoice: it comes off what the customer owes,
  // because they settle the transporter directly. Left unticked the freight is
  // ours to carry and the customer's bill is the goods alone, exactly as before.
  const freightOnInvoice =
    freightPreview <= 0 || !header.transporter_id || !header.deduct_freight ? 0 : -freightPreview
  const invoiceTotal =
    Math.round((totals.amount + totals.gst + (Number(header.round_off) || 0) + freightOnInvoice) * 100) / 100
  const tds = useMemo(() => {
    const pct = Number(header.tds_pct) || 0
    const cust = customers.find((c) => String(c.id) === String(header.customer_id || ''))
    if (!cust || pct <= 0 || invoiceTotal <= 0) return { amount: 0, threshold: 0, belowSlab: false }
    const threshold = Number(cust.tds_threshold) || 0
    const basePct = cust.tds_above_only ? 0 : pct
    if (threshold <= 0) return { amount: (invoiceTotal * pct) / 100, threshold: 0, belowSlab: false }
    // What this customer has already been billed this financial year, taken
    // from the invoices on screen (this invoice itself excluded when editing).
    const d = new Date(String(header.sale_date || todayISO()))
    const startY = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
    const fyStart = `${startY}-04-01`
    const upto = String(header.sale_date || todayISO()).slice(0, 10)
    const prior = rows
      .filter(
        (r) =>
          String(r.customer_id ?? '') === String(header.customer_id) &&
          String(r.sale_date ?? '').slice(0, 10) >= fyStart &&
          String(r.sale_date ?? '').slice(0, 10) <= upto &&
          (!editingGroup || String(r.invoice_group ?? '') !== String(editingGroup))
      )
      .reduce((s, r) => s + (Number(r.amount) || 0), 0)
    const below = Math.max(0, Math.min(threshold - prior, invoiceTotal))
    const above = invoiceTotal - below
    return {
      amount: (below * basePct) / 100 + (above * pct) / 100,
      threshold,
      belowSlab: !!cust.tds_above_only && above <= 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.tds_pct, header.customer_id, header.sale_date, invoiceTotal, customers, rows, editingGroup])

  // Rate cards for the bargains used on this invoice, keyed by bargain id then
  // packaging id. Loaded when a line names a bargain; the rate it yields is
  // offered, never forced — the line stays editable.
  const [cards, setCards] = useState<Record<string, Record<string, Row>>>({})
  const loadCard = useCallback(async (bargainId: string): Promise<Record<string, Row>> => {
    if (cards[bargainId]) return cards[bargainId]
    try {
      const rows = await window.api.skuRates.list(Number(bargainId))
      const byPack: Record<string, Row> = {}
      for (const r of rows) {
        if (r.rate_per_case != null || r.rate_per_mt != null) byPack[String(r.packaging_id)] = r
      }
      setCards((p) => ({ ...p, [bargainId]: byPack }))
      return byPack
    } catch {
      return {}
    }
  }, [cards])

  // The card is fetched when a bargain is PICKED — which meant opening an
  // existing invoice never fetched it, and the caption then told the user the
  // bargain had no rate card when it plainly did. Load whatever the lines on
  // the form actually reference, however they got there.
  const itemBargainKey = items
    .map((it) => String(it.sales_bargain_id || ''))
    .filter(Boolean)
    .sort()
    .join(',')
  useEffect(() => {
    for (const id of new Set(itemBargainKey.split(',').filter(Boolean))) {
      if (!cards[id]) void loadCard(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemBargainKey])

  // A card row turned into the rate THIS line is priced in. The line always
  // charges rate x quantity in the bargain's unit (MT/KG/L) — even a packed
  // line, whose cases are converted to that unit first.
  //
  // Packed deals are negotiated per case, so the per-case figure is the one to
  // trust: it is derived through the exact same MT-per-case conversion the
  // Rate/Case box itself uses, so it can never disagree with what a person
  // reads off the card. The card's independently-typed per-MT column is only a
  // convenience for whoever filled the sheet — a typo there (dividing by the
  // wrong case size, a slipped decimal) would otherwise bill silently wrong,
  // with nothing on this screen able to catch it.
  function cardRateInUnit(hit: Row, saleUom: string, mtPerCaseValue: number): number | null {
    if (hit.rate_per_case != null && mtPerCaseValue > 0) {
      // Six decimals for the same reason the Rate/Case box uses them: the
      // amount is qty x this rate, so paise-level rounding here cannot
      // reproduce cases x rate-per-case on a fractional case weight.
      return Math.round((Number(hit.rate_per_case) / mtPerCaseValue) * 1e6) / 1e6
    }
    const perMt = hit.rate_per_mt == null ? null : Number(hit.rate_per_mt)
    if (perMt == null) return null
    const u = String(saleUom || 'MT').toUpperCase()
    // KG and L are thousandths of the per-MT rate (1 L counted as 1 KG here).
    return u === 'KG' || u === 'L' ? Math.round((perMt / 1000) * 100) / 100 : perMt
  }

  // The card rate for a line, in the unit the line is priced in.
  function cardRateFor(it: Row): number | null {
    const card = cards[String(it.sales_bargain_id || '')]
    const hit = card?.[String(it.packaging_id || '')]
    if (!hit) return null
    const c = calc(it)
    return cardRateInUnit(hit, c.saleUom, mtPerCase(c))
  }

  function selectItemBargain(idx: number, v: string): void {
    if (v === 'none') { setItem(idx, { sales_bargain_id: '' }); return }
    const b = bargains.find((x) => String(x.id) === v)
    const it = items[idx]
    // Pull the bargain's SKU rate card. The lookup must use the packaging and
    // sale type the line is ABOUT to have (the bargain often brings both) —
    // reading items[idx] inside the .then sees the stale pre-bargain line and
    // the card lookup misses, which is exactly how fed rates failed to appear.
    const nextPack = b?.packaging_id ? String(b.packaging_id) : String(it.packaging_id || '')
    void loadCard(v).then((card) => {
      const hit = card[nextPack]
      if (!hit) return
      const nc = calc({ ...it, sales_bargain_id: v, packaging_id: nextPack, sale_type: b?.sale_type || it.sale_type || 'LOOSE' })
      const rate = cardRateInUnit(hit, nc.saleUom, mtPerCase(nc))
      // Rate/Case is a STATED figure, never a computed one: it comes off the
      // card when the card carries it, otherwise from what the user types. The
      // per-MT rate beside it is the derived one, kept only for reporting.
      if (rate != null) {
        setItem(idx, {
          rate: String(rate),
          rate_case: hit.rate_per_case != null ? String(hit.rate_per_case) : '',
          rate_from_card: true
        })
      }
    })
    setItem(idx, {
      sales_bargain_id: v,
      rate: it.rate || b?.rate || '',
      gst_pct: it.gst_pct || (b && Number(b.gst_pct) > 0 ? b.gst_pct : it.gst_pct),
      gst_type: b?.gst_type || it.gst_type || 'CGST_SGST',
      sale_type: b?.sale_type || it.sale_type || 'LOOSE',
      packaging_id: b?.packaging_id ? String(b.packaging_id) : it.packaging_id,
      product_id: it.product_id || (b ? String(b.product_id) : '')
    })
  }

  function chooseCustomer(v: string): void {
    const cust = customers.find((c) => String(c.id) === v)
    setHeader((p) => ({
      ...p,
      customer_id: v,
      customer: cust?.name ?? p.customer,
      // TDS comes off the customer master, like GST does — still editable.
      tds_pct: cust && Number(cust.tds_pct) > 0 ? cust.tds_pct : ''
    }))
    // Drop item bargains that belong to another customer.
    setItems((prev) => prev.map((it) => {
      const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
      const keep = b && (b.customer_id != null && String(b.customer_id) !== '' ? String(b.customer_id) === v : true)
      return keep ? it : { ...it, sales_bargain_id: '' }
    }))
  }

  // Selling more than the bargain has left. Mirrors the purchase loading query:
  // the excess is booked as a new bargain, moved onto the next open bargain, or
  // added to this one. `idx` is the line it came from.
  const [excess, setExcess] = useState<{
    idx: number
    qty: number
    balance: number
    uom: string
    mode: 'new' | 'existing' | 'expand'
    diffRate: boolean
    rate: string
    targetBargainId: string
  } | null>(null)
  const [excessBusy, setExcessBusy] = useState(false)

  // How much of a bargain this invoice may still draw: the register balance, plus
  // back whatever the invoice being edited already books on it (those lines are
  // about to be replaced), less what the invoice's OTHER lines take from it.
  function bargainRoom(bargainId: string, exceptIdx: number, lines: Row[]): number {
    const b = bargains.find((x) => String(x.id) === String(bargainId))
    if (!b) return Infinity
    let room = Number(b.balance_qty) || 0
    if (editingGroup) {
      for (const r of rows) {
        if (String(r.invoice_group || `LEGACY-${r.id}`) !== editingGroup) continue
        if (String(r.sales_bargain_id || '') === String(bargainId)) room += Number(r.qty) || 0
      }
    }
    lines.forEach((it, i) => {
      if (i === exceptIdx) return
      if (String(it.sales_bargain_id || '') === String(bargainId)) room -= calc(it).effQty
    })
    return Math.round(room * 1000) / 1000
  }

  // Split a line so `keepQty` stays on its bargain and the rest moves to another.
  // A packed line splits on a pouch boundary — the smallest saleable unit — so no
  // case is ever broken in half.
  function splitLine(it: Row, keepQty: number): [Row, Row] {
    const c = calc(it)
    if (!c.isPacked) {
      const keep = Math.max(0, Math.round(keepQty * 1000) / 1000)
      const rest = Math.round((c.effQty - keep) * 1000) / 1000
      return [{ ...it, qty: String(keep) }, { ...it, qty: String(rest) }]
    }
    const ppb = Number(c.selPack?.pouches_per_box) || 1
    const perPouch = convertQty(Number(c.selPack?.base_per_pouch) || 0, c.packBaseUom, c.saleUom)
    const total = (Number(it.boxes) || 0) * ppb + (Number(it.pouches) || 0)
    const keepPouches = perPouch > 0 ? Math.min(total, Math.floor(keepQty / perPouch + 1e-9)) : 0
    const asPack = (n: number): Row => ({
      boxes: Math.floor(n / ppb) ? String(Math.floor(n / ppb)) : '',
      pouches: n % ppb ? String(n % ppb) : ''
    })
    return [{ ...it, ...asPack(keepPouches) }, { ...it, ...asPack(total - keepPouches) }]
  }

  // Carry out the chosen resolution, then save the invoice.
  async function resolveExcess(): Promise<void> {
    if (!excess) return
    const it = items[excess.idx]
    if (!it) return void setExcess(null)
    const label = String(header.invoice_no || '').trim() || '(no number)'
    const date = String(header.sale_date || todayISO())
    setExcessBusy(true)
    try {
      // (a) Grow this bargain and leave the invoice as typed.
      if (excess.mode === 'expand') {
        const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
        await window.api.salesBargains.adjust(
          Number(it.sales_bargain_id),
          excess.qty,
          `Top-up for invoice ${label}`,
          date
        )
        toast.success(`${b?.bargain_no || 'Bargain'} increased by ${formatNum(excess.qty)} ${excess.uom}`)
        setExcess(null)
        await save(items, true)
        return
      }

      // (b) and (c) both split the line, so work out the halves first — the
      // packed split lands on a pouch boundary and can differ slightly from the
      // raw excess, and the new bargain must cover what actually moves.
      const [keep, extra] = splitLine(it, excess.balance)
      const moveQty = calc(extra).effQty
      if (moveQty <= 1e-9) {
        toast.error('Nothing to move — check the quantity')
        return
      }

      let targetId = excess.targetBargainId
      let extraRate = String(it.rate || '')
      if (excess.mode === 'new') {
        const rate = excess.diffRate && Number(excess.rate) > 0 ? Number(excess.rate) : Number(it.rate) || 0
        if (rate <= 0) {
          toast.error('Enter a rate for the new bargain')
          return
        }
        const made = await window.api.salesBargains.create({
          bargain_date: date,
          customer: String(header.customer || ''),
          customer_id: header.customer_id ? Number(header.customer_id) : null,
          product_id: Number(it.product_id),
          qty: moveQty,
          uom: excess.uom,
          rate,
          sale_type: it.sale_type,
          packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
          gst_pct: Number(it.gst_pct) || 0,
          gst_type: it.gst_type,
          freight_term: header.freight_term,
          note: `Excess of ${formatNum(moveQty)} ${excess.uom} on invoice ${label}`
        })
        targetId = String(made.id)
        extraRate = String(rate)
        toast.success(`New bargain ${made.bargain_no} created for ${formatNum(moveQty)} ${excess.uom}`)
      } else {
        if (!targetId) {
          toast.error('Select the bargain the extra quantity goes to')
          return
        }
        const room = bargainRoom(targetId, -1, items)
        if (moveQty > room + 1e-6) {
          const t = bargains.find((x) => String(x.id) === String(targetId))
          toast.error(`${t?.bargain_no || 'That bargain'} has only ${formatNum(room)} ${excess.uom} free`)
          return
        }
        toast.success(`${formatNum(moveQty)} ${excess.uom} moved to the selected bargain`)
      }

      const moved: Row = { ...extra, sales_bargain_id: targetId, rate: extraRate, rate_from_card: false }
      const next = [...items]
      // Nothing fits on the original bargain (its balance is already used up), so
      // the whole line moves rather than leaving an empty one behind.
      if (calc(keep).effQty <= 1e-9) next[excess.idx] = moved
      else next.splice(excess.idx, 1, keep, moved)
      setItems(next)
      setExcess(null)
      await save(next, true)
    } catch (e) {
      toast.error(errText(e))
      await load()
    } finally {
      setExcessBusy(false)
    }
  }

  // Tally's accept shortcut, on the invoice form only.
  useEffect(() => {
    if (!formPage) return
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        if (!saving) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, saving, header, items])

  async function save(overrideItems?: Row[], excessResolved = false): Promise<void> {
    const lines = overrideItems ?? items
    if (!String(header.invoice_no || '').trim()) return void toast.error('Invoice number is required')
    if (!lines.length) return void toast.error('Add at least one item')
    for (const [i, it] of lines.entries()) {
      if (!it.product_id) return void toast.error(`Item ${i + 1}: select a product`)
      const c = calc(it)
      if (c.isPacked && !it.packaging_id) return void toast.error(`Item ${i + 1}: select a packaging`)
      if (c.effQty <= 0) return void toast.error(`Item ${i + 1}: enter quantity`)
      if ((Number(it.rate) || 0) < 0) return void toast.error(`Item ${i + 1}: rate cannot be negative`)
    }
    if (isDld && !header.transporter_id) return void toast.error('Select a transporter for the FOR delivery')

    // More on a line than its bargain has left: stop and ask where the extra goes
    // instead of failing the save. The server checks the balance as well, so this
    // is the query, not the guard.
    if (!excessResolved) {
      for (const [i, it] of lines.entries()) {
        if (!it.sales_bargain_id) continue
        const c = calc(it)
        const room = bargainRoom(String(it.sales_bargain_id), i, lines)
        const over = Math.round((c.effQty - room) * 1000) / 1000
        if (over > 1e-6) {
          const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
          setExcess({
            idx: i,
            qty: over,
            balance: Math.max(room, 0),
            uom: c.saleUom,
            mode: 'new',
            diffRate: false,
            rate: String(it.rate || b?.rate || ''),
            targetBargainId: ''
          })
          return
        }
      }
    }

    const payload: Row = {
      ...header,
      customer_id: header.customer_id ? Number(header.customer_id) : null,
      transporter_id: header.transporter_id ? Number(header.transporter_id) : null,
      round_off: Number(header.round_off) || 0,
      round_off_manual: header.round_off_manual ? 1 : 0,
      tds_pct: Number(header.tds_pct) || 0,
      items: lines.map((it) => ({
        product_id: Number(it.product_id),
        sales_bargain_id: it.sales_bargain_id ? Number(it.sales_bargain_id) : null,
        sale_type: it.sale_type,
        packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
        boxes: it.boxes,
        pouches: it.pouches,
        qty: it.qty,
        rate: it.rate,
        // A packed line is billed on this, not on rate x MT — the case weight
        // does not always convert exactly and the error lands on the money.
        // Only a STATED rate is stored. Never fabricate one for a line that
        // never had it — the main process then values that line the way it
        // always did, rather than on a figure nobody agreed.
        rate_per_case:
          it.sale_type === 'PACKED' && Number.isFinite(Number(it.rate_case)) && Number(it.rate_case) > 0
            ? Number(it.rate_case)
            : null,
        gst_pct: it.gst_pct,
        gst_type: it.gst_type
      }))
    }
    const submit = async (force: boolean): Promise<void> => {
      const p = force ? { ...payload, force_no_stock: true } : payload
      if (editingGroup) await window.api.sales.updateInvoice(editingGroup, p)
      else await window.api.sales.createInvoice(p)
    }

    setSaving(true)
    try {
      try {
        await submit(false)
      } catch (e) {
        const msg = errText(e)
        if (/stock/i.test(msg)) {
          const go = window.confirm(`${msg}\n\nDispatch anyway (off-stock)? The finished-goods stock will still be reduced by this dispatch and may go negative — this only skips the "enough stock" check.`)
          if (!go) { setSaving(false); return }
          await submit(true)
        } else {
          throw e
        }
      }
      toast.success('Invoice saved')
      setFormPage(false)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  // Marking an invoice Unloaded is the moment the transporter's delivered
  // weight is known, so that is where it gets asked for — one figure per line,
  // since an invoice can carry several products.
  const [unloadInv, setUnloadInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [unloadDate, setUnloadDate] = useState(todayISO())
  const [unloadQty, setUnloadQty] = useState<Record<string, string>>({})
  const [unloadSaving, setUnloadSaving] = useState(false)

  function openUnload(inv: { group: string; first: Row; lines: Row[] }): void {
    setUnloadInv(inv)
    setUnloadDate(String(inv.first.unloaded_date || todayISO()).slice(0, 10))
    // Deliberately blank. A pre-filled dispatched figure is quicker to accept
    // than to retype, which is exactly the problem — it invites confirming a
    // number nobody weighed. Whatever was recorded before is kept, so a re-open
    // is an edit rather than a fresh ask.
    setUnloadQty(
      Object.fromEntries(inv.lines.map((l) => [String(l.id), l.received_qty != null ? String(l.received_qty) : '']))
    )
  }

  async function confirmUnload(): Promise<void> {
    if (!unloadInv) return
    const received: Record<string, number | null> = {}
    for (const l of unloadInv.lines) {
      const raw = unloadQty[String(l.id)]
      if (raw === '' || raw == null) {
        return void toast.error(`Enter the received qty for ${l.product_name} — it is required to unload`)
      }
      const q = Number(raw)
      if (!Number.isFinite(q) || q < 0) return void toast.error(`Enter a valid received qty for ${l.product_name}`)
      received[String(l.id)] = q
    }
    setUnloadSaving(true)
    try {
      await changeInvoiceStage(unloadInv.group, 'unloaded', unloadDate, received)
      setUnloadInv(null)
    } finally {
      setUnloadSaving(false)
    }
  }

  async function changeInvoiceStage(
    group: string,
    stage: string,
    dateIn?: string,
    received?: Record<string, number | null>
  ): Promise<void> {
    const label = DISPATCH_STAGES.find((x) => x.value === stage)?.label || stage
    const today = dateIn || todayISO()
    try {
      await window.api.sales.setInvoiceStage(group, stage, false, today, received)
      toast.success(`Invoice marked ${label}`)
      await load()
    } catch (e) {
      const msg = errText(e)
      if (/stock/i.test(msg)) {
        const go = window.confirm(`${msg}\n\nDispatch anyway (off-stock)? The finished-goods stock will still be reduced by this invoice and may go negative — this only skips the "enough stock" check.`)
        if (!go) return
        try {
          await window.api.sales.setInvoiceStage(group, stage, true, today, received)
          toast.success(`Invoice marked ${label} — off-stock (stock still reduced)`)
          await load()
        } catch (e2) {
          toast.error(errText(e2))
        }
        return
      }
      toast.error(msg)
    }
  }

  async function delInvoice(inv: { group: string; first: Row; lines: Row[] }): Promise<void> {
    if (!window.confirm(`Delete invoice ${inv.first.invoice_no || ''} (${inv.lines.length} item${inv.lines.length > 1 ? 's' : ''})?`)) return
    try {
      await window.api.sales.removeInvoice(inv.group)
      toast.success('Invoice deleted')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // Reject: the customer refused the consignment before it was ever fully
  // delivered — the invoice stays on record (its Credit Note is a separate,
  // manual step) but drops out of the Gate Out picker and the "Produce more"
  // demand calc. Doesn't touch stock or the journal.
  const [rejectInv, setRejectInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  async function saveReject(): Promise<void> {
    if (!rejectInv) return
    if (!rejectReason.trim()) return void toast.error('Enter a reason')
    setRejecting(true)
    try {
      await window.api.sales.rejectInvoice(rejectInv.group, rejectReason.trim())
      toast.success('Invoice marked Rejected')
      setRejectInv(null)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRejecting(false)
    }
  }
  // Cancel delivery: the customer calls it off while the load is on the road.
  // Nothing is ever unloaded, so there is no weighed-in quantity — but the
  // transporter carried it and still has to be paid, so the freight is struck on
  // an assumed quantity, pre-filled with what was dispatched and editable.
  const [cancelInv, setCancelInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelQty, setCancelQty] = useState<Record<string, string>>({})
  const [cancelling, setCancelling] = useState(false)
  const cancelFreightQty = (cancelInv?.lines || []).reduce(
    (t, l) => t + (Number(cancelQty[String(l.id)]) || 0),
    0
  )

  function openCancel(inv: { group: string; first: Row; lines: Row[] }): void {
    setCancelInv(inv)
    setCancelReason('')
    // Pre-filled with the dispatched figure: the whole load travelled unless the
    // user says otherwise. Unlike unloading, a number here is an assumption we
    // are making on the transporter's behalf, not a weighbridge reading, so it
    // is offered rather than demanded blank.
    setCancelQty(Object.fromEntries(inv.lines.map((l) => [String(l.id), String(Number(l.qty) || 0)])))
  }

  async function confirmCancel(): Promise<void> {
    if (!cancelInv) return
    if (!cancelReason.trim()) return void toast.error('Enter why the delivery was cancelled')
    const freightQty: Record<string, number | null> = {}
    for (const l of cancelInv.lines) {
      const raw = cancelQty[String(l.id)]
      const q = Number(raw)
      if (raw === '' || raw == null || !Number.isFinite(q) || q < 0) {
        return void toast.error(`Enter a valid freight qty for ${l.product_name}`)
      }
      freightQty[String(l.id)] = q
    }
    setCancelling(true)
    try {
      await window.api.sales.cancelDelivery(cancelInv.group, cancelReason.trim(), freightQty)
      toast.success(`Delivery cancelled — freight kept on ${formatNum(cancelFreightQty)} ${cancelInv.first.uom || 'MT'}`)
      setCancelInv(null)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setCancelling(false)
    }
  }

  async function restoreInvoice(inv: { group: string; first: Row }): Promise<void> {
    try {
      await window.api.sales.unrejectInvoice(inv.group)
      toast.success('Invoice restored')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  return (
    <div>
      {!formPage && (
      <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-9 pl-8"
            placeholder="Search invoice no, customer, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
            Date
          </span>
          <DatePicker value={dateFrom} onChange={(v) => setDateFrom(v || '')} max={dateTo || undefined} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
          <span className="shrink-0 text-[10px] text-muted-foreground">to</span>
          <DatePicker value={dateTo} onChange={(v) => setDateTo(v || '')} min={dateFrom || undefined} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
            Product type
          </span>
          <MultiSelectFilter
            options={productTypes.map((t) => ({ value: t, label: t.toUpperCase() }))}
            value={productType}
            onApply={setProductType}
            allLabel="All product types"
            className="h-9 w-[11.5rem] text-[12px]"
          />
        </div>
        {unloadOnly && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] font-medium text-sky-900">
            <Truck className="h-3.5 w-3.5 shrink-0" />
            Deliveries still out — record what was received on unloading
          </span>
        )}
        {!unloadOnly && (
        <ExcelButton
          className="ml-auto"
          filename={`sales-invoices-${todayISO()}`}
          sheetName="Sales invoices"
          title="Sales invoices"
          columns={[
            { header: 'Date', key: 'date', value: (r) => formatDate(r.first.sale_date) },
            { header: 'Invoice no', key: 'inv', value: (r) => r.first.invoice_no || '' },
            { header: 'Customer', key: 'cust', value: (r) => r.first.customer || '' },
            { header: 'Items', key: 'items', value: (r) => r.lines.map((l: Row) => l.product_name).join(', ') },
            { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
            { header: 'Invoice total', key: 'net', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.net) || 0 },
            { header: 'Stage', key: 'stage', value: (r) => stageInfo(r.first).label }
          ]}
          rows={filteredInvoices}
        />
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table className={unloadOnly ? 'min-w-[720px]' : 'min-w-[1040px]'}>
          {/* The dark fill belongs on the THEAD, not the row: TableHeader
              carries [&_tr:hover]:bg-transparent (so a header never lights up
              like a data row), and that descendant selector out-specifies any
              hover: class on the row itself — which made the row go
              transparent on hover and show the white card through it. */}
          <TableHeader className="bg-[#1a2c56] [&_th]:text-white">
            <TableRow className="border-b-2 border-[#1a2c56]/30">
              {INV_COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    c.key === 'invoice_no' && 'w-[150px]',
                    c.key === 'qty' && 'w-[110px] text-right',
                    c.key === 'net' && 'w-[140px] text-right',
                    c.key === 'freight' && 'w-[130px]',
                    // The desk has four columns and no Actions, so Dispatch
                    // carries the only control and is pulled to the right —
                    // otherwise Items stretches and leaves a lane of white
                    // space between the item and the button that acts on it.
                    c.key === 'dispatch' && (unloadOnly ? 'w-[240px] text-right' : 'w-[220px]'),
                    unloadOnly && c.key === 'customer' && 'w-[260px]',
                    unloadOnly && c.key === 'items' && 'w-auto'
                  )}
                >
                  <ColumnFilter
                    label={c.label}
                    options={invColOptions(c.key)}
                    value={invCols[c.key] ?? []}
                    onDark
                    onApply={(v) => setInvCols((p) => ({ ...p, [c.key]: v }))}
                    align={
                      c.key === 'qty' || c.key === 'net' || (unloadOnly && c.key === 'dispatch') ? 'end' : 'start'
                    }
                  />
                </TableHead>
              ))}
              {!unloadOnly && <TableHead className="w-[84px] text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Totals for exactly the rows the filters left — sits under the
                header so the figure is read before scrolling, not after. */}
            {!loading && !unloadOnly && filteredInvoices.length > 0 && (
              <TableRow className="border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50">
                <TableCell className="font-semibold text-amber-900">
                  Total
                  <span className="ml-1.5 font-normal text-amber-800/70">
                    ({filteredInvoices.length} invoice{filteredInvoices.length === 1 ? '' : 's'})
                  </span>
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="text-right font-semibold tabular-nums text-amber-900">
                  {formatNum(filteredInvoices.reduce((t, inv) => t + (Number(inv.qty) || 0), 0))}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-amber-900">
                  {formatINR(filteredInvoices.reduce((t, inv) => t + (Number(inv.net) || 0), 0))}
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell />
              </TableRow>
            )}
            {loading ? (
              <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : filteredInvoices.length === 0 ? (
              <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                {unloadOnly
                  ? 'Nothing waiting to be received — every delivery in this period has been unloaded.'
                  : invoices.length === 0 ? 'No sales yet.' : 'No sales in this period / search.'}
              </TableCell></TableRow>
            ) : (
              filteredInvoices.map((inv) => {
                const stg = stageInfo(inv.first)
                const exTerm = String(inv.first.freight_term || 'FREIGHT_ON_GOODS') !== 'DLD'
                const idx = DISPATCH_STAGES.findIndex((x) => x.value === stg.value)
                const prevStage = idx > 0 ? DISPATCH_STAGES[idx - 1] : null
                const nextStage = idx < DISPATCH_STAGES.length - 1 ? DISPATCH_STAGES[idx + 1] : null
                const untracked = Number(inv.first.track_stock) === 0
                const isOpen = !!expanded[inv.group]
                return (
                  <Fragment key={inv.group}>
                    <TableRow
                      className={unloadOnly ? undefined : 'cursor-pointer'}
                      onClick={unloadOnly ? undefined : () => setExpanded((p) => ({ ...p, [inv.group]: !p[inv.group] }))}
                    >
                      <TableCell className="align-top">
                        <div className="flex items-center gap-1.5">
                          {unloadOnly ? null : isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          <div>
                            <div className="flex items-center gap-1.5 whitespace-nowrap">
                              {formatDate(inv.first.sale_date)}
                              {inv.first.rejected_at && (
                                <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
                                  <Ban className="h-2.5 w-2.5" /> Rejected
                                </Badge>
                              )}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">{inv.first.invoice_no || '—'}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="truncate font-medium" title={inv.first.customer || ''}>{inv.first.customer || '—'}</div>
                        {inv.first.rejected_at && (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-rose-700" title={inv.first.rejected_reason || ''}>
                            <Ban className="h-3 w-3 shrink-0" /> <span className="truncate">{inv.first.rejected_reason}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-sm">{inv.lines.length} item{inv.lines.length > 1 ? 's' : ''}</div>
                        <div className="truncate text-xs text-muted-foreground" title={inv.lines.map((r) => r.product_name).join(', ')}>
                          {inv.lines.map((r) => r.product_name).join(', ')}
                        </div>
                      </TableCell>
                      {!unloadOnly && (
                        <>
                      <TableCell className="align-top text-right tabular-nums">{formatNum(inv.qty)}</TableCell>
                      <TableCell className="align-top text-right tabular-nums">{formatINR(inv.net)}</TableCell>
                      <TableCell className="align-top">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            exTerm ? 'bg-slate-200 text-slate-700' : 'bg-sky-100 text-sky-800'
                          )}
                          title={exTerm ? 'Ex — the customer lifts, no freight of ours' : 'FOR — we deliver and pay the transporter'}
                        >
                          {exTerm ? 'Ex' : 'FOR'}
                        </span>
                      </TableCell>
                        </>
                      )}
                      <TableCell className="align-top" onClick={(e) => e.stopPropagation()}>
                        {unloadOnly ? (
                          // One action, and only once the load has actually left:
                          // an invoice still Pending has not been dispatched, so
                          // there is nothing to receive against it yet.
                          <div className="flex items-center justify-end gap-2">
                            <Badge variant={stg.badge} className="min-w-[76px] justify-center">{stg.label}</Badge>
                            {stg.value === 'pending' ? (
                              <span className="text-[11px] text-muted-foreground">Not dispatched yet</span>
                            ) : (
                              <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openUnload(inv)}>
                                <Truck className="h-3.5 w-3.5" /> Record received
                              </Button>
                            )}
                          </div>
                        ) : exTerm ? (
                          <span className="flex h-7 items-center gap-1 text-xs font-medium text-emerald-600" title="Customer lifts — no dispatch tracking">
                            <Check className="h-3.5 w-3.5" /> Done
                          </span>
                        ) : (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={!prevStage}
                            onClick={() => prevStage && changeInvoiceStage(inv.group, prevStage.value)}
                            title={prevStage ? `Back to ${prevStage.label}` : 'At the first stage'}
                            className="flex h-7 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <Badge variant={stg.badge} className="min-w-[76px] justify-center">{stg.label}</Badge>
                          {nextStage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 gap-1 px-2 text-xs"
                              title={`Mark ${nextStage.label}`}
                              onClick={() =>
                                nextStage.value === 'unloaded'
                                  ? openUnload(inv)
                                  : void changeInvoiceStage(inv.group, nextStage.value)
                              }
                            >
                              {nextStage.label}<ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="flex items-center gap-0.5 pl-1 text-xs font-medium text-emerald-600" title="Delivered"><Check className="h-3.5 w-3.5" /> Done</span>
                          )}
                        </div>
                        )}
                        {untracked && !unloadOnly && <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-orange-600">Off-stock</div>}
                      </TableCell>
                      {!unloadOnly && (
                      <TableCell className="align-top text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end">
                          <RowActions
                            actions={[
                              ...(inv.first.rejected_at
                                ? [
                                    {
                                      label: 'Restore — back to the active list',
                                      icon: RotateCcw,
                                      onClick: () => void restoreInvoice(inv)
                                    }
                                  ]
                                : stg.value !== 'unloaded'
                                  ? [
                                      // Only a FOR delivery has a journey to
                                      // call off; an Ex sale leaves with the
                                      // customer at invoicing.
                                      ...(exTerm
                                        ? []
                                        : [
                                            {
                                              label: 'Cancel delivery — called off in transit',
                                              icon: Truck,
                                              onClick: () => openCancel(inv)
                                            }
                                          ]),
                                      {
                                        label: 'Reject — customer refused it',
                                        icon: Ban,
                                        onClick: () => { setRejectInv(inv); setRejectReason('') }
                                      }
                                    ]
                                  : []),
                              { label: 'Edit invoice', icon: Pencil, onClick: () => openEditInvoice(inv) },
                              { label: 'Delete invoice', icon: Trash2, danger: true, onClick: () => delInvoice(inv) }
                            ]}
                          />
                        </div>
                      </TableCell>
                      )}
                    </TableRow>
                    {!unloadOnly && isOpen && inv.lines.map((r) => {
                      const inStock = stock[r.product_id as number]?.stock ?? 0
                      return (
                        <TableRow key={r.id as number} className="bg-muted/30">
                          <TableCell />
                          <TableCell className="align-top text-xs text-muted-foreground">{r.sales_bargain_no || 'No bargain'}</TableCell>
                          <TableCell className="align-top">
                            <div className="text-sm font-medium">{r.product_name}</div>
                            <div className="text-xs text-muted-foreground">{r.sale_type === 'PACKED' ? (r.packaging_name || 'Packed') : 'Loose'}</div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            <div>{formatNum(r.qty)} {r.uom}</div>
                            {r.received_qty != null ? (
                              <div
                                className={cn(
                                  'text-[11px]',
                                  Number(r.qty) - Number(r.received_qty) > 0.0005 ? 'text-rose-600' : 'text-emerald-700'
                                )}
                                title="Weighed in by the transporter at the customer's end"
                              >
                                rec {formatNum(r.received_qty)}
                                {Number(r.qty) - Number(r.received_qty) > 0.0005 && (
                                  <> · short {formatNum(Number(r.qty) - Number(r.received_qty))}</>
                                )}
                              </div>
                            ) : null}
                            <div className="text-[11px] text-muted-foreground" title="Finished stock in hand">stk {formatNum(inStock)}</div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            <div>{formatINR(Number(r.amount) + Number(r.gst_amount || 0))}</div>
                            <div className="text-[11px] text-muted-foreground">@ {formatINR(r.rate)}/{r.uom}</div>
                          </TableCell>
                          <TableCell className="align-top text-[11px] text-muted-foreground" colSpan={2}>
                            GST {formatNum(r.gst_pct)}% ({r.gst_type === 'IGST' ? 'IGST' : 'CGST+SGST'}) · {formatINR(r.gst_amount)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      </>
      )}

      {formPage && (
      <div className="w-full rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
          <button className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline" onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}>
            <ArrowLeft className="h-3.5 w-3.5" /> {onBack ? `Back to ${backLabel || 'previous page'}` : 'Back'}
          </button>
          <div className="h-4 border-l border-[#1a2c56]/30" />
          <h2 className="text-[13px] font-bold uppercase tracking-widest">
            {editingGroup ? 'Alter sales invoice' : 'Sales invoice'}
          </h2>
          <span className="ml-auto text-[11px] font-medium">
            {header.invoice_no ? `No ${header.invoice_no}` : 'No: not yet given'} · {formatDate(header.sale_date)}
          </span>
        </div>

        {/* Invoice header */}
        <div className="border-b border-dashed border-[#d9d2b8] px-4 py-3 [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white">
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 [&>div]:min-w-0 [&>div]:gap-1 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
            <div className="flex flex-col gap-1.5">
              <Label>Date</Label>
              <DatePicker value={header.sale_date} onChange={(v) => setHeaderField('sale_date', v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Invoice no</Label>
              <Input value={header.invoice_no ?? ''} onChange={(e) => setHeaderField('invoice_no', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Customer</Label>
              <Select value={header.customer_id ? String(header.customer_id) : ''} onValueChange={chooseCustomer}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {invoiceCustomers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* No trading tick here: a trading sale is booked on the Trading
                page, which sets the flag itself on both sides of the deal. The
                header still CARRIES is_trading when an existing invoice is
                loaded (see openEditInvoice), so editing one cannot silently
                turn it into an ordinary sale. */}
            <div className="flex flex-col gap-1.5">
              <Label>Freight term</Label>
              <Select value={header.freight_term || 'FREIGHT_ON_GOODS'} onValueChange={(v) => setHeaderField('freight_term', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT_ON_GOODS">Ex — customer lifts</SelectItem>
                  <SelectItem value="DLD">FOR — we deliver</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Dispatch stage</Label>
              {isDld ? (
                <Select value={header.dispatch_stage || 'pending'} onValueChange={(v) => setHeaderField('dispatch_stage', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DISPATCH_STAGES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <div
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-emerald-50 px-2.5 text-[12px] font-medium text-emerald-700"
                  title="Ex sale — the goods leave with the customer, so the dispatch is complete on invoicing"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Done — customer lifts</span>
                </div>
              )}
            </div>
          </div>

          {isDld && (
            <div className="mt-4 grid grid-cols-2 gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label>Transporter *</Label>
                <Select value={header.transporter_id ? String(header.transporter_id) : ''} onValueChange={(v) => setHeaderField('transporter_id', v)}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{transporters.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>&nbsp;</Label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-sky-200 bg-white px-2.5 text-[12px] font-medium text-sky-900">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={!!header.deduct_freight}
                    onChange={(e) => setHeaderField('deduct_freight', e.target.checked)}
                  />
                  Deduct freight from invoice total
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Freight rate / unit</Label>
                <Input type="number" className="bg-white" value={header.transport_rate ?? ''} onChange={(e) => setHeaderField('transport_rate', e.target.value)} />
                <span className="text-[10px] text-muted-foreground">per case for a packed item, per MT for a loose one</span>
              </div>
              <p className="col-span-full text-[11px] text-sky-800">
                {header.deduct_freight
                  ? 'Deducted: the freight comes OFF the invoice total (rate × cases, or rate × MT if loose) because the customer settles the transporter directly — so it is not booked as ours to pay and will not appear on Fr. Outward Working.'
                  : 'Not deducted: the invoice total is the goods alone. The freight is ours to carry, posted to the transporter ledger, and shows on Fr. Outward Working until their bill is booked.'}
              </p>
            </div>
          )}

          {isDld && header.dispatch_stage && header.dispatch_stage !== 'pending' && (
            <div className="mt-4 grid grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label>Loaded date</Label>
                <DatePicker value={header.loaded_date ?? ''} onChange={(v) => setHeaderField('loaded_date', v)} />
              </div>
              {(header.dispatch_stage === 'transit' || header.dispatch_stage === 'unloaded') && (
                <div className="flex flex-col gap-1.5"><Label>In-transit date</Label><DatePicker value={header.transit_date ?? ''} onChange={(v) => setHeaderField('transit_date', v)} /></div>
              )}
              {header.dispatch_stage === 'unloaded' && (
                <div className="flex flex-col gap-1.5"><Label>Unloaded date</Label><DatePicker value={header.unloaded_date ?? ''} onChange={(v) => setHeaderField('unloaded_date', v)} /></div>
              )}
              <p className="text-[11px] text-muted-foreground sm:col-span-3">Blank stages are stamped with today&apos;s date. Dispatching draws finished stock (checked against availability).</p>
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2 rounded bg-[#f1ecd9] px-3 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Particulars</span>
            <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {items.length} item{items.length === 1 ? '' : 's'} · {formatNum(totals.qty)} MT
            </span>
          </div>
          <div className="space-y-2">
          {items.map((item, i) => {
            const c = calc(item)
            const prodBargains = bargainsFor(item)
            return (
              <div key={i} className="rounded border border-[#e5dfc8] bg-white p-3 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white">
                <div className="mb-2 flex items-center justify-between border-b border-dotted border-[#e5dfc8] pb-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Item {i + 1}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{formatINR(c.net)}</span>
                    {items.length > 1 && (
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-destructive" onClick={() => removeItem(i)}>
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </Button>
                    )}
                  </span>
                </div>
                <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:gap-1">
                  <div className="flex flex-col gap-1.5">
                    <Label>Product *</Label>
                    <Select value={String(item.product_id)} onValueChange={(v) => setItem(i, { product_id: v, sales_bargain_id: '' })}>
                      <SelectTrigger><SelectValue placeholder="Finished product" /></SelectTrigger>
                      <SelectContent>{products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                    </Select>
                    {/* A fixed-height caption slot, empty here — Sales bargain's
                        expiry note is the only one of these three that ever has
                        text, so without this the row would tilt toward it. */}
                    <span className="block h-[15px]" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Sales bargain (optional)</Label>
                    <Select value={item.sales_bargain_id ? String(item.sales_bargain_id) : 'none'} onValueChange={(v) => selectItemBargain(i, v)} disabled={!item.product_id}>
                      <SelectTrigger>
                        {/* The list carries the detail; the closed field shows
                            the bargain number and a short balance, so it never
                            outgrows its box. */}
                        <SelectValue placeholder="No bargain">
                          {(() => {
                            const b = bargains.find((x) => String(x.id) === String(item.sales_bargain_id))
                            if (!b) return 'No bargain'
                            return (
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-medium normal-case">{b.bargain_no}</span>
                                <span className="shrink-0 text-[11px] normal-case text-muted-foreground">
                                  bal {formatNum(b.balance_qty)}
                                </span>
                                {!notExpired(b) && (
                                  <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-bold uppercase text-amber-800">
                                    expired
                                  </span>
                                )}
                              </span>
                            )
                          })()}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No bargain</SelectItem>
                        {prodBargains.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            <span className="font-medium">{b.bargain_no}</span>
                            <span className="text-muted-foreground"> · Bal {formatNum(b.balance_qty)} · {formatINR(b.rate)}</span>
                            {!notExpired(b) && (
                              <span className="font-medium text-amber-700"> · rate expired {formatDate(b.rate_expiry_date)}</span>
                            )}
                            {notExpired(b) && rateExpired(b) && (
                              <span className="text-emerald-700"> · valid on {formatDate(asOfDate)}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="block min-h-[15px] text-[10px] font-medium leading-[15px] text-amber-700">
                      {(() => {
                        const chosen = bargains.find((b) => String(b.id) === String(item.sales_bargain_id))
                        return chosen && !notExpired(chosen)
                          ? `Rate expired ${formatDate(chosen.rate_expiry_date)}, before this invoice's date (${formatDate(asOfDate)}) — selling against it anyway`
                          : ''
                      })()}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Sale type</Label>
                    <Select value={item.sale_type || 'LOOSE'} onValueChange={(v) => setItem(i, { sale_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                        <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="block h-[15px]" />
                  </div>
                </div>

                {c.isPacked && (
                  <div className="mt-2 grid grid-cols-2 items-start gap-x-3 gap-y-2 rounded-md border border-violet-200 bg-violet-50/60 p-2.5 sm:grid-cols-3 [&>div]:min-w-0 [&>div]:gap-1">
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <Label>Packed SKU *</Label>
                      <Select value={item.packaging_id ? String(item.packaging_id) : ''} onValueChange={(v) => {
                        setItem(i, { packaging_id: v })
                        // Changing the SKU re-prices from the bargain's rate card.
                        const bid = String(items[i]?.sales_bargain_id || '')
                        if (bid) {
                          void loadCard(bid).then((card) => {
                            const hit = card[v]
                            if (!hit) return
                            const nc = calc({ ...items[i], packaging_id: v })
                            const rate = cardRateInUnit(hit, nc.saleUom, mtPerCase(nc))
                            if (rate != null) {
                              setItem(i, {
                                rate: String(rate),
                                rate_case: hit.rate_per_case != null ? String(hit.rate_per_case) : '',
                                rate_from_card: true
                              })
                            }
                          })
                        }
                      }}>
                        <SelectTrigger className="bg-white"><SelectValue placeholder="Select packaging" /></SelectTrigger>
                        <SelectContent>{packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                      </Select>
                      {/* A fixed-height caption slot — present or not, every
                          column in this row reserves the same space below its
                          box, so the boxes above line up instead of drifting
                          up/down with however much hint text each one has. */}
                      <span className="block h-[15px] text-[11px] leading-[15px] text-muted-foreground">
                        {c.selPack &&
                          `1 ${c.selPack.box_label} = ${formatNum(c.selPack.pouches_per_box)} ${c.selPack.pouch_label} = ${formatNum(Number(c.selPack.pouches_per_box) * Number(c.selPack.base_per_pouch))} ${c.selPack.base_uom}`}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>{c.selPack?.box_label || 'Cases'}</Label>
                      <Input type="number" className="bg-white" value={item.boxes ?? ''} onChange={(e) => setItem(i, { boxes: e.target.value })} />
                      <span className="block h-[15px]" />
                    </div>
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 items-start gap-x-3 gap-y-2 sm:grid-cols-4 [&>div]:min-w-0 [&>div]:gap-1">
                  <div className="flex flex-col gap-1.5">
                    <Label>Qty ({c.saleUom})</Label>
                    {c.isPacked ? (
                      <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">{formatNum(c.effQty)}</div>
                    ) : (
                      <Input type="number" value={item.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value })} />
                    )}
                    {/* A fixed-height caption slot — present or not, every column
                        in this row reserves the same space below its box, so
                        the boxes above stay level instead of drifting up/down
                        with however much hint text each one has. */}
                    <span className="block h-[15px] text-[11px] leading-[15px] text-muted-foreground">
                      {c.isPacked && c.selPack && c.packBaseUom !== c.saleUom ? `= ${formatNum(c.packBaseQty)} ${c.packBaseUom}` : ''}
                    </span>
                  </div>
                  {/* Packed goods are quoted per case — that is the only rate
                      box a packed line needs. The per-MT figure it implies is
                      still computed and billed (see calc/cardRateInUnit), it is
                      just never shown: a second, read-only, unchangeable box
                      next to the one the user actually fills in had nothing to
                      offer but clutter. Loose sales have no case to price by,
                      so they get the per-unit rate box instead. */}
                  {c.isPacked ? (
                    <div className="flex flex-col gap-1.5">
                      <Label>Rate / {c.selPack?.box_label || 'case'}</Label>
                      <Input
                        type="number"
                        placeholder="0.00"
                        // Only what the card gave or the user typed. It used to
                        // fall back to rate/MT x MT-per-case, which is a DERIVED
                        // figure — and one that changed with the conversion
                        // factor, so the same saved line could read 1979.78 on
                        // one build and 1980.52 on another.
                        value={item.rate_case ?? ''}
                        onChange={(e) => {
                          const per = mtPerCase(c)
                          const v = e.target.value
                          setItem(i, {
                            rate_case: v,
                            // Six decimals, not two: the amount is qty(MT) x this
                            // rate, so a rate rounded to paise cannot reproduce
                            // cases x rate-per-case on a fractional case weight.
                            rate: per > 0 && v !== '' ? String(Math.round((Number(v) / per) * 1e6) / 1e6) : item.rate,
                            rate_from_card: false
                          })
                        }}
                      />
                      <span className="block min-h-[15px] text-[10px] leading-[15px]">
                        {(() => {
                          const card = cards[String(item.sales_bargain_id || '')]
                          const hit = card?.[String(item.packaging_id || '')]
                          const cardRate = cardRateFor(item)
                          if (cardRate != null) {
                            return (
                              <span className={cn(item.rate_from_card ? 'font-medium text-emerald-700' : 'text-amber-700')}>
                                {item.rate_from_card ? 'from the bargain rate card' : `card rate ${formatINR(hit?.rate_per_case ?? cardRate)} — overridden`}
                              </span>
                            )
                          }
                          // An older line carries no stated per-case rate, so the
                          // box is empty. Show what it was actually billed at so
                          // the figure is not simply missing — labelled as
                          // history, not offered as the agreed rate.
                          if (!item.rate_case && mtPerCase(c) > 0 && Number(item.rate) > 0) {
                            return (
                              <span className="text-muted-foreground">
                                billed at {formatINR(Math.round(Number(item.rate) * mtPerCase(c) * 100) / 100)}/
                                {c.selPack?.box_label || 'case'} — retype to restate it
                              </span>
                            )
                          }
                          // Say why nothing was filled: no card at all, or this
                          // SKU is not on it. Silence here is what looked like a bug.
                          if (item.sales_bargain_id && item.packaging_id) {
                            const hasCard = card && Object.keys(card).length > 0
                            return (
                              <span className="text-muted-foreground">
                                {hasCard
                                  ? 'this SKU is not priced on the bargain’s rate card'
                                  : 'no rate card on this bargain — add one from the Sales Bargain page'}
                              </span>
                            )
                          }
                          return mtPerCase(c) > 0 ? (
                            <span className="text-muted-foreground">
                              1 {c.selPack?.box_label || 'case'} = {formatNum(mtPerCase(c))} {c.saleUom}
                            </span>
                          ) : null
                        })()}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label>Rate /{c.saleUom}</Label>
                      <Input
                        type="number"
                        value={item.rate ?? ''}
                        onChange={(e) => setItem(i, { rate: e.target.value, rate_from_card: false })}
                      />
                      <span className="block h-[15px]" />
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={item.gst_pct ?? ''} onChange={(e) => setItem(i, { gst_pct: e.target.value })} />
                    <span className="block h-[15px]" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST type</Label>
                    <Select value={item.gst_type || 'CGST_SGST'} onValueChange={(v) => setItem(i, { gst_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="block h-[15px]" />
                  </div>
                </div>
                <div className="mt-2 text-right text-xs text-muted-foreground">
                  Line: taxable {formatINR(c.amount)} ·{' '}
                  {String(item.gst_type || 'CGST_SGST') === 'IGST' ? (
                    <>IGST{c.gstPct ? ` @ ${c.gstPct}%` : ''} {formatINR(c.gstAmt)}</>
                  ) : (
                    <>
                      CGST{c.gstPct ? ` @ ${c.gstPct / 2}%` : ''} {formatINR(c.gstAmt / 2)} · SGST
                      {c.gstPct ? ` @ ${c.gstPct / 2}%` : ''} {formatINR(c.gstAmt / 2)}
                    </>
                  )}{' '}
                  · <span className="font-semibold text-foreground">{formatINR(c.net)}</span>
                </div>
              </div>
            )
          })}
          </div>
          <Button variant="outline" size="sm" className="mt-2 bg-white" onClick={addItem}><Plus className="h-4 w-4" /> Add item</Button>
        </div>

        {/* Invoice summary */}
        <div className="ml-auto w-full max-w-md px-4 pb-4 text-sm">
          <div className="rounded border border-[#d9d2b8] bg-[#f7f2e2] p-3">
          <div className="flex items-center justify-between py-0.5"><span className="text-muted-foreground">Taxable value</span><span className="tabular-nums">{formatINR(totals.amount)}</span></div>
          {/* GST split by head, the way it must appear on the invoice: an
              intra-state line is half CGST and half SGST, inter-state is IGST.
              An invoice may legitimately mix the two, so both are summed. */}
          {(() => {
            let cgst = 0
            let igst = 0
            for (const it of items) {
              const g = calc(it).gstAmt
              if (String(it.gst_type || 'CGST_SGST') === 'IGST') igst += g
              else cgst += g / 2
            }
            const round2 = (v: number): number => Math.round(v * 100) / 100
            return (
              <>
                {cgst > 0.004 && (
                  <>
                    <div className="flex items-center justify-between py-0.5">
                      <span className="text-muted-foreground">CGST</span>
                      <span className="tabular-nums">{formatINR(round2(cgst))}</span>
                    </div>
                    <div className="flex items-center justify-between py-0.5">
                      <span className="text-muted-foreground">SGST</span>
                      <span className="tabular-nums">{formatINR(round2(cgst))}</span>
                    </div>
                  </>
                )}
                {igst > 0.004 && (
                  <div className="flex items-center justify-between py-0.5">
                    <span className="text-muted-foreground">IGST</span>
                    <span className="tabular-nums">{formatINR(round2(igst))}</span>
                  </div>
                )}
                <div className="flex items-center justify-between py-0.5">
                  <span className="text-muted-foreground">Total GST</span>
                  <span className="tabular-nums">{formatINR(totals.gst)}</span>
                </div>
              </>
            )
          })()}
          <div className="flex items-center justify-between py-0.5">
            <span className="text-muted-foreground">
              Round off {header.round_off_manual ? '(manual)' : '(auto)'}
            </span>
            <span className="flex items-center gap-1.5">
              {header.round_off_manual ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  title="Go back to rounding the invoice total to the nearest rupee automatically"
                  onClick={() => setHeader((p) => ({ ...p, round_off_manual: false }))}
                >
                  Auto
                </Button>
              ) : null}
              <Input
                type="number"
                step="0.01"
                className="h-7 w-24 bg-white text-right"
                placeholder="0.00"
                value={header.round_off ?? ''}
                onChange={(e) =>
                  setHeader((p) => ({ ...p, round_off: e.target.value, round_off_manual: e.target.value !== '' }))
                }
              />
            </span>
          </div>
          {freightOnInvoice !== 0 && (
            <div className="flex items-center justify-between py-0.5">
              <span className="text-muted-foreground">
                Less freight
                <span className="ml-1 text-[10px] uppercase tracking-wide">(customer pays the transporter)</span>
              </span>
              <span className="tabular-nums text-rose-700">−{formatINR(Math.abs(freightOnInvoice))}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t-2 border-[#1a2c56] pt-1.5 text-[15px] font-bold text-[#1a2c56]">
            <span>Invoice total</span>
            <span className="tabular-nums">{formatINR(invoiceTotal)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5">
            <span className="text-muted-foreground">TDS %</span>
            <Input
              type="number"
              step="0.01"
              className="h-7 w-24 bg-white text-right"
              placeholder="0"
              title="Withheld by the customer on the invoice total. Filled in from the customer master; the slab on that master decides how much actually applies."
              value={header.tds_pct ?? ''}
              onChange={(e) => setHeaderField('tds_pct', e.target.value)}
            />
          </div>
          {Number(header.tds_pct) > 0 && (
            <>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">
                  TDS
                  {tds.belowSlab && (
                    <span className="ml-1 text-[11px]">— under the ₹{formatNum(tds.threshold)} slab, nothing withheld</span>
                  )}
                </span>
                <span className="tabular-nums">{formatINR(tds.amount)}</span>
              </div>
              <div className="flex items-center justify-between border-t pt-1 font-semibold text-[#1a2c56]">
                <span>Net receivable</span>
                <span className="tabular-nums">{formatINR(invoiceTotal - tds.amount)}</span>
              </div>
            </>
          )}
          </div>
        </div>

        <Dialog open={!!excess} onOpenChange={(o) => !o && setExcess(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="text-amber-900">More than the bargain has left</DialogTitle>
            </DialogHeader>
            {excess && (() => {
              const it = items[excess.idx] || {}
              const cur = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
              // Other open bargains of the same customer + product that can take it.
              const nextBargains = bargains.filter(
                (b) =>
                  String(b.id) !== String(it.sales_bargain_id) &&
                  String(b.product_id) === String(it.product_id) &&
                  matchesCustomer(b) &&
                  notExpired(b) &&
                  bargainRoom(String(b.id), -1, items) >= excess.qty - 1e-6
              )
              return (
                <div className="space-y-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  <p>
                    Item {excess.idx + 1} sells <b>{formatNum(calc(it).effQty)} {excess.uom}</b> but{' '}
                    <b>{cur?.bargain_no || 'this bargain'}</b> has only{' '}
                    <b>{formatNum(excess.balance)} {excess.uom}</b> left. Choose where the extra{' '}
                    <b>{formatNum(excess.qty)} {excess.uom}</b> should go:
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
                      {cur?.bargain_no || 'This bargain'} will be increased by{' '}
                      <b>{formatNum(excess.qty)} {excess.uom}</b> (at its own rate) so the whole item stays on it. The
                      top-up is logged as an Addition on the bargain register.
                    </p>
                  ) : excess.mode === 'new' ? (
                    <>
                      <p className="text-[11px]">
                        The item is split in two: <b>{formatNum(excess.balance)} {excess.uom}</b> stays on{' '}
                        {cur?.bargain_no || 'this bargain'} and a new bargain is created for{' '}
                        {String(header.customer || 'the customer')} carrying the extra{' '}
                        <b>{formatNum(excess.qty)} {excess.uom}</b>.
                      </p>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={excess.diffRate}
                          onCheckedChange={(v) => setExcess((p) => (p ? { ...p, diffRate: v } : p))}
                        />
                        <span>A different rate applies to the extra quantity</span>
                      </div>
                      {excess.diffRate && (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-amber-900">Rate for the extra qty (per {excess.uom})</Label>
                          <Input
                            type="number"
                            className="bg-white"
                            value={excess.rate}
                            onChange={(e) => setExcess((p) => (p ? { ...p, rate: e.target.value } : p))}
                          />
                          <p className="text-[11px]">The new line is invoiced at this rate.</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-amber-900">Next bargain for the extra qty</Label>
                      {nextBargains.length === 0 ? (
                        <p className="text-[11px]">
                          No other open bargain for {String(header.customer || 'this customer')} has{' '}
                          {formatNum(excess.qty)} {excess.uom} free — book it as a new bargain, or add it to this one.
                        </p>
                      ) : (
                        <>
                          <Select
                            value={excess.targetBargainId}
                            onValueChange={(v) => setExcess((p) => (p ? { ...p, targetBargainId: v } : p))}
                          >
                            <SelectTrigger className="bg-white"><SelectValue placeholder="Select bargain" /></SelectTrigger>
                            <SelectContent>
                              {nextBargains
                                .slice()
                                .sort((a, b) => String(a.bargain_date || '').localeCompare(String(b.bargain_date || '')))
                                .map((b) => (
                                  <SelectItem key={b.id} value={String(b.id)}>
                                    {b.bargain_no} · BAL {formatNum(bargainRoom(String(b.id), -1, items))} · {formatINR(b.rate)}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[11px]">
                            The item is split in two and the extra line keeps the rate you typed — the chosen bargain&apos;s
                            own rate is not applied, so change it on the line if it should differ.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            <DialogFooter>
              <Button variant="outline" onClick={() => setExcess(null)} disabled={excessBusy}>Cancel</Button>
              <Button onClick={() => void resolveExcess()} disabled={excessBusy}>
                {excessBusy
                  ? 'Saving…'
                  : excess?.mode === 'expand'
                    ? 'Top up & save'
                    : excess?.mode === 'existing'
                      ? 'Allocate & save'
                      : 'Add bargain & save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex items-center justify-end gap-2 rounded-b-md border-t border-[#d9d2b8] bg-[#f1ecd9] px-4 py-2.5">
          <span className="mr-auto text-[11px] text-muted-foreground">
            Ctrl+A accepts, like Tally — or use the button.
          </span>
          <Button variant="outline" className="bg-white" onClick={() => (onBack ? onBack() : setFormPage(false))} disabled={saving}>Cancel</Button>
          <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : editingGroup ? 'Save changes' : 'Accept invoice'}
          </Button>
        </div>
      </div>
      )}

      {/* Reject — the customer refused the consignment before it was fully delivered */}
      {/* Marking Unloaded: capture what the transporter actually delivered. */}
      <Dialog open={!!cancelInv} onOpenChange={(o) => !o && !cancelling && setCancelInv(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cancel delivery {cancelInv?.first.invoice_no || ''}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            The customer called this load off before it was unloaded, so there is no received quantity to record and
            the invoice is marked <b>Cancelled</b> rather than delivered. The transporter still carried it, so the
            freight is charged on the quantity below — the dispatched figure, which you can change if only part of the
            load actually travelled. Stock, the journal and the credit note are untouched, exactly as with a rejection.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason</Label>
            <Input
              autoFocus
              placeholder="e.g. customer cancelled the order while in transit"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_84px_96px] items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Product</span>
              <span className="text-right">Dispatched</span>
              <span className="text-right">Freight on</span>
            </div>
            {(cancelInv?.lines || []).map((l) => (
              <div key={String(l.id)} className="grid grid-cols-[minmax(0,1fr)_84px_96px] items-center gap-2 border-b px-3 py-1.5 last:border-0">
                <span className="min-w-0 truncate text-[13px]">{l.product_name}</span>
                <span className="text-right text-[12px] tabular-nums text-muted-foreground">{formatNum(l.qty)}</span>
                <Input
                  type="number"
                  className="h-8 text-right tabular-nums"
                  value={cancelQty[String(l.id)] ?? ''}
                  onChange={(e) => setCancelQty((p) => ({ ...p, [String(l.id)]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Freight will be billed on <b>{formatNum(cancelFreightQty)} {cancelInv?.first.uom || 'MT'}</b> in total.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelInv(null)} disabled={cancelling}>Keep the delivery</Button>
            <Button variant="destructive" onClick={() => void confirmCancel()} disabled={cancelling || !cancelReason.trim()}>
              {cancelling ? 'Cancelling…' : 'Cancel delivery'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!unloadInv} onOpenChange={(o) => !o && !unloadSaving && setUnloadInv(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Unload {unloadInv?.first.invoice_no || 'this invoice'}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            Enter the quantity the transporter actually delivered. It is recorded against the invoice, shown in its details,
            feeds the dispatch register, and prices the freight — so every line has to be filled in.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Unloaded date</Label>
            <div className="w-44"><DatePicker value={unloadDate} onChange={(v) => setUnloadDate(v || todayISO())} /></div>
          </div>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_84px_96px_76px] items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Product</span>
              <span className="text-right">Dispatched</span>
              <span className="text-right">Received</span>
              <span className="text-right">Shortage</span>
            </div>
            {(unloadInv?.lines || []).map((l) => {
              const raw = unloadQty[String(l.id)]
              const short = raw === '' || raw == null ? null : Number(l.qty) - Number(raw)
              return (
                <div key={String(l.id)} className="grid grid-cols-[minmax(0,1fr)_84px_96px_76px] items-center gap-2 border-b px-3 py-1.5 last:border-0">
                  <span className="min-w-0 truncate text-[13px]">{l.product_name}</span>
                  <span className="text-right text-[12px] tabular-nums text-muted-foreground">{formatNum(l.qty)}</span>
                  <Input
                    type="number"
                    className={cn('h-8 text-right tabular-nums', (raw ?? '') === '' && 'border-rose-400')}
                    placeholder="Required"
                    value={raw ?? ''}
                    onChange={(e) => setUnloadQty((p) => ({ ...p, [String(l.id)]: e.target.value }))}
                  />
                  <span
                    className={cn(
                      'text-right text-[12px] tabular-nums',
                      short != null && short > 0.0005 ? 'text-rose-600' : 'text-muted-foreground'
                    )}
                  >
                    {short == null ? '—' : formatNum(short)}
                  </span>
                </div>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnloadInv(null)} disabled={unloadSaving}>Cancel</Button>
            <Button
              onClick={() => void confirmUnload()}
              disabled={unloadSaving || (unloadInv?.lines || []).some((l) => (unloadQty[String(l.id)] ?? '') === '')}
              title={
                (unloadInv?.lines || []).some((l) => (unloadQty[String(l.id)] ?? '') === '')
                  ? 'Fill in the received qty on every line first'
                  : undefined
              }
            >
              {unloadSaving ? 'Saving…' : 'Mark unloaded'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectInv} onOpenChange={(o) => !o && !rejecting && setRejectInv(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject {rejectInv?.first.invoice_no || 'this invoice'}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            Marks this invoice Rejected — it drops out of the Gate Out picker and the "Produce more" demand calc but
            stays on record. This does not touch stock or the journal; if it needs correcting (e.g. a Credit Note),
            do that separately.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Reason <span className="text-red-600">*</span></Label>
            <textarea
              className="min-h-[5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="e.g. Customer refused the consignment — diverted to another party"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectInv(null)} disabled={rejecting}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => void saveReject()} disabled={rejecting}>
              {rejecting ? 'Saving…' : 'Reject invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Sales bargains tab ----------------

function SalesBargainsTab({ onOpenSale }: { onOpenSale?: (id: number) => void } = {}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [sales, setSales] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [packagings, setPackagings] = useState<Row[]>([])
  // Type classification tab (Finished Oil / Fatty / …), Loose / Packed section,
  // and whether to also show fully-settled (0-balance) bargains.
  const [sectionCategory, setSectionCategory] = useState<string>('ALL')
  const [sectionType, setSectionType] = useState<'LOOSE' | 'PACKED'>('LOOSE')
  const [showZero, setShowZero] = useState(false)
  const [search, setSearch] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [expandedBg, setExpandedBg] = useState<Set<number>>(new Set())
  // Period register range — defaults to the current month. Opening / Addition /
  // Dispatch / Balance are computed relative to this range.
  const [dateFrom, setDateFrom] = useState(monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  const F = dateFrom || '0000-01-01'
  const T = dateTo || todayISO()
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'salesBargains')) { setDateFrom(globalRange.from); setDateTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // add/remove balance qty
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{ mode: 'add' | 'remove'; amount: string; note: string; date: string }>({
    mode: 'add',
    amount: '',
    note: '',
    date: todayISO()
  })
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  // Sales bargains are general: the balance already counts every company's
  // dispatch, so the register reads as ONE book by default (empty = all) and
  // the invoice list underneath has to span the same companies. Picking one
  // narrows both together.
  const [companies, setCompanies] = useState<Row[]>([])
  const [coIds, setCoIds] = useState<number[]>([])
  // The credit-note lines behind each bargain's Return figure.
  const [returns, setReturns] = useState<Row[]>([])
  // The Category master, so an inactive category drops out of these dropdowns.
  const { rows: catRows } = useCategories([], 'sales')
  const saleCats = useMemo(
    () => saleCatsFrom(catRows, rows.map((r) => r.sale_category)),
    [catRows, rows]
  )
  // listSales defaults to the ACTIVE company when given nothing, so "all" has
  // to be spelled out as every id. Known only after the first load; until then
  // the active company's invoices show, and the list fills in on the refresh.
  // Keyed off a string, not the array — every load hands back a fresh array,
  // and a fresh identity in load's deps would re-trigger load forever.
  const companyKey = companies
    .map((c) => Number(c.id))
    .sort((a, b) => a - b)
    .join(',')
  const companyAll = useMemo(
    () => (companyKey ? companyKey.split(',').map(Number) : []),
    [companyKey]
  )

  const load = useCallback(async () => {
    const sel = coIds.length ? coIds : undefined
    const [b, s, pr, cu, pk, cos, ret] = await Promise.all([
      window.api.salesBargains.list(F, T, sel),
      window.api.sales.list(sel ?? companyAll),
      window.api.data.list('products'),
      window.api.data.list('customers'),
      window.api.data.list('packagings'),
      window.api.company.list().catch(() => [] as Row[]),
      window.api.salesBargains.returns(sel).catch(() => [] as Row[])
    ])
    setRows(b)
    setSales(s)
    setCompanies(cos)
    setReturns(ret)
    // All active products (not just finished) so byproducts — fatty, scrap,
    // spent earth, misc — can be sold under their sale-type bargains too.
    setProducts(pr.filter((x) => x.active))
    setCustomers(cu.filter((x) => x.active))
    setPackagings(pk.filter((x) => x.active))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [F, T, coIds, companyKey])

  // Same rule as the Sales invoice form: a bargain is a manufacturing rate
  // contract, so Trading customers are left out — but the bargain's own
  // customer stays listed so an existing one still opens and edits.
  const bargainCustomers = useMemo(
    () =>
      customers.filter(
        (c) => isManufacturingParty(c) || String(c.id) === String(form.customer_id || '')
      ),
    [customers, form.customer_id]
  )

  const returnsByBargain = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const r of returns) {
      const id = Number(r.bargain_id)
      if (!id) continue
      if (!m.has(id)) m.set(id, [])
      m.get(id)!.push(r)
    }
    return m
  }, [returns])

  // Dispatches (sales) grouped by the bargain they drew down, for the expand row.
  const dispatchesByBargain = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const s of sales) {
      const bid = Number(s.sales_bargain_id)
      if (!bid) continue
      if (!m.has(bid)) m.set(bid, [])
      m.get(bid)!.push(s)
    }
    for (const arr of m.values()) arr.sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)))
    return m
  }, [sales])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  function toggleGroup(name: string): void {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleBg(id: number): void {
    setExpandedBg((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const q = search.trim().toLowerCase()
  const visibleRows = rows.filter(
    (r) =>
      (sectionCategory === 'ALL' || String(r.sale_category || 'FINISHED_OIL') === sectionCategory) &&
      (String(r.sale_type || 'LOOSE') === 'PACKED' ? 'PACKED' : 'LOOSE') === sectionType &&
      inRegister(r, F, T, showZero) &&
      (!q ||
        [r.bargain_no, r.customer, r.product_name, r.note].some((f) =>
          String(f || '').toLowerCase().includes(q)
        ))
  )
  const sortedRows = useMemo(
    () =>
      [...visibleRows].sort(
        (a, b) =>
          String(a.customer || '').localeCompare(String(b.customer || '')) ||
          String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
      ),
    [visibleRows]
  )

  const groupStats = useMemo(() => {
    const m = new Map<string, { count: number; opening: number; addition: number; adjusted: number; dispatch: number; ret: number; closing: number; uom: string }>()
    for (const r of visibleRows) {
      const k = String(r.customer || '—')
      if (!m.has(k)) m.set(k, { count: 0, opening: 0, addition: 0, adjusted: 0, dispatch: 0, ret: 0, closing: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      const reg = bargainRegister(r, F, T)
      g.count += 1
      g.opening += reg.opening
      g.addition += reg.addition
      g.adjusted += reg.adjusted
      g.dispatch += reg.dispatch
      g.ret += reg.ret
      g.closing += reg.closing
    }
    return m
  }, [visibleRows, F, T])

  const grand = useMemo(() => {
    let count = 0, opening = 0, addition = 0, adjusted = 0, dispatch = 0, ret = 0, closing = 0
    for (const g of groupStats.values()) {
      count += g.count
      opening += g.opening
      addition += g.addition
      adjusted += g.adjusted
      dispatch += g.dispatch
      ret += g.ret
      closing += g.closing
    }
    return { count, opening, addition, adjusted, dispatch, ret, closing }
  }, [groupStats])

  function blank(): Row {
    return {
      bargain_date: todayISO(),
      customer: '',
      customer_id: '',
      product_id: '',
      qty: '',
      uom: 'MT',
      rate: '',
      gst_pct: '',
      gst_type: 'CGST_SGST',
      rate_expiry_date: '',
      note: '',
      sale_type: 'LOOSE',
      sale_category: sectionCategory === 'ALL' ? 'FINISHED_OIL' : sectionCategory,
      packaging_id: '',
      freight_term: 'FREIGHT_ON_GOODS',
      manual_bargain_no: ''
    }
  }
  function openAdd(): void {
    setEditing(null)
    setForm(blank())
    setError(null)
    setOpen(true)
  }
  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      bargain_date: row.bargain_date ?? todayISO(),
      customer: row.customer ?? '',
      customer_id: row.customer_id ? String(row.customer_id) : '',
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      uom: row.uom ?? 'MT',
      rate: row.rate ?? '',
      gst_pct: row.gst_pct ?? '',
      gst_type: row.gst_type ?? 'CGST_SGST',
      rate_expiry_date: row.rate_expiry_date ?? '',
      note: row.note ?? '',
      sale_type: row.sale_type ?? 'LOOSE',
      sale_category: row.sale_category ?? 'FINISHED_OIL',
      packaging_id: row.packaging_id ? String(row.packaging_id) : '',
      freight_term: row.freight_term ?? 'FREIGHT_ON_GOODS',
      manual_bargain_no: row.manual_bargain_no ?? ''
    })
    setError(null)
    setOpen(true)
  }
  function setField(key: string, value: unknown): void {
    setForm((p) => ({ ...p, [key]: value }))
  }

  // How much of the bargain being edited is already sold — locks customer/product
  // and floors the quantity.
  const editSold = editing ? Math.max(0, (Number(editing.qty) || 0) - (Number(editing.balance_qty) || 0)) : 0
  const editLocked = editSold > 1e-4

  async function save(): Promise<void> {
    if (!form.customer || !String(form.customer).trim()) return setError('Customer is required')
    if (!form.product_id) return setError('Select a product')
    if (!form.qty || Number(form.qty) <= 0) return setError('Quantity must be greater than 0')
    if (!form.rate || Number(form.rate) <= 0) return setError('Rate must be greater than 0')
    if (editLocked && Number(form.qty) < editSold - 1e-4) {
      return setError(`Quantity cannot be below the ${formatNum(editSold)} already sold`)
    }
    setSaving(true)
    setError(null)
    try {
      const payload = { ...form, product_id: Number(form.product_id) }
      if (editing) await window.api.salesBargains.update(editing.id as number, payload)
      else await window.api.salesBargains.create(payload)
      toast.success('Sales bargain saved')
      setOpen(false)
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete sales bargain ${row.bargain_no}?`)) return
    try {
      await window.api.salesBargains.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // Flatten the expandable second level for Excel: each bargain followed by the
  // dispatches booked against it. Bargains with none still get their row.
  function dispatchDetailRows(): Row[] {
    const out: Row[] = []
    for (const b of sortedRows) {
      const reg = bargainRegister(b, F, T)
      out.push({
        bargain_no: b.bargain_no || '',
        bargain_date: formatDate(b.bargain_date),
        customer: b.customer || '',
        product: b.product_name || '',
        rate: Number(b.rate) || 0,
        // The parent row states the bargain's period register, so the grouped
        // sheet reads on its own without cross-checking the summary tab.
        opening: reg.opening,
        addition: reg.addition,
        adjusted: reg.adjusted,
        balance: reg.closing,
        qty: reg.dispatch,
        ret: reg.ret
      })
      // One row per invoice, same as the on-screen drilldown — a split
      // invoice's lines are summed rather than listed separately, with a
      // qty-weighted average sale rate.
      const byInvoice = new Map<string, { invoice_no: string; sale_date: string; sample: Row; qty: number; taxable: number; total: number }>()
      for (const d of dispatchesByBargain.get(Number(b.id)) || []) {
        const key = String(d.invoice_group || d.invoice_no || d.id)
        if (!byInvoice.has(key)) {
          byInvoice.set(key, { invoice_no: d.invoice_no, sale_date: d.sale_date, sample: d, qty: 0, taxable: 0, total: 0 })
        }
        const g = byInvoice.get(key)!
        g.qty += Number(d.qty) || 0
        g.taxable += Number(d.amount) || 0
        g.total += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
      }
      for (const rl of returnsByBargain.get(Number(b.id)) || []) {
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          customer: '',
          product: String(rl.product_name || ''),
          rate: Number(rl.rate) || 0,
          invoice_no: `${String(rl.note_no || 'CN')} (return)`,
          company_name: String(rl.company_name || ''),
          sale_date: formatDate(rl.note_date),
          stage: rl.explicit_bargain_id ? 'return — named on note' : `return vs ${String(rl.against_ref || '—')}`,
          ret: Number(rl.qty) || 0,
          sale_rate: Number(rl.rate) || 0,
          amount: -(Number(rl.amount_incl ?? rl.amount) || 0)
        })
      }
      for (const g of byInvoice.values()) {
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          customer: '',
          product: '',
          rate: Number(b.rate) || 0,
          invoice_no: g.invoice_no || '—',
          company_name: String(g.sample.company_name || ''),
          sale_date: formatDate(g.sale_date),
          stage: String(g.sample.stage || g.sample.status || ''),
          qty: g.qty,
          sale_rate: g.qty > 0 ? g.taxable / g.qty : 0,
          amount: g.total
        })
      }
    }
    return out
  }

  // --- SKU rate card for one sales bargain ----------------------------------
  const [rateRow, setRateRow] = useState<Row | null>(null)
  const [rateRows, setRateRows] = useState<Row[]>([])
  const [rateBusy, setRateBusy] = useState(false)
  const rateFile = useRef<HTMLInputElement | null>(null)

  async function openRates(row: Row): Promise<void> {
    setRateRow(row)
    setRateRows([])
    try {
      setRateRows(await window.api.skuRates.list(Number(row.id)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function downloadRateCard(): Promise<void> {
    if (!rateRow) return
    try {
      await downloadSkuRateExcel(rateRows, {
        bargainNo: String(rateRow.bargain_no || ''),
        qty: Number(rateRow.qty) || 0,
        uom: String(rateRow.uom || 'MT'),
        customer: String(rateRow.customer || '')
      })
      toast.success('Rate card downloaded — only the rate columns are editable')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function uploadRateCard(file: File): Promise<void> {
    if (!rateRow) return
    setRateBusy(true)
    try {
      const parsed = await parseSkuRateExcel(file)
      if (!parsed.rows.length) {
        toast.error('No SKU rows found — use the downloaded rate card')
        return
      }
      // The card carries the bargain it was generated for, so one bargain's
      // rates cannot be uploaded onto another by mistake.
      const want = String(rateRow.bargain_no || '').trim()
      if (parsed.bargainNo && want && parsed.bargainNo !== want) {
        toast.error(`That card belongs to bargain ${parsed.bargainNo}, not ${want}`)
        return
      }
      const res = await window.api.skuRates.save(Number(rateRow.id), parsed.rows)
      setRateRows(await window.api.skuRates.list(Number(rateRow.id)))
      toast.success(
        `${res.saved} SKU rate${res.saved === 1 ? '' : 's'} saved` +
          (res.cleared ? `, ${res.cleared} cleared` : '')
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRateBusy(false)
      if (rateFile.current) rateFile.current.value = ''
    }
  }

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    setAdjustForm({ mode: 'add', amount: '', note: '', date: todayISO() })
    setAdjustError(null)
  }
  async function saveAdjust(): Promise<void> {
    if (!adjustRow) return
    const amt = Number(adjustForm.amount)
    if (!amt || amt <= 0) {
      setAdjustError('Enter a quantity greater than zero')
      return
    }
    const delta = adjustForm.mode === 'add' ? amt : -amt
    setAdjustSaving(true)
    setAdjustError(null)
    try {
      await window.api.salesBargains.adjust(Number(adjustRow.id), delta, adjustForm.note || undefined, adjustForm.date || undefined)
      toast.success(
        adjustForm.mode === 'add'
          ? `Added ${amt} ${adjustRow.uom || 'MT'} to ${adjustRow.bargain_no}`
          : `Removed ${amt} ${adjustRow.uom || 'MT'} from ${adjustRow.bargain_no}`
      )
      setAdjustRow(null)
      await load()
    } catch (e) {
      setAdjustError(errText(e))
    } finally {
      setAdjustSaving(false)
    }
  }

  const rateCard = (
    <Dialog open={!!rateRow} onOpenChange={(o) => !o && setRateRow(null)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>SKU rates — {rateRow?.bargain_no}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Download the card, fill the rate per case or per MT for each SKU, and upload it back. Whichever rate you
            leave blank is worked out from MT per case. These rates are then offered on a sale line booked against this
            bargain.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={rateFile}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadRateCard(f)
              }}
            />
            <Button variant="outline" size="sm" onClick={downloadRateCard} disabled={!rateRows.length}>
              <Download className="h-4 w-4" /> Download rate card
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => rateFile.current?.click()}
              disabled={rateBusy}
            >
              <Upload className="h-4 w-4" /> {rateBusy ? 'Uploading…' : 'Upload filled card'}
            </Button>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {rateRows.filter((r) => r.rate_per_case != null || r.rate_per_mt != null).length} of {rateRows.length}{' '}
              SKUs priced
            </span>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-muted/70">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-semibold">SKU</th>
                  <th className="px-3 py-1.5 text-right font-semibold">MT / case</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Rate / case</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Rate / MT</th>
                </tr>
              </thead>
              <tbody>
                {rateRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                      No packed SKUs for this bargain&apos;s product. Add them under Masters → Packed SKU.
                    </td>
                  </tr>
                ) : (
                  rateRows.map((r, i) => {
                    const priced = r.rate_per_case != null || r.rate_per_mt != null
                    return (
                      <tr
                        key={String(r.packaging_id)}
                        className={cn('border-b last:border-0', i % 2 === 1 && 'bg-muted/30', priced && 'bg-emerald-50/60')}
                      >
                        <td className="px-3 py-1.5 font-medium">{r.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {caseMT(r).toFixed(5)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                          {r.rate_per_case != null ? formatINR(r.rate_per_case) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {r.rate_per_mt != null ? formatINR(r.rate_per_mt) : '—'}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRateRow(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return (
    <div>
      {rateCard}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-2">
      <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
        {[{ v: 'ALL', label: 'All' }, ...saleCats].map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => setSectionCategory(t.v)}
            className={cn(
              'whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
              sectionCategory === t.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
        <div className="inline-flex rounded-lg border p-0.5">
          {(['LOOSE', 'PACKED'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSectionType(t)}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                sectionType === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t === 'LOOSE' ? 'Loose' : 'Packed'}
            </button>
          ))}
        </div>
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] text-muted-foreground">
          <Switch checked={showZero} onCheckedChange={setShowZero} />
          Show settled (0 balance)
        </label>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="relative min-w-[180px] flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-8 pl-8 text-[12px]"
            placeholder="Search bargain no, customer, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="shrink-0 text-muted-foreground">Date</span>
          <FyPicker from={dateFrom} to={dateTo} onRange={(f, t) => { setDateFrom(f); setDateTo(t) }} className="h-8 w-36 shrink-0 text-[11px]" />
          <DatePicker value={dateFrom} onChange={(v) => setDateFrom(v || '')} max={dateTo || undefined} className="h-8 w-40 shrink-0 text-[11px]" />
          <span className="shrink-0 text-muted-foreground">to</span>
          <DatePicker value={dateTo} onChange={(v) => setDateTo(v || '')} min={dateFrom || undefined} className="h-8 w-40 shrink-0 text-[11px]" />
          {(dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear</Button>
          )}
        </div>
        {companies.length > 1 && (
          <Select
            value={coIds.length === 1 ? String(coIds[0]) : 'all'}
            onValueChange={(v) => setCoIds(v === 'all' ? [] : [Number(v)])}
          >
            <SelectTrigger className="h-8 w-[12rem] shrink-0 text-[12px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all" className="text-[12px]">All companies</SelectItem>
              {companies.map((c) => (
                <SelectItem key={String(c.id)} value={String(c.id)} className="text-[12px]">
                  {String(c.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ExcelButton
            filename={`sales-bargains-${todayISO()}`}
            sheetName="Sales bargains"
            title="Sales bargains"
            columns={[
              { header: 'Bargain no', key: 'bargain_no', value: (r) => r.bargain_no || '' },
              { header: 'Manual no', key: 'manual_bargain_no', value: (r) => r.manual_bargain_no || '' },
              { header: 'Date', key: 'date', value: (r) => formatDate(r.bargain_date) },
              { header: 'Type', key: 'sale_category', value: (r) => saleCatLabel(r.sale_category) },
              { header: 'Customer', key: 'customer', value: (r) => r.customer || '' },
              { header: 'Product', key: 'product', value: (r) => r.product_name || '' },
              ...(companies.length > 1
                ? [{ header: 'Company', key: 'company_name', value: (r: Row) => String(r.company_name || '') }]
                : []),
              { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).opening },
              { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).addition },
              { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).adjusted },
              { header: 'Rate', key: 'rate', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.rate) || 0 },
              { header: 'Dispatch', key: 'dispatch', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).dispatch },
              { header: 'Return', key: 'ret', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).ret },
              { header: 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).closing }
            ]}
            rows={sortedRows}
            extraSheets={[
              {
                sheetName: 'Dispatches',
                title: 'Sales bargains — dispatch detail',
                columns: [
                  { header: 'Bargain no', key: 'bargain_no' },
                  { header: 'BG date', key: 'bargain_date' },
                  { header: 'Customer', key: 'customer' },
                  { header: 'Product', key: 'product' },
                  { header: 'BG rate', key: 'rate', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Invoice', key: 'invoice_no' },
                  { header: 'Company', key: 'company_name' },
                  { header: 'Dispatched on', key: 'sale_date' },
                  { header: 'Stage', key: 'stage' },
                  { header: 'Dis qty', key: 'qty', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Return', key: 'ret', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Sale rate', key: 'sale_rate', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Value incl. GST', key: 'amount', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000' }
                ],
                rows: dispatchDetailRows(),
                isGroup: (r) => !r.invoice_no,
                outlineDetail: true
              }
            ]}
          />
          <Button size="sm" onClick={openAdd} disabled={products.length === 0}>
            <Plus className="h-4 w-4" /> New sales bargain
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Table wrapperClassName="rounded-lg" className="min-w-[1180px] text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>Bargain no</TableHead>
              <TableHead>Manual no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Addition</TableHead>
              <TableHead className="text-right">Adjusted</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Dispatch</TableHead>
              <TableHead className="text-right">Return</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="w-[110px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                  {rows.length === 0 ? 'No sales bargains yet.' : 'No sales bargains in this period.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                <TableRow className="border-y-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell colSpan={4} className="py-2 text-xs font-bold uppercase tracking-wide text-amber-900">
                    Grand total
                    <span className="ml-1 font-medium normal-case tracking-normal text-amber-700">
                      · {grand.count} bargain{grand.count === 1 ? '' : 's'}
                    </span>
                  </TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.opening)}</TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.addition)}</TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.adjusted)}</TableCell>
                  <TableCell className="py-2" />
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.dispatch)}</TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-emerald-800">
                    {grand.ret > 0.0005 ? formatNum(grand.ret) : '0'}
                  </TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.closing)} MT</TableCell>
                  <TableCell className="py-2" />
                </TableRow>
                {sortedRows.map((row, i) => {
                  const grp = String(row.customer || '—')
                  const newGroup = i === 0 || grp !== String(sortedRows[i - 1].customer || '—')
                  const isCollapsed = !q && !openGroups.has(grp)
                  const g = groupStats.get(grp)
                  // Serial number within the customer group (1-based).
                  const seq = sortedRows.slice(0, i + 1).filter((r) => String(r.customer || '—') === grp).length
                  const bgOpen = expandedBg.has(Number(row.id))
                  return (
                    <Fragment key={row.id as number}>
                      {newGroup && (
                        <TableRow
                          className="cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70"
                          onClick={() => toggleGroup(grp)}
                        >
                          <TableCell colSpan={4} className="py-1.5">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700">
                              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              {grp}
                              <span className="font-medium normal-case tracking-normal text-slate-500">
                                · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.opening ?? 0)}</TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.addition ?? 0)}</TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.adjusted ?? 0)}</TableCell>
                          <TableCell className="py-1.5" />
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.dispatch ?? 0)}</TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-emerald-800">
                            {(g?.ret ?? 0) > 0.0005 ? formatNum(g?.ret ?? 0) : '0'}
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.closing ?? 0)} {g?.uom || 'MT'}</TableCell>
                          <TableCell className="py-1.5" />
                        </TableRow>
                      )}
                      {!isCollapsed && (() => {
                        const reg = bargainRegister(row, F, T)
                        return (
                        <TableRow className={cn('cursor-pointer', bgOpen && 'bg-slate-100 hover:bg-slate-100')} onClick={() => toggleBg(Number(row.id))}>
                          <TableCell className="font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {bgOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                              <span className="tabular-nums text-muted-foreground">{seq}.</span>
                              {row.bargain_no}
                              {rateExpired(row) && Number(row.balance_qty) > 0 && (
                                <span
                                  className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                                  title={`The rate expired on ${formatDate(row.rate_expiry_date)} — it is still offered on a sale, marked as expired`}
                                >
                                  Rate expired
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{row.manual_bargain_no || '—'}</TableCell>
                          <TableCell>{formatDate(row.bargain_date)}</TableCell>
                          <TableCell>{row.product_name || '—'}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{reg.opening ? formatNum(reg.opening) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{reg.addition ? formatNum(reg.addition) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span className={reg.adjusted < -1e-9 ? 'text-red-600' : reg.adjusted > 0 ? 'text-emerald-700' : ''}>
                              {reg.adjusted ? formatNum(reg.adjusted) : '—'}
                            </span>
                            {Math.abs(reg.futureAdjusted) > 1e-9 && (
                              <span
                                className="ml-1 text-[10px] font-medium text-amber-600"
                                title={`Adjustment of ${formatNum(reg.futureAdjusted)} dated after ${formatDate(T)} — widen the date range to include it`}
                              >
                                ({reg.futureAdjusted > 0 ? '+' : ''}{formatNum(reg.futureAdjusted)} later)
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(row.rate)}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', reg.dispatch && 'font-bold text-red-600')}>{reg.dispatch ? formatNum(reg.dispatch) : '—'}</TableCell>
                          <TableCell
                            className={cn('text-right tabular-nums', reg.ret && 'font-bold text-emerald-700')}
                            title={reg.ret ? 'Came back on a customer credit note — added back to the balance' : undefined}
                          >
                            {reg.ret ? formatNum(reg.ret) : '—'}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            <span className={reg.closing < -1e-9 ? 'text-red-600' : ''}>{formatNum(reg.closing)}</span>
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end">
                              <RowActions
                                actions={[
                                  { label: 'SKU rate card', icon: Tags, onClick: () => void openRates(row) },
                                  { label: 'Add / remove balance qty', icon: SlidersHorizontal, onClick: () => openAdjust(row) },
                                  { label: 'Edit bargain', icon: Pencil, onClick: () => openEdit(row) },
                                  { label: 'Delete bargain', icon: Trash2, danger: true, onClick: () => del(row) }
                                ]}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                        )
                      })()}
                      {!isCollapsed && bgOpen && (
                        <TableRow className="bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={12} className="p-0">
                            {(() => {
                              const disp = dispatchesByBargain.get(Number(row.id)) || []
                              const tot = disp.reduce(
                                (s, d) => {
                                  s.qty += Number(d.qty) || 0
                                  s.amount += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
                                  return s
                                },
                                { qty: 0, amount: 0 }
                              )
                              // One row per invoice — a split invoice draws the
                              // bargain down over several lines, which used to
                              // show as that many rows here. Qty and amount sum
                              // across the invoice's lines; rate is the
                              // qty-weighted average (taxable amount / qty), not
                              // just the first line's rate.
                              const byInvoice = new Map<string, { id: number; invoice_no: string; sale_date: string; sample: Row; qty: number; taxable: number; total: number }>()
                              for (const d of disp) {
                                const key = String(d.invoice_group || d.invoice_no || d.id)
                                if (!byInvoice.has(key)) {
                                  byInvoice.set(key, { id: Number(d.id), invoice_no: d.invoice_no, sale_date: d.sale_date, sample: d, qty: 0, taxable: 0, total: 0 })
                                }
                                const g = byInvoice.get(key)!
                                g.qty += Number(d.qty) || 0
                                g.taxable += Number(d.amount) || 0
                                g.total += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
                              }
                              const retLines = returnsByBargain.get(Number(row.id)) || []
                              // Dispatches and returns are the same story told in
                              // date order, so they share one table: a return is a
                              // negative line, and the total is what the bargain
                              // actually kept rather than the gross it shipped.
                              type Line = {
                                key: string
                                id: number
                                kind: 'out' | 'ret'
                                label: string
                                sub: string
                                date: string
                                qty: number
                                rate: number
                                amount: number
                                uom: string
                              }
                              const lines: Line[] = [
                                ...Array.from(byInvoice.values()).map((g): Line => ({
                                  key: `d${g.id}`,
                                  id: g.id,
                                  kind: 'out',
                                  label: String(g.invoice_no || '—'),
                                  sub: stageInfo(g.sample).label,
                                  date: String(g.sale_date || ''),
                                  qty: g.qty,
                                  rate: g.qty > 0 ? g.taxable / g.qty : 0,
                                  amount: g.total,
                                  uom: String(g.sample.uom || row.uom || 'MT')
                                })),
                                ...retLines.map((rl, ri): Line => ({
                                  key: `r${rl.note_id}-${ri}`,
                                  id: 0,
                                  kind: 'ret',
                                  label: String(rl.note_no || 'CN'),
                                  sub: rl.explicit_bargain_id
                                    ? 'Return · named on the note'
                                    : `Return vs ${String(rl.against_ref || '—')}`,
                                  date: String(rl.note_date || ''),
                                  qty: -(Number(rl.qty) || 0),
                                  rate: Number(rl.rate) || 0,
                                  // Inclusive of GST, matching the dispatch rows
                                  // this column already states that way.
                                  amount: -(Number(rl.amount_incl ?? rl.amount) || 0),
                                  uom: String(row.uom || 'MT')
                                }))
                              ].sort((x, y) => x.date.localeCompare(y.date) || x.key.localeCompare(y.key))
                              const net = lines.reduce(
                                (acc, l) => {
                                  acc.qty += l.qty
                                  acc.amount += l.amount
                                  if (l.kind === 'ret') acc.ret += -l.qty
                                  else acc.out += l.qty
                                  return acc
                                },
                                { qty: 0, amount: 0, out: 0, ret: 0 }
                              )
                              return (
                                <div className="bg-muted/20 px-6 py-3">
                                  {row.note && <p className="pb-2 text-xs text-muted-foreground"><span className="font-semibold">Note:</span> {row.note}</p>}
                                  {lines.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">No dispatches on this bargain yet.</p>
                                  ) : (
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b text-left text-muted-foreground">
                                          <th className="w-8 py-1.5 pr-3 font-semibold">#</th>
                                          <th className="py-1.5 pr-3 font-semibold">Invoice / Note</th>
                                          <th className="py-1.5 pr-3 font-semibold">Date</th>
                                          <th className="py-1.5 pr-3 font-semibold">Stage</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Qty</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                                          <th className="py-1.5 text-right font-semibold">Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {lines.map((l, di) => {
                                          const isRet = l.kind === 'ret'
                                          return (
                                            <tr
                                              key={l.key}
                                              className={cn(
                                                'border-b last:border-0',
                                                isRet && 'bg-emerald-50/60',
                                                !isRet && onOpenSale && 'cursor-pointer hover:bg-muted/40'
                                              )}
                                              title={isRet ? 'Returned on a credit note — added back to the balance' : onOpenSale ? 'Open this sale invoice' : undefined}
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                if (!isRet) onOpenSale?.(l.id)
                                              }}
                                            >
                                              <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{di + 1}</td>
                                              <td className="py-1.5 pr-3 font-medium">
                                                <span className="inline-flex items-center gap-1.5">
                                                  {l.label}
                                                  {isRet && (
                                                    <span className="rounded bg-emerald-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-800">
                                                      return
                                                    </span>
                                                  )}
                                                </span>
                                              </td>
                                              <td className="whitespace-nowrap py-1.5 pr-3">{formatDate(l.date)}</td>
                                              <td className={cn('py-1.5 pr-3', isRet && 'text-emerald-800')}>{l.sub}</td>
                                              <td
                                                className={cn(
                                                  'py-1.5 pr-3 text-right font-medium tabular-nums',
                                                  isRet ? 'text-emerald-700' : 'text-red-600'
                                                )}
                                              >
                                                {isRet ? '+' : ''}{formatNum(Math.abs(l.qty))} {l.uom}
                                              </td>
                                              <td className="py-1.5 pr-3 text-right tabular-nums">{formatINR(l.rate)}</td>
                                              <td className={cn('py-1.5 text-right tabular-nums', isRet && 'text-emerald-700')}>
                                                {isRet ? '−' : ''}{formatINR(Math.abs(l.amount))}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                        <tr className="border-t-2 font-semibold">
                                          <td className="py-1.5 pr-3" colSpan={4}>
                                            Net drawn
                                            {net.ret > 0.0005 && (
                                              <span className="ml-1.5 font-normal text-muted-foreground">
                                                · {formatNum(net.out)} dispatched less {formatNum(net.ret)} returned
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-red-600">{formatNum(net.qty)} {row.uom}</td>
                                          <td className="py-1.5" />
                                          <td className="py-1.5 text-right tabular-nums">{formatINR(net.amount)}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              )
                            })()}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.bargain_no}` : 'New sales bargain'}</DialogTitle>
          </DialogHeader>
          {editLocked && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {formatNum(editSold)} {editing?.uom || 'MT'} is already sold on this bargain — customer and product are locked, and the quantity can&apos;t go below {formatNum(editSold)}.
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Date</Label>
              <DatePicker value={form.bargain_date} onChange={(v) => setField('bargain_date', v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Customer *</Label>
              <Select
                value={form.customer_id ? String(form.customer_id) : (form.customer ? 'legacy' : '')}
                onValueChange={(v) => {
                  if (v === 'legacy') return
                  const cust = customers.find((c) => String(c.id) === v)
                  setForm((p) => ({
                    ...p,
                    customer_id: v,
                    customer: cust?.name ?? p.customer,
                    gst_pct: p.gst_pct || (cust && Number(cust.gst_pct) > 0 ? cust.gst_pct : p.gst_pct)
                  }))
                }}
                disabled={editLocked}
              >
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {!form.customer_id && form.customer && (
                    <SelectItem value="legacy">{String(form.customer)} (unlinked — re-select to link)</SelectItem>
                  )}
                  {bargainCustomers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={form.sale_category || 'FINISHED_OIL'} onValueChange={(v) => setField('sale_category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {saleCats.map((c) => <SelectItem key={c.v} value={c.v}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Product *</Label>
              <Select value={String(form.product_id)} onValueChange={(v) => setField('product_id', v)} disabled={editLocked}>
                <SelectTrigger><SelectValue placeholder="Product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Qty *</Label>
              <Input type="number" min={editLocked ? editSold : 0} value={form.qty ?? ''} onChange={(e) => setField('qty', e.target.value)} />
              {editLocked && Number(form.qty) < editSold - 1e-4 && (
                <span className="text-[11px] text-red-600">Cannot be below {formatNum(editSold)} already sold.</span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom || 'MT'} onChange={(v) => setField('uom', v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Rate *</Label>
              <Input type="number" value={form.rate ?? ''} onChange={(e) => setField('rate', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>GST %</Label>
              <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setField('gst_pct', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>GST type</Label>
              <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setField('gst_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                  <SelectItem value="IGST">IGST</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Rate expiry</Label>
              <DatePicker value={form.rate_expiry_date ?? ''} onChange={(v) => setField('rate_expiry_date', v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Manual bargain no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                value={form.manual_bargain_no ?? ''}
                onChange={(e) => setField('manual_bargain_no', e.target.value)}
                placeholder="e.g. the party's own reference"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Sale type</Label>
              <Select value={form.sale_type || 'LOOSE'} onValueChange={(v) => setField('sale_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                  <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Freight term</Label>
              <Select value={form.freight_term || 'FREIGHT_ON_GOODS'} onValueChange={(v) => setField('freight_term', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT_ON_GOODS">Ex (customer lifts)</SelectItem>
                  <SelectItem value="DLD">FOR (we deliver)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.sale_type === 'PACKED' && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Default packaging</Label>
                <Select value={form.packaging_id ? String(form.packaging_id) : ''} onValueChange={(v) => setField('packaging_id', v)}>
                  <SelectTrigger><SelectValue placeholder="Select packaging" /></SelectTrigger>
                  <SelectContent>
                    {packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>Note</Label>
              <Input value={form.note ?? ''} onChange={(e) => setField('note', e.target.value)} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Sale type and freight term default onto each dispatch under this bargain — you can still override them per sale.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!adjustRow} onOpenChange={(o) => !o && setAdjustRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust balance — {adjustRow?.bargain_no}</DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const qty = Number(adjustRow.qty) || 0
            // Rounded to the 3 decimals MT is tracked at — balance_qty is a
            // running total that can carry float residue past that (0.0019996
            // reading as "0.002"), which made squaring off to what the screen
            // already shows as the full balance look like an over-removal.
            const bal = Math.round((Number(adjustRow.balance_qty) || 0) * 1000) / 1000
            const sold = qty - bal
            const amt = Number(adjustForm.amount) || 0
            const delta = adjustForm.mode === 'add' ? amt : -amt
            const newBal = bal + delta
            const uom = adjustRow.uom || 'MT'
            return (
              <div className="grid gap-4">
                <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-3 text-center text-sm">
                  <div><div className="text-[11px] text-muted-foreground">Bargain qty</div><div className="font-semibold tabular-nums">{formatNum(qty)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Sold</div><div className="font-semibold tabular-nums">{formatNum(sold)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Balance</div><div className="font-semibold tabular-nums">{formatNum(bal)} {uom}</div></div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40')}>+ Add to balance</button>
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40')}>− Remove from balance</button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})</Label>
                  <Input type="number" autoFocus value={adjustForm.amount} onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={adjustForm.date} onChange={(v) => setAdjustForm((p) => ({ ...p, date: v || '' }))} />
                  <p className="text-xs text-muted-foreground">Shown under "Addition" for this date's month in the register.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Note (optional)</Label>
                  <Input value={adjustForm.note} onChange={(e) => setAdjustForm((p) => ({ ...p, note: e.target.value }))} placeholder="Reason for the adjustment" />
                </div>
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  New balance:{' '}
                  <span className={cn('font-semibold tabular-nums', newBal < -1e-9 && 'text-red-600')}>{formatNum(newBal)} {uom}</span>
                  {amt > 0 && adjustForm.mode === 'remove' && newBal < -1e-9 && (
                    <span className="ml-2 text-red-600">— more than the available balance</span>
                  )}
                </div>
                {adjustError && <p className="text-sm text-destructive">{adjustError}</p>}
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={adjustSaving}>Cancel</Button>
            <Button onClick={saveAdjust} disabled={adjustSaving}>{adjustSaving ? 'Saving…' : 'Apply'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- page ----------------

export function Sales({ focusId, onFocusHandled, onBack, backLabel }: { focusId?: number | null; onFocusHandled?: () => void; onBack?: () => void; backLabel?: string } = {}): React.JSX.Element {
  const [needs, setNeeds] = useState<Row[]>([])
  const [needsOpen, setNeedsOpen] = useState(false)
  const [salesAdd, setSalesAdd] = useState<{ open: () => void; canAdd: boolean; formOpen: boolean } | null>(null)
  const loadNeeds = useCallback(async () => {
    // Hidden for the unloading desk, so it is not fetched either.
    if (UNLOAD_DESK()) return
    setNeeds(await window.api.stock.needs())
  }, [])
  useEffect(() => {
    loadNeeds()
  }, [loadNeeds])
  useLiveRefresh(loadNeeds)

  const rawShort = needs.filter((n) => n.raw_short).length
  const totalProduce = needs.reduce((s, n) => s + (Number(n.shortfall) || 0), 0)
  const unloadOnly = UNLOAD_DESK()

  return (
    <>
      <PageHeader
        title={unloadOnly ? 'Unloading desk' : 'Sales'}
        subtitle={
          unloadOnly
            ? 'FOR deliveries still out — record the quantity received'
            : 'Finished-goods dispatches drawn against sales bargains'
        }
        hint={
          unloadOnly
            ? 'Each delivery listed here has left the factory and is not yet unloaded. Open one, enter what the transporter actually delivered on every line, and it is marked unloaded.'
            : 'Each dispatch draws down a sales bargain and reduces finished-goods stock. Short stock can be produced on the spot. Book the rate contracts under Sales Bargain.'
        }
        actions={
          salesAdd?.formOpen || unloadOnly ? undefined : (
            <>
              <Button
                size="sm"
                variant={needs.length === 0 ? 'outline' : rawShort > 0 ? 'destructive' : 'default'}
                onClick={() => setNeedsOpen(true)}
                className={cn(needs.length > 0 && rawShort > 0 && 'animate-pulse')}
              >
                <AlertTriangle className="h-4 w-4" />
                Production needs
                {needs.length > 0 && (
                  <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs font-bold">
                    {needs.length}
                  </span>
                )}
              </Button>
              <Button size="sm" onClick={() => salesAdd?.open()} disabled={!salesAdd?.canAdd}>
                <Plus className="h-4 w-4" /> New sale
              </Button>
            </>
          )
        }
      />
      <div className="px-4 py-4">
        <SalesTab focusId={focusId} onFocusHandled={onFocusHandled} onRegister={setSalesAdd} onBack={onBack} backLabel={backLabel} />
      </div>

      <Dialog open={needsOpen} onOpenChange={setNeedsOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Production needs — demand vs stock
            </DialogTitle>
          </DialogHeader>

          {needs.length === 0 ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 py-10 text-center text-sm font-medium text-emerald-800">
              All committed sales are covered by current finished-goods stock. Nothing to produce.
            </div>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-3 gap-3">
                <div className="rounded-lg border bg-card p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Products short</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">{needs.length}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total to produce</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">{formatNum(totalProduce)}</div>
                </div>
                <div className={cn('rounded-lg border p-3 text-center', rawShort > 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50')}>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Raw short</div>
                  <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', rawShort > 0 ? 'text-red-600' : 'text-emerald-700')}>{rawShort}</div>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border">
                <Table className="text-[13px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Committed</TableHead>
                      <TableHead className="text-right">In stock</TableHead>
                      <TableHead className="text-right">To produce</TableHead>
                      <TableHead className="text-right">Raw material</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {needs.map((nd) => (
                      <TableRow key={nd.id as number}>
                        <TableCell className="font-medium">{nd.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(nd.demand)}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', Number(nd.stock) < -1e-9 ? 'text-red-600' : 'text-muted-foreground')}>
                          {formatNum(nd.stock)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-700">{formatNum(nd.shortfall)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={nd.raw_short ? 'destructive' : 'warning'}>
                            {nd.raw_short ? 'Raw short — buy raw' : 'Raw available'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Committed = pending dispatches + remaining sales-bargain quantity. To produce = committed − stock. &ldquo;Raw
                short&rdquo; means even producing the shortfall, some formula input is below stock — buy raw first.
              </p>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function SalesBargains({ onOpenSale }: { onOpenSale?: (id: number) => void } = {}): React.JSX.Element {
  return (
    <>
      <PageHeader title="Sales Bargain" subtitle="Rate contracts with customers — drawn down as sales are dispatched" hint="Each sales bargain locks a rate and quantity with a customer; dispatches under Sales draw it down. The bargain number is FGCODE/DD-MM/CUSTOMER/SERIAL, resetting monthly." />
      <div className="px-4 py-4">
        <SalesBargainsTab onOpenSale={onOpenSale} />
      </div>
    </>
  )
}

