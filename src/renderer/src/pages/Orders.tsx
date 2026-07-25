import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, BarChart3, Eye, Pencil, Plus, Trash2, Truck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { Tooltip, TooltipContent, TooltipTrigger, InfoTip } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { computeMoney, computeShortage } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

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

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant = status === 'empty' || status === 'received' ? 'success' : status === 'loaded' ? 'warning' : 'secondary'
  return <Badge variant={variant}>{TANKER_LABEL[status] ?? (status === 'received' ? 'Completed' : status)}</Badge>
}

// Movement-overview columns. 'loaded' is transient (loading jumps straight to
// transit), so it is not shown as its own resting column.
const PIVOT_STAGES = [
  { key: 'supplier_factory', label: 'To be loaded' },
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
  return 'supplier_factory'
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

interface OrdersProps {
  focusId?: number | null
  onFocusHandled?: () => void
  onBack?: () => void
}

export function Orders({ focusId, onFocusHandled, onBack }: OrdersProps = {}): React.JSX.Element {
  const [tab, setTab] = useState('tankers')
  const [rows, setRows] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [sources, setSources] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pivotStart, setPivotStart] = useState(monthStartISO())
  const [pivotEnd, setPivotEnd] = useState(todayISO())

  const [loadingOpen, setLoadingOpen] = useState(false)
  const [loadingForm, setLoadingForm] = useState<Row>({ tanker_count: 1, factory_entry_date: todayISO() })
  const [loadingRows, setLoadingRows] = useState<Row[]>([{}])
  const [actionRow, setActionRow] = useState<Row | null>(null)
  const [actionForm, setActionForm] = useState<Row>({})
  // Loading more than the bargain balance: the excess is either booked as a new
  // bargain (optional rate) or allocated to an existing next bargain.
  const [excess, setExcess] = useState<
    { qty: number; balance: number; mode: 'new' | 'existing'; diffRate: boolean; rate: string; targetBargainId: string } | null
  >(null)
  const [detailRow, setDetailRow] = useState<Row | null>(null)
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
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, pt, b, s, src, tr, cfg, ge] = await Promise.all([
      window.api.orders.list(),
      window.api.tankers.list(),
      window.api.bargains.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('sources'),
      window.api.data.list('transporters'),
      window.api.settings.all(),
      window.api.gate.list()
    ])
    setRows(o)
    setTankers(pt)
    setBargains(b)
    setSuppliers(s)
    setSources(src.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    setSettings(cfg)
    setGateEntries(ge)
    setLoading(false)
  }, [])

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
    for (const t of tankers) {
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
  }, [tankers, pivotStart, pivotEnd])

  // The tanker list below the pivot follows the same date range — a tanker
  // belongs to the window if its loaded (or gate-entry) date falls within it.
  const visibleTankers = useMemo(() => {
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    return tankers.filter((t) => {
      const d = String(t.loaded_date || t.factory_entry_date || t.created_at || '').slice(0, 10)
      return !!d && d >= start && d <= end
    })
  }, [tankers, pivotStart, pivotEnd])

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

  // Suppliers with bargains for the picked oil (route step 2).
  function suppliersForOil(oilId: string): { id: string; name: string }[] {
    const m = new Map<string, string>()
    for (const b of bargains.filter((x) => String(x.oil_type_id) === oilId)) {
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
    if (loadingRows.some((row) => !row.bargain_id || !String(row.tanker_no || '').trim())) {
      toast.error('Enter the tanker number and bargain for every tanker')
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
      source_id: '',
      bargain_id: String(row.bargain_id || '')
    })
    if (target === 'transit') Object.assign(next, { transit_date: todayISO(), source_id: '' })
    if (target === 'outside_factory') next.outside_factory_date = todayISO()
    if (target === 'inside_factory') next.inside_factory_date = todayISO()
    if (target === 'empty') Object.assign(next, {
      empty_date: todayISO(),
      // prefill with the gate-received qty so the gate cross-check passes
      received_qty: gateQtyFor(row.id) ?? row.loaded_qty,
      transporter_id: row.transporter_id || '',
      transport_rate_per_ton: transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton || ''
    })
    setActionForm(next)
    setExcess(null)
    setActionRow(row)
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
      outside_weighment_doc_no: row.outside_weighment_doc_no || ''
    })
  }

  async function saveEditTanker(): Promise<void> {
    if (!editTanker) return
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
    if (target === 'loaded' && Number(actionForm.loaded_qty) <= 0) {
      toast.error('Enter the actual loaded quantity')
      return
    }
    if (target === 'transit' && !actionForm.source_id) {
      toast.error('Select the source / port')
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
            : `Loading confirmed — extra ${formatNum(excess.qty)} added as a new bargain`
        )
      } else {
        toast.success(target === 'loaded' ? 'Loading confirmed and tanker moved to In transit' : `Tanker moved to ${TANKER_LABEL[target]}`)
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
    setForm({ invoice_no: '', order_date: todayISO(), is_registered_transporter: true, transporter_id: '', gst_type: 'CGST_SGST', allowed_shortage_pct: '', round_off: '', round_off_manual: false, charge_interest: false, interest_touched: false, remarks: '', freight_paid_to_supplier: false })
    setSelected([])
    setError(null)
    setFormPage(true)
    setTab('purchases')
  }

  function openEditPurchase(row: Row): void {
    const supplier = suppliers.find((x) => x.id === row.supplier_id)
    setEditing(row)
    setForm({
      bargain_id: row.bargain_id,
      supplier_id: row.supplier_id,
      oil_type_id: row.oil_type_id,
      bargain_type: row.bargain_type,
      bargain_rate: row.bargain_rate,
      supplier_name: row.supplier_name,
      oil_label: String(row.oil_code || row.oil_name || ''),
      uom: row.uom,
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
      charge_interest: Number(row.interest_pct) > 0 && Number(row.interest_days) > 0,
      interest_touched: true,
      transporter_id: row.transporter_id || '',
      is_registered_transporter: !!row.is_registered_transporter,
      allowed_shortage_pct: row.allowed_shortage_pct ?? '',
      round_off: row.round_off ?? '',
      // keep the saved round off on edit; auto kicks in only if it was zero
      round_off_manual: !!(row.round_off && Number(row.round_off) !== 0),
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

  const selectableTankers = useMemo(
    () => tankers.filter((x) =>
      String(x.supplier_id) === String(form.supplier_id || '') &&
      x.status !== 'supplier_factory' &&
      Number(x.loaded_qty) > 0 &&
      (x.order_id == null || x.order_id === editing?.id)
    ),
    [tankers, form.supplier_id, editing]
  )
  // Only suppliers that actually have billable tankers appear in the picker
  // (plus the invoice's own supplier when editing).
  const invoiceSuppliers = useMemo(() => {
    const billable = new Set(
      tankers
        .filter((x) =>
          x.status !== 'supplier_factory' &&
          Number(x.loaded_qty) > 0 &&
          (x.order_id == null || x.order_id === editing?.id))
        .map((x) => String(x.supplier_id))
    )
    return suppliers.filter(
      (s) => billable.has(String(s.id)) || String(s.id) === String(form.supplier_id || '')
    )
  }, [suppliers, tankers, editing, form.supplier_id])
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
  const mixedRates = useMemo(
    () => new Set(chosenTankers.map((x) => Number(x.bargain_rate) || 0)).size > 1,
    [chosenTankers]
  )
  const totalQty = chosenTankers.reduce((sum, x) => sum + Number(x.loaded_qty || 0), 0)
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
  const calc = useMemo(() => computeMoney({
    orderedQty: totalQty,
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
    tdsPrior: Number(form.tds_prior) || 0
  }), [form, totalQty])

  // Default the per-invoice interest toggle: ON when the supplier charges
  // interest AND the purchase is supplier-financed. A manual flip sticks.
  useEffect(() => {
    if (!formPage || editing || form.interest_touched) return
    const on = !!form.adds_interest && selected.length > 0 && financedCount === selected.length
    if (!!form.charge_interest !== on) {
      setForm((p) => ({ ...p, charge_interest: on }))
    }
  }, [formPage, editing, form.interest_touched, form.adds_interest, form.charge_interest, financedCount, selected.length])

  // Auto round-off to the nearest rupee (Tally style). A manual edit overrides
  // it; clearing the field brings the auto value back.
  useEffect(() => {
    if (!formPage || form.round_off_manual) return
    const net = calc.netAmount
    if (!Number.isFinite(net) || net <= 0) return
    const auto = Math.round(net) - net
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(form.round_off ?? '') !== val) {
      setForm((p) => ({ ...p, round_off: val }))
    }
  }, [calc.netAmount, form.round_off_manual, form.round_off, formPage])

  async function savePurchase(): Promise<void> {
    if (!form.supplier_id) return setError('Select the supplier')
    if (!selected.length) return setError('Select at least one loaded tanker')
    if (!form.bargain_id) return setError('Select at least one loaded tanker')
    if (!form.invoice_no) return setError('Invoice number is required')
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
      tanker_ids: selected,
      transporter_id: form.transporter_id ? Number(form.transporter_id) : null,
      allowed_shortage_pct:
        form.allowed_shortage_pct === '' || form.allowed_shortage_pct == null
          ? null
          : Number(form.allowed_shortage_pct),
      round_off: Number(form.round_off) || 0,
      financed_by_party: financedCount === selected.length,
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
          subtitle="Load tankers first, then combine one or more tankers into a purchase invoice"
          hint="Tanker lifecycle: To be loaded → Loaded → In transit → Outside factory → Inside factory → Empty. Pick the transporter when sending tankers to the supplier. At Empty, record received qty plus the KRFL and outside-factory weighment slips."
          actions={
            <div className="flex gap-2">
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
        <div className="p-6">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
            <button className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}>
              <ArrowLeft className="h-4 w-4" /> {onBack ? 'Back to ledger' : 'Back'}
            </button>
            <div className="h-4 border-l" />
            <h2 className="text-base font-semibold">{editing ? `Edit purchase ${editing.invoice_no}` : 'Create purchase invoice'}</h2>
            <p className="text-sm text-muted-foreground">Select all loaded tankers covered by this single supplier invoice.</p>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-6">
              <section className="rounded-xl border bg-card p-5">
                <h3 className="mb-4 font-medium">Invoice details</h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-1.5 md:col-span-3">
                    <Label>Supplier *</Label>
                    <Select
                      value={String(form.supplier_id || '')}
                      onValueChange={(v) => choosePurchaseSupplier(v)}
                      disabled={!!editing}
                    >
                      <SelectTrigger><SelectValue placeholder="Select the supplier — its loaded tankers appear below" /></SelectTrigger>
                      <SelectContent>
                        {invoiceSuppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <span className="text-[11px] text-muted-foreground">
                      {form.bargain_id
                        ? `Bargain ${bargains.find((b) => String(b.id) === String(form.bargain_id))?.bargain_no || ''} — taken from the selected tankers.`
                        : 'The bargain is picked up automatically from the tankers you select.'}
                    </span>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Invoice number *</Label>
                    <Input value={form.invoice_no || ''} onChange={(e) => setForm((p) => ({ ...p, invoice_no: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Purchase date *</Label>
                    <DatePicker value={form.order_date || ''} onChange={(v) => setForm((p) => ({ ...p, order_date: v }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Invoice rate *</Label>
                    <Input type="number" value={form.invoice_rate ?? ''} onChange={(e) => setForm((p) => ({ ...p, invoice_rate: e.target.value, invoice_rate_touched: true }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST (intra-state)</SelectItem>
                        <SelectItem value="IGST">IGST (inter-state)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>TDS %</Label>
                    <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Transporter</Label>
                    <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
                      {tankerTransporterName || (
                        <span className="text-muted-foreground">
                          {chosenTankers.length ? 'Supplier-delivered / from tankers' : 'Select tankers first'}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">Taken from the selected tankers.</span>
                  </div>
                  <div className={cn('grid gap-1.5', !tankerTransporterId && 'opacity-50')}>
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
                      <Label className="text-xs">Days</Label>
                      <Input
                        type="number"
                        className="h-8 w-20 text-right"
                        disabled={!form.charge_interest}
                        value={form.interest_days ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, interest_days: e.target.value }))}
                      />
                    </div>
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
                  </div>

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

                  <div className="grid gap-1.5 md:col-span-3">
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

              <section className="rounded-xl border bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">Tankers on this invoice</h3>
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
            </div>

            <aside className="h-fit rounded-xl border bg-card p-5 xl:sticky xl:top-6">
              <h3 className="mb-3 font-medium">Purchase summary</h3>
              <MoneyRow label="Tankers" value={String(selected.length)} />
              <MoneyRow label="Total loaded quantity" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
              <MoneyRow label="Paid by us" value={String(selected.length - financedCount)} />
              <MoneyRow label="Supplier financed" value={String(financedCount)} />
              <div className="my-3 border-t" />
              <MoneyRow label="Bargain rate" value={formatINR(Number(form.bargain_rate) || 0)} />
              {!!form.charge_interest && (
                <MoneyRow
                  label={`Interest @ ${Number(form.interest_pct) || 0}% · ${Number(form.interest_days) || 0}d`}
                  value={formatINR(calc.interestPerUnit * totalQty)}
                />
              )}
              {Number(form.additional_interest) > 0 && (
                <MoneyRow
                  label={`Additional interest (${formatINR(Number(form.additional_interest))}/${form.uom || 'MT'})`}
                  value={formatINR((Number(form.additional_interest) || 0) * totalQty)}
                />
              )}
              <MoneyRow label="Adjusted invoice rate" value={formatINR(calc.adjustedRate)} />
              <MoneyRow label="Taxable value" value={formatINR(calc.taxableValue)} />
              {form.gst_type === 'IGST' ? (
                <MoneyRow label={`IGST${form.gst_pct ? ` @ ${form.gst_pct}%` : ''}`} value={formatINR(calc.gstAmount)} />
              ) : (
                <>
                  <MoneyRow label={`CGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                  <MoneyRow label={`SGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                </>
              )}
              <MoneyRow label="Total value (excl. TDS)" value={formatINR(calc.taxableValue + calc.gstAmount)} strong />
              <MoneyRow label="TDS" value={`− ${formatINR(calc.tdsAmount)}`} />
              <div className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-muted-foreground" title="Auto-rounds the net to the nearest rupee. Type to override; clear to go back to auto.">
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
              <div className="my-3 border-t" />
              <MoneyRow label="Net purchase amount" value={formatINR(calc.netAmount + (Number(form.round_off) || 0))} strong />
              {error && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setFormPage(false)} disabled={saving}>Cancel</Button>
                <Button onClick={savePurchase} disabled={saving}>{saving ? 'Saving…' : 'Save purchase'}</Button>
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <div className="p-8">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-6">
              <TabsTrigger value="tankers">Tanker movement</TabsTrigger>
              <TabsTrigger value="purchases">Purchase entries</TabsTrigger>
            </TabsList>

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
                    <Label className="text-xs text-muted-foreground">From</Label>
                    <DatePicker max={pivotEnd} value={pivotStart} onChange={(v) => setPivotStart(v || todayISO())} className="w-40" />
                    <Label className="text-xs text-muted-foreground">To</Label>
                    <DatePicker min={pivotStart} max={todayISO()} value={pivotEnd} onChange={(v) => setPivotEnd(v || todayISO())} className="w-40" />
                    {(pivotStart !== monthStartISO() || pivotEnd !== todayISO()) && (
                      <Button variant="ghost" size="sm" onClick={() => { setPivotStart(monthStartISO()); setPivotEnd(todayISO()) }}>This month</Button>
                    )}
                  </div>
                </div>
                <Table>
                  <TableHeader className="bg-amber-100/70"><TableRow>
                    <TableHead className="text-amber-900">Oil type</TableHead>
                    {PIVOT_STAGES.map((s) => <TableHead key={s.key} className="text-center text-amber-900">{s.label}</TableHead>)}
                    <TableHead className="text-center text-amber-900">Total</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {pivot.rows.length === 0 ? (
                      <TableRow><TableCell colSpan={PIVOT_STAGES.length + 2} className="py-8 text-center text-muted-foreground">No tankers to show for this period.</TableCell></TableRow>
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
                                        <span className="cursor-default font-medium underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
                                          {cell.count}
                                        </span>
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
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Tanker</TableHead><TableHead>Supplier / bargain</TableHead><TableHead className="text-right">Loaded qty</TableHead>
                    <TableHead>Payment</TableHead><TableHead>Invoice</TableHead><TableHead>Stage</TableHead><TableHead className="text-right">Action</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {loading ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : visibleTankers.length === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{tankers.length === 0 ? 'No tankers yet. Add the first loaded tanker.' : 'No tankers in this date range.'}</TableCell></TableRow>
                        : visibleTankers.map((row) => {
                          const next = nextTankerStage(row.status)
                          return <TableRow key={row.id}>
                            <TableCell><div className="font-medium">{row.tanker_no}</div><div className="text-xs text-muted-foreground">{row.status === 'supplier_factory' ? `Entered ${formatDate(row.loaded_date)}` : `Loaded ${formatDate(row.loaded_date)}`}</div></TableCell>
                            <TableCell><div>{row.supplier_name}</div><div className="text-xs text-muted-foreground">{row.bargain_no}</div></TableCell>
                            <TableCell className="text-right tabular-nums">{Number(row.loaded_qty) > 0 ? `${formatNum(row.loaded_qty)} ${row.uom}` : 'Not loaded'}</TableCell>
                            <TableCell>{row.payment_mode === 'pending' ? <span className="text-muted-foreground">Not decided</span> : row.payment_mode === 'supplier_finance' ? <Badge variant="warning">Supplier financed</Badge> : <Badge variant="muted">Paid by us</Badge>}</TableCell>
                            <TableCell>{row.invoice_no || <span className="text-muted-foreground">Not entered</span>}</TableCell>
                            <TableCell><StatusBadge status={row.status} /></TableCell>
                            <TableCell className="text-right"><div className="flex justify-end gap-1">
                              {next && <Button size="sm" variant="outline" onClick={() => openTankerAction(row)}>{TANKER_LABEL[next]}</Button>}
                              <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit stage entries" onClick={() => openEditTanker(row)}><Pencil className="h-4 w-4" /></Button>
                              {!row.order_id && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deleteTanker(row)}><Trash2 className="h-4 w-4" /></Button>}
                            </div></TableCell>
                          </TableRow>
                        })}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="purchases">
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Invoice</TableHead><TableHead>Supplier</TableHead><TableHead>Oil</TableHead><TableHead className="text-center">Tankers</TableHead>
                    <TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Net amount</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {loading ? <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : rows.length === 0 ? <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No purchase entries yet.</TableCell></TableRow>
                        : rows.map((row) => <TableRow key={row.id}>
                          <TableCell><div className="font-medium">{row.invoice_no}</div><div className="text-xs text-muted-foreground">{formatDate(row.order_date)}</div></TableCell>
                          <TableCell>{row.supplier_name}</TableCell><TableCell>{row.oil_code}</TableCell>
                          <TableCell className="text-center"><Badge variant="secondary">{row.tanker_count || 0}</Badge></TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(row.ordered_qty)} {row.uom}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatINR(row.net_amount)}</TableCell>
                          <TableCell>
                            <Badge variant={row.status === 'received' ? 'success' : 'warning'}>
                              {row.status === 'received' ? 'Completed' : 'In process'}
                            </Badge>
                          </TableCell>
                          <TableCell><div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setDetailRow(row)}><Eye className="h-4 w-4" /></Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEditPurchase(row)}><Pencil className="h-4 w-4" /></Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deletePurchase(row)}><Trash2 className="h-4 w-4" /></Button>
                          </div></TableCell>
                        </TableRow>)}
                  </TableBody>
                </Table>
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
            <div className="grid gap-1.5">
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
            <div className="grid gap-1.5">
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
            <div className="grid gap-1.5">
              <Label>Number of tankers</Label>
              <Input type="number" min="1" max="20" value={loadingForm.tanker_count} onChange={(e) => setTankerCount(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
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
                <div className="grid min-w-0 gap-1.5">
                  <Label>Tanker number *</Label>
                  <Input value={row.tanker_no || ''} onChange={(e) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, tanker_no: e.target.value } : item))} />
                </div>
                <div className="grid min-w-0 gap-1.5">
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
                <div className="grid gap-1.5">
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
                <div className="grid min-w-0 gap-1.5">
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
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{target ? `Move ${actionRow?.tanker_no} to ${TANKER_LABEL[target]}` : 'Update tanker'}</DialogTitle></DialogHeader>
          {target === 'loaded' && actionRow && <div className="grid gap-4">
            <div className="grid gap-1.5">
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
              <div className="grid gap-1.5"><Label>Loaded date</Label><DatePicker value={actionForm.loaded_date || ''} onChange={(v) => setActionForm((p) => ({ ...p, loaded_date: v }))} /></div>
              <div className="grid gap-1.5"><Label>Actual loaded quantity *</Label><Input type="number" value={actionForm.loaded_qty || ''} onChange={(e) => { setExcess(null); setActionForm((p) => ({ ...p, loaded_qty: e.target.value })) }} /></div>
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
                  </div>

                  {excess.mode === 'new' ? (
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
                        <div className="grid gap-1.5">
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
                    <div className="grid gap-1.5">
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
            <div className="grid gap-1.5">
              <Label>Source / port</Label>
              <Select value={String(actionForm.source_id || '')} onValueChange={(value) => setActionForm((p) => ({ ...p, source_id: value }))}>
                <SelectTrigger><SelectValue placeholder="Select source for expected delivery" /></SelectTrigger>
                <SelectContent>{sources.map((source) => <SelectItem key={source.id} value={String(source.id)}>{source.name} · {source.transit_days}d</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5"><Label>Payment arrangement</Label>
              <Select value={actionForm.payment_mode || 'paid_by_us'} onValueChange={(value) => setActionForm((p) => ({ ...p, payment_mode: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                  <SelectItem value="supplier_finance">Supplier financed — pay later</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">After confirming loading, this tanker will automatically move to In transit. A purchase invoice is not required first.</p>
          </div>}
          {target === 'transit' && <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Transit date</Label><DatePicker value={actionForm.transit_date || ''} min={actionRow?.loaded_date || undefined} onChange={(v) => setActionForm((p) => ({ ...p, transit_date: v }))} /></div>
            <div className="grid gap-1.5"><Label>Source / port</Label><Select value={String(actionForm.source_id || '')} onValueChange={(v) => setActionForm((p) => ({ ...p, source_id: v }))}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{sources.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} · {s.transit_days}d</SelectItem>)}</SelectContent></Select></div>
          </div>}
          {target === 'outside_factory' && <div className="grid gap-1.5"><Label>Outside factory date</Label><DatePicker value={actionForm.outside_factory_date || ''} min={actionRow?.transit_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm({ outside_factory_date: v })} /></div>}
          {target === 'inside_factory' && <div className="grid gap-1.5"><Label>Inside factory date</Label><DatePicker value={actionForm.inside_factory_date || ''} min={actionRow?.outside_factory_date || actionRow?.transit_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm({ inside_factory_date: v })} /></div>}
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
              <div className="grid gap-1.5"><Label>Empty date</Label><DatePicker value={actionForm.empty_date || ''} min={actionRow?.inside_factory_date || actionRow?.outside_factory_date || actionRow?.loaded_date || undefined} onChange={(v) => setActionForm((p) => ({ ...p, empty_date: v }))} /></div>
              <div className="grid gap-1.5"><Label>Received quantity</Label><Input type="number" value={actionForm.received_qty || ''} onChange={(e) => setActionForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Transporter</Label><Select value={String(actionForm.transporter_id || '')} onValueChange={(v) => {
                const tr = transporters.find((x) => String(x.id) === v)
                setActionForm((p) => ({ ...p, transporter_id: v, transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || '' }))
              }}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1.5"><Label>Transport rate / {actionRow.uom}</Label><Input type="number" value={actionForm.transport_rate_per_ton || ''} onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} /></div>
            </div>
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="text-sm font-medium">KRFL weighment slip</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5"><Label>Doc number</Label><Input value={actionForm.krfl_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} /></div>
                <div className="grid gap-1.5">
                  <Label>Photo upload</Label>
                  <input type="file" accept="image/*" className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1.5 file:text-xs file:font-medium" onChange={(e) => onWeighmentPhoto('krfl_weighment_photo', e.target.files?.[0])} />
                </div>
              </div>
              {actionForm.krfl_weighment_photo && <img src={actionForm.krfl_weighment_photo} alt="KRFL weighment slip" className="max-h-32 w-fit rounded-md border" />}
            </div>
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="text-sm font-medium">Outside factory weighment slip</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5"><Label>Doc number</Label><Input value={actionForm.outside_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, outside_weighment_doc_no: e.target.value }))} /></div>
                <div className="grid gap-1.5">
                  <Label>Photo upload</Label>
                  <input type="file" accept="image/*" className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1.5 file:text-xs file:font-medium" onChange={(e) => onWeighmentPhoto('outside_weighment_photo', e.target.files?.[0])} />
                </div>
              </div>
              {actionForm.outside_weighment_photo && <img src={actionForm.outside_weighment_photo} alt="Outside factory weighment slip" className="max-h-32 w-fit rounded-md border" />}
            </div>
            <div className="rounded-lg border bg-muted/30 p-3"><MoneyRow label="Loaded" value={`${formatNum(actionRow.loaded_qty)} ${actionRow.uom}`} /><MoneyRow label="Shortage" value={`${formatNum(shortage.actualShortage)} ${actionRow.uom}`} /><MoneyRow label="Freight" value={formatINR(shortage.transportAmount)} /></div>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => { setActionRow(null); setExcess(null) }}>Cancel</Button><Button onClick={advanceTanker}>{excess ? (excess.mode === 'existing' ? 'Allocate & confirm' : 'Add bargain & confirm') : 'Confirm'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

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
                  <div className="grid gap-1.5">
                    <Label>Tanker number</Label>
                    <Input value={editTankerForm.tanker_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, tanker_no: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Bargain</Label>
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

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>{eIdx <= 0 ? 'Tanker placement date' : 'Loaded date'}</Label>
                    <DatePicker value={editTankerForm.loaded_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, loaded_date: v }))} />
                  </div>
                  {eIdx >= 2 && (
                    <div className="grid gap-1.5">
                      <Label>Loaded qty ({editTanker.uom})</Label>
                      <Input type="number" value={editTankerForm.loaded_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, loaded_qty: e.target.value }))} />
                    </div>
                  )}
                </div>

                {eIdx >= 2 && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="grid gap-1.5">
                      <Label>Payment</Label>
                      <Select value={editTankerForm.payment_mode || 'paid_by_us'} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, payment_mode: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                          <SelectItem value="supplier_finance">Supplier financed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Transit date</Label>
                      <DatePicker value={editTankerForm.transit_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, transit_date: v }))} />
                    </div>
                    <div className="grid gap-1.5">
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

                {eIdx >= 3 && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label>Outside factory date</Label>
                      <DatePicker value={editTankerForm.outside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, outside_factory_date: v }))} />
                    </div>
                    {eIdx >= 4 && (
                      <div className="grid gap-1.5">
                        <Label>Inside factory date</Label>
                        <DatePicker value={editTankerForm.inside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, inside_factory_date: v }))} />
                      </div>
                    )}
                  </div>
                )}

                {eIdx >= 5 && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label>Empty date</Label>
                        <DatePicker value={editTankerForm.empty_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, empty_date: v }))} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>Received qty {eGate != null ? `(gate: ${formatNum(eGate)})` : ''}</Label>
                        <Input type="number" value={editTankerForm.received_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, received_qty: e.target.value }))} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label>Transporter</Label>
                        <Select value={String(editTankerForm.transporter_id || '')} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, transporter_id: v }))}>
                          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent>
                            {transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label>Transport rate / {editTanker.uom}</Label>
                        <Input type="number" value={editTankerForm.transport_rate_per_ton ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label>KRFL weighment doc no</Label>
                        <Input value={editTankerForm.krfl_weighment_doc_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} />
                      </div>
                      <div className="grid gap-1.5">
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

      <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Purchase {detailRow?.invoice_no}</DialogTitle></DialogHeader>
          {detailRow && <div className="grid gap-2">
            <MoneyRow label="Supplier" value={detailRow.supplier_name || '—'} />
            <MoneyRow label="Purchase date" value={formatDate(detailRow.order_date)} />
            <MoneyRow label="Tankers" value={detailRow.tanker_nos || '—'} />
            <MoneyRow label="Total quantity" value={`${formatNum(detailRow.ordered_qty)} ${detailRow.uom}`} />
            <MoneyRow label="Net amount" value={formatINR(detailRow.net_amount)} strong />
            {detailRow.remarks && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold">Remarks:</span> {detailRow.remarks}
              </p>
            )}
          </div>}
        </DialogContent>
      </Dialog>

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-muted-foreground" /> Tankers by product</DialogTitle>
          </DialogHeader>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Loaded from</Label>
              <DatePicker value={repFrom} onChange={setRepFrom} className="w-40" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">To</Label>
              <DatePicker value={repTo} onChange={setRepTo} className="w-40" />
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
