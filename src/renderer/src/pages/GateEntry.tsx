import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ClipboardList,
  LogIn, LogOut, Pencil, Scale, Trash2, Truck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { InfoTip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { errText, formatDate, formatNum, todayISO } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange } from '@/lib/globalDateRange'
import { useCategories } from '@/lib/useCategories'
import { Pagination, usePaged } from '@/components/Pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Receipt classification for a gate entry.
// Miscellaneous covers goods with no trading party behind them — workshop
// material, empty drums, samples. The gate records what it is, not whose it is.
const isMisc = (v: unknown): boolean => {
  const c = String(v || '').trim().toUpperCase()
  return c === 'MISCELLANEOUS' || c === 'MISC'
}

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

export function GateEntry(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  // Register filters: date range on the entry date, receipt category, free text.
  const [gFrom, setGFrom] = useState('')
  const [gTo, setGTo] = useState('')
  const [gCat, setGCat] = useState('ALL')
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRange.version > 0) { setGFrom(globalRange.from); setGTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const [gSearch, setGSearch] = useState('')
  const [gDir, setGDir] = useState<'ALL' | 'in' | 'out'>('ALL')
  const gCats = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.rec_type || '')).filter(Boolean))).sort(),
    [rows]
  )
  const filteredRows = useMemo(() => {
    const q = gSearch.trim().toLowerCase()
    return rows.filter((r) => {
      const d = String(r.entry_date || '').slice(0, 10)
      if (gFrom && d < gFrom) return false
      if (gTo && d > gTo) return false
      if (gCat !== 'ALL' && String(r.rec_type || '') !== gCat) return false
      if (gDir !== 'ALL' && String(r.direction || 'in') !== gDir) return false
      if (!q) return true
      return [r.gate_entry_no, r.ref_no, r.tanker_no, r.supplier_name, r.sale_customer, r.sale_invoice, r.person, r.note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [rows, gFrom, gTo, gCat, gDir, gSearch])
  const paged = usePaged(filteredRows)
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

  function modeToggle(mode: 'with' | 'without', set: (m: 'with' | 'without') => void, pending: number): React.JSX.Element {
    return (
      <div className="mb-3 inline-flex rounded-lg border border-[#d9d2b8] bg-[#f1ecd9] p-0.5">
        {(['with', 'without'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => set(m)}
            className={cn(
              'cursor-pointer rounded-md px-3.5 py-1.5 text-[12px] font-semibold transition-colors',
              mode === m ? 'bg-[#1a2c56] text-white' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {m === 'with' ? 'With weighment' : 'Without weighment'}
            {m === 'with' && pending > 0 && (
              <span className={cn('ml-1.5 rounded-full px-1.5 text-[10px]', mode === m ? 'bg-white/20' : 'bg-amber-200 text-amber-900')}>
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
  // per-pending-entry weighbridge inputs (gross / tare → net)
  const [weights, setWeights] = useState<Record<number, { gross: string; tare: string }>>({})
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [editForm, setEditForm] = useState<Row>({})

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

  const pending = rows.filter((r) => r.status === 'pending')
  const pendingIn = pending.filter((r) => String(r.direction || 'in') === 'in').length
  const pendingOut = pending.filter((r) => String(r.direction || 'in') === 'out').length
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
  function partiesIn(list: Row[], side: 'supplier' | 'customer', category: string): { rows: Row[]; narrowed: boolean } {
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
        dispatch_qty: Number(arrival.dispatch_qty) || 0,
        // Without weighment the declared quantity stands as the entry's figure.
        received_qty: arrival.no_weighment ? Number(arrival.dispatch_qty) || 0 : 0,
        no_weighment: !!arrival.no_weighment,
        status: arrival.no_weighment ? 'completed' : 'pending'
      })
      toast.success(
        arrival.no_weighment
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
  async function saveWeight(row: Row): Promise<void> {
    const w = storedWeights(row)
    const gross = w.gross === '' ? null : Number(w.gross)
    const tare = w.tare === '' ? null : Number(w.tare)
    if (gross == null && tare == null) return void toast.error('Enter the gross or the tare weight')
    try {
      const r = await window.api.gate.weights(row.id, gross, tare)
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
  function storedWeights(row: Row): { gross: string; tare: string } {
    const typed = weights[row.id]
    if (typed) return typed
    return {
      gross: row.gross_weight == null ? '' : String(row.gross_weight),
      tare: row.tare_weight == null ? '' : String(row.tare_weight)
    }
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
      dispatch_qty: row.dispatch_qty ?? '',
      received_qty: row.received_qty ?? '',
      gross_weight: row.gross_weight ?? '',
      tare_weight: row.tare_weight ?? '',
      uom: row.uom || 'MT',
      note: row.note || '',
      is_direct_mnc: !!row.is_direct_mnc,
      supplier_id: row.supplier_id ? String(row.supplier_id) : ''
    })
  }

  async function saveEdit(): Promise<void> {
    if (!editRow) return
    try {
      await window.api.gate.update(editRow.id, {
        ...editForm,
        tanker_id: editForm.tanker_id ? Number(editForm.tanker_id) : null,
        oil_type_id: editForm.oil_type_id ? Number(editForm.oil_type_id) : null,
        dispatch_qty: Number(editForm.dispatch_qty) || 0,
        received_qty: Number(editForm.received_qty) || 0,
        is_direct_mnc: !!editForm.is_direct_mnc,
        supplier_id: editForm.is_direct_mnc && editForm.supplier_id ? Number(editForm.supplier_id) : null
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

  // The 'Without weighment' view of a tab: the plain register line — vehicle,
  // person, material — finished on the spot. Identical for both directions;
  // the tab supplies the direction.
  function quickEntry(dir: 'in' | 'out'): React.JSX.Element {
    return (
        <section className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white">
          <div className="mb-3 flex items-center gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-200 text-slate-700">
              <ClipboardList className="h-4 w-4" />
            </div>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Without weighment — quick entry</h3>
            <InfoTip text="The plain gate-register line: which vehicle, who it is with, and what it carries. It completes on the spot — no weighment, no invoice, and it touches no stock or purchase." />
            <span className="ml-auto rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-700">
              {dir === 'in' ? 'Coming in' : 'Going out'}
            </span>
          </div>
          <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid min-w-0 gap-1">
              <Label>Vehicle number *</Label>
              <Input
                value={quick.tanker_no || ''}
                placeholder="e.g. UP14 HT 5682"
                onChange={(e) => setQuick((p) => ({ ...p, tanker_no: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && recordQuick(dir)}
              />
            </div>
            <div className="grid min-w-0 gap-1">
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
            <div className="grid min-w-0 gap-1">
              <Label>Material *</Label>
              <Input
                value={quick.note || ''}
                placeholder="What is in the vehicle"
                onChange={(e) => setQuick((p) => ({ ...p, note: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && recordQuick(dir)}
              />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label>Date</Label>
              <DatePicker value={quick.entry_date || ''} onChange={(v) => setQuick((p) => ({ ...p, entry_date: v }))} />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
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
    const list = pending.filter((r) => String(r.direction || 'in') === dir)
    return (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-700">
              <Scale className="h-4 w-4" />
            </div>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Waiting for weighment</h3>
            <InfoTip text="Enter the weighbridge Gross and Tare; the net (gross − tare) is calculated and completes the entry." />
            <Badge variant={list.length ? 'warning' : 'muted'} className="ml-1">{list.length}</Badge>
          </div>
          {list.length === 0 ? (
            <div className="rounded-xl border border-dashed py-5 text-center text-sm text-muted-foreground">
              No tankers waiting for weight.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {list.map((row) => (
                <div key={row.id} className="flex flex-col rounded-xl border border-amber-200 bg-card shadow-sm transition-shadow hover:shadow-md">
                  {/* Identity strip: vehicle + direction, never wrapping. */}
                  <div className="flex items-center gap-2 rounded-t-xl border-b border-amber-100 bg-amber-50/60 px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                        row.direction === 'out' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                      )}
                    >
                      {row.direction === 'out' ? <LogOut className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
                    </span>
                    <span className="truncate text-[13.5px] font-bold tracking-wide">{row.tanker_no}</span>
                    <Badge
                      variant={row.direction === 'out' ? 'default' : 'warning'}
                      className="ml-auto shrink-0 whitespace-nowrap"
                    >
                      {row.direction === 'out' ? 'OUT' : 'IN'}
                    </Badge>
                  </div>

                  <div className="flex flex-1 flex-col px-3 pb-3 pt-2">
                    <div className="truncate text-[12.5px] font-medium" title={String(row.direction === 'out' ? row.sale_customer || '' : row.supplier_name || '')}>
                      {row.direction === 'out'
                        ? (row.sale_invoice || row.sale_customer
                            ? <>{row.sale_customer || '—'}{row.sale_invoice ? <span className="text-muted-foreground"> · {row.sale_invoice}</span> : ''}</>
                            : <span className="font-medium text-amber-700">No bill{row.note ? ` — ${row.note}` : ''}</span>)
                        : <>{row.supplier_name || '—'}{row.bargain_no ? <span className="text-muted-foreground"> · {row.bargain_no}</span> : ''}</>}
                    </div>
                    {/* Meta as aligned label/value pairs instead of a wrapping sentence. */}
                    <div className="mt-1.5 grid grid-cols-3 gap-1 text-center">
                      {[
                        { l: 'Gate no', v: String(row.gate_entry_no || '—') },
                        { l: String(row.rec_type || 'OIL'), v: formatDate(row.entry_date) },
                        { l: 'Dispatch', v: Number(row.dispatch_qty) > 0 ? `${formatNum(row.dispatch_qty)} ${row.uom}` : '—' }
                      ].map((x) => (
                        <div key={x.l} className="rounded bg-muted/50 px-1 py-0.5">
                          <div className="truncate text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{x.l}</div>
                          <div className="truncate text-[11px] font-medium tabular-nums">{x.v}</div>
                        </div>
                      ))}
                    </div>
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
                      const setW = (k: 'gross' | 'tare', val: string): void =>
                        setWeights((p) => ({ ...p, [row.id]: { ...storedWeights(row), [k]: val } }))
                      return (
                        <div className="mt-auto">
                          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                            <div className="grid gap-0.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Gross ({row.uom})</span>
                              <Input type="number" className="h-8 text-right tabular-nums" placeholder="0.000" value={w.gross}
                                onChange={(e) => setW('gross', e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)} />
                            </div>
                            <div className="grid gap-0.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Tare ({row.uom})</span>
                              <Input type="number" className="h-8 text-right tabular-nums" placeholder="0.000" value={w.tare}
                                onChange={(e) => setW('tare', e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)} />
                            </div>
                          </div>
                          {/* One figure saves and waits; both complete. */}
                          {(hasG || hasT) && !both && (
                            <div className="mt-1.5 rounded bg-amber-100/70 px-2 py-1 text-[10.5px] font-medium text-amber-900">
                              {hasG ? 'Gross recorded — waiting for the tare weight' : 'Tare recorded — waiting for the gross weight'}
                            </div>
                          )}
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className={cn('text-[12px]', ready ? 'font-semibold text-emerald-700' : 'text-muted-foreground')}>
                              Net <span className="tabular-nums">{ready ? formatNum(net) : '—'}</span> {row.uom}
                            </span>
                            <span className="flex items-center gap-1">
                              {!isOil && !hasG && !hasT && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2 text-[11px]"
                                  title="Finish this entry with no weighment (not allowed for oil)"
                                  onClick={() => void skipWeighment(row)}
                                >
                                  No weighment
                                </Button>
                              )}
                              <Button
                                size="sm"
                                className="h-8"
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
              ))}
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
            filename={`gate-entries-${todayISO()}`}
            sheetName="Gate entries"
            title="Gate entries"
            columns={[
              { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
              { header: 'Date', key: 'entry_date', value: (r) => formatDate(r.entry_date) },
              { header: 'In / Out', key: 'direction', value: (r) => (r.direction === 'out' ? 'OUT' : 'IN') },
              { header: 'Rec type', key: 'rec_type', value: (r) => r.rec_type || 'OIL' },
              { header: 'Vehicle', key: 'tanker_no', value: (r) => r.tanker_no || '' },
              { header: 'Party', key: 'party', value: (r) => r.party || r.supplier_name || r.customer || '' },
              { header: 'Gross', key: 'gross_weight', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.gross_weight) || 0 },
              { header: 'Tare', key: 'tare_weight', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.tare_weight) || 0 },
              { header: 'Net qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
              { header: 'Status', key: 'status', value: (r) => (r.status === 'completed' ? 'Done' : 'Pending') },
              { header: 'Weighed', key: 'no_weighment', value: (r) => (String(r.entry_kind) === 'simple' ? 'Quick entry' : Number(r.no_weighment) === 1 ? 'No weighment' : 'Yes') },
              { header: 'Person', key: 'person', value: (r) => r.person || '' },
              { header: 'Note / material', key: 'note', value: (r) => r.note || '' }
            ]}
            rows={rows}
          />
        }
      />
      <div className="w-full px-4 py-5">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <TabsList>
              <TabsTrigger value="in">
                Gate in
                {pendingIn > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 text-[10px] font-semibold text-amber-900">
                    {pendingIn}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="out">
                Gate out
                {pendingOut > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 text-[10px] font-semibold text-amber-900">
                    {pendingOut}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="view">
                Entries
                {rows.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
                    {rows.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            {tab === 'view' && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-2.5 py-1">
                <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
                  {(['ALL', 'in', 'out'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition',
                        gDir === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setGDir(d)}
                    >
                      {d === 'ALL' ? 'All' : d}
                    </button>
                  ))}
                </div>
                <div className="h-5 shrink-0 border-l" />
                <div className="relative shrink-0">
                  <Input
                    type="search"
                    className="h-7 w-52 pl-2 text-[11px]"
                    placeholder="Search gate no, vehicle, party…"
                    value={gSearch}
                    onChange={(e) => setGSearch(e.target.value)}
                  />
                </div>
                <div className="h-5 shrink-0 border-l" />
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                    Date
                  </span>
                  <DatePicker value={gFrom} onChange={(v) => setGFrom(v || '')} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                  <span className="shrink-0 text-[10px] text-muted-foreground">to</span>
                  <DatePicker value={gTo} onChange={(v) => setGTo(v || '')} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                </div>
                <div className="h-5 shrink-0 border-l" />
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                    Category
                  </span>
                  <Select value={gCat} onValueChange={setGCat}>
                    <SelectTrigger className="h-7 w-[10.5rem] shrink-0 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All categories</SelectItem>
                      {gCats.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {(gFrom || gTo || gCat !== 'ALL' || gDir !== 'ALL' || gSearch) && (
                  <>
                    <div className="h-5 shrink-0 border-l" />
                    <button
                      type="button"
                      className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                      onClick={() => { setGFrom(''); setGTo(''); setGCat('ALL'); setGDir('ALL'); setGSearch('') }}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <TabsContent value="in" className="space-y-4">
        {modeToggle(inMode, setInMode, pendingIn)}
        {inMode === 'without' ? quickEntry('in') : (<>
        {/* Tanker IN */}
        <section className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white">
          <div className="mb-3 flex items-center gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
              <Truck className="h-4 w-4" />
            </div>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Tanker in</h3>
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
          <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {arrival.is_direct_mnc ? (
              <div className="grid min-w-0 gap-1">
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
              <div className="grid min-w-0 gap-1">
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
            <div className="grid min-w-0 gap-1">
              <Label>{arrival.is_direct_mnc ? 'Vehicle number *' : 'Tanker number *'}</Label>
              <Input
                value={arrival.tanker_no || ''}
                placeholder={arrival.is_direct_mnc ? 'Type the vehicle number' : ''}
                onChange={(e) => setArrival((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            <div className="grid min-w-0 gap-1">
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
              <div className="grid min-w-0 gap-1">
                <Label>
                  Party <span className="text-[10px] font-normal text-muted-foreground">(supplier or customer)</span>
                </Label>
                <Select
                  searchable
                  value={String(arrival.party || '')}
                  onValueChange={(v) => setArrival((p) => ({ ...p, party: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {(() => {
                      const sup = partiesIn(allSuppliers, 'supplier', String(arrival.rec_type || ''))
                      const cus = partiesIn(customers, 'customer', String(arrival.rec_type || ''))
                      return (
                        <>
                          {sup.rows.length > 0 && (
                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Suppliers{sup.narrowed ? ` · ${String(arrival.rec_type).toUpperCase()}` : ''}
                            </div>
                          )}
                          {sup.rows.map((x) => (
                            <SelectItem key={`s${x.id}`} value={`s:${x.id}`}>{x.name}</SelectItem>
                          ))}
                          {cus.rows.length > 0 && (
                            <div className="mt-1 border-t px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                              Customers{cus.narrowed ? ` · ${String(arrival.rec_type).toUpperCase()}` : ''}
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
            {/* Miscellaneous has no product behind it, so let the gateman say
                what actually came in. */}
            {String(arrival.rec_type || '').toUpperCase() === 'MISCELLANEOUS' && (
              <div className="grid min-w-0 gap-1 sm:col-span-2">
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
            <div className="grid min-w-0 gap-1">
              <Label className="flex items-center gap-1">Gate entry no <span className="text-[10px] font-normal text-muted-foreground">(auto)</span></Label>
              <Input value={arrival.gate_entry_no || ''} disabled className="bg-muted/50 text-muted-foreground" />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label className="flex items-center gap-1">Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input value={arrival.ref_no || ''} placeholder="Gate-register no…" onChange={(e) => setArrival((p) => ({ ...p, ref_no: e.target.value }))} />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label>Date</Label>
              <DatePicker value={arrival.entry_date || ''} onChange={(v) => setArrival((p) => ({ ...p, entry_date: v }))} />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button className="h-8 bg-emerald-600 px-4 text-[13px] font-semibold hover:bg-emerald-700" onClick={recordArrival} disabled={savingArrival}>
              <Truck className="h-4 w-4" />
              {savingArrival ? 'Saving…' : 'Tanker received'}
            </Button>
          </div>
        </section>

        {weighQueue('in')}
        </>)}

          </TabsContent>

          <TabsContent value="out" className="space-y-4">
        {modeToggle(outMode, setOutMode, pendingOut)}
        {outMode === 'without' ? quickEntry('out') : (<>
        {/* Gate OUT — sale dispatch leaving the factory */}
        <section className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] p-4 shadow-sm [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white [&_textarea]:bg-white">
          <div className="mb-3 flex items-center gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-100 text-sky-700">
              <LogOut className="h-4 w-4" />
            </div>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Gate out</h3>
            <InfoTip text="Record a sale dispatch leaving the factory. Only dispatched sales (Loaded / In transit / Unloaded) that haven't gone out yet are listed. The exit weight completes it." />
          </div>
          <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <div className="grid min-w-0 gap-1 sm:col-span-2 lg:col-span-1">
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
            <div className="grid min-w-0 gap-1">
              <Label>
                Reason / note{' '}
                {!gateOut.invoice_group && <span className="text-[10px] font-normal text-amber-700">required without an invoice</span>}
              </Label>
              <Input
                value={gateOut.note || ''}
                placeholder="e.g. empty tanker returning"
                onChange={(e) => setGateOut((p) => ({ ...p, note: e.target.value }))}
              />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label>Vehicle number *</Label>
              <Input value={gateOut.tanker_no || ''} onChange={(e) => setGateOut((p) => ({ ...p, tanker_no: e.target.value }))} />
            </div>
            {/* With no invoice behind it the vehicle belongs to nobody, so the
                party is named here — the same combined list as Gate in.
                Miscellaneous has no trading party, so it is not asked for. */}
            {!gateOut.invoice_group && !isMisc(gateOut.rec_type) && (
              <div className="grid min-w-0 gap-1">
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
            <div className="grid min-w-0 gap-1">
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
            <div className="grid min-w-0 gap-1">
              <Label className="flex items-center gap-1">Gate out no <span className="text-[10px] font-normal text-muted-foreground">(auto)</span></Label>
              <Input value={gateOut.gate_entry_no || ''} disabled className="bg-muted/50 text-muted-foreground" />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label className="flex items-center gap-1">Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input value={gateOut.ref_no || ''} placeholder="Gate-register no…" onChange={(e) => setGateOut((p) => ({ ...p, ref_no: e.target.value }))} />
            </div>
            <div className="grid min-w-0 gap-1">
              <Label>Date</Label>
              <DatePicker value={gateOut.entry_date || ''} onChange={(v) => setGateOut((p) => ({ ...p, entry_date: v }))} />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button className="h-8 bg-sky-600 px-4 text-[13px] font-semibold hover:bg-sky-700" onClick={recordGateOut} disabled={savingOut}>
              <LogOut className="h-4 w-4" />
              {savingOut ? 'Saving…' : 'Vehicle out'}
            </Button>
          </div>
        </section>

        {weighQueue('out')}
        </>)}
          </TabsContent>

          <TabsContent value="view">
        {/* History */}
        <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold">Gate register</div>
          <Table className="text-[13px]">
            <TableHeader><TableRow>
              <TableHead>Gate entry no</TableHead>
              <TableHead>In / Out</TableHead>
              <TableHead>Rec type</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Vehicle · party</TableHead>
              <TableHead className="text-right">Dispatch qty</TableHead>
              <TableHead className="text-right">Received (net)</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>Status</TableHead>
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
                  const diff = Number(row.dispatch_qty || 0) - Number(row.received_qty || 0)
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        <div>{row.gate_entry_no}</div>
                        {row.ref_no && <div className="text-[11px] font-normal text-muted-foreground">Manual: {row.ref_no}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={isOut ? 'default' : 'muted'}>{isOut ? 'OUT' : 'IN'}</Badge>
                      </TableCell>
                      <TableCell><span className="text-xs font-medium text-muted-foreground">{row.rec_type || 'OIL'}</span></TableCell>
                      <TableCell>{formatDate(row.entry_date)}</TableCell>
                      <TableCell>
                        <div>{row.tanker_no}</div>
                        {String(row.entry_kind) === 'simple' ? (
                          <div className="text-xs">
                            <span className="font-medium text-slate-700">{row.person || 'Quick entry'}</span>
                            {row.note ? <span className="text-muted-foreground"> · {row.note}</span> : ''}
                          </div>
                        ) : isOut ? (
                          <div className="text-xs text-muted-foreground">
                            {row.sale_invoice || row.sale_customer
                              ? <>{row.sale_customer || '—'}{row.sale_invoice ? ` · ${row.sale_invoice}` : ''}{row.sale_product ? ` · ${row.sale_product}` : ''}</>
                              : <span className="font-medium text-amber-700">No bill{row.note ? ` — ${row.note}` : ''}</span>}
                          </div>
                        ) : (
                          row.supplier_name && <div className="text-xs text-muted-foreground">{row.supplier_name}{row.bargain_no ? ` · ${row.bargain_no}` : ''}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNum(row.dispatch_qty)} {row.uom}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {done ? (
                          <>
                            <div>{formatNum(row.received_qty)} {row.uom}</div>
                            {(row.gross_weight != null || row.tare_weight != null) && (
                              <div className="text-[11px] text-muted-foreground">G {formatNum(row.gross_weight)} · T {formatNum(row.tare_weight)}</div>
                            )}
                          </>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {!done ? <span className="text-muted-foreground">—</span> : Math.abs(diff) < 0.0005 ? <Badge variant="muted">0</Badge> : <span className={diff > 0 ? 'text-amber-700' : 'text-emerald-700'}>{formatNum(diff)} {row.uom}</span>}
                      </TableCell>
                      <TableCell>
                        {done ? <Badge variant="success">Completed</Badge> : <Badge variant="warning">Pending weight</Badge>}
                        {Number(row.no_weighment) === 1 && (
                          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
                            {String(row.entry_kind) === 'simple' ? 'Quick entry' : 'No weighment'}
                          </div>
                        )}
                      </TableCell>
                      <TableCell><div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => remove(row)}><Trash2 className="h-4 w-4" /></Button>
                      </div></TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
          <Pagination {...paged} label="gate entries" className="border-t px-3" />
        </section>
          </TabsContent>
        </Tabs>
      </div>

      {/* Correction dialog (office use) */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit {editRow?.gate_entry_no}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Gate entry no *</Label><Input value={editForm.gate_entry_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, gate_entry_no: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Manual gate no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label><Input value={editForm.ref_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, ref_no: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Date *</Label><DatePicker value={editForm.entry_date || ''} onChange={(v) => setEditForm((p) => ({ ...p, entry_date: v }))} /></div>
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
              <div className="grid gap-1.5">
                <Label>MNC / party *</Label>
                <Select
                  searchable
                  value={String(editForm.supplier_id || '')}
                  onValueChange={(v) => setEditForm((p) => ({ ...p, supplier_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent>
                    {partiesIn(suppliers, 'supplier', String(editForm.rec_type || '')).rows.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>{editForm.is_direct_mnc ? 'Vehicle number *' : 'Tanker no *'}</Label><Input value={editForm.tanker_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, tanker_no: e.target.value }))} /></div>
              <div className="grid gap-1.5">
                <Label>Rec type</Label>
                <Select searchable value={editForm.rec_type || 'OIL'} onValueChange={(v) => setEditForm((p) => ({ ...p, rec_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{recTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5"><Label>Gross wt</Label><Input type="number" value={editForm.gross_weight ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, gross_weight: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Tare wt</Label><Input type="number" value={editForm.tare_weight ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, tare_weight: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>UOM</Label><Input value={editForm.uom || ''} onChange={(e) => setEditForm((p) => ({ ...p, uom: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Dispatch qty</Label><Input type="number" value={editForm.dispatch_qty ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, dispatch_qty: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Received (net)</Label><Input type="number" value={editForm.received_qty ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            <div className="grid gap-1.5"><Label>Note</Label><Input value={editForm.note || ''} onChange={(e) => setEditForm((p) => ({ ...p, note: e.target.value }))} /></div>
            <p className="text-xs text-muted-foreground">Enter Gross &amp; Tare and the net is computed automatically; otherwise the Received (net) figure is used. Leaving both empty keeps the entry pending.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
