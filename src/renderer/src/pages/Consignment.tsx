import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronRight, Clock, Package, Pencil, Plus, ShoppingCart, Trash2 } from 'lucide-react'
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
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { FyPicker } from '@/components/FyPicker'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The website's dialog shell: forest header band, pale ground, one field
// height throughout, and a footer that is a bar rather than three buttons
// floating on the body. Written once because this page has two dialogs and
// they are the same shape.
const CS_DIALOG =
  '!gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!hidden'
// Editing a lot opens against the right edge rather than over the middle of
// the register, so the row it came from stays where it was. Header and footer
// are pinned; only the fields scroll.
const CS_DRAWER =
  '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[min(100vw,560px)] !max-w-none !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!hidden'
const CS_HEAD = '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left'
const CS_TITLE = '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white'
const CS_BODY =
  '!gap-3.5 !overflow-y-auto !px-5 !py-4 [&_label]:!text-[10.5px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.12em] [&_label]:!text-[#5A6B62] [&_input]:!h-11 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[13.5px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[13.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=date-picker]]:!h-11 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13.5px] [&_[data-slot=date-picker]]:!font-bold'
const CS_FOOT = '!flex-wrap !gap-2.5 !border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5'
const CS_BTN =
  '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !bg-white !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E] hover:!bg-[#EAF0E9]'
const CS_GO =
  '!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]'

function SummaryLine({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between py-1 text-sm', strong && 'font-semibold')}>
      <span className={cn(!strong && 'text-muted-foreground')}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function Consignment(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('consignment')
  const [deposits, setDeposits] = useState<Row[]>([])
  const [pending, setPending] = useState<Row[]>([])
  const [summary, setSummary] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [settings, setSettings] = useState<Row>({})
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCompany, setActiveCompany] = useState<number>(0)
  const [loading, setLoading] = useState(true)

  // Period for the register: opening balance before it, deposits/invoices
  // within it — same convention as Stock's own MNC/Consignment tab.
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const ranged = !!(from || to)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'consignment')) { setFrom(globalRange.from); setTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const [d, sm, pg, s, p, b, cfg, co, act] = await Promise.all([
      window.api.consignment.list(),
      window.api.consignment.summary(ranged ? { from, to } : undefined),
      window.api.consignment.pending(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.bargains.list(undefined, undefined, undefined, 'consignment'),
      window.api.settings.all(),
      window.api.company.list(),
      window.api.company.getActive()
    ])
    setDeposits(d)
    setSummary(sm)
    setPending(pg)
    setSuppliers(s.filter((x) => x.active))
    setProducts(p.filter((x) => x.active && x.category === 'raw'))
    setBargains(b)
    setSettings(cfg)
    setCompanies(co.filter((x) => x.active))
    setActiveCompany(Number(act?.id) || 0)
    setLoading(false)
  }, [ranged, from, to])

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
    setDepForm({
      supplier_id: '',
      product_id: '',
      qty: '',
      uom: defaultUom,
      deposit_date: todayISO(),
      note: '',
      company_id: String(activeCompany || '')
    })
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
      note: g.note || '',
      company_id: String(activeCompany || '')
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
      note: row.note ?? '',
      company_id: String(row.company_id ?? activeCompany ?? '')
    })
    setDepError(null)
    setDepOpen(true)
  }

  async function saveDeposit(): Promise<void> {
    if (!depForm.company_id) return setDepError('Choose which company this stock belongs to')
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
      company_id: Number(depForm.company_id),
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

  async function openBooking(sumRow: Row, presetQty?: unknown): Promise<void> {
    const supplier = suppliers.find((x) => String(x.id) === String(sumRow.supplier_id))
    setBook(sumRow)
    setBookError(null)
    setBookForm({
      bargain_id: '',
      invoice_no: '',
      order_date: todayISO(),
      ordered_qty: presetQty ?? '',
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
      tds_prior: 0,
      company_id: String(activeCompany || '')
    })
  }

  // Shortcut from a single lot's edit dialog: book straight against that lot's
  // supplier + product, defaulting the quantity to what this lot holds.
  function openBookFromLot(row: Row): void {
    const sumRow = summary.find(
      (s) => String(s.supplier_id) === String(row.supplier_id) && String(s.product_id) === String(row.product_id)
    )
    if (!sumRow) {
      toast.error('No consignment balance found for this supplier and product')
      return
    }
    openBooking(sumRow, row.qty)
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
    if (!bookForm.company_id) return setBookError('Choose which company to book this purchase into')
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
        company_id: Number(bookForm.company_id),
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
          .filter((d) => {
            if (String(d.supplier_id) !== String(r.supplier_id) || String(d.product_id) !== String(r.product_id)) return false
            if (!ranged) return true
            const dt = String(d.deposit_date || '').slice(0, 10)
            if (from && dt < from) return false
            if (to && dt > to) return false
            return true
          })
          .sort((a, b) => String(a.deposit_date || '').localeCompare(String(b.deposit_date || '')))
      })
    }
    return Array.from(bands.values()).sort((a, b) =>
      String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''))
    )
  }, [summary, deposits, ranged, from, to])
  const pendingLotCount = deposits.filter((d) => d.order_id == null).length

  // Products folded shut, by party and product. Shut rather than open is what
  // is remembered, so a product that arrives later opens the way every other
  // one does instead of inheriting a state set before it existed — and the
  // register reads exactly as it did before anything is clicked.
  const [shutProducts, setShutProducts] = useState<Set<string>>(() => new Set())
  function toggleProduct(key: string): void {
    setShutProducts((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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

      <div className={cn('space-y-6 px-4 py-5', __WEB__ && '!space-y-3 !px-3 !py-3')}>
        {/* What the page is holding, read off the same arrays everything below
            is drawn from — so a tile can never state something the register
            under it contradicts. */}
        {__WEB__ && !loading && (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                k: ranged ? 'Closing stock' : 'In stock',
                v: formatNum(totalBalance),
                unit: 'MT',
                sub: `${stockBands.length} part${stockBands.length === 1 ? 'y' : 'ies'} holding`,
                accent: '#0B6B45'
              },
              {
                k: 'Awaiting validation',
                v: String(pending.length),
                unit: '',
                sub: 'gate arrivals not yet placed',
                accent: '#C2700A'
              },
              {
                k: 'Pending booking',
                v: String(pendingLotCount),
                unit: '',
                sub: 'lots still off your books',
                accent: '#1B4E82'
              },
              {
                k: 'Booked',
                v: formatNum(stockBands.reduce((t, b) => t + (Number(b.invoiced) || 0), 0)),
                unit: 'MT',
                sub: 'invoiced into your books',
                accent: '#0B3D2E'
              }
            ].map((k) => (
              <div
                key={k.k}
                className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
                style={{ borderTop: `3px solid ${k.accent}` }}
              >
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-[22px] font-bold leading-none tracking-[-0.035em] tabular-nums">{k.v}</span>
                  {k.unit && <span className="text-[10.5px] font-extrabold text-[#5A6B62]">{k.unit}</span>}
                </div>
                <div className="mt-1 truncate text-[11px] font-semibold text-[#5A6B62]" title={k.sub}>{k.sub}</div>
              </div>
            ))}
          </div>
        )}
        {/* Step 1 of the flow: tankers passed at the gate, waiting for the
            accountant to say whose stock they are. */}
        {pending.length > 0 && (
          <section
            className={cn(
              'overflow-hidden rounded-xl border-2 border-amber-300 bg-amber-50/40',
              // The one queue on this page that is asking to be worked, so it
              // keeps a warm edge while everything below it is forest.
              __WEB__ && '!rounded-[4px] !border !border-[#E2A84A] !border-l-4 !border-l-[#E2A84A] !bg-white'
            )}
          >
            <div
              className={cn(
                'flex items-center justify-between border-b border-amber-200 bg-amber-100/70 px-5 py-3',
                __WEB__ && '!gap-3.5 !border-b-0 !bg-[#FDF6E7] !px-[15px] !py-3'
              )}
            >
              <div className={cn(__WEB__ && 'min-w-0')}>
                <h3 className={cn('font-medium text-amber-900', __WEB__ && '!flex !items-center !gap-2 !text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                  {__WEB__ && <Clock className="h-[18px] w-[18px] shrink-0 text-[#8A5300]" />}
                  Gate arrivals awaiting validation
                </h3>
                <p className={cn('text-xs text-amber-800', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#8A5300]')}>
                  Tankers passed at the gate that aren&apos;t linked to a purchase. Validate one to start maintaining its consignment stock.
                </p>
              </div>
              <Badge
                variant="warning"
                className={cn(__WEB__ && '!shrink-0 !rounded-[2px] !border-0 !bg-[#F5E2B8] !px-2.5 !py-[5px] !text-[11px] !font-extrabold !text-[#7A4A00]')}
              >
                {pending.length} pending
              </Badge>
            </div>
            <Table
              className={cn(
                'text-[12px] [&_td]:px-4 [&_td]:py-2 [&_th]:h-9 [&_th]:px-4',
                __WEB__ && '!text-[12.5px] [&_td]:!px-2.5 [&_td]:!py-2.5 [&_th]:!h-[30px] [&_th]:!px-2.5'
              )}
            >
              <TableHeader className={cn(__WEB__ && '!bg-[#EAF0E9]')}>
                <TableRow className={cn(__WEB__ && '!border-t !border-t-[#E4D9BC] !border-b-0 hover:!bg-[#EAF0E9] [&>th]:!bg-[#EAF0E9] [&>th]:!text-[9.5px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.11em] [&>th]:!text-[#33473E]')}>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Gate no</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Date</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Tanker</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Party</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Type</TableHead>
                  <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Net qty</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Weighment</TableHead>
                  <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((g, i) => {
                  const weighed = g.status === 'completed' && Number(g.received_qty) > 0
                  return (
                    <TableRow
                      key={g.id as number}
                      className={cn(
                        'border-b',
                        i % 2 === 1 && 'bg-amber-50/60',
                        __WEB__ && '!border-b-0 !border-t !border-t-[#EAF0E9] !bg-white hover:!bg-[#FFFDF7]'
                      )}
                    >
                      <TableCell className={cn('font-medium tabular-nums', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{g.gate_entry_no}</TableCell>
                      <TableCell className={cn('whitespace-nowrap', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(g.entry_date)}</TableCell>
                      <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !tabular-nums !text-[#0A1F17]')}>{g.tanker_no || <span className="italic text-muted-foreground">no number</span>}</TableCell>
                      <TableCell>
                        {g.supplier_name ? (
                          <span className="inline-flex items-center gap-1.5">
                            {g.supplier_name}
                            {Number(g.is_direct_mnc) === 1 && (
                              <Badge className={cn('bg-violet-600 font-normal hover:bg-violet-600', __WEB__ && '!rounded-[2px] !bg-[#0B3D2E] !px-1.5 !py-[3px] !text-[9.5px] !font-extrabold !tracking-[.05em] !text-[#C7F03F] hover:!bg-[#0B3D2E]')}>MNC</Badge>
                            )}
                          </span>
                        ) : (
                          <span className="italic text-muted-foreground">to be named</span>
                        )}
                      </TableCell>
                      <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>{g.rec_type || 'OIL'}</TableCell>
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
        <section
          className={cn(
            'overflow-hidden rounded-xl border-2 border-violet-200 bg-card',
            // Violet was never a colour this app uses; the register wears the
            // same forest the other four do.
            __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white'
          )}
        >
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 border-b border-violet-200 bg-violet-50 px-5 py-3',
              __WEB__ && '!gap-3.5 !border-b-0 !bg-[#0B3D2E] !px-[15px] !py-3 !text-white'
            )}
          >
            <div className={cn(__WEB__ && 'min-w-0')}>
              <h3 className={cn('font-medium text-violet-900', __WEB__ && '!flex !items-center !gap-2 !text-[14px] !font-extrabold !text-white')}>
                {__WEB__ && <Package className="h-[19px] w-[19px] shrink-0 text-[#C7F03F]" />}
                Stock
              </h3>
              <p className={cn('text-xs text-violet-800/80', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#8FBFA8]')}>
                Supplier-owned stock lying at your place, tanker by tanker. Booking a purchase moves it into your books.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {pendingLotCount > 0 && (
                <Badge
                  variant="warning"
                  className={cn(__WEB__ && '!rounded-[2px] !border-0 !bg-[#FFEDD0] !px-2.5 !py-[5px] !text-[11px] !font-extrabold !text-[#8A5300]')}
                >
                  {pendingLotCount} tanker{pendingLotCount > 1 ? 's' : ''} pending booking
                </Badge>
              )}
              <Badge
                className={cn(
                  'bg-violet-600 hover:bg-violet-600',
                  __WEB__ && '!rounded-[2px] !bg-[#C7F03F]/[.16] !px-2.5 !py-[5px] !text-[11.5px] !font-extrabold !tabular-nums !text-[#C7F03F] hover:!bg-[#C7F03F]/[.16]'
                )}
              >
                {formatNum(totalBalance)} MT {ranged ? 'closing' : 'in stock'}
              </Badge>
            </div>
          </div>
          <div
            className={cn(
              'flex flex-wrap items-center gap-2 border-b border-violet-100 bg-violet-50/40 px-5 py-2',
              __WEB__ &&
                '!gap-2 !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[15px] !py-2.5 [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[12px] [&_[data-slot=date-picker]]:!font-bold [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12px] [&_[data-slot=select-trigger]]:!font-extrabold'
            )}
          >
            {/* w-28 is 112px, and "FY 2026-27" plus the chevron does not fit
                in it — the label was being truncated to "FY 2026…". */}
            <FyPicker
              from={from}
              to={to}
              onRange={(f, t) => { setFrom(f); setTo(t) }}
              className={cn('h-9 w-28 text-xs', __WEB__ && '!w-[136px] !whitespace-nowrap !text-[12px]')}
            />
            <span className="text-[11px] font-semibold text-muted-foreground">From</span>
            <div className="w-40"><DatePicker value={from} onChange={(v) => setFrom(v || '')} max={to || undefined} /></div>
            <span className="text-[11px] font-semibold text-muted-foreground">To</span>
            <div className="w-40"><DatePicker value={to} onChange={(v) => setTo(v || '')} min={from || undefined} /></div>
            {ranged && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setFrom(''); setTo('') }}>
                Clear
              </Button>
            )}
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
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-x-6 gap-y-1 bg-violet-100/60 px-5 py-2',
                      __WEB__ && '!gap-x-4 !border-b !border-b-[#DCE7DB] !bg-[#EFF5EC] !px-[15px] !py-2.5'
                    )}
                  >
                    <div className={cn('text-sm font-semibold text-violet-900', __WEB__ && '!text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                      {band.supplier_name}
                    </div>
                    <div className={cn('ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]', __WEB__ && '!gap-x-4')}>
                      {/* Label above value reads as a caption; label BESIDE it
                          reads as a figure with a name, which is what these
                          three are. */}
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        In <span className={cn('font-semibold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-[#33473E]')}>{formatNum(band.deposited)}</span>
                      </span>
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        Booked <span className={cn('font-semibold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-[#33473E]')}>{formatNum(band.invoiced)}</span>
                      </span>
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        In stock{' '}
                        <span className={cn('font-bold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[14px] !font-bold !normal-case !tracking-[-0.02em] !text-[#0B6B45]')}>
                          {formatNum(band.balance)} {band.uom}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Products of that party, each with its tankers */}
                  {(band.products as Row[]).map((p) => {
                    const pkey = `${band.supplier_id}:${p.product_id}`
                    const shut = __WEB__ && shutProducts.has(pkey)
                    return (
                    <div key={pkey} className={cn('px-5 py-2.5', __WEB__ && '!p-0 [&+div]:!mt-2.5')}>
                      <div
                        className={cn(
                          'flex flex-wrap items-center gap-x-4 gap-y-1',
                          __WEB__ && '!gap-x-3.5 !border-b-0 !bg-[#1A5C46] !px-[15px] !py-2.5 !text-white'
                        )}
                      >
                        {/* The product's own tankers fold away under it. A party
                            can hold four or five products and every one of them
                            listing its lots made the register a page of scrolling
                            before the next party. */}
                        {__WEB__ && (
                          <button
                            type="button"
                            aria-expanded={!shut}
                            onClick={() => toggleProduct(pkey)}
                            title={shut ? 'Show this product’s tankers' : 'Hide this product’s tankers'}
                            className="flex items-center gap-2 rounded-[3px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B3D2E]"
                          >
                            <ChevronRight className={cn('h-4 w-4 shrink-0 text-[#C7F03F] transition-transform', !shut && 'rotate-90')} />
                            <span className="text-[13.5px] font-extrabold text-white">{p.product_code || p.product_name}</span>
                            <span className="text-[11px] font-semibold text-[#8FBFA8]">
                              · {(p.lots as Row[]).length} tanker{(p.lots as Row[]).length === 1 ? '' : 's'}
                            </span>
                          </button>
                        )}
                        {!__WEB__ && <div className="text-[13px] font-medium">{p.product_code || p.product_name}</div>}
                        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground', __WEB__ && '!ml-auto !gap-x-3.5')}>
                          <span className={cn(__WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]')}>
                            In <span className={cn('tabular-nums', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-white')}>{formatNum(p.deposited)}</span>
                          </span>
                          <span className={cn(__WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]')}>
                            Booked <span className={cn('tabular-nums', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-white')}>{formatNum(p.invoiced)}</span>
                          </span>
                          <span
                            className={cn(
                              'font-semibold',
                              Number(p.balance) > 0.0001 ? 'text-emerald-700' : 'text-muted-foreground',
                              __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]'
                            )}
                          >
                            In stock{' '}
                            <span
                              className={cn(
                                'tabular-nums',
                                __WEB__ && '!ml-1 !text-[14px] !font-bold !normal-case !tracking-[-0.02em]',
                                __WEB__ && (Number(p.balance) > 0.0001 ? '!text-[#C7F03F]' : '!text-[#8FBFA8]')
                              )}
                            >
                              {formatNum(p.balance)} {p.uom}
                            </span>
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            'ml-auto h-7 text-xs',
                            __WEB__ && '!ml-0 !h-8 !gap-1.5 !rounded-[3px] !border-0 !bg-[#C7F03F] !px-3.5 !text-[11.5px] !font-extrabold !text-[#12280B] hover:!bg-[#B8E32E] disabled:!bg-white/20 disabled:!text-[#8FBFA8] disabled:!opacity-100'
                          )}
                          disabled={Number(p.balance) <= 0.0001}
                          onClick={() => openBooking(p)}
                        >
                          {__WEB__ && <ShoppingCart className="h-4 w-4" />}
                          Book purchase
                        </Button>
                      </div>

                      {(p.lots as Row[]).length > 0 && !shut && (
                        <Table
                          className={cn(
                            'mt-2 text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-8 [&_th]:px-3',
                            __WEB__ && '!mt-0 !text-[13px] !table-fixed [&_td]:!px-2.5 [&_td]:!py-2.5 [&_th]:!h-[32px] [&_th]:!px-2.5'
                          )}
                          wrapperClassName={cn('rounded-lg border', __WEB__ && '!rounded-none !border-0')}
                        >
                          <TableHeader>
                            <TableRow className={cn('bg-muted/60', __WEB__ && '!border-b-[#DCE7DB] !bg-[#EAF0E9] hover:!bg-[#EAF0E9] [&>th]:!bg-[#EAF0E9] [&>th]:!text-[10.5px] [&>th]:!font-extrabold [&>th]:!tracking-[.11em] [&>th]:!text-[#0A1F17]')}>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Date</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[190px] !whitespace-nowrap !text-[10.5px]')}>Tanker</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Gate no</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Weighed</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[86px] !whitespace-nowrap !text-[10.5px]')}>Short %</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[118px] !whitespace-nowrap !text-[10.5px]')}>Qty (net)</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[120px] !whitespace-nowrap !text-[10.5px]')}>Status</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-auto !whitespace-nowrap !text-[10.5px]')}>Note</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[86px] !whitespace-nowrap !text-[10.5px]')}>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(p.lots as Row[]).map((d) => {
                              const booked = d.order_id != null
                              return (
                                <TableRow
                                  key={d.id as number}
                                  className={cn(
                                    'border-b',
                                    !booked && 'bg-emerald-50/40',
                                    // A mark down the left edge says which lots
                                    // are still the supplier's without reading
                                    // the status column of every line.
                                    __WEB__ && '!border-b-[#F1F5EF] !bg-white hover:!bg-[#F7FAF6]'
                                  )}
                                  style={__WEB__ ? { borderLeft: `3px solid ${booked ? '#C3D2C6' : '#0B6B45'}` } : undefined}
                                >
                                  <TableCell className={cn('whitespace-nowrap', __WEB__ && '!text-[13px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(d.deposit_date)}</TableCell>
                                  <TableCell
                                    className={cn('font-medium', __WEB__ && '!max-w-0 !truncate !text-[13px] !font-bold !tabular-nums !text-[#0A1F17]')}
                                    title={String(d.tanker_no || '')}
                                  >
                                    {d.tanker_no || (Number(d.is_opening) === 1 ? (
                                      <Badge variant="secondary" className="font-normal">Opening</Badge>
                                    ) : (
                                      <span className="italic text-muted-foreground">no number</span>
                                    ))}
                                  </TableCell>
                                  <TableCell className={cn('tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#5A6B62]')}>
                                    {d.gate_entry_no || '—'}
                                  </TableCell>
                                  <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>
                                    {Number(d.weighed_qty) > 0 ? formatNum(d.weighed_qty) : '—'}
                                  </TableCell>
                                  <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>
                                    {Number(d.shortage_pct) > 0 ? `${d.shortage_pct}%` : '—'}
                                  </TableCell>
                                  <TableCell
                                    className={cn(
                                      'text-right font-semibold tabular-nums',
                                      booked ? 'text-muted-foreground' : 'text-emerald-700',
                                      __WEB__ && '!text-[13.5px] !font-bold',
                                      __WEB__ && (booked ? '!text-[#8FA79B]' : '!text-[#0B6B45]')
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
                                  <TableCell className={cn('max-w-[200px] truncate text-muted-foreground', __WEB__ && '!max-w-0 !text-[12.5px] !font-semibold !text-[#5A6B62]')} title={String(d.note || '')}>
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
                            {/* What the lots above come to. The band over them
                                already says it, but a table you have scrolled
                                to the bottom of should not make you scroll back
                                up to find its total. */}
                            {__WEB__ && (
                              <TableRow className="!border-b-[#C3D2C6] !border-t-2 !border-t-[#C7F03F] !bg-[#EFF5EC] hover:!bg-[#EFF5EC]">
                                <TableCell colSpan={3} className="!text-[10.5px] !font-extrabold !uppercase !tracking-[.11em] !text-[#0B3D2E]">
                                  {(p.lots as Row[]).length} tanker{(p.lots as Row[]).length === 1 ? '' : 's'}
                                </TableCell>
                                <TableCell className="!text-right !text-[12.5px] !font-bold !tabular-nums !text-[#33473E]">
                                  {formatNum((p.lots as Row[]).reduce((t, d) => t + (Number(d.weighed_qty) || 0), 0))}
                                </TableCell>
                                <TableCell />
                                <TableCell className="!text-right !text-[13.5px] !font-bold !tabular-nums !tracking-[-0.02em] !text-[#0A1F17]">
                                  {formatNum(p.deposited)} {p.uom}
                                </TableCell>
                                <TableCell colSpan={3} className="!text-[11px] !font-bold !text-[#5A6B62]">
                                  {formatNum(p.balance)} {p.uom} still in stock
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Deposit intake dialog */}
      <Dialog open={depOpen} onOpenChange={(o) => !o && setDepOpen(false)}>
        <DialogContent className={cn(__WEB__ && CS_DRAWER)}>
          <DialogHeader className={cn(__WEB__ && CS_HEAD)}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Consignment stock
              </div>
            )}
            <DialogTitle className={cn(__WEB__ && CS_TITLE)}>
              {editing
                ? 'Edit consignment stock'
                : depForm.gate_entry_id
                  ? 'Validate gate arrival'
                  : 'Log consignment stock'}
            </DialogTitle>
          </DialogHeader>
          <div className={cn('grid gap-4', __WEB__ && CS_BODY)}>
            {!!depForm.gate_entry_id && (
              <div
                className={cn(
                  'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900',
                  __WEB__ && '!rounded-[4px] !border-[#F0D9AE] !border-l-4 !border-l-[#C2700A] !bg-[#FFFBF2] !px-3.5 !py-3 !text-[12px] !font-semibold !leading-relaxed !text-[#8A5300]'
                )}
              >
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
            <div className="flex flex-col gap-1.5">
              <Label>Company *</Label>
              <Select
                value={String(depForm.company_id || '')}
                onValueChange={(v) => setDepForm((p) => ({ ...p, company_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                <SelectContent>
                  {companies.map((cm) => (
                    <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {String(depForm.company_id || '') !== String(activeCompany) && !!depForm.company_id && (
                <span className="text-[11px] font-medium text-amber-700">
                  {editing
                    ? `This stock will move to ${companies.find((cm) => String(cm.id) === String(depForm.company_id))?.name}.`
                    : `This stock will be maintained under ${companies.find((cm) => String(cm.id) === String(depForm.company_id))?.name}, not the company you are viewing now.`}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
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
            {/* The tanker number was carried in from the gate entry and
                saved with the lot, but there was nowhere to correct it — which
                is how a whole invoice reference ends up in a field meant for a
                vehicle number and stays there. saveDeposit already sends it. */}
            <div className="flex flex-col gap-1.5">
              <Label>Tanker no</Label>
              <Input
                value={depForm.tanker_no ?? ''}
                placeholder="Vehicle number"
                onChange={(e) => setDepForm((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Product *</Label>
              <Select value={String(depForm.product_id || '')} onValueChange={(v) => setDepForm((p) => ({ ...p, product_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
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
              <div className="flex flex-col gap-1.5">
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
              <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
              <Label>Deposit date</Label>
              <DatePicker min={minDate} value={depForm.deposit_date || ''} onChange={(v) => setDepForm((p) => ({ ...p, deposit_date: v }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Note</Label>
              <Input value={depForm.note ?? ''} onChange={(e) => setDepForm((p) => ({ ...p, note: e.target.value }))} />
            </div>
            {depError && (
              <p className={cn('text-sm text-destructive', __WEB__ && '!rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-3 !py-2.5 !text-[12.5px] !font-bold !text-[#8C2F26]')}>
                {depError}
              </p>
            )}
          </div>
          <DialogFooter className={cn(__WEB__ && CS_FOOT)}>
            <Button variant="outline" onClick={() => setDepOpen(false)} disabled={savingDep} className={cn(__WEB__ && CS_BTN)}>
              Cancel
            </Button>
            {editing && (
              <Button
                variant="outline"
                onClick={() => { setDepOpen(false); openBookFromLot(editing) }}
                disabled={savingDep}
                className={cn(__WEB__ && cn(CS_BTN, '!text-[#0B6B45]'))}
              >
                Book this stock
              </Button>
            )}
            <Button onClick={saveDeposit} disabled={savingDep} className={cn(__WEB__ && cn(CS_GO, '!ml-auto'))}>
              {__WEB__ && !savingDep && <Check className="h-[18px] w-[18px]" />}
              {savingDep ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Booking dialog */}
      <Dialog open={!!book} onOpenChange={(o) => !o && setBook(null)}>
        <DialogContent
          className={cn(
            'max-h-[90vh] overflow-y-auto sm:max-w-lg',
            __WEB__ && cn(CS_DIALOG, '!grid-rows-[auto_minmax(0,1fr)_auto] !overflow-hidden')
          )}
        >
          <DialogHeader className={cn(__WEB__ && CS_HEAD)}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Consignment stock
              </div>
            )}
            <DialogTitle className={cn('flex items-center gap-1.5', __WEB__ && CS_TITLE)}>
              Book consignment purchase
              <InfoTip text="No transporter, no gate entry and no tanker stages — the goods are already at your place. The invoiced quantity becomes your owned stock and posts to the supplier ledger and journal." />
            </DialogTitle>
          </DialogHeader>
          {book && (
            <div className={cn('grid gap-4', __WEB__ && CS_BODY)}>
              <div
                className={cn(
                  'rounded-md bg-muted px-3 py-2 text-sm',
                  __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3.5 !py-3 !text-[13px] !font-semibold !text-[#33473E]'
                )}
              >
                {book.supplier_name} · {book.product_code || book.product_name} · available{' '}
                <b className={cn(__WEB__ && '!text-[#0B6B45]')}>{formatNum(book.balance)} {book.uom}</b>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Book into company *</Label>
                <Select
                  value={String(bookForm.company_id || '')}
                  onValueChange={(v) => setBookForm((p) => ({ ...p, company_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                  <SelectContent>
                    {companies.map((cm) => (
                      <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {String(bookForm.company_id || '') !== String(activeCompany) && !!bookForm.company_id && (
                  <span className="text-[11px] font-medium text-amber-700">
                    This purchase will be booked into{' '}
                    {companies.find((cm) => String(cm.id) === String(bookForm.company_id))?.name}.
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
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
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice number *</Label>
                  <Input value={bookForm.invoice_no || ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_no: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice date *</Label>
                  <DatePicker value={bookForm.order_date || ''} onChange={(v) => setBookForm((p) => ({ ...p, order_date: v }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity * (max {formatNum(maxBookQty)})</Label>
                  <Input type="number" value={bookForm.ordered_qty || ''} onChange={(e) => setBookForm((p) => ({ ...p, ordered_qty: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice rate *</Label>
                  <Input type="number" value={bookForm.invoice_rate ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_rate: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>GST %</Label>
                  <Input type="number" value={bookForm.gst_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>GST type</Label>
                  <Select value={bookForm.gst_type || 'CGST_SGST'} onValueChange={(v) => setBookForm((p) => ({ ...p, gst_type: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                      <SelectItem value="IGST">IGST</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
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

              <div className="flex flex-col gap-1.5">
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

              {bookError && (
                <p className={cn('text-sm text-destructive', __WEB__ && '!rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-3 !py-2.5 !text-[12.5px] !font-bold !text-[#8C2F26]')}>
                  {bookError}
                </p>
              )}
            </div>
          )}
          <DialogFooter className={cn(__WEB__ && CS_FOOT)}>
            <Button variant="outline" onClick={() => setBook(null)} disabled={savingBook} className={cn(__WEB__ && CS_BTN)}>
              Cancel
            </Button>
            <Button onClick={saveBooking} disabled={savingBook} className={cn(__WEB__ && cn(CS_GO, '!ml-auto'))}>
              {__WEB__ && !savingBook && <ShoppingCart className="h-[18px] w-[18px]" />}
              {savingBook ? 'Booking…' : 'Book purchase'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
