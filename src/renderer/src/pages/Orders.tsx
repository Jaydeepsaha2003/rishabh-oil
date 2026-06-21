import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Eye, Pencil, Plus, Trash2, Truck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { computeMoney, computeShortage } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TANKER_STAGES = ['supplier_factory', 'loaded', 'transit', 'outside_factory', 'inside_factory', 'empty']
const TANKER_LABEL: Record<string, string> = {
  supplier_factory: 'Inside supplier factory',
  loaded: 'Loaded',
  transit: 'In transit',
  outside_factory: 'Outside factory',
  inside_factory: 'Inside factory',
  empty: 'Empty'
}

function nextTankerStage(status: string): string | null {
  const i = TANKER_STAGES.indexOf(status)
  return i >= 0 && i < TANKER_STAGES.length - 1 ? TANKER_STAGES[i + 1] : null
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant = status === 'empty' || status === 'received' ? 'success' : status === 'loaded' ? 'warning' : 'secondary'
  return <Badge variant={variant}>{TANKER_LABEL[status] ?? (status === 'received' ? 'Completed' : status)}</Badge>
}

function Summary({ label, value, note }: { label: string; value: string; note: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  )
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

export function Orders(): React.JSX.Element {
  const [tab, setTab] = useState('tankers')
  const [rows, setRows] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [sources, setSources] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const [loadingOpen, setLoadingOpen] = useState(false)
  const [loadingForm, setLoadingForm] = useState<Row>({ tanker_count: 1, factory_entry_date: todayISO() })
  const [loadingRows, setLoadingRows] = useState<Row[]>([{}])
  const [actionRow, setActionRow] = useState<Row | null>(null)
  const [actionForm, setActionForm] = useState<Row>({})
  const [detailRow, setDetailRow] = useState<Row | null>(null)

  const [formPage, setFormPage] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, pt, b, s, src, tr, cfg] = await Promise.all([
      window.api.orders.list(),
      window.api.tankers.list(),
      window.api.bargains.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('sources'),
      window.api.data.list('transporters'),
      window.api.settings.all()
    ])
    setRows(o)
    setTankers(pt)
    setBargains(b)
    setSuppliers(s)
    setSources(src.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    setSettings(cfg)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const tanker of tankers) c[tanker.status] = (c[tanker.status] || 0) + 1
    return c
  }, [tankers])

  function selectLoadingBargain(index: number, id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    setLoadingRows((current) => current.map((row, i) => i === index ? {
      ...row,
      bargain_id: b.id,
      supplier_id: b.supplier_id,
      oil_type_id: b.oil_type_id,
      supplier_name: b.supplier_name,
      oil_label: `${b.oil_code} · ${b.oil_name}`,
      uom: b.uom,
      balance_qty: b.balance_qty
    } : row))
  }

  function setTankerCount(value: string): void {
    const count = Math.max(1, Math.min(20, Number(value) || 1))
    setLoadingForm((p) => ({ ...p, tanker_count: count }))
    setLoadingRows((current) => Array.from({ length: count }, (_, i) => current[i] || {}))
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
          factory_entry_date: loadingForm.factory_entry_date
        })
      }
      toast.success(`${loadingRows.length} tanker${loadingRows.length === 1 ? '' : 's'} sent inside supplier factory`)
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
    const next: Row = {}
    if (target === 'loaded') Object.assign(next, {
      loaded_date: todayISO(),
      loaded_qty: '',
      payment_mode: 'paid_by_us',
      source_id: ''
    })
    if (target === 'transit') Object.assign(next, { transit_date: todayISO(), source_id: '' })
    if (target === 'outside_factory') next.outside_factory_date = todayISO()
    if (target === 'inside_factory') next.inside_factory_date = todayISO()
    if (target === 'empty') Object.assign(next, {
      empty_date: todayISO(),
      received_qty: row.loaded_qty,
      transporter_id: row.transporter_id || '',
      transport_rate_per_ton: transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton || ''
    })
    setActionForm(next)
    setActionRow(row)
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
    if (target === 'empty' && (actionRow.bargain_type || 'Ex') !== 'Delivered' && !actionForm.transporter_id) {
      toast.error('Select a transporter')
      return
    }
    try {
      await window.api.tankers.advance(actionRow.id, target, {
        ...actionForm,
        loaded_qty: Number(actionForm.loaded_qty) || 0,
        source_id: actionForm.source_id ? Number(actionForm.source_id) : null,
        transporter_id: actionForm.transporter_id ? Number(actionForm.transporter_id) : null,
        received_qty: Number(actionForm.received_qty) || 0,
        transport_rate_per_ton: Number(actionForm.transport_rate_per_ton) || 0
      })
      toast.success(target === 'loaded' ? 'Loading confirmed and tanker moved to In transit' : `Tanker moved to ${TANKER_LABEL[target]}`)
      setActionRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
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
      oil_label: `${b.oil_code} · ${b.oil_name}`,
      uom: b.uom,
      invoice_rate: p.invoice_rate || b.rate_per_uom,
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
    setForm({ invoice_no: '', order_date: todayISO(), is_registered_transporter: true, transporter_id: '' })
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
      oil_label: `${row.oil_code} · ${row.oil_name}`,
      uom: row.uom,
      invoice_no: row.invoice_no,
      order_date: row.order_date,
      invoice_rate: row.invoice_rate,
      gst_pct: row.gst_pct,
      tds_pct: supplier?.tds_pct ?? row.tds_pct,
      tds_threshold: supplier?.tds_threshold ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      adds_interest: !!supplier?.adds_interest,
      interest_pct: supplier?.interest_pct ?? row.interest_pct,
      interest_days: supplier?.interest_days ?? row.interest_days,
      transporter_id: row.transporter_id || '',
      is_registered_transporter: !!row.is_registered_transporter
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
      x.bargain_id === form.bargain_id &&
      x.status !== 'supplier_factory' &&
      Number(x.loaded_qty) > 0 &&
      (x.order_id == null || x.order_id === editing?.id)
    ),
    [tankers, form.bargain_id, editing]
  )
  const chosenTankers = useMemo(() => tankers.filter((x) => selected.includes(Number(x.id))), [tankers, selected])
  const totalQty = chosenTankers.reduce((sum, x) => sum + Number(x.loaded_qty || 0), 0)
  const financedCount = chosenTankers.filter((x) => x.payment_mode === 'supplier_finance').length
  const calc = useMemo(() => computeMoney({
    orderedQty: totalQty,
    invoiceRate: Number(form.invoice_rate) || 0,
    bargainRate: Number(form.bargain_rate) || 0,
    gstPct: Number(form.gst_pct) || 0,
    tdsPct: form.tds_above_only ? 0 : Number(form.tds_pct) || 0,
    addsInterest: !!form.adds_interest,
    interestPct: Number(form.interest_pct) || 0,
    interestDays: Number(form.interest_days) || 0,
    tdsThreshold: Number(form.tds_threshold) || 0,
    tdsPctAbove: Number(form.tds_pct) || 0,
    tdsPrior: Number(form.tds_prior) || 0
  }), [form, totalQty])

  async function savePurchase(): Promise<void> {
    if (!form.bargain_id) return setError('Select a bargain')
    if (!form.invoice_no) return setError('Invoice number is required')
    if (!selected.length) return setError('Select at least one loaded tanker')
    if (!form.transporter_id) return setError('Select the transporter')
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
      transporter_id: Number(form.transporter_id),
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

  const target = actionRow ? nextTankerStage(actionRow.status) : null
  const shortage = actionRow ? computeShortage({
    orderedQty: Number(actionRow.loaded_qty) || 0,
    receivedQty: Number(actionForm.received_qty) || 0,
    allowedPct: Number(settings.allowed_shortage_pct || 0),
    bargainRate: Number(actionRow.bargain_rate) || 0,
    transportRatePerTon: Number(actionForm.transport_rate_per_ton) || 0
  }) : null

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Load tankers first, then combine one or more tankers into a purchase invoice"
        actions={!formPage ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setLoadingOpen(true)}>
              <Truck className="h-4 w-4" /> Send tankers to supplier
            </Button>
            <Button size="sm" onClick={openNewPurchase}>
              <Plus className="h-4 w-4" /> New purchase
            </Button>
          </div>
        ) : undefined}
      />

      {formPage ? (
        <div className="p-8">
          <button className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setFormPage(false)}>
            <ArrowLeft className="h-4 w-4" /> Back to purchases
          </button>
          <div className="mb-6">
            <h2 className="text-xl font-semibold">{editing ? `Edit purchase ${editing.invoice_no}` : 'Create purchase invoice'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Select all loaded tankers covered by this single supplier invoice.</p>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
            <div className="space-y-6">
              <section className="rounded-xl border bg-card p-5">
                <h3 className="mb-4 font-medium">Invoice and bargain</h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-1.5 md:col-span-3">
                    <Label>Bargain *</Label>
                    <Select value={String(form.bargain_id || '')} onValueChange={(v) => choosePurchaseBargain(v)}>
                      <SelectTrigger><SelectValue placeholder="Select bargain" /></SelectTrigger>
                      <SelectContent>
                        {bargains.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · {b.supplier_name} · {b.oil_code}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Invoice number *</Label>
                    <Input value={form.invoice_no || ''} onChange={(e) => setForm((p) => ({ ...p, invoice_no: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Purchase date *</Label>
                    <Input type="date" value={form.order_date || ''} onChange={(e) => setForm((p) => ({ ...p, order_date: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Invoice rate *</Label>
                    <Input type="number" value={form.invoice_rate || ''} onChange={(e) => setForm((p) => ({ ...p, invoice_rate: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>TDS %</Label>
                    <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Transporter *</Label>
                    <Select value={String(form.transporter_id || '')} onValueChange={(value) => setForm((p) => ({ ...p, transporter_id: value }))}>
                      <SelectTrigger><SelectValue placeholder="Select transporter" /></SelectTrigger>
                      <SelectContent>
                        {transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
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
                    <p className="text-xs text-muted-foreground">One invoice may include any number of loaded tankers from the same bargain.</p>
                  </div>
                  <Badge variant="secondary">{selected.length} selected</Badge>
                </div>
                {!form.bargain_id ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">Select a bargain to see its loaded tankers.</div>
                ) : selectableTankers.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No available loaded tankers for this bargain.</div>
                ) : (
                  <div className="grid gap-2">
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
                            <div className="text-xs text-muted-foreground">Loaded {formatDate(tanker.loaded_date)} · {tanker.payment_mode === 'supplier_finance' ? 'Supplier financed' : 'Paid by us'}</div>
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
              <MoneyRow label="Total loaded quantity" value={`${formatNum(totalQty)} ${form.uom || 'ton'}`} strong />
              <MoneyRow label="Paid by us" value={String(selected.length - financedCount)} />
              <MoneyRow label="Supplier financed" value={String(financedCount)} />
              <div className="my-3 border-t" />
              <MoneyRow label="Bargain rate" value={formatINR(Number(form.bargain_rate) || 0)} />
              <MoneyRow label="Adjusted invoice rate" value={formatINR(calc.adjustedRate)} />
              <MoneyRow label="Taxable value" value={formatINR(calc.taxableValue)} />
              <MoneyRow label="GST" value={formatINR(calc.gstAmount)} />
              <MoneyRow label="TDS" value={`− ${formatINR(calc.tdsAmount)}`} />
              <div className="my-3 border-t" />
              <MoneyRow label="Net purchase amount" value={formatINR(calc.netAmount)} strong />
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
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                {TANKER_STAGES.filter((stage) => stage !== 'loaded').map((stage) => <Summary key={stage} label={TANKER_LABEL[stage]} value={String(counts[stage] || 0)} note={stage === 'supplier_factory' ? 'Quantity not known yet' : 'Tankers at this stage'} />)}
              </div>
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Tanker</TableHead><TableHead>Supplier / bargain</TableHead><TableHead className="text-right">Loaded qty</TableHead>
                    <TableHead>Payment</TableHead><TableHead>Invoice</TableHead><TableHead>Stage</TableHead><TableHead className="text-right">Action</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {loading ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : tankers.length === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No tankers yet. Add the first loaded tanker.</TableCell></TableRow>
                        : tankers.map((row) => {
                          const next = nextTankerStage(row.status)
                          return <TableRow key={row.id}>
                            <TableCell><div className="font-medium">{row.tanker_no}</div><div className="text-xs text-muted-foreground">{row.status === 'supplier_factory' ? `Entered ${formatDate(row.loaded_date)}` : `Loaded ${formatDate(row.loaded_date)}`}</div></TableCell>
                            <TableCell><div>{row.supplier_name}</div><div className="text-xs text-muted-foreground">{row.bargain_no} · {row.oil_code}</div></TableCell>
                            <TableCell className="text-right tabular-nums">{Number(row.loaded_qty) > 0 ? `${formatNum(row.loaded_qty)} ${row.uom}` : 'Not loaded'}</TableCell>
                            <TableCell>{row.payment_mode === 'pending' ? <span className="text-muted-foreground">Not decided</span> : row.payment_mode === 'supplier_finance' ? <Badge variant="warning">Supplier financed</Badge> : <Badge variant="muted">Paid by us</Badge>}</TableCell>
                            <TableCell>{row.invoice_no || <span className="text-muted-foreground">Not entered</span>}</TableCell>
                            <TableCell><StatusBadge status={row.status} /></TableCell>
                            <TableCell className="text-right"><div className="flex justify-end gap-1">
                              {next && <Button size="sm" variant="outline" onClick={() => openTankerAction(row)}>{TANKER_LABEL[next]}</Button>}
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
                          <TableCell><StatusBadge status={row.status} /></TableCell>
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Send tankers inside supplier factory</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Enter only the tanker count, tanker numbers and intended bargains. Loaded quantity and payment will be entered after loading.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Number of tankers</Label>
              <Input type="number" min="1" max="20" value={loadingForm.tanker_count} onChange={(e) => setTankerCount(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Factory entry date</Label>
              <Input type="date" value={loadingForm.factory_entry_date || ''} onChange={(e) => setLoadingForm((p) => ({ ...p, factory_entry_date: e.target.value }))} />
            </div>
          </div>
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {loadingRows.map((row, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[48px_1fr_2fr]">
                <div className="flex h-9 items-center justify-center rounded-md bg-muted text-sm font-semibold">{index + 1}</div>
                <div className="grid gap-1.5">
                  <Label>Tanker number *</Label>
                  <Input value={row.tanker_no || ''} onChange={(e) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, tanker_no: e.target.value } : item))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Bargain / oil *</Label>
                  <Select value={String(row.bargain_id || '')} onValueChange={(value) => selectLoadingBargain(index, value)}>
                    <SelectTrigger><SelectValue placeholder="Select intended bargain" /></SelectTrigger>
                    <SelectContent>
                      {bargains.map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.bargain_no} · {b.supplier_name} · {b.oil_code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {row.supplier_name && <span className="text-xs text-muted-foreground">{row.supplier_name} · {row.oil_label}</span>}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setLoadingOpen(false)}>Cancel</Button><Button onClick={createTanker}>Send {loadingRows.length} tanker{loadingRows.length === 1 ? '' : 's'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!actionRow} onOpenChange={(open) => !open && setActionRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{target ? `Move ${actionRow?.tanker_no} to ${TANKER_LABEL[target]}` : 'Update tanker'}</DialogTitle></DialogHeader>
          {target === 'loaded' && <div className="grid gap-4">
            <div className="rounded-md bg-muted px-3 py-2 text-sm">
              {actionRow?.bargain_no} · {actionRow?.supplier_name} · {actionRow?.oil_code}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Loaded date</Label><Input type="date" value={actionForm.loaded_date || ''} onChange={(e) => setActionForm((p) => ({ ...p, loaded_date: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Actual loaded quantity *</Label><Input type="number" value={actionForm.loaded_qty || ''} onChange={(e) => setActionForm((p) => ({ ...p, loaded_qty: e.target.value }))} /></div>
            </div>
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
            <div className="grid gap-1.5"><Label>Transit date</Label><Input type="date" value={actionForm.transit_date || ''} onChange={(e) => setActionForm((p) => ({ ...p, transit_date: e.target.value }))} /></div>
            <div className="grid gap-1.5"><Label>Source / port</Label><Select value={String(actionForm.source_id || '')} onValueChange={(v) => setActionForm((p) => ({ ...p, source_id: v }))}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{sources.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} · {s.transit_days}d</SelectItem>)}</SelectContent></Select></div>
          </div>}
          {target === 'outside_factory' && <div className="grid gap-1.5"><Label>Outside factory date</Label><Input type="date" value={actionForm.outside_factory_date || ''} onChange={(e) => setActionForm({ outside_factory_date: e.target.value })} /></div>}
          {target === 'inside_factory' && <div className="grid gap-1.5"><Label>Inside factory date</Label><Input type="date" value={actionForm.inside_factory_date || ''} onChange={(e) => setActionForm({ inside_factory_date: e.target.value })} /></div>}
          {target === 'empty' && actionRow && shortage && <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Empty date</Label><Input type="date" value={actionForm.empty_date || ''} onChange={(e) => setActionForm((p) => ({ ...p, empty_date: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Received quantity</Label><Input type="number" value={actionForm.received_qty || ''} onChange={(e) => setActionForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Transporter</Label><Select value={String(actionForm.transporter_id || '')} onValueChange={(v) => {
                const tr = transporters.find((x) => String(x.id) === v)
                setActionForm((p) => ({ ...p, transporter_id: v, transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || '' }))
              }}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1.5"><Label>Transport rate / {actionRow.uom}</Label><Input type="number" value={actionForm.transport_rate_per_ton || ''} onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} /></div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3"><MoneyRow label="Loaded" value={`${formatNum(actionRow.loaded_qty)} ${actionRow.uom}`} /><MoneyRow label="Shortage" value={`${formatNum(shortage.actualShortage)} ${actionRow.uom}`} /><MoneyRow label="Freight" value={formatINR(shortage.transportAmount)} /></div>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setActionRow(null)}>Cancel</Button><Button onClick={advanceTanker}>Confirm</Button></DialogFooter>
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
          </div>}
        </DialogContent>
      </Dialog>
    </>
  )
}
