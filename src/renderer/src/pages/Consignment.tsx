import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { InfoTip } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { computeMoney } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function SummaryLine({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between py-1 text-sm', strong && 'font-semibold')}>
      <span className={cn(!strong && 'text-muted-foreground')}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function Consignment(): React.JSX.Element {
  const [deposits, setDeposits] = useState<Row[]>([])
  const [summary, setSummary] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [settings, setSettings] = useState<Row>({})
  const [loading, setLoading] = useState(true)

  // intake (deposit) dialog
  const [depOpen, setDepOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [depForm, setDepForm] = useState<Row>({})
  const [depError, setDepError] = useState<string | null>(null)
  const [savingDep, setSavingDep] = useState(false)

  // booking dialog
  const [book, setBook] = useState<Row | null>(null)
  const [bookForm, setBookForm] = useState<Row>({})
  const [bookError, setBookError] = useState<string | null>(null)
  const [savingBook, setSavingBook] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [d, sm, s, p, b, cfg] = await Promise.all([
      window.api.consignment.list(),
      window.api.consignment.summary(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.bargains.list(),
      window.api.settings.all()
    ])
    setDeposits(d)
    setSummary(sm)
    setSuppliers(s.filter((x) => x.active))
    setProducts(p.filter((x) => x.active && x.category === 'raw'))
    setBargains(b)
    setSettings(cfg)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  const defaultUom = settings.default_uom ?? 'MT'

  function openAddDeposit(): void {
    setEditing(null)
    setDepForm({ supplier_id: '', product_id: '', qty: '', uom: defaultUom, deposit_date: todayISO(), note: '' })
    setDepError(null)
    setDepOpen(true)
  }

  function openEditDeposit(row: Row): void {
    setEditing(row)
    setDepForm({
      supplier_id: String(row.supplier_id ?? ''),
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      uom: row.uom ?? defaultUom,
      deposit_date: row.deposit_date ?? todayISO(),
      note: row.note ?? ''
    })
    setDepError(null)
    setDepOpen(true)
  }

  async function saveDeposit(): Promise<void> {
    if (!depForm.supplier_id) return setDepError('Supplier is required')
    if (!depForm.product_id) return setDepError('Product is required')
    if (!depForm.qty || Number(depForm.qty) <= 0) return setDepError('Quantity must be greater than 0')
    setSavingDep(true)
    setDepError(null)
    const payload: Row = {
      supplier_id: Number(depForm.supplier_id),
      product_id: Number(depForm.product_id),
      qty: Number(depForm.qty),
      uom: depForm.uom || defaultUom,
      deposit_date: depForm.deposit_date,
      note: depForm.note || null
    }
    try {
      if (editing) {
        await window.api.consignment.update(editing.id as number, payload)
        toast.success('Consignment stock updated')
      } else {
        await window.api.consignment.create(payload)
        toast.success('Consignment stock added')
      }
      setDepOpen(false)
      await load()
    } catch (e) {
      setDepError((e as Error).message)
    } finally {
      setSavingDep(false)
    }
  }

  async function deleteDeposit(row: Row): Promise<void> {
    if (!window.confirm(`Delete this consignment stock entry for ${row.supplier_name}?`)) return
    try {
      await window.api.consignment.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Bargains available for the booking's supplier + product with balance left.
  const bookBargains = useMemo(() => {
    if (!book) return []
    return bargains.filter(
      (b) =>
        String(b.supplier_id) === String(book.supplier_id) &&
        String(b.oil_type_id) === String(book.product_id) &&
        Number(b.balance_qty) > 0.0001
    )
  }, [book, bargains])

  const chosenBargain = useMemo(
    () => bargains.find((b) => String(b.id) === String(bookForm.bargain_id)),
    [bargains, bookForm.bargain_id]
  )

  // Max invoiceable = min(consigned balance, chosen bargain balance).
  const maxBookQty = useMemo(() => {
    const consign = Number(book?.balance) || 0
    const barg = chosenBargain ? Number(chosenBargain.balance_qty) || 0 : consign
    return Math.min(consign, barg)
  }, [book, chosenBargain])

  async function openBooking(sumRow: Row): Promise<void> {
    const supplier = suppliers.find((x) => String(x.id) === String(sumRow.supplier_id))
    setBook(sumRow)
    setBookError(null)
    setBookForm({
      bargain_id: '',
      invoice_no: '',
      order_date: todayISO(),
      ordered_qty: '',
      invoice_rate: '',
      gst_pct: supplier?.gst_pct ?? 0,
      gst_type: 'CGST_SGST',
      tds_pct: supplier?.tds_pct ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      tds_threshold: supplier?.tds_threshold ?? 0,
      adds_interest: !!supplier?.adds_interest,
      charge_interest: false,
      interest_pct: supplier?.interest_pct ?? 0,
      interest_days: supplier?.interest_days ?? 0,
      remarks: '',
      tds_prior: 0
    })
  }

  // When a bargain is chosen, default the invoice rate to its bargain rate.
  function chooseBookBargain(id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    setBookForm((p) => ({
      ...p,
      bargain_id: id,
      invoice_rate: p.invoice_rate || (b ? b.rate_per_uom : '')
    }))
  }

  // Prior-year taxable for the correct TDS slab in the preview.
  useEffect(() => {
    if (!book || !bookForm.order_date) return
    let active = true
    window.api.orders
      .fyTaxable(Number(book.supplier_id), String(bookForm.order_date), 0)
      .then((v) => active && setBookForm((p) => ({ ...p, tds_prior: v })))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [book, bookForm.order_date])

  const calc = useMemo(
    () =>
      computeMoney({
        orderedQty: Number(bookForm.ordered_qty) || 0,
        invoiceRate: Number(bookForm.invoice_rate) || 0,
        bargainRate: chosenBargain ? Number(chosenBargain.rate_per_uom) || 0 : 0,
        gstPct: Number(bookForm.gst_pct) || 0,
        tdsPct: bookForm.tds_above_only ? 0 : Number(bookForm.tds_pct) || 0,
        addsInterest: !!bookForm.charge_interest,
        interestPct: Number(bookForm.interest_pct) || 0,
        interestDays: Number(bookForm.interest_days) || 0,
        tdsThreshold: Number(bookForm.tds_threshold) || 0,
        tdsPctAbove: Number(bookForm.tds_pct) || 0,
        tdsPrior: Number(bookForm.tds_prior) || 0
      }),
    [bookForm, chosenBargain]
  )

  async function saveBooking(): Promise<void> {
    if (!book) return
    if (!bookForm.bargain_id) return setBookError('Select the bargain to invoice against')
    if (!bookForm.invoice_no) return setBookError('Invoice number is required')
    const qty = Number(bookForm.ordered_qty) || 0
    if (qty <= 0) return setBookError('Enter the quantity to invoice')
    if (qty > maxBookQty + 1e-6) {
      return setBookError(`Quantity exceeds what is available (${formatNum(maxBookQty)} ${book.uom || 'MT'})`)
    }
    if (Number(bookForm.invoice_rate) <= 0) return setBookError('Invoice rate must be greater than zero')
    setSavingBook(true)
    setBookError(null)
    try {
      await window.api.orders.create({
        is_consignment: true,
        invoice_no: bookForm.invoice_no,
        order_date: bookForm.order_date,
        bargain_id: Number(bookForm.bargain_id),
        supplier_id: Number(book.supplier_id),
        oil_type_id: Number(book.product_id),
        bargain_type: chosenBargain?.bargain_type || 'EX',
        ordered_qty: qty,
        uom: book.uom || 'MT',
        bargain_rate: chosenBargain ? Number(chosenBargain.rate_per_uom) : 0,
        invoice_rate: Number(bookForm.invoice_rate),
        gst_pct: Number(bookForm.gst_pct) || 0,
        gst_type: bookForm.gst_type || 'CGST_SGST',
        tds_pct: Number(bookForm.tds_pct) || 0,
        charge_interest: !!bookForm.charge_interest,
        interest_pct: Number(bookForm.interest_pct) || 0,
        interest_days: Number(bookForm.interest_days) || 0,
        round_off: 0,
        remarks: bookForm.remarks || null,
        transporter_id: null,
        is_registered_transporter: false,
        allowed_shortage_pct: null,
        tanker_ids: [],
        financed_by_party: false,
        payment_date: bookForm.order_date
      })
      toast.success('Consignment purchase booked')
      setBook(null)
      await load()
    } catch (e) {
      setBookError((e as Error).message)
    } finally {
      setSavingBook(false)
    }
  }

  const totalBalance = summary.reduce((s, r) => s + (Number(r.balance) || 0), 0)

  return (
    <>
      <PageHeader
        title="Consignment stock"
        subtitle="Supplier goods lying at your place but not yet in your books — invoice them to make them yours"
        hint="Log stock a supplier deposits at your place. It shows here as supplier-owned (off-books). When you set a bargain and book a purchase invoice against it, the invoiced quantity becomes your owned stock and enters your books — no transporter, no tanker stages."
        actions={
          <Button size="sm" onClick={openAddDeposit}>
            <Plus className="h-4 w-4" /> Log consignment stock
          </Button>
        }
      />

      <div className="space-y-6 p-6">
        <section className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <div>
              <h3 className="font-medium">Consigned stock (supplier-owned)</h3>
              <p className="text-xs text-muted-foreground">Balance still lying at your place, per supplier and product.</p>
            </div>
            <Badge variant="secondary">{formatNum(totalBalance)} MT total</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Deposited</TableHead>
                <TableHead className="text-right">Invoiced</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : summary.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No consignment stock yet.</TableCell></TableRow>
              ) : (
                summary.map((r) => (
                  <TableRow key={`${r.supplier_id}:${r.product_id}`}>
                    <TableCell className="font-medium">{r.supplier_name}</TableCell>
                    <TableCell>{r.product_code || r.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNum(r.deposited)} {r.uom}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.invoiced)} {r.uom}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatNum(r.balance)} {r.uom}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Number(r.balance) <= 0.0001}
                        onClick={() => openBooking(r)}
                      >
                        Book purchase
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>

        <section className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3">
            <h3 className="font-medium">Deposit entries</h3>
            <p className="text-xs text-muted-foreground">Each time a supplier drops stock at your place.</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : deposits.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No deposits recorded.</TableCell></TableRow>
              ) : (
                deposits.map((d) => (
                  <TableRow key={d.id as number}>
                    <TableCell>{formatDate(d.deposit_date)}</TableCell>
                    <TableCell className="font-medium">{d.supplier_name}</TableCell>
                    <TableCell>{d.product_code || d.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNum(d.qty)} {d.uom}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-muted-foreground">{d.note || '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditDeposit(d)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteDeposit(d)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </div>

      {/* Deposit intake dialog */}
      <Dialog open={depOpen} onOpenChange={(o) => !o && setDepOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit consignment stock' : 'Log consignment stock'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(depForm.supplier_id || '')} onValueChange={(v) => setDepForm((p) => ({ ...p, supplier_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Product *</Label>
              <Select value={String(depForm.product_id || '')} onValueChange={(v) => setDepForm((p) => ({ ...p, product_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Quantity *</Label>
                <Input type="number" value={depForm.qty ?? ''} onChange={(e) => setDepForm((p) => ({ ...p, qty: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label>Deposit date</Label>
                <DatePicker value={depForm.deposit_date || ''} onChange={(v) => setDepForm((p) => ({ ...p, deposit_date: v }))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Note</Label>
              <Input value={depForm.note ?? ''} onChange={(e) => setDepForm((p) => ({ ...p, note: e.target.value }))} />
            </div>
            {depError && <p className="text-sm text-destructive">{depError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepOpen(false)} disabled={savingDep}>Cancel</Button>
            <Button onClick={saveDeposit} disabled={savingDep}>{savingDep ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Booking dialog */}
      <Dialog open={!!book} onOpenChange={(o) => !o && setBook(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              Book consignment purchase
              <InfoTip text="No transporter, no gate entry and no tanker stages — the goods are already at your place. The invoiced quantity becomes your owned stock and posts to the supplier ledger and journal." />
            </DialogTitle>
          </DialogHeader>
          {book && (
            <div className="grid gap-4">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                {book.supplier_name} · {book.product_code || book.product_name} · available{' '}
                <b>{formatNum(book.balance)} {book.uom}</b>
              </div>
              <div className="grid gap-1.5">
                <Label>Bargain *</Label>
                <Select value={String(bookForm.bargain_id || '')} onValueChange={chooseBookBargain}>
                  <SelectTrigger><SelectValue placeholder="Select the bargain" /></SelectTrigger>
                  <SelectContent>
                    {bookBargains.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · BAL {formatNum(b.balance_qty)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {bookBargains.length === 0 && (
                  <span className="text-[11px] text-amber-700">No open bargain for this supplier and product — create one in Bargains first.</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Invoice number *</Label>
                  <Input value={bookForm.invoice_no || ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_no: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Invoice date *</Label>
                  <DatePicker value={bookForm.order_date || ''} onChange={(v) => setBookForm((p) => ({ ...p, order_date: v }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Quantity * (max {formatNum(maxBookQty)})</Label>
                  <Input type="number" value={bookForm.ordered_qty || ''} onChange={(e) => setBookForm((p) => ({ ...p, ordered_qty: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Invoice rate *</Label>
                  <Input type="number" value={bookForm.invoice_rate ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_rate: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>GST %</Label>
                  <Input type="number" value={bookForm.gst_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>GST type</Label>
                  <Select value={bookForm.gst_type || 'CGST_SGST'} onValueChange={(v) => setBookForm((p) => ({ ...p, gst_type: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                      <SelectItem value="IGST">IGST</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>TDS %</Label>
                  <Input type="number" value={bookForm.tds_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Switch checked={!!bookForm.charge_interest} onCheckedChange={(v) => setBookForm((p) => ({ ...p, charge_interest: v }))} />
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">Supplier interest</span>
                    <InfoTip text="Interest = BG rate incl. GST × Int% × days ÷ 365; adjusted invoice rate = invoice rate + interest." />
                  </div>
                </div>
                <div className={cn('ml-auto flex items-center gap-2', !bookForm.charge_interest && 'opacity-50')}>
                  <Label className="text-xs">Int %</Label>
                  <Input type="number" className="h-8 w-20 text-right" disabled={!bookForm.charge_interest} value={bookForm.interest_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, interest_pct: e.target.value }))} />
                  <Label className="text-xs">Days</Label>
                  <Input type="number" className="h-8 w-20 text-right" disabled={!bookForm.charge_interest} value={bookForm.interest_days ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, interest_days: e.target.value }))} />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Remarks</Label>
                <textarea
                  rows={2}
                  className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Optional notes"
                  value={bookForm.remarks ?? ''}
                  onChange={(e) => setBookForm((p) => ({ ...p, remarks: e.target.value }))}
                />
              </div>

              <div className="rounded-lg border bg-muted/30 p-3">
                <SummaryLine label="Adjusted invoice rate" value={formatINR(calc.adjustedRate)} />
                <SummaryLine label="Taxable value" value={formatINR(calc.taxableValue)} />
                <SummaryLine label="GST" value={formatINR(calc.gstAmount)} />
                <SummaryLine label="TDS" value={`− ${formatINR(calc.tdsAmount)}`} />
                <SummaryLine label="Net purchase amount" value={formatINR(calc.netAmount)} strong />
              </div>

              {bookError && <p className="text-sm text-destructive">{bookError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBook(null)} disabled={savingBook}>Cancel</Button>
            <Button onClick={saveBooking} disabled={savingBook}>{savingBook ? 'Booking…' : 'Book purchase'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
