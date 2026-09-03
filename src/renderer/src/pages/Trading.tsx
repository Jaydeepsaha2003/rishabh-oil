import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, CalendarClock, Check, ChevronDown, ChevronRight, FileSpreadsheet, Inbox, Loader2, Pencil, Plus, Repeat, Search, TrendingDown, TrendingUp, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { computeMoney } from '@/lib/orderCalc'
import { isTradingParty } from '@/lib/constants'
import { exportTradingDeals } from '@/lib/tradingExcel'
import { useEntryWindow } from '@/lib/useEntryWindow'

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
// gets saved.
//
// `on` is what the withholding is struck on, and the two sides differ:
//   'total'   — taxable + GST, plus the round off that rides the first invoice.
//               What the purchase side has always used.
//   'taxable' — the goods alone. Every SALE withholds on this: GST is the
//               government's money passing through, so taking a slice of it
//               would withhold tax on tax, and the rupee round-off is a
//               presentation artifact with no business moving the figure.
//               Matches saleTds() in the main process, which is what actually
//               gets saved.
function slabTdsTotal(
  lines: { qty: number; rate: number }[],
  taxableOf: (l: { qty: number; rate: number }) => number,
  gstPct: number,
  roundOff: number,
  pct: number,
  master: { tds_threshold?: unknown; tds_above_only?: unknown } | undefined,
  priorAtStart: number,
  on: 'total' | 'taxable' = 'total'
): number {
  if (pct <= 0 || !lines.length) return 0
  const threshold = n(master?.tds_threshold)
  const basePct = master?.tds_above_only ? 0 : pct
  let prior = priorAtStart
  let total = 0
  lines.forEach((l, i) => {
    const taxable = taxableOf(l)
    const base =
      on === 'taxable' ? taxable : taxable + (taxable * gstPct) / 100 + (i === 0 ? roundOff : 0)
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
          {(() => {
            // Each line of a deal becomes an invoice of its own, so a number
            // used twice down this grid is two documents with one name. Marked
            // on the later line, the one that would have to change.
            const k = String(l.invoice_no ?? '').trim().toUpperCase()
            const dupOf = k
              ? rows.findIndex((o) => String(o.invoice_no ?? '').trim().toUpperCase() === k)
              : -1
            const repeated = dupOf >= 0 && dupOf < i
            return (
              <Input
                className={cn('doc-ref h-8', repeated && 'border-rose-400 focus-visible:ring-rose-300')}
                title={repeated ? `Same number as line ${dupOf + 1} — each line needs its own` : undefined}
                value={String(l.invoice_no ?? '')}
                onChange={(e) => onChange(i, 'invoice_no', e.target.value)}
              />
            )
          })()}
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
        {/* Blue: one more line on THIS grid. The same colour as the column
            headers above it, so it reads as belonging to this table. */}
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1 border border-[#1a2c56]/25 bg-[#dce6f5] text-[11px] font-semibold text-[#1a2c56] shadow-sm hover:bg-[#c6d8f2]"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" /> Add invoice
        </Button>
        <span className="text-[11px] font-semibold tabular-nums">
          {rows.length} invoice{rows.length === 1 ? '' : 's'} · {formatNum(totalQty)} {uom}
        </span>
      </div>
    </div>
  )
}

// The Customer column when a deal was sold on to more than one buyer.
//
// The register keeps one row per deal, so the names cannot all sit in the cell
// — but a bare count tells you nothing about who or for how much. The count is
// a pill that reads as a count rather than a party name, and hovering it gives
// the full split: every buyer, what they took, what they owe, and whether the
// money is in. It replaces a native title attribute holding newline-joined
// names, which had no figures in it and no styling at all.
function BuyersCell({ parties, uom }: { parties: Row[]; uom: string }): React.JSX.Element {
  const totalQty = parties.reduce((a, p) => a + n(p.qty), 0)
  const totalTaxable = parties.reduce((a, p) => a + n(p.taxable), 0)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-[#1a2c56]/20 bg-[#eef4ff] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[#1a2c56] transition-colors hover:border-[#1a2c56]/45 hover:bg-[#dce6f5]">
          <Users className="h-3 w-3 shrink-0" />
          {parties.length} buyers
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-lg px-3 py-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/55">
          Sold on to {parties.length} buyers
        </div>
        <table className="w-full border-collapse text-[11.5px]">
          <tbody>
            {parties.map((p, i) => (
              <tr key={i} className="align-baseline">
                <td className="max-w-[15rem] truncate pr-3 font-semibold">{String(p.customer_name || '—')}</td>
                <td className="whitespace-nowrap pr-3 text-white/55">
                  {n(p.invoice_count)} inv · {formatNum(p.qty)} {uom}
                </td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{formatINR(p.taxable)}</td>
                <td className="whitespace-nowrap text-right">
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide',
                      p.fully_paid ? 'bg-emerald-400/20 text-emerald-300' : 'bg-amber-400/20 text-amber-300'
                    )}
                  >
                    {p.fully_paid ? 'Paid' : 'Due'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-1.5 flex items-baseline justify-between gap-4 border-t border-white/20 pt-1.5 text-[10.5px] text-white/70">
          <span>
            {formatNum(totalQty)} {uom} sold on
          </span>
          <span className="font-semibold tabular-nums text-white">{formatINR(totalTaxable)}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

// What a buyer's TDS was actually struck on.
//
// Two buyers on one deal, same rate, wildly different TDS, and nothing on
// screen saying why — that is the question this answers. The slab is a
// PER-YEAR allowance on the party's master: while it lasts, nothing is
// withheld, and only turnover past it carries the rate. Whether the allowance
// applies at all is its own switch on the master, so a party can carry a slab
// and still be withheld on the full value — which looks like a bug until the
// screen says so out loud.
function tdsBasis(
  taxable: number,
  master: Row | undefined,
  prior: number
): { base: number; slabLeft: number; exempt: boolean; hasSlab: boolean; note: string } {
  const threshold = n(master?.tds_threshold)
  const exempt = !!master?.tds_above_only && threshold > 0
  const slabLeft = exempt ? Math.max(0, round2(threshold - prior)) : 0
  const base = exempt ? Math.max(0, round2(taxable - slabLeft)) : taxable
  const hasSlab = threshold > 0
  let note = ''
  if (exempt && slabLeft > 0.005) {
    note = `first ${formatINR(slabLeft)} of the year exempt, so charged on ${formatINR(base)}`
  } else if (exempt) {
    note = `the ${formatINR(threshold)} yearly slab is already used up, so charged on the whole value`
  } else if (hasSlab) {
    note = `charged on the whole value — this buyer's master does not exempt its ${formatINR(threshold)} slab`
  } else {
    note = 'charged on the whole value — no slab set on this buyer'
  }
  return { base, slabLeft, exempt, hasSlab, note }
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

// One invoice line on either side of a deal: a number, a quantity, a rate.
const blankLine = (): Row => ({ invoice_no: '', qty: '', rate: '' })

// One buyer on the sale side. A deal buys from a single supplier and sells on
// to one buyer or to several, so this side is a list of these — each with its
// own invoices and its own tax treatment.
//
// GST and TDS live on the BUYER, not on the deal, because they belong to the
// party rather than to the trade: an out-of-state buyer is IGST where an
// in-state one is CGST+SGST, and each buyer withholds TDS on its own slab.
// One deal-wide rate would tax somebody wrongly the moment a second buyer
// joined. Round off likewise — it rounds that buyer's own invoice.
const blankParty = (): Row => ({
  customer_id: '',
  lines: [blankLine()],
  gst_pct: '',
  gst_type: 'CGST_SGST',
  tds_pct: '',
  round_off: '',
  round_off_manual: false
})

const emptyForm = (): Row => ({
  deal_date: todayISO(),
  product_category: 'ALL',
  uom: 'MT',
  purchase_lines: [blankLine()],
  sale_parties: [blankParty()],
  purchase_gst_type: 'CGST_SGST',
  purchase_gst_pct: '',
  purchase_tds_pct: '',
  purchase_round_off: '',
  purchase_round_off_manual: false
})

export function Trading(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('trading')
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
  // Every party this deal already names stays listed even if the master has
  // since been flipped off Trading, so an existing deal still opens and edits.
  // With several buyers that is every one of them, not just the first.
  const namedCustomerIds = useMemo(() => {
    const arr = Array.isArray(form.sale_parties) ? (form.sale_parties as Row[]) : []
    return new Set(arr.map((sp) => String(sp?.customer_id || '')).filter(Boolean))
  }, [form.sale_parties])
  const dealCustomers = useMemo(
    () => customers.filter((c) => isTradingParty(c) || namedCustomerIds.has(String(c.id))),
    [customers, namedCustomerIds]
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
    // The sale side comes back grouped by buyer. A deal booked before several
    // buyers were possible has exactly one group, so it opens as one card —
    // and a deal from before multi-invoice has one line inside it. Neither is
    // rewritten to fit; the backend just describes them in today's shape.
    const toParties = (deal: Row): Row[] => {
      const arr = Array.isArray(deal.sale_parties) ? (deal.sale_parties as Row[]) : []
      if (!arr.length) return [blankParty()]
      return arr.map((sp) => ({
        customer_id: String(sp.customer_id || ''),
        lines: toLines(sp.lines),
        gst_pct: sp.gst_pct ?? '',
        gst_type: sp.gst_type || 'CGST_SGST',
        tds_pct: sp.tds_pct ?? '',
        round_off: sp.round_off ?? '',
        round_off_manual: !!(sp.round_off && Number(sp.round_off) !== 0)
      }))
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
      purchase_gst_pct: d.purchase_gst_pct ?? '',
      purchase_gst_type: d.purchase_gst_type || 'CGST_SGST',
      purchase_tds_pct: d.purchase_tds_pct ?? '',
      purchase_round_off: d.purchase_round_off ?? '',
      // A non-zero saved round off was a deliberate override — preserve it as
      // manual rather than letting the auto-effect silently recompute it.
      purchase_round_off_manual: !!(d.purchase_round_off && Number(d.purchase_round_off) !== 0),
      sale_parties: toParties(d)
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

  // ---------------------------------------------------------- the buyer cards
  const parties = (): Row[] => (Array.isArray(form.sale_parties) ? (form.sale_parties as Row[]) : [])

  // Auto-loaded flags are per buyer, so buyer 2's GST coming off its own
  // master does not un-highlight buyer 1's.
  const partyKey = (pi: number, field: string): string => `sale.${pi}.${field}`

  function patchParty(pi: number, patch: Row): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : [])]
      arr[pi] = { ...arr[pi], ...patch }
      return { ...p, sale_parties: arr }
    })
  }

  function setPartyField(pi: number, field: string, value: unknown): void {
    patchParty(pi, { [field]: value })
    setAutoFields((prev) => {
      const k = partyKey(pi, field)
      if (!prev.has(k)) return prev
      const next = new Set(prev)
      next.delete(k)
      return next
    })
  }

  // Same as the Sales Bargain form's customer pick — GST and TDS off the
  // customer master when it carries them, for this buyer alone.
  function chooseCustomer(pi: number, id: string): void {
    const c = customers.find((x) => String(x.id) === id)
    const hasGst = !!c && Number(c.gst_pct) > 0
    const hasTds = !!c && Number(c.tds_pct) > 0
    patchParty(pi, {
      customer_id: id,
      ...(hasGst ? { gst_pct: c?.gst_pct } : {}),
      ...(hasTds ? { tds_pct: c?.tds_pct } : {})
    })
    setAutoFields((prev) => {
      const next = new Set(prev)
      if (hasGst) next.add(partyKey(pi, 'gst_pct'))
      if (hasTds) next.add(partyKey(pi, 'tds_pct'))
      return next
    })
  }

  function addParty(): void {
    setForm((p) => ({
      ...p,
      sale_parties: [...(Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : []), blankParty()]
    }))
  }

  function removeParty(pi: number): void {
    setForm((p) => {
      const arr = (Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : []).filter((_, i) => i !== pi)
      // Never leave the sale side with no buyer to type into.
      return { ...p, sale_parties: arr.length ? arr : [blankParty()] }
    })
    // The flags are keyed by position, so dropping a card would otherwise
    // leave the one after it wearing the removed card's highlight. Only the
    // sale side's flags go — the purchase side has not moved.
    setAutoFields((prev) => new Set(Array.from(prev).filter((k) => !k.startsWith('sale.'))))
  }

  function setPartyLine(pi: number, i: number, key: string, value: string): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : [])]
      const ls = [...(Array.isArray(arr[pi]?.lines) ? (arr[pi].lines as Row[]) : [])]
      ls[i] = { ...ls[i], [key]: value }
      arr[pi] = { ...arr[pi], lines: ls }
      return { ...p, sale_parties: arr }
    })
  }
  function addPartyLine(pi: number): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : [])]
      arr[pi] = {
        ...arr[pi],
        lines: [...(Array.isArray(arr[pi]?.lines) ? (arr[pi].lines as Row[]) : []), blankLine()]
      }
      return { ...p, sale_parties: arr }
    })
  }
  function removePartyLine(pi: number, i: number): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p.sale_parties) ? (p.sale_parties as Row[]) : [])]
      const ls = (Array.isArray(arr[pi]?.lines) ? (arr[pi].lines as Row[]) : []).filter((_, idx) => idx !== i)
      arr[pi] = { ...arr[pi], lines: ls.length ? ls : [blankLine()] }
      return { ...p, sale_parties: arr }
    })
  }

  // The purchase side is still one grid under one supplier. The sale side is
  // one grid per buyer and has its own helpers below.
  type Side = 'purchase_lines'
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
  const purchaseQty = purchaseLines.reduce((s, l) => s + l.qty, 0)

  // Each buyer's own priced lines, and the sale side as a whole. Same rule as
  // above: the blank row at the bottom of a grid is not an invoice yet.
  const partyLines = useMemo(
    () =>
      parties().map((sp) =>
        (Array.isArray(sp?.lines) ? (sp.lines as Row[]) : [])
          .map((l) => ({ rate: n(l.rate), qty: n(l.qty) }))
          .filter((l) => l.qty > 0 && l.rate > 0)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(form.sale_parties)]
  )
  const saleLines = partyLines.flat()
  const saleQty = saleLines.reduce((s, l) => s + l.qty, 0)
  const qtyDiff = purchaseQty - saleQty
  const qtyMismatch = purchaseQty > 0 && saleQty > 0 && Math.abs(qtyDiff) > 1e-6

  // What each party has already been billed this financial year — the point
  // the slab picks up from. Fetched from the same figures the main process
  // uses, so the preview lands on the saved number.
  const [purchasePrior, setPurchasePrior] = useState(0)
  const [salePriors, setSalePriors] = useState<Record<string, number>>({})
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
  // One prior per buyer, keyed by customer id — each party's slab starts from
  // its OWN year to date, so a deal split five ways needs five of these.
  useEffect(() => {
    if (!formPage) { setSalePriors({}); return }
    const ids = Array.from(
      new Set(parties().map((sp) => Number(sp?.customer_id)).filter((x) => x > 0))
    )
    if (!ids.length) { setSalePriors({}); return }
    let alive = true
    const date = String(form.deal_date || todayISO())
    // Editing: the deal's own already-saved invoice to this buyer must not
    // count towards the buyer's prior, or re-saving would walk the slab up.
    const ownSaleFor = (cid: number): number => {
      const sp = (Array.isArray(editingDeal?.sale_parties) ? (editingDeal?.sale_parties as Row[]) : []).find(
        (x) => Number(x?.customer_id) === cid
      )
      const first = (Array.isArray(sp?.lines) ? (sp?.lines as Row[]) : [])[0]
      return Number(first?.sale_id || 0)
    }
    void Promise.all(
      ids.map((id) =>
        window.api.sales
          .fyTaxable(id, date, ownSaleFor(id))
          .then((v) => [id, n(v)] as const)
          .catch(() => [id, 0] as const)
      )
    ).then((pairs) => {
      if (!alive) return
      const next: Record<string, number> = {}
      for (const [id, v] of pairs) next[String(id)] = v
      setSalePriors(next)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, JSON.stringify(parties().map((sp) => sp?.customer_id)), form.deal_date, editingDeal])

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

  // One set of figures per buyer. Each buyer is invoiced separately, so each
  // gets its own GST, its own round off and its own TDS on its own slab —
  // adding them up afterwards is what the deal earned, but the arithmetic
  // cannot be done on the total or a party would be taxed at another's rate.
  const partyCalcs = useMemo(
    () =>
      parties().map((sp, pi) => {
        const ls = partyLines[pi] ?? []
        const master = customers.find((c) => String(c.id) === String(sp?.customer_id || ''))
        const gstPct = n(sp?.gst_pct)
        const amount = ls.reduce((a, l) => a + l.qty * l.rate, 0)
        const gstAmount = (amount * gstPct) / 100
        const roundOff = n(sp?.round_off)
        const total = amount + gstAmount + roundOff
        const tdsAmount = slabTdsTotal(
          ls,
          (l) => l.qty * l.rate,
          gstPct,
          roundOff,
          n(sp?.tds_pct),
          master,
          n(salePriors[String(sp?.customer_id || '')]),
          'taxable'
        )
        return {
          qty: ls.reduce((a, l) => a + l.qty, 0),
          invoiceCount: ls.length,
          master,
          amount,
          gstAmount,
          roundOff,
          preRoundTotal: amount + gstAmount,
          total,
          tdsAmount,
          netReceivable: round2(total - tdsAmount)
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(form.sale_parties), JSON.stringify(partyLines), customers, JSON.stringify(salePriors)]
  )

  const saleCalc = useMemo(() => {
    const sum = (pick: (c: (typeof partyCalcs)[number]) => number): number =>
      round2(partyCalcs.reduce((a, c) => a + pick(c), 0))
    return {
      amount: sum((c) => c.amount),
      gstAmount: sum((c) => c.gstAmount),
      roundOff: sum((c) => c.roundOff),
      preRoundTotal: sum((c) => c.preRoundTotal),
      total: sum((c) => c.total),
      tdsAmount: sum((c) => c.tdsAmount),
      netReceivable: sum((c) => c.netReceivable)
    }
  }, [partyCalcs])

  // Margin is the profit on the trade itself — struck on taxable value on
  // both sides, not the tax-inclusive totals (GST is a pass-through, round-off
  // a rupee-rounding artifact — neither is part of what was actually earned).
  const margin = round2(saleCalc.amount - purchaseCalc.taxableValue)
  const marginPct = purchaseCalc.taxableValue > 0 ? round2((margin / purchaseCalc.taxableValue) * 100) : 0

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

  // The same auto round-off, once per buyer — each buyer's own invoice is what
  // rounds to whole rupees. Written back in a single pass so N buyers do not
  // mean N renders.
  useEffect(() => {
    if (!formPage) return
    const ps = parties()
    const wanted = ps.map((sp, pi) => {
      if (sp?.round_off_manual) return null
      const total = partyCalcs[pi]?.preRoundTotal ?? 0
      if (!Number.isFinite(total) || total <= 0) return null
      const auto = Math.round(total) - total
      return Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    })
    if (!wanted.some((w, pi) => w !== null && String(ps[pi]?.round_off ?? '') !== w)) return
    setForm((prev) => {
      const arr = [...(Array.isArray(prev.sale_parties) ? (prev.sale_parties as Row[]) : [])]
      wanted.forEach((w, pi) => {
        if (w === null || !arr[pi]) return
        if (String(arr[pi].round_off ?? '') !== w) arr[pi] = { ...arr[pi], round_off: w }
      })
      return { ...prev, sale_parties: arr }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, JSON.stringify(partyCalcs.map((c) => c.preRoundTotal)), JSON.stringify(form.sale_parties)])

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

  const filteredDeals = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inRange = globalRangeAppliesTo(globalRange, 'trading')
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
      // Every buyer on the deal is searchable, not only the first — a deal
      // split five ways should be findable by any of the five.
      const buyers = Array.isArray(d.customer_names) ? d.customer_names : [d.customer_name]
      return [d.product_code, d.product_name, d.supplier_name, ...buyers, ...invoiceNos]
        .some((f) => String(f || '').toLowerCase().includes(q))
    })
  }, [deals, search, globalRange])

  // Summary cards mirror the filtered list, not the full unfiltered set — so
  // "Total deals" never shows a count higher than what's actually listed
  // below it once a date range or search is narrowing the view.
  // Both sides on TAXABLE value, because that is what a trade is judged on.
  //
  // Purchase showed the net payable (taxable + GST − TDS) and Sale the
  // tax-inclusive total, while Margin was struck on taxable — so the three
  // figures never reconciled. On the current book they read as a Rs 5,28,213
  // profit sitting beside a Rs 5,73,120 loss. GST is a pass-through (input
  // credit against output liability) and TDS is a withholding, not a cost;
  // neither belongs in what the trade earned. Now Sale − Purchase IS the
  // margin, to the paisa.
  const totalMargin = filteredDeals.reduce((s, d) => s + n(d.margin), 0)
  const totalPurchase = filteredDeals.reduce((s, d) => s + n(d.purchase_taxable), 0)
  const totalSale = filteredDeals.reduce((s, d) => s + n(d.sale_amount), 0)

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
                  <div className="flex flex-col gap-1.5">
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
                  <div className="flex flex-col gap-1.5">
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
                  <div className="flex flex-col gap-1.5">
                    <Label>Quantity <span className="text-[10px] font-normal normal-case text-muted-foreground">(from the invoices below)</span></Label>
                    <Input
                      disabled
                      className="bg-muted/50 text-muted-foreground"
                      value={purchaseQty > 0 ? `${formatNum(purchaseQty)} ${form.uom || 'MT'}` : ''}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>UOM</Label>
                    <Select value={form.uom || 'MT'} onValueChange={(v) => setForm((p) => ({ ...p, uom: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MT">MT</SelectItem>
                        <SelectItem value="KG">KG</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Deal date</Label>
                    <DatePicker min={minDate} value={String(form.deal_date || '')} onChange={(v) => setForm((p) => ({ ...p, deal_date: v }))} />
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-3">
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
                  <div className="flex flex-col gap-1.5 md:col-span-2">
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
                  <div className="flex flex-col gap-1.5 md:col-span-3">
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
                  <div className="flex flex-col gap-1.5">
                    <Label>GST % {autoFields.has('purchase_gst_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                    <Input
                      type="number"
                      className={autoFields.has('purchase_gst_pct') ? AUTO_CLASS : ''}
                      value={form.purchase_gst_pct ?? ''}
                      onChange={(e) => setField('purchase_gst_pct', e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.purchase_gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, purchase_gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
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
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Sale (out)
                  </h3>
                  <span className="text-[11px] text-muted-foreground">
                    {parties().length === 1
                      ? 'One buyer — add another to split this purchase between several'
                      : `${parties().length} buyers · ${formatNum(saleQty)} ${form.uom || 'MT'} sold on in ${saleLines.length} invoice${saleLines.length === 1 ? '' : 's'}`}
                  </span>
                </div>

                {/* One card per buyer. The goods came in on one purchase and go
                    out to whoever takes them, so each buyer gets its own
                    invoices AND its own tax treatment — a buyer in another
                    state is IGST where one in this state is CGST+SGST, and
                    each withholds TDS on its own slab. */}
                <div className="space-y-3">
                  {parties().map((sp, pi) => {
                    const c = partyCalcs[pi]
                    const name = customers.find((x) => String(x.id) === String(sp?.customer_id || ''))?.name
                    // The same buyer twice is two half-lists of one party's
                    // invoices; marked on the later card, the one to change.
                    const dupOf = sp?.customer_id
                      ? parties().findIndex((o) => String(o?.customer_id || '') === String(sp.customer_id))
                      : -1
                    const repeated = dupOf >= 0 && dupOf < pi
                    return (
                      <div
                        key={pi}
                        className={cn(
                          'rounded border bg-[#fffdf7] shadow-sm',
                          repeated ? 'border-rose-400' : 'border-[#d9d2b8]'
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2 rounded-t border-b border-emerald-200 bg-emerald-50/80 px-3 py-1.5">
                          <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
                            Buyer {pi + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-emerald-900">
                            {name || 'no customer picked yet'}
                          </span>
                          {c && c.invoiceCount > 0 && (
                            <span className="shrink-0 text-[11px] font-medium tabular-nums text-emerald-800">
                              {c.invoiceCount} invoice{c.invoiceCount === 1 ? '' : 's'} · {formatNum(c.qty)}{' '}
                              {form.uom || 'MT'} · {formatINR(c.amount)}
                            </span>
                          )}
                          {parties().length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-600"
                              title="Remove this buyer and all of its invoices"
                              onClick={() => removeParty(pi)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>

                        <div className="grid gap-4 p-3 md:grid-cols-3">
                          <div className="flex flex-col gap-1.5 md:col-span-3">
                            <Label>Customer *</Label>
                            <Select
                              value={String(sp?.customer_id || '')}
                              onValueChange={(v) => chooseCustomer(pi, v)}
                            >
                              <SelectTrigger className={repeated ? 'border-rose-400 focus-visible:ring-rose-300' : ''}>
                                <SelectValue placeholder="Select customer" />
                              </SelectTrigger>
                              <SelectContent className="max-h-64">
                                {dealCustomers.length === 0 ? (
                                  <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                                    No Trading customers yet — set a customer to Trading under Masters → Customers.
                                  </div>
                                ) : (
                                  dealCustomers.map((cu) => (
                                    <SelectItem key={String(cu.id)} value={String(cu.id)}>
                                      {cu.name}
                                    </SelectItem>
                                  ))
                                )}
                              </SelectContent>
                            </Select>
                            {repeated && (
                              <p className="text-[11px] text-rose-700">
                                Already listed as buyer {dupOf + 1} — put all of that buyer&rsquo;s invoices under
                                the one card, or the party&rsquo;s TDS slab is split in two.
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col gap-1.5 md:col-span-3">
                            <Label>Sale invoices *</Label>
                            <InvoiceLines
                              title="Sale"
                              rows={Array.isArray(sp?.lines) ? (sp.lines as Row[]) : []}
                              uom={String(form.uom || 'MT')}
                              totalQty={c?.qty ?? 0}
                              onChange={(i, k, v) => setPartyLine(pi, i, k, v)}
                              onAdd={() => addPartyLine(pi)}
                              onRemove={(i) => removePartyLine(pi, i)}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>
                              GST %{' '}
                              {autoFields.has(partyKey(pi, 'gst_pct')) && (
                                <span className="text-amber-700">(auto)</span>
                              )}
                            </Label>
                            <Input
                              type="number"
                              className={autoFields.has(partyKey(pi, 'gst_pct')) ? AUTO_CLASS : ''}
                              value={sp?.gst_pct ?? ''}
                              onChange={(e) => setPartyField(pi, 'gst_pct', e.target.value)}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>GST type</Label>
                            <Select
                              value={sp?.gst_type || 'CGST_SGST'}
                              onValueChange={(v) => patchParty(pi, { gst_type: v })}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                                <SelectItem value="IGST">IGST</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>
                              TDS %{' '}
                              {autoFields.has(partyKey(pi, 'tds_pct')) && (
                                <span className="text-amber-700">(auto)</span>
                              )}
                            </Label>
                            <Input
                              type="number"
                              className={autoFields.has(partyKey(pi, 'tds_pct')) ? AUTO_CLASS : ''}
                              value={sp?.tds_pct ?? ''}
                              onChange={(e) => setPartyField(pi, 'tds_pct', e.target.value)}
                            />
                          </div>
                        </div>

                        {/* This buyer's own invoice, totalled where it is
                            entered — so the figure is checked against the
                            document in hand, not against a deal-wide total
                            that belongs to nobody. */}
                        {!!c && c.invoiceCount > 0 && (
                          <div className="grid gap-x-4 gap-y-1.5 rounded-b border-t border-[#e5dfc8] bg-[#f7f2e2] px-3 py-2 sm:grid-cols-3 lg:grid-cols-5">
                            <Fact label="Taxable" value={formatINR(c.amount)} />
                            <Fact label={`GST ${formatNum(sp?.gst_pct)}%`} value={formatINR(c.gstAmount)} />
                            <div className="min-w-0">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Round off {sp?.round_off_manual ? '(manual)' : '(auto)'}
                              </div>
                              <Input
                                type="number"
                                placeholder="0.00"
                                title="Rounds this buyer's invoice to whole rupees. Clear it to go back to the automatic value."
                                className={cn(
                                  'mt-0.5 h-7 w-24 bg-white text-right text-[13px] tabular-nums',
                                  sp?.round_off_manual && 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400'
                                )}
                                value={String(sp?.round_off ?? '')}
                                onChange={(e) =>
                                  patchParty(pi, { round_off: e.target.value, round_off_manual: e.target.value !== '' })
                                }
                              />
                            </div>
                            <Fact label="Invoice total" value={formatINR(c.total)} />
                            <Fact
                              label="Net receivable"
                              value={formatINR(c.netReceivable)}
                              hint={c.tdsAmount > 0.005 ? `TDS ${formatINR(c.tdsAmount)}` : undefined}
                            />
                            {n(sp?.tds_pct) > 0 && (() => {
                              const b = tdsBasis(c.amount, c.master, n(salePriors[String(sp?.customer_id || '')]))
                              return (
                                <p
                                  className={cn(
                                    'sm:col-span-3 lg:col-span-5 text-[11px] leading-snug',
                                    b.hasSlab && !b.exempt ? 'text-amber-800' : 'text-muted-foreground'
                                  )}
                                >
                                  <b>TDS {formatNum(sp?.tds_pct)}%</b> on {formatINR(b.base)} ={' '}
                                  <b>{formatINR(c.tdsAmount)}</b> — {b.note}.
                                  {b.exempt && (
                                    <>
                                      {' '}
                                      {formatINR(n(salePriors[String(sp?.customer_id || '')]))} already billed to this
                                      buyer this year.
                                    </>
                                  )}
                                </p>
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  {/* Green, and heavier than Add invoice: this one adds a
                      whole party — its own invoices, its own GST and its own
                      TDS slab — so it should not look like one more row. Green
                      to match the buyer cards it creates. */}
                  <Button
                    type="button"
                    size="sm"
                    className="h-9 gap-1.5 bg-emerald-600 px-4 text-[12px] font-bold text-white shadow-md hover:bg-emerald-700"
                    onClick={addParty}
                  >
                    <Plus className="h-4 w-4" /> Add another buyer
                  </Button>
                  {parties().length > 1 && (
                    <span className="text-[11px] text-muted-foreground">
                      Each buyer is invoiced separately, with its own GST, TDS and round off.
                    </span>
                  )}
                </div>

                {qtyMismatch && (
                  <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                    Sold {formatNum(saleQty)} on{parties().length > 1 ? ` across ${parties().length} buyers` : ''} against{' '}
                    {formatNum(purchaseQty)} {form.uom || 'MT'} bought —{' '}
                    <b>{formatNum(Math.abs(qtyDiff))} {form.uom || 'MT'} {qtyDiff > 0 ? 'still unsold' : 'oversold'}</b>. You can
                    save it this way and invoice the rest later.
                  </p>
                )}
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
                <h3 className="mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Sale summary
                </h3>
                {/* With several buyers the roll-up alone hides who owes what,
                    so each buyer's net is listed above it. Round off is edited
                    on the buyer's own card, beside the invoice it rounds —
                    there is no single deal-wide figure to put here. */}
                {/* One card per buyer, and the NAME gets a line to itself.
                    Sharing a line with the amount left a 360px column trying to
                    fit "FARMWICK COMMODITIES (P) LTD (1 inv · 500)" and a rupee
                    figure at once, so the name was cut off mid-word and the
                    invoice count with it — the two things a reader most needs
                    from this block. The count, quantity and tax sit on a second
                    line where there is room, with the money right-aligned so
                    the figures stack into a column that adds up by eye. */}
                {partyCalcs.length > 1 && (
                  <div className="mb-2.5 space-y-1.5 border-b border-dotted border-[#d9d2b8] pb-2.5">
                    <div className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      <span>Per buyer</span>
                      <span>Net receivable</span>
                    </div>
                    {partyCalcs.map((c, pi) => {
                      const sp = parties()[pi]
                      const name = customers.find((x) => String(x.id) === String(sp?.customer_id || ''))?.name
                      return (
                        <div key={pi} className="rounded border border-[#e5dfc8] bg-white px-2 py-1.5">
                          <div
                            className="truncate text-[11.5px] font-semibold leading-tight text-[#1a2c56]"
                            title={name || undefined}
                          >
                            {name || `Buyer ${pi + 1}`}
                          </div>
                          <div className="mt-1 flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                              {c.invoiceCount} inv · {formatNum(c.qty)} {form.uom || 'MT'}
                              {n(sp?.gst_pct) > 0 && ` · GST ${formatNum(sp?.gst_pct)}%`}
                              {/* The slab is named right beside the figure it
                                  changes: two buyers at the same rate can owe
                                  very different TDS, and this is the reason. */}
                              {c.tdsAmount > 0.005 &&
                                (() => {
                                  const b = tdsBasis(
                                    c.amount,
                                    c.master,
                                    n(salePriors[String(sp?.customer_id || '')])
                                  )
                                  const tag = b.exempt && b.slabLeft > 0.005 ? 'after slab' : 'full value'
                                  return ` · TDS ${formatINR(c.tdsAmount)} (${tag})`
                                })()}
                            </span>
                            <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-[#1a2c56]">
                              {formatINR(c.netReceivable)}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                <MoneyRow label="Taxable value" value={formatINR(saleCalc.amount)} muted />
                <MoneyRow label="GST" value={formatINR(saleCalc.gstAmount)} muted />
                <MoneyRow label="Round off" value={formatINR(saleCalc.roundOff)} muted />
                <div className="my-2 border-t-2 border-[#1a2c56]" />
                <MoneyRow
                  label={partyCalcs.length > 1 ? `Sale invoice total (${partyCalcs.length} buyers)` : 'Sale invoice total'}
                  value={formatINR(saleCalc.total)}
                  strong
                />
                <MoneyRow label="TDS (on taxable value)" value={formatINR(saleCalc.tdsAmount)} muted />
                <MoneyRow
                  label={partyCalcs.length > 1 ? 'Net receivable from buyers' : 'Net receivable from customer'}
                  value={formatINR(saleCalc.netReceivable)}
                  strong
                />
              </div>

              <div className="rounded border border-[#1a2c56]/30 bg-white p-4">
                <MoneyRow label="Deal margin (sale − purchase, on taxable value)" value={formatINR(margin)} strong />
                <MoneyRow label="Margin %" value={`${marginPct.toFixed(2)}%`} muted />
              </div>
            </aside>
          </div>
        </div>
      </div>
    )
  }

  return (
    // No h-full and no scroller of its own. The app's <main> already scrolls,
    // and nesting a second one inside it meant the page scrolled in a box:
    // the outer scrollbar never appeared and the inner one sat inside the
    // padding where it is easy to miss. p-4 to match every other register,
    // which also gives the table back the width p-6 was taking.
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title="Purchase & Sales Trading"
        hint="No bargain, no tanker movement, no stock entries, no interest — the purchase and sale book straight through in one step, same as ticking 'Trading' inside Purchases/Sales, just from one dedicated screen with full GST/TDS/round-off control. One deal buys from a single supplier across as many purchase invoices as it needs, and sells on to ONE OR SEVERAL buyers — each buyer with its own invoices, its own GST type, its own TDS slab and its own round off, because those belong to the party and not to the trade. GST/TDS auto-load from the supplier/customer master (highlighted amber) and can be overridden. Deleting a deal removes every purchase and sale invoice on it."
        actions={
          <>
            {globalRangeAppliesTo(globalRange, 'trading') && (
              <span
                className="flex items-center gap-1.5 rounded-full border border-[#d9d2b8] bg-[#fffdf4] px-3 py-1.5 text-[11px] font-medium text-[#1a2c56]"
                title={globalRange.scope === 'page' ? 'Set with Alt+F2 — applied to this page only' : 'Set with Alt+F2 — applies across every page'}
              >
                <CalendarClock className="h-3.5 w-3.5" />
                {formatDate(globalRange.from)} → {formatDate(globalRange.to)}
              </span>
            )}
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={filteredDeals.length === 0}
              onClick={() =>
                void exportTradingDeals(
                  filteredDeals,
                  `trading-deals-${globalRangeAppliesTo(globalRange, 'trading') ? `${globalRange.from}-to-${globalRange.to}` : todayISO()}`
                )
              }
            >
              <FileSpreadsheet className="h-4 w-4" /> Download Excel
            </Button>
            <Button className="gap-1.5" onClick={openNew}>
              <Plus className="h-4 w-4" /> New trading deal
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="flex items-center gap-3 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-700">
            <Repeat className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total deals</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{filteredDeals.length}</div>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total purchase (taxable)</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatINR(totalPurchase)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total sale (taxable)</div>
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
          on a cream ledger, and a grand total pinned at the foot.
          -mx-4 breaks it out of the page padding so the register runs the full
          width of the screen — fifteen money columns need every pixel, and the
          side gaps bought nothing. The header and search above keep their
          margin; only the table goes edge to edge, so the rounding and the
          left/right border go with it. */}
      <div className="-mx-4 overflow-hidden border-y border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
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
                  { label: 'Purchase (taxable)', right: true },
                  { label: 'Customer' },
                  { label: 'Sale (taxable)', right: true },
                  { label: 'Margin', right: true },
                  { label: 'Margin %', right: true },
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
                // The sale side grouped by buyer. Empty only for a deal with
                // no sale invoices at all, in which case the flat list stands
                // in and the view reads exactly as it always did.
                const sp: Row[] = Array.isArray(d.sale_parties) ? d.sale_parties : []
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
                  <TableCell
                    className="py-1.5 text-right text-[13px] tabular-nums"
                    title={`Taxable ${formatINR(d.purchase_taxable)} + GST ${formatINR(d.purchase_gst_amount)} − TDS ${formatINR(d.purchase_tds_amount)} = ${formatINR(d.purchase_net)} payable to the supplier`}
                  >
                    {formatINR(d.purchase_taxable)}
                  </TableCell>
                  {/* One buyer reads as its name. Several read as a count pill
                      with the whole split on hover — see BuyersCell. */}
                  <TableCell className="py-1.5 text-[13px] font-medium">
                    {n(d.customer_count) > 1 ? (
                      <BuyersCell parties={sp} uom={String(d.purchase_uom || 'MT')} />
                    ) : (
                      d.customer_name || '—'
                    )}
                  </TableCell>
                  <TableCell
                    className="py-1.5 text-right text-[13px] tabular-nums"
                    title={`Taxable ${formatINR(d.sale_amount)} + GST ${formatINR(d.sale_gst_amount)} = ${formatINR(d.sale_net)} invoiced to the customer`}
                  >
                    {formatINR(d.sale_amount)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'py-1.5 text-right text-[13px] font-semibold tabular-nums',
                      n(d.margin) < 0 ? 'text-red-700' : 'text-emerald-700'
                    )}
                  >
                    {formatINR(d.margin)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'py-1.5 text-right text-[13px] tabular-nums',
                      n(d.margin_pct) < 0 ? 'text-red-700' : 'text-emerald-700'
                    )}
                  >
                    {n(d.margin_pct).toFixed(2)}%
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
                    <TableCell colSpan={10} className="p-0">
                      <div className="grid gap-3 border-l-[3px] border-[#1a2c56] px-4 py-3 lg:grid-cols-2">
                        <DealLineTable
                          heading="Purchase invoices"
                          party={String(d.supplier_name || '—')}
                          lines={pl}
                          uom={String(d.purchase_uom || 'MT')}
                          tone="rose"
                        />
                        {/* One table per buyer. Stacked in the sale column so
                            a deal split five ways reads as five invoices to
                            five parties, each with its own tax and its own
                            money still to come in — not as one merged block
                            that nobody can be chased for. */}
                        <div className="space-y-3">
                          {(sp.length ? sp : [{ customer_name: d.customer_name, lines: sl }]).map((party: Row, pi: number) => (
                            <div key={pi}>
                              <DealLineTable
                                heading={sp.length > 1 ? `Sale invoices — buyer ${pi + 1}` : 'Sale invoices'}
                                party={String(party.customer_name || '—')}
                                lines={Array.isArray(party.lines) ? party.lines : []}
                                uom={String(d.purchase_uom || 'MT')}
                                tone="emerald"
                              />
                              {sp.length > 1 && (
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px] text-muted-foreground">
                                  <span>GST {formatNum(party.gst_pct)}%</span>
                                  <span>·</span>
                                  <span>TDS {formatINR(party.tds_amount)}</span>
                                  <span>·</span>
                                  <span className="font-semibold text-[#1a2c56]">
                                    Net {formatINR(party.net_receivable)}
                                  </span>
                                  <span
                                    className={cn(
                                      'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                      party.fully_paid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                                    )}
                                  >
                                    {party.fully_paid
                                      ? 'Paid'
                                      : `Outstanding ${formatINR(Math.max(0, n(party.net_receivable) - n(party.paid)))}`}
                                  </span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="grid gap-x-6 gap-y-1 rounded border border-[#d9d2b8] bg-[#fffdf4] px-3 py-2 text-[12px] sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
                          <Fact
                            label="GST (purchase / sale)"
                            value={`${formatNum(d.purchase_gst_pct)}% / ${sp.length > 1 ? 'per buyer' : `${formatNum(d.sale_gst_pct)}%`}`}
                          />
                          <Fact
                            label="TDS (purchase / sale)"
                            value={`${formatINR(d.purchase_tds_amount)} / ${formatINR(d.sale_tds_amount)}`}
                            hint={`${formatNum(d.purchase_tds_pct)}% / ${sp.length > 1 ? 'per buyer' : `${formatNum(d.sale_tds_pct)}%`}`}
                          />
                          <Fact label="Net payable to supplier" value={formatINR(d.purchase_net)} />
                          <Fact
                            label={sp.length > 1 ? `Net receivable (${sp.length} buyers)` : 'Net receivable from customer'}
                            value={formatINR(d.sale_net_receivable)}
                          />
                          {!!d.lc_id && (
                            <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2 lg:col-span-4">
                              <span className="text-[11px] font-semibold text-[#1a2c56]">LC {d.lc_no || `#${d.lc_id}`}</span>
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                  d.lc_bank_repaid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                                )}
                              >
                                {d.lc_bank_repaid ? 'Bank repaid' : 'Bank outstanding'}
                              </span>
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                  d.sale_fully_paid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                                )}
                              >
                                {d.sale_fully_paid
                                  ? 'Sale paid'
                                  : `Sale outstanding ${formatINR(Math.max(0, n(d.sale_net_receivable) - n(d.sale_paid)))}`}
                              </span>
                              {d.trading_lc_closed && (
                                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800">
                                  LC closed
                                </span>
                              )}
                            </div>
                          )}
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
                    purchase: a.purchase + n(d.purchase_taxable),
                    sale: a.sale + n(d.sale_amount),
                    margin: a.margin + n(d.margin),
                    purchaseTaxable: a.purchaseTaxable + n(d.purchase_taxable)
                  }),
                  { qty: 0, purchase: 0, sale: 0, margin: 0, purchaseTaxable: 0 }
                )
                // The blended rate across every deal on screen — not an
                // average of each deal's own %, which would misweight a small
                // deal's percentage as heavily as a large one's.
                const marginPct = t.purchaseTaxable > 0 ? (t.margin / t.purchaseTaxable) * 100 : 0
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
                    <TableCell className={cn('py-2 text-right text-[13px] tabular-nums', marginPct < 0 ? 'text-red-700' : 'text-emerald-700')}>
                      {marginPct.toFixed(2)}%
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
