import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { convertQty, errText, formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

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

// ---------------- Sales tab ----------------

function SalesTab({
  focusId,
  onFocusHandled,
  onRegister,
  onBack
}: {
  focusId?: number | null
  onFocusHandled?: () => void
  onRegister?: (a: { open: () => void; canAdd: boolean; formOpen: boolean }) => void
  onBack?: () => void
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

  const load = useCallback(async () => {
    setLoading(true)
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

  // Sales grouped into invoices (line items sharing an invoice_group).
  const invoices = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const g = String(r.invoice_group || `LEGACY-${r.id}`)
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(r)
    }
    return Array.from(m.entries())
      .map(([group, lines]) => {
        const first = lines[0]
        const amount = lines.reduce((s, r) => s + (Number(r.amount) || 0), 0)
        const net = lines.reduce((s, r) => s + (Number(r.amount) || 0) + (Number(r.gst_amount) || 0), 0)
        const qty = lines.reduce((s, r) => s + (Number(r.qty) || 0), 0)
        return { group, lines, first, amount, net, qty }
      })
      .sort((a, b) => Number(b.first.id) - Number(a.first.id))
  }, [rows])

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
      unloaded_date: ''
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
    onRegister?.({ open: openAdd, canAdd: products.length > 0, formOpen: formPage })
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
      dispatch_stage: f.dispatch_stage ?? (f.status === 'done' ? 'unloaded' : 'pending'),
      loaded_date: f.loaded_date ?? '',
      transit_date: f.transit_date ?? '',
      unloaded_date: f.unloaded_date ?? ''
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
  const notExpired = (b: Row): boolean => !b.rate_expiry_date || String(b.rate_expiry_date) >= todayISO()
  const bargainsFor = (item: Row): Row[] =>
    bargains.filter(
      (b) =>
        String(b.id) === String(item.sales_bargain_id) ||
        (String(b.product_id) === String(item.product_id) && matchesCustomer(b) && Number(b.balance_qty) > 0 && notExpired(b))
    )

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
    const amount = effQty * (Number(item.rate) || 0)
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

  function selectItemBargain(idx: number, v: string): void {
    if (v === 'none') { setItem(idx, { sales_bargain_id: '' }); return }
    const b = bargains.find((x) => String(x.id) === v)
    const it = items[idx]
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
    setHeader((p) => ({ ...p, customer_id: v, customer: cust?.name ?? p.customer }))
    // Drop item bargains that belong to another customer.
    setItems((prev) => prev.map((it) => {
      const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
      const keep = b && (b.customer_id != null && String(b.customer_id) !== '' ? String(b.customer_id) === v : true)
      return keep ? it : { ...it, sales_bargain_id: '' }
    }))
  }

  async function save(): Promise<void> {
    if (!items.length) return void toast.error('Add at least one item')
    for (const [i, it] of items.entries()) {
      if (!it.product_id) return void toast.error(`Item ${i + 1}: select a product`)
      const c = calc(it)
      if (c.isPacked && !it.packaging_id) return void toast.error(`Item ${i + 1}: select a packaging`)
      if (c.effQty <= 0) return void toast.error(`Item ${i + 1}: enter quantity`)
      if ((Number(it.rate) || 0) < 0) return void toast.error(`Item ${i + 1}: rate cannot be negative`)
    }
    if (isDld && !header.transporter_id) return void toast.error('Select a transporter for the FOR delivery')

    const payload: Row = {
      ...header,
      customer_id: header.customer_id ? Number(header.customer_id) : null,
      transporter_id: header.transporter_id ? Number(header.transporter_id) : null,
      items: items.map((it) => ({
        product_id: Number(it.product_id),
        sales_bargain_id: it.sales_bargain_id ? Number(it.sales_bargain_id) : null,
        sale_type: it.sale_type,
        packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
        boxes: it.boxes,
        pouches: it.pouches,
        qty: it.qty,
        rate: it.rate,
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
          const go = window.confirm(`${msg}\n\nDispatch anyway WITHOUT booking stock? These items won't draw from or affect finished-goods stock (untracked).`)
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

  async function changeInvoiceStage(group: string, stage: string): Promise<void> {
    const label = DISPATCH_STAGES.find((x) => x.value === stage)?.label || stage
    const today = todayISO()
    try {
      await window.api.sales.setInvoiceStage(group, stage, false, today)
      toast.success(`Invoice marked ${label}`)
      await load()
    } catch (e) {
      const msg = errText(e)
      if (/stock/i.test(msg)) {
        const go = window.confirm(`${msg}\n\nDispatch anyway WITHOUT booking stock? This invoice won't draw from or affect finished-goods stock (untracked).`)
        if (!go) return
        try {
          await window.api.sales.setInvoiceStage(group, stage, true, today)
          toast.success(`Invoice marked ${label} — off-stock (untracked)`)
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

  return (
    <div>
      {!formPage && (
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">Date / Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead className="w-[110px] text-right">Qty</TableHead>
              <TableHead className="w-[140px] text-right">Invoice total</TableHead>
              <TableHead className="w-[220px]">Dispatch</TableHead>
              <TableHead className="w-[84px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : invoices.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No sales yet.</TableCell></TableRow>
            ) : (
              invoices.map((inv) => {
                const stg = stageInfo(inv.first)
                const idx = DISPATCH_STAGES.findIndex((x) => x.value === stg.value)
                const prevStage = idx > 0 ? DISPATCH_STAGES[idx - 1] : null
                const nextStage = idx < DISPATCH_STAGES.length - 1 ? DISPATCH_STAGES[idx + 1] : null
                const untracked = Number(inv.first.track_stock) === 0
                const isOpen = !!expanded[inv.group]
                return (
                  <Fragment key={inv.group}>
                    <TableRow className="cursor-pointer" onClick={() => setExpanded((p) => ({ ...p, [inv.group]: !p[inv.group] }))}>
                      <TableCell className="align-top">
                        <div className="flex items-center gap-1.5">
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          <div>
                            <div className="whitespace-nowrap">{formatDate(inv.first.sale_date)}</div>
                            <div className="truncate text-xs text-muted-foreground">{inv.first.invoice_no || '—'}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="truncate font-medium" title={inv.first.customer || ''}>{inv.first.customer || '—'}</div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-sm">{inv.lines.length} item{inv.lines.length > 1 ? 's' : ''}</div>
                        <div className="truncate text-xs text-muted-foreground" title={inv.lines.map((r) => r.product_name).join(', ')}>
                          {inv.lines.map((r) => r.product_name).join(', ')}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">{formatNum(inv.qty)}</TableCell>
                      <TableCell className="align-top text-right tabular-nums">{formatINR(inv.net)}</TableCell>
                      <TableCell className="align-top" onClick={(e) => e.stopPropagation()}>
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
                            <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" title={`Mark ${nextStage.label}`} onClick={() => changeInvoiceStage(inv.group, nextStage.value)}>
                              {nextStage.label}<ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="flex items-center gap-0.5 pl-1 text-xs font-medium text-emerald-600" title="Delivered"><Check className="h-3.5 w-3.5" /> Done</span>
                          )}
                        </div>
                        {untracked && <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-orange-600">Off-stock</div>}
                      </TableCell>
                      <TableCell className="align-top text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-0.5">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditInvoice(inv)}><Pencil className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => delInvoice(inv)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {isOpen && inv.lines.map((r) => {
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
      )}

      {formPage && (
      <div className="w-full">
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
          <button className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}>
            <ArrowLeft className="h-4 w-4" /> {onBack ? 'Back to ledger' : 'Back'}
          </button>
          <div className="h-4 border-l" />
          <h2 className="text-base font-semibold">{editingGroup ? 'Edit invoice' : 'New sale invoice'}</h2>
        </div>

        {/* Invoice header */}
        <div className="rounded-xl border bg-card p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Date</Label>
              <DatePicker value={header.sale_date} onChange={(v) => setHeaderField('sale_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Invoice no</Label>
              <Input value={header.invoice_no ?? ''} onChange={(e) => setHeaderField('invoice_no', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Customer</Label>
              <Select value={header.customer_id ? String(header.customer_id) : ''} onValueChange={chooseCustomer}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {customers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Freight term</Label>
              <Select value={header.freight_term || 'FREIGHT_ON_GOODS'} onValueChange={(v) => setHeaderField('freight_term', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT_ON_GOODS">Ex (customer lifts — no transporter)</SelectItem>
                  <SelectItem value="DLD">FOR (we deliver — transporter)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Dispatch stage</Label>
              <Select value={header.dispatch_stage || 'pending'} onValueChange={(v) => setHeaderField('dispatch_stage', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DISPATCH_STAGES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isDld && (
            <div className="mt-4 grid grid-cols-2 gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label>Transporter *</Label>
                <Select value={header.transporter_id ? String(header.transporter_id) : ''} onValueChange={(v) => setHeaderField('transporter_id', v)}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{transporters.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Freight rate / unit</Label>
                <Input type="number" className="bg-white" value={header.transport_rate ?? ''} onChange={(e) => setHeaderField('transport_rate', e.target.value)} />
              </div>
              <p className="col-span-full text-[11px] text-sky-800">Freight is posted to the transporter ledger per item (rate × qty) and recovered from the customer.</p>
            </div>
          )}

          {header.dispatch_stage && header.dispatch_stage !== 'pending' && (
            <div className="mt-4 grid grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label>Loaded date</Label>
                <DatePicker value={header.loaded_date ?? ''} onChange={(v) => setHeaderField('loaded_date', v)} />
              </div>
              {(header.dispatch_stage === 'transit' || header.dispatch_stage === 'unloaded') && (
                <div className="grid gap-1.5"><Label>In-transit date</Label><DatePicker value={header.transit_date ?? ''} onChange={(v) => setHeaderField('transit_date', v)} /></div>
              )}
              {header.dispatch_stage === 'unloaded' && (
                <div className="grid gap-1.5"><Label>Unloaded date</Label><DatePicker value={header.unloaded_date ?? ''} onChange={(v) => setHeaderField('unloaded_date', v)} /></div>
              )}
              <p className="text-[11px] text-muted-foreground sm:col-span-3">Blank stages are stamped with today&apos;s date. Dispatching draws finished stock (checked against availability).</p>
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="mt-4 space-y-3">
          {items.map((item, i) => {
            const c = calc(item)
            const prodBargains = bargainsFor(item)
            return (
              <div key={i} className="rounded-xl border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold">Item {i + 1}</span>
                  {items.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={() => removeItem(i)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-1.5">
                    <Label>Product *</Label>
                    <Select value={String(item.product_id)} onValueChange={(v) => setItem(i, { product_id: v, sales_bargain_id: '' })}>
                      <SelectTrigger><SelectValue placeholder="Finished product" /></SelectTrigger>
                      <SelectContent>{products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Sales bargain (optional)</Label>
                    <Select value={item.sales_bargain_id ? String(item.sales_bargain_id) : 'none'} onValueChange={(v) => selectItemBargain(i, v)} disabled={!item.product_id}>
                      <SelectTrigger><SelectValue placeholder="No bargain" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No bargain</SelectItem>
                        {prodBargains.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · bal {formatNum(b.balance_qty)} @ {formatINR(b.rate)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Sale type</Label>
                    <Select value={item.sale_type || 'LOOSE'} onValueChange={(v) => setItem(i, { sale_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                        <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {c.isPacked && (
                  <div className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-violet-200 bg-violet-50/60 p-3 sm:grid-cols-3">
                    <div className="grid gap-1.5 sm:col-span-3">
                      <Label>Packaging *</Label>
                      <Select value={item.packaging_id ? String(item.packaging_id) : ''} onValueChange={(v) => setItem(i, { packaging_id: v })}>
                        <SelectTrigger className="bg-white"><SelectValue placeholder="Select packaging" /></SelectTrigger>
                        <SelectContent>{packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                      </Select>
                      {c.selPack && (
                        <span className="text-[11px] text-muted-foreground">
                          1 {c.selPack.box_label} = {formatNum(c.selPack.pouches_per_box)} {c.selPack.pouch_label} = {formatNum(Number(c.selPack.pouches_per_box) * Number(c.selPack.base_per_pouch))} {c.selPack.base_uom}
                        </span>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label>{c.selPack?.box_label || 'Cases'}</Label>
                      <Input type="number" className="bg-white" value={item.boxes ?? ''} onChange={(e) => setItem(i, { boxes: e.target.value })} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Loose {c.selPack?.pouch_label || 'units'}</Label>
                      <Input type="number" className="bg-white" value={item.pouches ?? ''} onChange={(e) => setItem(i, { pouches: e.target.value })} />
                    </div>
                  </div>
                )}

                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="grid gap-1.5">
                    <Label>Qty ({c.saleUom})</Label>
                    {c.isPacked ? (
                      <>
                        <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">{formatNum(c.effQty)}</div>
                        {c.selPack && c.packBaseUom !== c.saleUom && <span className="text-[11px] text-muted-foreground">= {formatNum(c.packBaseQty)} {c.packBaseUom}</span>}
                      </>
                    ) : (
                      <Input type="number" value={item.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value })} />
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Rate /{c.saleUom}</Label>
                    <Input type="number" value={item.rate ?? ''} onChange={(e) => setItem(i, { rate: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={item.gst_pct ?? ''} onChange={(e) => setItem(i, { gst_pct: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST type</Label>
                    <Select value={item.gst_type || 'CGST_SGST'} onValueChange={(v) => setItem(i, { gst_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="mt-2 text-right text-xs text-muted-foreground">
                  Line: taxable {formatINR(c.amount)} · GST {formatINR(c.gstAmt)} · <span className="font-semibold text-foreground">{formatINR(c.net)}</span>
                </div>
              </div>
            )
          })}
          <Button variant="outline" size="sm" onClick={addItem}><Plus className="h-4 w-4" /> Add item</Button>
        </div>

        {/* Invoice summary */}
        <div className="mt-4 rounded-xl border bg-muted/30 p-4 text-sm">
          <div className="flex items-center justify-between py-0.5"><span className="text-muted-foreground">Taxable value</span><span className="tabular-nums">{formatINR(totals.amount)}</span></div>
          <div className="flex items-center justify-between py-0.5"><span className="text-muted-foreground">Total GST</span><span className="tabular-nums">{formatINR(totals.gst)}</span></div>
          <div className="mt-1 flex items-center justify-between border-t pt-1 text-base font-semibold"><span>Invoice total</span><span className="tabular-nums">{formatINR(totals.amount + totals.gst)}</span></div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => (onBack ? onBack() : setFormPage(false))} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save invoice'}</Button>
        </div>
      </div>
      )}
    </div>
  )
}

// ---------------- Sales bargains tab ----------------

function SalesBargainsTab(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [packagings, setPackagings] = useState<Row[]>([])
  const [search, setSearch] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // add/remove balance qty
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{ mode: 'add' | 'remove'; amount: string; note: string }>({
    mode: 'add',
    amount: '',
    note: ''
  })
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [b, pr, cu, pk] = await Promise.all([
      window.api.salesBargains.list(),
      window.api.data.list('products'),
      window.api.data.list('customers'),
      window.api.data.list('packagings')
    ])
    setRows(b)
    setProducts(pr.filter((x) => x.active && x.category === 'finished'))
    setCustomers(cu.filter((x) => x.active))
    setPackagings(pk.filter((x) => x.active))
  }, [])

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

  const q = search.trim().toLowerCase()
  const visibleRows = rows.filter(
    (r) =>
      !q ||
      [r.bargain_no, r.customer, r.product_name, r.note].some((f) =>
        String(f || '').toLowerCase().includes(q)
      )
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
    const m = new Map<string, { count: number; qty: number; sold: number; bal: number; uom: string }>()
    for (const r of visibleRows) {
      const k = String(r.customer || '—')
      if (!m.has(k)) m.set(k, { count: 0, qty: 0, sold: 0, bal: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      g.count += 1
      g.qty += Number(r.qty) || 0
      g.sold += Number(r.sold_qty) || 0
      g.bal += Number(r.balance_qty) || 0
    }
    return m
  }, [visibleRows])

  const grand = useMemo(() => {
    let count = 0
    let qty = 0
    let sold = 0
    let bal = 0
    for (const g of groupStats.values()) {
      count += g.count
      qty += g.qty
      sold += g.sold
      bal += g.bal
    }
    return { count, qty, sold, bal }
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
      packaging_id: '',
      freight_term: 'FREIGHT_ON_GOODS'
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
      packaging_id: row.packaging_id ? String(row.packaging_id) : '',
      freight_term: row.freight_term ?? 'FREIGHT_ON_GOODS'
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

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    setAdjustForm({ mode: 'add', amount: '', note: '' })
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
      await window.api.salesBargains.adjust(Number(adjustRow.id), delta, adjustForm.note || undefined)
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-9 pl-8"
            placeholder="Search bargain no, customer, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={openAdd} disabled={products.length === 0}>
          <Plus className="h-4 w-4" /> New sales bargain
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table className="min-w-[760px] text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead>Bargain no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Op Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Bal Qty</TableHead>
              <TableHead className="w-[110px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {rows.length === 0 ? 'No sales bargains yet.' : 'No sales bargains match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                <TableRow className="border-y-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell colSpan={3} className="py-2 text-xs font-bold uppercase tracking-wide text-amber-900">
                    Grand total
                    <span className="ml-1 font-medium normal-case tracking-normal text-amber-700">
                      · {grand.count} bargain{grand.count === 1 ? '' : 's'}
                    </span>
                  </TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.qty)} MT</TableCell>
                  <TableCell className="py-2" />
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.sold)} MT</TableCell>
                  <TableCell className="py-2 text-right text-xs font-bold tabular-nums text-amber-900">{formatNum(grand.bal)} MT</TableCell>
                  <TableCell className="py-2" />
                </TableRow>
                {sortedRows.map((row, i) => {
                  const grp = String(row.customer || '—')
                  const newGroup = i === 0 || grp !== String(sortedRows[i - 1].customer || '—')
                  const isCollapsed = !q && !openGroups.has(grp)
                  const g = groupStats.get(grp)
                  return (
                    <Fragment key={row.id as number}>
                      {newGroup && (
                        <TableRow
                          className="cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70"
                          onClick={() => toggleGroup(grp)}
                        >
                          <TableCell colSpan={3} className="py-1.5">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700">
                              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              {grp}
                              <span className="font-medium normal-case tracking-normal text-slate-500">
                                · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.qty ?? 0)} {g?.uom || 'MT'}</TableCell>
                          <TableCell className="py-1.5" />
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.sold ?? 0)}</TableCell>
                          <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">{formatNum(g?.bal ?? 0)}</TableCell>
                          <TableCell className="py-1.5" />
                        </TableRow>
                      )}
                      {!isCollapsed && (
                        <TableRow>
                          <TableCell className="font-medium">{row.bargain_no}</TableCell>
                          <TableCell>{formatDate(row.bargain_date)}</TableCell>
                          <TableCell>{row.product_name || '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(row.qty)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(row.rate)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(row.sold_qty)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            <span className={Number(row.balance_qty) < -1e-9 ? 'text-red-600' : ''}>{formatNum(row.balance_qty)}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8" title="Add / remove balance qty" onClick={() => openAdjust(row)}>
                                <SlidersHorizontal className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(row)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
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
            <div className="grid gap-1.5">
              <Label>Date</Label>
              <DatePicker value={form.bargain_date} onChange={(v) => setField('bargain_date', v)} />
            </div>
            <div className="grid gap-1.5">
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
                  {customers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Product *</Label>
              <Select value={String(form.product_id)} onValueChange={(v) => setField('product_id', v)} disabled={editLocked}>
                <SelectTrigger><SelectValue placeholder="Finished product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Qty *</Label>
              <Input type="number" min={editLocked ? editSold : 0} value={form.qty ?? ''} onChange={(e) => setField('qty', e.target.value)} />
              {editLocked && Number(form.qty) < editSold - 1e-4 && (
                <span className="text-[11px] text-red-600">Cannot be below {formatNum(editSold)} already sold.</span>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom || 'MT'} onChange={(v) => setField('uom', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Rate *</Label>
              <Input type="number" value={form.rate ?? ''} onChange={(e) => setField('rate', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>GST %</Label>
              <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setField('gst_pct', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>GST type</Label>
              <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setField('gst_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                  <SelectItem value="IGST">IGST</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Rate expiry</Label>
              <DatePicker value={form.rate_expiry_date ?? ''} onChange={(v) => setField('rate_expiry_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Sale type</Label>
              <Select value={form.sale_type || 'LOOSE'} onValueChange={(v) => setField('sale_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                  <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
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
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Default packaging</Label>
                <Select value={form.packaging_id ? String(form.packaging_id) : ''} onValueChange={(v) => setField('packaging_id', v)}>
                  <SelectTrigger><SelectValue placeholder="Select packaging" /></SelectTrigger>
                  <SelectContent>
                    {packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5 sm:col-span-2">
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
            const bal = Number(adjustRow.balance_qty) || 0
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
                <div className="grid gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})</Label>
                  <Input type="number" autoFocus value={adjustForm.amount} onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
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

export function Sales({ focusId, onFocusHandled, onBack }: { focusId?: number | null; onFocusHandled?: () => void; onBack?: () => void } = {}): React.JSX.Element {
  const [needs, setNeeds] = useState<Row[]>([])
  const [needsOpen, setNeedsOpen] = useState(false)
  const [salesAdd, setSalesAdd] = useState<{ open: () => void; canAdd: boolean; formOpen: boolean } | null>(null)
  const loadNeeds = useCallback(async () => {
    setNeeds(await window.api.stock.needs())
  }, [])
  useEffect(() => {
    loadNeeds()
  }, [loadNeeds])
  useLiveRefresh(loadNeeds)

  const rawShort = needs.filter((n) => n.raw_short).length
  const totalProduce = needs.reduce((s, n) => s + (Number(n.shortfall) || 0), 0)

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle="Finished-goods dispatches drawn against sales bargains"
        hint="Each dispatch draws down a sales bargain and reduces finished-goods stock. Short stock can be produced on the spot. Book the rate contracts under Sales Bargain."
        actions={
          salesAdd?.formOpen ? undefined : (
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
        <SalesTab focusId={focusId} onFocusHandled={onFocusHandled} onRegister={setSalesAdd} onBack={onBack} />
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

export function SalesBargains(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Sales Bargain" subtitle="Rate contracts with customers — drawn down as sales are dispatched" hint="Each sales bargain locks a rate and quantity with a customer; dispatches under Sales draw it down. The bargain number is FGCODE/DD-MM/CUSTOMER/SERIAL, resetting monthly." />
      <div className="px-4 py-4">
        <SalesBargainsTab />
      </div>
    </>
  )
}
