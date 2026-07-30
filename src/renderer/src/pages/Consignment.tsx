import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
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
  const [pending, setPending] = useState<Row[]>([])
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
    const [d, sm, pg, s, p, b, cfg] = await Promise.all([
      window.api.consignment.list(),
      window.api.consignment.summary(),
      window.api.consignment.pending(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.bargains.list(),
      window.api.settings.all()
    ])
    setDeposits(d)
    setSummary(sm)
    setPending(pg)
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

  // Weighed quantity less the allowed shortage, to 3 decimals.
  function netOfShortage(weighed: unknown, pct: unknown): string {
    const w = Number(weighed) || 0
    const p = Number(pct) || 0
    if (w <= 0) return ''
    return String(Math.round(w * (1 - p / 100) * 1000) / 1000)
  }

  function openAddDeposit(): void {
    setEditing(null)
    setDepForm({ supplier_id: '', product_id: '', qty: '', uom: defaultUom, deposit_date: todayISO(), note: '' })
    setDepError(null)
    setDepOpen(true)
  }

  // Validate a gate arrival into consignment stock: the gateman already logged
  // the vehicle (and its weighment), the accountant confirms whose stock it is.
  function openValidate(g: Row): void {
    setEditing(null)
    setDepForm({
      gate_entry_id: g.id,
      gate_entry_no: g.gate_entry_no,
      tanker_no: g.tanker_no || '',
      // A Direct MNC arrival already named its party at the gate, so validation
      // is only about which oil it is.
      supplier_id: g.supplier_id ? String(g.supplier_id) : '',
      supplier_prefilled: !!g.supplier_id,
      supplier_name: g.supplier_name || '',
      product_id: g.oil_type_id ? String(g.oil_type_id) : '',
      // The gate figure is gross-of-shortage; the stock taken in is net of the
      // allowed shortage, which is how the yard has been noting it by hand.
      weighed_qty: Number(g.received_qty) > 0 ? g.received_qty : '',
      shortage_pct: settings.allowed_shortage_pct ?? '0.2',
      qty:
        Number(g.received_qty) > 0
          ? netOfShortage(g.received_qty, settings.allowed_shortage_pct ?? '0.2')
          : '',
      uom: g.uom || defaultUom,
      deposit_date: g.entry_date ?? todayISO(),
      note: g.note || ''
    })
    setDepError(null)
    setDepOpen(true)
  }

  function openEditDeposit(row: Row): void {
    setEditing(row)
    setDepForm({
      supplier_id: String(row.supplier_id ?? ''),
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      weighed_qty: row.weighed_qty ?? '',
      shortage_pct: row.shortage_pct ?? '',
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
      note:
        depForm.note ||
        (Number(depForm.shortage_pct) > 0 && Number(depForm.weighed_qty) > 0
          ? `AFTER ${depForm.shortage_pct}% SHORTAGE`
          : null),
      gate_entry_id: depForm.gate_entry_id ? Number(depForm.gate_entry_id) : null,
      tanker_no: depForm.tanker_no || null,
      // Recorded alongside the net so the register can show how it was reached.
      weighed_qty: depForm.weighed_qty !== '' && depForm.weighed_qty != null ? Number(depForm.weighed_qty) : null,
      shortage_pct: depForm.shortage_pct !== '' && depForm.shortage_pct != null ? Number(depForm.shortage_pct) : null
    }
    try {
      if (editing) {
        await window.api.consignment.update(editing.id as number, payload)
        toast.success('Consignment stock updated')
      } else {
        await window.api.consignment.create(payload)
        toast.success(
          depForm.gate_entry_id
            ? `Gate entry ${depForm.gate_entry_no} validated into consignment stock`
            : 'Consignment stock added'
        )
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

  // The stock register: one band per supplier, a line per product inside it,
  // and the individual tankers under each product. Numbers come from the roll-up
  // so they always agree with what the purchase side draws against.
  const stockBands = useMemo(() => {
    const bands = new Map<string, Row>()
    for (const r of summary) {
      const key = String(r.supplier_id)
      if (!bands.has(key)) {
        bands.set(key, {
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          uom: r.uom || 'MT',
          deposited: 0,
          invoiced: 0,
          balance: 0,
          products: [] as Row[]
        })
      }
      const band = bands.get(key) as Row
      band.deposited += Number(r.deposited) || 0
      band.invoiced += Number(r.invoiced) || 0
      band.balance += Number(r.balance) || 0
      band.products.push({
        ...r,
        lots: deposits
          .filter(
            (d) =>
              String(d.supplier_id) === String(r.supplier_id) &&
              String(d.product_id) === String(r.product_id)
          )
          .sort((a, b) => String(a.deposit_date || '').localeCompare(String(b.deposit_date || '')))
      })
    }
    return Array.from(bands.values()).sort((a, b) =>
      String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''))
    )
  }, [summary, deposits])
  const pendingLotCount = deposits.filter((d) => d.order_id == null).length

  return (
    <>
      <PageHeader
        title="Consignment stock"
        subtitle="Supplier goods lying at your place but not yet in your books — invoice them to make them yours"
        hint="Log stock a supplier deposits at your place. It shows here as supplier-owned (off-books). When you set a bargain and book a purchase invoice against it, the invoiced quantity becomes your owned stock and enters your books — no transporter, no tanker stages."
        actions={
          <div className="flex items-center gap-2">
            <ExcelButton
              filename={`consignment-${todayISO()}`}
              sheetName="Consignment"
              title="Consignment stock"
              columns={[
                { header: 'Date', key: 'deposit_date', value: (r) => formatDate(r.deposit_date) },
                { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
                { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
                { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
                { header: 'Quantity', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
                { header: 'UOM', key: 'uom', value: (r) => r.uom || '' },
                { header: 'Status', key: 'status', value: (r) => (r.order_id != null ? 'Booked' : 'In stock') },
                { header: 'Invoice no', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                { header: 'Note', key: 'note', value: (r) => r.note || '' }
              ]}
              rows={deposits}
            />
            <Button size="sm" onClick={openAddDeposit}>
              <Plus className="h-4 w-4" /> Log consignment stock
            </Button>
          </div>
        }
      />

      <div className="space-y-6 px-4 py-5">
        {/* Step 1 of the flow: tankers passed at the gate, waiting for the
            accountant to say whose stock they are. */}
        {pending.length > 0 && (
          <section className="overflow-hidden rounded-xl border-2 border-amber-300 bg-amber-50/40">
            <div className="flex items-center justify-between border-b border-amber-200 bg-amber-100/70 px-5 py-3">
              <div>
                <h3 className="font-medium text-amber-900">Gate arrivals awaiting validation</h3>
                <p className="text-xs text-amber-800">
                  Tankers passed at the gate that aren&apos;t linked to a purchase. Validate one to start maintaining its consignment stock.
                </p>
              </div>
              <Badge variant="warning">{pending.length} pending</Badge>
            </div>
            <Table className="text-[12px] [&_td]:px-4 [&_td]:py-2 [&_th]:h-9 [&_th]:px-4">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Gate no</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Date</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Tanker</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Party</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Type</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900">Net qty</TableHead>
                  <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">Weighment</TableHead>
                  <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((g, i) => {
                  const weighed = g.status === 'completed' && Number(g.received_qty) > 0
                  return (
                    <TableRow key={g.id as number} className={cn('border-b', i % 2 === 1 && 'bg-amber-50/60')}>
                      <TableCell className="font-medium tabular-nums">{g.gate_entry_no}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(g.entry_date)}</TableCell>
                      <TableCell className="font-medium">{g.tanker_no || <span className="italic text-muted-foreground">no number</span>}</TableCell>
                      <TableCell>
                        {g.supplier_name ? (
                          <span className="inline-flex items-center gap-1.5">
                            {g.supplier_name}
                            {Number(g.is_direct_mnc) === 1 && (
                              <Badge className="bg-violet-600 font-normal hover:bg-violet-600">MNC</Badge>
                            )}
                          </span>
                        ) : (
                          <span className="italic text-muted-foreground">to be named</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{g.rec_type || 'OIL'}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-emerald-700">
                        {weighed ? `${formatNum(g.received_qty)} ${g.uom || 'MT'}` : '—'}
                      </TableCell>
                      <TableCell>
                        {weighed ? (
                          <Badge variant="success">Weighed</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting weighment</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => openValidate(g)}>Validate</Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>
        )}

        {/* The stock register: what each supplier is holding at our place, the
            tankers it is made of, and what has already been invoiced. */}
        <section className="overflow-hidden rounded-xl border-2 border-violet-200 bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-200 bg-violet-50 px-5 py-3">
            <div>
              <h3 className="font-medium text-violet-900">Stock</h3>
              <p className="text-xs text-violet-800/80">
                Supplier-owned stock lying at your place, tanker by tanker. Booking a purchase moves it into your books.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {pendingLotCount > 0 && (
                <Badge variant="warning">{pendingLotCount} tanker{pendingLotCount > 1 ? 's' : ''} pending booking</Badge>
              )}
              <Badge className="bg-violet-600 hover:bg-violet-600">{formatNum(totalBalance)} MT in stock</Badge>
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : stockBands.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              No consignment stock yet. Validate a gate arrival above, or use{' '}
              <span className="font-medium">Log consignment stock</span> to enter one.
            </div>
          ) : (
            <div className="divide-y-2 divide-violet-100">
              {stockBands.map((band) => (
                <div key={String(band.supplier_id)}>
                  {/* Party band */}
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 bg-violet-100/60 px-5 py-2">
                    <div className="text-sm font-semibold text-violet-900">{band.supplier_name}</div>
                    <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
                      <span className="text-violet-900/70">
                        In <span className="font-semibold tabular-nums text-violet-900">{formatNum(band.deposited)}</span>
                      </span>
                      <span className="text-violet-900/70">
                        Booked <span className="font-semibold tabular-nums text-violet-900">{formatNum(band.invoiced)}</span>
                      </span>
                      <span className="text-violet-900/70">
                        In stock{' '}
                        <span className="font-bold tabular-nums text-violet-900">
                          {formatNum(band.balance)} {band.uom}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Products of that party, each with its tankers */}
                  {(band.products as Row[]).map((p) => (
                    <div key={`${band.supplier_id}:${p.product_id}`} className="px-5 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <div className="text-[13px] font-medium">{p.product_code || p.product_name}</div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            In <span className="tabular-nums">{formatNum(p.deposited)}</span>
                          </span>
                          <span>
                            Booked <span className="tabular-nums">{formatNum(p.invoiced)}</span>
                          </span>
                          <span
                            className={cn(
                              'font-semibold',
                              Number(p.balance) > 0.0001 ? 'text-emerald-700' : 'text-muted-foreground'
                            )}
                          >
                            In stock <span className="tabular-nums">{formatNum(p.balance)} {p.uom}</span>
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7 text-xs"
                          disabled={Number(p.balance) <= 0.0001}
                          onClick={() => openBooking(p)}
                        >
                          Book purchase
                        </Button>
                      </div>

                      {(p.lots as Row[]).length > 0 && (
                        <Table
                          className="mt-2 text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-8 [&_th]:px-3"
                          wrapperClassName="rounded-lg border"
                        >
                          <TableHeader>
                            <TableRow className="bg-muted/60">
                              <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Date</TableHead>
                              <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Tanker</TableHead>
                              <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Gate no</TableHead>
                              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Weighed</TableHead>
                              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Short %</TableHead>
                              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Qty (net)</TableHead>
                              <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Status</TableHead>
                              <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Note</TableHead>
                              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(p.lots as Row[]).map((d) => {
                              const booked = d.order_id != null
                              return (
                                <TableRow key={d.id as number} className={cn('border-b', !booked && 'bg-emerald-50/40')}>
                                  <TableCell className="whitespace-nowrap">{formatDate(d.deposit_date)}</TableCell>
                                  <TableCell className="font-medium">
                                    {d.tanker_no || (Number(d.is_opening) === 1 ? (
                                      <Badge variant="secondary" className="font-normal">Opening</Badge>
                                    ) : (
                                      <span className="italic text-muted-foreground">no number</span>
                                    ))}
                                  </TableCell>
                                  <TableCell className="tabular-nums text-muted-foreground">
                                    {d.gate_entry_no || '—'}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums text-muted-foreground">
                                    {Number(d.weighed_qty) > 0 ? formatNum(d.weighed_qty) : '—'}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums text-muted-foreground">
                                    {Number(d.shortage_pct) > 0 ? `${d.shortage_pct}%` : '—'}
                                  </TableCell>
                                  <TableCell
                                    className={cn(
                                      'text-right font-semibold tabular-nums',
                                      booked ? 'text-muted-foreground' : 'text-emerald-700'
                                    )}
                                  >
                                    {formatNum(d.qty)} {d.uom}
                                  </TableCell>
                                  <TableCell>
                                    {/* Validation status: a lot is Completed once it has been
                                        validated with a quantity. Whether it has since been
                                        invoiced is shown alongside, not instead. */}
                                    {Number(d.qty) > 0 ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <Badge variant="success">Completed</Badge>
                                        {booked && (
                                          <span className="text-[10px] text-muted-foreground">
                                            {String(d.invoice_no || 'booked')}
                                          </span>
                                        )}
                                      </span>
                                    ) : (
                                      <Badge variant="warning">Pending</Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className="max-w-[200px] truncate text-muted-foreground">
                                    {d.note || '—'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex justify-end gap-1">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        disabled={booked}
                                        title={booked ? 'Booked on a purchase — edit that invoice instead' : 'Edit'}
                                        onClick={() => openEditDeposit(d)}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-destructive"
                                        disabled={booked}
                                        title={booked ? 'Booked on a purchase — delete that invoice first' : 'Delete'}
                                        onClick={() => deleteDeposit(d)}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Deposit intake dialog */}
      <Dialog open={depOpen} onOpenChange={(o) => !o && setDepOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? 'Edit consignment stock'
                : depForm.gate_entry_id
                  ? 'Validate gate arrival'
                  : 'Log consignment stock'}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            {!!depForm.gate_entry_id && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                From gate entry <b>{depForm.gate_entry_no}</b>
                {depForm.tanker_no ? <> · tanker <b>{depForm.tanker_no}</b></> : null}
                {Number(depForm.qty) > 0 ? <> · weighed net <b>{formatNum(depForm.qty)} {depForm.uom}</b></> : <> · <b>not weighed yet</b> — enter the quantity manually</>}
                <div className="mt-0.5 opacity-80">
                  {depForm.supplier_prefilled
                    ? `Party already named at the gate${depForm.supplier_name ? ` — ${depForm.supplier_name}` : ''}. Just pick the oil and save.`
                    : 'Confirm whose stock this is; the quantity starts being maintained once saved.'}
                </div>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1.5">
                Supplier *
                {depForm.supplier_prefilled && (
                  <Badge variant="secondary" className="font-normal">from the gate entry</Badge>
                )}
              </Label>
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
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label className="flex items-center gap-1">
                  Weighed qty
                  <InfoTip text="The gate weighment, before the allowed shortage is deducted." />
                </Label>
                <Input
                  type="number"
                  value={depForm.weighed_qty ?? ''}
                  onChange={(e) =>
                    setDepForm((p) => ({
                      ...p,
                      weighed_qty: e.target.value,
                      qty: netOfShortage(e.target.value, p.shortage_pct)
                    }))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Shortage %</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.2"
                  value={depForm.shortage_pct ?? ''}
                  onChange={(e) =>
                    setDepForm((p) => ({
                      ...p,
                      shortage_pct: e.target.value,
                      qty: netOfShortage(p.weighed_qty, e.target.value)
                    }))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Net qty taken in *</Label>
                <Input
                  type="number"
                  className="font-semibold"
                  value={depForm.qty ?? ''}
                  onChange={(e) => setDepForm((p) => ({ ...p, qty: e.target.value }))}
                />
              </div>
            </div>
            {Number(depForm.weighed_qty) > 0 && Number(depForm.shortage_pct) > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {formatNum(depForm.weighed_qty)} {depForm.uom} weighed − {depForm.shortage_pct}% shortage (
                {formatNum(Number(depForm.weighed_qty) - Number(depForm.qty || 0))} {depForm.uom}) ={' '}
                <b>{formatNum(depForm.qty)} {depForm.uom}</b> taken into stock.
              </p>
            )}
            <div className="grid gap-1.5">
              <Label>Deposit date</Label>
              <DatePicker value={depForm.deposit_date || ''} onChange={(v) => setDepForm((p) => ({ ...p, deposit_date: v }))} />
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
