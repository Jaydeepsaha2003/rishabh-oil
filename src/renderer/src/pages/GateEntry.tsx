import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock, Hash, Info, Lock,
  RotateCcw, LogIn, LogOut, Pencil, Scale, Trash2, Truck, X } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnFilter } from '@/components/ui/column-filter'
import { Switch } from '@/components/ui/switch'
import { InfoTip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { errText, formatDate, formatNum, todayISO } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { RowActions } from '@/components/ui/row-actions'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { useCategories } from '@/lib/useCategories'
import { Pagination, usePaged } from '@/components/Pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Receipt classification for a gate entry.
// Miscellaneous covers goods with no trading party behind them — workshop
// material, empty drums, samples. The gate records what it is, not whose it is.
// The register's Status column is binary: a row is either weighed off and
// closed, or still waiting for a weight. Fixed rather than derived from the
// data so both choices are always offered, even when the current page happens
// to hold only one of them.
const GATE_STATUS_OPTIONS = [
  { value: 'done', label: 'Completed' },
  { value: 'pending', label: 'Pending weight' }
]

const isMisc = (v: unknown): boolean => {
  const c = String(v || '').trim().toUpperCase()
  return c === 'MISCELLANEOUS' || c === 'MISC'
}

// Oil arrives on a tanker picked from the purchase, which already carries the
// quantity that was loaded. Everything else — fatty, scrap, spent earth,
// packaging — comes on a hand-typed vehicle with nothing behind it, so the
// quantity on the challan has to be typed in or the entry has no figure to
// weigh against.
const isOil = (v: unknown): boolean => String(v || '').trim().toUpperCase() === 'OIL'

// The dispatch quantity is a number, or the word NA when the challan gives
// none. NA is the ONLY text allowed — anything else is a typo, so it is simply
// not accepted as it is typed.
const DISPATCH_HINT = 'a quantity, or NA'
const isNa = (v: unknown): boolean => String(v ?? '').trim().toUpperCase() === 'NA'
function cleanDispatch(raw: string): string {
  const t = raw.trim()
  if (t === '') return ''
  // Let NA be reached one letter at a time without the field fighting back.
  if (/^n$/i.test(t)) return t.toUpperCase()
  if (isNa(t)) return 'NA'
  return /^\d*\.?\d*$/.test(t) ? t : ''
}
// What a saved entry shows for its dispatch figure.
const dispatchLabel = (row: Row, uom?: unknown): string =>
  Number(row.dispatch_na) === 1
    ? 'NA'
    : Number(row.dispatch_qty) > 0
      ? `${formatNum(row.dispatch_qty)}${uom ? ` ${uom}` : ''}`
      : '—'

const blankArrival = (): Row => ({
  gate_entry_no: '',
  ref_no: '',
  entry_date: todayISO(),
  rec_type: 'OIL',
  tanker_id: '',
  tanker_no: '',
  dispatch_qty: '',
  uom: 'MT',
  // Direct MNC stock: the vehicle is not one of ours, so there is nothing to
  // pick from the tanker list — the number is typed and the party named here.
  is_direct_mnc: false,
  supplier_id: '',
  customer_id: '',
  // 's:12' / 'c:5' — one picker spanning both party masters, used when the
  // vehicle is typed in by hand rather than chosen from the tanker list.
  party: '',
  note: '',
  // Recorded and finished at the gate — no weighbridge step.
  no_weighment: false
})

const blankGateOut = (): Row => ({
  gate_entry_no: '',
  ref_no: '',
  entry_date: todayISO(),
  rec_type: 'OIL',
  invoice_group: '',
  tanker_no: '',
  dispatch_qty: '',
  uom: 'MT',
  no_weighment: false,
  note: '',
  // 's:12' / 'c:5' — named by hand when no sale invoice supplies the party.
  party: ''
})

// One day either side, on the local calendar.
function shiftDate(iso: string, days: number): string {
  const base = String(iso || '').slice(0, 10)
  const d = new Date(`${base || todayISO()}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function GateEntry(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('gateEntry')
  const [rows, setRows] = useState<Row[]>([])
  // Register filters: date range on the entry date, receipt category, free text.
  const [gFrom, setGFrom] = useState('')
  const [gTo, setGTo] = useState('')
  // How the period is being asked for. The gate is worked a day at a time —
  // "what came in today" is the question the desk actually asks — but the only
  // way to get one day was to set both ends of a range to it, and the only way
  // to see everything was to clear two boxes and hope that was what empty
  // meant. Both are now something you can just pick.
  const [gMode, setGMode] = useState<'day' | 'range' | 'all'>('all')
  // Stepping through days keeps its own cursor, so switching to Range and back
  // returns to the day you were on rather than to today.
  const [gDay, setGDay] = useState(todayISO())
  const setDay = (d: string): void => {
    setGDay(d)
    setGFrom(d)
    setGTo(d)
  }
  const pickMode = (m: 'day' | 'range' | 'all'): void => {
    setGMode(m)
    if (m === 'all') {
      setGFrom('')
      setGTo('')
    } else if (m === 'day') {
      setDay(gDay || todayISO())
    }
  }
  // Empty = no filter (every category shows) — checked, not radio, so more
  // than one category can be picked at once.
  const [gCats, setGCats] = useState<string[]>([])
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'gateEntry')) {
      setGFrom(globalRange.from)
      setGTo(globalRange.to)
      if (globalRange.from && globalRange.from === globalRange.to) {
        setGDay(globalRange.from)
        setGMode('day')
      } else {
        setGMode(globalRange.from || globalRange.to ? 'range' : 'all')
      }
    }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const [gSearch, setGSearch] = useState('')
  const [gDir, setGDir] = useState<'ALL' | 'in' | 'out'>('ALL')
  // Quick entries (entry_kind 'simple') have no document, no weighment, no
  // stock behind them — just a vehicle number and a note. Normal entries go
  // through the full weighbridge (Tare/Gross). Separate enough in what they
  // record that the register benefits from filtering one out from the other.
  const [gKind, setGKind] = useState<'ALL' | 'quick' | 'normal'>('ALL')
  // Excel-style filter on the register's own Status column. Empty = no filter.
  const [gStatus, setGStatus] = useState<string[]>([])
  const gCatOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.rec_type || '')).filter(Boolean))).sort(),
    [rows]
  )
  const filteredRows = useMemo(() => {
    const q = gSearch.trim().toLowerCase()
    return rows.filter((r) => {
      // Rejected entries have their own tab — a stuck, never-completed tanker
      // shouldn't keep cluttering the main register once it's marked as one.
      if (r.rejected_at) return false
      const d = String(r.entry_date || '').slice(0, 10)
      if (gFrom && d < gFrom) return false
      if (gTo && d > gTo) return false
      if (gCats.length && !gCats.includes(String(r.rec_type || ''))) return false
      if (gDir !== 'ALL' && String(r.direction || 'in') !== gDir) return false
      if (gKind !== 'ALL') {
        const isQuick = String(r.entry_kind) === 'simple'
        if (gKind === 'quick' && !isQuick) return false
        if (gKind === 'normal' && isQuick) return false
      }
      if (gStatus.length && !gStatus.includes(String(r.status) === 'pending' ? 'pending' : 'done')) return false
      if (!q) return true
      return [r.gate_entry_no, r.ref_no, r.tanker_no, r.supplier_name, r.sale_customer, r.sale_invoice, r.sale_invoices, r.person, r.note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [rows, gFrom, gTo, gCats, gDir, gKind, gStatus, gSearch])
  const paged = usePaged(filteredRows)
  // Summary tiles start closed: the register below carries the same rows,
  // and this tab is opened to find an entry far more often than to read a
  // total.
  const [kpiOpen, setKpiOpen] = useState(false)
  const [tankers, setTankers] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  // Every active party, both sides — the manual-vehicle picker spans them.
  const [allSuppliers, setAllSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  // (category -> party ids) derived from what each party actually trades.
  const [partyCats, setPartyCats] = useState<Row[]>([])
  // Lets the gateman reach a party the category filter would hide.
  const [showAllParties, setShowAllParties] = useState(false)
  const [products, setProducts] = useState<Row[]>([])
  // The page carried the two entry forms, the weighment queue and the whole
  // register at once; split so recording and reviewing are separate.
  const [tab, setTab] = useState('in')
  // Rec type is the Categories master, plus whatever the products already use
  // so nothing on an old record becomes unselectable.
  // Every category, both directions. A purchase/sales tag narrows the master
  // screens, but the gate must be able to record whatever actually arrives or
  // leaves — a sales-tagged SCRAP lorry still comes in through the same gate.
  const { categories: recTypes } = useCategories(products.map((p) => p.material_type))
  const [sales, setSales] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [arrival, setArrival] = useState<Row>(blankArrival())
  const [savingArrival, setSavingArrival] = useState(false)
  // The plain register line — vehicle, person, material. Nothing else.
  const [quick, setQuick] = useState<Row>({ direction: 'in', tanker_no: '', person: '', note: '', entry_date: todayISO() })
  const [savingQuick, setSavingQuick] = useState(false)
  // Each direction is entered one of two ways: weighed at the bridge, or
  // finished at the gate. One toggle inside the tab, not a switch per form.
  const [inMode, setInMode] = useState<'with' | 'without'>('with')
  const [outMode, setOutMode] = useState<'with' | 'without'>('with')

  // `inline` puts it in the tab row rather than above the form. It is the same
  // control either way; what changes is that it loses its bottom margin and
  // takes the tab strip's own height, so the two read as one band instead of
  // two strips that nearly line up.
  function modeToggle(
    mode: 'with' | 'without',
    set: (m: 'with' | 'without') => void,
    pending: number,
    inline = false
  ): React.JSX.Element {
    return (
      <div className={cn(
        'mb-3 inline-flex rounded-lg border border-[#d9d2b8] bg-[#f1ecd9] p-0.5',
        __WEB__ && '!gap-0.5 !rounded-[4px] !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]',
        inline && __WEB__ && '!mb-0 !p-1'
      )}>
        {(['with', 'without'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => set(m)}
            className={cn(
              'cursor-pointer rounded-md px-3.5 py-1.5 text-[12px] font-semibold transition-colors',
              mode === m ? 'bg-[#1a2c56] text-white' : 'text-muted-foreground hover:text-foreground',
              __WEB__ && '!h-[34px] !rounded-[2px] !px-3.5 !text-[12px]',
              inline && __WEB__ && '!h-9 !text-[12.5px]',
              __WEB__ && (mode === m ? '!bg-[#0B3D2E] !font-extrabold !text-white' : '!font-bold !text-[#5A6B62] hover:!text-[#0A1F17]')
            )}
          >
            {m === 'with' ? 'With weighment' : 'Without weighment'}
            {m === 'with' && pending > 0 && (
              <span
                className={cn(
                  'ml-1.5 rounded-full px-1.5 text-[10px]',
                  mode === m ? 'bg-white/20' : 'bg-amber-200 text-amber-900',
                  __WEB__ && '!rounded-[2px] !px-1.5 !py-[2px] !text-[11px] !font-extrabold !tabular-nums',
                  __WEB__ && (mode === m ? '!bg-[#C7F03F]/20 !text-[#C7F03F]' : '!bg-[#DCE7DB] !text-[#33473E]')
                )}
              >
                {pending}
              </span>
            )}
          </button>
        ))}
      </div>
    )
  }
  const [gateOut, setGateOut] = useState<Row>(blankGateOut())
  const [savingOut, setSavingOut] = useState(false)
  // The Gate out form stays folded away until it is wanted — most of the time
  // this tab is opened to weigh something already in the queue below, not to
  // record a new tanker, and the form pushed that queue off the screen.
  const [outFormOpen, setOutFormOpen] = useState(false)
  // per-pending-entry weighbridge inputs (gross / tare → net)
  const [weights, setWeights] = useState<Record<number, { gross: string; tare: string; dispatch: string }>>({})
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [editForm, setEditForm] = useState<Row>({})
  // A Gate In vehicle flagged "Gross comes later at Gate Out" — picked here,
  // then weighed on the spot.
  const [grossPickId, setGrossPickId] = useState('')
  const [grossPickValue, setGrossPickValue] = useState('')
  // The sale this vehicle turned out to be for. It was flagged at Gate In
  // before any invoice existed, so it is named here, as the Gross is taken.
  // A tanker can carry more than one bill out on the same trip, so this is a
  // list. The first one picked is the entry's primary invoice — the one every
  // existing register reads — and all of them are linked to the entry.
  const [grossPickInvoices, setGrossPickInvoices] = useState<string[]>([])
  // The day the vehicle actually left — asked here because this is the only
  // point this flow ever gets a date typed into it; without it every such
  // dispatch would silently default to whatever day the Gross happened to be
  // entered, which is often not the day the vehicle drove out.
  const [grossPickOutDate, setGrossPickOutDate] = useState(todayISO())
  const [grossPickSaving, setGrossPickSaving] = useState(false)
  // Custom prompt (replaces the browser's plain confirm()) asked when a Gate
  // In vehicle is saved Tare-only for the first time — a gate operator reads
  // this, not a developer, so it needs to be plain and unmissable.
  const [grossOutPrompt, setGrossOutPrompt] = useState<{ row: Row; tare: number } | null>(null)
  const [grossOutSaving, setGrossOutSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [g, pt, sl, nextNo, nextOutNo, sup, prd, cus, pcats] = await Promise.all([
      window.api.gate.list(),
      // the gate serves every company — list tankers across all of them
      window.api.tankers.list(true),
      window.api.gate.dispatchableSales().catch(() => [] as Row[]),
      window.api.gate.nextNo('in').catch(() => ''),
      window.api.gate.nextNo('out').catch(() => ''),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.data.list('customers').catch(() => [] as Row[]),
      window.api.gate.partyCategories().catch(() => [] as Row[])
    ])
    setRows(g)
    setTankers(pt)
    // Only parties whose purchases skip tanker movement can send direct stock.
    setSuppliers(sup.filter((x) => x.active && x.skip_tanker_stages))
    setAllSuppliers(sup.filter((x) => x.active))
    setCustomers(cus.filter((x) => x.active))
    setPartyCats(pcats)
    setProducts(prd.filter((x) => x.active))
    setSales(sl)
    setArrival((p) => (p.gate_entry_no ? p : { ...p, gate_entry_no: nextNo }))
    setGateOut((p) => (p.gate_entry_no ? p : { ...p, gate_entry_no: nextOutNo }))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // A rejected entry (the tanker it was cut for will never be completed —
  // refused, redirected elsewhere) drops out of every active queue; it only
  // shows up under the Rejected tab from here on.
  const rejectedRows = rows.filter((r) => !!r.rejected_at)
  const pending = rows.filter((r) => r.status === 'pending' && !r.rejected_at)
  // Gate In vehicles weighed Tare-only and flagged to have their Gross taken
  // here at Gate Out instead of back at Gate In's own queue — they've fully
  // moved over, so both the queue and the tab counts should agree.
  const awaitingGross = pending.filter(
    (r) => String(r.direction || 'in') === 'in' && !!r.awaiting_gross_out && r.gross_weight == null
  )
  const pendingIn = pending.filter((r) => String(r.direction || 'in') === 'in').length - awaitingGross.length
  const pendingOut = pending.filter((r) => String(r.direction || 'in') === 'out').length + awaitingGross.length

  async function saveAwaitingGross(): Promise<void> {
    const row = awaitingGross.find((r) => String(r.id) === grossPickId)
    if (!row) return
    const gross = Number(grossPickValue)
    if (!grossPickValue || !Number.isFinite(gross) || gross <= 0) return void toast.error('Enter the gross weight')
    if (!grossPickInvoices.length) return void toast.error('Link the sale invoice this vehicle is carrying')
    if (!grossPickOutDate) return void toast.error('Enter the date the vehicle left')
    if (grossPickOutDate < String(row.entry_date || '').slice(0, 10)) {
      return void toast.error('The vehicle cannot leave before the day it came in')
    }
    setGrossPickSaving(true)
    try {
      const r = await window.api.gate.weights(row.id, gross, null, null, null, grossPickInvoices, grossPickOutDate)
      const names = grossPickInvoices
        .map((g) => outgoable.find((x) => String(x.invoice_group) === g)?.invoice_no)
        .filter(Boolean)
      toast.success(
        `${row.tanker_no} completed — net ${formatNum(r.net || 0)} ${row.uom}` +
          (names.length ? ` · ${names.join(', ')}` : '')
      )
      setGrossPickId('')
      setGrossPickValue('')
      setGrossPickInvoices([])
      setGrossPickOutDate(todayISO())
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setGrossPickSaving(false)
    }
  }
  const completed = rows.filter((r) => r.status !== 'pending')

  // Tankers that can still arrive: not emptied yet and no gate entry so far.
  const arrivable = useMemo(() => {
    const withEntry = new Set(rows.map((r) => Number(r.tanker_id)).filter((x) => x > 0))
    return tankers
      .filter((t) => t.status !== 'empty' && !withEntry.has(Number(t.id)))
      .sort((a, b) => String(a.tanker_no).localeCompare(String(b.tanker_no)))
  }, [tankers, rows])

  function chooseTanker(id: string): void {
    const t = tankers.find((x) => String(x.id) === id)
    setArrival((p) => ({
      ...p,
      tanker_id: id,
      tanker_no: t?.tanker_no || p.tanker_no,
      oil_type_id: t ? String(t.oil_type_id) : '',
      uom: t?.uom || 'MT',
      dispatch_qty: t?.loaded_qty ? String(t.loaded_qty) : p.dispatch_qty
    }))
  }

  // Dispatched sale invoices that haven't gone out through the gate yet.
  const outgoable = useMemo(
    () => sales.filter((s) => Number(s.gate_outs) === 0 || String(s.invoice_group) === String(gateOut.invoice_group)),
    [sales, gateOut.invoice_group]
  )

  function chooseSale(group: string): void {
    const s = sales.find((x) => String(x.invoice_group) === group)
    setGateOut((p) => ({
      ...p,
      invoice_group: group,
      // The invoice names the customer, so a hand-picked party is dropped.
      party: '',
      uom: s?.uom || 'MT',
      dispatch_qty: s?.qty ? String(s.qty) : p.dispatch_qty,
      // The category belongs to the goods being dispatched, so it comes from the
      // invoice rather than being picked again at the gate.
      rec_type: s?.product_category ? String(s.product_category).toUpperCase() : p.rec_type
    }))
  }

  // A gate line with nothing behind it: no document, no weighment, no stock.
  async function recordQuick(dir: 'in' | 'out'): Promise<void> {
    if (!String(quick.tanker_no || '').trim()) return void toast.error('Enter the vehicle number')
    if (!String(quick.note || '').trim()) return void toast.error('Say what the vehicle is carrying')
    setSavingQuick(true)
    try {
      await window.api.gate.create({
        entry_kind: 'simple',
        direction: dir,
        entry_date: quick.entry_date || todayISO(),
        tanker_no: String(quick.tanker_no).trim(),
        person: quick.person || null,
        note: String(quick.note).trim(),
        rec_type: 'MISCELLANEOUS',
        dispatch_qty: 0,
        received_qty: 0,
        no_weighment: true
      })
      toast.success(`${quick.tanker_no} logged at the gate`)
      setQuick({ tanker_no: '', person: '', note: '', entry_date: quick.entry_date || todayISO() })
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSavingQuick(false)
    }
  }

  // Parties for one category. The tag on the master (Supplier type / Customer
  // category) is the answer when it is set; a party with no tag falls back to
  // what it has actually traded. Anything that belongs to other categories is
  // hidden — HUSK means HUSK parties. "Show all" below the field is the escape
  // for a party that has neither a tag nor any history yet.
  // keepId: a party already linked on the row being edited stays in the list
  // even if it doesn't match the category — otherwise editing an entry whose
  // party was tagged (or re-tagged) into a different category than the entry
  // itself makes the field render as if the party had been lost, when it is
  // really just filtered out of view.
  function partiesIn(
    list: Row[],
    side: 'supplier' | 'customer',
    category: string,
    keepId?: number | string | null
  ): { rows: Row[]; narrowed: boolean } {
    const cat = String(category || '').trim().toUpperCase()
    if (!cat || showAllParties) return { rows: list, narrowed: false }
    const traded = new Set(
      partyCats.filter((r) => String(r.side) === side && String(r.cat).toUpperCase() === cat).map((r) => Number(r.id))
    )
    const tagOf = (x: Row): string =>
      String((side === 'supplier' ? x.supplier_type : x.category) || '').trim().toUpperCase()
    const hit = list.filter((x) => {
      const tag = tagOf(x)
      return tag ? tag === cat : traded.has(Number(x.id))
    })
    const keep = Number(keepId) || 0
    if (keep && !hit.some((x) => Number(x.id) === keep)) {
      const current = list.find((x) => Number(x.id) === keep)
      if (current) hit.unshift(current)
    }
    return { rows: hit, narrowed: hit.length < list.length }
  }

  // Gate OUT — normally with a sale invoice; a vehicle can also leave without
  // a bill when that is said explicitly and the reason is recorded.
  async function recordGateOut(): Promise<void> {
    if (!gateOut.invoice_group && !String(gateOut.note || '').trim()) {
      return void toast.error('Pick the sale invoice, or write why the vehicle is leaving without one')
    }
    if (!String(gateOut.tanker_no || '').trim()) return void toast.error('Enter the vehicle number')
    setSavingOut(true)
    try {
      await window.api.gate.create({
        ...gateOut,
        direction: 'out',
        invoice_group: gateOut.invoice_group || null,
        tanker_id: null,
        // A hand-named party, for an exit the invoice does not account for.
        supplier_id: String(gateOut.party || '').startsWith('s:')
          ? Number(String(gateOut.party).slice(2))
          : null,
        customer_id: String(gateOut.party || '').startsWith('c:')
          ? Number(String(gateOut.party).slice(2))
          : null,
        dispatch_qty: Number(gateOut.dispatch_qty) || 0,
        // No invoice-derived (or hand-entered) figure yet is exactly the "the
        // challan gives none" case, not a real zero — flag it NA now so a
        // vehicle weighed later without anyone touching the weighbridge's own
        // Dis. qty field doesn't silently compare its net against a hard 0.
        dispatch_na: !(Number(gateOut.dispatch_qty) > 0),
        received_qty: gateOut.no_weighment ? Number(gateOut.dispatch_qty) || 0 : 0,
        no_weighment: !!gateOut.no_weighment,
        status: gateOut.no_weighment ? 'completed' : 'pending'
      })
      toast.success(
        gateOut.no_weighment
          ? `Vehicle ${gateOut.tanker_no} out — no weighment, entry complete`
          : `Vehicle ${gateOut.tanker_no} out — waiting for weight`
      )
      setGateOut(blankGateOut())
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingOut(false)
    }
  }

  // Step 1 — the guard records the tanker coming in; weight comes later.
  async function recordArrival(): Promise<void> {
    if (!String(arrival.tanker_no || '').trim()) {
      toast.error(arrival.is_direct_mnc ? 'Enter the vehicle number' : 'Select the tanker (or type its number)')
      return
    }
    if (arrival.is_direct_mnc && !arrival.supplier_id) {
      toast.error('Choose the MNC / direct-purchase party sending this stock')
      return
    }
    // Whose vehicle this is has to be on the record. A picked tanker already
    // carries its supplier, an MNC arrival is checked above, and miscellaneous
    // has no trading party behind it by definition — everything else must say.
    if (!arrival.is_direct_mnc && !arrival.tanker_id && !isMisc(arrival.rec_type) && !arrival.party) {
      toast.error('Select the party this vehicle has come from or gone to')
      return
    }
    // Miscellaneous is spare parts, empty drums, workshop material — nobody
    // puts that on the weighbridge, so the gateman just states the quantity
    // and the entry is complete on the spot.
    const noWeigh = isMisc(arrival.rec_type) || !!arrival.no_weighment
    setSavingArrival(true)
    try {
      await window.api.gate.create({
        ...arrival,
        tanker_id: arrival.is_direct_mnc || !arrival.tanker_id ? null : Number(arrival.tanker_id),
        oil_type_id: arrival.oil_type_id ? Number(arrival.oil_type_id) : null,
        supplier_id: arrival.is_direct_mnc
          ? arrival.supplier_id
            ? Number(arrival.supplier_id)
            : null
          : String(arrival.party || '').startsWith('s:')
            ? Number(String(arrival.party).slice(2))
            : null,
        customer_id: !arrival.is_direct_mnc && String(arrival.party || '').startsWith('c:')
          ? Number(String(arrival.party).slice(2))
          : null,
        note: arrival.note ? String(arrival.note).trim() : null,
        is_direct_mnc: !!arrival.is_direct_mnc,
        dispatch_qty: isNa(arrival.dispatch_qty) ? 0 : Number(arrival.dispatch_qty) || 0,
        dispatch_na: isNa(arrival.dispatch_qty),
        // Without weighment the declared quantity stands as the entry's figure.
        received_qty: noWeigh && !isNa(arrival.dispatch_qty) ? Number(arrival.dispatch_qty) || 0 : 0,
        no_weighment: noWeigh,
        status: noWeigh ? 'completed' : 'pending'
      })
      toast.success(
        noWeigh
          ? `Tanker ${arrival.tanker_no} recorded — no weighment, entry complete`
          : `Tanker ${arrival.tanker_no} received — waiting for weight`
      )
      setArrival(blankArrival())
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingArrival(false)
    }
  }

  // Step 2 — gross & tare arrive from the weighbridge; net completes the entry.
  // Save whatever is on the weighbridge slip so far. One figure keeps the
  // vehicle in the queue; both complete it.
  async function doSaveWeight(row: Row, gross: number | null, tare: number | null, awaitingGrossOut?: boolean): Promise<void> {
    try {
      const d = storedWeights(row).dispatch
      const r = await window.api.gate.weights(
        row.id,
        gross,
        tare,
        awaitingGrossOut,
        d === '' ? null : isNa(d) ? 'NA' : Number(d)
      )
      if (r.status === 'completed') {
        toast.success(`${row.tanker_no} completed — net ${formatNum(r.net || 0)} ${row.uom}`)
      } else {
        toast.success(`${row.tanker_no}: ${r.missing === 'gross' ? 'tare' : 'gross'} saved — still waiting for the ${r.missing}`)
      }
      setWeights((p) => {
        const next = { ...p }
        delete next[row.id]
        return next
      })
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  async function saveWeight(row: Row): Promise<void> {
    const w = storedWeights(row)
    const gross = w.gross === '' ? null : Number(w.gross)
    const tare = w.tare === '' ? null : Number(w.tare)
    if (gross == null && tare == null) return void toast.error('Enter the gross or the tare weight')

    // Tare recorded first, on a Gate In arrival, before Gross even exists yet —
    // ask whether this vehicle's Gross will come later at Gate Out, so it can
    // be flagged into that screen's own picker instead of only sitting here.
    const isGateIn = String(row.direction || 'in') === 'in'
    const tareOnlyFirstTime = tare != null && gross == null && row.tare_weight == null && row.gross_weight == null
    if (isGateIn && tareOnlyFirstTime) {
      setGrossOutPrompt({ row, tare })
      return
    }
    await doSaveWeight(row, gross, tare)
  }

  async function resolveGrossOutPrompt(showAtGateOut: boolean): Promise<void> {
    if (!grossOutPrompt) return
    setGrossOutSaving(true)
    try {
      await doSaveWeight(grossOutPrompt.row, null, grossOutPrompt.tare, showAtGateOut)
    } finally {
      setGrossOutSaving(false)
      setGrossOutPrompt(null)
    }
  }

  // Finish a non-oil entry with no weighment at all.
  async function skipWeighment(row: Row): Promise<void> {
    if (!confirm(`Complete ${row.tanker_no} without any weighment?`)) return
    try {
      await window.api.gate.skipWeighment(row.id)
      toast.success(`${row.tanker_no} completed without weighment`)
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // What the card shows: the operator's unsaved typing, else whatever weight
  // was already recorded against the entry.
  function storedWeights(row: Row): { gross: string; tare: string; dispatch: string } {
    const typed = weights[row.id]
    if (typed) return typed
    return {
      gross: row.gross_weight == null ? '' : String(row.gross_weight),
      tare: row.tare_weight == null ? '' : String(row.tare_weight),
      // The challan figure, which the weighbridge can still set or correct.
      dispatch:
        Number(row.dispatch_na) === 1 ? 'NA' : Number(row.dispatch_qty) > 0 ? String(row.dispatch_qty) : ''
    }
  }

  // Net = gross − tare, to three decimals, when both are present.
  function derivedNet(f: Row): number | null {
    const g = f.gross_weight === '' || f.gross_weight == null ? null : Number(f.gross_weight)
    if (g == null || !Number.isFinite(g)) return null
    const t = f.tare_weight === '' || f.tare_weight == null ? 0 : Number(f.tare_weight) || 0
    return Math.round((g - t) * 1000) / 1000
  }
  // Typing a weight moves the net with it; typing the net directly overrides.
  function syncNet(f: Row): Row {
    const d = derivedNet(f)
    return d == null ? f : { ...f, received_qty: String(d) }
  }

  // The manual "Party (supplier or customer)" picker only ever applies to a
  // hand-typed vehicle that is not Direct MNC, not carrying a tanker (whose
  // party comes from its bargain), not already named by a sale invoice, and
  // not Miscellaneous (which has no trading party at all) — same rule the
  // arrival/gate-out forms use when first recording the entry.
  // --------------------------------------------------------------- edit ----
  // The website's Edit gate entry: a right-side drawer rather than a centred
  // box, because the form is three groups of fields and a box that tall has to
  // scroll the page behind it.
  //
  // Written out separately from the desktop dialog rather than styled into it.
  // The two are genuinely different shapes — banded cards against a flat grid —
  // and the desktop app is not part of this work. What they share is the state
  // and every save path; only the markup forks.
  const EDIT_LABEL = 'mb-1.5 block text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]'
  const EDIT_FIELD =
    '!h-11 !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13.5px] !font-bold !text-[#0A1F17]'
  const EDIT_CARD = 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white'
  const EDIT_BAND =
    'flex items-center gap-2 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-[15px] py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]'

  function editCardBody(cls?: string): string {
    return cn('grid gap-3 p-[15px]', cls)
  }

  function editDrawerWeb(): React.JSX.Element {
    const done = String(editRow?.status) !== 'pending'
    const isOut = String(editRow?.direction) === 'out'
    const net = derivedNet(editForm)
    const na = String(editForm.dispatch_qty ?? '').trim().toUpperCase() === 'NA'
    // What the challan said against what the bridge found. Shown only when
    // both figures are real — an entry still waiting for its tare has nothing
    // to compare, and a challan marked NA never claimed a figure at all.
    const disp = na ? null : Number(editForm.dispatch_qty || 0) || null
    const recd = net != null ? net : Number(editForm.received_qty || 0) || null
    const gap = disp != null && recd != null ? Math.round((disp - recd) * 1000) / 1000 : null
    const gapPct = gap != null && disp ? (gap / disp) * 100 : null

    return (
      <>
        {/* Header. The gate number is the thing being edited, so it is the
            title; direction and status ride beside it because they decide what
            the rest of the form is allowed to say. */}
        <div className="flex-none bg-[#0B3D2E] px-5 py-4 text-white">
          <div className="flex items-start justify-between gap-3.5">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Edit gate entry
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <span className="text-[20px] font-bold tracking-[-0.02em] tabular-nums">
                  {String(editRow?.gate_entry_no || '')}
                </span>
                <span
                  className={cn(
                    'rounded-[2px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.06em]',
                    isOut ? 'bg-[#1B4E82] text-white' : 'bg-[#C7F03F] text-[#12280B]'
                  )}
                >
                  {isOut ? 'Out' : 'In'}
                </span>
                <span
                  className={cn(
                    'rounded-[2px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.06em]',
                    done ? 'bg-white/[.14] text-[#DCEFE4]' : 'bg-[#FFEDD0] text-[#8A5300]'
                  )}
                >
                  {done ? 'Completed' : 'Pending Wt.'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditRow(null)}
              title="Close"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-[3px] bg-white/10 transition-colors hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto bg-[#F1F5EF] px-5 py-4 [&>*]:shrink-0">
          {/* -------------------------------------------------- the entry -- */}
          <div className={EDIT_CARD}>
            <div className={EDIT_BAND}>
              <Hash className="h-[17px] w-[17px] text-[#5A6B62]" />
              The entry
            </div>
            <div className={editCardBody('sm:grid-cols-2 lg:grid-cols-4')}>
              <div>
                <span className={EDIT_LABEL}>
                  Gate entry no <span className="text-[#B3261E]">*</span>
                </span>
                <Input
                  value={editForm.gate_entry_no || ''}
                  onChange={(e) => setEditForm((p) => ({ ...p, gate_entry_no: e.target.value }))}
                  className={cn(EDIT_FIELD, '!tabular-nums')}
                />
              </div>
              <div>
                <span className={EDIT_LABEL}>
                  Manual gate no{' '}
                  <span className="font-bold normal-case tracking-normal">(optional)</span>
                </span>
                <Input
                  value={editForm.ref_no || ''}
                  onChange={(e) => setEditForm((p) => ({ ...p, ref_no: e.target.value }))}
                  className={cn(EDIT_FIELD, '!tabular-nums')}
                />
              </div>
              <div>
                <span className={EDIT_LABEL}>
                  Date <span className="text-[#B3261E]">*</span>
                </span>
                <DatePicker
                  min={minDate}
                  value={editForm.entry_date || ''}
                  onChange={(v) => setEditForm((p) => ({ ...p, entry_date: v }))}
                  className={cn(EDIT_FIELD, '![&_*]:!font-bold')}
                />
              </div>
              {/* The time the vehicle came in. The column has always been
                  stored and shown in the register; it simply had nowhere to be
                  corrected. Left blank it keeps whatever it already had. */}
              <div>
                <span className={EDIT_LABEL}>In time</span>
                <div className="relative">
                  <Clock className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#5A6B62]" />
                  <Input
                    value={String(editForm.entry_time || '').slice(0, 5)}
                    placeholder="14:20"
                    onChange={(e) => setEditForm((p) => ({ ...p, entry_time: e.target.value }))}
                    className={cn(EDIT_FIELD, '!pl-10 !tabular-nums')}
                  />
                </div>
              </div>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-[4px] border px-3 py-2.5 sm:col-span-2 lg:col-span-4',
                  editForm.is_direct_mnc
                    ? 'border-[#D8C7EE] bg-[#F7F3FD]'
                    : 'border-[#DCE7DB] bg-[#F7FAF6]'
                )}
              >
                <Switch
                  checked={!!editForm.is_direct_mnc}
                  onCheckedChange={(v) => {
                    if (
                      v &&
                      !editForm.is_direct_mnc &&
                      !window.confirm(
                        'Mark this as DIRECT MNC STOCK?\n\nThe vehicle is the party’s own — no tanker is linked, and you name the MNC / direct-purchase party sending it.'
                      )
                    ) {
                      return
                    }
                    setEditForm((p) => ({ ...p, is_direct_mnc: v, supplier_id: v ? p.supplier_id : '' }))
                  }}
                />
                <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
                  Direct MNC stock
                </span>
                <span className="ml-auto text-right text-[11.5px] font-semibold text-[#5A6B62]">
                  {editForm.is_direct_mnc
                    ? suppliers.find((x) => String(x.id) === String(editForm.supplier_id))?.name ||
                      'Party not set — assign it from Consignment stock → Validate'
                    : 'The vehicle is ours or the transporter’s'}
                </span>
              </label>
            </div>
          </div>

          {/* --------------------------------- vehicle, party and material -- */}
          <div className={EDIT_CARD}>
            <div className={EDIT_BAND}>
              <Truck className="h-[17px] w-[17px] text-[#5A6B62]" />
              Vehicle, party and material
            </div>
            <div className={editCardBody('sm:grid-cols-2 lg:grid-cols-3')}>
              {partyEditable(editForm) && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <span className={EDIT_LABEL}>
                    Party <span className="font-bold normal-case tracking-normal">(supplier or customer)</span>
                  </span>
                  <Select
                    searchable
                    value={String(editForm.party || '')}
                    onValueChange={(v) => setEditForm((p) => ({ ...p, party: v }))}
                  >
                    <SelectTrigger className={EDIT_FIELD}>
                      <SelectValue placeholder="Select the party" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">{partyOptions(editForm)}</SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <span className={EDIT_LABEL}>
                  {editForm.is_direct_mnc ? 'Vehicle number' : 'Tanker no'}{' '}
                  <span className="text-[#B3261E]">*</span>
                </span>
                <Input
                  value={editForm.tanker_no || ''}
                  onChange={(e) => setEditForm((p) => ({ ...p, tanker_no: e.target.value }))}
                  className={cn(
                    EDIT_FIELD,
                    '!tabular-nums',
                    !String(editForm.tanker_no || '').trim() && '!border-[#E3C58C] !bg-[#FFFBF2]'
                  )}
                />
              </div>
              <div>
                <span className={EDIT_LABEL}>Rec type</span>
                <Select
                  searchable
                  value={editForm.rec_type || 'OIL'}
                  onValueChange={(v) => setEditForm((p) => ({ ...p, rec_type: v }))}
                >
                  <SelectTrigger className={EDIT_FIELD}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {recTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <span className={EDIT_LABEL}>Product</span>
                <Select
                  searchable
                  value={String(editForm.oil_type_id || '')}
                  onValueChange={(v) => setEditForm((p) => ({ ...p, oil_type_id: v }))}
                >
                  <SelectTrigger
                    className={cn(EDIT_FIELD, !editForm.oil_type_id && '!border-[#E3C58C] !bg-[#FFFBF2]')}
                  >
                    <SelectValue placeholder="Select product" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((pr) => (
                      <SelectItem key={pr.id} value={String(pr.id)}>{pr.code || pr.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editForm.oil_type_id && (
                  <div className="mt-1.5 text-[11px] font-bold text-[#8A5300]">
                    No product on this entry — stock cannot be posted against it until one is picked.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* --------------------------------------------------- weighment -- */}
          <div className={EDIT_CARD}>
            <div className={EDIT_BAND}>
              <Scale className="h-[17px] w-[17px] text-[#5A6B62]" />
              Weighment
            </div>
            <div className="p-[15px]">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <span className={EDIT_LABEL}>Gross wt</span>
                  <Input
                    type="number"
                    value={editForm.gross_weight ?? ''}
                    onChange={(e) => setEditForm((p) => syncNet({ ...p, gross_weight: e.target.value }))}
                    className={cn(EDIT_FIELD, '!text-right !tabular-nums')}
                  />
                </div>
                <div>
                  <span className={EDIT_LABEL}>Tare wt</span>
                  <Input
                    type="number"
                    value={editForm.tare_weight ?? ''}
                    onChange={(e) => setEditForm((p) => syncNet({ ...p, tare_weight: e.target.value }))}
                    className={cn(EDIT_FIELD, '!text-right !tabular-nums')}
                  />
                </div>
                <div>
                  <span className={EDIT_LABEL}>UOM</span>
                  <Input
                    value={editForm.uom || ''}
                    onChange={(e) => setEditForm((p) => ({ ...p, uom: e.target.value }))}
                    className={EDIT_FIELD}
                  />
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                      Dispatch qty
                    </span>
                    {/* The challan that named no figure. It was typed as the
                        letters NA into the same box; as a switch it is one
                        click and cannot be mistyped. */}
                    <button
                      type="button"
                      onClick={() =>
                        setEditForm((p) => ({ ...p, dispatch_qty: na ? '' : 'NA' }))
                      }
                      title={na ? 'This challan named no quantity' : 'Mark the challan as naming no quantity'}
                      className={cn(
                        'rounded-[2px] border px-2 py-[3px] text-[10px] font-extrabold tracking-[.05em] transition-colors',
                        na
                          ? 'border-[#C2700A] bg-[#FFEDD0] text-[#8A5300]'
                          : 'border-[#DCE7DB] bg-white text-[#5A6B62] hover:bg-[#F7FAF6]'
                      )}
                    >
                      NA
                    </button>
                  </div>
                  <Input
                    placeholder={DISPATCH_HINT}
                    value={editForm.dispatch_qty ?? ''}
                    onChange={(e) => setEditForm((p) => ({ ...p, dispatch_qty: cleanDispatch(e.target.value) }))}
                    className={cn(
                      EDIT_FIELD,
                      '!text-right !tabular-nums',
                      na && '!border-[#F0D9AE] !bg-[#FFFBF2] !text-[#8A5300]'
                    )}
                  />
                </div>
                <div>
                  <span className={EDIT_LABEL}>
                    Received (net){' '}
                    {net != null && (
                      <span className="font-bold normal-case tracking-normal">(Gross − Tare)</span>
                    )}
                  </span>
                  <div className="relative">
                    {net != null && (
                      <Lock className="pointer-events-none absolute left-3 top-1/2 h-[16px] w-[16px] -translate-y-1/2 text-[#A8B8AE]" />
                    )}
                    <Input
                      type="number"
                      disabled={net != null}
                      value={net != null ? String(net) : editForm.received_qty ?? ''}
                      onChange={(e) => setEditForm((p) => ({ ...p, received_qty: e.target.value }))}
                      className={cn(
                        EDIT_FIELD,
                        '!text-right !tabular-nums',
                        net != null && '!border-[#E4ECE3] !bg-[#F7FAF6] !text-[#33473E] disabled:!opacity-100'
                      )}
                    />
                  </div>
                </div>
              </div>

              {gap != null && Math.abs(gap) >= 0.0005 && (
                <div
                  className={cn(
                    'mt-3 flex flex-wrap items-center gap-3 rounded-[4px] border border-l-4 px-3.5 py-3',
                    gap > 0
                      ? 'border-[#F0D9AE] border-l-[#C2700A] bg-[#FFFBF2]'
                      : 'border-[#BFE3CB] border-l-[#0B6B45] bg-[#F2F9F5]'
                  )}
                >
                  <AlertTriangle
                    className={cn('h-[19px] w-[19px] flex-none', gap > 0 ? 'text-[#C2700A]' : 'text-[#0B6B45]')}
                  />
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'text-[9.5px] font-extrabold uppercase tracking-[.12em]',
                        gap > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                      )}
                    >
                      {gap > 0 ? 'Shortage' : 'Excess'}
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 text-[11.5px] font-bold',
                        gap > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                      )}
                    >
                      {gap > 0
                        ? 'The bridge found less than the challan claimed.'
                        : 'The bridge found more than the challan claimed.'}
                    </div>
                  </div>
                  <div className="ml-auto text-right">
                    <div
                      className={cn(
                        'whitespace-nowrap text-[19px] font-bold tracking-[-0.02em] tabular-nums',
                        gap > 0 ? 'text-[#C2700A]' : 'text-[#0B6B45]'
                      )}
                    >
                      {formatNum(Math.abs(gap))} {editForm.uom || 'MT'}
                    </div>
                    {gapPct != null && (
                      <div
                        className={cn(
                          'mt-0.5 text-[11px] font-bold tabular-nums',
                          gap > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                        )}
                      >
                        {Math.abs(gapPct).toFixed(2)}% of the challan
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-start gap-2.5">
                <Info className="h-[17px] w-[17px] flex-none text-[#5A6B62]" />
                <span className="text-[11.5px] font-semibold leading-relaxed text-[#33473E]">
                  The net is Gross − Tare and cannot be typed — correct the two weights and it follows.
                  An entry with no Gross was finished without weighment, so there the net is entered
                  directly. Leaving everything empty keeps the entry pending.
                </span>
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------- note -- */}
          <div className={cn(EDIT_CARD, 'p-[15px]')}>
            <span className={EDIT_LABEL}>Note</span>
            <Input
              value={editForm.note || ''}
              placeholder="Anything to record against this entry"
              onChange={(e) => setEditForm((p) => ({ ...p, note: e.target.value }))}
              className={cn(EDIT_FIELD, '!font-semibold')}
            />
          </div>
        </div>

        {/* Footer. The left half says what saving will make this entry, because
            the status is decided by the weights above rather than chosen. */}
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-t-[#D6E2D6] bg-white px-5 py-3.5">
          <div
            className={cn(
              'flex min-w-0 items-center gap-2 text-[12px] font-bold',
              recd != null && recd > 0 ? 'text-[#0B6B45]' : 'text-[#8A5300]'
            )}
          >
            {recd != null && recd > 0 ? (
              <Check className="h-[17px] w-[17px] flex-none" />
            ) : (
              <Scale className="h-[17px] w-[17px] flex-none" />
            )}
            {recd != null && recd > 0
              ? `Saving completes this entry at ${formatNum(recd)} ${editForm.uom || 'MT'}`
              : 'No received quantity yet — this entry stays pending'}
          </div>
          <div className="ml-auto flex gap-2.5">
            <Button
              variant="outline"
              onClick={() => setEditRow(null)}
              className="!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]"
            >
              Cancel
            </Button>
            <Button
              onClick={saveEdit}
              className="!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]"
            >
              <Check className="h-[19px] w-[19px]" />
              Save
            </Button>
          </div>
        </div>
      </>
    )
  }

  // The grouped supplier/customer list the party picker offers. Lifted out of
  // the desktop dialog so the website's drawer offers exactly the same options,
  // filtered the same way, rather than a second copy that drifts.
  function partyOptions(f: Row): React.JSX.Element {
    const keepSup = String(f.party || '').startsWith('s:') ? String(f.party).slice(2) : null
    const keepCus = String(f.party || '').startsWith('c:') ? String(f.party).slice(2) : null
    const sup = partiesIn(allSuppliers, 'supplier', String(f.rec_type || ''), keepSup)
    const cus = partiesIn(customers, 'customer', String(f.rec_type || ''), keepCus)
    return (
      <>
        {sup.rows.length > 0 && (
          <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Suppliers
          </div>
        )}
        {sup.rows.map((x) => (
          <SelectItem key={`s${x.id}`} value={`s:${x.id}`}>{x.name}</SelectItem>
        ))}
        {cus.rows.length > 0 && (
          <div className="mt-1 border-t px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Customers
          </div>
        )}
        {cus.rows.map((x) => (
          <SelectItem key={`c${x.id}`} value={`c:${x.id}`}>{x.name}</SelectItem>
        ))}
      </>
    )
  }

  function partyEditable(f: Row): boolean {
    return !f.is_direct_mnc && !f.tanker_id && !f.invoice_group && !isMisc(f.rec_type)
  }

  function openEdit(row: Row): void {
    setEditRow(row)
    setEditForm({
      gate_entry_no: row.gate_entry_no,
      ref_no: row.ref_no || '',
      entry_date: row.entry_date,
      rec_type: row.rec_type || 'OIL',
      tanker_id: row.tanker_id ? String(row.tanker_id) : '',
      tanker_no: row.tanker_no || '',
      oil_type_id: row.oil_type_id ? String(row.oil_type_id) : '',
      dispatch_qty: Number(row.dispatch_na) === 1 ? 'NA' : row.dispatch_qty ?? '',
      received_qty: row.received_qty ?? '',
      gross_weight: row.gross_weight ?? '',
      tare_weight: row.tare_weight ?? '',
      uom: row.uom || 'MT',
      note: row.note || '',
      is_direct_mnc: !!row.is_direct_mnc,
      invoice_group: row.invoice_group || '',
      supplier_id: row.supplier_id ? String(row.supplier_id) : '',
      customer_id: row.customer_id ? String(row.customer_id) : '',
      party: row.supplier_id ? `s:${row.supplier_id}` : row.customer_id ? `c:${row.customer_id}` : ''
    })
  }

  async function saveEdit(): Promise<void> {
    if (!editRow) return
    // Whichever of supplier/customer the manual picker resolved to, when it
    // was eligible to be shown at all — otherwise the party this entry
    // already carries (from its tanker or sale invoice) is left untouched.
    const editable = partyEditable(editForm)
    const supplierId = editForm.is_direct_mnc
      ? editForm.supplier_id ? Number(editForm.supplier_id) : null
      : editable
        ? String(editForm.party || '').startsWith('s:') ? Number(String(editForm.party).slice(2)) : null
        : editForm.supplier_id ? Number(editForm.supplier_id) : null
    const customerId = !editForm.is_direct_mnc && editable && String(editForm.party || '').startsWith('c:')
      ? Number(String(editForm.party).slice(2))
      : !editForm.is_direct_mnc && !editable && editForm.customer_id
        ? Number(editForm.customer_id)
        : null
    try {
      await window.api.gate.update(editRow.id, {
        ...editForm,
        tanker_id: editForm.tanker_id ? Number(editForm.tanker_id) : null,
        oil_type_id: editForm.oil_type_id ? Number(editForm.oil_type_id) : null,
        dispatch_qty: isNa(editForm.dispatch_qty) ? 0 : Number(editForm.dispatch_qty) || 0,
        dispatch_na: isNa(editForm.dispatch_qty),
        received_qty: Number(editForm.received_qty) || 0,
        is_direct_mnc: !!editForm.is_direct_mnc,
        supplier_id: supplierId,
        customer_id: customerId
      })
      toast.success('Gate entry updated')
      setEditRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove(row: Row): Promise<void> {
    if (!window.confirm(`Delete gate entry ${row.gate_entry_no}?`)) return
    try {
      await window.api.gate.remove(row.id)
      toast.success('Gate entry deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Reject: the tanker this entry was cut for will never be completed — the
  // party refused it and it went elsewhere instead. Kept on record (not
  // deleted) with a reason, and dropped out of every active queue. Doesn't
  // touch the linked sale/stock — any Credit Note or other correction is a
  // separate, manual step.
  const [rejectRow, setRejectRow] = useState<Row | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  function openReject(row: Row): void {
    setRejectRow(row)
    setRejectReason('')
  }
  async function saveReject(): Promise<void> {
    if (!rejectRow) return
    if (!rejectReason.trim()) return void toast.error('Enter a reason')
    setRejecting(true)
    try {
      await window.api.gate.reject(Number(rejectRow.id), rejectReason.trim())
      toast.success(`${rejectRow.gate_entry_no} marked Rejected`)
      setRejectRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRejecting(false)
    }
  }
  async function restoreRejected(row: Row): Promise<void> {
    if (!window.confirm(`Restore ${row.gate_entry_no} out of Rejected?`)) return
    try {
      await window.api.gate.unreject(Number(row.id))
      toast.success('Restored')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // The 'Without weighment' view of a tab: the plain register line — vehicle,
  // person, material — finished on the spot. Identical for both directions;
  // the tab supplies the direction.
  function quickEntry(dir: 'in' | 'out'): React.JSX.Element {
    return (
        <section
          className={cn(
            'rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white',
            __WEB__ &&
              '!rounded-[4px] !border-[#D6E2D6] !bg-white !p-0 !shadow-none [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62] [&_input]:!h-[42px] [&_input]:!rounded-[4px] [&_input]:!text-[13px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-[42px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-option]]:!font-bold [&_[data-slot=date-picker]]:!h-[42px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
          )}
        >
          <div
            className={cn(
              'mb-3 flex items-center gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5',
              __WEB__ && '!mb-0 !gap-2.5 !border-b !border-solid !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[13px] !py-2'
            )}
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-200 text-slate-700">
              <ClipboardList className="h-4 w-4" />
            </div>
            <h3 className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]')}>Without weighment — quick entry</h3>
            <InfoTip text="The plain gate-register line: which vehicle, who it is with, and what it carries. It completes on the spot — no weighment, no invoice, and it touches no stock or purchase." />
            <span className="ml-auto rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-700">
              {dir === 'in' ? 'Coming in' : 'Going out'}
            </span>
          </div>
          <div className={cn('grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4', __WEB__ && '!gap-x-3 !gap-y-2.5 !p-[13px]')}>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Vehicle number *</Label>
              <Input
                value={quick.tanker_no || ''}
                placeholder="e.g. UP14 HT 5682"
                onChange={(e) => setQuick((p) => ({ ...p, tanker_no: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && recordQuick(dir)}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>
                Person <span className="text-[10px] font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={quick.person || ''}
                placeholder="Driver or the person responsible"
                onChange={(e) => setQuick((p) => ({ ...p, person: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && recordQuick(dir)}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Material *</Label>
              <Input
                value={quick.note || ''}
                placeholder="What is in the vehicle"
                onChange={(e) => setQuick((p) => ({ ...p, note: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && recordQuick(dir)}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Date</Label>
              <DatePicker min={minDate} value={quick.entry_date || ''} onChange={(v) => setQuick((p) => ({ ...p, entry_date: v }))} />
            </div>
            {/* The action joins the field row, as it does on the two cards
                above — same forest button, same height. It was slate, which
                is not a colour this page uses anywhere else. */}
            {__WEB__ && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="!opacity-0" aria-hidden>
                  .
                </Label>
                <Button
                  className="!h-[42px] !w-full !gap-2 !rounded-[4px] !bg-[#0B6B45] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-white hover:!bg-[#0A5D3C]"
                  onClick={() => void recordQuick(dir)}
                  disabled={savingQuick}
                >
                  <ClipboardList className="h-[18px] w-[18px]" />
                  {savingQuick ? 'Saving…' : 'Log entry'}
                </Button>
              </div>
            )}
          </div>
          {/* The note stays — it is the one thing that tells a clerk this
              card behaves differently from the weighment ones — but it sits
              under the row rather than beside a button that has moved. */}
          {__WEB__ && (
            <div className="border-t border-t-[#EAF0E9] px-[18px] py-2.5 text-[11.5px] font-semibold text-[#5A6B62]">
              Completes immediately — nothing waits for weighment.
            </div>
          )}
          <div className={cn('mt-4 flex items-center justify-end gap-3', __WEB__ && '!hidden')}>
            <span className="text-[11px] text-muted-foreground">Completes immediately — nothing waits for weighment.</span>
            <Button className="h-8 bg-slate-800 px-4 text-[13px] font-semibold hover:bg-slate-900" onClick={() => void recordQuick(dir)} disabled={savingQuick}>
              <ClipboardList className="h-4 w-4" />
              {savingQuick ? 'Saving…' : 'Log entry'}
            </Button>
          </div>
        </section>
    )
  }

  // The weighbridge queue for ONE direction, so Gate in and Gate out each
  // finish the vehicles they recorded instead of sharing one mixed list.
  function weighQueue(dir: 'in' | 'out'): React.JSX.Element {
    // A Gate In vehicle flagged "weigh Gross at Gate Out" moves entirely to
    // that screen's own "Awaiting Gross" picker — it shouldn't still sit here
    // too, waiting on a weight this queue will never receive.
    const list = pending.filter(
      (r) => String(r.direction || 'in') === dir && !(dir === 'in' && r.awaiting_gross_out && r.gross_weight == null)
    )
    // Dispatched invoices with zero gate-out entries against them — work
    // that's still outstanding even though nothing is physically at the
    // weighbridge yet. Only meaningful for Gate Out: a purchase (direction
    // 'in') has no invoice-side equivalent to be "pending" against.
    const noTanker = dir === 'out' ? sales.filter((s) => Number(s.gate_outs) === 0) : []
    return (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <div className={cn('flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-700', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#FFEDD0] !text-[#C2700A]')}>
              <Scale className={cn('h-4 w-4', __WEB__ && '!h-[17px] !w-[17px]')} />
            </div>
            <h3 className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]')}>Waiting for weighment</h3>
            <InfoTip text="Enter the weighbridge Gross and Tare; the net (gross − tare) is calculated and completes the entry." />
            <Badge
              variant={list.length ? 'warning' : 'muted'}
              className={cn('ml-1', __WEB__ && '!rounded-[2px] !border-0 !bg-[#FFEDD0] !px-2.5 !py-1 !text-[12px] !font-extrabold !tabular-nums !text-[#8A5300]')}
            >
              {list.length}
            </Badge>
            {__WEB__ && list.length > 0 && (
              <span className="ml-auto text-[12px] font-bold text-[#5A6B62]">
                Gross taken · tare weight still needed on {list.length === 1 ? 'it' : `all ${list.length}`}
              </span>
            )}
          </div>
          {list.length === 0 ? (
            noTanker.length > 0 ? (
              <div className="space-y-2">
                <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-4 py-3 text-[13px] text-amber-900">
                  No tanker at the gate yet, but {noTanker.length} dispatched invoice{noTanker.length === 1 ? '' : 's'} still {noTanker.length === 1 ? 'needs' : 'need'} one recorded.
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {noTanker.map((s) => (
                    <div
                      key={String(s.invoice_group)}
                      className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-card px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] font-medium">{String(s.customer || '—')}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {String(s.invoice_no || '')} · {formatNum(s.qty)} {String(s.uom || '')}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 text-[11px]"
                        onClick={() => {
                          chooseSale(String(s.invoice_group))
                          setOutFormOpen(true)
                        }}
                      >
                        Record
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed py-5 text-center text-sm text-muted-foreground">
                No tankers waiting for weight.
              </div>
            )
          ) : (
            <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-4', __WEB__ && '!gap-3 xl:!grid-cols-3')}>
              {list.map((row) => {
                // One accent per direction, carried through the whole card —
                // not just the little icon badge — so a grid of these reads
                // by colour before anyone reads the IN/OUT text.
                const dirColor = row.direction === 'out'
                  ? { border: 'border-l-sky-500', headerBg: 'bg-sky-50', headerBorder: 'border-sky-100', icon: 'bg-sky-100 text-sky-700', badge: 'bg-sky-600 text-white' }
                  : { border: 'border-l-emerald-500', headerBg: 'bg-emerald-50', headerBorder: 'border-emerald-100', icon: 'bg-emerald-100 text-emerald-700', badge: 'bg-emerald-600 text-white' }
                return (
                <div
                  key={row.id}
                  className={cn(
                    'flex flex-col rounded-xl border border-l-4 border-slate-200 bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
                    dirColor.border,
                    // The left mark carries the state, not the direction: green
                    // once the pair is complete, amber while a weight is still
                    // owed. The IN / OUT badge already says which way it went.
                    // A stronger outline than the page's usual #D6E2D6: these
                    // cards sit on white, three to a row, and at the lighter
                    // weight the eye could not tell where one ended and the
                    // next began.
                    __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#C3D2C6] !bg-white !shadow-[0_1px_2px_rgba(10,31,23,.05)] !transition-none hover:!translate-y-0 hover:!border-[#8FBFA8]',
                    __WEB__ && (storedWeights(row).gross !== '' && storedWeights(row).tare !== '' ? '!border-l-[#12855A]' : '!border-l-[#C2700A]')
                  )}
                >
                  {/* Identity strip: vehicle + direction, never wrapping. */}
                  <div className={cn('flex items-center gap-2 rounded-tr-xl border-b px-3 py-2', dirColor.headerBg, dirColor.headerBorder, __WEB__ && '!gap-2.5 !rounded-none !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-3.5 !py-2')}>
                    <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md', dirColor.icon, __WEB__ && '!h-auto !w-auto !bg-transparent !text-[#0B6B45]')}>
                      {row.direction === 'out' ? <LogOut className={cn('h-3.5 w-3.5', __WEB__ && '!h-[17px] !w-[17px]')} /> : <LogIn className={cn('h-3.5 w-3.5', __WEB__ && '!h-[17px] !w-[17px]')} />}
                    </span>
                    <span className={cn('truncate text-[13.5px] font-bold tracking-wide', __WEB__ && '!text-[14.5px] !tracking-[-0.01em]')}>{row.tanker_no}</span>
                    <span className={cn('ml-auto shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide', dirColor.badge, __WEB__ && '!rounded-[2px] !bg-[#0B3D2E] !px-2.5 !py-1 !text-[10.5px] !font-extrabold !tracking-[.08em] !text-[#C7F03F]')}>
                      {row.direction === 'out' ? 'OUT' : 'IN'}
                    </span>
                  </div>

                  <div className={cn('flex flex-1 flex-col px-3 pb-3 pt-2', __WEB__ && '!px-3.5 !pb-3.5 !pt-3')}>
                    <div className={cn('truncate text-[12.5px] font-medium', __WEB__ && '!text-[12.5px] !font-extrabold !tracking-[-0.01em]')} title={String(row.direction === 'out' ? row.sale_customer || '' : row.supplier_name || '')}>
                      {row.direction === 'out'
                        ? (row.sale_invoice || row.sale_customer
                            ? <>{row.sale_customer || '—'}{row.sale_invoice ? <span className="text-muted-foreground"> · {row.sale_invoice}</span> : ''}</>
                            : <span className="font-medium text-amber-700">No bill{row.note ? ` — ${row.note}` : ''}</span>)
                        : <>{row.supplier_name || '—'}{row.bargain_no ? <span className="text-muted-foreground"> · {row.bargain_no}</span> : ''}</>}
                    </div>
                    {/* Meta as aligned label/value pairs instead of a wrapping
                        sentence — each its own colour so the three read as
                        distinct facts (identity, kind, claim) rather than one
                        flat grey row. */}
                    {__WEB__ ? (
                      // The handoff runs these as a chip row rather than three
                      // coloured tiles — four colours competing on a card this
                      // small made the tare box, which is the thing to fill in,
                      // no louder than the metadata around it.
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[3px] border border-[#E4ECE3] bg-[#F7FAF6] px-2.5 py-2">
                        <span className="rounded-[2px] bg-white px-2 py-1 text-[11.5px] font-bold tabular-nums text-[#33473E]">
                          {String(row.gate_entry_no || '—')}
                        </span>
                        <span className="rounded-[2px] bg-white px-2 py-1 text-[11px] font-extrabold tracking-[.05em] text-[#33473E]">
                          {String(row.rec_type || 'OIL')}
                        </span>
                        <span className="text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">{formatDate(row.entry_date)}</span>
                        <span className="ml-auto text-[11.5px] font-bold tabular-nums text-[#5A6B62]">
                          Dis {dispatchLabel(row, row.uom)}
                        </span>
                      </div>
                    ) : (
                    <div className="mt-1.5 grid grid-cols-3 gap-1 text-center">
                      {[
                        { l: 'Gate no', v: String(row.gate_entry_no || '—'), cls: 'bg-slate-100 text-slate-700' },
                        { l: String(row.rec_type || 'OIL'), v: formatDate(row.entry_date), cls: 'bg-violet-50 text-violet-700' },
                        { l: 'Dispatch', v: dispatchLabel(row, row.uom), cls: 'bg-rose-50 text-rose-700' }
                      ].map((x) => (
                        <div key={x.l} className={cn('rounded px-1 py-0.5', x.cls)}>
                          <div className="truncate text-[9px] font-semibold uppercase tracking-wide opacity-70">{x.l}</div>
                          <div className="truncate text-[11px] font-bold tabular-nums">{x.v}</div>
                        </div>
                      ))}
                    </div>
                    )}
                    {(() => {
                      const w = storedWeights(row)
                      const hasG = w.gross !== '' && Number(w.gross) > 0
                      const hasT = w.tare !== '' && Number(w.tare) >= 0
                      const both = hasG && hasT
                      const net = Math.round(((Number(w.gross) || 0) - (Number(w.tare) || 0)) * 1000) / 1000
                      const ready = both && net > 0
                      // Oil must be weighed both ways; other categories may be
                      // finished at the gate with no weighment at all.
                      const isOil = String(row.rec_type || 'OIL').toUpperCase() === 'OIL'
                      const setW = (k: 'gross' | 'tare' | 'dispatch', val: string): void =>
                        setWeights((p) => ({ ...p, [row.id]: { ...storedWeights(row), [k]: val } }))
                      return (
                        <div className="flex flex-1 flex-col">
                          {/* One line per label, never wrapping — two cards
                              side by side have to line up, and a wrapped
                              caption in one of them throws the whole row out.
                              Gross and Tare each keep their own colour from
                              label through to a filled box, so which is which
                              — and which is already entered — reads at a
                              glance instead of two identical white inputs. */}
                          <div
                            className={cn(
                              'mt-2.5 grid grid-cols-2 gap-x-2 gap-y-0.5',
                              // Boxed as one block: Gross and Tare are a pair
                              // that produces a single number, and two loose
                              // inputs on a white card did not say so.
                              __WEB__ &&
                                '!mt-2 !gap-x-3 !gap-y-2 !rounded-[3px] !border !border-[#E4ECE3] !p-2.5'
                            )}
                          >
                            <label
                              className={cn('truncate text-[9px] font-semibold uppercase tracking-wide text-sky-700', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.11em] !text-[#5A6B62]')}
                              title={row.direction === 'out' ? 'Gross — loaded, at exit' : 'Gross — loaded, at arrival'}
                            >
                              Gross <span className="font-normal normal-case text-muted-foreground">({row.uom}, loaded)</span>
                            </label>
                            <label
                              className={cn('truncate text-[9px] font-semibold uppercase tracking-wide text-amber-700', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.11em] !text-[#5A6B62]')}
                              title={row.direction === 'out' ? 'Tare — empty, at arrival' : 'Tare — empty, at exit'}
                            >
                              Tare <span className="font-normal normal-case text-muted-foreground">({row.uom}, empty)</span>
                            </label>
                            <Input
                              type="number"
                              className={cn(
                                'h-8 text-right tabular-nums',
                                hasG ? 'border-emerald-300 bg-emerald-50/60 font-semibold text-emerald-900' : 'border-sky-200 focus-visible:ring-sky-400',
                                __WEB__ && '!h-[42px] !rounded-[4px] !text-[15px] !font-bold',
                                __WEB__ && (hasG ? '!border-[#C3D2C6] !bg-white !text-[#0A1F17]' : '!border-[#E3C58C] !bg-white')
                              )}
                              placeholder="0.000"
                              value={w.gross}
                              onChange={(e) => setW('gross', e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)}
                            />
                            <Input
                              type="number"
                              className={cn(
                                'h-8 text-right tabular-nums',
                                hasT ? 'border-emerald-300 bg-emerald-50/60 font-semibold text-emerald-900' : 'border-amber-200 focus-visible:ring-amber-400',
                                __WEB__ && '!h-[42px] !rounded-[4px] !text-[15px] !font-bold',
                                __WEB__ && (hasT ? '!border-[#C3D2C6] !bg-white !text-[#0A1F17]' : '!border-[#E3C58C] !bg-white')
                              )}
                              placeholder="0.000"
                              value={w.tare}
                              onChange={(e) => setW('tare', e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)}
                            />
                          </div>
                          {/* A purchase oil tanker's quantity comes off its own
                              weighed load — always a hard number, never NA.
                              A sales oil dispatch is OUR OWN figure declared at
                              exit, often before the customer's receipt is
                              known, so it needs the same NA option everything
                              else already gets here. */}
                          {(!isOil || row.direction === 'out') && (
                            <div className={cn('mt-1.5 flex flex-col gap-0.5', __WEB__ && '!mt-2.5 !gap-2 !rounded-[3px] !border !border-[#E4ECE3] !p-2.5')}>
                              <label
                                className={cn('truncate text-[9px] font-semibold uppercase tracking-wide text-rose-700', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.11em] !text-[#5A6B62]')}
                                title="The quantity the challan declares — or NA when it gives none"
                              >
                                Dis. qty <span className="font-normal normal-case text-muted-foreground">({row.uom}, per challan)</span>
                              </label>
                              <Input
                                className={cn('h-8 border-rose-200 text-right tabular-nums focus-visible:ring-rose-400', __WEB__ && '!h-[42px] !rounded-[4px] !border-[#C3D2C6] !text-[14px] !font-bold')}
                                placeholder="0.000 or NA"
                                value={w.dispatch}
                                onChange={(e) => setW('dispatch', cleanDispatch(e.target.value))}
                                onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)}
                              />
                            </div>
                          )}
                          {/* One figure saves and waits; both complete. */}
                          {(hasG || hasT) && !both && (
                            <div className={cn('mt-1.5 flex items-center gap-1.5 rounded-lg bg-amber-100 px-2 py-1.5 text-[10.5px] font-semibold text-amber-900', __WEB__ && '!mt-2 !gap-2 !rounded-[3px] !border !border-[#F0E4CB] !bg-[#FFFBF2] !px-2.5 !py-2 !text-[11.5px] !font-bold !text-[#8A5300]')}>
                              <Scale className={cn('h-3 w-3 shrink-0', __WEB__ && '!h-[17px] !w-[17px] !text-[#C2700A]')} />
                              {hasG ? 'Gross recorded — waiting for the tare weight' : 'Tare recorded — waiting for the gross weight'}
                            </div>
                          )}
                          <div className={cn('mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-dotted border-amber-200 pt-2.5', __WEB__ && '!mt-2 !border-t !border-solid !border-t-[#E4ECE3] !pt-3')}>
                            <span
                              className={cn(
                                'inline-flex items-baseline gap-1 rounded-md px-2 py-1 text-[12px]',
                                ready ? 'bg-emerald-100 font-bold text-emerald-800' : 'bg-slate-100 text-muted-foreground',
                                __WEB__ && '!rounded-[3px] !px-2.5 !py-1.5 !text-[12.5px]',
                                __WEB__ && (ready ? '!bg-[#DFF0C4] !text-[#12280B]' : '!bg-[#F7FAF6] !text-[#5A6B62]')
                              )}
                            >
                              <span className="text-[9px] font-semibold uppercase tracking-wide opacity-70">Net</span>
                              <span className="tabular-nums">{ready ? formatNum(net) : '—'}</span> {row.uom}
                              {/* What the weighbridge found against what the
                                  challan claimed, the moment both are known. */}
                              {ready && !isNa(w.dispatch) && Number(w.dispatch) > 0 && (() => {
                                const short = Math.round((Number(w.dispatch) - net) * 1000) / 1000
                                if (Math.abs(short) < 0.0005) return <span className="ml-1 text-[11px] font-normal text-muted-foreground">· matches</span>
                                return (
                                  <span className={cn('ml-1 rounded px-1 text-[11px] font-bold', short > 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800')}>
                                    · {formatNum(Math.abs(short))} {short > 0 ? 'short' : 'excess'}
                                  </span>
                                )
                              })()}
                            </span>
                            <span className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className={cn('h-8 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50', __WEB__ && '!h-9 !rounded-[4px] !border-[1.5px] !border-[#F0D6D4] !bg-[#FDF3F2] !px-3.5 !text-[12px] !font-extrabold !text-[#B3261E] hover:!bg-[#FBE9E7]')}
                                title="This tanker will never be weighed — the party refused it and it went elsewhere"
                                onClick={() => openReject(row)}
                              >
                                Reject
                              </Button>
                              {!isOil && !hasG && !hasT && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 border-slate-300 px-2 text-[11px] text-slate-700"
                                  title="Finish this entry with no weighment (not allowed for oil)"
                                  onClick={() => void skipWeighment(row)}
                                >
                                  No weighment
                                </Button>
                              )}
                              <Button
                                size="sm"
                                className={cn(
                                  'h-8 font-semibold',
                                  ready ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-sky-600 hover:bg-sky-700',
                                  __WEB__ && '!h-9 !rounded-[4px] !px-4 !text-[12px] !font-extrabold',
                                  __WEB__ && (ready ? '!bg-[#0B3D2E] !text-[#C7F03F] hover:!bg-[#0F4A38]' : '!bg-[#33473E] !text-white hover:!bg-[#0B3D2E]')
                                )}
                                disabled={!hasG && !hasT}
                                title={
                                  ready
                                    ? 'Complete on net = gross − tare'
                                    : hasG || hasT
                                      ? 'Saves this weight; the vehicle stays in the queue for the other one'
                                      : isOil
                                        ? 'Oil needs both the gross and the tare weight'
                                        : 'Enter a weight, or finish with No weighment'
                                }
                                onClick={() => saveWeight(row)}
                              >
                                <Scale className="h-4 w-4" /> {ready ? 'Complete' : 'Save'}
                              </Button>
                            </span>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )
              })}
            </div>
          )}
        </section>
    )
  }

  return (
    <>
      <PageHeader
        title="Gate Entry"
        hint="Record a tanker the moment it comes IN (green) or a sale vehicle when it goes OUT (blue) — no weight needed yet. Entries wait under 'Waiting for weighment' until the weighbridge Gross & Tare are entered (net = gross − tare), which completes them. The Empty step in Purchases checks against the inbound weight; gate-outs link to the sale being dispatched."
        actions={
          <ExcelButton
            // The file names the period it holds, so two downloads taken on
            // the same day for different ranges don't collide.
            filename={
              gFrom || gTo
                ? `gate-entries-${gFrom || 'start'}-to-${gTo || todayISO()}`
                : `gate-entries-${todayISO()}`
            }
            sheetName="Gate entries"
            title={`Gate entries${gFrom || gTo ? ` (${gFrom || 'start'} → ${gTo || 'today'})` : ''}`}
            // Everything the register holds about an entry, so the sheet can
            // be worked on without coming back to the screen for a figure.
            columns={[
              { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
              { header: 'Manual no', key: 'ref_no', value: (r) => r.ref_no || '' },
              { header: 'In date', key: 'entry_date', value: (r) => formatDate(r.entry_date) },
              { header: 'In time', key: 'entry_time', width: 10, value: (r) => String(r.entry_time || '').slice(0, 5) },
              { header: 'Out date', key: 'out_date', value: (r) => (r.out_date ? formatDate(r.out_date) : '') },
              { header: 'Out time', key: 'out_time', width: 10, value: (r) => String(r.out_time || '').slice(0, 5) },
              { header: 'In / Out', key: 'direction', value: (r) => (r.direction === 'out' ? 'OUT' : 'IN') },
              { header: 'Rec type', key: 'rec_type', value: (r) => r.rec_type || 'OIL' },
              { header: 'Product', key: 'product', value: (r) => r.oil_name || r.oil_code || '' },
              { header: 'Vehicle', key: 'tanker_no', value: (r) => r.tanker_no || '' },
              {
                header: 'Party',
                key: 'party',
                value: (r) =>
                  r.direction === 'out'
                    ? r.sale_customer || r.gate_customer_name || r.supplier_name || ''
                    : r.supplier_name || r.gate_customer_name || ''
              },
              { header: 'Bargain', key: 'bargain_no', value: (r) => r.bargain_no || '' },
              {
                header: 'Sale invoice',
                key: 'sale_invoice',
                // Every bill the vehicle carried, so the sheet does not under-report a multi-bill trip.
                value: (r) => (Number(r.sale_count) > 1 ? String(r.sale_invoices || r.sale_invoice || '') : r.sale_invoice || '')
              },
              { header: 'UOM', key: 'uom', value: (r) => r.uom || 'MT' },
              {
                header: 'Dispatch qty',
                key: 'dispatch_qty',
                align: 'right',
                numFmt: '#,##0.000',
                // NA is a real answer on a challan that gives no figure, and
                // it has to survive into the sheet as the word, not as a zero.
                value: (r) => (Number(r.dispatch_na) === 1 ? 'NA' : Number(r.dispatch_qty) || 0)
              },
              { header: 'Gross', key: 'gross_weight', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.gross_weight) || 0 },
              { header: 'Tare', key: 'tare_weight', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.tare_weight) || 0 },
              // The net is received_qty. This used to read r.qty, which gate
              // entries do not carry, so every row exported a zero.
              { header: 'Net qty', key: 'received_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.received_qty) || 0 },
              {
                header: 'Short / excess',
                key: 'shortage',
                align: 'right',
                numFmt: '#,##0.000',
                // Nothing to compare against when the challan gave no figure.
                value: (r) =>
                  Number(r.dispatch_na) === 1 || !(Number(r.dispatch_qty) > 0)
                    ? ''
                    : Math.round((Number(r.dispatch_qty) - Number(r.received_qty || 0)) * 1000) / 1000
              },
              { header: 'Status', key: 'status', value: (r) => (r.status === 'completed' ? 'Done' : 'Pending') },
              { header: 'Weighed', key: 'no_weighment', value: (r) => (String(r.entry_kind) === 'simple' ? 'Quick entry' : Number(r.no_weighment) === 1 ? 'No weighment' : 'Yes') },
              { header: 'Direct MNC', key: 'is_direct_mnc', value: (r) => (Number(r.is_direct_mnc) === 1 ? 'Yes' : '') },
              { header: 'Person', key: 'person', value: (r) => r.person || '' },
              { header: 'Note / material', key: 'note', value: (r) => r.note || '' }
            ]}
            // What the register is showing is what comes out — the date range,
            // category, direction and search all apply. Downloading the whole
            // register when the screen shows a filtered slice of it is not
            // what anyone means by "export".
            rows={filteredRows}
          />
        }
      />
      <div className={cn('w-full px-4 py-5', __WEB__ && '!px-3 !py-3')}>
        <Tabs value={tab} onValueChange={setTab}>
          <div className={cn('mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2', __WEB__ && '!mb-3')}>
            <TabsList
              className={cn(
                'bg-gradient-to-r from-[#0b1530] to-[#152449] p-1 text-white/60',
                __WEB__ && '!gap-0.5 !rounded-[4px] !bg-[#0B3D2E] !bg-none !p-1 [&>button]:!h-9 [&>button]:!gap-2 [&>button]:!rounded-[2px] [&>button]:!px-3.5 [&>button]:!text-[12.5px] [&>button]:!font-extrabold [&>button]:!text-[#8FBFA8] [&>button:hover]:!text-white'
              )}
            >
              <TabsTrigger
                value="in"
                className={cn(
                  'data-[state=active]:bg-emerald-700 data-[state=active]:text-white data-[state=active]:shadow-md',
                  __WEB__ && 'data-[state=active]:!bg-[#C7F03F] data-[state=active]:!text-[#12280B] data-[state=active]:!shadow-none'
                )}
              >
                Gate in
                {pendingIn > 0 && (
                  <span className={cn('ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-amber-950', __WEB__ && '!ml-0 !rounded-[2px] !px-1.5 !py-[2px] !text-[11.5px] !font-extrabold !tabular-nums', __WEB__ && (tab === 'in' ? '!bg-[#0B3D2E]/15 !text-[#12280B]' : '!bg-white/[.12] !text-[#DCEFE4]'))}>
                    {pendingIn}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="out"
                className={cn(
                  'data-[state=active]:bg-sky-700 data-[state=active]:text-white data-[state=active]:shadow-md',
                  __WEB__ && 'data-[state=active]:!bg-[#C7F03F] data-[state=active]:!text-[#12280B] data-[state=active]:!shadow-none'
                )}
              >
                Gate out
                {pendingOut > 0 && (
                  <span className={cn('ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-amber-950', __WEB__ && '!ml-0 !rounded-[2px] !px-1.5 !py-[2px] !text-[11.5px] !font-extrabold !tabular-nums', __WEB__ && (tab === 'out' ? '!bg-[#0B3D2E]/15 !text-[#12280B]' : '!bg-white/[.12] !text-[#DCEFE4]'))}>
                    {pendingOut}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="view"
                className={cn(
                  'data-[state=active]:bg-amber-700 data-[state=active]:text-white data-[state=active]:shadow-md',
                  __WEB__ && 'data-[state=active]:!bg-[#C7F03F] data-[state=active]:!text-[#12280B] data-[state=active]:!shadow-none'
                )}
              >
                Entries
                {filteredRows.length > 0 && (
                  <span className={cn('ml-1.5 rounded-full bg-white/20 px-1.5 text-[10px] font-semibold text-white', __WEB__ && '!ml-0 !rounded-[2px] !px-1.5 !py-[2px] !text-[11.5px] !font-extrabold !tabular-nums', __WEB__ && (tab === 'view' ? '!bg-[#0B3D2E]/15 !text-[#12280B]' : '!bg-white/[.12] !text-[#DCEFE4]'))}>
                    {filteredRows.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="rejected"
                className={cn(
                  'data-[state=active]:bg-rose-700 data-[state=active]:text-white data-[state=active]:shadow-md',
                  // Rejected keeps red rather than the lime the other three
                  // share — it is the one tab that reports a problem.
                  __WEB__ && 'data-[state=active]:!bg-[#B3261E] data-[state=active]:!text-white data-[state=active]:!shadow-none'
                )}
              >
                Rejected
                {rejectedRows.length > 0 && (
                  <span className={cn('ml-1.5 rounded-full bg-rose-400 px-1.5 text-[10px] font-semibold text-rose-950', __WEB__ && '!ml-0 !rounded-[2px] !px-1.5 !py-[2px] !text-[11.5px] !font-extrabold !tabular-nums', __WEB__ && (tab === 'rejected' ? '!bg-white/20 !text-white' : '!bg-white/[.12] !text-[#DCEFE4]'))}>
                    {rejectedRows.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            {/* The weighed / not-weighed choice belongs to the tab it is in, so
                it sits with the tabs. It had a strip of its own directly under
                them, which cost a whole row of height to hold two buttons and
                left this space empty. */}
            {__WEB__ && tab === 'in' && modeToggle(inMode, setInMode, pendingIn, true)}
            {__WEB__ && tab === 'out' && modeToggle(outMode, setOutMode, pendingOut, true)}
            {/* Pipeline readout — the three numbers the gate is actually
                run by, off the same arrays the tab counts use. */}
            {__WEB__ && tab !== 'view' && (
              <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
                {[
                  { k: 'at gate', v: pending.length, Icon: Truck, color: '#0B6B45' },
                  { k: 'awaiting tare', v: pending.filter((r) => r.gross_weight != null && r.tare_weight == null).length, Icon: Scale, color: '#C2700A' },
                  { k: 'rejected today', v: rejectedRows.filter((r) => String(r.rejected_at || '').slice(0, 10) === todayISO()).length, Icon: Ban, color: '#B3261E' }
                ].map((st) => (
                  <div key={st.k} className="flex items-center gap-2">
                    <st.Icon className="h-[18px] w-[18px] shrink-0" style={{ color: st.color }} />
                    <span className="text-[15px] font-bold tabular-nums">{st.v}</span>
                    <span className="text-[11.5px] font-bold text-[#5A6B62]">{st.k}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === 'view' && (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[#d9d2b8] bg-[#fffdf4] px-2.5 py-1 shadow-sm',
                  __WEB__ &&
                    '!w-full !gap-x-2.5 !gap-y-2 !rounded-[4px] !border-[#D6E2D6] !bg-white !px-4 !py-2 !shadow-none [&_input]:!h-9 [&_input]:!rounded-[4px] [&_input]:!border-input [&_input]:!text-[12.5px] [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-input [&_[data-slot=date-picker]]:!text-[12px]'
                )}
              >
                <div className={cn('flex shrink-0 items-center gap-0.5 rounded-md bg-[#e5dfc8]/60 p-0.5', __WEB__ && '!gap-0.5 !rounded-[4px] !border !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]')}>
                  {(['ALL', 'in', 'out'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition',
                        gDir === d ? 'bg-[#1a2c56] text-white shadow-sm' : 'text-[#1a2c56]/70 hover:text-[#1a2c56]',
                        __WEB__ && '!h-8 !rounded-[2px] !px-3 !text-[11.5px] !font-extrabold', __WEB__ && (gDir === d ? '!bg-[#0B3D2E] !text-white !shadow-none' : '!bg-transparent !text-[#5A6B62] hover:!text-[#0A1F17]')
                      )}
                      onClick={() => setGDir(d)}
                    >
                      {d === 'ALL' ? 'All' : d}
                    </button>
                  ))}
                </div>
                <div className={cn('h-5 shrink-0 border-l border-[#d9d2b8]', __WEB__ && '!hidden')} />
                <div className={cn('flex shrink-0 items-center gap-0.5 rounded-md bg-[#e5dfc8]/60 p-0.5', __WEB__ && '!gap-0.5 !rounded-[4px] !border !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]')}>
                  {(['ALL', 'normal', 'quick'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      title={k === 'quick' ? 'No document, no weighment, no stock' : k === 'normal' ? 'Went through the full weighbridge' : undefined}
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition',
                        gKind === k ? 'bg-[#1a2c56] text-white shadow-sm' : 'text-[#1a2c56]/70 hover:text-[#1a2c56]',
                        __WEB__ && '!h-8 !rounded-[2px] !px-3 !text-[11.5px] !font-extrabold', __WEB__ && (gKind === k ? '!bg-[#0B3D2E] !text-white !shadow-none' : '!bg-transparent !text-[#5A6B62] hover:!text-[#0A1F17]')
                      )}
                      onClick={() => setGKind(k)}
                    >
                      {k === 'ALL' ? 'All' : k === 'quick' ? 'Quick entries' : 'Normal entries'}
                    </button>
                  ))}
                </div>
                <div className={cn('h-5 shrink-0 border-l border-[#d9d2b8]', __WEB__ && '!hidden')} />
                <div className="relative shrink-0">
                  <Input
                    type="search"
                    className={cn('h-7 w-52 pl-2 text-[11px]', __WEB__ && '!w-[16rem] !pl-3')}
                    placeholder="Search gate no, vehicle, party…"
                    value={gSearch}
                    onChange={(e) => setGSearch(e.target.value)}
                  />
                </div>
                <div className={cn('h-5 shrink-0 border-l border-[#d9d2b8]', __WEB__ && '!hidden')} />
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className={cn('inline-flex shrink-0 overflow-hidden rounded-md border border-[#d9d2b8]', __WEB__ && '!gap-0.5 !rounded-[4px] !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]')}>
                    {(
                      [
                        ['day', 'Day'],
                        ['range', 'Range'],
                        ['all', 'All time']
                      ] as const
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => pickMode(m)}
                        className={cn(
                          'px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition',
                          gMode === m
                            ? 'bg-[#1a2c56] text-white'
                            : 'bg-white text-[#1a2c56]/70 hover:bg-[#f1ecd9]',
                          __WEB__ && '!h-8 !rounded-[2px] !px-3 !text-[11.5px] !font-extrabold', __WEB__ && (gMode === m ? '!bg-[#0B3D2E] !text-white !shadow-none' : '!bg-transparent !text-[#5A6B62] hover:!text-[#0A1F17]')
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {gMode === 'day' && (
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Arrows, because the gate is read one day after another
                          and re-picking the date from a calendar every time is
                          the slow way to do that. */}
                      <button
                        type="button"
                        title="Previous day"
                        onClick={() => setDay(shiftDate(gDay, -1))}
                        className="flex h-7 w-6 items-center justify-center rounded border border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-[#f1ecd9]"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <DatePicker
                        value={gDay}
                        onChange={(v) => setDay(v || todayISO())}
                        className="h-7 w-[9.5rem] shrink-0 text-[11px]"
                      />
                      <button
                        type="button"
                        title="Next day"
                        onClick={() => setDay(shiftDate(gDay, 1))}
                        className="flex h-7 w-6 items-center justify-center rounded border border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-[#f1ecd9]"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      {gDay !== todayISO() && (
                        <button
                          type="button"
                          onClick={() => setDay(todayISO())}
                          className="h-7 rounded border border-[#d9d2b8] bg-white px-2 text-[10px] font-semibold uppercase tracking-wide text-[#1a2c56] hover:bg-[#f1ecd9]"
                        >
                          Today
                        </button>
                      )}
                    </div>
                  )}
                  {gMode === 'range' && (
                    <>
                      <DatePicker value={gFrom} onChange={(v) => setGFrom(v || '')} max={gTo || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                      <span className="shrink-0 text-[10px] text-muted-foreground">to</span>
                      <DatePicker value={gTo} onChange={(v) => setGTo(v || '')} min={gFrom || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                    </>
                  )}
                  {gMode === 'all' && (
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                      every entry ever recorded
                    </span>
                  )}
                </div>
                <div className={cn('h-5 shrink-0 border-l border-[#d9d2b8]', __WEB__ && '!hidden')} />
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={cn('shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-[#1a2c56]/70', __WEB__ && '!text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]')}>
                    Category
                  </span>
                  <MultiSelectFilter
                    options={gCatOptions.map((c) => ({ value: c, label: c }))}
                    value={gCats}
                    onApply={setGCats}
                    allLabel="All categories"
                    className={cn('h-7 w-[10.5rem] shrink-0 text-[11px]', __WEB__ && '!h-9 !w-[11rem] !rounded-[4px] !text-[12px]')}
                  />
                </div>
                {(gFrom || gTo || gCats.length > 0 || gDir !== 'ALL' || gKind !== 'ALL' || gStatus.length > 0 || gSearch) && (
                  <>
                    <div className={cn('h-5 shrink-0 border-l border-[#d9d2b8]', __WEB__ && '!hidden')} />
                    <button
                      type="button"
                      className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide text-rose-700 hover:text-rose-900', __WEB__ && '!px-2 !text-[11.5px] !font-extrabold !tracking-[.05em] !text-[#0B6B45] hover:!text-[#0B3D2E]')}
                      // Clearing the dates has to put the mode back too, or the
                      // control would still read "Day" over an unfiltered list.
                      onClick={() => { setGMode('all'); setGFrom(''); setGTo(''); setGCats([]); setGDir('ALL'); setGKind('ALL'); setGStatus([]); setGSearch('') }}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <TabsContent value="in" className="space-y-4">
        {!__WEB__ && modeToggle(inMode, setInMode, pendingIn)}
        {inMode === 'without' ? quickEntry('in') : (<>
        {/* Tanker IN */}
        <section
          className={cn(
            'rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white',
            __WEB__ &&
              '!rounded-[4px] !border-[#D6E2D6] !bg-white !p-0 !shadow-none [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62] [&_input]:!h-[42px] [&_input]:!rounded-[4px] [&_input]:!text-[13px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-[42px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-option]]:!font-bold [&_[data-slot=date-picker]]:!h-[42px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
          )}
        >
          <div
            className={cn(
              'mb-3 flex items-center gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5',
              __WEB__ && '!mb-0 !gap-2.5 !border-b !border-solid !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[13px] !py-2'
            )}
          >
            <div className={cn('flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-700', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9] !text-[#0B3D2E]')}>
              <Truck className="h-4 w-4" />
            </div>
            <h3 className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]')}>Tanker in</h3>
            <InfoTip text="Record a tanker the moment it arrives — pick it from the list or type the number manually. Weight is entered later under Waiting for weighment." />
            {/* Direct MNC stock arrives on the party's own vehicle: nothing to
                pick from our tanker list, so the number is typed and the party
                named here. Validation on the Consignment page then only needs
                the oil. */}
            <label
              className={cn(
                'ml-auto flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition',
                arrival.is_direct_mnc
                  ? 'border-violet-300 bg-violet-50 text-violet-900'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              <Switch
                checked={!!arrival.is_direct_mnc}
                onCheckedChange={(v) => {
                  // Only a real off→on flip needs asking — it changes what the
                  // entry means, so it is confirmed rather than just flipped.
                  if (
                    v &&
                    !arrival.is_direct_mnc &&
                    !window.confirm(
                      'Record this as DIRECT MNC STOCK?\n\nThe vehicle is the party’s own, so no tanker is picked from the movement register, and you must name the MNC / direct-purchase party sending it.'
                    )
                  ) {
                    return
                  }
                  setArrival((p) => ({ ...p, is_direct_mnc: v, tanker_id: '', supplier_id: v ? p.supplier_id : '' }))
                }}
              />
              <span className="font-medium">Direct MNC stock</span>
              <InfoTip text="ON: the goods come straight from a direct-purchase party (BUNGE and the like) on their own vehicle. No tanker to select — type the number and name the party." />
            </label>
          </div>
          <div className={cn('grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', __WEB__ && '!gap-x-3 !gap-y-2.5 !p-[13px]')}>
            {arrival.is_direct_mnc ? (
              <div className="flex min-w-0 flex-col gap-1">
                <Label>MNC / party *</Label>
                <Select
                  searchable
                  value={String(arrival.supplier_id || '')}
                  onValueChange={(v) => setArrival((p) => ({ ...p, supplier_id: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={suppliers.length ? 'Select the party' : 'No direct-purchase party yet'} />
                  </SelectTrigger>
                  <SelectContent>
                    {partiesIn(suppliers, 'supplier', String(arrival.rec_type || '')).rows.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-1">
                <Label>Tanker *</Label>
                <Select searchable value={String(arrival.tanker_id || '')} onValueChange={chooseTanker}>
                  <SelectTrigger><SelectValue placeholder="Select arriving tanker" /></SelectTrigger>
                  <SelectContent>
                    {arrivable.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.tanker_no} · {t.supplier_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <Label>{arrival.is_direct_mnc ? 'Vehicle number *' : 'Tanker number *'}</Label>
              <Input
                value={arrival.tanker_no || ''}
                placeholder={arrival.is_direct_mnc ? 'Type the vehicle number' : ''}
                onChange={(e) => setArrival((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Rec type</Label>
              <Select
                searchable
                value={arrival.rec_type || 'OIL'}
                onValueChange={(v) =>
                  // Switching category re-scopes the party list, so a party
                  // that no longer belongs is dropped rather than left stale.
                  setArrival((p) => ({ ...p, rec_type: v, party: isMisc(v) ? '' : p.party }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {recTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* A hand-typed vehicle belongs to nobody yet — name the party it
                came from or went to, from either master in one list.
                Miscellaneous is workshop material, empty drums and the like:
                there is no trading party behind it, so it is not asked for. */}
            {!arrival.is_direct_mnc && !arrival.tanker_id && !isMisc(arrival.rec_type) && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label>
                  Party * <span className="text-[10px] font-normal text-muted-foreground">(supplier or customer)</span>
                </Label>
                <Select
                  searchable
                  value={String(arrival.party || '')}
                  onValueChange={(v) => setArrival((p) => ({ ...p, party: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent className="max-h-72">{partyOptions(editForm)}</SelectContent>
                </Select>
                {(() => {
                  const cat = String(arrival.rec_type || '').toUpperCase()
                  const sup = partiesIn(allSuppliers, 'supplier', cat)
                  const cus = partiesIn(customers, 'customer', cat)
                  const none = sup.rows.length === 0 && cus.rows.length === 0
                  if (!sup.narrowed && !cus.narrowed && !none) return null
                  return (
                    <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {none ? (
                        <span className="font-medium text-amber-700">
                          No party is tagged {cat} — tag them on the Suppliers / Customers master
                        </span>
                      ) : (
                        <>parties who deal in {cat}</>
                      )}
                      <button
                        type="button"
                        className="cursor-pointer font-medium text-indigo-600 underline-offset-2 hover:underline"
                        onClick={() => setShowAllParties((v) => !v)}
                      >
                        {showAllParties ? 'filter by category' : 'show all'}
                      </button>
                    </span>
                  )
                })()}
              </div>
            )}
            {/* Miscellaneous never reaches the weighbridge, so its quantity
                has to be stated here — there is no later step to state it in.
                Everything else is asked at the weighbridge instead, where the
                challan is actually to hand. */}
            {isMisc(arrival.rec_type) && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label>
                  Dis. qty <span className="text-[10px] font-normal text-muted-foreground">(no weighment)</span>
                </Label>
                <Input
                  value={arrival.dispatch_qty ?? ''}
                  placeholder={DISPATCH_HINT}
                  onChange={(e) =>
                    setArrival((p) => ({ ...p, dispatch_qty: cleanDispatch(e.target.value) }))
                  }
                />
              </div>
            )}
            {/* Miscellaneous has no product behind it, so let the gateman say
                what actually came in. */}
            {isMisc(arrival.rec_type) && (
              <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
                <Label>
                  Details <span className="text-[10px] font-normal text-muted-foreground">(optional — what is it?)</span>
                </Label>
                <Input
                  value={arrival.note || ''}
                  placeholder="e.g. spare parts, empty drums, workshop material"
                  onChange={(e) => setArrival((p) => ({ ...p, note: e.target.value }))}
                />
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="flex items-center gap-1">Gate entry no <span className="text-[10px] font-normal text-muted-foreground">(auto)</span></Label>
              <Input value={arrival.gate_entry_no || ''} disabled className="bg-muted/50 text-muted-foreground" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="flex items-center gap-1">Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input value={arrival.ref_no || ''} placeholder="Gate-register no…" onChange={(e) => setArrival((p) => ({ ...p, ref_no: e.target.value }))} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Date</Label>
              <DatePicker min={minDate} value={arrival.entry_date || ''} onChange={(v) => setArrival((p) => ({ ...p, entry_date: v }))} />
            </div>
            {/* The action takes the fourth column of the last row rather than
                a row of its own. The row ended at Date with an empty quarter
                beside it and the button banished to a strip below, which cost
                a band of height on the screen a gate clerk lives on — and put
                the thing they press furthest from the last thing they type.
                An empty label keeps it sitting on the same baseline as the
                fields; the desktop keeps its own footer strip. */}
            {__WEB__ && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="!opacity-0" aria-hidden>
                  .
                </Label>
                <Button
                  className="!h-[42px] !w-full !gap-2 !rounded-[4px] !bg-[#0B6B45] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-white hover:!bg-[#0A5D3C]"
                  onClick={recordArrival}
                  disabled={savingArrival}
                >
                  <Truck className="h-[18px] w-[18px]" />
                  {savingArrival ? 'Saving…' : isMisc(arrival.rec_type) ? 'Record entry' : 'Tanker received'}
                </Button>
              </div>
            )}
          </div>
          <div className={cn('mt-4 flex justify-end', __WEB__ && '!hidden')}>
            <Button className="h-8 bg-emerald-600 px-4 text-[13px] font-semibold hover:bg-emerald-700" onClick={recordArrival} disabled={savingArrival}>
              <Truck className="h-4 w-4" />
              {savingArrival ? 'Saving…' : isMisc(arrival.rec_type) ? 'Record entry' : 'Tanker received'}
            </Button>
          </div>
        </section>

        {weighQueue('in')}
        </>)}

          </TabsContent>

          <TabsContent value="out" className="space-y-4">
        {!__WEB__ && modeToggle(outMode, setOutMode, pendingOut)}
        {outMode === 'without' ? quickEntry('out') : (<>
        {/* Gate OUT — sale dispatch leaving the factory */}
        <section
          className={cn(
            'rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white',
            __WEB__ &&
              '!rounded-[4px] !border-[#D6E2D6] !bg-white !p-0 !shadow-none [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62] [&_input]:!h-[42px] [&_input]:!rounded-[4px] [&_input]:!text-[13px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-[42px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-option]]:!font-bold [&_[data-slot=date-picker]]:!h-[42px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2',
              outFormOpen && 'mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5',
              __WEB__ && '!mb-0 !gap-2.5 !border-b !border-solid !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[13px] !py-2 !pb-3'
            )}
          >
            <div className={cn('flex h-7 w-7 items-center justify-center rounded-md bg-sky-100 text-sky-700', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9] !text-[#0B3D2E]')}>
              <LogOut className="h-4 w-4" />
            </div>
            <h3 className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]')}>Gate out</h3>
            <InfoTip text="Record a sale tanker here — even the moment it arrives EMPTY for loading, before the invoice is ready (pick the party + a reason). It stays in the weighing queue below: enter its Tare (empty) weight now, then come back and enter the Gross (loaded) weight once it leaves — either order, either first. Net = Gross − Tare completes it." />
            <label className="ml-auto flex cursor-pointer items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {outFormOpen ? 'Hide form' : 'Record a tanker'}
              </span>
              <Switch checked={outFormOpen} onCheckedChange={setOutFormOpen} />
            </label>
          </div>
          {outFormOpen && (<>
          <div className={cn('grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', __WEB__ && '!gap-x-3 !gap-y-2.5 !p-[13px]')}>
            <div className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
              <Label>
                Sale invoice (dispatched){' '}
                <span className="text-[10px] font-normal text-muted-foreground">(optional — else give the reason)</span>
              </Label>
              <Select searchable value={String(gateOut.invoice_group || '')} onValueChange={chooseSale}>
                <SelectTrigger><SelectValue placeholder="Select outgoing invoice" /></SelectTrigger>
                <SelectContent>
                  {(() => {
                    // A chosen category narrows the invoices to that kind of
                    // goods; if none match it shows everything rather than
                    // leaving the gateman with an empty list.
                    const cat = String(gateOut.rec_type || '').trim().toUpperCase()
                    const hit = cat
                      ? outgoable.filter((x) => String(x.product_category || '').toUpperCase() === cat)
                      : outgoable
                    const list = hit.length ? hit : outgoable
                    return list.map((s) => (
                      <SelectItem key={s.invoice_group} value={String(s.invoice_group)}>
                        {s.invoice_no || 'No invoice no'} · {s.customer || '—'} · {s.product_name} · {formatNum(s.qty)} {s.uom}
                      </SelectItem>
                    ))
                  })()}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>
                Reason / note{' '}
                {!gateOut.invoice_group && <span className="text-[10px] font-normal text-amber-700">required without an invoice</span>}
              </Label>
              <Input
                value={gateOut.note || ''}
                placeholder="e.g. empty tanker arrived for loading"
                onChange={(e) => setGateOut((p) => ({ ...p, note: e.target.value }))}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Vehicle number *</Label>
              <Input value={gateOut.tanker_no || ''} onChange={(e) => setGateOut((p) => ({ ...p, tanker_no: e.target.value }))} />
            </div>
            {/* With no invoice behind it the vehicle belongs to nobody, so the
                party is named here — the same combined list as Gate in.
                Miscellaneous has no trading party, so it is not asked for. */}
            {!gateOut.invoice_group && !isMisc(gateOut.rec_type) && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label>
                  Party <span className="text-[10px] font-normal text-muted-foreground">(supplier or customer)</span>
                </Label>
                <Select
                  searchable
                  value={String(gateOut.party || '')}
                  onValueChange={(v) => setGateOut((p) => ({ ...p, party: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {(() => {
                      const cat = String(gateOut.rec_type || '')
                      const sup = partiesIn(allSuppliers, 'supplier', cat)
                      const cus = partiesIn(customers, 'customer', cat)
                      return (
                        <>
                          {cus.rows.length > 0 && (
                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Customers{cus.narrowed ? ` · ${cat.toUpperCase()}` : ''}
                            </div>
                          )}
                          {cus.rows.map((x) => (
                            <SelectItem key={`c${x.id}`} value={`c:${x.id}`}>{x.name}</SelectItem>
                          ))}
                          {sup.rows.length > 0 && (
                            <div className="mt-1 border-t px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Suppliers{sup.narrowed ? ` · ${cat.toUpperCase()}` : ''}
                            </div>
                          )}
                          {sup.rows.map((x) => (
                            <SelectItem key={`s${x.id}`} value={`s:${x.id}`}>{x.name}</SelectItem>
                          ))}
                        </>
                      )
                    })()}
                  </SelectContent>
                </Select>
                {(() => {
                  const cat = String(gateOut.rec_type || '').toUpperCase()
                  const sup = partiesIn(allSuppliers, 'supplier', cat)
                  const cus = partiesIn(customers, 'customer', cat)
                  const none = sup.rows.length === 0 && cus.rows.length === 0
                  if (!sup.narrowed && !cus.narrowed && !none) return null
                  return (
                    <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {none ? (
                        <span className="font-medium text-amber-700">No party is tagged {cat}</span>
                      ) : (
                        <>parties who deal in {cat}</>
                      )}
                      <button
                        type="button"
                        className="cursor-pointer font-medium text-indigo-600 underline-offset-2 hover:underline"
                        onClick={() => setShowAllParties((v) => !v)}
                      >
                        {showAllParties ? 'filter by category' : 'show all'}
                      </button>
                    </span>
                  )
                })()}
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Category <span className="text-[10px] font-normal text-muted-foreground">(from the invoice)</span></Label>
              <Select
                searchable
                value={gateOut.rec_type || 'OIL'}
                onValueChange={(v) => setGateOut((p) => ({ ...p, rec_type: v, party: isMisc(v) ? '' : p.party }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {recTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="flex items-center gap-1">Gate out no <span className="text-[10px] font-normal text-muted-foreground">(auto)</span></Label>
              <Input value={gateOut.gate_entry_no || ''} disabled className="bg-muted/50 text-muted-foreground" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="flex items-center gap-1">Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input value={gateOut.ref_no || ''} placeholder="Gate-register no…" onChange={(e) => setGateOut((p) => ({ ...p, ref_no: e.target.value }))} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Date</Label>
              <DatePicker min={minDate} value={gateOut.entry_date || ''} onChange={(v) => setGateOut((p) => ({ ...p, entry_date: v }))} />
            </div>
            {/* Same as Gate in: the action takes the empty cell at the end of
                the last row instead of a strip of its own below it. */}
            {__WEB__ && (
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="!opacity-0" aria-hidden>
                  .
                </Label>
                <Button
                  className="!h-[42px] !w-full !gap-2 !rounded-[4px] !bg-[#0B6B45] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-white hover:!bg-[#0A5D3C]"
                  onClick={recordGateOut}
                  disabled={savingOut}
                >
                  <LogOut className="h-[18px] w-[18px]" />
                  {savingOut ? 'Saving…' : 'Record tanker'}
                </Button>
              </div>
            )}
          </div>
          <div className={cn('mt-4 flex justify-end', __WEB__ && '!hidden')}>
            <Button className="h-8 bg-sky-600 px-4 text-[13px] font-semibold hover:bg-sky-700" onClick={recordGateOut} disabled={savingOut}>
              <LogOut className="h-4 w-4" />
              {savingOut ? 'Saving…' : 'Record tanker'}
            </Button>
          </div>
          </>)}
        </section>

        {awaitingGross.length > 0 && (
          <section
            className={cn(
              'rounded-md border border-amber-300 bg-amber-50 p-4 shadow-sm',
              // One height for every control in this card, set here rather
              // than on each field: the two pickers, the date and the weight
              // box each carried their own size, so a row of four came out at
              // three different heights. Matches the Gate in / Gate out cards.
              __WEB__ &&
                '!rounded-[4px] !border-[#F0D9AE] !bg-[#FFFBF2] !p-0 !shadow-none [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62] [&_input]:!h-[42px] [&_input]:!rounded-[4px] [&_input]:!bg-white [&_input]:!text-[13px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-[42px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-option]]:!font-bold [&_[data-slot=date-picker]]:!h-[42px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
            )}
          >
            <div className={cn('mb-3 flex items-center gap-2 border-b border-dotted border-amber-300 pb-1.5', __WEB__ && '!mb-0 !border-b-[#F0D9AE] !border-solid !px-[13px] !py-2')}>
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-700">
                <Scale className="h-4 w-4" />
              </div>
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-amber-900">Awaiting Gross (from Gate In)</h3>
              <InfoTip text="Vehicles weighed Tare-only at Gate In and flagged as being for sale. Pick one, link the sale invoice it is carrying, say when it left and enter its Gross weight — it completes on the spot. No dispatch quantity is asked for: the invoice already says what is on board." />
              <Badge variant="warning" className="ml-1">{awaitingGross.length}</Badge>
            </div>
            <div className={cn('grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4', __WEB__ && '!gap-x-3 !gap-y-2.5 !p-[13px] lg:!grid-cols-[1fr_1fr_1fr_1fr_auto]')}>
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Vehicle</Label>
                <Select value={grossPickId} onValueChange={setGrossPickId}>
                  <SelectTrigger className="h-8 bg-white text-[13px]"><SelectValue placeholder="Select a vehicle" /></SelectTrigger>
                  <SelectContent>
                    {awaitingGross.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.tanker_no} · Tare {formatNum(r.tare_weight)} {r.uom} · {formatDate(r.entry_date)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Sale invoice{grossPickInvoices.length > 1 ? 's' : ''} *
                  <InfoTip text="One vehicle can carry several bills out on the same trip. Pick each invoice on board — the picker stays open so you can add more, and picking one again takes it off. Every invoice linked here is marked as gone out." />
                </Label>
                {/* Picking adds rather than replaces, so a second bill on the
                    same tanker no longer means overwriting the first. */}
                <Select
                  searchable
                  value=""
                  selected={grossPickInvoices}
                  onValueChange={(v) =>
                    setGrossPickInvoices((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
                  }
                >
                  <SelectTrigger className="h-8 bg-white text-[13px]">
                    <span className={cn('truncate', !grossPickInvoices.length && 'text-muted-foreground')}>
                      {grossPickInvoices.length === 0
                        ? 'Link the invoice'
                        : grossPickInvoices.length === 1
                          ? outgoable.find((x) => String(x.invoice_group) === grossPickInvoices[0])?.invoice_no ||
                            '1 invoice'
                          : `${grossPickInvoices.length} invoices linked`}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {outgoable.length === 0 ? (
                      <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                        No dispatched sale invoices to link.
                      </div>
                    ) : (
                      outgoable.map((x) => (
                        <SelectItem key={x.invoice_group} value={String(x.invoice_group)}>
                          {x.invoice_no || 'No invoice no'} · {x.customer || '—'} · {formatNum(x.qty)} {x.uom}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {grossPickInvoices.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {grossPickInvoices.map((g) => {
                      const inv = outgoable.find((x) => String(x.invoice_group) === g)
                      return (
                        <button
                          key={g}
                          type="button"
                          title="Remove this invoice"
                          onClick={() => setGrossPickInvoices((prev) => prev.filter((x) => x !== g))}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-300"
                        >
                          {inv?.invoice_no || g}
                          <span className="text-amber-700">×</span>
                        </button>
                      )
                    })}
                    <span className="self-center text-[11px] text-muted-foreground">
                      {formatNum(
                        grossPickInvoices.reduce(
                          (t, g) => t + Number(outgoable.find((x) => String(x.invoice_group) === g)?.qty || 0),
                          0
                        )
                      )}{' '}
                      total
                    </span>
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Vehicle out date *</Label>
                <DatePicker
                  value={grossPickOutDate}
                  onChange={(v) => setGrossPickOutDate(v || todayISO())}
                  // Can't leave before the day it arrived — the arrival is
                  // fixed on the entry already picked above.
                  min={awaitingGross.find((r) => String(r.id) === grossPickId)?.entry_date || undefined}
                  className="h-8 bg-white text-[13px]"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Gross weight *</Label>
                <div className={cn('flex gap-2', __WEB__ && '!block')}>
                  <Input
                    type="number"
                    className={cn('h-8 bg-white text-[13px]', __WEB__ && '!w-full')}
                    placeholder="0.000"
                    value={grossPickValue}
                    onChange={(e) => setGrossPickValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void saveAwaitingGross()}
                  />
                  {/* On the app the button shares the weight box's row. On the
                      website it moves to a cell of its own beside it — sharing
                      left the weight field short by the width of a button, and
                      the button itself half the height of everything around
                      it. See the Gate in card, which does the same. */}
                  {!__WEB__ && (
                    <Button
                      className="h-8 shrink-0 bg-amber-600 px-3 text-[12px] hover:bg-amber-700"
                      disabled={!grossPickId || !grossPickInvoices.length || !grossPickOutDate || grossPickSaving}
                      onClick={() => void saveAwaitingGross()}
                    >
                      {grossPickSaving ? 'Saving…' : 'Complete'}
                    </Button>
                  )}
                </div>
              </div>
              {__WEB__ && (
                <div className="flex min-w-0 flex-col gap-1">
                  <Label className="!opacity-0" aria-hidden>
                    .
                  </Label>
                  <Button
                    className="!h-[42px] !w-full !gap-2 !rounded-[4px] !bg-[#C2700A] !px-5 !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-white hover:!bg-[#A85F08] disabled:!bg-[#E4C79A] disabled:!text-white"
                    disabled={!grossPickId || !grossPickInvoices.length || !grossPickOutDate || grossPickSaving}
                    onClick={() => void saveAwaitingGross()}
                  >
                    <Scale className="h-[18px] w-[18px]" />
                    {grossPickSaving ? 'Saving…' : 'Complete'}
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}

        {weighQueue('out')}
        </>)}
          </TabsContent>

          <TabsContent value="view">
        {/* Summary tiles. Every figure is read off filteredRows — the same
            array the register below is drawn from — so a tile can never state
            something the table under it contradicts, and all four move with
            the filters rather than reporting the whole database. */}
        {__WEB__ && (
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
                {filteredRows.length} entries
              </span>
            </button>
            {kpiOpen && (
          <div className="grid gap-2.5 px-3.5 pb-3.5 pt-1 sm:grid-cols-2 xl:grid-cols-4">
            {(() => {
              const pendingWt = filteredRows.filter((r) => r.status === 'pending' && !r.rejected_at).length
              const rejected = filteredRows.filter((r) => !!r.rejected_at).length
              // The single worst gap between what the challan claimed and what
              // the weighbridge found — the one row worth opening first.
              let worst: { v: number; row: Row | null } = { v: 0, row: null }
              for (const r of filteredRows) {
                if (Number(r.dispatch_na) === 1) continue
                const d = Math.abs(Number(r.dispatch_qty || 0) - Number(r.received_qty || 0))
                if (Number(r.received_qty || 0) > 0 && d > worst.v) worst = { v: d, row: r }
              }
              return [
                { k: 'Entries', v: String(filteredRows.length), unit: '', sub: 'matching these filters', accent: '#0B3D2E' },
                { k: 'Pending weighment', v: String(pendingWt), unit: '', sub: 'gross taken, tare due', accent: '#C2700A' },
                { k: 'Rejected', v: String(rejected), unit: '', sub: 'turned away at the gate', accent: '#B3261E' },
                {
                  k: 'Largest difference',
                  v: worst.row ? formatNum(worst.v) : '—',
                  unit: worst.row ? String(worst.row.uom || 'MT') : '',
                  sub: worst.row
                    ? `${String(worst.row.gate_entry_no || '')} · ${String(worst.row.rec_type || 'OIL')}`
                    : 'nothing weighed in this range',
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
        {/* History */}
        <section className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
          <div
            className={cn(
              'flex items-center gap-2 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2.5 text-white',
              __WEB__ && '!gap-2.5 !bg-[#0B3D2E] !bg-none !px-4 !py-2'
            )}
          >
            <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-white/15', __WEB__ && '!h-auto !w-auto !bg-transparent !text-[#C7F03F]')}>
              <ClipboardList className={cn('h-3.5 w-3.5', __WEB__ && '!h-[17px] !w-[17px]')} />
            </span>
            <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>Gate register</span>
            {__WEB__ && (
              <span className="rounded-[2px] bg-[#C7F03F]/[.16] px-2 py-[3px] text-[12px] font-extrabold tabular-nums text-[#C7F03F]">
                {filteredRows.length}
              </span>
            )}
          </div>
          <Table
            className={cn(
              'text-[13px] [&_td]:border-r [&_td]:border-slate-100 [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-slate-200 [&_th:last-child]:border-r-0',
              // Nothing wraps: a gate number split over two lines and a
              // stacked date are the two things this register is scanned for.
              __WEB__ &&
                '!min-w-[1320px] [&_td]:!whitespace-nowrap [&_td]:!border-r-[#F1F5EF] [&_th]:!whitespace-nowrap [&_th]:!border-r-[#DCE7DB]'
            )}
          >
            <TableHeader
              className={cn(
                __WEB__ &&
                  '!bg-[#EAF0E9] [&_th]:!h-9 [&_th]:!text-[10.5px] [&_th]:!font-extrabold [&_th]:!uppercase [&_th]:!tracking-[.1em] [&_th]:!text-[#33473E]'
              )}
            ><TableRow className={cn(__WEB__ && '!border-b-[#D6E2D6] hover:!bg-[#EAF0E9]')}>
              <TableHead>Gate entry</TableHead>
              <TableHead>In / Out</TableHead>
              <TableHead>
                {/* Bound to the same gCats the Category picker in the filter
                    bar uses, so the two are one filter with two handles rather
                    than two that can disagree. */}
                <ColumnFilter
                  label="Rec type"
                  options={gCatOptions.map((c) => ({
                    value: c,
                    label: c,
                    count: rows.filter((r) => String(r.rec_type || '') === c).length
                  }))}
                  value={gCats}
                  onApply={setGCats}
                />
              </TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Vehicle · party</TableHead>
              <TableHead className="text-right">Dis Qty</TableHead>
              <TableHead className="text-right">Rec (net)</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>
                <ColumnFilter
                  label="Status"
                  options={GATE_STATUS_OPTIONS}
                  value={gStatus}
                  onApply={setGStatus}
                />
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">No gate entries yet.</TableCell></TableRow>
              ) : (
                paged.pageRows.map((row) => {
                  const done = row.status !== 'pending'
                  const isOut = row.direction === 'out'
                  // Nothing to compare against when the challan gave no figure.
                  const diff = Number(row.dispatch_na) === 1 ? 0 : Number(row.dispatch_qty || 0) - Number(row.received_qty || 0)
                  return (
                    <TableRow
                      key={row.id}
                      className={cn(
                        // A mark down the left edge, so which rows are still
                        // waiting on the weighbridge reads from the shape of
                        // the register rather than from reading the status
                        // column of every line.
                        __WEB__ && '!border-b-[#EAF0E9] [&>td]:!py-2.5',
                        __WEB__ && (done ? '!bg-white hover:!bg-[#F7FAF6]' : '!bg-[#FFFDF7] hover:!bg-[#FFFBF2]')
                      )}
                      style={__WEB__ ? { borderLeft: `3px solid ${done ? '#0B6B45' : '#C2700A'}` } : undefined}
                    >
                      <TableCell className={cn('font-medium', __WEB__ && '!text-[13.5px] !font-bold !tabular-nums !text-[#0A1F17]')}>
                        <div>{row.gate_entry_no}</div>
                        {row.ref_no && (
                          <div className={cn('text-[11px] font-normal text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11px] !font-semibold !tabular-nums !text-[#5A6B62]')}>
                            Manual {row.ref_no}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={isOut ? 'default' : 'muted'}
                          className={cn(
                            __WEB__ && '!rounded-[2px] !border-0 !px-2.5 !py-1 !text-[10.5px] !font-extrabold !tracking-[.08em]',
                            __WEB__ && (isOut ? '!bg-[#1B4E82] !text-white' : '!bg-[#EAF0E9] !text-[#0B3D2E]')
                          )}
                        >
                          {isOut ? 'OUT' : 'IN'}
                        </Badge>
                      </TableCell>
                      <TableCell><span className={cn('text-xs font-medium text-muted-foreground', __WEB__ && '!text-[12.5px] !font-bold !text-[#33473E]')}>{row.rec_type || 'OIL'}</span></TableCell>
                      <TableCell>
                        {/* A vehicle that came in empty and went out loaded is
                            one record with two movements — show both ends. */}
                        <div className="whitespace-nowrap">
                          <span className={cn('text-[10px] font-semibold uppercase text-muted-foreground', __WEB__ && '!mr-1 !text-[9.5px] !font-extrabold !tracking-[.06em] !text-[#5A6B62]')}>In </span>
                          <span className={cn(__WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(row.entry_date)}</span>
                          {row.entry_time && (
                            <span className={cn('ml-1 text-[11px] tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>{String(row.entry_time).slice(0, 5)}</span>
                          )}
                        </div>
                        {row.out_date && (
                          <div className="whitespace-nowrap">
                            <span className={cn('text-[10px] font-semibold uppercase text-muted-foreground', __WEB__ && '!mr-1 !text-[9.5px] !font-extrabold !tracking-[.06em] !text-[#5A6B62]')}>Out </span>
                            <span className={cn(__WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(row.out_date)}</span>
                            {row.out_time && (
                              <span className={cn('ml-1 text-[11px] tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>{String(row.out_time).slice(0, 5)}</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className={cn(__WEB__ && '!text-[13px] !font-extrabold !tabular-nums !text-[#0A1F17]')}>{row.tanker_no}</div>
                        {String(row.entry_kind) === 'simple' ? (
                          <div className={cn('text-xs', __WEB__ && '!mt-0.5 !text-[12px]')}>
                            <span className={cn('font-medium text-slate-700', __WEB__ && '!font-semibold !text-[#33473E]')}>{row.person || 'Quick entry'}</span>
                            {row.note ? <span className={cn('text-muted-foreground', __WEB__ && '!font-semibold !text-[#5A6B62]')}> · {row.note}</span> : ''}
                          </div>
                        ) : isOut ? (
                          <div className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-0.5 !text-[12px] !font-semibold !text-[#33473E]')}>
                            {row.sale_invoice || row.sale_customer
                              ? <>{row.sale_customer || '—'}{
                                  // A vehicle carrying several bills names them
                                  // all; one bill reads as it always did.
                                  Number(row.sale_count) > 1
                                    ? ` · ${row.sale_invoices || row.sale_invoice} (${row.sale_count} bills)`
                                    : row.sale_invoice ? ` · ${row.sale_invoice}` : ''
                                }{row.sale_product ? ` · ${row.sale_product}` : ''}</>
                              : <span className="font-medium text-amber-700">No bill{row.note ? ` — ${row.note}` : ''}</span>}
                          </div>
                        ) : (
                          row.supplier_name && <div className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-0.5 !text-[12px] !font-semibold !text-[#33473E]')}>{row.supplier_name}{row.bargain_no ? ` · ${row.bargain_no}` : ''}</div>
                        )}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[13px] !font-bold !text-[#33473E]')}>{dispatchLabel(row, row.uom)}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[13px] !font-bold !text-[#0A1F17]')}>
                        {done ? (
                          <>
                            <div>{formatNum(row.received_qty)} {row.uom}</div>
                            {(row.gross_weight != null || row.tare_weight != null) && (
                              <div className={cn('text-[11px] text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11px] !font-semibold !text-[#5A6B62]')}>G {formatNum(row.gross_weight)} · T {formatNum(row.tare_weight)}</div>
                            )}
                          </>
                        ) : <span className={cn('text-muted-foreground', __WEB__ && '!text-[#A9CBBA]')}>—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {!done || Number(row.dispatch_na) === 1 ? (
                          <span className={cn('text-muted-foreground', __WEB__ && '!text-[#A9CBBA]')}>—</span>
                        ) : Math.abs(diff) < 0.0005 ? (
                          <Badge variant="muted" className={cn(__WEB__ && '!rounded-[2px] !border-0 !bg-[#EAF0E9] !px-2 !py-[3px] !text-[11px] !font-extrabold !text-[#5A6B62]')}>0</Badge>
                        ) : (
                          <span className={cn(diff > 0 ? 'text-amber-700' : 'text-emerald-700', __WEB__ && '!text-[13px] !font-bold', __WEB__ && (diff > 0 ? '!text-[#C2700A]' : '!text-[#0B6B45]'))}>{formatNum(diff)} {row.uom}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {done ? (
                          <Badge variant="success" className={cn(__WEB__ && '!rounded-[2px] !border !border-[#BFE3CB] !bg-[#E9F5EE] !px-2.5 !py-1 !text-[10.5px] !font-extrabold !uppercase !tracking-[.06em] !text-[#0B6B45]')}>Completed</Badge>
                        ) : (
                          <Badge variant="warning" className={cn(__WEB__ && '!rounded-[2px] !border !border-[#F0D9AE] !bg-[#FFEDD0] !px-2.5 !py-1 !text-[10.5px] !font-extrabold !uppercase !tracking-[.06em] !text-[#8A5300]')}>Pending Wt.</Badge>
                        )}
                        {Number(row.no_weighment) === 1 && (
                          <div className={cn('mt-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700', __WEB__ && '!mt-1 !text-[10px] !font-extrabold !tracking-[.08em] !text-[#1B4E82]')}>
                            {String(row.entry_kind) === 'simple' ? 'Quick entry' : 'No weighment'}
                          </div>
                        )}
                      </TableCell>
                      {/* All of the row's actions behind the one menu, so the
                          column is a fixed width whatever state the row is in —
                          a completed entry has no Reject, and three icons on one
                          row against two on the next read as a missing button
                          rather than an action that does not apply. Reject stays
                          listed but disabled, with the reason, so it is never
                          silently absent. */}
                      <TableCell><div className="flex justify-end">
                        <RowActions
                          actions={[
                            { label: 'Edit entry', icon: Pencil, onClick: () => openEdit(row) },
                            {
                              label: 'Reject — this tanker will never be completed',
                              icon: Ban,
                              disabled: done,
                              disabledReason: 'Already completed — reject only applies to an entry still pending',
                              onClick: () => openReject(row)
                            },
                            { label: 'Delete entry', icon: Trash2, danger: true, onClick: () => remove(row) }
                          ]}
                        />
                      </div></TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
          {/* Styled from here rather than inside Pagination: that component
              is the footer of every register in the app, and this is the only
              one being redesigned. */}
          <Pagination
            {...paged}
            label="gate entries"
            className={cn(
              'border-t px-3',
              __WEB__ &&
                '!border-t-[#D6E2D6] !px-4 !py-3 [&>span]:!text-[12.5px] [&>span]:!font-semibold [&>span]:!text-[#5A6B62] [&_button]:!h-[34px] [&_button]:!min-w-[34px] [&_button]:!rounded-[3px] [&_button]:!border-[#D6E2D6] [&_button]:!text-[13px] [&_button]:!font-bold [&_.bg-primary]:!border-[#0B3D2E] [&_.bg-primary]:!bg-[#0B3D2E] [&_.bg-primary]:!text-[#C7F03F]'
            )}
          />
        </section>
          </TabsContent>
          <TabsContent value="rejected">
            <section className="rounded-xl border bg-card">
              <div className="border-b bg-rose-50 px-4 py-3">
                <h3 className="text-[13px] font-semibold text-rose-900">Rejected gate entries</h3>
                <p className="text-[11px] text-rose-800/80">
                  Tankers that were cut a gate entry but never completed — the party refused it and it went elsewhere
                  instead. Kept here for the record; restoring one puts it back into its normal queue.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Gate entry</TableHead>
                    <TableHead>In / Out</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Vehicle · party</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Rejected on</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rejectedRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Nothing rejected.</TableCell></TableRow>
                  ) : (
                    rejectedRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.gate_entry_no}</TableCell>
                        <TableCell>
                          <Badge variant={row.direction === 'out' ? 'default' : 'success'}>
                            {row.direction === 'out' ? 'OUT' : 'IN'}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <div>
                            {formatDate(row.entry_date)}
                            {row.entry_time && (
                              <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">{String(row.entry_time).slice(0, 5)}</span>
                            )}
                          </div>
                          {/* A visit has two ends; the register shows both when
                              the vehicle has actually gone. */}
                          {row.out_date && (
                            <div className="text-[11px] text-muted-foreground">
                              <span className="font-semibold uppercase">out </span>
                              {formatDate(row.out_date)}
                              {row.out_time && <span className="ml-1 tabular-nums">{String(row.out_time).slice(0, 5)}</span>}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div>{row.tanker_no}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.direction === 'out'
                              ? [row.sale_customer, row.sale_invoice].filter(Boolean).join(' · ') || '—'
                              : row.supplier_name || '—'}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[20rem] text-[13px]">{row.rejected_reason}</TableCell>
                        <TableCell className="whitespace-nowrap text-[12px] text-muted-foreground">{formatDate(row.rejected_at)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" className="h-8 gap-1.5 px-2 text-[11px]" onClick={() => void restoreRejected(row)}>
                            <RotateCcw className="h-3.5 w-3.5" /> Restore
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </section>
          </TabsContent>
        </Tabs>
      </div>

      {/* Tare-first confirmation — one plain question, a graphic, two big
          buttons. No paragraphs: this is read by a gate operator, not typed
          out and studied. */}
      <Dialog open={!!grossOutPrompt} onOpenChange={(o) => !o && !grossOutSaving && setGrossOutPrompt(null)}>
        <DialogContent className="max-w-sm text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-sky-100 text-sky-700">
            <Truck className="h-10 w-10" />
          </div>
          <DialogHeader className="items-center text-center sm:text-center">
            <DialogTitle className="text-[20px] font-bold">{grossOutPrompt?.row.tanker_no}</DialogTitle>
          </DialogHeader>
          <p className="-mt-2 text-[18px] font-semibold">Is this tanker for sale?</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Button
              className="h-16 bg-emerald-600 text-[16px] font-bold hover:bg-emerald-700"
              disabled={grossOutSaving}
              onClick={() => void resolveGrossOutPrompt(true)}
            >
              Yes
            </Button>
            <Button
              variant="outline"
              className="h-16 text-[16px] font-bold"
              disabled={grossOutSaving}
              onClick={() => void resolveGrossOutPrompt(false)}
            >
              No
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject — the tanker this entry was cut for will never be completed */}
      <Dialog open={!!rejectRow} onOpenChange={(o) => !o && !rejecting && setRejectRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject {rejectRow?.gate_entry_no}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            Marks this entry Rejected — it drops out of every active queue but stays on record. This does not touch
            the linked sale or stock; if one needs correcting (e.g. a Credit Note), do that separately.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Reason <span className="text-red-600">*</span></Label>
            <textarea
              className="min-h-[5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="e.g. Party refused the consignment — tanker diverted to Bectors"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectRow(null)} disabled={rejecting}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => void saveReject()} disabled={rejecting}>
              {rejecting ? 'Saving…' : 'Reject entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correction dialog (office use) */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent
          className={cn(
            __WEB__ &&
              // A right-side sheet, full height, its own scroll. Radix centres
              // a dialog and caps it; all three are overridden here rather
              // than in the shared component, which every other dialog in the
              // app still wants as it is.
              '!left-auto !right-0 !top-0 !flex !h-full !max-h-none !w-[min(100vw,740px)] !max-w-none !translate-x-0 !translate-y-0 !flex-col !gap-0 !rounded-none !border-0 !bg-[#F1F5EF] !p-0 !shadow-[-16px_0_40px_rgba(10,31,23,.24)] [&>button]:!hidden'
          )}
        >
          {__WEB__ ? (
            <>
              {/* The title has to exist for the dialog to be announced, but the
                  drawer draws its own header. */}
              <DialogHeader className="sr-only">
                <DialogTitle>Edit {editRow?.gate_entry_no}</DialogTitle>
              </DialogHeader>
              {editDrawerWeb()}
            </>
          ) : (
          <>
          <DialogHeader><DialogTitle>Edit {editRow?.gate_entry_no}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Gate entry no *</Label><Input value={editForm.gate_entry_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, gate_entry_no: e.target.value }))} /></div>
              <div className="flex flex-col gap-1.5"><Label>Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label><Input value={editForm.ref_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, ref_no: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Date *</Label><DatePicker min={minDate} value={editForm.entry_date || ''} onChange={(v) => setEditForm((p) => ({ ...p, entry_date: v }))} /></div>
              <div />
            </div>
            <label
              className={cn(
                'flex w-fit cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition',
                editForm.is_direct_mnc ? 'border-violet-300 bg-violet-50 text-violet-900' : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              <Switch
                checked={!!editForm.is_direct_mnc}
                onCheckedChange={(v) => {
                  // Only a real off→on flip needs asking — an entry that is
                  // already MNC re-affirming the same state is not a change.
                  if (
                    v &&
                    !editForm.is_direct_mnc &&
                    !window.confirm(
                      'Mark this as DIRECT MNC STOCK?\n\nThe vehicle is the party’s own — no tanker is linked, and you name the MNC / direct-purchase party sending it.'
                    )
                  ) {
                    return
                  }
                  setEditForm((p) => ({ ...p, is_direct_mnc: v, supplier_id: v ? p.supplier_id : '' }))
                }}
              />
              <span className="font-medium">Direct MNC stock</span>
            </label>
            {editForm.is_direct_mnc && (
              <div className="flex flex-col gap-1.5">
                <Label>MNC / party</Label>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {editForm.supplier_id ? (
                    suppliers.find((x) => String(x.id) === String(editForm.supplier_id))?.name || '—'
                  ) : (
                    <span className="italic text-muted-foreground">
                      Not set yet — assign it from Consignment stock → Validate
                    </span>
                  )}
                </div>
              </div>
            )}
            {partyEditable(editForm) && (
              <div className="flex flex-col gap-1.5">
                <Label>
                  Party <span className="text-[10px] font-normal text-muted-foreground">(supplier or customer)</span>
                </Label>
                <Select
                  searchable
                  value={String(editForm.party || '')}
                  onValueChange={(v) => setEditForm((p) => ({ ...p, party: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {(() => {
                      const keepSup = String(editForm.party || '').startsWith('s:') ? String(editForm.party).slice(2) : null
                      const keepCus = String(editForm.party || '').startsWith('c:') ? String(editForm.party).slice(2) : null
                      const sup = partiesIn(allSuppliers, 'supplier', String(editForm.rec_type || ''), keepSup)
                      const cus = partiesIn(customers, 'customer', String(editForm.rec_type || ''), keepCus)
                      return (
                        <>
                          {sup.rows.length > 0 && (
                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Suppliers
                            </div>
                          )}
                          {sup.rows.map((x) => (
                            <SelectItem key={`s${x.id}`} value={`s:${x.id}`}>{x.name}</SelectItem>
                          ))}
                          {cus.rows.length > 0 && (
                            <div className="mt-1 border-t px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Customers
                            </div>
                          )}
                          {cus.rows.map((x) => (
                            <SelectItem key={`c${x.id}`} value={`c:${x.id}`}>{x.name}</SelectItem>
                          ))}
                        </>
                      )
                    })()}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5"><Label>{editForm.is_direct_mnc ? 'Vehicle number *' : 'Tanker no *'}</Label><Input value={editForm.tanker_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, tanker_no: e.target.value }))} /></div>
              <div className="flex flex-col gap-1.5">
                <Label>Rec type</Label>
                <Select searchable value={editForm.rec_type || 'OIL'} onValueChange={(v) => setEditForm((p) => ({ ...p, rec_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{recTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Product</Label>
                <Select
                  searchable
                  value={String(editForm.oil_type_id || '')}
                  onValueChange={(v) => setEditForm((p) => ({ ...p, oil_type_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                  <SelectContent>
                    {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Gross wt</Label><Input type="number" value={editForm.gross_weight ?? ''} onChange={(e) => setEditForm((p) => syncNet({ ...p, gross_weight: e.target.value }))} /></div>
              <div className="flex flex-col gap-1.5"><Label>Tare wt</Label><Input type="number" value={editForm.tare_weight ?? ''} onChange={(e) => setEditForm((p) => syncNet({ ...p, tare_weight: e.target.value }))} /></div>
              <div className="flex flex-col gap-1.5"><Label>UOM</Label><Input value={editForm.uom || ''} onChange={(e) => setEditForm((p) => ({ ...p, uom: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Dispatch qty</Label><Input placeholder={DISPATCH_HINT} value={editForm.dispatch_qty ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, dispatch_qty: cleanDispatch(e.target.value) }))} /></div>
              {(() => {
                // The weighbridge decides the net, so on a weighed entry it is
                // shown, not typed — change Gross or Tare and it follows. An
                // entry finished without weighment has nothing to derive it
                // from, so there it stays typeable.
                const d = derivedNet(editForm)
                return (
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Received (net){' '}
                      {d != null && (
                        <span className="text-[10px] font-normal normal-case text-muted-foreground">
                          (Gross − Tare)
                        </span>
                      )}
                    </Label>
                    <Input
                      type="number"
                      disabled={d != null}
                      className={d != null ? 'bg-muted/50 text-muted-foreground' : ''}
                      value={d != null ? String(d) : editForm.received_qty ?? ''}
                      onChange={(e) => setEditForm((p) => ({ ...p, received_qty: e.target.value }))}
                    />
                  </div>
                )
              })()}
            </div>
            <div className="flex flex-col gap-1.5"><Label>Note</Label><Input value={editForm.note || ''} onChange={(e) => setEditForm((p) => ({ ...p, note: e.target.value }))} /></div>
            <p className="text-xs text-muted-foreground">The net is Gross − Tare and cannot be typed — correct the two weights and it follows. An entry with no Gross was finished without weighment, so there the net is entered directly. Leaving everything empty keeps the entry pending.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </DialogFooter>
          </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
