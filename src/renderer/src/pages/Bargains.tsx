import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  AlertTriangle,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  MinusCircle,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RowActions } from '@/components/ui/row-actions'
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
import { FyPicker } from '@/components/FyPicker'
import { UomSelect } from '@/components/UomSelect'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { exportRowsToExcel } from '@/lib/excel'
import { cn, inkOn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useCategories } from '@/lib/useCategories'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { isManufacturingParty } from '@/lib/constants'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The first day a contract struck on `date` may expire -- the day after it. A
// contract cannot expire on the day it was struck, so same-day is out too.
function dayAfter(date: unknown): string | undefined {
  const s = String(date || '').slice(0, 10)
  if (!s) return undefined
  const d = new Date(`${s}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
  adjusted: (r) => Number(r._adjusted) || 0,
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
// opening (b/f) + addition (booked in period) + adjusted (manual add/remove in
// period) − dispatch (received in period) = closing.
function bargainRegister(r: Row, from: string, to: string): { opening: number; addition: number; adjusted: number; dispatch: number; closing: number } {
  const qty = Number(r.qty) || 0
  const before = Number(r.disp_before) || 0
  const inP = Number(r.disp_period) || 0
  const adjBefore = Number(r.adj_before) || 0
  const adjIn = Number(r.adj_in) || 0
  const adjAfter = Number(r.adj_after) || 0
  const bdate = String(r.bargain_date || '').slice(0, 10)
  const createdInRange = bdate >= from && bdate <= to
  const createdBefore = bdate < from
  // Original booked qty, stripped of every dated top-up (those are shown as
  // their own Adjusted figure in the month they were made, not folded into
  // Opening or blended into Addition).
  const baseQty = qty - adjBefore - adjIn - adjAfter
  // Opening = base created before + top-ups dated before the period − dispatched before.
  const opening = createdBefore ? Math.max(0, baseQty + adjBefore - before) : 0
  // Addition = the bargain as originally booked, only in the period it was booked.
  const addition = createdInRange ? baseQty : 0
  // Adjusted = manual balance add/remove dated in the period — kept separate so
  // Addition always reads as "what was originally struck", not muddied by
  // later corrections.
  const adjusted = adjIn
  return { opening, addition, adjusted, dispatch: inP, closing: opening + addition + adjusted - inP }
}

// A bargain shows in the register when it still has an open balance, or when
// `showZero` is on — in which case the settled ones come too, regardless of
// which period is selected.
function inRegister(r: Row, from: string, to: string, showZero = false): boolean {
  const bdate = String(r.bargain_date || '').slice(0, 10)
  if (bdate > to) return false
  const reg = bargainRegister(r, from, to)
  if (reg.closing > 1e-6) return true
  // Settled. Shown whenever the switch is on, whatever the period.
  //
  // This used to require the bargain to have been created, finished, or had
  // activity inside [from, to] — which reads sensibly and behaves terribly.
  // Turn the switch on with a month selected and nothing happens: the settled
  // bargains were all finished in some earlier month, so none of them
  // qualified, and the control looked broken. The only way to see them was to
  // widen the range, which is not what "Show settled" says it does.
  //
  // The period still governs what the COLUMNS say — the figures come from
  // bargainRegister(from, to) either way — and a bargain dated after the
  // period end is still out, above. This decides membership only.
  return showZero
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

// Column-group tints for the purchase-bargain register on the website.
// Opening / Addition / Adjusted are one thought (what was contracted) and
// Dispatch is what moved against it, so each set gets a faint ground and
// hairline edges rather than thirteen identically-painted columns.
const PB_G = '!bg-[#FBFDFA]'
const PB_GL = '!bg-[#FBFDFA] !border-l !border-l-[#EAF0E9]'
const PB_GR = '!bg-[#FBFDFA] !border-r !border-r-[#EAF0E9]'
const PB_BAL = '!bg-[#EFF5EC]'
const PB_HG = '!bg-[#0F4534]'
const PB_HGL = '!bg-[#0F4534] !border-l !border-l-[#C7F03F]/20'
const PB_HGR = '!bg-[#0F4534] !border-r !border-r-[#C7F03F]/20'
const PB_HBAND = '!bg-[#0C3226]'
const PB_HOPEN = '!bg-[#1A4D2E] !text-[#C7F03F]'

// How far a bargain has been drawn down, for the bar under Balance. Amber from
// 95%: a contract that is nearly drawn is the one worth spotting before more
// tankers are sent against it.
function pbBar(opening: number, addition: number, adjusted: number, dispatch: number): { pct: number; color: string } {
  const contracted = opening + addition + adjusted
  const pct = contracted > 0 ? Math.min(100, Math.max(0, (dispatch / contracted) * 100)) : 0
  return { pct, color: pct >= 95 ? '#C2700A' : pct > 0 ? '#12855A' : '#DCE7DB' }
}

export function Bargains({ onOpenOrder }: { onOpenOrder?: (orderId: number) => void } = {}): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('bargains')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [brokers, setBrokers] = useState<Row[]>([])
  const [oilTypes, setOilTypes] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [draws, setDraws] = useState<Row[]>([])
  // Bargains are general, so the register reads as ONE book across every
  // company by default — empty means all. Picking a company narrows whose
  // tankers and whose consignment/direct purchases count as drawn against it.
  const [companies, setCompanies] = useState<Row[]>([])
  const [coIds, setCoIds] = useState<number[]>([])
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
  // Alt+F2 broadcasts a period from anywhere — adopt it here too.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'bargains')) { setDateFrom(globalRange.from); setDateTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const sel = coIds.length ? coIds : undefined
    const [b, s, o, br, pt, settings, cd, cos] = await Promise.all([
      window.api.bargains.list(F, T, sel),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.data.list('brokers'),
      // bargains are general → show consumption from every company's tankers
      window.api.tankers.list(true),
      window.api.settings.all(),
      // Every company's consignment / direct draws, for the same reason the
      // tankers come from every company: the balance already counts them.
      window.api.orders.consignmentDraws(sel).catch(() => [] as Row[]),
      window.api.company.list().catch(() => [] as Row[])
    ])
    setRows(b)
    setCompanies(cos)
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
  }, [F, T, coIds])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function openAdd(): void {
    setEditing(null)
    // With a single product category there's nothing to choose — preselect it.
    const only = usableCategories.length === 1 ? usableCategories[0] : ''
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
  const { categories: bargainCats } = useCategories(suppliers.map((x) => x.supplier_type), 'purchase')
  // Every ACTIVE purchase-side category from the master — not only the ones that
  // already have a product behind them. A category with nothing purchasable
  // used to just vanish from this dropdown, which reads as the master not
  // working; it is now listed and disabled with the reason, so the answer is on
  // screen instead of having to be worked out.
  //
  // `oilTypes` is already narrowed to ACTIVE products whose sub-category is
  // `raw` — that is what a purchase bargain can be struck on.
  const productCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of oilTypes) {
      const k = String(o.material_type || 'OIL').trim().toUpperCase()
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    const live = bargainCats.length ? bargainCats : MATERIAL_TYPES
    const names = [...live]
    // The value already on the bargain being edited is always kept, whatever
    // the master now says, so an old entry never becomes unselectable.
    const cur = String(form.product_category || '').trim().toUpperCase()
    if (cur && !names.includes(cur)) names.push(cur)
    return names.map((t) => ({ name: t, products: counts.get(t) || 0 }))
  }, [oilTypes, bargainCats, form.product_category])
  // Only the ones that can actually be picked, for the "preselect the only
  // option" shortcut.
  const usableCategories = useMemo(
    () => productCategories.filter((t) => t.products > 0).map((t) => t.name),
    [productCategories]
  )
  const categoryProducts = useMemo(
    () => oilTypes.filter((o) => String(o.material_type || 'OIL') === String(form.product_category || '')),
    [oilTypes, form.product_category]
  )

  const bgRate = (Number(form.base_rate) || 0) + (Number(form.duty) || 0)
  const total = (Number(form.qty) || 0) * bgRate

  // Shown under the expiry field the moment the pair stops making sense --
  // which happens when the bargain date is moved forward past an expiry that
  // was already set, not only when the expiry itself is picked.
  const expiryProblem = ((): string | null => {
    const struck = String(form.bargain_date || '').slice(0, 10)
    const expires = String(form.rate_expiry_date || '').slice(0, 10)
    if (!struck || !expires || expires > struck) return null
    return expires === struck
      ? 'Expiry cannot be the same day as the bargain'
      : `Expiry is before the bargain date (${formatDate(struck)})`
  })()

  async function save(): Promise<void> {
    if (!form.supplier_id) return setError('Supplier is required')
    if (!form.product_category) return setError('Product category is required')
    if (!form.oil_type_id) return setError('Product is required')
    if (!form.qty || Number(form.qty) <= 0) return setError('Quantity must be greater than 0')
    if (bgRate <= 0) return setError('Base rate must be greater than 0')
    if (expiryProblem) return setError(`Contract expiry must be after the bargain date — ${expiryProblem.toLowerCase()}`)
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
  // Same rule as the purchase invoice: a bargain is a manufacturing rate
  // contract, so Trading suppliers are left out — but the bargain's own
  // supplier stays listed so an existing one still opens and edits.
  const bargainSuppliers = useMemo(
    () =>
      suppliers.filter(
        (s) => isManufacturingParty(s) || String(s.id) === String(form.supplier_id || '')
      ),
    [suppliers, form.supplier_id]
  )
  // The tabs follow the Categories master, with ALL pinned at the end.
  const TYPE_FILTERS = [...bargainCats, 'ALL']
  // Enrich each bargain with its period register figures (used for the columns
  // and for sorting via the _opening/_addition/_adjusted/_dispatch/_closing accessors).
  const regRows = useMemo<Row[]>(
    () =>
      rows.map((r): Row => {
        const reg = bargainRegister(r, F, T)
        return {
          ...r,
          _opening: reg.opening,
          _addition: reg.addition,
          _adjusted: reg.adjusted,
          _dispatch: reg.dispatch,
          _closing: reg.closing
        }
      }),
    [rows, F, T]
  )
  const q = search.trim().toLowerCase()
  // Everything except the settled switch. Splitting it out means the number on
  // the switch is counted from the same rows the register draws, so it can
  // never claim more (or fewer) than turning it on would show.
  const matchedRows = regRows
    .filter((r) => typeFilter === 'ALL' || String(r.supplier_type || '').toUpperCase() === typeFilter)
    .filter(
      (r) =>
        !q ||
        [r.bargain_no, r.supplier_name, r.oil_code, r.oil_name, r.broker_name, r.remarks].some((f) =>
          String(f || '').toLowerCase().includes(q)
        )
    )
  const visibleRows = matchedRows.filter((r) => inRegister(r, F, T, showZero))
  const settledCount = matchedRows.filter(
    (r) => inRegister(r, F, T, true) && !inRegister(r, F, T, false)
  ).length

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
  // Summary tiles start closed: the register below carries the same figures
  // per oil, so these are a glance, not the page.
  const [kpiOpen, setKpiOpen] = useState(false)
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
    const m = new Map<string, { count: number; opening: number; addition: number; adjusted: number; dispatch: number; closing: number; balValue: number; uom: string }>()
    for (const r of visibleRows) {
      const k = oilOf(r)
      if (!m.has(k)) m.set(k, { count: 0, opening: 0, addition: 0, adjusted: 0, dispatch: 0, closing: 0, balValue: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      g.count += 1
      g.opening += Number(r._opening) || 0
      g.addition += Number(r._addition) || 0
      g.adjusted += Number(r._adjusted) || 0
      g.dispatch += Number(r._dispatch) || 0
      g.closing += Number(r._closing) || 0
      g.balValue += (Number(r._closing) || 0) * (Number(r.rate_per_uom) || 0)
    }
    return m
  }, [visibleRows])

  // Grand total across the currently visible groups (matches the group bands).
  const grandVisible = useMemo(() => {
    let count = 0, opening = 0, addition = 0, adjusted = 0, dispatch = 0, closing = 0, balValue = 0
    for (const g of groupStats.values()) {
      count += g.count
      opening += g.opening
      addition += g.addition
      adjusted += g.adjusted
      dispatch += g.dispatch
      closing += g.closing
      balValue += g.balValue
    }
    return { count, opening, addition, adjusted, dispatch, closing, balValue }
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
      opening: number
      addition: number
      adjusted: number
      dispatch: number
      closing: number
    }
    const groups = new Map<string, Agg>()
    for (const r of regRows) {
      const key = oilOf(r)
      if (!groups.has(key))
        groups.set(key, { label: key, count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0, opening: 0, addition: 0, adjusted: 0, dispatch: 0, closing: 0 })
      const g = groups.get(key)!
      g.opening += Number(r._opening) || 0
      g.addition += Number(r._addition) || 0
      g.adjusted += Number(r._adjusted) || 0
      g.dispatch += Number(r._dispatch) || 0
      g.closing += Number(r._closing) || 0
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
        openValue: s.openValue + g.openValue,
        opening: s.opening + g.opening,
        addition: s.addition + g.addition,
        adjusted: s.adjusted + g.adjusted,
        dispatch: s.dispatch + g.dispatch,
        closing: s.closing + g.closing
      }),
      { count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0, opening: 0, addition: 0, adjusted: 0, dispatch: 0, closing: 0 }
    )
    return { groups: list, grand }
  }, [regRows])

  // Weighted average rate = total value ÷ total qty.
  const avgRate = (g: { total: number; qty: number }): number => (g.qty > 0 ? g.total / g.qty : 0)

  // A bargain is general, so only what draws on it has a company: the tanker
  // (through the invoice that booked it) and the consignment/direct purchase.
  // Downloaded with more than one company in the books, the detail sheet has to
  // say whose book each line landed in — otherwise KRFL and KRFIN rows sit
  // side by side unlabelled.
  const multiCo = companies.length > 1
  const coName = (id: unknown): string =>
    String(companies.find((c) => Number(c.id) === Number(id))?.name || '')
  // The colour picked for that company on the Companies page, or nothing —
  // which reads in the ordinary ink. Two companies' tankers sit in one list
  // here, and the colour is what tells them apart at a glance.
  const coColour = (id: unknown): string =>
    String(companies.find((c) => Number(c.id) === Number(id))?.colour || '')
  // A bargain is general: the company is whoever drew on it. Not drawn yet →
  // there is genuinely no company to name, and saying so beats a blank cell.
  const drawnCos = (r: Row): string => {
    const raw = String(r.drawn_companies || '').trim()
    if (!raw) return 'Not drawn yet'
    const names = raw.split(',').map((x) => x.trim()).filter(Boolean)
    return names.length > 1 ? `Both · ${names.join(' + ')}` : names[0]
  }

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
        ...(multiCo
          ? [{ header: 'Company', key: 'drawn_companies', value: (r: Row) => drawnCos(r) }]
          : []),
        { header: 'Opening', key: '_opening', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._opening) || 0 },
        { header: 'Addition', key: '_addition', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._addition) || 0 },
        { header: 'Adjusted', key: '_adjusted', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._adjusted) || 0 },
        { header: 'BG rate', key: 'rate_per_uom', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.rate_per_uom) || 0 },
        { header: 'Dispatch', key: '_dispatch', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._dispatch) || 0 },
        { header: 'Balance', key: '_closing', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r._closing) || 0 },
        { header: 'Total', key: 'total_amount', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.total_amount) || 0 }
      ],
      rows: [
        ...sortedRows,
        {
          bargain_no: 'GRAND TOTAL',
          _opening: grandVisible.opening,
          _addition: grandVisible.addition,
          _adjusted: grandVisible.adjusted,
          _dispatch: grandVisible.dispatch,
          _closing: grandVisible.closing,
          total_amount: sortedRows.reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0)
        }
      ],
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
            { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000' },
            { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000' },
            { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000' },
            { header: 'Tanker', key: 'tanker_no' },
            { header: 'Loaded on', key: 'loaded_date' },
            { header: 'Stage', key: 'stage' },
            { header: 'Invoice', key: 'invoice_no' },
            ...(multiCo ? [{ header: 'Company', key: 'company_name' as const }] : []),
            { header: 'Dis qty', key: 'dis_qty', align: 'right', numFmt: '#,##0.000' },
            { header: 'Received', key: 'received_qty', align: 'right', numFmt: '#,##0.000' },
            { header: 'Shortage', key: 'shortage', align: 'right', numFmt: '#,##0.000' },
            { header: 'Allowed MT', key: 'allowed_mt', align: 'right', numFmt: '#,##0.000' },
            // Only ever populated on an EX bargain's tanker rows, and only when
            // the shortage exceeds the allowed tolerance — see tankerDetailRows.
            { header: 'Deductible', key: 'deductible', align: 'right', numFmt: '#,##0.000' },
            { header: 'Status', key: 'status' },
            { header: 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000' },
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
      // Same rule the on-screen breakdown uses: EX puts the shortage risk
      // beyond the allowed tolerance on the supplier as a deductible; DLD
      // doesn't, since the transporter/company already absorbs it.
      const isEx = b.bargain_type === 'EX'
      const list = tankers.filter(
        (t) => Number(t.bargain_id) === id || (Number(t.extra_qty) > 0 && Number(t.extra_bargain_id) === id)
      )
      out.push({
        bargain_no: b.bargain_no || '',
        bargain_date: formatDate(b.bargain_date),
        supplier_name: b.supplier_name || '',
        oil: oilOf(b),
        rate: Number(b.rate_per_uom) || 0,
        // The parent row states the bargain's period register, so the grouped
        // sheet reads on its own without cross-checking the summary tab.
        opening: Number(b._opening) || 0,
        addition: Number(b._addition) || 0,
        adjusted: Number(b._adjusted) || 0,
        balance: Number(b._closing) || 0,
        dis_qty: Number(b._dispatch) || 0
      })
      for (const t of list) {
        const loaded = Number(t.loaded_qty) || 0
        const extra = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
        const isPrimary = Number(t.bargain_id) === id
        const share = isPrimary ? loaded - extra : extra
        // Receipts/shortage belong to the whole tanker — pro-rate by this
        // bargain's share of it, same as the on-screen breakdown.
        const shareRatio = loaded > 0 ? share / loaded : 1
        const rec = t.status === 'empty' && t.received_qty != null ? Number(t.received_qty) * shareRatio : null
        const shortage = rec != null ? Math.max(0, loaded - Number(t.received_qty)) * shareRatio : null
        const pct = Number(t.order_allowed_shortage_pct ?? b.allowed_shortage_pct ?? defaultShortagePct) || 0
        const allowedAmt = loaded > 0 ? (share * pct) / 100 : 0
        const deductible = isEx && shortage != null && shortage > allowedAmt ? shortage - allowedAmt : null
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
          company_name: coName(t.company_id),
          dis_qty: share,
          received_qty: rec != null ? rec : '',
          shortage: shortage != null ? shortage : '',
          allowed_mt: loaded > 0 ? allowedAmt : '',
          deductible: deductible != null ? deductible : '',
          status: deductible != null ? 'Deductible' : '',
          split: extra > 0 ? (isPrimary ? `split — ${extra} moved out` : 'split — excess share') : ''
        })
      }
      // MNC / direct purchases draw on a bargain without a tanker of their own.
      // The bargain's Dispatch figure counts them, so the sheet has to list
      // them too or its detail lines fall short of its own parent row.
      for (const d of draws.filter((x) => Number(x.bargain_id) === id)) {
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          supplier_name: '',
          oil: '',
          rate: Number(b.rate_per_uom) || 0,
          tanker_no: d.tanker_nos || '—',
          loaded_date: formatDate(d.order_date),
          stage: 'MNC / direct',
          invoice_no: d.invoice_no || '',
          company_name: String(d.company_name || coName(d.company_id)),
          dis_qty: Number(d.qty) || 0,
          received_qty: '',
          shortage: '',
          allowed_mt: '',
          deductible: '',
          status: '',
          split: ''
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
      opening: g.opening,
      addition: g.addition,
      adjusted: g.adjusted,
      dispatch: g.dispatch,
      closing: g.closing,
      balance: g.balance,
      qty: g.qty,
      avg: avgRate(g)
    }))
    const t = report.grand
    rows.push({
      label: 'GRAND TOTAL', openCount: t.openCount, count: t.count,
      opening: t.opening, addition: t.addition, adjusted: t.adjusted, dispatch: t.dispatch, closing: t.closing,
      balance: t.balance, qty: t.qty, avg: avgRate(t)
    })
    void exportRowsToExcel({
      filename: `bargain-report-by-oil-${todayISO()}`,
      sheetName: 'Bargain report',
      title: `Bargain report by oil (${formatDate(F)} — ${formatDate(T)})`,
      columns: [
        { header: 'Oil', key: 'label' },
        { header: 'Open bargains', key: 'openCount', align: 'right', numFmt: '#,##0' },
        { header: 'Total bargains', key: 'count', align: 'right', numFmt: '#,##0' },
        { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000' },
        { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000' },
        { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000' },
        { header: 'Dispatch', key: 'dispatch', align: 'right', numFmt: '#,##0.000' },
        { header: 'Closing', key: 'closing', align: 'right', numFmt: '#,##0.000' },
        { header: 'Bal qty (live)', key: 'balance', align: 'right', numFmt: '#,##0.000' },
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
                    <TableHead className="text-right text-amber-900">Opening</TableHead>
                    <TableHead className="text-right text-amber-900">Addition</TableHead>
                    <TableHead className="text-right text-amber-900">Adjusted</TableHead>
                    <TableHead className="text-right text-amber-900">Dispatch</TableHead>
                    <TableHead className="text-right text-amber-900">Closing</TableHead>
                    <TableHead className="text-right text-amber-900">Bal Qty</TableHead>
                    <TableHead className="text-right text-amber-900">Total qty</TableHead>
                    <TableHead className="text-right text-amber-900">Avg rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">No bargains yet.</TableCell>
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
                          <TableCell className="text-right tabular-nums">{formatNum(g.opening)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.addition)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.adjusted)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.dispatch)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatNum(g.closing)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.balance)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.qty)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(avgRate(g))}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell>Grand total</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.openCount}</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.opening)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.addition)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.adjusted)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.dispatch)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatNum(report.grand.closing)}</TableCell>
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
              Opening / Addition / Dispatch / Closing follow the register's date range. Open = bargains with balance quantity left; Bal Qty is the live open quantity. Avg rate is weighted (total value ÷ total qty).
            </p>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'mb-4 flex flex-wrap items-center gap-x-3 gap-y-2',
                // One white card, one height for everything on it — the
                // pickers arrive at 32px, 36px and 40px otherwise.
                __WEB__ &&
                  '!mb-3 !gap-x-2.5 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-4 !py-3 [&_input]:!h-10 [&_input]:!rounded-[4px] [&_input]:!text-[13px] [&_[data-slot=select-trigger]]:!h-10 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=date-picker]]:!h-10 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[12.5px] [&>label>button]:!h-auto'
              )}
            >
              {/* One dropdown rather than a chip per category — the list grows
                  with the Products master, so a row of chips only ever gets
                  longer and starts scrolling sideways. */}
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-9 w-48 shrink-0 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {TYPE_FILTERS.map((t) => (
                    <SelectItem key={t} value={t} className="text-[13px]">
                      {t === 'ALL' ? 'All categories' : t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {companies.length > 1 && (
                <Select
                  value={coIds.length === 1 ? String(coIds[0]) : 'all'}
                  onValueChange={(v) => setCoIds(v === 'all' ? [] : [Number(v)])}
                >
                  <SelectTrigger className="h-9 w-[13rem] shrink-0 text-[13px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <SelectValue />
                    </span>
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="all" className="text-[13px]">All companies</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={String(c.id)} value={String(c.id)} className="text-[13px]">
                        {String(c.name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="relative min-w-[180px] flex-1 basis-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  className="h-9 pl-8"
                  placeholder="Search bargain no, supplier, oil, broker…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[13px]">
                <span className={cn('text-muted-foreground', __WEB__ && '!text-[10.5px] !font-extrabold !uppercase !tracking-[.13em] !text-[#5A6B62]')}>Date</span>
                <FyPicker from={dateFrom} to={dateTo} onRange={(f, t) => { setDateFrom(f); setDateTo(t) }} className="h-9 w-28 text-xs" />
                <DatePicker value={dateFrom} onChange={(v) => setDateFrom(v || '')} max={dateTo || undefined} className="w-[8.5rem]" />
                <span className={cn('text-muted-foreground', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>to</span>
                <DatePicker value={dateTo} onChange={(v) => setDateTo(v || '')} min={dateFrom || undefined} className="w-[8.5rem]" />
                {(dateFrom || dateTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('h-8 text-muted-foreground', __WEB__ && '!px-2.5 !font-extrabold !uppercase !tracking-[.05em] !text-[#0B6B45]')}
                    onClick={() => { setDateFrom(''); setDateTo('') }}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <label className={cn('ml-auto flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[13px] text-muted-foreground', __WEB__ && '!h-[38px] !gap-2.5 !rounded-[4px] !border !border-[#C3D2C6] !bg-white !px-3 !text-[12.5px] !font-bold !text-[#33473E] hover:!bg-[#F7FAF6]')}>
                <Switch checked={showZero} onCheckedChange={setShowZero} />
                Show settled {__WEB__ ? <span className="font-semibold text-[#7C9188]">(0 balance)</span> : '(0 balance)'}
                {/* The count, so the switch can be seen to have done something
                    even when the rows it adds are inside collapsed oil bands —
                    and so that "nothing to add" reads as an answer rather than
                    as a control that ignored the click. */}
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums',
                    settledCount === 0 ? 'bg-muted text-muted-foreground' : 'bg-[#EAF0E9] text-[#33473E]'
                  )}
                >
                  {settledCount}
                </span>
              </label>
            </div>

            {/* Summary. Every figure is read off grandVisible — the sum of
                the same groupStats the bands below are drawn from — so a tile
                can never state something the register contradicts. */}
            {__WEB__ && sortedRows.length > 0 && (
              <div className="mb-3 overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <button
                  type="button"
                  aria-expanded={kpiOpen}
                  onClick={() => setKpiOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 px-3.5 py-2 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62] transition-colors hover:bg-[#F7FAF6]"
                >
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-[#12855A] transition-transform', !kpiOpen && '-rotate-90')} />
                  Summary
                  <span className="ml-1 rounded-[2px] bg-[#EAF0E9] px-1.5 py-[2px] text-[11px] font-extrabold tabular-nums tracking-normal text-[#33473E]">
                    {formatNum(grandVisible.closing)} MT open
                  </span>
                </button>
                {kpiOpen && (
                  <div className="grid gap-2.5 px-3.5 pb-3.5 pt-1 sm:grid-cols-2 xl:grid-cols-4">
                    {(() => {
                      const contracted = grandVisible.opening + grandVisible.addition + grandVisible.adjusted
                      return [
                        {
                          k: 'Bargains open',
                          v: String(grandVisible.count),
                          unit: '',
                          sub: `across ${groupStats.size} oil type${groupStats.size === 1 ? '' : 's'}`,
                          accent: '#0B3D2E'
                        },
                        {
                          k: 'Contracted',
                          v: formatNum(contracted),
                          unit: 'MT',
                          sub: grandVisible.opening ? `${formatNum(grandVisible.opening)} MT opening carried in` : 'nothing carried in',
                          accent: '#12855A'
                        },
                        {
                          k: 'Dispatched',
                          v: formatNum(grandVisible.dispatch),
                          unit: 'MT',
                          sub: contracted > 0 ? `${Math.round((grandVisible.dispatch / contracted) * 100)}% of contracted` : 'nothing contracted',
                          accent: '#C2700A'
                        },
                        {
                          k: 'Balance open',
                          v: formatNum(grandVisible.closing),
                          unit: 'MT',
                          sub: `${formatINR(grandVisible.balValue)} still to draw`,
                          accent: '#C7F03F'
                        }
                      ]
                    })().map((k) => (
                      <div
                        key={k.k}
                        className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
                        style={{ borderTop: `3px solid ${k.accent}` }}
                      >
                        <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
                        <div className="mt-1 flex items-baseline gap-1.5">
                          <span className="text-[23px] font-bold leading-none tracking-[-0.035em] tabular-nums">{k.v}</span>
                          {k.unit && <span className="text-[11px] font-bold text-[#5A6B62]">{k.unit}</span>}
                        </div>
                        <div className="mt-1 truncate text-[11.5px] font-semibold text-[#5A6B62]" title={k.sub}>{k.sub}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className={cn('rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
              {/* Nothing wraps: a bargain number split over three lines and a
                  stacked date are exactly what this register is scanned for.
                  The wrapper already scrolls, so it slides sideways instead. */}
              <Table
                wrapperClassName={cn('max-h-[calc(100vh-215px)] rounded-xl', __WEB__ && '!rounded-[4px]')}
                className={cn(
                  'min-w-[860px] text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:h-9',
                  __WEB__ &&
                    '!min-w-[1074px] !table-fixed [&_td]:!whitespace-nowrap [&_td]:!truncate [&_td]:!px-2 [&_th]:!whitespace-nowrap [&_th]:!px-2 [&_th]:!text-[10.5px] [&_th]:!font-semibold [&_th]:!tracking-[.04em] [&_th_button]:!text-[10.5px] [&_th_button]:!font-semibold'
                )}
              >
                {/* The widths, stated once. table-fixed cannot read them off
                    the header here — its first row is the group band, whose
                    cells span three columns at a time — so a colgroup is the
                    only place they can live. They add to 1074, the table's
                    floor, so a 13" screen fits without zooming out and
                    anything narrower slides. */}
                {__WEB__ && (
                  <colgroup>
                    {[112, 91, 100, 69, 62, 69, 71, 69, 95, 65, 76, 128, 67].map((w, i) => (
                      <col key={i} style={{ width: `${w}px` }} />
                    ))}
                  </colgroup>
                )}
                <TableHeader className={cn(__WEB__ && '[&_th]:!h-10')}>
                  {/* A band naming what the column sets below mean, so Opening
                      / Addition / Adjusted read as one idea and Dispatch as
                      another — without renaming or merging any column. */}
                  {__WEB__ && (
                    <TableRow className="!border-b-0 hover:!bg-transparent [&>th]:!sticky [&>th]:!top-0 [&>th]:!z-20 [&>th]:!h-[30px] [&>th]:!bg-[#072B20] [&>th]:!text-center [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.14em] [&>th]:!text-white">
                      <TableHead colSpan={5} />
                      <TableHead colSpan={3} className={cn(PB_HBAND, '!border-l !border-l-[#C7F03F]/20 !border-r !border-r-[#C7F03F]/20')}>
                        Contracted qty
                      </TableHead>
                      <TableHead />
                      <TableHead className={cn(PB_HBAND, '!border-l !border-l-[#C7F03F]/20 !border-r !border-r-[#C7F03F]/20')}>Moved</TableHead>
                      <TableHead className={PB_HOPEN}>Open</TableHead>
                      <TableHead colSpan={2} />
                    </TableRow>
                  )}
                  <TableRow className={cn(__WEB__ && 'hover:!bg-transparent')}>
                    {(
                      [
                        { id: 'bargain_no', label: 'Bargain no' },
                        { id: 'bargain_date', label: 'Date' },
                        { id: 'supplier', label: 'Supplier' },
                        { id: 'oil', label: 'Oil' },
                        { id: 'condition', label: __WEB__ ? 'Cond.' : 'Condition' },
                        { id: 'qty', label: 'Opening', right: true },
                        { id: 'addition', label: 'Addition', right: true },
                        { id: 'adjusted', label: 'Adjusted', right: true },
                        { id: 'rate', label: 'BG rate', right: true },
                        { id: 'dispatch', label: 'Dispatch', right: true },
                        { id: 'balance', label: 'Balance', right: true },
                        { id: 'total', label: 'Total', right: true }
                      ] as { id: string; label: string; right?: boolean }[]
                    ).map((c) => (
                      <TableHead
                        key={c.id}
                        className={cn(
                          'sticky top-0 z-20 bg-slate-100 text-[11px] font-semibold uppercase tracking-wide text-foreground',
                          c.right && 'text-right',
                          __WEB__ && '!top-[30px] !h-11 !bg-[#0B3D2E] !text-[12px] !font-extrabold !tracking-[.07em] !text-[#DCEFE4]',
                          __WEB__ && c.id === 'qty' && PB_HGL,
                          __WEB__ && c.id === 'addition' && PB_HG,
                          __WEB__ && c.id === 'adjusted' && PB_HGR,
                          __WEB__ && c.id === 'dispatch' && cn(PB_HGL, '!border-r !border-r-[#C7F03F]/20'),
                          __WEB__ && c.id === 'balance' && PB_HOPEN
                        )}
                      >
                        <button
                          onClick={() => toggleSort(c.id)}
                          className={cn(
                            // uppercase repeated here on purpose: Tailwind's
                            // preflight sets `text-transform: none` on every
                            // <button>, so the th's own uppercase never reached
                            // the label inside it — which is why these headers
                            // read "Bargain no" while the plain Actions th two
                            // cells over read "ACTIONS".
                            'inline-flex items-center gap-1 uppercase transition-colors hover:text-foreground',
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
                    <TableHead className={cn('sticky top-0 z-20 bg-slate-100 w-[90px] text-right text-[11px] font-semibold uppercase tracking-wide text-foreground', __WEB__ && '!top-[30px] !h-11 !bg-[#0B3D2E] !text-[12px] !font-extrabold !tracking-[.07em] !text-[#DCEFE4]')}>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : sortedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                        {rows.length === 0
                          ? 'No bargains yet. Click “New bargain” to add one.'
                          : `No ${typeFilter === 'ALL' ? '' : typeFilter + ' '}bargains to show.`}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                    <TableRow
                      className={cn(
                        'border-y-2 border-amber-500 bg-amber-100 hover:bg-amber-100',
                        // Lime family, not the page's greens — the total of
                        // everything has to look unlike the group bands it
                        // sums, or it reads as one more of them.
                        __WEB__ && '!border-y-0 !border-b-2 !border-b-[#0B3D2E] !bg-[#EDF7D4] hover:!bg-[#EDF7D4] [&>td]:!h-[46px] [&>td]:!text-[13px] [&>td]:!text-[#2E4A0B]'
                      )}
                    >
                      <TableCell colSpan={5} className={cn('py-2 text-xs font-bold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[11px] !font-extrabold !tracking-[.1em] !text-[#2E4A0B]')}>
                        Grand total
                        <span className={cn('ml-1 font-medium normal-case tracking-normal text-amber-700', __WEB__ && '!ml-1.5 !text-[12px] !font-semibold !text-[#5B7226]')}>
                          · {grandVisible.count} bargain{grandVisible.count === 1 ? '' : 's'}
                        </span>
                      </TableCell>
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-l !border-l-[#CBE0A0] !text-[13px] !text-[#2E4A0B]')}>{formatNum(grandVisible.opening)}</TableCell>
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !text-[13px] !text-[#2E4A0B]')}>{formatNum(grandVisible.addition)}</TableCell>
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-r !border-r-[#CBE0A0] !text-[13px] !text-[#2E4A0B]')}>{formatNum(grandVisible.adjusted)}</TableCell>
                      <TableCell className="py-2" />
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-l !border-l-[#CBE0A0] !border-r !border-r-[#CBE0A0] !text-[13px] !text-[#2E4A0B]')}>{formatNum(grandVisible.dispatch)}</TableCell>
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#C7F03F] !text-[14px] !tracking-[-0.02em] !text-[#12280B]')}>{formatNum(grandVisible.closing)}</TableCell>
                      <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!text-[13px] !text-[#2E4A0B]')}>{formatINR(grandVisible.balValue)}</TableCell>
                      <TableCell className="py-2" />
                    </TableRow>
                    {sortedRows.map((row, i) => {
                      const oil = oilOf(row)
                      const newGroup =
                        groupedByOil && (i === 0 || oil !== oilOf(sortedRows[i - 1]))
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
                              className={cn(
                                'cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70',
                                // An oil band, not a second header: a forest left
                                // edge when open marks which rows belong to it.
                                __WEB__ && '!border-y-0 !border-b !border-b-[#DCE7DB] !border-l-[3px] [&>td]:!h-[44px]',
                                __WEB__ && (isCollapsed ? '!border-l-[#C3D2C6] !bg-[#F1F5EF] hover:!bg-[#E4ECE3]' : '!border-l-[#0B3D2E] !bg-[#E4ECE3] hover:!bg-[#E4ECE3]')
                              )}
                              onClick={() => toggleGroup(oil)}
                            >
                              <TableCell colSpan={5} className="py-1.5">
                                <span className={cn('inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700', __WEB__ && '!gap-2.5 !text-[13.5px] !font-extrabold !tracking-[.01em] !text-[#0A1F17]')}>
                                  {isCollapsed ? <ChevronRight className={cn('h-3.5 w-3.5', __WEB__ && '!h-[18px] !w-[18px] !text-[#5A6B62]')} /> : <ChevronDown className={cn('h-3.5 w-3.5', __WEB__ && '!h-[18px] !w-[18px] !text-[#5A6B62]')} />}
                                  {oil}
                                  <span className={cn('font-medium normal-case tracking-normal text-slate-500', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>
                                    · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-l !border-l-[#DCE7DB] !text-[12.5px]', __WEB__ && ((g?.opening ?? 0) ? '!text-[#0A1F17]' : '!text-[#8AA096]'))}>{formatNum(g?.opening ?? 0)}</TableCell>
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!text-[12.5px]', __WEB__ && ((g?.addition ?? 0) ? '!text-[#0A1F17]' : '!text-[#8AA096]'))}>{formatNum(g?.addition ?? 0)}</TableCell>
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-r !border-r-[#DCE7DB] !text-[12.5px]', __WEB__ && ((g?.adjusted ?? 0) ? '!text-[#0A1F17]' : '!text-[#8AA096]'))}>{formatNum(g?.adjusted ?? 0)}</TableCell>
                              <TableCell className="py-1.5" />
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-l !border-l-[#DCE7DB] !border-r !border-r-[#DCE7DB] !text-[12.5px]', __WEB__ && ((g?.dispatch ?? 0) ? '!text-[#0A1F17]' : '!text-[#8AA096]'))}>{formatNum(g?.dispatch ?? 0)}</TableCell>
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && PB_BAL, __WEB__ && '!text-[13px] !text-[#0A1F17]')}>
                                {formatNum(g?.closing ?? 0)}
                              </TableCell>
                              <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!text-[12.5px] !text-[#0A1F17]')}>{formatINR(g?.balValue ?? 0)}</TableCell>
                              <TableCell className="py-1.5" />
                            </TableRow>
                          )}
                          {!isCollapsed && (
                          <>
                          <TableRow
                            className={cn(
                              'cursor-pointer transition-colors',
                              expanded.has(Number(row.id)) ? 'bg-slate-100 hover:bg-slate-100' : 'hover:bg-muted/40',
                              __WEB__ && '!border-b-[#EAF0E9] !border-l-[3px] !border-l-[#DCE7DB] [&>td]:!py-2.5',
                              __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white hover:!bg-white' : '!bg-white hover:!bg-[#F7FAF6]')
                            )}
                            onClick={() => toggleExpand(Number(row.id))}
                          >
                          <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !tracking-[-0.02em]')}>
                            <ChevronRight
                              className={cn(
                                'mr-1 inline h-3.5 w-3.5 text-muted-foreground transition-transform',
                                expanded.has(Number(row.id)) && 'rotate-90',
                                __WEB__ && '!mr-2 !h-[18px] !w-[18px] !text-[#A8B8AE]'
                              )}
                            />
                            <span className={cn('mr-1 tabular-nums text-muted-foreground', __WEB__ && '!mr-2 !text-[10.5px] !font-bold !text-[#5A6B62]')}>{seq}.</span>
                            <span className={cn(__WEB__ && '!truncate')} title={String(row.bargain_no || '')}>
                              {row.bargain_no}
                            </span>
                          </TableCell>
                          <TableCell className={cn('whitespace-nowrap text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#5A6B62]')}>{formatDate(row.bargain_date)}</TableCell>
                          <TableCell className={cn('max-w-[160px] truncate', __WEB__ && '!text-[12.5px] !font-bold')} title={row.supplier_name ?? ''}>{row.supplier_name ?? '—'}</TableCell>
                          <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-[11.5px] !font-bold !text-[#5A6B62]')}>{row.oil_code}</TableCell>
                          <TableCell>
                            <Badge
                              variant={row.bargain_type === 'DLD' || row.bargain_type === 'Delivered' ? 'secondary' : 'muted'}
                              className={cn('text-[10px]', __WEB__ && '!rounded-[2px] !border-0 !bg-[#EAF0E9] !px-1.5 !py-1 !text-[10.5px] !font-extrabold !tracking-[.06em] !text-[#33473E]')}
                            >
                              {row.bargain_type}
                            </Badge>
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white' : PB_GL), __WEB__ && (Number(row._opening) ? '!text-[12.5px] !font-bold !text-[#0A1F17]' : '!text-[12.5px] !font-medium !text-[#C3D2C6]'))}>{Number(row._opening) ? formatNum(row._opening) : '—'}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white' : PB_G), __WEB__ && '!text-[13px] !font-bold')}>{Number(row._addition) ? formatNum(row._addition) : '—'}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white' : PB_GR), __WEB__ && (Number(row._adjusted) ? '!text-[12.5px] !font-bold' : '!text-[12.5px] !font-medium !text-[#C3D2C6]'))}>
                            <span className={cn(Number(row._adjusted) < -1e-9 ? 'text-red-600' : Number(row._adjusted) > 0 ? 'text-emerald-700' : '', __WEB__ && Number(row._adjusted) !== 0 && '!text-[#8A5300]')}>
                              {Number(row._adjusted) ? formatNum(row._adjusted) : '—'}
                            </span>
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[12.5px] !font-bold')}>{formatINR(row.rate_per_uom)}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', Number(row._dispatch) && 'font-bold text-red-600', __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white !border-l !border-l-[#EAF0E9] !border-r !border-r-[#EAF0E9]' : cn(PB_GL, PB_GR)), __WEB__ && (Number(row._dispatch) ? '!text-[13px] !font-bold !text-[#0A1F17]' : '!text-[12.5px] !font-medium !text-[#C3D2C6]'))}>{Number(row._dispatch) ? formatNum(row._dispatch) : '—'}</TableCell>
                          <TableCell className={cn('text-right font-semibold tabular-nums', __WEB__ && (expanded.has(Number(row.id)) ? '!bg-white' : PB_BAL))}>
                            {__WEB__ ? (() => {
                              const b = pbBar(Number(row._opening) || 0, Number(row._addition) || 0, Number(row._adjusted) || 0, Number(row._dispatch) || 0)
                              return (
                                <>
                                  <div className={cn('text-[13.5px] font-bold', Number(row._closing) < -1e-9 ? 'text-[#B3261E]' : b.pct >= 95 ? 'text-[#8A5300]' : 'text-[#0A1F17]')}>
                                    {formatNum(row._closing)}
                                  </div>
                                </>
                              )
                            })() : (
                              <span className={Number(row._closing) < -1e-9 ? 'text-red-600' : ''}>
                                {formatNum(row._closing)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[12.5px] !font-bold')}>
                            {formatINR(row.total_amount)}
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-1">
                              {/* One ⋮ rather than three icon buttons: the row's
                                  own click already opens its tankers, so nothing
                                  here is the primary action and none of the
                                  three earns permanent width. */}
                              <RowActions
                                actions={[
                                  { label: 'Add / remove balance qty', icon: SlidersHorizontal, onClick: () => openAdjust(row) },
                                  { label: 'Edit bargain', icon: Pencil, onClick: () => openEdit(row) },
                                  { label: 'Delete bargain', icon: Trash2, danger: true, onClick: () => del(row) }
                                ]}
                              />
                            </div>
                          </TableCell>
                          </TableRow>
                          {expanded.has(Number(row.id)) && (
                            <TableRow className={cn('bg-slate-200 hover:bg-slate-200', __WEB__ && '!border-l-[3px] !border-l-[#C3D2C6] !bg-[#F1F5EF] hover:!bg-[#F1F5EF]')}>
                              <TableCell colSpan={13} className="p-0">
                                {(() => {
                                  // A tanker may be split across two bargains (excess loading):
                                  // its bargain gets loaded − extra, the auto-created line gets extra.
                                  const list = tankers.filter(
                                    (t) =>
                                      (Number(t.bargain_id) === Number(row.id) ||
                                        (Number(t.extra_qty) > 0 && Number(t.extra_bargain_id) === Number(row.id))) &&
                                      // The register's figures are already scoped to
                                      // the picked companies; the tanker list has to
                                      // agree or the two stop adding up.
                                      (coIds.length === 0 || coIds.includes(Number(t.company_id)))
                                  )
                                  // Consignment / direct purchases draw on a bargain
                                  // without a tanker of their own, so they are listed
                                  // separately from the tanker table.
                                  const drawn = draws.filter((d) => Number(d.bargain_id) === Number(row.id))
                                  const drawnBlock = drawn.length ? (
                                    <div className={cn('mb-2 overflow-hidden rounded-md border border-violet-200', __WEB__ && '!mb-2.5 !rounded-[4px] !border-[#D6E2D6]')}>
                                      <div className={cn('flex items-center justify-between bg-violet-100/70 px-3 py-1', __WEB__ && '!border-b !border-b-[#E4ECE3] !bg-[#EAF0E9] !px-3.5 !py-2.5')}>
                                        <span className={cn('text-[10px] font-semibold uppercase tracking-wide text-violet-900', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.1em] !text-[#33473E]')}>
                                          MNC / direct purchases on this bargain
                                        </span>
                                        <span className={cn('text-[11px] font-bold tabular-nums text-violet-900', __WEB__ && '!text-[12.5px] !text-[#0A1F17]')}>
                                          {formatNum(drawn.reduce((a, d) => a + (Number(d.qty) || 0), 0))} {row.uom}
                                        </span>
                                      </div>
                                      <table className="w-full bg-white text-[11px]">
                                        <thead>
                                          <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                                            <th className="px-3 py-1">Invoice</th>
                                            <th className="px-3 py-1">Date</th>
                                            {companies.length > 1 && <th className="px-3 py-1">Co.</th>}
                                            <th className="px-3 py-1">Party</th>
                                            <th className="px-3 py-1">Tanker(s)</th>
                                            <th className="px-3 py-1 text-right">Drawn</th>
                                            <th className="px-3 py-1 text-right">Invoice rate</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {drawn.map((d) => (
                                            <tr
                                              key={`${d.order_id}-${d.bargain_id}`}
                                              className={cn('border-b last:border-0', d.order_id && onOpenOrder && 'cursor-pointer hover:bg-sky-50')}
                                              title={d.order_id ? 'Open the purchase invoice' : undefined}
                                              onClick={() => d.order_id && onOpenOrder?.(Number(d.order_id))}
                                            >
                                              <td className="px-3 py-1 font-medium">{d.invoice_no}</td>
                                              <td className="whitespace-nowrap px-3 py-1">{formatDate(d.order_date)}</td>
                                              {companies.length > 1 && (
                                                <td className="whitespace-nowrap px-3 py-1 text-muted-foreground">
                                                  {String(d.company_name || '—')}
                                                </td>
                                              )}
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
                                      <div className={cn('bg-slate-200 px-6 py-4', __WEB__ && '!border-b !border-b-[#DCE7DB] !bg-[#F1F5EF] !py-3.5 !pl-10 !pr-4')}>
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
                                  // EX bargains put the shortage risk beyond the allowed
                                  // tolerance on the supplier — the excess becomes a
                                  // deductible, unlike DLD where the transporter/company
                                  // already absorbs it through freight/shortage handling.
                                  const isEx = row.bargain_type === 'EX'
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
                                    <div className={cn('bg-slate-200 px-6 py-4', __WEB__ && '!border-b !border-b-[#DCE7DB] !bg-[#F1F5EF] !py-3.5 !pl-10 !pr-4')}>
                                      {remarksLine}
                                      {drawnBlock}
                                      <div className={cn(__WEB__ && 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white')}>
                                      <table className={cn('overflow-hidden rounded-lg border border-slate-300 bg-card text-xs shadow-sm [&_td]:pl-3 [&_th]:pl-3', __WEB__ && '!w-full !rounded-none !border-0 !shadow-none')}>
                                        <thead>
                                          <tr className={cn('border-b bg-slate-200/70 text-left text-slate-700', __WEB__ && '!border-b-[#D6E2D6] !bg-[#EAF0E9] [&>th]:!h-[34px] [&>th]:!py-0 [&>th]:!text-[10px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.09em] [&>th]:!text-[#33473E]')}>
                                            <th className="py-1.5 pr-3 font-semibold w-8">#</th>
                                            <th className="py-1.5 pr-3 font-semibold">Tanker</th>
                                            <th className="py-1.5 pr-3 font-semibold">Loading Date</th>
                                            <th className="py-1.5 pr-3 font-semibold">Receipt Date</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Dis Qty</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Rec Qty</th>
                                            <th className="py-1.5 pr-3 text-right font-semibold">Shortage</th>
                                            <th className={cn('py-1.5 text-right font-semibold', isEx && 'pr-3')}>Allowed MT</th>
                                            {isEx && (
                                              <>
                                                <th className="py-1.5 pr-3 text-right font-semibold">Deductible</th>
                                                <th className="py-1.5 text-right font-semibold">Status</th>
                                              </>
                                            )}
                                            {/* Whose book the tanker went through. A bargain
                                                is general — either company can draw on it —
                                                so the tanker is the level where that is
                                                actually decided. */}
                                            <th className="py-1.5 pr-3 text-left font-semibold">Company</th>
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
                                            const allowedAmt = loaded > 0 ? (dis * pctOf(t)) / 100 : 0
                                            const deductible = isEx && shortage != null && shortage > allowedAmt ? shortage - allowedAmt : null
                                            return (
                                              <tr
                                                key={t.id as number}
                                                className={cn(
                                                  'border-b',
                                                  ti % 2 === 1 ? 'bg-muted/40' : 'bg-card',
                                                  t.order_id && onOpenOrder && 'cursor-pointer hover:bg-sky-50',
                                                  // Zebra stripes go: the left mark
                                                  // carries the only distinction that
                                                  // matters here — did this tanker cost
                                                  // the supplier a deduction.
                                                  __WEB__ && '!border-b-[#EAF0E9] !border-l-[3px] [&>td]:!h-[48px] [&>td]:!py-0',
                                                  __WEB__ && (deductible != null ? '!border-l-[#B3261E] !bg-[#FDF3F2]' : '!border-l-[#12855A] !bg-white'),
                                                  __WEB__ && t.order_id && onOpenOrder && 'hover:!bg-[#F7FAF6]'
                                                )}
                                                title={t.order_id ? 'Open the purchase invoice' : 'Not billed yet'}
                                                onClick={() => t.order_id && onOpenOrder?.(Number(t.order_id))}
                                              >
                                                <td className={cn('py-1.5 pr-3 tabular-nums text-muted-foreground', __WEB__ && '!text-[10px] !font-bold !text-[#5A6B62]')}>{ti + 1}</td>
                                                <td className={cn('py-1.5 pr-3 font-medium', __WEB__ && '!text-[12.5px] !font-bold')}>
                                                  {t.tanker_no}
                                                  {split && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(split)</span>}
                                                </td>
                                                <td className={cn('py-1.5 pr-3', __WEB__ && '!text-[12px] !font-semibold !tabular-nums !text-[#5A6B62]')}>{loaded > 0 ? formatDate(t.loaded_date) : '—'}</td>
                                                <td className={cn('py-1.5 pr-3', __WEB__ && '!text-[12px] !font-semibold !tabular-nums !text-[#5A6B62]')}>{t.empty_date ? formatDate(t.empty_date) : '—'}</td>
                                                <td className={cn('py-1.5 pr-3 text-right tabular-nums font-medium text-red-600', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{loaded > 0 ? formatNum(dis) : '—'}</td>
                                                <td className={cn('py-1.5 pr-3 text-right tabular-nums', __WEB__ && '!text-[12.5px] !font-bold')}>{rec != null ? formatNum(rec) : '—'}</td>
                                                <td className="py-1.5 pr-3 text-right tabular-nums">
                                                  {/* The figure alone. The bar that used to sit under it
                                                      measured the shortage against its allowance — the same
                                                      species of bar the client had removed from the Balance
                                                      column, and the Allowed MT figure is right beside it
                                                      anyway. */}
                                                  {__WEB__ && shortage != null ? (
                                                    <div
                                                      className={cn('text-[12.5px] font-bold', deductible != null ? 'text-[#B3261E]' : 'text-[#8A5300]')}
                                                      title={
                                                        allowedAmt > 0
                                                          ? `${formatNum(shortage)} against an allowance of ${formatNum(allowedAmt)}`
                                                          : undefined
                                                      }
                                                    >
                                                      {formatNum(shortage)}
                                                    </div>
                                                  ) : shortage != null ? (
                                                    <span className={shortage > 0 ? 'text-amber-700' : ''}>{formatNum(shortage)}</span>
                                                  ) : '—'}
                                                </td>
                                                <td className={cn('py-1.5 text-right tabular-nums', isEx && 'pr-3', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>{loaded > 0 ? formatNum(allowedAmt) : '—'}</td>
                                                {isEx && (
                                                  <>
                                                    <td className={cn('py-1.5 pr-3 text-right tabular-nums text-red-600', __WEB__ && (deductible != null ? '!text-[12.5px] !font-bold !text-[#B3261E]' : '!text-[12.5px] !text-[#C3D2C6]'))}>{deductible != null ? formatNum(deductible) : __WEB__ ? '—' : ''}</td>
                                                    <td className={cn('py-1.5 text-right', __WEB__ && '!pr-3')}>
                                                      {__WEB__ ? (
                                                        <span
                                                          className={cn(
                                                            'inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold',
                                                            deductible != null ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]' : 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                                          )}
                                                        >
                                                          {deductible != null ? <MinusCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                                                          {deductible != null ? 'Deductible' : 'Within allowance'}
                                                        </span>
                                                      ) : deductible != null ? <Badge variant="destructive" className="text-[10px]">Deductible</Badge> : ''}
                                                    </td>
                                                  </>
                                                )}
                                                {/* The invoice's company where the tanker has
                                                    been mapped into one, and the tanker's own
                                                    until then — that is the order in which it
                                                    is actually decided. */}
                                                <td className={cn('py-1.5 pr-3', __WEB__ && '!text-[12px] !font-bold !text-[#33473E]')}>
                                                  {(() => {
                                                    const co = coName(t.invoice_company_id ?? t.company_id)
                                                    if (!co) return <span className={cn(__WEB__ && '!font-semibold !text-[#A8B8AE]')}>—</span>
                                                    const bg = coColour(t.invoice_company_id ?? t.company_id)
                                                    // The colour as the chip's ground rather than its
                                                    // ink: a pale pick is unreadable as text but reads
                                                    // perfectly as a background, and a filled chip
                                                    // tells two companies apart down a column far
                                                    // faster than two shades of lettering.
                                                    if (!__WEB__ || !bg) return co
                                                    return (
                                                      <span
                                                        className="inline-block whitespace-nowrap rounded-[2px] px-2 py-[3px] text-[11px] font-bold"
                                                        style={{ background: bg, color: inkOn(bg) }}
                                                      >
                                                        {co}
                                                      </span>
                                                    )
                                                  })()}
                                                </td>
                                              </tr>
                                            )
                                          })}
                                          <tr className={cn('border-t-2 border-amber-500 bg-amber-50 font-semibold text-amber-900', __WEB__ && '!border-t-0 !bg-[#C7F03F] !text-[#12280B] [&>td]:!h-[46px] [&>td]:!py-0')}>
                                            <td className={cn('py-1.5 pr-3', __WEB__ && '!pl-3 !text-[10.5px] !font-extrabold !uppercase !tracking-[.09em] !text-[#2E4A0B]')} colSpan={4}>
                                              Total{__WEB__ ? ` · ${list.length} tanker${list.length === 1 ? '' : 's'}` : ''}
                                            </td>
                                            <td className={cn('py-1.5 pr-3 text-right tabular-nums text-red-600', __WEB__ && '!text-[13px] !text-[#12280B]')}>{formatNum(tot.dis)}</td>
                                            <td className={cn('py-1.5 pr-3 text-right tabular-nums', __WEB__ && '!text-[13px] !text-[#12280B]')}>{formatNum(tot.rec)}</td>
                                            <td className={cn('py-1.5 pr-3 text-right tabular-nums', __WEB__ && '!text-[13px] !text-[#12280B]')}>{formatNum(tot.shortage)}</td>
                                            <td className={cn('py-1.5 text-right tabular-nums', isEx && 'pr-3', __WEB__ && '!text-[12.5px] !text-[#3F5A12]')}>{formatNum(tot.allowed)}</td>
                                            {isEx && (() => {
                                              const totDeductible = tot.shortage > tot.allowed ? tot.shortage - tot.allowed : null
                                              return (
                                                <>
                                                  <td className={cn('py-1.5 pr-3 text-right tabular-nums text-red-600', __WEB__ && '!text-[13px] !text-[#8C2F26]')}>{totDeductible != null ? formatNum(totDeductible) : __WEB__ ? '—' : ''}</td>
                                                  <td className={cn('py-1.5 text-right', __WEB__ && '!pr-3')}>
                                                    {__WEB__ ? (
                                                      totDeductible != null ? (
                                                        <span className="inline-flex items-center gap-1.5 rounded-[2px] bg-[#8C2F26] px-2 py-1 text-[10.5px] font-extrabold text-white">
                                                          <MinusCircle className="h-3.5 w-3.5" /> Deductible
                                                        </span>
                                                      ) : null
                                                    ) : totDeductible != null ? <Badge variant="destructive" className="text-[10px]">Deductible</Badge> : ''}
                                                  </td>
                                                </>
                                              )
                                            })()}
                                            <td className="py-1.5 pr-3" />
                                          </tr>
                                        </tbody>
                                      </table>
                                      </div>
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
              {__WEB__ && sortedRows.length > 0 && (
                <div className="flex items-center justify-between gap-3 border-t border-[#EAF0E9] px-4 py-3">
                  <div className="text-[12px] font-semibold text-[#5A6B62]">
                    {grandVisible.count} bargain{grandVisible.count === 1 ? '' : 's'} ·{' '}
                    {formatNum(grandVisible.opening + grandVisible.addition + grandVisible.adjusted)} MT contracted ·{' '}
                    {formatNum(grandVisible.closing)} MT balance
                  </div>
                  {(() => {
                    const oils = Array.from(groupStats.keys())
                    const allOpen = oils.length > 0 && oils.every((o) => openGroups.has(o))
                    return (
                      <button
                        type="button"
                        onClick={() => setOpenGroups(allOpen ? new Set<string>() : new Set(oils))}
                        className="flex items-center gap-1.5 text-[11.5px] font-extrabold uppercase tracking-[.05em] text-[#0B6B45] transition-colors hover:text-[#0B3D2E]"
                      >
                        <ChevronDown className={cn('h-[18px] w-[18px] transition-transform', allOpen && 'rotate-180')} />
                        {allOpen ? 'Collapse all' : 'Expand all'}
                      </button>
                    )
                  })()}
                </div>
              )}
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
            <div className="flex flex-col gap-1.5">
              <Label>Bargain date *</Label>
              <DatePicker
                min={minDate}
                value={form.bargain_date}
                onChange={(v) => setField('bargain_date', v)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Bargain no</Label>
              <Input
                value={(() => {
                  if (!editing) return 'Auto-generated'
                  // Nothing loaded yet — the number can still follow a changed
                  // supplier or product, so preview what saving will make it.
                  if (editLocked) return editing.bargain_no
                  const parts = String(editing.bargain_no || '').split('/')
                  if (parts.length !== 4) return editing.bargain_no
                  const norm = (s: string): string => s.replace(/\s+/g, '').toUpperCase()
                  const oil = categoryProducts.find((o) => String(o.id) === String(form.oil_type_id))
                  const sup = suppliers.find((s) => String(s.id) === String(form.supplier_id))
                  const oilSeg = oil ? norm(String(oil.code || oil.name || parts[0])) : parts[0]
                  const partySeg = sup ? norm(String(sup.name || parts[2])) : parts[2]
                  return `${oilSeg}/${parts[1]}/${partySeg}/${parts[3]}`
                })()}
                disabled
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(form.supplier_id)} onValueChange={(v) => setField('supplier_id', v)} disabled={editLocked}>
                <SelectTrigger>
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {bargainSuppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Product category *</Label>
              <Select value={String(form.product_category || '')} onValueChange={(v) => setField('product_category', v)} disabled={editLocked}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {productCategories.map((t) => (
                    <SelectItem
                      key={t.name}
                      value={t.name}
                      disabled={t.products === 0}
                      title={
                        t.products === 0
                          ? `No purchasable product is filed under ${t.name} — add one under Products with its sub-category set to Raw`
                          : undefined
                      }
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span>{t.name}</span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t.products === 0 ? 'no products' : `${t.products} product${t.products === 1 ? '' : 's'}`}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
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

            <div className="flex flex-col gap-1.5">
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

            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom} onChange={(v) => setField('uom', v)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Bargain qty *</Label>
              <Input type="number" min={editLocked ? editConsumed : 0} value={form.qty} onChange={(e) => setField('qty', e.target.value)} />
              {editLocked && Number(form.qty) < editConsumed - 1e-4 && (
                <span className="text-[11px] text-red-600">Cannot be below {formatNum(editConsumed)} already loaded.</span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Base rate (ex duty) *</Label>
              <Input
                type="number"
                value={form.base_rate}
                onChange={(e) => setField('base_rate', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Duty per {form.uom || 'MT'}</Label>
              <Input type="number" value={form.duty} onChange={(e) => setField('duty', e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Contract expiry</Label>
              {/* Nothing on or before the bargain date is selectable: a contract
                  cannot expire the day it was struck, let alone earlier. An
                  expiry already on the record that a later change to the
                  bargain date has invalidated is called out rather than
                  silently discarded -- both dates are the user's to fix. */}
              <DatePicker
                value={form.rate_expiry_date ?? ''}
                min={dayAfter(form.bargain_date)}
                onChange={(v) => setField('rate_expiry_date', v)}
              />
              {expiryProblem && <div className="text-[11px] font-medium text-destructive">{expiryProblem}</div>}
            </div>

            <div className="flex content-end flex-col gap-1.5">
              <Label>Bargain rate (base + duty)</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">
                {formatINR(bgRate)}
              </div>
            </div>
            <div className="flex content-end flex-col gap-1.5">
              <Label>Total bargain amount</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-semibold tabular-nums">
                {formatINR(total)}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
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
        <DialogContent
          className={cn(
            'max-w-md',
            // A right-hand drawer on the website, wide enough for the before /
            // after pair to sit side by side — the whole point of this panel is
            // seeing what the balance becomes before committing to it.
            __WEB__ &&
              '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[560px] !max-w-[95vw] !translate-x-0 !translate-y-0 !grid !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Adjust balance</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1.5 !break-all !text-[15px] !font-bold !leading-[1.35] !tracking-[-0.01em] !text-white')}>
              {__WEB__ ? adjustRow?.bargain_no : `Adjust balance — ${adjustRow?.bargain_no}`}
            </DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const qty = Number(adjustRow.qty) || 0
            // Rounded to the 3 decimals MT is tracked at — balance_qty is a
            // running total that can carry float residue past that, which made
            // squaring off to what the screen already shows as the full
            // balance look like an over-removal.
            const bal = Math.round((Number(adjustRow.balance_qty) || 0) * 1000) / 1000
            const consumed = qty - bal
            const amt = Number(adjustForm.amount) || 0
            const delta = adjustForm.mode === 'add' ? amt : -amt
            const newBal = bal + delta
            const uom = adjustRow.uom || 'MT'
            if (__WEB__) {
              // Display only — the same arithmetic the desktop panel shows,
              // drawn as before / after instead of on one line.
              const entered = amt > 0
              const over = adjustForm.mode === 'remove' && entered && newBal < -1e-9
              const newQty = qty + delta
              const pct = (v: number, of: number): number => (of > 0 ? Math.min(100, Math.max(0, (v / of) * 100)) : 0)
              const drawnOld = pct(consumed, qty)
              const drawnNew = pct(consumed, newQty)
              return (
                <>
                  <div className="min-h-0 overflow-y-auto px-[22px] py-4">
                    <div className="flex flex-col gap-4">
                      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                        <div className="grid grid-cols-3">
                          {[
                            { k: 'Bargain qty', v: formatNum(qty) },
                            { k: 'Loaded', v: formatNum(consumed) },
                            { k: 'Balance', v: formatNum(bal) }
                          ].map((st, i) => (
                            <div key={st.k} className={cn('px-3.5 py-3', i < 2 && 'border-r border-[#EAF0E9]')}>
                              <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{st.k}</div>
                              <div className="mt-1 flex items-baseline gap-1">
                                <span className="text-[19px] font-bold tracking-[-0.02em] tabular-nums">{st.v}</span>
                                <span className="text-[10.5px] font-bold text-[#5A6B62]">{uom}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="px-3.5 pb-3.5">
                          <div className="h-[7px] overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                            <div className="h-full bg-[#12855A]" style={{ width: `${drawnOld}%` }} />
                          </div>
                          <div className="mt-1.5 text-[11px] font-bold text-[#5A6B62]">
                            {Math.round(drawnOld)}% loaded · {formatNum(bal)} {uom} open today
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        {([
                          { m: 'add' as const, label: '+ Add to balance', on: 'border-[#12855A] bg-[#E9F5EE] text-[#0B6B45]' },
                          { m: 'remove' as const, label: '− Remove from balance', on: 'border-[#C2700A] bg-[#FFEDD0] text-[#8A5300]' }
                        ]).map((btn) => (
                          <button
                            key={btn.m}
                            type="button"
                            onClick={() => setAdjustForm((prev) => ({ ...prev, mode: btn.m }))}
                            className={cn(
                              'flex h-[50px] items-center justify-center gap-1.5 rounded-[4px] border-[1.5px] text-[13px] transition-colors',
                              adjustForm.mode === btn.m ? `${btn.on} font-extrabold` : 'border-[#C3D2C6] bg-white font-bold text-[#5A6B62] hover:bg-[#F7FAF6]'
                            )}
                          >
                            {btn.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-col gap-4 rounded-[4px] border border-[#D6E2D6] bg-white p-4">
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">
                            Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})
                          </div>
                          <Input
                            type="number"
                            autoFocus
                            value={adjustForm.amount}
                            onChange={(e) => setAdjustForm((prev) => ({ ...prev, amount: e.target.value }))}
                            className={cn(
                              '!h-[50px] !rounded-[4px] !text-[17px] !font-bold !tabular-nums',
                              over ? '!border-[#B3261E]' : entered ? '!border-[#C3D2C6]' : '!border-[#E3C58C]'
                            )}
                          />
                        </div>
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">Date</div>
                          <DatePicker
                            value={adjustForm.date}
                            onChange={(v) => setAdjustForm((prev) => ({ ...prev, date: v || '' }))}
                            className="!h-[50px] !rounded-[4px]"
                          />
                          <p className="mt-1.5 text-[12px] font-semibold text-[#5A6B62]">
                            Shown under &ldquo;Addition&rdquo; for this date&rsquo;s month in the register.
                          </p>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">
                            Note <span className="font-semibold text-[#5A6B62]">(optional)</span>
                          </div>
                          <Input
                            value={adjustForm.note}
                            onChange={(e) => setAdjustForm((prev) => ({ ...prev, note: e.target.value }))}
                            placeholder="Reason for the adjustment"
                            className="!h-[50px] !rounded-[4px] !text-[13.5px]"
                          />
                        </div>
                      </div>

                      {over && (
                        <div className="flex gap-2.5 rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-3">
                          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#B3261E]" />
                          <div className="text-[12.5px] font-semibold leading-relaxed text-[#8C2F26]">
                            Only {formatNum(bal)} {uom} is left on this bargain. Removing {formatNum(amt)} {uom} would take the balance below zero.
                          </div>
                        </div>
                      )}

                      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                        <div className="flex items-center justify-between gap-2.5 border-b border-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
                          <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">After this adjustment</span>
                          {entered && !over && (
                            <span className={cn('text-[12.5px] font-extrabold tabular-nums', delta >= 0 ? 'text-[#0B6B45]' : 'text-[#8A5300]')}>
                              {delta >= 0 ? '+' : '−'}{formatNum(Math.abs(delta))} {uom}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3 p-3.5">
                          <div>
                            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Bargain qty</div>
                            <div className="mt-1 text-[18px] font-bold tabular-nums">
                              {over ? '—' : formatNum(entered ? newQty : qty)}{' '}
                              <span className="text-[11px] font-semibold text-[#5A6B62]">{uom}</span>
                            </div>
                          </div>
                          <div>
                            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">New balance</div>
                            <div className={cn('mt-1 text-[18px] font-bold tabular-nums', !over && entered && newBal < -1e-9 && 'text-[#B3261E]')}>
                              {over ? '—' : formatNum(entered ? newBal : bal)}{' '}
                              <span className="text-[11px] font-semibold text-[#5A6B62]">{uom}</span>
                            </div>
                          </div>
                        </div>
                        <div className="px-3.5 pb-3.5">
                          <div className="h-[7px] overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                            <div
                              className="h-full"
                              style={{
                                width: `${over ? 0 : entered ? drawnNew : drawnOld}%`,
                                background: drawnNew >= 95 ? '#C2700A' : '#12855A'
                              }}
                            />
                          </div>
                          {!entered && !over && (
                            <div className="mt-2 text-[12px] font-semibold text-[#5A6B62]">Enter a quantity to see the new balance.</div>
                          )}
                          {over && (
                            <div className="mt-2 text-[12px] font-semibold text-[#5A6B62]">Reduce the quantity to see the new balance.</div>
                          )}
                        </div>
                      </div>

                      {adjustError && (
                        <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                          {adjustError}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
                    <button
                      type="button"
                      onClick={() => setAdjustRow(null)}
                      disabled={adjustSaving}
                      className="h-12 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-6 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#F7FAF6] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveAdjust}
                      disabled={adjustSaving}
                      className={cn(
                        'flex h-12 items-center gap-2 rounded-[4px] px-7 text-[13.5px] font-extrabold uppercase tracking-[.03em] transition-colors disabled:opacity-60',
                        entered && !over ? 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0F4A38]' : 'bg-[#33473E] text-white hover:bg-[#0B3D2E]'
                      )}
                    >
                      <Check className="h-5 w-5" /> {adjustSaving ? 'Saving…' : 'Apply'}
                    </button>
                  </div>
                </>
              )
            }
            return (
              <div className="flex flex-col gap-4">
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

                <div className="flex flex-col gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})</Label>
                  <Input
                    type="number"
                    autoFocus
                    value={adjustForm.amount}
                    onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))}
                  />
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
          {/* The website's drawer draws its own pinned footer inside the
              body above, so this one is desktop's alone. */}
          {!__WEB__ && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={adjustSaving}>Cancel</Button>
              <Button onClick={saveAdjust} disabled={adjustSaving}>{adjustSaving ? 'Saving…' : 'Apply'}</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
