import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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
import { UomSelect } from '@/components/UomSelect'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { exportRowsToExcel } from '@/lib/excel'
import { Pagination, usePaged, PAGE_SIZE } from '@/components/Pagination'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

type SortState = { key: string; dir: 'asc' | 'desc' } | null

// Per-column sort accessors. Anything not listed here isn't sortable.
const SORT_ACCESSORS: Record<string, (r: Row) => string | number> = {
  bargain_no: (r) => String(r.bargain_no || ''),
  bargain_date: (r) => String(r.bargain_date || ''),
  supplier: (r) => String(r.supplier_name || ''),
  oil: (r) => String(r.oil_code || r.oil_name || ''),
  condition: (r) => String(r.bargain_type || ''),
  qty: (r) => Number(r._opening) || 0,
  addition: (r) => Number(r._addition) || 0,
  rate: (r) => Number(r.rate_per_uom) || 0,
  dispatch: (r) => Number(r._dispatch) || 0,
  balance: (r) => Number(r._closing) || 0,
  total: (r) => Number(r.total_amount) || 0
}

const oilOf = (r: Row): string => String(r.oil_code || r.oil_name || '—')

// Product categories (products.material_type), in display order.
const MATERIAL_TYPES = ['OIL', 'HUSK', 'PACKAGING', 'CHEMICAL', 'MISC']

// First day of the current month, YYYY-MM-DD.
function monthStartISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// Period register for a purchase bargain relative to [from,to]:
// opening (b/f) + addition (opened in period) − dispatch (received in period) = closing.
function bargainRegister(r: Row, from: string, to: string): { opening: number; addition: number; dispatch: number; closing: number } {
  const qty = Number(r.qty) || 0
  const before = Number(r.disp_before) || 0
  const inP = Number(r.disp_period) || 0
  const adjBefore = Number(r.adj_before) || 0
  const adjIn = Number(r.adj_in) || 0
  const adjAfter = Number(r.adj_after) || 0
  const bdate = String(r.bargain_date || '').slice(0, 10)
  const createdInRange = bdate >= from && bdate <= to
  const createdBefore = bdate < from
  // Original booked qty, stripped of every dated top-up (those are shown as Addition
  // in the month they were made, not folded into Opening).
  const baseQty = qty - adjBefore - adjIn - adjAfter
  // Opening = base created before + top-ups dated before the period − dispatched before.
  const opening = createdBefore ? Math.max(0, baseQty + adjBefore - before) : 0
  // Addition = base booked this period (if created here) + top-ups dated in the period.
  const addition = (createdInRange ? baseQty : 0) + adjIn
  return { opening, addition, dispatch: inP, closing: opening + addition - inP }
}

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
  const activityInRange = reg.opening + reg.addition + reg.dispatch > 1e-6
  return finishedInRange || createdInRange || activityInRange
}

// Default order: grouped by oil (A→Z), oldest first inside each group.
function defaultCompare(a: Row, b: Row): number {
  const byOil = oilOf(a).localeCompare(oilOf(b))
  if (byOil !== 0) return byOil
  const byDate = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
  if (byDate !== 0) return byDate
  return (Number(a.id) || 0) - (Number(b.id) || 0)
}

function emptyForm(uom: string): Row {
  return {
    bargain_date: todayISO(),
    supplier_id: '',
    broker_id: '',
    product_category: '',
    oil_type_id: '',
    bargain_type: 'EX',
    qty: '',
    uom,
    base_rate: '',
    duty: '',
    rate_expiry_date: '',
    remarks: ''
  }
}

export function Bargains({ onOpenOrder }: { onOpenOrder?: (orderId: number) => void } = {}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [brokers, setBrokers] = useState<Row[]>([])
  const [oilTypes, setOilTypes] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [draws, setDraws] = useState<Row[]>([])
  const [defaultShortagePct, setDefaultShortagePct] = useState('0.2')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [defaultUom, setDefaultUom] = useState('MT')
  const [typeFilter, setTypeFilter] = useState('OIL')
  const [showZero, setShowZero] = useState(false)
  const [search, setSearch] = useState('')
  // Period register range — defaults to the current month.
  const [dateFrom, setDateFrom] = useState(monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  const F = dateFrom || '0000-01-01'
  const T = dateTo || todayISO()

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyForm('MT'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Add/remove balance quantity on a bargain.
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{ mode: 'add' | 'remove'; amount: string; note: string; date: string }>({
    mode: 'add',
    amount: '',
    note: '',
    date: todayISO()
  })
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

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
      await window.api.bargains.adjust(Number(adjustRow.id), delta, adjustForm.note || undefined, adjustForm.date || undefined)
      toast.success(
        adjustForm.mode === 'add'
          ? `Added ${amt} ${adjustRow.uom || 'MT'} to ${adjustRow.bargain_no}`
          : `Removed ${amt} ${adjustRow.uom || 'MT'} from ${adjustRow.bargain_no}`
      )
      setAdjustRow(null)
      await load()
    } catch (e) {
      setAdjustError((e as Error).message)
    } finally {
      setAdjustSaving(false)
    }
  }

  // How much of the bargain being edited is already loaded/consumed. When > 0
  // the supplier and oil are locked and qty can't drop below it.
  const editConsumed = editing
    ? Math.max(0, (Number(editing.qty) || 0) - (Number(editing.balance_qty) || 0))
    : 0
  const editLocked = editConsumed > 1e-4

  const load = useCallback(async () => {
    setLoading(true)
    const [b, s, o, br, pt, settings, cd] = await Promise.all([
      window.api.bargains.list(F, T),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.data.list('brokers'),
      // bargains are general → show consumption from every company's tankers
      window.api.tankers.list(true),
      window.api.settings.all(),
      window.api.orders.consignmentDraws().catch(() => [] as Row[])
    ])
    setRows(b)
    setSuppliers(s.filter((x) => x.active))
    setBrokers(br.filter((x) => x.active))
    setTankers(pt)
    setDraws(cd)
    setDefaultShortagePct(settings.allowed_shortage_pct ?? '0.2')
    setOilTypes(
      o
        .filter((x) => x.active && x.category === 'raw')
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    )
    setDefaultUom(settings.default_uom ?? 'MT')
    setLoading(false)
  }, [F, T])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function openAdd(): void {
    setEditing(null)
    // With a single product category there's nothing to choose — preselect it.
    const only = productCategories.length === 1 ? productCategories[0] : ''
    setForm({ ...emptyForm(defaultUom), product_category: only })
    setError(null)
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      bargain_date: row.bargain_date ?? todayISO(),
      supplier_id: String(row.supplier_id ?? ''),
      broker_id: row.broker_id ? String(row.broker_id) : '',
      // Derive the category from the saved product so the cascade shows it.
      product_category: String(
        oilTypes.find((o) => String(o.id) === String(row.oil_type_id))?.material_type || 'OIL'
      ),
      oil_type_id: String(row.oil_type_id ?? ''),
      bargain_type: row.bargain_type ?? 'EX',
      qty: row.qty ?? '',
      uom: row.uom ?? defaultUom,
      base_rate: row.base_rate ?? '',
      duty: row.duty ?? '',
      rate_expiry_date: row.rate_expiry_date ?? '',
      remarks: row.remarks ?? ''
    })
    setError(null)
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Switching the product category clears a product that no longer fits it.
      if (key === 'product_category') {
        const stillValid = oilTypes.some(
          (o) => String(o.id) === String(prev.oil_type_id) && String(o.material_type || 'OIL') === String(value)
        )
        if (!stillValid) next.oil_type_id = ''
      }
      return next
    })
  }

  // Categories that actually have purchasable products, and the products inside
  // the chosen category (the cascade behind Product category → Product).
  const productCategories = useMemo(() => {
    const set = new Set(oilTypes.map((o) => String(o.material_type || 'OIL')))
    return MATERIAL_TYPES.filter((t) => set.has(t))
  }, [oilTypes])
  const categoryProducts = useMemo(
    () => oilTypes.filter((o) => String(o.material_type || 'OIL') === String(form.product_category || '')),
    [oilTypes, form.product_category]
  )

  const bgRate = (Number(form.base_rate) || 0) + (Number(form.duty) || 0)
  const total = (Number(form.qty) || 0) * bgRate

  async function save(): Promise<void> {
    if (!form.supplier_id) return setError('Supplier is required')
    if (!form.product_category) return setError('Product category is required')
    if (!form.oil_type_id) return setError('Product is required')
    if (!form.qty || Number(form.qty) <= 0) return setError('Quantity must be greater than 0')
    if (bgRate <= 0) return setError('Base rate must be greater than 0')
    if (editLocked && Number(form.qty) < editConsumed - 1e-4) {
      return setError(`Quantity cannot be below the ${formatNum(editConsumed)} already loaded/consumed`)
    }

    setSaving(true)
    setError(null)
    try {
      const payload: Row = {
        bargain_date: form.bargain_date,
        supplier_id: Number(form.supplier_id),
        broker_id: form.broker_id ? Number(form.broker_id) : null,
        oil_type_id: Number(form.oil_type_id),
        bargain_type: form.bargain_type,
        qty: Number(form.qty),
        uom: form.uom || defaultUom,
        base_rate: Number(form.base_rate) || 0,
        duty: Number(form.duty) || 0,
        rate_expiry_date: form.rate_expiry_date || null,
        remarks: form.remarks || null
      }
      if (editing) {
        await window.api.bargains.update(editing.id as number, payload)
        toast.success('Bargain updated')
      } else {
        const res = await window.api.bargains.create(payload)
        toast.success(`Bargain ${res.bargain_no} created`)
      }
      setOpen(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete bargain ${row.bargain_no}? This cannot be undone.`)) return
    try {
      await window.api.bargains.remove(row.id as number)
      toast.success('Bargain deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const noMasters = suppliers.length === 0 || oilTypes.length === 0
  const TYPE_FILTERS = ['OIL', 'HUSK', 'PACKAGING', 'CHEMICAL', 'ALL']
  // Enrich each bargain with its period register figures (used for the columns
  // and for sorting via the _opening/_addition/_dispatch/_closing accessors).
  const regRows = useMemo<Row[]>(
    () =>
      rows.map((r): Row => {
        const reg = bargainRegister(r, F, T)
        return { ...r, _opening: reg.opening, _addition: reg.addition, _dispatch: reg.dispatch, _closing: reg.closing }
      }),
    [rows, F, T]
  )
  const q = search.trim().toLowerCase()
  const visibleRows = regRows
    .filter((r) => typeFilter === 'ALL' || String(r.supplier_type || '').toUpperCase() === typeFilter)
    .filter((r) => inRegister(r, F, T, showZero))
    .filter(
      (r) =>
        !q ||
        [r.bargain_no, r.supplier_name, r.oil_code, r.oil_name, r.broker_name, r.remarks].some((f) =>
          String(f || '').toLowerCase().includes(q)
        )
    )

  const [sort, setSort] = useState<SortState>(null)
  const [reportOpen, setReportOpen] = useState(false)

  function toggleSort(key: string): void {
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
  }

  const sortedRows = useMemo(() => {
    const list = [...visibleRows]
    if (!sort) {
      list.sort(defaultCompare)
    } else {
      const acc = SORT_ACCESSORS[sort.key]
      list.sort((a, b) => {
        const va = acc(a)
        const vb = acc(b)
        const c = typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb))
        return sort.dir === 'asc' ? c : -c
      })
    }
    return list
  }, [visibleRows, sort])
  const paged = usePaged(sortedRows)

  // Oil-group separators only make sense while rows are grouped by oil.
  const groupedByOil = !sort || sort.key === 'oil'

  function toggleExpand(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Collapsed oil groups (band click toggles).
  // Oil groups are COLLAPSED by default — we track the ones the user opens.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  function toggleGroup(oil: string): void {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(oil)) next.delete(oil)
      else next.add(oil)
      return next
    })
  }

  // Per-oil totals shown on the group band, aligned to the table columns.
  const groupStats = useMemo(() => {
    const m = new Map<string, { count: number; opening: number; addition: number; dispatch: number; closing: number; balValue: number; uom: string }>()
    for (const r of visibleRows) {
      const k = oilOf(r)
      if (!m.has(k)) m.set(k, { count: 0, opening: 0, addition: 0, dispatch: 0, closing: 0, balValue: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      g.count += 1
      g.opening += Number(r._opening) || 0
      g.addition += Number(r._addition) || 0
      g.dispatch += Number(r._dispatch) || 0
      g.closing += Number(r._closing) || 0
      g.balValue += (Number(r._closing) || 0) * (Number(r.rate_per_uom) || 0)
    }
    return m
  }, [visibleRows])

  // Grand total across the currently visible groups (matches the group bands).
  const grandVisible = useMemo(() => {
    let count = 0, opening = 0, addition = 0, dispatch = 0, closing = 0, balValue = 0
    for (const g of groupStats.values()) {
      count += g.count
      opening += g.opening
      addition += g.addition
      dispatch += g.dispatch
      closing += g.closing
      balValue += g.balValue
    }
    return { count, opening, addition, dispatch, closing, balValue }
  }, [groupStats])

  // Report: one summary line per oil type — open bargains (balance left), total
  // qty/balance, weighted average rate and total value. Not bargain-wise.
  const report = useMemo(() => {
    type Agg = {
      label: string
      count: number
      openCount: number
      qty: number
      balance: number
      total: number
      openValue: number
    }
    const groups = new Map<string, Agg>()
    for (const r of rows) {
      const key = oilOf(r)
      if (!groups.has(key))
        groups.set(key, { label: key, count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0 })
      const g = groups.get(key)!
      const qty = Number(r.qty) || 0
      const balance = Number(r.balance_qty) || 0
      const rate = Number(r.rate_per_uom) || 0
      g.count += 1
      g.qty += qty
      g.balance += balance
      g.total += Number(r.total_amount) || 0
      if (balance > 0.005) {
        g.openCount += 1
        g.openValue += balance * rate
      }
    }
    const list = Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label))
    const grand = list.reduce(
      (s, g) => ({
        count: s.count + g.count,
        openCount: s.openCount + g.openCount,
        qty: s.qty + g.qty,
        balance: s.balance + g.balance,
        total: s.total + g.total,
        openValue: s.openValue + g.openValue
      }),
      { count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0 }
    )
    return { groups: list, grand }
  }, [rows])

  // Weighted average rate = total value ÷ total qty.
  const avgRate = (g: { total: number; qty: number }): number => (g.qty > 0 ? g.total / g.qty : 0)

  function downloadExcel(): void {
    void exportRowsToExcel({
      filename: `bargains-${typeFilter.toLowerCase()}-${todayISO()}`,
      sheetName: 'Pur bargains',
      title: 'Purchase bargains',
      columns: [
        { header: 'Bargain no', key: 'bargain_no', value: (r) => r.bargain_no || '' },
        { header: 'Date', key: 'bargain_date', value: (r) => formatDate(r.bargain_date) },
        { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
        { header: 'Oil', key: 'oil', value: (r) => oilOf(r) },
        { header: 'Condition', key: 'bargain_type', value: (r) => r.bargain_type || '' },
        { header: 'Opening', key: '_opening', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._opening) || 0 },
        { header: 'Addition', key: '_addition', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._addition) || 0 },
        { header: 'BG rate', key: 'rate_per_uom', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.rate_per_uom) || 0 },
        { header: 'Dispatch', key: '_dispatch', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._dispatch) || 0 },
        { header: 'Balance', key: '_closing', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._closing) || 0 },
        { header: 'Total', key: 'total_amount', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.total_amount) || 0 }
      ],
      rows: sortedRows,
      // Second tab: every tanker under every bargain, so the nested view of the
      // page is readable in Excel too. A tanker split across two bargains shows
      // under both, with only its share.
      extraSheets: [
        {
          sheetName: 'Tankers',
          title: 'Purchase bargains — tanker detail',
          columns: [
            { header: 'Bargain no', key: 'bargain_no' },
            { header: 'BG date', key: 'bargain_date' },
            { header: 'Supplier', key: 'supplier_name' },
            { header: 'Oil', key: 'oil' },
            { header: 'BG rate', key: 'rate', align: 'right', numFmt: '#,##0.00' },
            { header: 'Tanker', key: 'tanker_no' },
            { header: 'Loaded on', key: 'loaded_date' },
            { header: 'Stage', key: 'stage' },
            { header: 'Invoice', key: 'invoice_no' },
            { header: 'Dis qty', key: 'dis_qty', align: 'right', numFmt: '#,##0.000' },
            { header: 'Received', key: 'received_qty', align: 'right', numFmt: '#,##0.000' },
            { header: 'Split', key: 'split' }
          ],
          rows: tankerDetailRows(),
          isGroup: (r) => !r.tanker_no,
          outlineDetail: true
        }
      ]
    })
  }

  // Flatten the expandable second level: one row per bargain followed by its
  // tankers. Bargains with none still appear, so nothing goes missing.
  function tankerDetailRows(): Row[] {
    const out: Row[] = []
    for (const b of sortedRows) {
      const id = Number(b.id)
      const list = tankers.filter(
        (t) => Number(t.bargain_id) === id || (Number(t.extra_qty) > 0 && Number(t.extra_bargain_id) === id)
      )
      out.push({
        bargain_no: b.bargain_no || '',
        bargain_date: formatDate(b.bargain_date),
        supplier_name: b.supplier_name || '',
        oil: oilOf(b),
        rate: Number(b.rate_per_uom) || 0,
        dis_qty: Number(b._dispatch) || 0
      })
      for (const t of list) {
        const loaded = Number(t.loaded_qty) || 0
        const extra = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
        const isPrimary = Number(t.bargain_id) === id
        const share = isPrimary ? loaded - extra : extra
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          supplier_name: '',
          oil: '',
          rate: Number(isPrimary ? b.rate_per_uom : b.rate_per_uom) || 0,
          tanker_no: t.tanker_no || '—',
          loaded_date: formatDate(t.loaded_date),
          stage: String(t.status || ''),
          invoice_no: t.invoice_no || '',
          dis_qty: share,
          received_qty: Number(t.received_qty) || 0,
          split: extra > 0 ? (isPrimary ? `split — ${extra} moved out` : 'split — excess share') : ''
        })
      }
    }
    return out
  }

  function downloadReportExcel(): void {
    const rows = report.groups.map((g) => ({
      label: g.label,
      openCount: g.openCount,
      count: g.count,
      balance: g.balance,
      qty: g.qty,
      avg: avgRate(g)
    }))
    const t = report.grand
    rows.push({ label: 'GRAND TOTAL', openCount: t.openCount, count: t.count, balance: t.balance, qty: t.qty, avg: avgRate(t) })
    void exportRowsToExcel({
      filename: `bargain-report-by-oil-${todayISO()}`,
      sheetName: 'Bargain report',
      title: 'Bargain report by oil',
      columns: [
        { header: 'Oil', key: 'label' },
        { header: 'Open bargains', key: 'openCount', align: 'right', numFmt: '#,##0' },
        { header: 'Total bargains', key: 'count', align: 'right', numFmt: '#,##0' },
        { header: 'Bal qty', key: 'balance', align: 'right', numFmt: '#,##0.000' },
        { header: 'Total qty', key: 'qty', align: 'right', numFmt: '#,##0.000' },
        { header: 'Avg rate', key: 'avg', align: 'right', numFmt: '#,##0.00' }
      ],
      rows
    })
  }

  return (
    <>
      <PageHeader
        title="Bargains"
        subtitle="Rate contracts — drawn down as purchase tankers are loaded"
        hint="Each bargain locks a rate and quantity with a supplier. The bargain number is OILCODE/DD-MM/PARTYNAME/SERIAL, where the serial restarts every month from 01 (e.g. MAHUWA/01-07/ROHINIOIL/03). Landed rate = base rate + customs duty. Click any column header to sort; the Report button groups the full history by oil."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setReportOpen((v) => !v)}>
              <BarChart3 className="h-4 w-4" />
              {reportOpen ? 'Back to list' : 'Report'}
            </Button>
            <Button variant="outline" size="sm" onClick={downloadExcel}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button size="sm" onClick={openAdd} disabled={noMasters}>
              <Plus className="h-4 w-4" />
              New bargain
            </Button>
          </div>
        }
      />

      <div className="w-full p-4">
        {noMasters && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Add at least one supplier and one oil type in Settings before creating a bargain.
          </div>
        )}

        {reportOpen ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <button
                  className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setReportOpen(false)}
                >
                  <ArrowLeft className="h-4 w-4" /> Back to list
                </button>
                <h3 className="text-lg font-semibold">Bargain report — by oil</h3>
                <p className="text-xs text-muted-foreground">
                  Open bargains, weighted average rate and value per oil type · {report.grand.count} bargains overall
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadReportExcel}>
                <FileSpreadsheet className="h-4 w-4" /> Download report
              </Button>
            </div>

            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <Table className="text-[13px]">
                <TableHeader className="bg-amber-100/70">
                  <TableRow>
                    <TableHead className="text-amber-900">Oil</TableHead>
                    <TableHead className="text-center text-amber-900">Open bargains</TableHead>
                    <TableHead className="text-center text-amber-900">Total bargains</TableHead>
                    <TableHead className="text-right text-amber-900">Bal Qty</TableHead>
                    <TableHead className="text-right text-amber-900">Total qty</TableHead>
                    <TableHead className="text-right text-amber-900">Avg rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No bargains yet.</TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {report.groups.map((g) => (
                        <TableRow key={g.label}>
                          <TableCell className="font-semibold">{g.label}</TableCell>
                          <TableCell className="text-center tabular-nums">
                            <Badge variant={g.openCount > 0 ? 'warning' : 'muted'}>{g.openCount}</Badge>
                          </TableCell>
                          <TableCell className="text-center tabular-nums">{g.count}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.balance)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.qty)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(avgRate(g))}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell>Grand total</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.openCount}</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.balance)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.qty)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatINR(avgRate(report.grand))}</TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Open = bargains with balance quantity left. Bal Qty is the quantity still open. Avg rate is weighted (total value ÷ total qty).
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
                {TYPE_FILTERS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      typeFilter === t ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t === 'ALL' ? 'All' : t}
                  </button>
                ))}
              </div>
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  className="h-9 pl-8"
                  placeholder="Search bargain no, supplier, oil, broker…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">Date</span>
                <DatePicker value={dateFrom} onChange={(v) => setDateFrom(v || '')} className="w-36" />
                <span className="text-muted-foreground">to</span>
                <DatePicker value={dateTo} onChange={(v) => setDateTo(v || '')} className="w-36" />
                {(dateFrom || dateTo) && (
                  <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear</Button>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={showZero} onCheckedChange={setShowZero} />
                Show settled (0 balance)
              </label>
            </div>

            <div className="rounded-xl border bg-card shadow-sm">
              <Table wrapperClassName="max-h-[calc(100vh-215px)] rounded-xl" className="min-w-[860px] text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:h-9">
                <TableHeader>
                  <TableRow>
                    {(
                      [
                        { id: 'bargain_no', label: 'Bargain no' },
                        { id: 'bargain_date', label: 'Date' },
                        { id: 'supplier', label: 'Supplier' },
                        { id: 'oil', label: 'Oil' },
                        { id: 'condition', label: 'Condition' },
                        { id: 'qty', label: 'Opening', right: true },
                        { id: 'addition', label: 'Addition', right: true },
                        { id: 'rate', label: 'BG rate', right: true },
                        { id: 'dispatch', label: 'Dispatch', right: true },
                        { id: 'balance', label: 'Balance', right: true },
                        { id: 'total', label: 'Total', right: true }
                      ] as { id: string; label: string; right?: boolean }[]
                    ).map((c) => (
                      <TableHead key={c.id} className={cn('sticky top-0 z-20 bg-slate-100 text-[11px] font-semibold uppercase tracking-wide text-foreground', c.right && 'text-right')}>
                        <button
                          onClick={() => toggleSort(c.id)}
                          className={cn(
                            'inline-flex items-center gap-1 transition-colors hover:text-foreground',
                            c.right && 'w-full justify-end'
                          )}
                          title={`Sort by ${c.label}`}
                        >
                          {c.label}
                          {sort?.key === c.id ? (
                            sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                    ))}
                    <TableHead className="sticky top-0 z-20 bg-slate-100 w-[90px] text-right text-[11px] font-semibold uppercase tracking-wide text-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : sortedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                        {rows.length === 0
                          ? 'No bargains yet. Click “New bargain” to add one.'
                          : `No ${typeFilter === 'ALL' ? '' : typeFilter + ' '}bargains to show.`}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                    <TableRow className="border-y-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                      <TableCell colSpan={5} className="py-2 text-xs font-bold uppercase tracking-wide text-amber-900">
                        Grand total
                        <span className="ml-1 font-medium normal-case tracking-normal text-amber-700">
                          · {grandVisible.count} bargain{grandVisible.count === 1 ? '' : 's'}
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grandVisible.opening)}</TableCell>
                      <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grandVisible.addition)}</TableCell>
                      <TableCell className="py-2" />
                      <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grandVisible.dispatch)}</TableCell>
                      <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grandVisible.closing)}</TableCell>
                      <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatINR(grandVisible.balValue)}</TableCell>
                      <TableCell className="py-2" />
                    </TableRow>
                    {paged.pageRows.map((row, pi) => {
                      // Index in the full list, so serials and group breaks stay
                      // correct across pages; a page always opens with its header.
                      const i = (paged.page - 1) * PAGE_SIZE + pi
                      const oil = oilOf(row)
                      const newGroup =
                        groupedByOil && (pi === 0 || i === 0 || oil !== oilOf(sortedRows[i - 1]))
                      // Groups are collapsed unless the user opened them; while
                      // searching, always reveal matches.
                      const isCollapsed = groupedByOil && !q && !openGroups.has(oil)
                      const g = groupStats.get(oil)
                      // Serial number within the oil group (1-based).
                      const seq = groupedByOil
                        ? sortedRows.slice(0, i + 1).filter((r) => oilOf(r) === oil).length
                        : i + 1
                      return (
                        <Fragment key={row.id as number}>
                          {newGroup && (
                            <TableRow
                              className="cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70"
                              onClick={() => toggleGroup(oil)}
                            >
                              <TableCell colSpan={5} className="py-1.5">
                                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700">
                                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                  {oil}
                                  <span className="font-medium normal-case tracking-normal text-slate-500">
                                    · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.opening ?? 0)}</TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.addition ?? 0)}</TableCell>
                              <TableCell className="py-1.5" />
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.dispatch ?? 0)}</TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.closing ?? 0)}</TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatINR(g?.balValue ?? 0)}</TableCell>
                              <TableCell className="py-1.5" />
                            </TableRow>
                          )}
                          {!isCollapsed && (
                          <>
                          <TableRow className={cn('cursor-pointer transition-colors', expanded.has(Number(row.id)) ? 'bg-slate-100 hover:bg-slate-100' : 'hover:bg-muted/40')} onClick={() => toggleExpand(Number(row.id))}>
                          <TableCell className="font-medium">
                            <ChevronRight
                              className={cn(
                                'mr-1 inline h-3.5 w-3.5 text-muted-foreground transition-transform',
                                expanded.has(Number(row.id)) && 'rotate-90'
                              )}
                            />
                            <span className="mr-1 tabular-nums text-muted-foreground">{seq}.</span>
                            {row.bargain_no}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(row.bargain_date)}</TableCell>
                          <TableCell className="max-w-[160px] truncate" title={row.supplier_name ?? ''}>{row.supplier_name ?? '—'}</TableCell>
                          <TableCell className="text-muted-foreground">{row.oil_code}</TableCell>
                          <TableCell>
                            <Badge variant={row.bargain_type === 'DLD' || row.bargain_type === 'Delivered' ? 'secondary' : 'muted'} className="text-[10px]">
                              {row.bargain_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{Number(row._opening) ? formatNum(row._opening) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{Number(row._addition) ? formatNum(row._addition) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(row.rate_per_uom)}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', Number(row._dispatch) && 'font-bold text-red-600')}>{Number(row._dispatch) ? formatNum(row._dispatch) : '—'}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            <span className={Number(row._closing) < -1e-9 ? 'text-red-600' : ''}>
                              {formatNum(row._closing)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatINR(row.total_amount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8" title="Add / remove balance qty" onClick={(e) => { e.stopPropagation(); openAdjust(row) }}>
                                <SlidersHorizontal className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); openEdit(row) }}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive"
                                onClick={(e) => { e.stopPropagation(); del(row) }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                          </TableRow>
                          {expanded.has(Number(row.id)) && (
                            <TableRow className="bg-slate-200 hover:bg-slate-200">
                              <TableCell colSpan={12} className="p-0">
                                {(() => {
                                  // A tanker may be split across two bargains (excess loading):
                                  // its bargain gets loaded − extra, the auto-created line gets extra.
                                  const list = tankers.filter(
                                    (t) =>
                                      Number(t.bargain_id) === Number(row.id) ||
                                      (Number(t.extra_qty) > 0 && Number(t.extra_bargain_id) === Number(row.id))
                                  )
                                  // Consignment / direct purchases draw on a bargain
                                  // without a tanker of their own, so they are listed
                                  // separately from the tanker table.
                                  const drawn = draws.filter((d) => Number(d.bargain_id) === Number(row.id))
                                  const drawnBlock = drawn.length ? (
                                    <div className="mb-2 overflow-hidden rounded-md border border-violet-200">
                                      <div className="flex items-center justify-between bg-violet-100/70 px-3 py-1">
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-900">
                                          MNC / direct purchases on this bargain
                                        </span>
                                        <span className="text-[11px] font-bold tabular-nums text-violet-900">
                                          {formatNum(drawn.reduce((a, d) => a + (Number(d.qty) || 0), 0))} {row.uom}
                                        </span>
                                      </div>
                                      <table className="w-full bg-white text-[11px]">
                                        <thead>
                                          <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                                            <th className="px-3 py-1">Invoice</th>
                                            <th className="px-3 py-1">Date</th>
                                            <th className="px-3 py-1">Party</th>
                                            <th className="px-3 py-1">Tanker(s)</th>
                                            <th className="px-3 py-1 text-right">Drawn</th>
                                            <th className="px-3 py-1 text-right">Invoice rate</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {drawn.map((d) => (
                                            <tr key={`${d.order_id}-${d.bargain_id}`} className="border-b last:border-0">
                                              <td className="px-3 py-1 font-medium">{d.invoice_no}</td>
                                              <td className="whitespace-nowrap px-3 py-1">{formatDate(d.order_date)}</td>
                                              <td className="px-3 py-1">{d.supplier_name}</td>
                                              <td className="px-3 py-1 text-muted-foreground">{d.tanker_nos || '—'}</td>
                                              <td className="px-3 py-1 text-right font-bold tabular-nums text-red-600">
                                                {formatNum(d.qty)}
                                              </td>
                                              <td className="px-3 py-1 text-right tabular-nums">{formatINR(d.invoice_rate)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : null
                                  const remarksLine = row.remarks ? (
                                    <p className="pb-2 text-xs text-muted-foreground"><span className="font-semibold">Remarks:</span> {row.remarks}</p>
                                  ) : null
                                  if (!list.length) {
                                    return (
                                      <div className="bg-slate-200 px-6 py-4">
                                        {remarksLine}
                                        {drawnBlock}
                                        {!drawn.length && (
                                          <p className="text-xs text-muted-foreground">No tankers on this bargain yet.</p>
                                        )}
                                      </div>
                                    )
                                  }
                                  const disOf = (t: Row): number => {
                                    const loaded = Number(t.loaded_qty) || 0
                                    const extra = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
                                    return Number(t.bargain_id) === Number(row.id) ? loaded - extra : extra
                                  }
                                  // receipts/shortage belong to the whole tanker — pro-rate by share
                                  const shareOf = (t: Row): number => {
                                    const loaded = Number(t.loaded_qty) || 0
                                    return loaded > 0 ? disOf(t) / loaded : 1
                                  }
                                  const pctOf = (t: Row): number =>
                                    Number(t.order_allowed_shortage_pct ?? row.allowed_shortage_pct ?? defaultShortagePct) || 0
                                  const tot = list.reduce(
                                    (s, t) => {
                                      const loaded = Number(t.loaded_qty) || 0
                                      const rec = t.received_qty != null ? Number(t.received_qty) : null
                                      const share = shareOf(t)
                                      s.dis += disOf(t)
                                      s.rec += (rec ?? 0) * share
                                      s.shortage += rec != null ? Math.max(0, loaded - rec) * share : 0
                                      s.allowed += (disOf(t) * pctOf(t)) / 100
                                      return s
                                    },
                                    { dis: 0, rec: 0, shortage: 0, allowed: 0 }
                                  )
                                  return (
                                    <div className="bg-slate-200 px-6 py-4">
                                      {remarksLine}
                                      {drawnBlock}
                                      <table className="overflow-hidden rounded-lg border border-slate-300 bg-card text-xs shadow-sm [&_td]:pl-3 [&_th]:pl-3">
                                        <thead>
                                          <tr className="border-b bg-slate-200/70 text-left text-slate-700">
                                            <th className="py-1.5 pr-3 font-semibold w-8">#</th>
                                            <th className="py-1.5 pr-3 font-semibold">Tanker</th>
                                            <th className="py-1.5 pr-3 font-semibold">Loading Date</th>
                                            <th className="py-1.5 pr-3 font-semibold">Receipt Date</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Dis Qty</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Rec Qty</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Shortage</th>
                                            <th className="py-1.5 text-right font-semibold">Allowed MT</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {list.map((t, ti) => {
                                            const loaded = Number(t.loaded_qty) || 0
                                            const dis = disOf(t)
                                            const share = shareOf(t)
                                            const split = Number(t.extra_qty) > 0 && Number(t.extra_bargain_id) > 0
                                            const rec = t.status === 'empty' && t.received_qty != null ? Number(t.received_qty) * share : null
                                            const shortage = rec != null ? Math.max(0, loaded - Number(t.received_qty)) * share : null
                                            return (
                                              <tr
                                                key={t.id as number}
                                                className={cn(
                                                  'border-b',
                                                  ti % 2 === 1 ? 'bg-muted/40' : 'bg-card',
                                                  t.order_id && onOpenOrder && 'cursor-pointer hover:bg-sky-50'
                                                )}
                                                title={t.order_id ? 'Open the purchase invoice' : 'Not billed yet'}
                                                onClick={() => t.order_id && onOpenOrder?.(Number(t.order_id))}
                                              >
                                                <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{ti + 1}</td>
                                                <td className="py-1.5 pr-3 font-medium">
                                                  {t.tanker_no}
                                                  {split && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(split)</span>}
                                                </td>
                                                <td className="py-1.5 pr-3">{loaded > 0 ? formatDate(t.loaded_date) : '—'}</td>
                                                <td className="py-1.5 pr-3">{t.empty_date ? formatDate(t.empty_date) : '—'}</td>
                                                <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-red-600">{loaded > 0 ? formatNum(dis) : '—'}</td>
                                                <td className="py-1.5 pr-3 text-right tabular-nums">{rec != null ? formatNum(rec) : '—'}</td>
                                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                                  {shortage != null ? (
                                                    <span className={shortage > 0 ? 'text-amber-700' : ''}>{formatNum(shortage)}</span>
                                                  ) : '—'}
                                                </td>
                                                <td className="py-1.5 text-right tabular-nums">{loaded > 0 ? formatNum((dis * pctOf(t)) / 100) : '—'}</td>
                                              </tr>
                                            )
                                          })}
                                          <tr className="border-t-2 border-amber-500 bg-amber-50 font-semibold text-amber-900">
                                            <td className="py-1.5 pr-3" colSpan={4}>Total</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-red-600">{formatNum(tot.dis)}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{formatNum(tot.rec)}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{formatNum(tot.shortage)}</td>
                                            <td className="py-1.5 text-right tabular-nums">{formatNum(tot.allowed)}</td>
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>
                                  )
                                })()}
                              </TableCell>
                            </TableRow>
                          )}
                          </>
                          )}
                        </Fragment>
                      )
                    })}
                    </>
                  )}
                </TableBody>
              </Table>
              <Pagination {...paged} label="bargains" className="border-t px-3" />
            </div>
          </>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.bargain_no}` : 'New bargain'}</DialogTitle>
          </DialogHeader>

          {editLocked && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {formatNum(editConsumed)} {editing?.uom || 'MT'} is already loaded/consumed on this bargain — supplier and oil are
              locked, and the quantity can&apos;t go below {formatNum(editConsumed)}.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Bargain date *</Label>
              <DatePicker
                value={form.bargain_date}
                onChange={(v) => setField('bargain_date', v)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Bargain no</Label>
              <Input value={editing ? editing.bargain_no : 'Auto-generated'} disabled />
            </div>

            <div className="grid gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(form.supplier_id)} onValueChange={(v) => setField('supplier_id', v)} disabled={editLocked}>
                <SelectTrigger>
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Product category *</Label>
              <Select value={String(form.product_category || '')} onValueChange={(v) => setField('product_category', v)} disabled={editLocked}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {productCategories.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Product *</Label>
              <Select
                value={String(form.oil_type_id)}
                onValueChange={(v) => setField('oil_type_id', v)}
                disabled={editLocked || !form.product_category}
              >
                <SelectTrigger>
                  <SelectValue placeholder={form.product_category ? 'Select product' : 'Pick a category first'} />
                </SelectTrigger>
                <SelectContent>
                  {categoryProducts.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.code || o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!!form.product_category && categoryProducts.length === 0 && (
                <span className="text-[11px] text-amber-700">No {String(form.product_category)} products yet — add one under Products.</span>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label>Broker</Label>
              <Select value={String(form.broker_id || '')} onValueChange={(v) => setField('broker_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select broker (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {brokers.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Bargain condition</Label>
              <Select value={form.bargain_type} onValueChange={(v) => setField('bargain_type', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EX">EX</SelectItem>
                  <SelectItem value="DLD">DLD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom} onChange={(v) => setField('uom', v)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Bargain qty *</Label>
              <Input type="number" min={editLocked ? editConsumed : 0} value={form.qty} onChange={(e) => setField('qty', e.target.value)} />
              {editLocked && Number(form.qty) < editConsumed - 1e-4 && (
                <span className="text-[11px] text-red-600">Cannot be below {formatNum(editConsumed)} already loaded.</span>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label>Base rate (ex duty) *</Label>
              <Input
                type="number"
                value={form.base_rate}
                onChange={(e) => setField('base_rate', e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Duty per {form.uom || 'MT'}</Label>
              <Input type="number" value={form.duty} onChange={(e) => setField('duty', e.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Contract expiry</Label>
              <DatePicker
                value={form.rate_expiry_date ?? ''}
                onChange={(v) => setField('rate_expiry_date', v)}
              />
            </div>

            <div className="grid content-end gap-1.5">
              <Label>Bargain rate (base + duty)</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">
                {formatINR(bgRate)}
              </div>
            </div>
            <div className="grid content-end gap-1.5">
              <Label>Total bargain amount</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-semibold tabular-nums">
                {formatINR(total)}
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Remarks</Label>
            <textarea
              rows={2}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Optional notes about this bargain"
              value={form.remarks ?? ''}
              onChange={(e) => setField('remarks', e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save bargain'}
            </Button>
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
            const bal = Number(adjustRow.balance_qty) || 0
            const consumed = qty - bal
            const amt = Number(adjustForm.amount) || 0
            const delta = adjustForm.mode === 'add' ? amt : -amt
            const newBal = bal + delta
            const uom = adjustRow.uom || 'MT'
            return (
              <div className="grid gap-4">
                <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-3 text-center text-sm">
                  <div><div className="text-[11px] text-muted-foreground">Bargain qty</div><div className="font-semibold tabular-nums">{formatNum(qty)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Loaded</div><div className="font-semibold tabular-nums">{formatNum(consumed)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Balance</div><div className="font-semibold tabular-nums">{formatNum(bal)} {uom}</div></div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))}
                    className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40')}
                  >
                    + Add to balance
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))}
                    className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40')}
                  >
                    − Remove from balance
                  </button>
                </div>

                <div className="grid gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})</Label>
                  <Input
                    type="number"
                    autoFocus
                    value={adjustForm.amount}
                    onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={adjustForm.date} onChange={(v) => setAdjustForm((p) => ({ ...p, date: v || '' }))} />
                  <p className="text-xs text-muted-foreground">Shown under "Addition" for this date's month in the register.</p>
                </div>

                <div className="grid gap-1.5">
                  <Label>Note (optional)</Label>
                  <Input value={adjustForm.note} onChange={(e) => setAdjustForm((p) => ({ ...p, note: e.target.value }))} placeholder="Reason for the adjustment" />
                </div>

                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  New balance:{' '}
                  <span className={cn('font-semibold tabular-nums', newBal < -1e-9 && 'text-red-600')}>
                    {formatNum(newBal)} {uom}
                  </span>
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
    </>
  )
}
