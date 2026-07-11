import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
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
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------- Sales tab ----------------

function SalesTab(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [stock, setStock] = useState<Record<number, Row>>({})
  const [loading, setLoading] = useState(true)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [s, pr, sb, st, cu] = await Promise.all([
      window.api.sales.list(),
      window.api.data.list('products'),
      window.api.salesBargains.list(),
      window.api.stock.list(),
      window.api.data.list('customers')
    ])
    setRows(s)
    setProducts(pr.filter((x) => x.active && x.category === 'finished'))
    setBargains(sb)
    setCustomers(cu.filter((x) => x.active))
    const sm: Record<number, Row> = {}
    for (const l of st) sm[l.id as number] = l
    setStock(sm)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function blank(): Row {
    return {
      sale_date: todayISO(),
      invoice_no: '',
      customer: '',
      customer_id: '',
      product_id: '',
      sales_bargain_id: '',
      qty: '',
      rate: '',
      status: 'pending'
    }
  }
  function openAdd(): void {
    setEditing(null)
    setForm(blank())
    setOpen(true)
  }
  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      sale_date: row.sale_date ?? todayISO(),
      invoice_no: row.invoice_no ?? '',
      customer: row.customer ?? '',
      customer_id: row.customer_id ? String(row.customer_id) : '',
      product_id: String(row.product_id ?? ''),
      sales_bargain_id: row.sales_bargain_id ? String(row.sales_bargain_id) : '',
      qty: row.qty ?? '',
      rate: row.rate ?? '',
      status: row.status ?? 'pending'
    })
    setOpen(true)
  }
  function setField(key: string, value: unknown): void {
    setForm((p) => {
      const next = { ...p, [key]: value }
      if (key === 'product_id') next.sales_bargain_id = '' // reset bargain when product changes
      return next
    })
  }
  function selectBargain(v: string): void {
    if (v === 'none') {
      setForm((p) => ({ ...p, sales_bargain_id: '' }))
      return
    }
    const b = bargains.find((x) => String(x.id) === v)
    setForm((p) => ({ ...p, sales_bargain_id: v, rate: p.rate || b?.rate || '' }))
  }

  const sel = form.product_id ? stock[Number(form.product_id)] : null
  const amount = (Number(form.qty) || 0) * (Number(form.rate) || 0)
  const productBargains = bargains.filter(
    (b) =>
      String(b.product_id) === String(form.product_id) &&
      (Number(b.balance_qty) > 0 || String(b.id) === String(form.sales_bargain_id))
  )
  const selBargain = form.sales_bargain_id
    ? bargains.find((b) => String(b.id) === String(form.sales_bargain_id))
    : null

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select a product')
      return
    }
    if (!form.qty || Number(form.qty) <= 0) {
      toast.error('Enter quantity')
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        product_id: Number(form.product_id),
        sales_bargain_id: form.sales_bargain_id ? Number(form.sales_bargain_id) : null
      }
      if (editing) await window.api.sales.update(editing.id as number, payload)
      else await window.api.sales.create(payload)
      toast.success('Sale saved')
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(row: Row): Promise<void> {
    const next = row.status === 'done' ? 'pending' : 'done'
    try {
      await window.api.sales.setStatus(row.id as number, next)
      toast.success(next === 'done' ? 'Marked fully done' : 'Marked pending')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete sale ${row.invoice_no || ''}?`)) return
    try {
      await window.api.sales.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={openAdd} disabled={products.length === 0}>
          <Plus className="h-4 w-4" />
          New sale
        </Button>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Bargain</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">In stock</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[130px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                  No sales yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const inStock = stock[row.product_id as number]?.stock ?? 0
                const short = row.status !== 'done' && Number(row.qty) > Number(inStock)
                return (
                  <TableRow key={row.id as number}>
                    <TableCell>{formatDate(row.sale_date)}</TableCell>
                    <TableCell>{row.invoice_no || '—'}</TableCell>
                    <TableCell>{row.customer || '—'}</TableCell>
                    <TableCell className="font-medium">{row.product_name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.sales_bargain_no || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNum(row.qty)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${short ? 'text-amber-700' : 'text-muted-foreground'}`}>
                      {formatNum(inStock)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(row.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'done' ? 'success' : 'warning'}>
                        {row.status === 'done' ? 'Fully done' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={row.status === 'done' ? 'Mark pending' : 'Mark fully done'}
                          onClick={() => toggleStatus(row)}
                        >
                          {row.status === 'done' ? (
                            <RotateCcw className="h-4 w-4" />
                          ) : (
                            <Check className="h-4 w-4 text-emerald-600" />
                          )}
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit sale' : 'New sale'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <DatePicker value={form.sale_date} onChange={(v) => setField('sale_date', v)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Invoice no</Label>
                <Input value={form.invoice_no ?? ''} onChange={(e) => setField('invoice_no', e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Customer</Label>
              <Select
                value={form.customer_id ? String(form.customer_id) : ''}
                onValueChange={(v) => {
                  const cust = customers.find((c) => String(c.id) === v)
                  setForm((p) => ({ ...p, customer_id: v, customer: cust?.name ?? p.customer }))
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Links the sale to the customer ledger so receipts can be tracked.</span>
            </div>
            <div className="grid gap-1.5">
              <Label>Product *</Label>
              <Select value={String(form.product_id)} onValueChange={(v) => setField('product_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Finished product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sel && (
                <p className="text-xs text-muted-foreground">
                  Produced {formatNum(sel.produced)} · In stock{' '}
                  <span className={Number(sel.stock) < (Number(form.qty) || 0) ? 'text-amber-700' : ''}>
                    {formatNum(sel.stock)}
                  </span>
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Sales bargain (optional)</Label>
              <Select
                value={form.sales_bargain_id ? String(form.sales_bargain_id) : 'none'}
                onValueChange={selectBargain}
                disabled={!form.product_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No bargain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No bargain</SelectItem>
                  {productBargains.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.bargain_no} · bal {formatNum(b.balance_qty)} @ {formatINR(b.rate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selBargain && (
                <p className="text-xs text-muted-foreground">
                  Bargain balance left: {formatNum(selBargain.balance_qty)} {selBargain.uom}
                </p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>Qty</Label>
                <Input type="number" value={form.qty ?? ''} onChange={(e) => setField('qty', e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Rate</Label>
                <Input type="number" value={form.rate ?? ''} onChange={(e) => setField('rate', e.target.value)} />
              </div>
              <div className="grid content-end gap-1.5">
                <Label>Amount</Label>
                <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">
                  {formatINR(amount)}
                </div>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="done">Fully done</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Marking &quot;Fully done&quot; deducts the quantity from finished-goods stock.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save sale'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Sales bargains tab ----------------

function SalesBargainsTab(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [b, pr] = await Promise.all([
      window.api.salesBargains.list(),
      window.api.data.list('products')
    ])
    setRows(b)
    setProducts(pr.filter((x) => x.active && x.category === 'finished'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function blank(): Row {
    return {
      bargain_date: todayISO(),
      customer: '',
      product_id: '',
      qty: '',
      uom: 'MT',
      rate: '',
      rate_expiry_date: '',
      note: ''
    }
  }
  function openAdd(): void {
    setEditing(null)
    setForm(blank())
    setOpen(true)
  }
  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      bargain_date: row.bargain_date ?? todayISO(),
      customer: row.customer ?? '',
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      uom: row.uom ?? 'MT',
      rate: row.rate ?? '',
      rate_expiry_date: row.rate_expiry_date ?? '',
      note: row.note ?? ''
    })
    setOpen(true)
  }
  function setField(key: string, value: unknown): void {
    setForm((p) => ({ ...p, [key]: value }))
  }

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select a product')
      return
    }
    if (!form.qty || Number(form.qty) <= 0) {
      toast.error('Enter quantity')
      return
    }
    setSaving(true)
    try {
      const payload = { ...form, product_id: Number(form.product_id) }
      if (editing) await window.api.salesBargains.update(editing.id as number, payload)
      else await window.api.salesBargains.create(payload)
      toast.success('Sales bargain saved')
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
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
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={openAdd} disabled={products.length === 0}>
          <Plus className="h-4 w-4" />
          New sales bargain
        </Button>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bargain no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Sold</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="w-[90px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  No sales bargains yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id as number}>
                  <TableCell className="font-medium">{row.bargain_no}</TableCell>
                  <TableCell>{formatDate(row.bargain_date)}</TableCell>
                  <TableCell>{row.customer || '—'}</TableCell>
                  <TableCell>{row.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(row.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(row.rate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(row.sold_qty)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    <span className={Number(row.balance_qty) < 0 ? 'text-red-600' : ''}>
                      {formatNum(row.balance_qty)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
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
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.bargain_no}` : 'New sales bargain'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Date</Label>
              <DatePicker value={form.bargain_date} onChange={(v) => setField('bargain_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Customer</Label>
              <Input value={form.customer ?? ''} onChange={(e) => setField('customer', e.target.value)} />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label>Product *</Label>
              <Select value={String(form.product_id)} onValueChange={(v) => setField('product_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Finished product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Qty *</Label>
              <Input type="number" value={form.qty ?? ''} onChange={(e) => setField('qty', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom || 'MT'} onChange={(v) => setField('uom', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Rate</Label>
              <Input type="number" value={form.rate ?? ''} onChange={(e) => setField('rate', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Rate expiry</Label>
              <DatePicker
                value={form.rate_expiry_date ?? ''}
                onChange={(v) => setField('rate_expiry_date', v)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Note</Label>
              <Input value={form.note ?? ''} onChange={(e) => setField('note', e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- page ----------------

export function Sales(): React.JSX.Element {
  const [needs, setNeeds] = useState<Row[]>([])
  const loadNeeds = useCallback(async () => {
    setNeeds(await window.api.stock.needs())
  }, [])
  useEffect(() => {
    loadNeeds()
  }, [loadNeeds])
  useLiveRefresh(loadNeeds)

  return (
    <>
      <PageHeader title="Sales" subtitle="Finished-goods sales and sales bargains" hint="A sales bargain books a rate and quantity with a customer; each dispatch draws it down and reduces finished-goods stock. Short stock can be produced on the spot." />
      <div className="p-8">
        {needs.length > 0 && (
          <Card className="mb-6 border-amber-200 bg-amber-50 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              Produce more to meet committed sales
            </div>
            <div className="grid gap-1.5">
              {needs.map((nd) => (
                <div key={nd.id as number} className="flex items-center justify-between text-sm">
                  <span className="text-amber-900">
                    <span className="font-medium">{nd.name}</span> — produce {formatNum(nd.shortfall)} more
                    <span className="text-amber-700">
                      {' '}
                      (need {formatNum(nd.demand)}, in stock {formatNum(nd.stock)})
                    </span>
                  </span>
                  <Badge variant={nd.raw_short ? 'destructive' : 'warning'}>
                    {nd.raw_short ? 'Raw short — buy raw' : 'Raw available'}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Tabs defaultValue="sales">
          <TabsList>
            <TabsTrigger value="sales">Sales</TabsTrigger>
            <TabsTrigger value="bargains">Sales bargains</TabsTrigger>
          </TabsList>
          <TabsContent value="sales" className="mt-6">
            <SalesTab />
          </TabsContent>
          <TabsContent value="bargains" className="mt-6">
            <SalesBargainsTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
