import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Inbox, Pencil, Plus, Repeat, Search, TrendingDown, TrendingUp, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { computeMoney } from '@/lib/orderCalc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Auto-loaded fields get a distinct highlight so it's visible at a glance
// which values came off the party master vs. were typed by hand.
const AUTO_CLASS = 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400'

function MoneyRow({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className={strong ? 'font-semibold text-foreground' : muted ? 'text-muted-foreground' : 'text-foreground/80'}>{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

const emptyForm = (): Row => ({
  deal_date: todayISO(),
  uom: 'MT',
  purchase_gst_type: 'CGST_SGST',
  sale_gst_type: 'CGST_SGST',
  purchase_gst_pct: '',
  purchase_tds_pct: '',
  purchase_round_off: '',
  purchase_round_off_manual: false,
  sale_gst_pct: '',
  sale_round_off: '',
  sale_round_off_manual: false
})

export function Trading(): React.JSX.Element {
  const [deals, setDeals] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const [formPage, setFormPage] = useState(false)
  const [editingDeal, setEditingDeal] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Which fields currently hold a value auto-loaded from the party master —
  // drives the highlight; editing a field by hand clears its own flag.
  const [autoFields, setAutoFields] = useState<Set<string>>(new Set())

  function setField(key: string, value: unknown): void {
    setForm((p) => ({ ...p, [key]: value }))
    setAutoFields((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

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
    setEditingDeal(null)
    setForm(emptyForm())
    setAutoFields(new Set())
    setError(null)
    setFormPage(true)
  }

  function openEdit(d: Row): void {
    setEditingDeal(d)
    setForm({
      deal_date: d.deal_date || todayISO(),
      product_id: String(d.product_id || ''),
      qty: d.purchase_qty ?? '',
      uom: d.purchase_uom || 'MT',
      note: d.note || '',
      supplier_id: String(d.supplier_id || ''),
      purchase_invoice_no: d.purchase_invoice_no || '',
      purchase_rate: d.purchase_rate ?? '',
      purchase_gst_pct: d.purchase_gst_pct ?? '',
      purchase_gst_type: d.purchase_gst_type || 'CGST_SGST',
      purchase_tds_pct: d.purchase_tds_pct ?? '',
      purchase_round_off: d.purchase_round_off ?? '',
      // A non-zero saved round off was a deliberate override — preserve it as
      // manual rather than letting the auto-effect silently recompute it.
      purchase_round_off_manual: !!(d.purchase_round_off && Number(d.purchase_round_off) !== 0),
      customer_id: String(d.customer_id || ''),
      sale_invoice_no: d.sale_invoice_no || '',
      sale_rate: d.sale_rate ?? '',
      sale_gst_pct: d.sale_gst_pct ?? '',
      sale_gst_type: d.sale_gst_type || 'CGST_SGST',
      sale_round_off: d.sale_round_off ?? '',
      sale_round_off_manual: !!(d.sale_round_off && Number(d.sale_round_off) !== 0)
    })
    setAutoFields(new Set())
    setError(null)
    setFormPage(true)
  }

  // Same as the real Purchase form's supplier pick: GST/TDS come off the
  // party master, not typed by hand each time. No interest here — a trading
  // deal is a clean pass-through, so that block doesn't apply.
  function chooseSupplier(id: string): void {
    const s = suppliers.find((x) => String(x.id) === id)
    setForm((p) => ({
      ...p,
      supplier_id: id,
      purchase_gst_pct: s?.gst_pct ?? p.purchase_gst_pct,
      purchase_tds_pct: s?.tds_pct ?? p.purchase_tds_pct
    }))
    setAutoFields((prev) => {
      const next = new Set(prev)
      if (s?.gst_pct != null) next.add('purchase_gst_pct')
      if (s?.tds_pct != null) next.add('purchase_tds_pct')
      return next
    })
  }

  // Same as the Sales Bargain form's customer pick — GST off the customer
  // master when it carries one.
  function chooseCustomer(id: string): void {
    const c = customers.find((x) => String(x.id) === id)
    const hasGst = c && Number(c.gst_pct) > 0
    setForm((p) => ({
      ...p,
      customer_id: id,
      sale_gst_pct: hasGst ? c.gst_pct : p.sale_gst_pct
    }))
    if (hasGst) setAutoFields((prev) => new Set(prev).add('sale_gst_pct'))
  }

  const qty = n(form.qty)
  const purchaseRate = n(form.purchase_rate)
  const saleRate = n(form.sale_rate)

  const purchaseCalc = useMemo(
    () =>
      computeMoney({
        orderedQty: qty,
        invoiceRate: purchaseRate,
        bargainRate: purchaseRate,
        gstPct: n(form.purchase_gst_pct),
        tdsPct: n(form.purchase_tds_pct),
        addsInterest: false,
        interestPct: 0,
        interestDays: 0,
        roundOff: n(form.purchase_round_off)
      }),
    [qty, purchaseRate, form.purchase_gst_pct, form.purchase_tds_pct, form.purchase_round_off]
  )

  const saleCalc = useMemo(() => {
    const amount = qty * saleRate
    const gstAmount = (amount * n(form.sale_gst_pct)) / 100
    const roundOff = n(form.sale_round_off)
    return { amount, gstAmount, roundOff, preRoundTotal: amount + gstAmount, total: amount + gstAmount + roundOff }
  }, [qty, saleRate, form.sale_gst_pct, form.sale_round_off])

  const margin = saleCalc.total - purchaseCalc.roundedTotal

  // Auto round-off to the nearest rupee on both invoices — same as the real
  // Purchase/Sale forms. A manual edit overrides it; clearing the field
  // brings the auto value back.
  useEffect(() => {
    if (!formPage || form.purchase_round_off_manual) return
    const total = purchaseCalc.totalExclTds
    if (!Number.isFinite(total) || total <= 0) return
    const auto = Math.round(total) - total
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(form.purchase_round_off ?? '') !== val) {
      setForm((p) => ({ ...p, purchase_round_off: val }))
    }
  }, [formPage, purchaseCalc.totalExclTds, form.purchase_round_off_manual, form.purchase_round_off])

  useEffect(() => {
    if (!formPage || form.sale_round_off_manual) return
    const total = saleCalc.preRoundTotal
    if (!Number.isFinite(total) || total <= 0) return
    const auto = Math.round(total) - total
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(form.sale_round_off ?? '') !== val) {
      setForm((p) => ({ ...p, sale_round_off: val }))
    }
  }, [formPage, saleCalc.preRoundTotal, form.sale_round_off_manual, form.sale_round_off])

  async function saveDeal(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      if (editingDeal) {
        await window.api.trading.update(Number(editingDeal.id), form)
        toast.success('Trading deal updated')
      } else {
        await window.api.trading.create(form)
        toast.success('Trading deal booked — no tanker movement, no stock entries')
      }
      setFormPage(false)
      setEditingDeal(null)
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
  const totalPurchase = deals.reduce((s, d) => s + n(d.purchase_total), 0)
  const totalSale = deals.reduce((s, d) => s + n(d.sale_net), 0)

  const filteredDeals = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return deals
    return deals.filter((d) =>
      [d.product_code, d.product_name, d.supplier_name, d.customer_name, d.purchase_invoice_no, d.sale_invoice_no]
        .some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [deals, search])

  if (formPage) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
            <button className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline" onClick={() => { setFormPage(false); setEditingDeal(null) }}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
            <div className="h-4 border-l border-[#1a2c56]/30" />
            <h2 className="text-[13px] font-bold uppercase tracking-widest">{editingDeal ? 'Alter trading deal' : 'New trading deal'}</h2>
            <span className="ml-auto text-[11px] font-medium">Raw pass-through — no bargain, no tanker, no stock</span>
          </div>

          <div className="grid gap-4 p-4 xl:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <section className="rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Deal details
                </h3>
                <div className="grid gap-4 md:grid-cols-4">
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label>Raw product *</Label>
                    <Select value={String(form.product_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                      <SelectContent>
                        {products.map((p) => <SelectItem key={String(p.id)} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Quantity *</Label>
                    <Input type="number" value={form.qty ?? ''} onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>UOM</Label>
                    <Select value={form.uom || 'MT'} onValueChange={(v) => setForm((p) => ({ ...p, uom: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MT">MT</SelectItem>
                        <SelectItem value="KG">KG</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Deal date</Label>
                    <DatePicker value={String(form.deal_date || '')} onChange={(v) => setForm((p) => ({ ...p, deal_date: v }))} />
                  </div>
                  <div className="grid gap-1.5 md:col-span-3">
                    <Label>Note</Label>
                    <Input value={form.note ?? ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
                  </div>
                </div>
              </section>

              <section className="rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Purchase (in)
                </h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label>Supplier *</Label>
                    <Select value={String(form.supplier_id || '')} onValueChange={chooseSupplier}>
                      <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {suppliers.map((s) => <SelectItem key={String(s.id)} value={String(s.id)}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Purchase invoice no. *</Label>
                    <Input value={form.purchase_invoice_no ?? ''} onChange={(e) => setForm((p) => ({ ...p, purchase_invoice_no: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Purchase rate (₹) *</Label>
                    <Input type="number" value={form.purchase_rate ?? ''} onChange={(e) => setForm((p) => ({ ...p, purchase_rate: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST % {autoFields.has('purchase_gst_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                    <Input
                      type="number"
                      className={autoFields.has('purchase_gst_pct') ? AUTO_CLASS : ''}
                      value={form.purchase_gst_pct ?? ''}
                      onChange={(e) => setField('purchase_gst_pct', e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.purchase_gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, purchase_gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>TDS % {autoFields.has('purchase_tds_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                    <Input
                      type="number"
                      className={autoFields.has('purchase_tds_pct') ? AUTO_CLASS : ''}
                      value={form.purchase_tds_pct ?? ''}
                      onChange={(e) => setField('purchase_tds_pct', e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Round off (₹) {form.purchase_round_off_manual ? '(manual)' : '(auto)'}</Label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={form.purchase_round_off ?? ''}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, purchase_round_off: e.target.value, purchase_round_off_manual: e.target.value !== '' }))
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Sale (out)
                </h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label>Customer *</Label>
                    <Select value={String(form.customer_id || '')} onValueChange={chooseCustomer}>
                      <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {customers.map((c) => <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Sales invoice no. *</Label>
                    <Input value={form.sale_invoice_no ?? ''} onChange={(e) => setForm((p) => ({ ...p, sale_invoice_no: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Sale rate (₹) *</Label>
                    <Input type="number" value={form.sale_rate ?? ''} onChange={(e) => setForm((p) => ({ ...p, sale_rate: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Quantity sold <span className="text-[10px] font-normal text-muted-foreground">(auto, same as purchased)</span></Label>
                    <Input disabled value={qty > 0 ? `${formatNum(qty)} ${form.uom || 'MT'}` : ''} className="bg-muted/50 text-muted-foreground" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST % {autoFields.has('sale_gst_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                    <Input
                      type="number"
                      className={autoFields.has('sale_gst_pct') ? AUTO_CLASS : ''}
                      value={form.sale_gst_pct ?? ''}
                      onChange={(e) => setField('sale_gst_pct', e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.sale_gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, sale_gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Round off (₹) {form.sale_round_off_manual ? '(manual)' : '(auto)'}</Label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={form.sale_round_off ?? ''}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, sale_round_off: e.target.value, sale_round_off_manual: e.target.value !== '' }))
                      }
                    />
                  </div>
                </div>
              </section>

              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setFormPage(false); setEditingDeal(null) }}>Cancel</Button>
                <Button disabled={saving} onClick={() => void saveDeal()}>
                  {saving ? 'Saving…' : editingDeal ? 'Save changes' : 'Book deal'}
                </Button>
              </div>
            </div>

            <aside className="h-fit space-y-4 xl:sticky xl:top-6">
              <div className="rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4">
                <h3 className="mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Purchase summary</h3>
                <MoneyRow label="Adjusted rate" value={formatINR(purchaseCalc.adjustedRate)} muted />
                <MoneyRow label="Taxable value" value={formatINR(purchaseCalc.taxableValue)} muted />
                <MoneyRow label="GST" value={formatINR(purchaseCalc.gstAmount)} muted />
                <MoneyRow label="Total (excl. TDS)" value={formatINR(purchaseCalc.totalExclTds)} muted />
                <MoneyRow label="Round off" value={formatINR(n(form.purchase_round_off))} muted />
                <div className="my-2 border-t" />
                <MoneyRow label="Total after round off" value={formatINR(purchaseCalc.roundedTotal)} />
                <MoneyRow label="TDS" value={formatINR(purchaseCalc.tdsAmount)} muted />
                <div className="my-2 border-t-2 border-[#1a2c56]" />
                <MoneyRow label="Net payable to supplier" value={formatINR(purchaseCalc.netAmount)} strong />
              </div>

              <div className="rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4">
                <h3 className="mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Sale summary</h3>
                <MoneyRow label="Taxable value" value={formatINR(saleCalc.amount)} muted />
                <MoneyRow label="GST" value={formatINR(saleCalc.gstAmount)} muted />
                <MoneyRow label="Round off" value={formatINR(saleCalc.roundOff)} muted />
                <div className="my-2 border-t-2 border-[#1a2c56]" />
                <MoneyRow label="Sale invoice total" value={formatINR(saleCalc.total)} strong />
              </div>

              <div className="rounded border border-[#1a2c56]/30 bg-white p-4">
                <MoneyRow label="Deal margin (sale − purchase, incl. GST)" value={formatINR(margin)} strong />
              </div>
            </aside>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <PageHeader
        title="Purchase & Sales Trading"
        subtitle="Raw-product pass-through deals — buy from a supplier, sell the same quantity straight to a customer"
        hint="No bargain, no tanker movement, no stock entries, no interest — the purchase and sale book straight through in one step, same as ticking 'Trading' inside Purchases/Sales, just from one dedicated screen with full GST/TDS/round-off control. GST/TDS auto-load from the supplier/customer master (highlighted amber) and can be overridden. Deleting a deal removes both its purchase and sale invoices."
        actions={
          <Button className="gap-1.5" onClick={openNew}>
            <Plus className="h-4 w-4" /> New trading deal
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="flex items-center gap-3 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-700">
            <Repeat className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total deals</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{deals.length}</div>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total purchase</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatINR(totalPurchase)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total sale</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatINR(totalSale)}</div>
        </Card>
        <Card className="flex items-center gap-3 p-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${totalMargin < 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
            {totalMargin < 0 ? <TrendingDown className="h-4.5 w-4.5" /> : <TrendingUp className="h-4.5 w-4.5" />}
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total margin</div>
            <div className={`mt-0.5 text-lg font-semibold tabular-nums ${totalMargin < 0 ? 'text-destructive' : 'text-emerald-700'}`}>
              {formatINR(totalMargin)}
            </div>
          </div>
        </Card>
      </div>

      <div className="relative w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, party, invoice no…"
          className="h-9 pl-8"
        />
      </div>

      <Card className="overflow-auto p-0">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : filteredDeals.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {deals.length === 0 ? 'No trading deals booked yet.' : 'No deals match your search.'}
            </p>
            {deals.length === 0 && (
              <Button size="sm" variant="outline" className="mt-1 gap-1.5" onClick={openNew}>
                <Plus className="h-3.5 w-3.5" /> Book your first deal
              </Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Purchase (net)</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Sale (total)</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredDeals.map((d) => (
                <TableRow key={String(d.id)} className="group">
                  <TableCell className="tabular-nums text-muted-foreground">{formatDate(d.deal_date)}</TableCell>
                  <TableCell className="font-medium">{d.product_code || d.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(d.purchase_qty)} {d.purchase_uom}</TableCell>
                  <TableCell>
                    <div>{d.supplier_name || '—'}</div>
                    {d.purchase_invoice_no && <div className="text-[11px] text-muted-foreground">{d.purchase_invoice_no}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(d.purchase_net)}</TableCell>
                  <TableCell>
                    <div>{d.customer_name || '—'}</div>
                    {d.sale_invoice_no && <div className="text-[11px] text-muted-foreground">{d.sale_invoice_no}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(d.sale_net)}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={n(d.margin) < 0 ? 'destructive' : 'success'} className="gap-1 tabular-nums">
                      {n(d.margin) < 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
                      {formatINR(d.margin)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit this deal" onClick={() => openEdit(d)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete this deal" onClick={() => void removeDeal(d)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
