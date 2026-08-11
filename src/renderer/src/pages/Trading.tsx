import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Inbox, Loader2, Pencil, Plus, Repeat, Search, TrendingDown, TrendingUp, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange } from '@/lib/globalDateRange'
import { computeMoney } from '@/lib/orderCalc'
import { isTradingParty } from '@/lib/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// TDS on one invoice, on the party master's slab — the same tiering the main
// process applies on save. Below the financial year's threshold the base rate
// runs (0 when the master says "no TDS below the slab"); the rest is charged
// at the invoice's own rate.
function tierTds(base: number, prior: number, threshold: number, basePct: number, abovePct: number): number {
  if (!threshold || threshold <= 0) return (base * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, base))
  return (below * basePct) / 100 + ((base - below) * abovePct) / 100
}

// Each invoice on a side is posted in turn, so every one moves the party's
// year-to-date total along and the next one sits further up the slab. Walking
// the lines in the same order is the only way the preview can agree with what
// gets saved. Round off rides on the first invoice, as it does on save.
function slabTdsTotal(
  lines: { qty: number; rate: number }[],
  taxableOf: (l: { qty: number; rate: number }) => number,
  gstPct: number,
  roundOff: number,
  pct: number,
  master: { tds_threshold?: unknown; tds_above_only?: unknown } | undefined,
  priorAtStart: number
): number {
  if (pct <= 0 || !lines.length) return 0
  const threshold = n(master?.tds_threshold)
  const basePct = master?.tds_above_only ? 0 : pct
  let prior = priorAtStart
  let total = 0
  lines.forEach((l, i) => {
    const taxable = taxableOf(l)
    const base = taxable + (taxable * gstPct) / 100 + (i === 0 ? roundOff : 0)
    total += round2(tierTds(base, prior, threshold, basePct, pct))
    prior += taxable
  })
  return round2(total)
}

// Auto-loaded fields get a distinct highlight so it's visible at a glance
// which values came off the party master vs. were typed by hand.
const AUTO_CLASS = 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400'

// The invoice grid used on both sides of a deal: as many numbered rows as
// needed, a + to add another, and a running total under the quantity column.
function InvoiceLines({
  title,
  rows,
  uom,
  totalQty,
  onChange,
  onAdd,
  onRemove
}: {
  title: string
  rows: Row[]
  uom: string
  totalQty: number
  onChange: (i: number, key: string, value: string) => void
  onAdd: () => void
  onRemove: (i: number) => void
}): React.JSX.Element {
  return (
    <div className="rounded border border-[#e5dfc8] bg-[#fdfcf6]">
      <div className="grid grid-cols-[2rem_1fr_7rem_8rem_2rem] items-center gap-2 border-b border-[#e5dfc8] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>#</span>
        <span>{title} invoice no.</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Rate (₹)</span>
        <span />
      </div>
      {rows.map((l, i) => (
        <div key={i} className="grid grid-cols-[2rem_1fr_7rem_8rem_2rem] items-center gap-2 border-b border-dotted border-[#e5dfc8] px-2.5 py-1.5 last:border-0">
          <span className="text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
          <Input
            className="h-8"
            value={String(l.invoice_no ?? '')}
            onChange={(e) => onChange(i, 'invoice_no', e.target.value)}
          />
          <Input
            className="h-8 text-right"
            type="number"
            value={String(l.qty ?? '')}
            onChange={(e) => onChange(i, 'qty', e.target.value)}
          />
          <Input
            className="h-8 text-right"
            type="number"
            value={String(l.rate ?? '')}
            onChange={(e) => onChange(i, 'rate', e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-red-600"
            title="Remove this invoice"
            onClick={() => onRemove(i)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 bg-[#f5f2e4] px-2.5 py-1.5">
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Add invoice
        </Button>
        <span className="text-[11px] font-semibold tabular-nums">
          {rows.length} invoice{rows.length === 1 ? '' : 's'} · {formatNum(totalQty)} {uom}
        </span>
      </div>
    </div>
  )
}

// A labelled figure in the expanded deal's summary strip.
function Fact({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-semibold tabular-nums text-[#1a2c56]">
        {value}
        {hint && <span className="ml-1 text-[11px] font-normal text-muted-foreground">({hint})</span>}
      </div>
    </div>
  )
}

// One side's invoices, shown when a deal row is expanded: every invoice with
// its own qty and rate, and the side's totals underneath.
function DealLineTable({
  heading,
  party,
  lines,
  uom,
  tone
}: {
  heading: string
  party: string
  lines: Row[]
  uom: string
  tone: 'rose' | 'emerald'
}): React.JSX.Element {
  const totalQty = lines.reduce((s, l) => s + n(l.qty), 0)
  const totalValue = lines.reduce((s, l) => s + n(l.qty) * n(l.rate), 0)
  return (
    <div className="overflow-hidden rounded border border-[#d9d2b8] bg-[#fffdf4] shadow-sm">
      <div
        className={cn(
          'flex items-baseline justify-between gap-2 border-b px-3 py-1.5',
          tone === 'rose'
            ? 'border-rose-200 bg-rose-50/80 text-rose-900'
            : 'border-emerald-200 bg-emerald-50/80 text-emerald-900'
        )}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest">{heading}</span>
        <span className="truncate text-[11px] font-semibold">{party}</span>
      </div>
      <table className="w-full border-collapse text-[12px] [&_td]:border-r [&_td]:border-[#e8e2cc] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#e8e2cc] [&_th:last-child]:border-r-0">
        <thead>
          <tr className="border-b border-[#d9d2b8] bg-[#dce6f5] text-[10px] uppercase tracking-widest text-[#1a2c56]">
            <th className="w-8 px-2 py-1 text-left font-bold">#</th>
            <th className="px-2 py-1 text-left font-bold">Invoice no.</th>
            <th className="px-2 py-1 text-right font-bold">Qty</th>
            <th className="px-2 py-1 text-right font-bold">Rate</th>
            <th className="px-2 py-1 text-right font-bold">Value</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">No invoices.</td>
            </tr>
          ) : (
            lines.map((l, i) => (
              <tr key={i} className={cn('border-b border-[#efe9d5] last:border-0', i % 2 === 1 && 'bg-[#faf7ea]')}>
                <td className="px-2 py-1 tabular-nums text-muted-foreground">{i + 1}</td>
                <td className="px-2 py-1 font-medium">{String(l.invoice_no || '—')}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatNum(l.qty)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(l.rate)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(n(l.qty) * n(l.rate))}</td>
              </tr>
            ))
          )}
        </tbody>
        {lines.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-[#1a2c56] bg-[#f0ecd9] font-bold text-[#1a2c56]">
              <td className="px-2 py-1" />
              <td className="px-2 py-1">{lines.length} invoice{lines.length === 1 ? '' : 's'}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatNum(totalQty)} {uom}</td>
              <td className="px-2 py-1" />
              <td className="px-2 py-1 text-right tabular-nums">{formatINR(totalValue)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// Round off sits in the summary next to the total it moves, rather than as a
// field up in the form. It fills itself in to whole rupees; typing over it
// takes control, and emptying it hands control back to the auto value.
function MoneyEditRow({
  label,
  value,
  manual,
  onChange
}: {
  label: string
  value: string
  manual: boolean
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">
        {label} <span className="text-[10px] uppercase tracking-wide">{manual ? '(manual)' : '(auto)'}</span>
      </span>
      <Input
        type="number"
        placeholder="0.00"
        title="Rounds the invoice to whole rupees. Clear it to go back to the automatic value."
        className={cn(
          'h-7 w-28 bg-white text-right text-sm tabular-nums',
          manual && 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400'
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function MoneyRow({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className={strong ? 'font-semibold text-foreground' : muted ? 'text-muted-foreground' : 'text-foreground/80'}>{label}</span>
      <span className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

// One invoice line on either side of a deal. A deal buys across as many
// purchase invoices as it needs and sells across as many sale invoices —
// party, product, GST and TDS are set once and apply to every line.
const blankLine = (): Row => ({ invoice_no: '', qty: '', rate: '' })

const emptyForm = (): Row => ({
  deal_date: todayISO(),
  product_category: 'ALL',
  uom: 'MT',
  purchase_lines: [blankLine()],
  sale_lines: [blankLine()],
  purchase_gst_type: 'CGST_SGST',
  sale_gst_type: 'CGST_SGST',
  purchase_gst_pct: '',
  purchase_tds_pct: '',
  purchase_round_off: '',
  purchase_round_off_manual: false,
  sale_gst_pct: '',
  sale_tds_pct: '',
  sale_round_off: '',
  sale_round_off_manual: false
})

export function Trading(): React.JSX.Element {
  // Alt+F2's period picker filters this list by deal date — deliberately no
  // visible date-range control of its own on this page.
  const globalRange = useGlobalDateRange()
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
  // Deal rows whose invoice breakdown is open. The list stays one row per
  // deal; clicking a row unfolds what it is made of.
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  function toggleExpanded(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
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

  // A pass-through deal is trading business, so only parties marked Trading in
  // the master belong here — the mirror of the Sales/Purchase forms, which
  // list the manufacturing ones. The party a deal already names always stays
  // listed, so an existing deal still opens and edits.
  const dealSuppliers = useMemo(
    () => suppliers.filter((s) => isTradingParty(s) || String(s.id) === String(form.supplier_id || '')),
    [suppliers, form.supplier_id]
  )
  const dealCustomers = useMemo(
    () => customers.filter((c) => isTradingParty(c) || String(c.id) === String(form.customer_id || '')),
    [customers, form.customer_id]
  )

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
    // A deal booked before multi-invoice existed arrives with a single line
    // list all the same — the backend builds it from its one order/sale.
    const toLines = (raw: unknown): Row[] => {
      const arr = Array.isArray(raw) ? (raw as Row[]) : []
      return arr.length
        ? arr.map((l) => ({ invoice_no: l.invoice_no ?? '', qty: l.qty ?? '', rate: l.rate ?? '' }))
        : [blankLine()]
    }
    setForm({
      deal_date: d.deal_date || todayISO(),
      product_id: String(d.product_id || ''),
      // Open on the deal's own category so its product is visible in the list.
      product_category: String(
        products.find((p) => String(p.id) === String(d.product_id))?.material_type || 'ALL'
      ),
      uom: d.purchase_uom || 'MT',
      note: d.note || '',
      supplier_id: String(d.supplier_id || ''),
      purchase_lines: toLines(d.purchase_lines),
      sale_lines: toLines(d.sale_lines),
      purchase_gst_pct: d.purchase_gst_pct ?? '',
      purchase_gst_type: d.purchase_gst_type || 'CGST_SGST',
      purchase_tds_pct: d.purchase_tds_pct ?? '',
      purchase_round_off: d.purchase_round_off ?? '',
      // A non-zero saved round off was a deliberate override — preserve it as
      // manual rather than letting the auto-effect silently recompute it.
      purchase_round_off_manual: !!(d.purchase_round_off && Number(d.purchase_round_off) !== 0),
      customer_id: String(d.customer_id || ''),
      sale_gst_pct: d.sale_gst_pct ?? '',
      sale_tds_pct: d.sale_tds_pct ?? '',
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
    const hasTds = c && Number(c.tds_pct) > 0
    setForm((p) => ({
      ...p,
      customer_id: id,
      sale_gst_pct: hasGst ? c.gst_pct : p.sale_gst_pct,
      sale_tds_pct: hasTds ? c.tds_pct : p.sale_tds_pct
    }))
    setAutoFields((prev) => {
      const next = new Set(prev)
      if (hasGst) next.add('sale_gst_pct')
      if (hasTds) next.add('sale_tds_pct')
      return next
    })
  }

  type Side = 'purchase_lines' | 'sale_lines'
  const lines = (side: Side): Row[] => (Array.isArray(form[side]) ? (form[side] as Row[]) : [])

  function setLine(side: Side, i: number, key: string, value: string): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p[side]) ? (p[side] as Row[]) : [])]
      arr[i] = { ...arr[i], [key]: value }
      return { ...p, [side]: arr }
    })
  }
  function addLine(side: Side): void {
    setForm((p) => ({ ...p, [side]: [...(Array.isArray(p[side]) ? (p[side] as Row[]) : []), blankLine()] }))
  }
  function removeLine(side: Side, i: number): void {
    setForm((p) => {
      const arr = (Array.isArray(p[side]) ? (p[side] as Row[]) : []).filter((_, idx) => idx !== i)
      // Never leave the grid with nothing to type into.
      return { ...p, [side]: arr.length ? arr : [blankLine()] }
    })
  }

  // Only lines with something in them count towards the totals — the blank
  // row waiting at the bottom of the grid is not an invoice yet.
  const priced = (side: Side): { rate: number; qty: number }[] =>
    lines(side)
      .map((l) => ({ rate: n(l.rate), qty: n(l.qty) }))
      .filter((l) => l.qty > 0 && l.rate > 0)

  const purchaseLines = priced('purchase_lines')
  const saleLines = priced('sale_lines')
  const purchaseQty = purchaseLines.reduce((s, l) => s + l.qty, 0)
  const saleQty = saleLines.reduce((s, l) => s + l.qty, 0)
  const qtyDiff = purchaseQty - saleQty
  const qtyMismatch = purchaseQty > 0 && saleQty > 0 && Math.abs(qtyDiff) > 1e-6

  // What each party has already been billed this financial year — the point
  // the slab picks up from. Fetched from the same figures the main process
  // uses, so the preview lands on the saved number.
  const [purchasePrior, setPurchasePrior] = useState(0)
  const [salePrior, setSalePrior] = useState(0)
  useEffect(() => {
    const id = Number(form.supplier_id)
    if (!formPage || !id) { setPurchasePrior(0); return }
    let alive = true
    window.api.orders
      .fyTaxable(id, String(form.deal_date || todayISO()), Number(editingDeal?.order_id || 0))
      .then((v) => { if (alive) setPurchasePrior(n(v)) })
      .catch(() => { if (alive) setPurchasePrior(0) })
    return () => { alive = false }
  }, [formPage, form.supplier_id, form.deal_date, editingDeal])
  useEffect(() => {
    const id = Number(form.customer_id)
    if (!formPage || !id) { setSalePrior(0); return }
    let alive = true
    window.api.sales
      .fyTaxable(id, String(form.deal_date || todayISO()), Number(editingDeal?.sale_id || 0))
      .then((v) => { if (alive) setSalePrior(n(v)) })
      .catch(() => { if (alive) setSalePrior(0) })
    return () => { alive = false }
  }, [formPage, form.customer_id, form.deal_date, editingDeal])

  // The flat product list runs to every active product, so a category narrows
  // it the way the purchase Bargain form does. ALL keeps everything visible.
  const productCats = useMemo(() => {
    const set = new Set(products.map((p) => String(p.material_type || 'OIL')))
    return Array.from(set).sort()
  }, [products])
  const shownProducts = useMemo(() => {
    const cat = String(form.product_category || '')
    return cat && cat !== 'ALL'
      ? products.filter((p) => String(p.material_type || 'OIL') === cat)
      : products
  }, [products, form.product_category])

  const supplierMaster = suppliers.find((s) => String(s.id) === String(form.supplier_id || ''))
  const customerMaster = customers.find((c) => String(c.id) === String(form.customer_id || ''))

  const purchaseCalc = useMemo(
    () =>
      computeMoney({
        orderedQty: purchaseQty,
        // Each invoice is its own order on save, so the taxable value is the
        // sum over the lines — computeMoney's `lines` does exactly that, and
        // the flat rate below only matters when there is a single line.
        invoiceRate: purchaseQty > 0 ? purchaseLines.reduce((s, l) => s + l.qty * l.rate, 0) / purchaseQty : 0,
        bargainRate: 0,
        lines: purchaseLines,
        gstPct: n(form.purchase_gst_pct),
        tdsPct: n(form.purchase_tds_pct),
        addsInterest: false,
        interestPct: 0,
        interestDays: 0,
        roundOff: n(form.purchase_round_off)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(purchaseLines), form.purchase_gst_pct, form.purchase_tds_pct, form.purchase_round_off]
  )

  // Purchase TDS, per invoice on the supplier's slab. computeMoney's own
  // figure is a flat rate over the whole deal, which is not what gets saved.
  const purchaseTds = useMemo(
    () =>
      slabTdsTotal(
        purchaseLines,
        (l) => Math.ceil(l.rate) * l.qty,
        n(form.purchase_gst_pct),
        n(form.purchase_round_off),
        n(form.purchase_tds_pct),
        supplierMaster,
        purchasePrior
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(purchaseLines), form.purchase_gst_pct, form.purchase_round_off, form.purchase_tds_pct, supplierMaster, purchasePrior]
  )
  const purchaseNet = round2(purchaseCalc.roundedTotal - purchaseTds)

  const saleCalc = useMemo(() => {
    const amount = saleLines.reduce((s, l) => s + l.qty * l.rate, 0)
    const gstAmount = (amount * n(form.sale_gst_pct)) / 100
    const roundOff = n(form.sale_round_off)
    const total = amount + gstAmount + roundOff
    // TDS the customer withholds, on the customer's slab and per invoice —
    // the invoice still stands at `total`, only `netReceivable` is collected.
    const tdsAmount = slabTdsTotal(
      saleLines,
      (l) => l.qty * l.rate,
      n(form.sale_gst_pct),
      roundOff,
      n(form.sale_tds_pct),
      customerMaster,
      salePrior
    )
    return {
      amount,
      gstAmount,
      roundOff,
      preRoundTotal: amount + gstAmount,
      total,
      tdsAmount,
      netReceivable: round2(total - tdsAmount)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saleLines), form.sale_gst_pct, form.sale_round_off, form.sale_tds_pct, customerMaster, salePrior])

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
    const inRange = globalRange.version > 0
    return deals.filter((d) => {
      if (inRange) {
        const dd = String(d.deal_date || '').slice(0, 10)
        if (dd < globalRange.from || dd > globalRange.to) return false
      }
      if (!q) return true
      // Every invoice number on the deal is searchable, not just the first.
      const invoiceNos = [
        ...(Array.isArray(d.purchase_lines) ? d.purchase_lines : []),
        ...(Array.isArray(d.sale_lines) ? d.sale_lines : [])
      ].map((l: Row) => l.invoice_no)
      return [d.product_code, d.product_name, d.supplier_name, d.customer_name, ...invoiceNos]
        .some((f) => String(f || '').toLowerCase().includes(q))
    })
  }, [deals, search, globalRange])

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
                  <div className="grid gap-1.5">
                    <Label>Stock category</Label>
                    <Select
                      value={String(form.product_category || 'ALL')}
                      onValueChange={(v) =>
                        // Changing the category drops a product that no longer
                        // belongs to it, rather than leaving a hidden pick.
                        setForm((p) => {
                          const stillValid = products.some(
                            (x) =>
                              String(x.id) === String(p.product_id) &&
                              (v === 'ALL' || String(x.material_type || 'OIL') === v)
                          )
                          return { ...p, product_category: v, product_id: stillValid ? p.product_id : '' }
                        })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        <SelectItem value="ALL">All categories</SelectItem>
                        {productCats.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Product *</Label>
                    <Select value={String(form.product_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {shownProducts.length === 0 ? (
                          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                            No products in this category.
                          </div>
                        ) : (
                          shownProducts.map((p) => (
                            <SelectItem key={String(p.id)} value={String(p.id)}>
                              {p.code || p.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Quantity <span className="text-[10px] font-normal normal-case text-muted-foreground">(from the invoices below)</span></Label>
                    <Input
                      disabled
                      className="bg-muted/50 text-muted-foreground"
                      value={purchaseQty > 0 ? `${formatNum(purchaseQty)} ${form.uom || 'MT'}` : ''}
                    />
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
                        {dealSuppliers.length === 0 ? (
                          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                            No Trading suppliers yet — set a supplier to Trading under Masters → Suppliers.
                          </div>
                        ) : (
                          dealSuppliers.map((s) => <SelectItem key={String(s.id)} value={String(s.id)}>{s.name}</SelectItem>)
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5 md:col-span-3">
                    <Label>Purchase invoices *</Label>
                    <InvoiceLines
                      title="Purchase"
                      rows={lines('purchase_lines')}
                      uom={String(form.uom || 'MT')}
                      totalQty={purchaseQty}
                      onChange={(i, k, v) => setLine('purchase_lines', i, k, v)}
                      onAdd={() => addLine('purchase_lines')}
                      onRemove={(i) => removeLine('purchase_lines', i)}
                    />
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
                        {dealCustomers.length === 0 ? (
                          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                            No Trading customers yet — set a customer to Trading under Masters → Customers.
                          </div>
                        ) : (
                          dealCustomers.map((c) => <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>)
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5 md:col-span-3">
                    <Label>Sale invoices *</Label>
                    <InvoiceLines
                      title="Sale"
                      rows={lines('sale_lines')}
                      uom={String(form.uom || 'MT')}
                      totalQty={saleQty}
                      onChange={(i, k, v) => setLine('sale_lines', i, k, v)}
                      onAdd={() => addLine('sale_lines')}
                      onRemove={(i) => removeLine('sale_lines', i)}
                    />
                    {qtyMismatch && (
                      <p className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                        Sold {formatNum(saleQty)} against {formatNum(purchaseQty)} {form.uom || 'MT'} bought —{' '}
                        <b>{formatNum(Math.abs(qtyDiff))} {form.uom || 'MT'} {qtyDiff > 0 ? 'still unsold' : 'oversold'}</b>. You can
                        save it this way and invoice the rest later.
                      </p>
                    )}
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
                    <Label>TDS % {autoFields.has('sale_tds_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                    <Input
                      type="number"
                      className={autoFields.has('sale_tds_pct') ? AUTO_CLASS : ''}
                      value={form.sale_tds_pct ?? ''}
                      onChange={(e) => setField('sale_tds_pct', e.target.value)}
                    />
                  </div>
                </div>
              </section>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {/* Every row becomes a real invoice, posted one after another so
                  each lands on the right rung of the TDS slab — with a dozen
                  rows that genuinely takes a moment, so say so rather than
                  looking frozen. */}
              <div className="flex flex-wrap items-center justify-end gap-3">
                {saving && (
                  <span className="text-[12px] text-muted-foreground">
                    Posting {purchaseLines.length + saleLines.length} invoice
                    {purchaseLines.length + saleLines.length === 1 ? '' : 's'} — please wait, do not close this window.
                  </span>
                )}
                <Button variant="outline" disabled={saving} onClick={() => { setFormPage(false); setEditingDeal(null) }}>
                  Cancel
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void saveDeal()}
                  className="h-11 min-w-[13rem] gap-2 bg-emerald-600 px-6 text-[15px] font-bold shadow-md hover:bg-emerald-700 disabled:opacity-90"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {editingDeal ? 'Saving changes…' : 'Booking deal…'}
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      {editingDeal ? 'Save changes' : `Book deal (${purchaseLines.length + saleLines.length} invoices)`}
                    </>
                  )}
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
                <MoneyEditRow
                  label="Round off"
                  value={String(form.purchase_round_off ?? '')}
                  manual={!!form.purchase_round_off_manual}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, purchase_round_off: v, purchase_round_off_manual: v !== '' }))
                  }
                />
                <div className="my-2 border-t" />
                <MoneyRow label="Total after round off" value={formatINR(purchaseCalc.roundedTotal)} />
                <MoneyRow label="TDS" value={formatINR(purchaseTds)} muted />
                {!!supplierMaster?.tds_above_only && n(supplierMaster?.tds_threshold) > 0 && (
                  <p className="pb-1 text-[11px] text-muted-foreground">
                    No TDS below ₹{formatNum(supplierMaster.tds_threshold)} a year — {formatINR(purchasePrior)} already
                    billed to this supplier, so the slab applies from there.
                  </p>
                )}
                <div className="my-2 border-t-2 border-[#1a2c56]" />
                <MoneyRow label="Net payable to supplier" value={formatINR(purchaseNet)} strong />
              </div>

              <div className="rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4">
                <h3 className="mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Sale summary</h3>
                <MoneyRow label="Taxable value" value={formatINR(saleCalc.amount)} muted />
                <MoneyRow label="GST" value={formatINR(saleCalc.gstAmount)} muted />
                <MoneyEditRow
                  label="Round off"
                  value={String(form.sale_round_off ?? '')}
                  manual={!!form.sale_round_off_manual}
                  onChange={(v) => setForm((p) => ({ ...p, sale_round_off: v, sale_round_off_manual: v !== '' }))}
                />
                <div className="my-2 border-t-2 border-[#1a2c56]" />
                <MoneyRow label="Sale invoice total" value={formatINR(saleCalc.total)} strong />
                <MoneyRow label="TDS" value={formatINR(saleCalc.tdsAmount)} muted />
                <MoneyRow label="Net receivable from customer" value={formatINR(saleCalc.netReceivable)} strong />
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

      {/* Tally-style register: ruled columns, tight rows, figures right-aligned
          on a cream ledger, and a grand total pinned at the foot. */}
      <div className="overflow-hidden rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : filteredDeals.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {deals.length === 0 ? 'No trading deals booked yet.' : 'No deals match your filters.'}
            </p>
            {deals.length === 0 && (
              <Button size="sm" variant="outline" className="mt-1 gap-1.5" onClick={openNew}>
                <Plus className="h-3.5 w-3.5" /> Book your first deal
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <Table className="[&_td]:border-r [&_td]:border-[#e8e2cc] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#b9c9e4] [&_th:last-child]:border-r-0">
            <TableHeader>
              <TableRow className="bg-[#dce6f5] hover:bg-[#dce6f5]">
                {[
                  { label: 'Date' },
                  { label: 'Product' },
                  { label: 'Qty', right: true },
                  { label: 'Supplier' },
                  { label: 'Purchase (net)', right: true },
                  { label: 'Customer' },
                  { label: 'Sale (total)', right: true },
                  { label: 'Margin', right: true },
                  { label: 'Actions', right: true }
                ].map((h) => (
                  <TableHead
                    key={h.label}
                    className={cn(
                      'h-9 py-0 text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]',
                      h.right && 'text-right'
                    )}
                  >
                    {h.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredDeals.map((d, i) => {
                const open = expanded.has(Number(d.id))
                const pl: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
                const sl: Row[] = Array.isArray(d.sale_lines) ? d.sale_lines : []
                return (
                <React.Fragment key={String(d.id)}>
                <TableRow
                  className={cn(
                    'group cursor-pointer border-b border-[#e8e2cc] transition-colors hover:bg-[#eef4ff]',
                    i % 2 === 1 && 'bg-[#faf7ea]',
                    open && 'bg-[#e8f0ff] hover:bg-[#e8f0ff]'
                  )}
                  onClick={() => toggleExpanded(Number(d.id))}
                >
                  <TableCell className="py-1.5 text-[13px] tabular-nums text-[#1a2c56]">
                    <span className="inline-flex items-center gap-1.5">
                      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      {formatDate(d.deal_date)}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-[13px] font-semibold">{d.product_code || d.product_name}</TableCell>
                  <TableCell className="py-1.5 text-right text-[13px] tabular-nums">
                    {formatNum(d.purchase_qty)} <span className="text-[11px] text-muted-foreground">{d.purchase_uom}</span>
                  </TableCell>
                  {/* Invoice numbers live in the expanded view, not here. */}
                  <TableCell className="py-1.5 text-[13px] font-medium">{d.supplier_name || '—'}</TableCell>
                  <TableCell className="py-1.5 text-right text-[13px] tabular-nums">{formatINR(d.purchase_net)}</TableCell>
                  <TableCell className="py-1.5 text-[13px] font-medium">{d.customer_name || '—'}</TableCell>
                  <TableCell className="py-1.5 text-right text-[13px] tabular-nums">{formatINR(d.sale_net)}</TableCell>
                  <TableCell
                    className={cn(
                      'py-1.5 text-right text-[13px] font-semibold tabular-nums',
                      n(d.margin) < 0 ? 'text-red-700' : 'text-emerald-700'
                    )}
                  >
                    {formatINR(d.margin)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1 opacity-60 group-hover:opacity-100">
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit this deal" onClick={() => openEdit(d)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete this deal" onClick={() => void removeDeal(d)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow className="border-b-2 border-[#d9d2b8] bg-[#f4f7fd] hover:bg-[#f4f7fd] [&>td]:border-r-0">
                    <TableCell colSpan={9} className="p-0">
                      <div className="grid gap-3 border-l-[3px] border-[#1a2c56] px-4 py-3 lg:grid-cols-2">
                        <DealLineTable
                          heading="Purchase invoices"
                          party={String(d.supplier_name || '—')}
                          lines={pl}
                          uom={String(d.purchase_uom || 'MT')}
                          tone="rose"
                        />
                        <DealLineTable
                          heading="Sale invoices"
                          party={String(d.customer_name || '—')}
                          lines={sl}
                          uom={String(d.purchase_uom || 'MT')}
                          tone="emerald"
                        />
                        <div className="grid gap-x-6 gap-y-1 rounded border border-[#d9d2b8] bg-[#fffdf4] px-3 py-2 text-[12px] sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
                          <Fact label="GST (purchase / sale)" value={`${formatNum(d.purchase_gst_pct)}% / ${formatNum(d.sale_gst_pct)}%`} />
                          <Fact
                            label="TDS (purchase / sale)"
                            value={`${formatINR(d.purchase_tds_amount)} / ${formatINR(d.sale_tds_amount)}`}
                            hint={`${formatNum(d.purchase_tds_pct)}% / ${formatNum(d.sale_tds_pct)}%`}
                          />
                          <Fact label="Net payable to supplier" value={formatINR(d.purchase_net)} />
                          <Fact label="Net receivable from customer" value={formatINR(d.sale_net_receivable)} />
                          {(!d.qty_matched || d.note) && (
                            <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2 lg:col-span-4">
                              {!d.qty_matched && (
                                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
                                  {formatNum(Math.abs(n(d.purchase_qty) - n(d.sale_qty)))} {d.purchase_uom}{' '}
                                  {n(d.purchase_qty) > n(d.sale_qty) ? 'still unsold' : 'oversold'}
                                </span>
                              )}
                              {d.note && <span className="text-[11px] text-muted-foreground">Note: {String(d.note)}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </React.Fragment>
                )
              })}
              {/* Grand total across what is actually on screen, the way a
                  Tally register closes off its columns. */}
              {(() => {
                const t = filteredDeals.reduce(
                  (a, d) => ({
                    qty: a.qty + n(d.purchase_qty),
                    purchase: a.purchase + n(d.purchase_net),
                    sale: a.sale + n(d.sale_net),
                    margin: a.margin + n(d.margin)
                  }),
                  { qty: 0, purchase: 0, sale: 0, margin: 0 }
                )
                return (
                  <TableRow className="border-t-2 border-[#1a2c56] bg-[#f0ecd9] font-bold text-[#1a2c56] hover:bg-[#f0ecd9]">
                    <TableCell className="py-2 text-[12px] uppercase tracking-widest">Grand total</TableCell>
                    <TableCell className="py-2 text-[12px] text-muted-foreground">
                      {filteredDeals.length} deal{filteredDeals.length === 1 ? '' : 's'}
                    </TableCell>
                    <TableCell className="py-2 text-right text-[13px] tabular-nums">{formatNum(t.qty)}</TableCell>
                    <TableCell className="py-2" />
                    <TableCell className="py-2 text-right text-[13px] tabular-nums">{formatINR(t.purchase)}</TableCell>
                    <TableCell className="py-2" />
                    <TableCell className="py-2 text-right text-[13px] tabular-nums">{formatINR(t.sale)}</TableCell>
                    <TableCell className={cn('py-2 text-right text-[13px] tabular-nums', t.margin < 0 ? 'text-red-700' : 'text-emerald-700')}>
                      {formatINR(t.margin)}
                    </TableCell>
                    <TableCell className="py-2" />
                  </TableRow>
                )
              })()}
            </TableBody>
          </Table>
          </div>
        )}
      </div>
    </div>
  )
}
