import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { computeMoney, computeShortage, EN_ROUTE, nextStage, STATUS_LABEL } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant =
    status === 'received'
      ? 'success'
      : status === 'payment_cleared'
        ? 'warning'
        : status === 'ordered'
          ? 'muted'
          : 'secondary'
  return <Badge variant={variant}>{STATUS_LABEL[status] ?? status}</Badge>
}

function lateDays(row: Row): number | null {
  const exp = row.expected_delivery_date
  if (!exp) return null
  const ref = EN_ROUTE.includes(row.status)
    ? todayISO()
    : row.status === 'received'
      ? (row.received_date as string)
      : null
  if (!ref) return null
  const d = Math.round((new Date(ref).getTime() - new Date(exp).getTime()) / 86400000)
  return d > 0 ? d : null
}

function Row2({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

export function Orders(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [bargains, setBargains] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [sources, setSources] = useState<Row[]>([])
  const [allowedPct, setAllowedPct] = useState(0)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [actionRow, setActionRow] = useState<Row | null>(null)
  const [actionForm, setActionForm] = useState<Row>({})
  const [detailRow, setDetailRow] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, b, s, t, src, settings] = await Promise.all([
      window.api.orders.list(),
      window.api.bargains.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('transporters'),
      window.api.data.list('sources'),
      window.api.settings.all()
    ])
    setRows(o)
    setBargains(b)
    setSuppliers(s)
    setTransporters(t.filter((x) => x.active))
    setSources(src.filter((x) => x.active))
    setAllowedPct(Number(settings.allowed_shortage_pct ?? '0') || 0)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function setField(key: string, value: unknown): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function selectBargain(id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    const sup = suppliers.find((s) => s.id === b.supplier_id)
    setForm((prev) => ({
      ...prev,
      bargain_id: b.id,
      bargain_balance: b.balance_qty,
      supplier_id: b.supplier_id,
      supplier_name: b.supplier_name,
      oil_type_id: b.oil_type_id,
      oil_label: `${b.oil_code} · ${b.oil_name}`,
      bargain_type: b.bargain_type,
      bargain_rate: b.rate_per_uom,
      uom: b.uom,
      invoice_rate: prev.invoice_rate || b.rate_per_uom,
      gst_pct: sup?.gst_pct ?? 0,
      tds_pct: sup?.tds_pct ?? 0,
      adds_interest: !!sup?.adds_interest,
      interest_pct: sup?.interest_pct ?? 0,
      interest_days: sup?.interest_days ?? 0
    }))
  }

  function openAdd(): void {
    setEditing(null)
    setForm({ invoice_no: '', order_date: todayISO(), is_registered_transporter: true, posting: false })
    setError(null)
    setOpen(true)
  }

  function openEdit(row: Row): void {
    const sup = suppliers.find((s) => s.id === row.supplier_id)
    setEditing(row)
    setForm({
      bargain_id: row.bargain_id ?? '',
      invoice_no: row.invoice_no ?? '',
      order_date: row.order_date ?? todayISO(),
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      oil_type_id: row.oil_type_id,
      oil_label: `${row.oil_code} · ${row.oil_name}`,
      bargain_type: row.bargain_type,
      bargain_rate: row.bargain_rate,
      uom: row.uom,
      ordered_qty: row.ordered_qty,
      invoice_rate: row.invoice_rate,
      gst_pct: row.gst_pct,
      tds_pct: row.tds_pct,
      tanker_no: row.tanker_no ?? '',
      is_registered_transporter: row.is_registered_transporter == null ? true : !!row.is_registered_transporter,
      posting: !!row.posting,
      adds_interest: !!sup?.adds_interest,
      interest_pct: sup?.interest_pct ?? row.interest_pct ?? 0,
      interest_days: sup?.interest_days ?? row.interest_days ?? 0
    })
    setError(null)
    setOpen(true)
  }

  const calc = useMemo(
    () =>
      computeMoney({
        orderedQty: Number(form.ordered_qty) || 0,
        invoiceRate: Number(form.invoice_rate) || 0,
        bargainRate: Number(form.bargain_rate) || 0,
        gstPct: Number(form.gst_pct) || 0,
        tdsPct: Number(form.tds_pct) || 0,
        addsInterest: !!form.adds_interest,
        interestPct: Number(form.interest_pct) || 0,
        interestDays: Number(form.interest_days) || 0
      }),
    [form]
  )

  async function save(): Promise<void> {
    if (!form.bargain_id) return setError('Select a bargain')
    if (!form.invoice_no) return setError('Invoice no is required')
    if (!form.ordered_qty || Number(form.ordered_qty) <= 0) return setError('Ordered qty must be > 0')
    if (!form.invoice_rate || Number(form.invoice_rate) <= 0) return setError('Invoice rate must be > 0')
    if (!editing && form.bargain_balance != null && Number(form.ordered_qty) > Number(form.bargain_balance) + 1e-6) {
      return setError(`Qty exceeds the bargain balance (${formatNum(form.bargain_balance)} ${form.uom})`)
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Row = {
        invoice_no: form.invoice_no,
        order_date: form.order_date,
        bargain_id: form.bargain_id,
        supplier_id: form.supplier_id,
        oil_type_id: form.oil_type_id,
        bargain_type: form.bargain_type,
        bargain_rate: Number(form.bargain_rate) || 0,
        uom: form.uom || 'ton',
        ordered_qty: Number(form.ordered_qty),
        invoice_rate: Number(form.invoice_rate),
        gst_pct: Number(form.gst_pct) || 0,
        tds_pct: Number(form.tds_pct) || 0,
        tanker_no: form.tanker_no || null,
        is_registered_transporter: !!form.is_registered_transporter,
        posting: !!form.posting
      }
      if (editing) {
        await window.api.orders.update(editing.id as number, payload)
        toast.success('Order updated')
      } else {
        await window.api.orders.create(payload)
        toast.success('Order created')
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
    if (!window.confirm(`Delete order ${row.invoice_no}? This removes its ledger entries too.`)) return
    try {
      await window.api.orders.remove(row.id as number)
      toast.success('Order deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openAction(row: Row): void {
    const target = nextStage(row.status)
    if (!target) return
    setActionRow(row)
    const base: Row = {}
    if (target === 'at_port') Object.assign(base, { port_entry_date: todayISO(), tanker_no: row.tanker_no ?? '' })
    else if (target === 'payment_cleared')
      Object.assign(base, { payment_cleared_date: todayISO(), financed_by_party: false })
    else if (target === 'in_transit') Object.assign(base, { dispatch_date: todayISO(), source_id: '' })
    else if (target === 'outside_factory') Object.assign(base, { outside_factory_date: todayISO() })
    else if (target === 'inside_factory') Object.assign(base, { inside_factory_date: todayISO() })
    else if (target === 'received')
      Object.assign(base, {
        received_date: todayISO(),
        received_qty: row.ordered_qty,
        transporter_id: '',
        transport_rate_per_ton: ''
      })
    setActionForm(base)
  }

  function setActionField(key: string, value: unknown): void {
    setActionForm((prev) => ({ ...prev, [key]: value }))
  }

  function selectTransporter(id: string): void {
    const t = transporters.find((x) => String(x.id) === id)
    setActionForm((prev) => ({
      ...prev,
      transporter_id: id,
      transport_rate_per_ton: prev.transport_rate_per_ton || t?.default_rate_per_ton || ''
    }))
  }

  const target = actionRow ? nextStage(actionRow.status) : null
  const isEx = actionRow ? (actionRow.bargain_type || 'Ex') !== 'Delivered' : true

  const shortage = useMemo(() => {
    if (!actionRow) return null
    return computeShortage({
      orderedQty: Number(actionRow.ordered_qty) || 0,
      receivedQty: Number(actionForm.received_qty) || 0,
      allowedPct,
      bargainRate: Number(actionRow.bargain_rate) || 0,
      transportRatePerTon: Number(actionForm.transport_rate_per_ton) || 0
    })
  }, [actionRow, actionForm, allowedPct])

  async function confirmAction(): Promise<void> {
    if (!actionRow || !target) return
    // validations per stage
    if (target === 'in_transit' && !actionForm.source_id) {
      toast.error('Select a source')
      return
    }
    if (target === 'received') {
      if (!actionForm.received_qty || Number(actionForm.received_qty) <= 0) {
        toast.error('Enter received qty')
        return
      }
      if (Number(actionForm.received_qty) > Number(actionRow.ordered_qty) + 1e-6) {
        toast.error('Received qty cannot exceed ordered qty')
        return
      }
      if (isEx && !actionForm.transporter_id) {
        toast.error('Select a transporter')
        return
      }
    }
    try {
      await window.api.orders.advance(actionRow.id as number, target, {
        ...actionForm,
        source_id: actionForm.source_id ? Number(actionForm.source_id) : null,
        transporter_id: actionForm.transporter_id ? Number(actionForm.transporter_id) : 0,
        transport_rate_per_ton: Number(actionForm.transport_rate_per_ton) || 0,
        received_qty: Number(actionForm.received_qty) || 0
      })
      toast.success(`Moved to ${STATUS_LABEL[target]}`)
      setActionRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const noBargains = bargains.length === 0

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Purchase orders through the tanker lifecycle"
        actions={
          <Button size="sm" onClick={openAdd} disabled={noBargains}>
            <Plus className="h-4 w-4" />
            New order
          </Button>
        }
      />

      <div className="p-8">
        {noBargains && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Create a bargain first — orders are placed against a bargain.
          </div>
        )}

        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice no</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Oil</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Net amount</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="w-[230px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No orders yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const late = lateDays(row)
                  const tgt = nextStage(row.status)
                  return (
                    <TableRow
                      key={row.id as number}
                      className={late && EN_ROUTE.includes(row.status) ? 'bg-red-50' : ''}
                    >
                      <TableCell className="font-medium">{row.invoice_no}</TableCell>
                      <TableCell>{row.supplier_name ?? '—'}</TableCell>
                      <TableCell>{row.oil_code}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNum(row.ordered_qty)} {row.uom}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatINR(row.net_amount)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={row.status} />
                          {late && <Badge variant="destructive">{late}d late</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {tgt && (
                            <Button size="sm" variant="outline" onClick={() => openAction(row)}>
                              {STATUS_LABEL[tgt]}
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDetailRow(row)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            onClick={() => del(row)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create / edit order */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit order ${editing.invoice_no}` : 'New order'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Bargain *</Label>
                <Select value={String(form.bargain_id ?? '')} onValueChange={selectBargain}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select bargain" />
                  </SelectTrigger>
                  <SelectContent>
                    {bargains.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.bargain_no} · {b.supplier_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.supplier_name && (
                <p className="-mt-1 text-xs text-muted-foreground">
                  {form.supplier_name} · {form.oil_label} · {form.bargain_type}
                  {form.bargain_balance != null && !editing && (
                    <> · balance {formatNum(form.bargain_balance)} {form.uom}</>
                  )}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Invoice no *</Label>
                  <Input value={form.invoice_no ?? ''} onChange={(e) => setField('invoice_no', e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Order date *</Label>
                  <Input
                    type="date"
                    value={form.order_date ?? ''}
                    onChange={(e) => setField('order_date', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Dispatched qty (D.qty) *</Label>
                  <Input
                    type="number"
                    value={form.ordered_qty ?? ''}
                    onChange={(e) => setField('ordered_qty', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Invoice rate *</Label>
                  <Input
                    type="number"
                    value={form.invoice_rate ?? ''}
                    onChange={(e) => setField('invoice_rate', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>GST %</Label>
                  <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setField('gst_pct', e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>TDS %</Label>
                  <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setField('tds_pct', e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Tanker no</Label>
                  <Input value={form.tanker_no ?? ''} onChange={(e) => setField('tanker_no', e.target.value)} />
                </div>
                <div className="flex items-center justify-between self-end rounded-md border px-3 py-1.5">
                  <span className="text-sm">Registered tptr</span>
                  <Switch
                    checked={!!form.is_registered_transporter}
                    onCheckedChange={(v) => setField('is_registered_transporter', v)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-1.5">
                <span className="text-sm">Posted to accounts</span>
                <Switch checked={!!form.posting} onCheckedChange={(v) => setField('posting', v)} />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Calculation
              </div>
              <Row2 label="Bargain (booked) rate" value={formatINR(Number(form.bargain_rate) || 0)} />
              <Row2 label="Invoice rate" value={formatINR(Number(form.invoice_rate) || 0)} />
              <Row2
                label={`Interest / ${form.uom || 'ton'}${form.adds_interest ? ` (${form.interest_pct}% · ${form.interest_days}d)` : ''}`}
                value={formatINR(calc.interestPerUnit)}
              />
              <Row2 label="Adjusted rate" value={formatINR(calc.adjustedRate)} />
              <div className="my-2 border-t" />
              <Row2 label="Taxable value" value={formatINR(calc.taxableValue)} />
              <Row2 label={`GST (${Number(form.gst_pct) || 0}%)`} value={formatINR(calc.gstAmount)} />
              <Row2 label={`TDS (${Number(form.tds_pct) || 0}%)`} value={`− ${formatINR(calc.tdsAmount)}`} />
              <div className="my-2 border-t" />
              <Row2 label="Net (invoice)" value={formatINR(calc.netAmount)} strong />
              <div className="mt-3 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                At bargain rate
              </div>
              <Row2 label="Taxable value" value={formatINR(calc.finalTaxableValue)} />
              <Row2 label="Net (bargain)" value={formatINR(calc.finalNetAmount)} strong />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stage action */}
      <Dialog open={!!actionRow} onOpenChange={(o) => !o && setActionRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target ? `Move to ${STATUS_LABEL[target]}` : 'Advance'} — {actionRow?.invoice_no}
            </DialogTitle>
          </DialogHeader>

          {target === 'at_port' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Port entry date</Label>
                <Input
                  type="date"
                  value={actionForm.port_entry_date ?? ''}
                  onChange={(e) => setActionField('port_entry_date', e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Tanker no</Label>
                <Input
                  value={actionForm.tanker_no ?? ''}
                  onChange={(e) => setActionField('tanker_no', e.target.value)}
                />
              </div>
            </div>
          )}

          {target === 'payment_cleared' && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Payment cleared date</Label>
                <Input
                  type="date"
                  value={actionForm.payment_cleared_date ?? ''}
                  onChange={(e) => setActionField('payment_cleared_date', e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-1.5">
                <span className="text-sm">Financed by party (no interest)</span>
                <Switch
                  checked={!!actionForm.financed_by_party}
                  onCheckedChange={(v) => setActionField('financed_by_party', v)}
                />
              </div>
            </div>
          )}

          {target === 'in_transit' && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Dispatch date</Label>
                  <Input
                    type="date"
                    value={actionForm.dispatch_date ?? ''}
                    onChange={(e) => setActionField('dispatch_date', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Source</Label>
                  <Select
                    value={String(actionForm.source_id ?? '')}
                    onValueChange={(v) => setActionField('source_id', v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name} · {s.transit_days}d
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Expected delivery is the dispatch date plus the source&apos;s transit days.
              </p>
            </div>
          )}

          {target === 'outside_factory' && (
            <div className="grid gap-1.5">
              <Label>Outside factory date</Label>
              <Input
                type="date"
                value={actionForm.outside_factory_date ?? ''}
                onChange={(e) => setActionField('outside_factory_date', e.target.value)}
              />
            </div>
          )}

          {target === 'inside_factory' && (
            <div className="grid gap-1.5">
              <Label>Inside factory date</Label>
              <Input
                type="date"
                value={actionForm.inside_factory_date ?? ''}
                onChange={(e) => setActionField('inside_factory_date', e.target.value)}
              />
            </div>
          )}

          {target === 'received' && actionRow && shortage && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Received date</Label>
                  <Input
                    type="date"
                    value={actionForm.received_date ?? ''}
                    onChange={(e) => setActionField('received_date', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Received qty</Label>
                  <Input
                    type="number"
                    value={actionForm.received_qty ?? ''}
                    onChange={(e) => setActionField('received_qty', e.target.value)}
                  />
                </div>
              </div>
              {isEx ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label>Transporter</Label>
                      <Select value={String(actionForm.transporter_id ?? '')} onValueChange={selectTransporter}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          {transporters.map((t) => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Transport rate / {actionRow.uom}</Label>
                      <Input
                        type="number"
                        value={actionForm.transport_rate_per_ton ?? ''}
                        onChange={(e) => setActionField('transport_rate_per_ton', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <Row2 label="Ordered" value={`${formatNum(actionRow.ordered_qty)} ${actionRow.uom}`} />
                    <Row2
                      label={`Allowed shortage (${allowedPct}%)`}
                      value={`${formatNum(shortage.allowedQty)} ${actionRow.uom}`}
                    />
                    <Row2 label="Actual shortage" value={`${formatNum(shortage.actualShortage)} ${actionRow.uom}`} />
                    <Row2 label="Excess (to transporter)" value={`${formatNum(shortage.excessShortage)} ${actionRow.uom}`} />
                    <div className="my-2 border-t" />
                    <Row2 label="Freight" value={formatINR(shortage.transportAmount)} />
                    <Row2 label="Shortage penalty" value={`− ${formatINR(shortage.shortageCharge)}`} />
                    <Row2
                      label="Net to transporter"
                      value={formatINR(shortage.transportAmount - shortage.shortageCharge)}
                      strong
                    />
                  </div>
                </>
              ) : (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  Delivered (DLD) — transport borne by supplier, no transporter ledger entry.
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setActionRow(null)}>
              Cancel
            </Button>
            <Button onClick={confirmAction}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail */}
      <Dialog open={!!detailRow} onOpenChange={(o) => !o && setDetailRow(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Order {detailRow?.invoice_no}
              {detailRow && <StatusBadge status={detailRow.status} />}
            </DialogTitle>
          </DialogHeader>
          {detailRow && (
            <div className="max-h-[65vh] overflow-y-auto pr-1">
              <Row2 label="Supplier" value={detailRow.supplier_name ?? '—'} />
              <Row2 label="Oil" value={`${detailRow.oil_code} · ${detailRow.oil_name}`} />
              <Row2 label="Bargain type" value={detailRow.bargain_type} />
              {detailRow.tanker_no && <Row2 label="Tanker no" value={detailRow.tanker_no} />}
              <Row2 label="Ordered qty" value={`${formatNum(detailRow.ordered_qty)} ${detailRow.uom}`} />
              <Row2 label="Net amount" value={formatINR(detailRow.net_amount)} strong />

              <div className="mt-3 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tanker timeline
              </div>
              <Row2 label="Ordered" value={formatDate(detailRow.order_date)} />
              {detailRow.port_entry_date && <Row2 label="At port" value={formatDate(detailRow.port_entry_date)} />}
              {detailRow.payment_cleared_date && (
                <Row2
                  label={`Payment cleared${detailRow.financed_by_party ? ' (financed)' : ''}`}
                  value={formatDate(detailRow.payment_cleared_date)}
                />
              )}
              {detailRow.dispatch_date && <Row2 label="In transit" value={formatDate(detailRow.dispatch_date)} />}
              {detailRow.source_name && <Row2 label="Source" value={detailRow.source_name} />}
              {detailRow.expected_delivery_date && (
                <Row2 label="Expected delivery" value={formatDate(detailRow.expected_delivery_date)} />
              )}
              {detailRow.outside_factory_date && (
                <Row2 label="Outside factory" value={formatDate(detailRow.outside_factory_date)} />
              )}
              {detailRow.inside_factory_date && (
                <Row2 label="Inside factory" value={formatDate(detailRow.inside_factory_date)} />
              )}
              {detailRow.status === 'received' && (
                <>
                  <Row2 label="Received" value={formatDate(detailRow.received_date)} />
                  <Row2 label="Received qty" value={`${formatNum(detailRow.received_qty)} ${detailRow.uom}`} />
                  <Row2
                    label="Excess shortage"
                    value={`${formatNum(detailRow.excess_shortage_qty)} ${detailRow.uom}`}
                  />
                  <Row2 label="Transporter" value={detailRow.transporter_name ?? '—'} />
                  <Row2 label="Freight" value={formatINR(detailRow.transport_amount)} />
                  <Row2 label="Shortage charged" value={formatINR(detailRow.shortage_charge_amount)} />
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
