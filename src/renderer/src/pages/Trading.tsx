import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRight, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function Trading(): React.JSX.Element {
  const [deals, setDeals] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const [form, setForm] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [d, p, s, c] = await Promise.all([
      window.api.trading.list(),
      window.api.data.list('products'),
      window.api.data.list('suppliers'),
      window.api.data.list('customers')
    ])
    setDeals(d)
    setProducts(p)
    setSuppliers(s)
    setCustomers(c)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  function openNew(): void {
    setForm({ deal_date: todayISO(), uom: 'MT', gst_pct: '' })
    setError(null)
  }

  const qty = form ? n(form.qty) : 0
  const purchaseRate = form ? n(form.purchase_rate) : 0
  const saleRate = form ? n(form.sale_rate) : 0
  const gstPct = form ? n(form.gst_pct) : 0
  const purchaseAmount = qty * purchaseRate
  const saleAmount = qty * saleRate
  const marginPreview = (saleAmount - purchaseAmount) * (1 + gstPct / 100)

  async function saveDeal(): Promise<void> {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      await window.api.trading.create(form)
      toast.success('Trading deal booked — no tanker movement, no stock entries')
      setForm(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function removeDeal(d: Row): Promise<void> {
    if (!window.confirm(`Delete this trading deal (${d.product_name}, ${formatNum(d.purchase_qty)} ${d.purchase_uom})? Both its purchase and sale invoices are removed too.`)) return
    await window.api.trading.remove(Number(d.id))
    toast.success('Deal deleted')
    await load()
  }

  const totalMargin = deals.reduce((s, d) => s + n(d.margin), 0)

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <PageHeader
        title="Purchase & Sales Trading"
        subtitle="Raw-product pass-through deals — buy from a supplier, sell the same quantity straight to a customer"
        hint="No bargain, no tanker movement, no stock entries — the purchase and sale book straight through in one step, same as ticking 'Trading' inside Purchases/Sales, just from one dedicated screen. Deleting a deal removes both its purchase and sale invoices."
      />

      <div className="flex items-center gap-2">
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total deals</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{deals.length}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total margin</div>
          <div className={`mt-1 text-lg font-semibold tabular-nums ${totalMargin < 0 ? 'text-destructive' : 'text-emerald-700'}`}>
            {formatINR(totalMargin)}
          </div>
        </Card>
        <Button className="ml-auto gap-1.5" onClick={openNew}>
          <Plus className="h-4 w-4" /> New trading deal
        </Button>
      </div>

      <Card className="overflow-auto p-0">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : deals.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">No trading deals booked yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Purchase</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Sale</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((d) => (
                <TableRow key={String(d.id)}>
                  <TableCell className="tabular-nums">{formatDate(d.deal_date)}</TableCell>
                  <TableCell className="font-medium">{d.product_code || d.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(d.purchase_qty)} {d.purchase_uom}</TableCell>
                  <TableCell>{d.supplier_name || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(d.purchase_net)}</TableCell>
                  <TableCell>{d.customer_name || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(d.sale_net)}</TableCell>
                  <TableCell className={`text-right font-medium tabular-nums ${n(d.margin) < 0 ? 'text-destructive' : 'text-emerald-700'}`}>
                    {formatINR(d.margin)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void removeDeal(d)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* New deal */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>New trading deal</DialogTitle></DialogHeader>
          {form && (
            <div className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label>Raw product *</Label>
                  <Select value={String(form.product_id || '')} onValueChange={(v) => setForm({ ...form, product_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                    <SelectContent>
                      {products.map((p) => <SelectItem key={String(p.id)} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5"><Label>Quantity *</Label><Input type="number" value={form.qty ?? ''} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></div>
                <div className="grid gap-1.5">
                  <Label>UOM</Label>
                  <Select value={form.uom || 'MT'} onValueChange={(v) => setForm({ ...form, uom: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MT">MT</SelectItem>
                      <SelectItem value="KG">KG</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Purchase (in)</div>
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <Label>Supplier *</Label>
                      <Select value={String(form.supplier_id || '')} onValueChange={(v) => setForm({ ...form, supplier_id: v })}>
                        <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                        <SelectContent className="max-h-64">
                          {suppliers.map((s) => <SelectItem key={String(s.id)} value={String(s.id)}>{s.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5"><Label>Purchase rate (₹) *</Label><Input type="number" value={form.purchase_rate ?? ''} onChange={(e) => setForm({ ...form, purchase_rate: e.target.value })} /></div>
                    <div className="grid gap-1.5"><Label>Purchase invoice no.</Label><Input value={form.purchase_invoice_no ?? ''} onChange={(e) => setForm({ ...form, purchase_invoice_no: e.target.value })} /></div>
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Sale (out)</div>
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <Label>Customer *</Label>
                      <Select value={String(form.customer_id || '')} onValueChange={(v) => setForm({ ...form, customer_id: v })}>
                        <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                        <SelectContent className="max-h-64">
                          {customers.map((c) => <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5"><Label>Sale rate (₹) *</Label><Input type="number" value={form.sale_rate ?? ''} onChange={(e) => setForm({ ...form, sale_rate: e.target.value })} /></div>
                    <div className="grid gap-1.5"><Label>Sale invoice no.</Label><Input value={form.sale_invoice_no ?? ''} onChange={(e) => setForm({ ...form, sale_invoice_no: e.target.value })} /></div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5"><Label>Deal date</Label><DatePicker value={String(form.deal_date || '')} onChange={(v) => setForm({ ...form, deal_date: v })} /></div>
                <div className="grid gap-1.5"><Label>GST %</Label><Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setForm({ ...form, gst_pct: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label>Note</Label><Input value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
              </div>

              {qty > 0 && purchaseRate > 0 && saleRate > 0 && (
                <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3 text-[13px]">
                  <span className="font-medium">{formatINR(purchaseAmount)}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{formatINR(saleAmount)}</span>
                  <Badge variant={marginPreview < 0 ? 'destructive' : 'success'} className="ml-auto">
                    Margin (incl. GST) {formatINR(marginPreview)}
                  </Badge>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button disabled={saving} onClick={() => void saveDeal()}>{saving ? 'Booking…' : 'Book deal'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
