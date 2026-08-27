import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Eye, EyeOff, Layers, Plus, SlidersHorizontal, TrendingDown, TrendingUp, Trash2, Upload, X } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatDateShort, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { downloadDayCloseExcel, parseDayCloseExcel } from '@/lib/dayCloseExcel'
import { downloadSkuCountExcel, parseSkuCountExcel } from '@/lib/skuCountExcel'
import { ExcelButton } from '@/components/ExcelButton'
import { NUM_QTY, exportRowsToExcel, type ExcelColumn } from '@/lib/excel'
import { FyPicker } from '@/components/FyPicker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A figure on the register with its workings behind it. The register showed a
// number per SKU per day and nothing about how it got there -- a despatch of
// 34,000 was unarguable and unexplainable at the same time -- so hovering the
// number now says which parties took it, or which entries built it.
//
// The dashed underline is the only hint of it, so the table stays a table.
function CellWithWorkings({
  value,
  className,
  title,
  lines,
  footer,
  extra
}: {
  value: string
  className?: string
  title: string
  lines: { left: string; mid?: string; right: string }[]
  footer?: string
  // A block below the footer, for anything that is more than one more line —
  // the negative-since panel builds its own rows.
  extra?: React.ReactNode
}): React.JSX.Element {
  if (!lines.length && !extra) return <span className={className}>{value}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'cursor-help underline decoration-dotted decoration-slate-400 underline-offset-4',
            className
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/60">{title}</div>
        <div className="space-y-0.5">
          {lines.slice(0, 12).map((l, i) => (
            <div key={i} className="flex items-baseline gap-2 whitespace-nowrap text-[11px]">
              <span className="shrink-0 text-white/60">{l.left}</span>
              {l.mid && <span className="min-w-0 truncate">{l.mid}</span>}
              <span className="ml-auto shrink-0 font-semibold tabular-nums">{l.right}</span>
            </div>
          ))}
          {lines.length > 12 && <div className="text-[10px] text-white/50">… {lines.length - 12} more</div>}
        </div>
        {footer && <div className="mt-1 border-t border-white/20 pt-1 text-[10px] text-white/70">{footer}</div>}
        {extra}
      </TooltipContent>
    </Tooltip>
  )
}

// Whole days between two ISO dates.
function daysApart(from: string, to: string): number {
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00`)
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / 86400000))
}

// How a packed SKU is counted. The register stores and shows PIECES (pouches,
// jars, tins); a case holds `pouches_per_box` of them, which is 1 for a SKU sold
// by the tin and 40 for a pouch case -- so the two are the same number for most
// SKUs and wildly different for a few, which is exactly how the mix-up hid.
function perCase(row: Row | null): number {
  const v = Number(row?.pouches_per_box)
  return Number.isFinite(v) && v > 0 ? v : 1
}

function caseLabel(row: Row | null): string {
  return String(row?.box_label || 'Case')
}

function pieceLabel(row: Row | null): string {
  return String(row?.pouch_label || 'Piece')
}

// Step an ISO date by whole days, for the day-wise registers' arrows.
function shiftDate(iso: string, days: number): string {
  const s = String(iso || '').slice(0, 10)
  const d = new Date(`${s || new Date().toISOString().slice(0, 10)}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}


// Every export is stamped to the minute, so two downloads of the same register
// taken an hour apart never overwrite each other in the Downloads folder.
function nowStamp(): string {
  const d = new Date()
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
}

// The two movement registers share one column set: a line per document, with
// the vehicle, the bill and both weights.
// Whose books the line belongs to. Only worth a column when more than one
// company is in the download — on a single-company export it would be the same
// value on every row.
const COMPANY_COLUMN: ExcelColumn = {
  header: 'Company', key: 'company', width: 22, value: (r) => r.company || ''
}

const REGISTER_COLUMNS: ExcelColumn[] = [
  { header: 'Loading date', key: 'loaded_date', width: 14, value: (r) => (r.loaded_date ? formatDate(r.loaded_date) : '') },
  { header: 'Receiving date', key: 'received_date', width: 14, value: (r) => (r.received_date ? formatDate(r.received_date) : '') },
  {
    header: 'Party name', key: 'party', width: 28, divider: true,
    // A return is the same party with the goods going the other way, so it is
    // labelled rather than left looking like an ordinary movement.
    value: (r) => (Number(r.is_return) === 1 ? `${r.party || ''} — return` : r.party || '')
  },
  { header: 'Transporter', key: 'transporter', width: 26, value: (r) => r.transporter || '' },
  { header: 'Bill no', key: 'bill_no', width: 18, value: (r) => r.bill_no || '' },
  { header: 'Vehicle no', key: 'vehicle_no', width: 16, value: (r) => r.vehicle_no || '' },
  { header: 'Oil type', key: 'oil_type', width: 18, divider: true, value: (r) => r.oil_type || '' },
  {
    header: 'Dispatch qty', key: 'dispatch_qty', width: 14, align: 'right', numFmt: NUM_QTY, total: 'sum',
    // Returns come through negative, so the column total is the net movement —
    // the same figure the Book Stock register shows.
    fillFor: (r) => (Number(r.is_return) === 1 ? 'FFEAF0FB' : undefined),
    value: (r) => Number(r.dispatch_qty) || 0
  },
  { header: 'Received qty', key: 'received_qty', width: 14, align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.received_qty) || 0 },
  {
    header: 'Shortage', key: 'shortage', width: 12, align: 'right', numFmt: NUM_QTY, total: 'sum',
    // Only meaningful once both weights exist; a blank received qty would
    // otherwise read as the whole load having gone missing.
    fillFor: (r) => (r.received_qty != null && Number(r.dispatch_qty) - Number(r.received_qty) > 0.0005 ? 'FFFFD9D9' : undefined),
    value: (r) => (r.received_qty == null ? 0 : Math.round((Number(r.dispatch_qty) - Number(r.received_qty)) * 1000) / 1000)
  }
]

// The receipt register carries one column the dispatch side has no equivalent
// for: how much of the shortage the supplier actually wears. Computed in the
// backend by the same EX/tolerance rule the purchase screens use.
const DEDUCTIBLE_COLUMN: ExcelColumn = {
  header: 'Deductible', key: 'deductible', width: 13, align: 'right', numFmt: NUM_QTY, total: 'sum',
  fillFor: (r) => (r.deductible != null ? 'FFFFD9D9' : undefined),
  value: (r) => Number(r.deductible) || 0
}

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// Products' material Category (OIL / HUSK / SPENT EARTH / ...) is stored
// upper-case; shown title-case here purely for readability.
const titleCase = (s: string): string => s.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase())

// Pack size → MT per piece. Litres are treated 1 L ≈ 1 KG (the mill's despatch
// reports total 15 Ltr and 15 Kg SKUs into one MT figure the same way).
function packSizeMT(size: number, uom: string): number {
  const u = String(uom || 'KG').toUpperCase()
  const kg =
    u === 'GM' || u === 'G' || u === 'ML'
      ? size / 1000
      : u === 'QUINTAL'
        ? size * 100
        : u === 'MT' || u === 'TON' || u === 'KL'
          ? size * 1000
          : size // KG or L
  return kg / 1000
}

// Compact, colour-coded stat tile used across the Stock tabs.
const STAT_TONES: Record<string, string> = {
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  rose: 'border-rose-200 bg-rose-50 text-rose-800',
  sky: 'border-sky-200 bg-sky-50 text-sky-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-900',
  violet: 'border-violet-200 bg-violet-50 text-violet-800'
}
function MiniStat({
  label,
  value,
  hint,
  tone = 'slate'
}: {
  label: string
  value: string
  // What the unfiltered register comes to, shown only while the figure above
  // is a subtotal — so narrowing to one product never hides the mill total.
  hint?: string
  tone?: string
}): React.JSX.Element {
  return (
    <div className={cn('rounded-lg border px-3 py-2', STAT_TONES[tone] || STAT_TONES.slate)}>
      <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] tabular-nums opacity-60">{hint}</div>}
    </div>
  )
}

// A number cell that reveals a party-wise breakdown on hover.
function PartyCell({ value, parties, uom, tone }: { value: number; parties: Row[]; uom?: string; tone?: string }): React.JSX.Element {
  const cell = <span className="tabular-nums">{formatNum(value)}</span>
  const cls = cn('text-right tabular-nums', tone || 'text-emerald-700')
  if (!parties || parties.length === 0) {
    return <TableCell className={cls}>{value ? cell : '—'}</TableCell>
  }
  const hasReturn = parties.some((p) => p.isReturn)
  return (
    <TableCell className={cls}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'cursor-default underline decoration-dotted underline-offset-4',
              hasReturn ? 'decoration-rose-400 decoration-2' : 'decoration-muted-foreground/50'
            )}
          >
            {cell}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <div className="space-y-0.5">
            {parties.map((p, i) => (
              <div key={i} className={cn('flex justify-between gap-4', p.isReturn && 'opacity-90')}>
                <span className={cn(p.isReturn && 'italic')}>{p.party}</span>
                <span className={cn('tabular-nums font-medium', Number(p.qty) < 0 && 'text-rose-300')}>
                  {Number(p.qty) < 0 ? '−' : ''}{formatNum(Math.abs(Number(p.qty) || 0))} {uom || 'MT'}
                </span>
              </div>
            ))}
            {/* The cell is net of any returns, so the lines have to add up to
                it — otherwise the hover looks like it contradicts the column. */}
            {parties.some((p) => p.isReturn) && (
              <div className="mt-1 flex justify-between gap-4 border-t border-white/25 pt-1 font-semibold">
                <span>Net</span>
                <span className="tabular-nums">
                  {formatNum(parties.reduce((t, p) => t + (Number(p.qty) || 0), 0))} {uom || 'MT'}
                </span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TableCell>
  )
}

// One company, several, or all — the book registers aggregate whatever is
// picked. An empty selection means the active company, so the default view is
// unchanged.
function CompanyPicker({
  companies,
  value,
  onChange,
  activeId
}: {
  companies: Row[]
  value: number[]
  onChange: (ids: number[]) => void
  activeId: number
}): React.JSX.Element {
  // Same grammar as the Tanker Movement filter: one dropdown offering the
  // active company, every company together, or any single company.
  const all = companies.length > 1 && companies.every((c) => value.includes(Number(c.id)))
  const current = value.length === 0 ? 'active' : all ? 'all' : value.length === 1 ? String(value[0]) : 'all'
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        if (v === 'active') onChange([])
        else if (v === 'all') onChange(companies.map((c) => Number(c.id)))
        else onChange([Number(v)])
      }}
      showCheckbox
    >
      <SelectTrigger className="h-9 w-[13rem] text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="active">
          Active company
          {companies.find((c) => Number(c.id) === activeId)?.name
            ? ` — ${companies.find((c) => Number(c.id) === activeId)?.name}`
            : ''}
        </SelectItem>
        <SelectItem value="all">All companies</SelectItem>
        {companies.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function StockTable({ rows: allRows, breakdown, label = 'stock', range, onRange, companyPicker, companySplit = {}, stagePicker, companyIds = [] }: { rows: Row[]; breakdown: Record<number, { receipt: Row[]; dispatch: Row[] }>; label?: string; range: { from: string; to: string }; onRange: (r: { from: string; to: string }) => void; companyPicker?: React.ReactNode; companySplit?: Record<number, Row[]>; stagePicker?: React.ReactNode; companyIds?: number[] }): React.JSX.Element {
  const ranged = !!(range.from || range.to)
  // A product with no opening, no movement and no closing balance is just noise
  // in a long list, so it can be folded away. Everything below — KPIs, section
  // counts, the grid and the Excel export — reads the filtered set, so what is
  // downloaded is always what is on screen.
  const [hideIdle, setHideIdle] = useState(false)
  const FLOW_KEYS = ['opening', 'received', 'produced', 'transferred_in', 'transferred_out', 'consumed', 'sold', 'stock']
  const isIdle = useCallback(
    (r: Row): boolean => FLOW_KEYS.every((k) => Math.abs(Number(r[k]) || 0) < 1e-9),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const idleCount = useMemo(() => allRows.filter(isIdle).length, [allRows, isIdle])
  const rows = useMemo(() => (hideIdle ? allRows.filter((r) => !isIdle(r)) : allRows), [allRows, hideIdle, isIdle])
  const sum = (k: string): number => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const totals = {
    opening: sum('opening'),
    received: sum('received'),
    produced: sum('produced'),
    transferred_in: sum('transferred_in'),
    transferred_out: sum('transferred_out'),
    consumed: sum('consumed'),
    sold: sum('sold'),
    stock: sum('stock')
  }
  const negatives = rows.filter((r) => Number(r.stock) < -1e-9).length
  const inFlow = totals.received + totals.produced + totals.transferred_in
  const outFlow = totals.consumed + totals.sold + totals.transferred_out
  // Cluster products by their material Category (OIL / HUSK / PACKAGING /
  // CHEMICAL / ...) so a long product list reads as sections instead of one
  // flat wall of rows. Order follows first appearance, which is already
  // category, name from the backend query.
  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, Row[]>()
    for (const r of rows) {
      const g = String(r.material_type || '').trim().toUpperCase() || 'UNCATEGORIZED'
      if (!byGroup.has(g)) {
        byGroup.set(g, [])
        order.push(g)
      }
      byGroup.get(g)!.push(r)
    }
    return order.map((g) => ({ label: g, rows: byGroup.get(g)! }))
  }, [rows])
  // Excel rows: a line per product, then a line per party underneath it —
  // exactly what the hover shows — with the parties on outline level 1 so each
  // product collapses in Excel.
  // Shared by the two-level export (product + party lines) and the flat
  // product-only one, so the two can never drift apart.
  const flowColumns: ExcelColumn[] = [
    { header: 'Product', key: 'name', width: 26, value: (r) => r.name || '' },
    ...(ranged
      ? [{
          header: 'Opening', key: 'opening', align: 'right' as const, numFmt: NUM_QTY,
          total: 'sum' as const, divider: true, value: (r: Row) => Number(r.opening) || 0
        }]
      : []),
    { header: 'Receipt', key: 'received', align: 'right', numFmt: NUM_QTY, total: 'sum', divider: !ranged, value: (r) => Number(r.received) || 0 },
    { header: 'Produced', key: 'produced', align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.produced) || 0 },
    { header: 'Transfer in', key: 'transferred_in', align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.transferred_in) || 0 },
    { header: 'Transfer out', key: 'transferred_out', align: 'right', numFmt: NUM_QTY, total: 'sum', divider: true, value: (r) => Number(r.transferred_out) || 0 },
    { header: 'Consumed', key: 'consumed', align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.consumed) || 0 },
    { header: 'Dispatch', key: 'sold', align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.sold) || 0 },
    {
      header: ranged ? 'Closing' : 'In stock', key: 'stock', align: 'right', numFmt: NUM_QTY,
      total: 'sum', divider: true,
      headerFill: 'FF14532D',
      fillFor: (r) => (Number(r.stock) < -0.0005 ? 'FFFFD9D9' : 'FFEAF5EC'),
      value: (r) => Number(r.stock) || 0
    }
  ]

  // Three things can be taken off this screen, so the download button opens a
  // menu rather than assuming which one was wanted: what came in, what went
  // out, and the product-level flow summary this page already shows.
  const [dlOpen, setDlOpen] = useState(false)
  const [dlBusy, setDlBusy] = useState('')
  const periodLabel = ranged
    ? `${formatDate(range.from || '')} to ${formatDate(range.to || todayISO())}`
    : `as on ${formatDate(todayISO())}`
  const periodSlug = ranged ? `${range.from || 'start'}-to-${range.to || todayISO()}` : todayISO()

  async function downloadMovement(kind: 'receipt' | 'dispatch'): Promise<void> {
    setDlBusy(kind)
    try {
      const regs = await window.api.stock.registers(companyIds, ranged ? range : undefined)
      // An empty selection means the active company only, so that is one book.
      const multiCompany = companyIds.length > 1
      const data = kind === 'receipt' ? regs.receipts : regs.dispatches
      if (!data.length) {
        toast.error(`No ${kind}s in this period`)
        return
      }
      const name = kind === 'receipt' ? 'Receipt' : 'Dispatch'
      await exportRowsToExcel({
        filename: `${kind}-register-${periodSlug}-${nowStamp()}`,
        sheetName: `${name} register`,
        title: `${name} register`,
        subtitle:
          `${data.length} ${kind}${data.length === 1 ? '' : 's'} · quantities in MT · ${periodLabel}` +
          (kind === 'dispatch'
            ? ' · credit-note returns included as negative lines, so the total is the net dispatch'
            : ' · debit-note returns included as negative lines') +
          ` · generated ${formatDate(todayISO())}`,
        freezeCols: 2,
        totalLabel: 'TOTAL',
        columns: (() => {
          const base = [...REGISTER_COLUMNS]
          // Right after Bill no, as asked — so the company reads next to the
          // document it belongs to.
          if (multiCompany) base.splice(base.findIndex((c) => c.key === 'bill_no') + 1, 0, COMPANY_COLUMN)
          return kind === 'receipt' ? [...base, DEDUCTIBLE_COLUMN] : base
        })(),
        rows: data
      })
      toast.success(`Exported ${data.length} ${kind} row${data.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDlBusy('')
      setDlOpen(false)
    }
  }

  // The flow register: one line per product, or the same thing with each
  // product's parties opened up underneath it.
  async function downloadFlow(withParties: boolean): Promise<void> {
    setDlBusy(withParties ? 'flowparty' : 'flow')
    try {
      await exportRowsToExcel({
        filename: `${label}-stock-${withParties ? 'by-party' : 'flow'}-${periodSlug}-${nowStamp()}`,
        sheetName: `${label} stock`,
        title: `${label.charAt(0).toUpperCase()}${label.slice(1)} stock ${withParties ? 'by party' : 'flow'}`,
        subtitle:
          `${rows.length} product${rows.length === 1 ? '' : 's'} · quantities in MT · ${periodLabel}` +
          ` · generated ${formatDate(todayISO())}`,
        freezeCols: 1,
        totalLabel: 'GRAND TOTAL',
        columns: withParties
          ? [
              flowColumns[0],
              { header: 'Party', key: 'party', width: 24, value: (r: Row) => r.party || '' },
              { header: 'Flow', key: 'flow', width: 12, value: (r: Row) => r.flow || '' },
              ...flowColumns.slice(1)
            ]
          : flowColumns,
        rows: withParties ? sheetRows : rows,
        isGroup: withParties ? (r) => !!r.is_group : undefined,
        outlineDetail: withParties
      })
      toast.success(`Exported ${rows.length} product row${rows.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDlBusy('')
      setDlOpen(false)
    }
  }

  const sheetRows = rows.flatMap((r) => {
    const bd = breakdown[r.id as number]
    const split = companySplit[r.id as number] || []
    const kids = [
      // Company rows first: whose books hold how much of this product.
      ...split.map((x) => ({
        party: String(x.company),
        flow: 'Company',
        opening: x.opening,
        received: x.received,
        produced: x.produced,
        transferred_in: x.transferred_in,
        transferred_out: x.transferred_out,
        consumed: x.consumed,
        sold: x.sold,
        stock: x.stock
      })),
      ...(bd?.receipt || []).map((x) => ({ party: x.party, flow: 'Receipt', received: x.qty })),
      ...(bd?.dispatch || []).map((x) => ({ party: x.party, flow: 'Dispatch', sold: x.qty }))
    ]
    return [{ ...r, is_group: true }, ...kids.map((k) => ({ name: r.name, ...k }))]
  })

  return (
    <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <MiniStat label="Products" value={String(rows.length)} tone="slate" />
      <MiniStat label="Total in" value={formatNum(inFlow)} tone="emerald" />
      <MiniStat label="Total out" value={formatNum(outFlow)} tone="rose" />
      <MiniStat label={negatives ? `In stock · ${negatives} negative` : 'In stock'} value={formatNum(totals.stock)} tone={negatives ? 'amber' : 'sky'} />
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {stagePicker}
      {idleCount > 0 && (
        <Button
          variant={hideIdle ? 'default' : 'outline'}
          size="sm"
          className="h-9 gap-1.5 text-xs"
          title={
            hideIdle
              ? `Showing only products with movement — ${idleCount} idle product${idleCount === 1 ? '' : 's'} hidden`
              : `${idleCount} product${idleCount === 1 ? '' : 's'} have no opening, no movement and no closing balance`
          }
          onClick={() => setHideIdle((v) => !v)}
        >
          {hideIdle ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {hideIdle ? `${idleCount} zero-rows hidden` : `Hide ${idleCount} zero rows`}
        </Button>
      )}
      {companyPicker}
      <FyPicker from={range.from} to={range.to} onRange={(f, t) => onRange({ from: f, to: t })} className="h-9 w-28 text-xs" />
      {/* Period for the register: opening balance before it, flows within it. */}
      <span className="text-[11px] font-semibold text-muted-foreground">From</span>
      <div className="w-40"><DatePicker value={range.from} onChange={(v) => onRange({ ...range, from: v })} max={range.to || undefined} /></div>
      <span className="text-[11px] font-semibold text-muted-foreground">To</span>
      <div className="w-40"><DatePicker value={range.to} onChange={(v) => onRange({ ...range, to: v })} min={range.from || undefined} /></div>
      {ranged && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => onRange({ from: '', to: '' })}>
          Clear
        </Button>
      )}
      <Popover open={dlOpen} onOpenChange={setDlOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            className="h-9 w-9 bg-emerald-700 text-white shadow-sm hover:bg-emerald-800"
            title="Download a register as Excel"
            aria-label="Download a register as Excel"
          >
            <Download className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] p-1.5">
          <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Download · {periodLabel}
          </p>
          {([
            {
              key: 'receipt',
              icon: TrendingUp,
              tone: 'text-emerald-700',
              label: 'Receipt register',
              hint: 'One line per inward vehicle — loading and receiving dates, party, transporter, bill, vehicle, dispatch and received qty, shortage and deductible.',
              run: () => downloadMovement('receipt')
            },
            {
              key: 'dispatch',
              icon: TrendingDown,
              tone: 'text-rose-700',
              label: 'Dispatch register',
              hint: 'The same columns for everything that went out, before any credit-note returns.',
              run: () => downloadMovement('dispatch')
            },
            {
              key: 'flow',
              icon: Layers,
              tone: 'text-sky-700',
              label: 'Stock flow register',
              hint: `Opening, movement and closing for each of the ${rows.length} product${rows.length === 1 ? '' : 's'} on screen — one level, no party breakdown.`,
              run: () => downloadFlow(false)
            },
            {
              key: 'flowparty',
              icon: Building2,
              tone: 'text-indigo-700',
              label: 'Stock flow, by party',
              hint: 'The same sheet with each product opened up into the parties behind its receipts and dispatches.',
              run: () => downloadFlow(true)
            }
          ] as const).map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={!!dlBusy}
              onClick={() => void o.run()}
              className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-accent disabled:cursor-wait disabled:opacity-60"
            >
              <o.icon className={cn('mt-0.5 h-4 w-4 shrink-0', o.tone)} />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">
                  {o.label}
                  {dlBusy === o.key && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">preparing…</span>}
                </span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          ))}
          <p className="border-t px-2 pb-1 pt-1.5 text-[10px] leading-snug text-muted-foreground">
            Each file is named with the period and a timestamp, so repeat downloads never overwrite one another.
          </p>
        </PopoverContent>
      </Popover>
    </div>
    {rows.length === 0 ? (
      <div className="rounded-xl border bg-card py-10 text-center text-muted-foreground shadow-sm">
        {hideIdle && allRows.length ? 'Every product here is at zero for this period.' : 'Nothing here yet.'}
      </div>
    ) : (
      <div className="space-y-3">
        {groups.map((grp) => {
          const gSum = (k: string): number => grp.rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
          const gStock = gSum('stock')
          return (
            <div key={grp.label} className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex items-center justify-between bg-[#1a2c56] px-3.5 py-2">
                <span className="text-[12px] font-bold uppercase tracking-wide text-white">{titleCase(grp.label)}</span>
                <span className="text-[11px] font-medium text-white/70">{grp.rows.length} product{grp.rows.length === 1 ? '' : 's'}</span>
              </div>
              <Table className="min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">
                <TableHeader>
                  <TableRow>
                    {STOCK_TABLE_COLS(ranged).map((h) => (
                      <TableHead
                        key={h.l}
                        className={cn(
                          'bg-slate-100 text-[10px] font-semibold uppercase tracking-wide',
                          h.tone || 'text-slate-700',
                          h.r && 'text-right'
                        )}
                      >
                        {h.l}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grp.rows.map((r, i) => (
                    <TableRow key={r.id as number} className={cn('border-b', i % 2 === 1 && 'bg-muted/30')}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      {ranged && (
                        <TableCell className="text-right tabular-nums text-slate-700">
                          {Number(r.opening) ? formatNum(r.opening) : '—'}
                        </TableCell>
                      )}
                      <PartyCell value={Number(r.received)} parties={breakdown[r.id as number]?.receipt || []} />
                      <TableCell className="text-right tabular-nums text-emerald-700">{Number(r.produced) ? formatNum(r.produced) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-700">{Number(r.transferred_in) > 0 ? formatNum(r.transferred_in) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-rose-700">{Number(r.transferred_out) > 0 ? formatNum(r.transferred_out) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-rose-700">{Number(r.consumed) ? formatNum(r.consumed) : '—'}</TableCell>
                      <PartyCell value={Number(r.sold)} parties={breakdown[r.id as number]?.dispatch || []} tone="text-rose-700" />
                      <TableCell
                        className={cn(
                          'text-right font-bold tabular-nums',
                          Number(r.stock) < -1e-9 ? 'text-red-600' : 'text-sky-900'
                        )}
                      >
                        {formatNum(r.stock)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 border-teal-500 bg-teal-50 hover:bg-teal-50">
                    <TableCell className="text-[11px] font-bold uppercase tracking-wide text-teal-900">
                      {titleCase(grp.label)} total
                    </TableCell>
                    {ranged && <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('opening'))}</TableCell>}
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('received'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('produced'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('transferred_in'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('transferred_out'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('consumed'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('sold'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums', gStock < -1e-9 ? 'text-red-600' : 'text-teal-900')}>{formatNum(gStock)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )
        })}
        {groups.length > 1 && (
          <div className="overflow-hidden rounded-xl border-2 border-amber-500 bg-amber-100 shadow-sm">
            <Table className="min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
              <TableBody>
                <TableRow className="bg-amber-100 hover:bg-amber-100">
                  <TableCell className="text-[11px] font-bold uppercase tracking-wide text-amber-900">
                    Grand total across every category
                  </TableCell>
                  {ranged && <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.opening)}</TableCell>}
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.received)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.produced)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.transferred_in)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.transferred_out)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.consumed)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.sold)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.stock)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    )}
    </div>
  )
}

// Shared column header set for every per-category stock table.
function STOCK_TABLE_COLS(ranged: boolean): { l: string; r?: boolean; tone?: string }[] {
  return [
    { l: 'Product' },
    ...(ranged ? [{ l: 'Opening', r: true, tone: 'text-slate-700' }] : []),
    { l: 'Receipt', r: true, tone: 'text-emerald-700' },
    { l: 'Produced', r: true, tone: 'text-emerald-700' },
    { l: 'Transfer in', r: true, tone: 'text-emerald-700' },
    { l: 'Transfer out', r: true, tone: 'text-rose-700' },
    { l: 'Consumed', r: true, tone: 'text-rose-700' },
    { l: 'Dispatch', r: true, tone: 'text-rose-700' },
    { l: ranged ? 'Closing' : 'In stock', r: true, tone: 'text-sky-800' }
  ]
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  // Same parchment-and-navy ledger palette as the count sheet below it.
  return (
    <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] px-3 py-2 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-[16px] font-bold tabular-nums text-[#1a2c56]', tone)}>{value}</div>
    </div>
  )
}

// The two work-sections of the day-close sheet — one person owns each. Actual
// value is auto-valued at the weighted-average cost (never hand-typed).
const DAY_SECTIONS: Array<{ key: string; title: string; cats: string[] }> = [
  { key: 'raw-intermediate', title: 'Raw + Intermediate', cats: ['raw', 'intermediate'] },
  { key: 'finished', title: 'Finished', cats: ['finished'] }
]

// Daily physical-count sheet: enter actual closing stock and compare with the
// computed book stock to see the difference (for tally / reconciliation). Split
// into two owners — Raw/Intermediate and Finished — each with its own protected
// Excel download/upload; actual value = actual qty × weighted-average cost.
function DayClose(): React.JSX.Element {
  const [date, setDate] = useState(todayISO())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<string>(DAY_SECTIONS[0].key)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await window.api.stockCount.sheet(date))
    setLoading(false)
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  function setField(pid: number, key: string, value: unknown): void {
    setRows((rs) => rs.map((r) => (r.product_id === pid ? { ...r, [key]: value } : r)))
  }

  const rateOf = (r: Row): number => Number(r.rate) || 0
  // The physical count is Raw qty (actual_qty) + PP combined — that's what
  // actually exists on the ground, so valuation and the book/actual
  // reconciliation both run off the combined total, not Raw alone.
  const totalOf = (r: Row): number => (Number(r.actual_qty) || 0) + (Number(r.pp_qty) || 0)
  const actualValueOf = (r: Row): number => totalOf(r) * rateOf(r)
  const diffOf = (r: Row): number => Number(r.book_qty || 0) - totalOf(r)

  // Fill the sheet from the last count taken before this date — for the days
  // the plant is shut, when the stock on the ground has not moved.
  //
  // It fills the form, it does NOT save: a shutdown day is still a day someone
  // is asserting a figure for, so it goes in front of them first and is only
  // recorded when they press Save. Rows already filled in are left alone, so a
  // partly-counted sheet is never overwritten by yesterday's numbers.
  const [carrying, setCarrying] = useState(false)
  async function carryForward(): Promise<void> {
    setCarrying(true)
    try {
      const prev = await window.api.stockCount.previous(date)
      if (!prev.source_date) {
        toast.error('No earlier day close on file to copy from')
        return
      }
      const by = new Map(prev.items.map((i) => [Number(i.product_id), i]))
      let filled = 0
      let kept = 0
      setRows((rs) =>
        rs.map((r) => {
          const src = by.get(Number(r.product_id))
          if (!src) return r
          const hasActual = r.actual_qty !== '' && r.actual_qty != null
          const hasPp = r.pp_qty !== '' && r.pp_qty != null
          if (hasActual || hasPp) {
            kept += 1
            return r
          }
          if (src.actual_qty == null && src.pp_qty == null) return r
          filled += 1
          return {
            ...r,
            actual_qty: src.actual_qty == null ? r.actual_qty : src.actual_qty,
            pp_qty: src.pp_qty == null ? r.pp_qty : src.pp_qty
          }
        })
      )
      if (!filled) {
        toast.error(
          kept
            ? `Every counted row is already filled in — nothing copied from ${formatDate(prev.source_date)}`
            : `Nothing to copy from ${formatDate(prev.source_date)}`
        )
        return
      }
      toast.success(
        `Filled ${filled} ${filled === 1 ? 'row' : 'rows'} from ${formatDate(prev.source_date)}` +
          (kept ? ` · ${kept} already filled, left as they were` : '') +
          ' — check them and Save'
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCarrying(false)
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const res = await window.api.stockCount.save(date, rows)
      toast.success(`Saved ${res.count} actual ${res.count === 1 ? 'count' : 'counts'}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Merge an uploaded sheet into this section's rows and SAVE it straight away —
  // an uploaded count sheet is meant to be recorded, so it must not sit unsaved
  // in the grid (where a reload or date change would silently discard it).
  async function applyImport(
    cats: string[],
    parsed: Array<{ product_id?: number; name?: string; actual_qty?: string; pp_qty?: string; note?: string }>
  ): Promise<{ applied: number; saved: number }> {
    const byId = new Map<string, (typeof parsed)[number]>()
    const byName = new Map<string, (typeof parsed)[number]>()
    for (const p of parsed) {
      if (p.product_id != null) byId.set(String(p.product_id), p)
      if (p.name) byName.set(p.name.trim().toLowerCase(), p)
    }
    let applied = 0
    const merged = rows.map((r) => {
      if (!cats.includes(String(r.category))) return r
      const p = byId.get(String(r.product_id)) || byName.get(String(r.name).toLowerCase())
      if (!p) return r
      const hasQty = p.actual_qty != null && p.actual_qty !== ''
      const hasPp = p.pp_qty != null && p.pp_qty !== ''
      const hasNote = p.note != null && p.note !== ''
      if (!hasQty && !hasNote) return r
      applied++
      return {
        ...r,
        actual_qty: hasQty ? p.actual_qty : r.actual_qty,
        pp_qty: hasPp ? p.pp_qty : r.pp_qty,
        note: hasNote ? p.note : r.note
      }
    })
    setRows(merged)
    const res = await window.api.stockCount.save(date, merged)
    await load()
    return { applied, saved: res.count }
  }

  return (
    <div className="space-y-5">
      {/* Date and section sit on one line — both pick what the sheet below
          shows, so they belong together rather than stacked apart. */}
      <Tabs value={section} onValueChange={setSection}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Closing date</Label>
              <DatePicker max={todayISO()} value={date} onChange={(v) => setDate(v || todayISO())} className="w-44" />
            </div>
            <TabsList>
              {DAY_SECTIONS.map((s) => (
                <TabsTrigger key={s.key} value={s.key}>{s.title}</TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void carryForward()}
              disabled={carrying || saving || loading}
              title="Plant shut? Fill this sheet from the last day close before this date, then check and save"
            >
              <Copy className="h-4 w-4" /> {carrying ? 'Copying…' : 'Same as previous day'}
            </Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save day close'}</Button>
          </div>
        </div>
        {DAY_SECTIONS.map((s) => (
          <TabsContent key={s.key} value={s.key} className="mt-4">
            <DayCloseSection
              section={s}
              date={date}
              loading={loading}
              rows={rows.filter((r) => s.cats.includes(r.category))}
              setField={setField}
              onImport={applyImport}
              rateOf={rateOf}
              actualValueOf={actualValueOf}
              diffOf={diffOf}
              totalOf={totalOf}
            />
          </TabsContent>
        ))}
      </Tabs>

      <p className="text-xs text-muted-foreground">
        Book qty is the system-computed stock (received + produced − consumed − sold). Total = Raw qty + PP, the actual
        physical count. Difference = book − total; a positive value means physical stock is short of the books. Actual
        value is valued automatically at the weighted-average cost (rate × total). Download a protected Excel per
        section — only the Raw qty, PP and Note cells are editable — hand it to the person counting, then upload it
        back — uploading records the counts immediately.
      </p>
    </div>
  )
}

// One section (Raw+Intermediate or Finished): its own download/upload + grid.
function DayCloseSection({
  section,
  date,
  loading,
  rows,
  setField,
  onImport,
  rateOf,
  actualValueOf,
  diffOf,
  totalOf
}: {
  section: { key: string; title: string; cats: string[] }
  date: string
  loading: boolean
  rows: Row[]
  setField: (pid: number, key: string, value: unknown) => void
  onImport: (cats: string[], parsed: Array<{ product_id?: number; name?: string; actual_qty?: string; pp_qty?: string; note?: string }>) => Promise<{ applied: number; saved: number }>
  rateOf: (r: Row) => number
  actualValueOf: (r: Row) => number
  diffOf: (r: Row) => number
  totalOf: (r: Row) => number
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)

  const counted = rows.filter((r) => (r.actual_qty !== null && r.actual_qty !== '') || (r.pp_qty !== null && r.pp_qty !== ''))
  const totalDiff = counted.reduce((s, r) => s + diffOf(r), 0)
  const totalActualValue = rows.reduce((s, r) => s + actualValueOf(r), 0)
  const mismatches = counted.filter((r) => Math.abs(diffOf(r)) > 0.0005).length

  async function onDownload(): Promise<void> {
    try {
      await downloadDayCloseExcel(rows, section, date)
      toast.success(`Downloaded the protected ${section.title} sheet`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Upload a filled Excel — match by Product ID (or name) into this section's rows.
  async function onUpload(file: File | undefined): Promise<void> {
    if (!file) return
    try {
      const parsed = await parseDayCloseExcel(file)
      if (!parsed.length) {
        toast.error('No data rows found in the file')
        return
      }
      const byId = new Map<string, (typeof parsed)[number]>()
      const byName = new Map<string, (typeof parsed)[number]>()
      for (const p of parsed) {
        if (p.product_id != null) byId.set(String(p.product_id), p)
        if (p.name) byName.set(p.name.trim().toLowerCase(), p)
      }
      const { applied, saved } = await onImport(section.cats, parsed)
      if (applied === 0) {
        toast.error('No matching products in this section — check you uploaded the right sheet')
      } else {
        toast.success(`Imported ${applied} ${applied === 1 ? 'row' : 'rows'} and saved (${saved} counts recorded)`)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 flex-1">
          <StatCard label="Products counted" value={`${counted.length} / ${rows.length}`} />
          <StatCard label="Mismatches" value={String(mismatches)} tone={mismatches ? 'text-amber-700' : 'text-emerald-700'} />
          <StatCard label="Net difference (book − actual)" value={`${formatNum(totalDiff)}`} tone={Math.abs(totalDiff) > 0.0005 ? 'text-amber-700' : ''} />
          <StatCard label="Section actual value" value={formatINR(totalActualValue)} />
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download className="mr-2 h-4 w-4" /> Excel
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download the protected {section.title} sheet (only Raw qty, PP + Note editable)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Upload
              </Button>
            </TooltipTrigger>
            <TooltipContent>Upload the filled {section.title} sheet — the counts are recorded straight away</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Tally-style count sheet: ruled columns on a cream ledger, the two
          typed columns tinted so it is obvious what the counter fills in. */}
      <div className="overflow-hidden rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
        <Table className="[&_td]:border-r [&_td]:border-[#e8e2cc] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#b9c9e4] [&_th:last-child]:border-r-0">
          <TableHeader>
            <TableRow className="bg-[#dce6f5] hover:bg-[#dce6f5] [&_th]:h-9 [&_th]:py-0 [&_th]:text-[10px] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-widest [&_th]:text-[#1a2c56]">
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Book qty</TableHead>
              <TableHead className="w-[130px] bg-[#cfe0f7] text-right">Raw qty</TableHead>
              <TableHead className="w-[120px] bg-[#cfe0f7] text-right">PP</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead className="text-right">Rate (₹)</TableHead>
              <TableHead className="text-right">Actual value (₹)</TableHead>
              <TableHead className="w-[180px]">Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">No products in this section.</TableCell></TableRow>
            ) : (
              rows.map((r, i) => {
                const has = (r.actual_qty !== null && r.actual_qty !== '') || (r.pp_qty !== null && r.pp_qty !== '')
                const diff = diffOf(r)
                const off = has && Math.abs(diff) > 0.0005
                return (
                  <TableRow
                    key={r.product_id as number}
                    className={cn(
                      'border-b border-[#e8e2cc] transition-colors hover:bg-[#eef4ff]',
                      i % 2 === 1 && 'bg-[#faf7ea]',
                      // A counted row that disagrees with the books is what the
                      // whole sheet exists to surface — tint the line, not just
                      // the one figure.
                      off && 'bg-amber-50/70 hover:bg-amber-50'
                    )}
                  >
                    <TableCell className="py-1.5 text-[13px] font-semibold">{r.name}</TableCell>
                    <TableCell className="py-1.5">
                      <span className="rounded border border-[#d9d2b8] bg-[#f4f1e2] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1a2c56]">
                        {CAT_LABEL[r.category] || r.category}
                      </span>
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-[13px] tabular-nums text-muted-foreground">{formatNum(r.book_qty)}</TableCell>
                    <TableCell className="bg-[#f2f7ff]/70 py-1.5 text-right">
                      <Input
                        type="number"
                        className="h-7 w-28 bg-white text-right text-[13px]"
                        placeholder="—"
                        value={r.actual_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'actual_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className="bg-[#f2f7ff]/70 py-1.5 text-right">
                      <Input
                        type="number"
                        className="h-7 w-24 bg-white text-right text-[13px]"
                        placeholder="—"
                        value={r.pp_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'pp_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-[13px] font-bold tabular-nums">
                      {has ? formatNum(totalOf(r)) : '—'}
                    </TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] font-semibold tabular-nums', off ? (diff > 0 ? 'text-amber-700' : 'text-red-600') : 'text-muted-foreground')}>
                      {has ? formatNum(diff) : '—'}
                    </TableCell>
                    <TableCell className="py-1.5 text-right text-[13px] tabular-nums text-muted-foreground">{rateOf(r) ? formatNum(rateOf(r)) : '—'}</TableCell>
                    <TableCell className="py-1.5 text-right text-[13px] font-medium tabular-nums">{has ? formatINR(actualValueOf(r)) : '—'}</TableCell>
                    <TableCell className="py-1.5">
                      <Input
                        className="h-7 bg-white text-[13px]"
                        placeholder="optional"
                        value={r.note ?? ''}
                        onChange={(e) => setField(r.product_id, 'note', e.target.value)}
                      />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
            {!loading && rows.length > 0 && (
              <TableRow className="border-t-2 border-[#1a2c56] bg-[#f0ecd9] text-[#1a2c56] hover:bg-[#f0ecd9]">
                <TableCell colSpan={2} className="py-2 text-[12px] font-bold uppercase tracking-widest">Grand total</TableCell>
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.book_qty) || 0), 0))}
                </TableCell>
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.actual_qty) || 0), 0))}
                </TableCell>
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.pp_qty) || 0), 0))}
                </TableCell>
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatNum(rows.reduce((a, r) => a + totalOf(r), 0))}
                </TableCell>
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatNum(
                    rows.reduce(
                      (a, r) =>
                        a + ((r.actual_qty !== null && r.actual_qty !== '') || (r.pp_qty !== null && r.pp_qty !== '') ? diffOf(r) : 0),
                      0
                    )
                  )}
                </TableCell>
                <TableCell className="py-2" />
                <TableCell className="py-2 text-right text-[13px] font-bold tabular-nums">
                  {formatINR(rows.reduce((a, r) => a + actualValueOf(r), 0))}
                </TableCell>
                <TableCell className="py-2" />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// The filter list is keyed on what a SKU packs, not on the SKU itself: one
// entry per product (its linked finished product, or the short name typed on
// the SKU), which selects every SKU of that product at once. SKUs with no
// product named at all have nothing to group under, so they are listed
// individually by SKU name. `value` stays a list of SKU ids either way.
function skuFilterOptions(skus: Row[]): { key: string; label: string; ids: string[]; count: number }[] {
  const byProduct = new Map<string, string[]>()
  const loose: { key: string; label: string; ids: string[]; count: number }[] = []
  for (const s of skus) {
    const id = String(s.id)
    const product = String(s.product_name || '').trim()
    if (product) byProduct.set(product, [...(byProduct.get(product) ?? []), id])
    else loose.push({ key: `sku:${id}`, label: String(s.name || ''), ids: [id], count: 0 })
  }
  const products = Array.from(byProduct, ([label, ids]) => ({
    key: `product:${label}`,
    label,
    ids,
    count: ids.length
  })).sort((a, b) => a.label.localeCompare(b.label))
  loose.sort((a, b) => a.label.localeCompare(b.label))
  return [...products, ...loose]
}

// Searchable multi-select for narrowing the Packed SKU table — a long list is
// unworkable as a plain dropdown, so this is a checklist-style combobox (type
// to filter, click to toggle).
function SkuMultiSelect({
  skus,
  value,
  onChange
}: {
  skus: Row[]
  value: string[]
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const picked = new Set(value)
  const options = useMemo(() => skuFilterOptions(skus), [skus])
  const selectedOptions = options.filter((o) => o.ids.every((id) => picked.has(id)))

  // A product entry is all-or-nothing: it turns every SKU under it on or off.
  function toggle(ids: string[]): void {
    const next = new Set(value)
    if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id))
    else ids.forEach((id) => next.add(id))
    onChange(Array.from(next))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 min-w-[11rem] max-w-xs items-center gap-1.5 rounded-md border bg-white px-2.5 text-[13px]',
            'focus:outline-none focus:ring-2 focus:ring-primary/40',
            !value.length && 'text-muted-foreground'
          )}
        >
          <span className="truncate">
            {value.length === 0
              ? 'Filter by product…'
              : value.length === skus.length
                ? 'All products'
                : selectedOptions.length === 1
                  ? selectedOptions[0].label
                  : `${value.length} SKUs selected`}
          </span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Search product or SKU…" />
          <CommandList className="max-h-72">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {options.map((o) => {
              const all = o.ids.every((id) => picked.has(id))
              const some = !all && o.ids.some((id) => picked.has(id))
              return (
                <CommandItem key={o.key} value={o.label} onSelect={() => toggle(o.ids)}>
                  <span
                    className={cn(
                      'mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      all
                        ? 'border-primary bg-primary text-primary-foreground'
                        : some
                          ? 'border-primary text-primary'
                          : 'border-muted-foreground/40'
                    )}
                  >
                    {all ? <Check className="h-3 w-3" /> : some ? <span className="h-0.5 w-2 bg-primary" /> : null}
                  </span>
                  <span className="truncate">{o.label}</span>
                  {o.count > 0 && (
                    <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">
                      {o.count} SKU{o.count === 1 ? '' : 's'}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandList>
          <div className="flex items-center justify-between border-t p-1.5">
            <span className="px-1 text-[11px] text-muted-foreground">
              {value.length} of {skus.length} SKUs
            </span>
            <div className="flex items-center gap-0.5">
              {value.length < skus.length && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => onChange(skus.map((s) => String(s.id)))}
                >
                  <Check className="h-3 w-3" /> Select all
                </Button>
              )}
              {value.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => onChange([])}
                >
                  <X className="h-3 w-3" /> Clear
                </Button>
              )}
            </div>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Packed finished stock per SKU (packaging). A lightweight, manually-maintained
// count: add packs in / remove, and it's reduced automatically by dispatched
// PACKED sales of that SKU. on-hand = packed in − packed sold (in units).
function SkuStock(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  // The parts behind each figure, for the hover. One pair of queries for every
  // SKU on the page rather than one per tooltip.
  const [parts, setParts] = useState<Map<number, Row>>(new Map())
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{
    mode: 'add' | 'remove'
    amount: string
    note: string
    date: string
    // Which unit the typed figure is in. Stored stock is always pieces.
    unit: 'case' | 'piece'
    // Real packing off the line, or a hand fix to a wrong count. The register
    // used to guess this from the sign, which made every correction that ADDED
    // stock look like a day's production.
    kind: 'packing' | 'correction'
  }>({
    mode: 'add',
    kind: 'packing',
    amount: '',
    note: '',
    date: todayISO(),
    unit: 'case'
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Day register: pick a date to see/update that day's pieces (opening b/f +
  // packed in − despatched = closing). "All time" shows running totals.
  const [dayMode, setDayMode] = useState(true)
  const [date, setDate] = useState(todayISO())

  const load = useCallback(async () => {
    setLoading(true)
    const when = dayMode ? date : undefined
    const [list, breakdown] = await Promise.all([
      window.api.skuStock.list(when),
      // The workings behind the figures, for the hover. Asked for once for the
      // whole page, so a tooltip costs nothing when it opens.
      window.api.skuStock.breakdown(when).catch(() => [] as Row[])
    ])
    setRows(list)
    setParts(new Map(breakdown.map((b) => [Number(b.sku), b])))
    setLoading(false)
  }, [dayMode, date])
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  const unitLabel = (r: Row): string => {
    const size = Number(r.unit_size) || 0
    if (size > 0) return `${formatNum(size)} ${r.unit_uom || ''}`.trim()
    const bpp = Number(r.base_per_pouch) || 0
    return bpp > 0 ? `${formatNum(bpp)} ${r.base_uom || ''}`.trim() : '—'
  }

  // Tonnage of one SKU's on-hand pieces (pieces × pack size → MT).
  const skuMT = (r: Row): number => {
    const size = Number(r.unit_size) > 0 ? Number(r.unit_size) : Number(r.base_per_pouch) || 0
    const uom = Number(r.unit_size) > 0 ? String(r.unit_uom || 'KG') : String(r.base_uom || 'KG')
    return (Number(r.on_hand) || 0) * packSizeMT(size, uom)
  }

  // Every SKU's tonnage, summed — the sheet's TOTAL (MT).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const totalMT = useMemo(() => rows.reduce((s, r) => s + skuMT(r), 0), [rows])

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    // Default the entry to the day being viewed, so day-wise updates land there.
    // Counted in cases by default: that is how packed output comes off the line,
    // and it is what was being typed into a field that meant pieces.
    setAdjustForm({ mode: 'add', kind: 'packing', amount: '', note: '', date: dayMode ? date : todayISO(), unit: 'case' })
    setError(null)
  }

  async function saveAdjust(): Promise<void> {
    if (!adjustRow) return
    const amt = Number(adjustForm.amount)
    if (!amt || amt <= 0) { setError('Enter a quantity greater than zero'); return }
    // Refused here as well as in the main process, so the message lands on the
    // field rather than arriving as a failed save.
    if (adjustForm.kind === 'correction' && !adjustForm.note.trim()) {
      setError('Say what is being corrected — a correction without a reason cannot be checked later')
      return
    }
    // The register counts, and this column stores, PIECES. A case of 40 pouches
    // is 40 of them, so an entry made in cases is converted here rather than
    // being stored as if 40 pouches were 40 cases.
    const pieces = amt * (adjustForm.unit === 'case' ? perCase(adjustRow) : 1)
    const delta = adjustForm.mode === 'add' ? pieces : -pieces
    setSaving(true)
    setError(null)
    try {
      await window.api.skuStock.adjust(
        Number(adjustRow.id),
        delta,
        adjustForm.note || undefined,
        adjustForm.date || undefined,
        adjustForm.kind
      )
      toast.success(
        `${adjustForm.mode === 'add' ? 'Added' : 'Removed'} ${formatNum(Math.abs(pieces))} ${pieceLabel(adjustRow)}` +
          `${adjustForm.unit === 'case' && perCase(adjustRow) > 1 ? ` (${formatNum(amt)} × ${caseLabel(adjustRow)})` : ''} — ${adjustRow.name}`
      )
      setAdjustRow(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const totalOnHand = rows.reduce((s, r) => s + (Number(r.on_hand) || 0), 0)
  const negatives = rows.filter((r) => Number(r.on_hand) < -1e-6).length

  // Search + hide-empty, so a long SKU list stays workable. skuPick narrows to
  // specific SKUs (searchable multi-select) — it starts with everything ticked,
  // and an empty pick means no narrowing rather than an empty table.
  const [search, setSearch] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [skuPick, setSkuPick] = useState<string[]>([])
  // Everything starts ticked, so the filter reads as "all of this is showing"
  // rather than an empty box. Any SKU added later is ticked too, but only
  // while nothing has been unticked by hand — once it has, the picks stand.
  const seeded = useRef(false)
  const allPicked = useRef(true)
  useEffect(() => {
    if (!rows.length) return
    const ids = rows.map((r) => String(r.id))
    if (!seeded.current) {
      seeded.current = true
      setSkuPick(ids)
      return
    }
    if (allPicked.current) setSkuPick(ids)
  }, [rows])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const picked = new Set(skuPick)
    return rows.filter((r) => {
      // Matches the SKU name or the product it packs (linked finished product,
      // or the short name typed on the SKU).
      if (q && ![r.name, r.product_name].some((v) => String(v || '').toLowerCase().includes(q))) return false
      if (picked.size && !picked.has(String(r.id))) return false
      if (hideEmpty) {
        const moved = (Number(r.opening) || 0) + (Number(r.added_on ?? r.added) || 0) + (Number(r.sold_on ?? r.sold) || 0)
        if (Math.abs(Number(r.on_hand) || 0) < 1e-6 && Math.abs(moved) < 1e-6) return false
      }
      return true
    })
  }, [rows, search, hideEmpty, skuPick])
  const shownMT = useMemo(() => shown.reduce((s, r) => s + skuMT(r), 0), [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Excel count sheet -------------------------------------------------
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)

  async function downloadCountSheet(): Promise<void> {
    try {
      await downloadSkuCountExcel(
        shown.map((r) => ({ ...r, pack_label: unitLabel(r) })),
        dayMode ? date : todayISO(),
        skuMT
      )
      toast.success('Count sheet downloaded — only the Counted column is editable')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // A filled-in sheet is applied as dated adjustments: for each SKU the delta
  // between the counted closing and what the system holds, dated to the day
  // being viewed. Untouched rows come back equal, so they change nothing.
  async function importCountSheet(file: File): Promise<void> {
    setImporting(true)
    try {
      const parsed = await parseSkuCountExcel(file)
      if (!parsed.length) {
        toast.error('No counted rows found — use the downloaded count sheet')
        return
      }
      const when = dayMode ? date : todayISO()
      let applied = 0
      let unchanged = 0
      const missing: string[] = []
      for (const p of parsed) {
        const row =
          rows.find((r) => Number(r.id) === p.id) ||
          rows.find((r) => String(r.name || '').toLowerCase() === p.name.toLowerCase())
        if (!row) {
          missing.push(p.name)
          continue
        }
        const delta = p.counted - (Number(row.on_hand) || 0)
        if (Math.abs(delta) < 1e-6) {
          unchanged++
          continue
        }
        await window.api.skuStock.adjust(
          Number(row.id),
          delta,
          p.note || `Closing count ${formatDate(when)}`,
          when
        )
        applied++
      }
      await load()
      toast.success(
        `${applied} SKU${applied === 1 ? '' : 's'} updated${unchanged ? `, ${unchanged} already matched` : ''}` +
          (missing.length ? ` · not found: ${missing.slice(0, 3).join(', ')}` : '')
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      {/* Controls: period, search, and the count-sheet round trip */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border p-0.5">
          <button
            type="button"
            onClick={() => setDayMode(true)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] font-medium transition',
              dayMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Day wise
          </button>
          <button
            type="button"
            onClick={() => setDayMode(false)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] font-medium transition',
              !dayMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            All time
          </button>
        </div>
        {dayMode && (
          <div className="flex items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Date</span>
            {/* Reading a day-wise register means walking day by day, and going
                through the calendar for each step is the slow way round.
                Forward stops at today, since there is no stock after it. */}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              title="Previous day"
              onClick={() => setDate(shiftDate(date, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <DatePicker max={todayISO()} value={date} onChange={(v) => setDate(v || todayISO())} className="w-36" />
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              title={date >= todayISO() ? 'Already on today' : 'Next day'}
              disabled={date >= todayISO()}
              onClick={() => setDate(shiftDate(date, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground"
              disabled={date >= todayISO()}
              onClick={() => setDate(todayISO())}
            >
              Today
            </Button>
          </div>
        )}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU or product…"
          className="h-8 w-48 text-[13px]"
        />
        <SkuMultiSelect
          skus={rows}
          value={skuPick}
          onChange={(v) => {
            allPicked.current = v.length === rows.length
            setSkuPick(v)
          }}
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
          <Switch checked={hideEmpty} onCheckedChange={setHideEmpty} />
          Hide untouched
        </label>

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importCountSheet(f)
            }}
          />
          <Button variant="outline" size="sm" onClick={downloadCountSheet} disabled={!shown.length}>
            <Download className="h-4 w-4" /> Count sheet
          </Button>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            <Upload className="h-4 w-4" /> {importing ? 'Uploading…' : 'Upload closing'}
          </Button>
          <ExcelButton
            filename={`packed-sku-stock-${dayMode ? date : todayISO()}`}
            sheetName="Packed SKU stock"
            title={`Packed SKU stock${dayMode ? ` — ${formatDate(date)}` : ''}`}
            columns={
              dayMode
                ? [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Opening (pcs)', key: 'opening', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.opening) || 0 },
                    { header: 'Packed in', key: 'added_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added_on) || 0 },
                    { header: 'Despatch', key: 'sold_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold_on) || 0 },
                    { header: 'Closing (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'Closing (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
                : [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Packed in', key: 'added', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added) || 0 },
                    { header: 'Sold (packed)', key: 'sold', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold) || 0 },
                    { header: 'On hand (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'On hand (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
            }
            rows={shown}
          />
        </div>
      </div>

      {/* The band totals WHAT IS ON SCREEN. It used to total every SKU in the
          mill regardless of the filters right above it, so narrowing to one
          product left a closing figure that belonged to everything — a subtotal
          and a grand total looking identical, which is the one thing a total
          must never do. Whenever a filter is on, the full figure is kept on the
          second line rather than lost. */}
      {(() => {
        const sum = (list: Row[], get: (r: Row) => number): number => list.reduce((t, r) => t + get(r), 0)
        const inOf = (r: Row): number => (dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0)
        const outOf = (r: Row): number => (dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0)
        const handOf = (r: Row): number => Number(r.on_hand) || 0
        const part = shown.length !== rows.length
        const all = (v: string): string | undefined => (part ? `of ${v}` : undefined)
        return (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
            <MiniStat
              label="SKUs"
              value={`${shown.length}${part ? ` / ${rows.length}` : ''}`}
              hint={part ? 'filtered' : undefined}
              tone="slate"
            />
            <MiniStat
              label={dayMode ? 'Packed in' : 'Packed (total)'}
              value={formatNum(sum(shown, inOf))}
              hint={all(formatNum(sum(rows, inOf)))}
              tone="emerald"
            />
            <MiniStat
              label={dayMode ? 'Despatched' : 'Sold (packed)'}
              value={formatNum(sum(shown, outOf))}
              hint={all(formatNum(sum(rows, outOf)))}
              tone="rose"
            />
            <MiniStat
              label={dayMode ? 'Closing (pcs)' : 'On hand (pcs)'}
              value={formatNum(sum(shown, handOf))}
              hint={all(formatNum(totalOnHand))}
              tone="sky"
            />
            <MiniStat
              label={dayMode ? 'Closing (MT)' : 'On hand (MT)'}
              value={`${formatNum(shownMT)} MT`}
              hint={all(`${formatNum(totalMT)} MT`)}
              tone="violet"
            />
          </div>
        )
      })()}

      {negatives > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          <b>{negatives}</b> SKU{negatives === 1 ? '' : 's'} below zero — more despatched than packed. Check the packing
          entries for those rows.
        </div>
      )}

      <div className="rounded-xl border bg-card shadow-sm">
        <Table
          wrapperClassName="max-h-[calc(100vh-360px)] rounded-xl"
          className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-slate-200 hover:bg-slate-200">
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">SKU</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Pack</TableHead>
              {dayMode && (
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">Opening</TableHead>
              )}
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Packed in' : 'Packed (total)'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Despatch' : 'Sold'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Closing (pcs)' : 'On hand (pcs)'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Closing (MT)' : 'On hand (MT)'}
              </TableHead>
              <TableHead className="w-[64px] text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                Update
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={dayMode ? 8 : 7} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={dayMode ? 8 : 7} className="py-12 text-center text-muted-foreground">
                  {rows.length === 0
                    ? 'No SKUs. Add packagings under Masters → Packed SKU first.'
                    : 'No SKU matches this search.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {shown.map((r, i) => {
                  const onHand = Number(r.on_hand) || 0
                  const inQty = dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0
                  const outQty = dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0
                  const touched = inQty > 1e-6 || outQty > 1e-6
                  const part = parts.get(Number(r.id))
                  const per = perCase(r)
                  // Pieces, and the same figure in the unit the shop floor
                  // counts in, since that is the number people recognise.
                  const asCases = (pieces: number): string =>
                    per > 1 ? `${formatNum(pieces)} (${formatNum(pieces / per)} ${caseLabel(r).toLowerCase()})` : formatNum(pieces)
                  // Who took it. One line per invoice, so a party appearing on
                  // two invoices shows as two lines rather than one lump.
                  const outLines = ((part?.despatch || []) as Row[]).map((dr) => ({
                    left: formatDateShort(dr.sale_date),
                    mid: `${dr.customer || 'Unknown'} · ${dr.invoice_no || 'no invoice no'}`,
                    right: asCases(Number(dr.pieces) || 0)
                  }))
                  // A correction is not packing, and lumping the two together
                  // is how a hand-typed fix passes for production. It is split
                  // on what the entry SAYS it is now that it is asked for; the
                  // sign is only the fallback for entries made before that, and
                  // the backend already applies it.
                  const adjustments = (part?.packed_in || []) as Row[]
                  const fixes = adjustments.filter((a) => String(a.kind) === 'correction')
                  const inLines = adjustments
                    .filter((a) => String(a.kind) !== 'correction')
                    .map((a) => ({
                      left: formatDateShort(a.adj_date),
                      mid: String(a.note || 'Packed'),
                      right: asCases(Number(a.delta) || 0)
                    }))
                  const fixLines = fixes.map((a) => ({
                    left: formatDateShort(a.adj_date),
                    // Who made it matters more than anything else on the line —
                    // a correction is somebody's judgement, not a measurement.
                    mid: `${a.note || 'Correction'}${a.created_by ? ` · ${a.created_by}` : ''}`,
                    right: `${Number(a.delta) > 0 ? '+' : ''}${asCases(Number(a.delta) || 0)}`
                  }))
                  const fixNet = fixes.reduce((t, a) => t + (Number(a.delta) || 0), 0)
                  return (
                    <TableRow
                      key={r.id as number}
                      className={cn('border-b', i % 2 === 1 && 'bg-muted/30', touched && 'bg-sky-50/70 hover:bg-sky-50')}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          <span>{r.name}</span>
                          {/* A correction that only shows up if somebody thinks
                              to hover is a correction nobody reviews. */}
                          {fixes.length > 0 && (
                            <CellWithWorkings
                              value={fixes.length === 1 ? 'Corrected' : `Corrected ×${fixes.length}`}
                              className="shrink-0 rounded bg-amber-100 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-amber-800 no-underline"
                              title={dayMode ? `Hand corrections on ${formatDate(date)}` : 'Hand corrections — all time'}
                              lines={fixLines}
                              footer={`Net ${fixNet > 0 ? '+' : ''}${asCases(fixNet)} by hand — typed in, not counted off a production or despatch entry.`}
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{unitLabel(r)}</TableCell>
                      {dayMode && (
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {Number(r.opening) ? (
                            <CellWithWorkings
                              value={formatNum(r.opening)}
                              title={`Brought forward into ${formatDate(date)}`}
                              lines={[
                                { left: 'Packed in', mid: 'everything before this date', right: asCases(Number(r.added_before) || 0) },
                                { left: 'Despatched', mid: 'everything before this date', right: `−${asCases(Number(r.sold_before) || 0)}` }
                              ]}
                              footer={`= ${asCases(Number(r.opening) || 0)} on hand at the start of the day`}
                            />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-medium tabular-nums text-emerald-700">
                        {inQty ? (
                          <CellWithWorkings
                            value={formatNum(inQty)}
                            className="text-emerald-700"
                            title={dayMode ? `Packed in on ${formatDate(date)}` : 'Packed in — all time'}
                            lines={[...inLines, ...fixLines]}
                            footer={
                              fixLines.length
                                ? `${inLines.length} packing entr${inLines.length === 1 ? 'y' : 'ies'}, ${fixLines.length} correction${fixLines.length === 1 ? '' : 's'}`
                                : undefined
                            }
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-red-600">
                        {outQty ? (
                          <CellWithWorkings
                            value={formatNum(outQty)}
                            className="text-red-600"
                            title={dayMode ? `Despatched on ${formatDate(date)} — by party` : 'Despatched — by party'}
                            lines={outLines}
                            footer={`${outLines.length} invoice${outLines.length === 1 ? '' : 's'} · ${formatNum((outQty * Number(r.base_per_pouch || 0)) / 1000)} MT`}
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', onHand < -1e-6 ? 'text-red-600' : 'text-slate-900')}>
                        <CellWithWorkings
                          value={formatNum(onHand)}
                          className={onHand < -1e-6 ? 'text-red-600' : 'text-slate-900'}
                          title={dayMode ? `How ${formatDate(date)} closed` : 'How the balance stands'}
                          lines={
                            dayMode
                              ? [
                                  { left: 'Opening', right: asCases(Number(r.opening) || 0) },
                                  { left: 'Packed in', right: `+${asCases(inQty)}` },
                                  { left: 'Despatched', right: `−${asCases(outQty)}` }
                                ]
                              : [
                                  { left: 'Packed in', right: asCases(Number(r.added) || 0) },
                                  { left: 'Despatched', right: `−${asCases(Number(r.sold) || 0)}` }
                                ]
                          }
                          footer={
                            onHand < -1e-6
                              ? r.negative_since
                                ? `= ${asCases(onHand)} — below zero since ${formatDate(r.negative_since)}` +
                                  `${daysApart(String(r.negative_since), dayMode ? date : todayISO()) > 0 ? `, ${daysApart(String(r.negative_since), dayMode ? date : todayISO())} days now` : ' — today'}` +
                                  `. Every figure since carries the same error forward.`
                                : `= ${asCases(onHand)} — below zero, so more has gone out than was ever packed in`
                              : `= ${asCases(onHand)} · ${formatNum(skuMT(r))} MT`
                          }
                          extra={
                            onHand < -1e-6 && r.negative_since ? (
                              <div className="mt-1.5 border-t border-white/20 pt-1.5">
                                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-rose-300">
                                  Went negative on {formatDate(r.negative_since)}
                                </div>
                                {/* The day it first went under is the day whose
                                    paperwork has the answer — so the balance
                                    either side of that day is spelled out
                                    rather than left to be worked back to. */}
                                <div className="space-y-0.5 text-[11px]">
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-white/60">Stood at</span>
                                    <span className="ml-auto font-semibold tabular-nums">
                                      {asCases(Number(r.negative_trigger?.before) || 0)}
                                    </span>
                                  </div>
                                  {Number(r.negative_trigger?.sale) > 0 && (
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-white/60">Despatched that day</span>
                                      <span className="ml-auto font-semibold tabular-nums text-rose-300">
                                        −{asCases(Number(r.negative_trigger?.sale) || 0)}
                                      </span>
                                    </div>
                                  )}
                                  {Math.abs(Number(r.negative_trigger?.adj) || 0) > 1e-6 && (
                                    <div className="flex items-baseline gap-2">
                                      <span className="text-white/60">Packed / corrected that day</span>
                                      <span className="ml-auto font-semibold tabular-nums">
                                        {Number(r.negative_trigger?.adj) > 0 ? '+' : ''}
                                        {asCases(Number(r.negative_trigger?.adj) || 0)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div className="mt-1 text-[10px] text-white/70">
                                  It has not been back above zero since. Fix that day and the rest follows.
                                </div>
                              </div>
                            ) : undefined
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-violet-700">{formatNum(skuMT(r))}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={dayMode ? `Add / remove packs on ${formatDate(date)}` : 'Add / remove packs'}
                          onClick={() => openAdjust(r)}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell colSpan={dayMode ? 3 : 2} className="font-bold uppercase tracking-wide text-amber-900">
                    Total{shown.length !== rows.length ? ' (filtered)' : ''}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (Number(r.on_hand) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(shownMT)} MT</TableCell>
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {dayMode
          ? 'Day wise: opening (brought forward) + packed in on this date − despatched on this date = closing. Rows with movement on the day are tinted. Closing (MT) = pieces × pack size (1 L counted as 1 KG). Use the sliders icon for one SKU, or Count sheet → Upload closing to set the whole day at once.'
          : 'All time: packs added − packs sold on dispatched PACKED sales = on hand. On hand (MT) = pieces × pack size (1 L counted as 1 KG).'}
      </p>

      <Dialog open={!!adjustRow} onOpenChange={(o) => !o && setAdjustRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update packed stock — {adjustRow?.name}</DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const onHand = Number(adjustRow.on_hand) || 0
            const amt = Number(adjustForm.amount) || 0
            const pieces = amt * (adjustForm.unit === 'case' ? perCase(adjustRow) : 1)
            const delta = adjustForm.mode === 'add' ? pieces : -pieces
            const newHand = onHand + delta
            return (
              <div className="space-y-3">
                {/* Asked before anything else, because it changes what the
                    entry MEANS. Packing is production; a correction is somebody
                    deciding the count was wrong, and the register now says so
                    on the row rather than leaving it to look like output. */}
                <div className="flex gap-2">
                  {(
                    [
                      ['packing', 'Packing', 'Real packs off the line'],
                      ['correction', 'Correction', 'The count was wrong']
                    ] as const
                  ).map(([k, label, hint]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setAdjustForm((p) => ({ ...p, kind: k }))}
                      className={cn(
                        'flex-1 rounded-md border px-3 py-2 text-left',
                        adjustForm.kind === k
                          ? k === 'correction'
                            ? 'border-amber-500 bg-amber-50 text-amber-900'
                            : 'border-sky-500 bg-sky-50 text-sky-900'
                          : 'hover:bg-muted/40'
                      )}
                    >
                      <div className="text-sm font-medium">{label}</div>
                      <div className="text-[10.5px] leading-tight text-muted-foreground">{hint}</div>
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40')}>+ Add packs</button>
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40')}>− Remove packs</button>
                </div>
                {/* The unit has to be stated. This field used to say "Packs",
                    which on a 40-pouch case means either 1 or 40 depending on
                    who is reading it -- and the register counts pieces, so cases
                    typed in here were being read as pieces and the SKU went
                    tens of thousands negative. */}
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'}</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      autoFocus
                      className="flex-1"
                      value={adjustForm.amount}
                      onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))}
                    />
                    {perCase(adjustRow) > 1 ? (
                      <div className="inline-flex shrink-0 rounded-lg border p-0.5">
                        {(['case', 'piece'] as const).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setAdjustForm((p) => ({ ...p, unit: u }))}
                            className={cn(
                              'rounded-md px-3 py-1 text-[13px] font-medium transition',
                              adjustForm.unit === u
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                          >
                            {u === 'case' ? caseLabel(adjustRow) : pieceLabel(adjustRow)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-9 shrink-0 items-center rounded-md bg-muted px-3 text-[13px] text-muted-foreground">
                        {pieceLabel(adjustRow)}
                      </div>
                    )}
                  </div>
                  {amt > 0 && perCase(adjustRow) > 1 && adjustForm.unit === 'case' && (
                    <div className="text-[11px] text-muted-foreground">
                      {formatNum(amt)} × {perCase(adjustRow)} = <b>{formatNum(amt * perCase(adjustRow))}</b>{' '}
                      {pieceLabel(adjustRow)} · {formatNum((amt * perCase(adjustRow) * Number(adjustRow.base_per_pouch || 0)) / 1000)} MT
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={adjustForm.date} onChange={(v) => setAdjustForm((p) => ({ ...p, date: v || '' }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>
                    {adjustForm.kind === 'correction' ? 'What is being corrected *' : 'Note (optional)'}
                  </Label>
                  <Input
                    value={adjustForm.note}
                    onChange={(e) => setAdjustForm((p) => ({ ...p, note: e.target.value }))}
                    placeholder={
                      adjustForm.kind === 'correction'
                        ? 'e.g. counted in cases by mistake on 12-08'
                        : 'e.g. packed today'
                    }
                  />
                  {adjustForm.kind === 'correction' && (
                    <span className="text-[10.5px] text-muted-foreground">
                      This will be flagged on the register as a hand correction, against your name.
                    </span>
                  )}
                </div>
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  On hand: <span className="tabular-nums">{formatNum(onHand)}</span> →{' '}
                  <span className={cn('font-semibold tabular-nums', newHand < -1e-9 && 'text-red-600')}>{formatNum(newHand)}</span>{' '}
                  <span className="text-[11px] text-muted-foreground">{pieceLabel(adjustRow)}</span>
                  {newHand < -1e-9 && (
                    <div className="mt-1 text-[11px] font-medium text-red-600">
                      That would take this SKU below zero — check whether the figure is in{' '}
                      {caseLabel(adjustRow).toLowerCase()}s or {pieceLabel(adjustRow).toLowerCase()}s.
                    </div>
                  )}
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={saving}>Cancel</Button>
            <Button onClick={saveAdjust} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// MNC / consignment stock: goods a supplier (e.g. BUNGE) keeps at our place.
// It is NOT our stock until invoiced, so it is shown separately here —
// deposited − invoiced = balance still owned by the supplier.
function MncStock(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [lots, setLots] = useState<Row[]>([])
  const [invoices, setInvoices] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  // Opening stock: what the MNC already held with us when the books started.
  // No gate entry behind it, so it is entered by hand.
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [openingOpen, setOpeningOpen] = useState(false)
  const [opening, setOpening] = useState<Row>({})
  const [openingLog, setOpeningLog] = useState<Row[]>([])
  const [savingOpening, setSavingOpening] = useState(false)
  const [openingError, setOpeningError] = useState<string | null>(null)
  // Period for the register: opening balance before it, deposits/invoices
  // within it — same convention as Book Stock's date range.
  const [mncFrom, setMncFrom] = useState('')
  const [mncTo, setMncTo] = useState('')
  const mncRanged = !!(mncFrom || mncTo)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRangeMnc = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRangeMnc, 'stock')) { setMncFrom(globalRangeMnc.from); setMncTo(globalRangeMnc.to) }
  }, [globalRangeMnc.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true)
    const [sm, ls, inv, sup, prd] = await Promise.all([
      window.api.consignment.summary(mncRanged ? { from: mncFrom, to: mncTo } : undefined),
      window.api.consignment.list(),
      // The purchases that drew this stock down — the detail behind the
      // Invoiced column, on the same period as the summary.
      window.api.consignment.invoices(mncRanged ? { from: mncFrom, to: mncTo } : undefined),
      window.api.data.list('suppliers'),
      window.api.data.list('products')
    ])
    setRows(sm)
    setLots(ls)
    setInvoices(inv)
    setSuppliers(sup.filter((x) => x.active))
    setProducts(prd.filter((x) => x.active))
    setLoading(false)
  }, [mncRanged, mncFrom, mncTo])

  // The opening lot already recorded for a party + product, if any. A second
  // entry restates it rather than adding another row.
  // Every unbooked opening lot for a party + product. Normally one, but entries
  // made before opening stock became an update-in-place can leave several.
  const openingLotsFor = useCallback(
    (supplierId: unknown, productId: unknown): Row[] =>
      lots
        .filter(
          (l) =>
            Number(l.is_opening) === 1 &&
            l.order_id == null &&
            String(l.supplier_id) === String(supplierId || '') &&
            String(l.product_id) === String(productId || '')
        )
        // Newest first: the last figure entered is the one that counts.
        .sort((a, b) => Number(b.id) - Number(a.id)),
    [lots]
  )
  const openingLotFor = useCallback(
    (supplierId: unknown, productId: unknown): Row | undefined => openingLotsFor(supplierId, productId)[0],
    [openingLotsFor]
  )
  const existingOpenings = openingLotsFor(opening.supplier_id, opening.product_id)
  const existingOpening = existingOpenings[0]
  const existingOpeningTotal = existingOpenings.reduce((s, l) => s + (Number(l.qty) || 0), 0)

  function openOpeningStock(supplierId?: unknown, productId?: unknown): void {
    const existing = openingLotsFor(supplierId, productId)
    const found = existing[0]
    setOpening({
      supplier_id: supplierId ? String(supplierId) : '',
      product_id: productId ? String(productId) : '',
      qty: existing.length ? String(existing[0].qty ?? '') : '',
      uom: String(found?.uom || 'MT'),
      deposit_date: String(found?.deposit_date || todayISO()).slice(0, 10),
      note: found?.note ?? ''
    })
    setOpeningError(null)
    setOpeningOpen(true)
  }

  async function saveOpeningStock(): Promise<void> {
    if (!opening.supplier_id) return setOpeningError('Choose the MNC / party')
    if (!opening.product_id) return setOpeningError('Choose the product')
    if ((Number(opening.qty) || 0) <= 0) return setOpeningError('Enter the opening quantity')
    setSavingOpening(true)
    setOpeningError(null)
    try {
      // One validated main-process step: logs the old figure, merges duplicate
      // lots, refuses figures below what is already drawn or future dates.
      await window.api.consignment.saveOpening({
        supplier_id: Number(opening.supplier_id),
        product_id: Number(opening.product_id),
        qty: Number(opening.qty),
        uom: opening.uom || 'MT',
        deposit_date: opening.deposit_date,
        note: opening.note ? String(opening.note).trim() : 'Opening stock'
      })
      toast.success(`Opening stock set to ${formatNum(Number(opening.qty))} ${opening.uom || 'MT'}`)
      setOpeningOpen(false)
      await load()
    } catch (e) {
      setOpeningError((e as Error).message)
    } finally {
      setSavingOpening(false)
    }
  }

  // The band's live numbers for the pair in the dialog — shown before changing.
  const dlgBand = rows.find(
    (r) => String(r.supplier_id) === String(opening.supplier_id) && String(r.product_id) === String(opening.product_id)
  )
  const dlgDrawn = dlgBand ? (Number(dlgBand.deposited) || 0) - (Number(dlgBand.balance) || 0) : 0
  const dlgMin = dlgBand ? Math.max(0, dlgDrawn - ((Number(dlgBand.deposited) || 0) - existingOpeningTotal)) : 0
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // The restatement trail for the pair currently in the dialog — every set,
  // restate and delete of this opening, so mistakes can be put back.
  useEffect(() => {
    if (!openingOpen || !opening.supplier_id || !opening.product_id) {
      setOpeningLog([])
      return
    }
    let live = true
    window.api.consignment
      .openingLog(Number(opening.supplier_id), Number(opening.product_id))
      .then((r) => { if (live) setOpeningLog(r) })
      .catch(() => {})
    return () => { live = false }
  }, [openingOpen, opening.supplier_id, opening.product_id])

  const key = (r: Row): string => `${r.supplier_id}:${r.product_id}`
  function toggle(k: string): void {
    setOpen((p) => {
      const next = new Set(p)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  // The Opening figure a row shows: the pre-books manual balance when there is
  // no period selected, or the period's computed opening (which already
  // folds that manual balance in, once it is dated before the range) once a
  // range is chosen — same convention as Book Stock's ranged Opening column.
  const openingFor = useCallback(
    (r: Row): number =>
      mncRanged
        ? Number(r.opening) || 0
        : openingLotsFor(r.supplier_id, r.product_id).reduce((s2, l) => s2 + (Number(l.qty) || 0), 0),
    [mncRanged, openingLotsFor]
  )

  // Roll up per supplier — the "MNC" view (all of Bunge's stock with us).
  const byParty = useMemo(() => {
    const m = new Map<string, { name: string; opening: number; deposited: number; invoiced: number; balance: number; rows: Row[] }>()
    for (const r of rows) {
      const k = String(r.supplier_name || '—')
      if (!m.has(k)) m.set(k, { name: k, opening: 0, deposited: 0, invoiced: 0, balance: 0, rows: [] })
      const g = m.get(k)!
      g.opening += openingFor(r)
      g.deposited += Number(r.deposited) || 0
      g.invoiced += Number(r.invoiced) || 0
      g.balance += Number(r.balance) || 0
      g.rows.push(r)
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [rows, openingFor])

  const tot = rows.reduce(
    (s, r) => ({
      deposited: s.deposited + (Number(r.deposited) || 0),
      invoiced: s.invoiced + (Number(r.invoiced) || 0),
      balance: s.balance + (Number(r.balance) || 0)
    }),
    { deposited: 0, invoiced: 0, balance: 0 }
  )
  const totOpening = byParty.reduce((s, g) => s + g.opening, 0)

  // Excel rows: party+product summary, then each of its lots underneath.
  const mncSheetRows = byParty.flatMap((g) =>
    g.rows.flatMap((p) => [
      {
        supplier_name: g.name,
        product_code: p.product_code || p.product_name,
        opening: openingFor(p),
        deposited: p.deposited,
        invoiced: p.invoiced,
        balance: p.balance,
        uom: p.uom,
        is_group: true
      },
      ...lots
        .filter(
          (l) =>
            String(l.supplier_id) === String(p.supplier_id) && String(l.product_id) === String(p.product_id)
        )
        .map((l) => ({
          supplier_name: g.name,
          product_code: p.product_code || p.product_name,
          deposit_date: l.deposit_date,
          tanker_no: l.tanker_no,
          gate_entry_no: l.gate_entry_no,
          weighed_qty: l.weighed_qty,
          shortage_pct: l.shortage_pct,
          deposited: l.qty,
          uom: l.uom,
          invoice_no: l.invoice_no,
          status: Number(l.qty) > 0 ? 'Completed' : 'Pending'
        }))
    ])
  )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MiniStat label="Parties" value={String(byParty.length)} tone="violet" />
        <MiniStat label={mncRanged ? 'Deposited (period)' : 'Deposited'} value={formatNum(tot.deposited)} tone="emerald" />
        <MiniStat label={mncRanged ? 'Invoiced (period)' : 'Invoiced (became ours)'} value={formatNum(tot.invoiced)} tone="rose" />
        <MiniStat label={mncRanged ? 'Closing (supplier owned)' : 'Balance (supplier owned)'} value={formatNum(tot.balance)} tone="violet" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FyPicker from={mncFrom} to={mncTo} onRange={(f, t) => { setMncFrom(f); setMncTo(t) }} className="h-9 w-28 text-xs" />
          <span className="text-[11px] font-semibold text-muted-foreground">From</span>
          <div className="w-40"><DatePicker value={mncFrom} onChange={(v) => setMncFrom(v || '')} max={mncTo || undefined} /></div>
          <span className="text-[11px] font-semibold text-muted-foreground">To</span>
          <div className="w-40"><DatePicker value={mncTo} onChange={(v) => setMncTo(v || '')} min={mncFrom || undefined} /></div>
          {mncRanged && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setMncFrom(''); setMncTo('') }}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openOpeningStock()}>
          <Plus className="h-4 w-4" /> Add opening stock
        </Button>
        <ExcelButton
          filename={mncRanged ? `mnc-consignment-stock-${mncFrom || 'start'}-to-${mncTo || todayISO()}` : `mnc-consignment-stock-${todayISO()}`}
          sheetName="MNC stock"
          title={`MNC / consignment stock${mncRanged ? ` (${mncFrom || 'start'} → ${mncTo || 'today'})` : ''}`}
          columns={[
            { header: 'Party', key: 'supplier_name', value: (r) => r.supplier_name || '' },
            { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
            { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.opening) || 0 },
            { header: 'Deposited', key: 'deposited', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.deposited) || 0 },
            { header: 'Invoiced', key: 'invoiced', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.invoiced) || 0 },
            { header: mncRanged ? 'Closing' : 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.balance) || 0 },
            { header: 'UOM', key: 'uom', value: (r) => r.uom || 'MT' },
            { header: 'Date', key: 'deposit_date', value: (r) => (r.deposit_date ? formatDate(r.deposit_date) : '') },
            { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
            { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
            { header: 'Weighed', key: 'weighed_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.weighed_qty) || 0 },
            { header: 'Short %', key: 'shortage_pct', value: (r) => (Number(r.shortage_pct) > 0 ? `${r.shortage_pct}%` : '') },
            { header: 'Status', key: 'status', value: (r) => r.status || '' },
            { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' }
          ]}
          rows={mncSheetRows}
          isGroup={(r) => !!r.is_group}
          outlineDetail
        />
        </div>
      </div>
      <div className="rounded-xl border bg-card shadow-sm">
        <Table
          wrapperClassName="max-h-[calc(100vh-330px)] rounded-xl"
          className="min-w-[720px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900">Party / product</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">Opening</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Deposited</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-rose-700">Invoiced</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-violet-900">{mncRanged ? 'Closing' : 'Balance'}</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900">UOM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No consignment stock. Log a deposit under Consignment.</TableCell></TableRow>
            ) : (
              <>
                {byParty.map((g) => (
                  <Fragment key={g.name}>
                    <TableRow className="border-y-2 border-violet-300 bg-violet-50 hover:bg-violet-50">
                      <TableCell className="text-[11px] font-bold uppercase tracking-wide text-violet-900">
                        {g.name}
                        <span className="ml-1 font-medium normal-case tracking-normal text-violet-500">· {g.rows.length} product{g.rows.length === 1 ? '' : 's'}</span>
                      </TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-slate-700">{g.opening ? formatNum(g.opening) : '—'}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.deposited)}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.invoiced)}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.balance)}</TableCell>
                      <TableCell />
                    </TableRow>
                    {g.rows.map((r) => {
                      const k = key(r)
                      const isOpen = open.has(k)
                      // `lots` itself stays unranged (openingLotsFor/openingFor
                      // need every opening lot regardless of the picked range,
                      // to keep the "modify opening stock" affordance correct)
                      // — so the date filter is applied here instead, on the
                      // list actually rendered, to match the ranged "Deposited"
                      // total shown on the row above it.
                      const myLots = lots.filter((l) => {
                        if (String(l.supplier_id) !== String(r.supplier_id) || String(l.product_id) !== String(r.product_id)) return false
                        if (!mncRanged) return true
                        const d = String(l.deposit_date || '').slice(0, 10)
                        if (mncFrom && d < mncFrom) return false
                        if (mncTo && d > mncTo) return false
                        return true
                      })
                      const myInvoices = invoices.filter(
                        (v) => String(v.supplier_id) === String(r.supplier_id) && String(v.product_id) === String(r.product_id)
                      )
                      return (
                        <Fragment key={k}>
                          <TableRow className={cn('cursor-pointer border-b', isOpen && 'bg-slate-100')} onClick={() => toggle(k)}>
                            <TableCell className="font-medium">
                              <span className="inline-flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                {r.product_code || r.product_name}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-slate-600">
                              {(() => {
                                const o = openingFor(r)
                                return o ? formatNum(o) : '—'
                              })()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-emerald-700">{formatNum(r.deposited)}</TableCell>
                            <TableCell className="text-right tabular-nums text-rose-700">{Number(r.invoiced) ? formatNum(r.invoiced) : '—'}</TableCell>
                            <TableCell className={cn('text-right font-bold tabular-nums', Number(r.balance) < -1e-9 ? 'text-red-600' : 'text-violet-900')}>{formatNum(r.balance)}</TableCell>
                            <TableCell className="text-muted-foreground">
                              <span className="flex items-center justify-between gap-2">
                                {r.uom || 'MT'}
                                {openingLotFor(r.supplier_id, r.product_id) && (
                                  <button
                                    type="button"
                                    title="Modify the opening stock (validated against what is already drawn)"
                                    className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-slate-200 hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openOpeningStock(r.supplier_id, r.product_id)
                                    }}
                                  >
                                    <SlidersHorizontal className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </span>
                            </TableCell>
                          </TableRow>
                          {isOpen && (
                            <TableRow className="bg-slate-100 hover:bg-slate-100">
                              <TableCell colSpan={6} className="p-0">
                                <div className="space-y-3 px-6 py-3">
                                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-emerald-800">
                                    Deposited — lots received
                                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 tabular-nums text-emerald-900">
                                      {myLots.length}
                                    </span>
                                  </div>
                                  {myLots.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">No deposit lots recorded.</p>
                                  ) : (
                                    <table className="overflow-hidden rounded-lg border border-slate-300 bg-card text-xs shadow-sm [&_td]:pl-3 [&_th]:pl-3">
                                      <thead>
                                        <tr className="border-b bg-slate-200/70 text-left text-slate-700">
                                          <th className="w-8 py-1.5 pr-3 font-semibold">#</th>
                                          <th className="py-1.5 pr-3 font-semibold">Deposit date</th>
                                          <th className="py-1.5 pr-3 font-semibold">Tanker</th>
                                          <th className="py-1.5 pr-3 font-semibold">Gate no</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Weighed</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Short %</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Qty (net)</th>
                                          <th className="py-1.5 pr-3 font-semibold">Status</th>
                                          <th className="py-1.5 pr-3 font-semibold">Note</th>
                                          <th className="w-10 py-1.5 pr-3" />
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {myLots.map((l, li) => (
                                          <tr key={l.id as number} className={cn('border-b', li % 2 === 1 ? 'bg-muted/40' : 'bg-card')}>
                                            <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{li + 1}</td>
                                            <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(l.deposit_date)}</td>
                                            <td className="py-1.5 pr-3 font-medium">
                                              {l.tanker_no ||
                                                (Number(l.is_opening) === 1 ? (
                                                  <span className="text-violet-700">Opening</span>
                                                ) : (
                                                  <span className="text-muted-foreground">—</span>
                                                ))}
                                            </td>
                                            <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{l.gate_entry_no || '—'}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{Number(l.weighed_qty) > 0 ? formatNum(l.weighed_qty) : '—'}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{Number(l.shortage_pct) > 0 ? `${l.shortage_pct}%` : '—'}</td>
                                            <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-emerald-700">{formatNum(l.qty)} {l.uom}</td>
                                            <td className="py-1.5 pr-3">
                                              {Number(l.qty) > 0 ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                  <span className="font-medium text-emerald-700">Completed</span>
                                                  {l.order_id != null && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                      {String(l.invoice_no || 'booked')}
                                                    </span>
                                                  )}
                                                </span>
                                              ) : (
                                                <span className="font-medium text-amber-700">Pending</span>
                                              )}
                                            </td>
                                            <td className="py-1.5 pr-3 text-muted-foreground">{l.note || '—'}</td>
                                            <td className="py-1 pr-2 text-right">
                                              {Number(l.is_opening) === 1 && l.order_id == null && (
                                                <button
                                                  type="button"
                                                  title="Delete this opening lot (kept in history — restorable)"
                                                  className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                                  onClick={async (e) => {
                                                    e.stopPropagation()
                                                    if (!confirm(`Delete the opening lot of ${formatNum(l.qty)} ${l.uom || 'MT'}? Its figure stays in the restatement history.`)) return
                                                    try {
                                                      await window.api.consignment.remove(Number(l.id))
                                                      toast.success('Opening lot deleted — restorable from the opening dialog history')
                                                      await load()
                                                    } catch (err) {
                                                      toast.error((err as Error).message)
                                                    }
                                                  }}
                                                >
                                                  <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  {/* The other half of the movement: the
                                      purchases that took this stock into our
                                      books and reduced the party's balance. */}
                                  <div className="flex items-center gap-2 pt-1 text-[10px] font-bold uppercase tracking-widest text-rose-800">
                                    Invoiced — purchases booked
                                    <span className="rounded bg-rose-100 px-1.5 py-0.5 tabular-nums text-rose-900">
                                      {myInvoices.length}
                                    </span>
                                  </div>
                                  {myInvoices.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      Nothing invoiced{mncRanged ? ' in this period' : ''} — the whole deposit is still the party&apos;s.
                                    </p>
                                  ) : (
                                    <table className="overflow-hidden rounded-lg border border-slate-300 bg-card text-xs shadow-sm [&_td]:pl-3 [&_th]:pl-3">
                                      <thead>
                                        <tr className="border-b bg-slate-200/70 text-left text-slate-700">
                                          <th className="w-8 py-1.5 pr-3 font-semibold">#</th>
                                          <th className="py-1.5 pr-3 font-semibold">Invoice date</th>
                                          <th className="py-1.5 pr-3 font-semibold">Invoice no</th>
                                          <th className="py-1.5 pr-3 font-semibold">Bargain</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Qty invoiced</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Net amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {myInvoices.map((v, vi) => (
                                          <tr key={v.id as number} className={cn('border-b', vi % 2 === 1 ? 'bg-muted/40' : 'bg-card')}>
                                            <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{vi + 1}</td>
                                            <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(v.order_date)}</td>
                                            <td className="py-1.5 pr-3 font-medium">{String(v.invoice_no || '—')}</td>
                                            <td className="py-1.5 pr-3 text-muted-foreground">{String(v.bargain_no || '—')}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                                              {Number(v.invoice_rate) > 0 ? formatNum(v.invoice_rate) : '—'}
                                            </td>
                                            <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-rose-700">
                                              {formatNum(v.ordered_qty)} {v.uom}
                                            </td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums">{formatINR(v.net_amount)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot>
                                        <tr className="border-t bg-muted/60 font-semibold">
                                          <td className="py-1.5 pr-3" colSpan={5}>
                                            {myInvoices.length} invoice{myInvoices.length === 1 ? '' : 's'}
                                          </td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums text-rose-700">
                                            {formatNum(myInvoices.reduce((a, v) => a + (Number(v.ordered_qty) || 0), 0))}
                                          </td>
                                          <td className="py-1.5 pr-3 text-right tabular-nums">
                                            {formatINR(myInvoices.reduce((a, v) => a + (Number(v.net_amount) || 0), 0))}
                                          </td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                ))}
                <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell className="text-[11px] font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totOpening)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.deposited)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.invoiced)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.balance)}</TableCell>
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Consigned stock belongs to the supplier until you invoice it, so it is kept out of your own stock figures above. Deposited − Invoiced = Balance still owned by the party. Booking a consignment purchase against a bargain moves that quantity into your books and reduces this balance automatically. Expand a product to see its deposit lots. Use <span className="font-medium">Add opening stock</span> for what a party already held with you before the books started.
      </p>

      {/* Opening stock for an MNC party — no gate entry, entered by hand */}
      <Dialog open={openingOpen} onOpenChange={(o) => !o && setOpeningOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{existingOpening ? 'Update opening stock' : 'Add opening stock'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>MNC / party *</Label>
                <Select
                  value={String(opening.supplier_id || '')}
                  onValueChange={(v) => setOpening((p) => ({ ...p, supplier_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent>
                    {suppliers.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.name}
                        {x.skip_tanker_stages ? ' · direct' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Product *</Label>
                <Select
                  value={String(opening.product_id || '')}
                  onValueChange={(v) => setOpening((p) => ({ ...p, product_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the product" /></SelectTrigger>
                  <SelectContent>
                    {products.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.code || x.name}
                        {x.category ? ` · ${x.category}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {opening.supplier_id && opening.product_id && (
                <div className="sm:col-span-2">
                  <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2.5 sm:grid-cols-4">
                    {[
                      { l: 'Current opening', v: existingOpening ? `${formatNum(existingOpeningTotal)} ${existingOpening.uom}` : '—', tone: 'text-violet-900' },
                      { l: 'Deposited (all lots)', v: dlgBand ? formatNum(dlgBand.deposited) : '—', tone: 'text-emerald-700' },
                      { l: 'Already drawn', v: dlgBand ? formatNum(dlgDrawn) : '—', tone: 'text-rose-700' },
                      { l: 'Minimum allowed', v: `${formatNum(dlgMin)} ${opening.uom || 'MT'}`, tone: 'text-amber-700' }
                    ].map((x) => (
                      <div key={x.l}>
                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{x.l}</div>
                        <div className={cn('text-[13px] font-semibold tabular-nums', x.tone)}>{x.v}</div>
                      </div>
                    ))}
                  </div>
                  {existingOpenings.length > 1 && (
                    <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                      {existingOpenings.length} opening entries exist — saving merges them into one figure.
                    </p>
                  )}
                  {!existingOpening && openingLog.length > 0 && (
                    <p className="mt-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                      The opening here was removed — its last figure was{' '}
                      <b>
                        {formatNum(openingLog[0].old_qty ?? openingLog[0].new_qty)} {openingLog[0].uom || 'MT'}
                      </b>
                      . Use Restore below to bring it back.
                    </p>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label>Opening quantity *</Label>
                <Input
                  type="number"
                  value={opening.qty ?? ''}
                  placeholder="0.000"
                  onChange={(e) => setOpening((p) => ({ ...p, qty: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>UOM</Label>
                <Select value={String(opening.uom || 'MT')} onValueChange={(v) => setOpening((p) => ({ ...p, uom: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MT">MT</SelectItem>
                    <SelectItem value="KG">KG</SelectItem>
                    <SelectItem value="L">L</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>As on date</Label>
                <DatePicker
                  value={String(opening.deposit_date || '')}
                  onChange={(v) => setOpening((p) => ({ ...p, deposit_date: v }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Note</Label>
                <Input
                  value={opening.note ?? ''}
                  placeholder="Opening stock"
                  onChange={(e) => setOpening((p) => ({ ...p, note: e.target.value }))}
                />
              </div>
            </div>
            {opening.supplier_id && opening.product_id && openingLog.length > 0 && (
              <div className="rounded-lg border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Restatement history — every change is kept
                </div>
                <div className="max-h-36 overflow-auto">
                  {openingLog.map((h) => (
                    <div key={String(h.id)} className="flex items-center gap-2 border-b border-dotted px-3 py-1.5 text-[12px] last:border-0">
                      <span className="w-32 shrink-0 tabular-nums text-muted-foreground">
                        {formatDate(String(h.changed_at).slice(0, 10))}
                      </span>
                      <span
                        className={cn(
                          'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase',
                          h.action === 'delete' ? 'bg-red-100 text-red-700' : h.action === 'create' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'
                        )}
                      >
                        {h.action === 'delete' ? 'Removed' : h.action === 'create' ? 'Created' : 'Restated'}
                      </span>
                      <span className="min-w-0 flex-1 truncate tabular-nums">
                        {h.old_qty != null ? `${formatNum(h.old_qty)} → ` : ''}
                        {h.new_qty != null ? `${formatNum(h.new_qty)} ${h.uom || 'MT'}` : 'removed'}
                      </span>
                      {(h.old_qty != null || h.new_qty != null) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-1.5 text-[11px] text-indigo-700"
                          title="Fill this figure into the form — Save applies it with full validation"
                          onClick={() =>
                            setOpening((prev) => ({
                              ...prev,
                              qty: String(h.action === 'delete' || h.new_qty == null ? h.old_qty : h.old_qty ?? h.new_qty),
                              uom: String(h.uom || prev.uom || 'MT'),
                              deposit_date: String(h.deposit_date || prev.deposit_date || todayISO()).slice(0, 10)
                            }))
                          }
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {openingError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {openingError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpeningOpen(false)} disabled={savingOpening}>Cancel</Button>
            <Button onClick={saveOpeningStock} disabled={savingOpening}>
              {savingOpening ? 'Saving…' : existingOpening ? 'Update opening stock' : 'Add opening stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Move stock from the active (current) company to another company.
function Transfers(): React.JSX.Element {
  const [stock, setStock] = useState<Row[]>([])
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeId, setActiveId] = useState<number>(0)
  const [transfers, setTransfers] = useState<Row[]>([])
  const [form, setForm] = useState<Row>({ product_id: '', to_company_id: '', qty: '', transfer_date: todayISO(), note: '' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [s, cs, active, t] = await Promise.all([
      window.api.stock.list(),
      window.api.company.list(),
      window.api.company.getActive(),
      window.api.stock.transfers()
    ])
    setStock(s)
    setCompanies(cs)
    setActiveId(Number(active.id))
    setTransfers(t)
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  const activeName = companies.find((c) => Number(c.id) === activeId)?.name || 'this company'
  const targets = companies.filter((c) => c.active && Number(c.id) !== activeId)
  const chosen = stock.find((s) => String(s.id) === String(form.product_id))
  const available = chosen ? Number(chosen.stock) || 0 : 0

  async function submit(): Promise<void> {
    if (!form.product_id) return setError('Select a product')
    if (!form.to_company_id) return setError('Select the destination company')
    const qty = Number(form.qty) || 0
    if (qty <= 0) return setError('Enter a quantity greater than zero')
    if (qty > available + 1e-6) return setError(`Only ${formatNum(available)} in stock to transfer`)
    setSaving(true)
    setError(null)
    try {
      await window.api.stock.transfer({
        product_id: Number(form.product_id),
        to_company_id: Number(form.to_company_id),
        qty,
        transfer_date: form.transfer_date,
        note: form.note || null
      })
      toast.success('Stock transferred')
      setForm({ product_id: '', to_company_id: '', qty: '', transfer_date: todayISO(), note: '' })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: Row): Promise<void> {
    if (!window.confirm('Reverse this transfer? The stock returns to the source company.')) return
    try {
      await window.api.stock.deleteTransfer(row.id as number)
      toast.success('Transfer reversed')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-1 font-medium">Transfer stock to another company</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          Moves stock out of <b>{activeName}</b> and into the destination company. This is a physical stock move only — it does not create a sale or any ledger entry.
        </p>
        <div className="grid gap-4 md:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label>Product *</Label>
            <Select value={String(form.product_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}>
              <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
              <SelectContent>
                {stock.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.name} · {formatNum(s.stock)} in stock</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>To company *</Label>
            <Select value={String(form.to_company_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, to_company_id: v }))}>
              <SelectTrigger><SelectValue placeholder="Select company" /></SelectTrigger>
              <SelectContent>
                {targets.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Quantity * {chosen ? `(max ${formatNum(available)})` : ''}</Label>
            <Input type="number" value={form.qty} onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Date</Label>
            <DatePicker value={form.transfer_date || ''} onChange={(v) => setForm((p) => ({ ...p, transfer_date: v }))} />
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-3">
            <Label>Note</Label>
            <Input value={form.note ?? ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
          </div>
          <div className="flex items-end">
            <Button className="w-full" onClick={submit} disabled={saving}>
              <ArrowRightLeft className="h-4 w-4" /> {saving ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>From → To</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfers.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No transfers yet.</TableCell></TableRow>
            ) : (
              transfers.map((t) => (
                <TableRow key={t.id as number}>
                  <TableCell>{formatDate(t.transfer_date)}</TableCell>
                  <TableCell>
                    <Badge variant={t.direction === 'out' ? 'secondary' : 'default'}>
                      {t.direction === 'out' ? 'Out' : 'In'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{t.product_code || t.product_name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.from_company_name} → {t.to_company_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(t.qty)} {t.uom}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">{t.note || '—'}</TableCell>
                  <TableCell className="text-right">
                    {t.direction === 'out' && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => remove(t)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function Stock(): React.JSX.Element {
  const [stockGroup, setStockGroup] = useState<'book' | 'actual'>('book')
  const [tab, setTab] = useState('raw')
  const [rows, setRows] = useState<Row[]>([])
  const [breakdown, setBreakdown] = useState<Record<number, { receipt: Row[]; dispatch: Row[] }>>({})
  const [range, setRange] = useState({ from: '', to: '' })
  const ranged = !!(range.from || range.to)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRangeStock = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRangeStock, 'stock')) setRange({ from: globalRangeStock.from, to: globalRangeStock.to })
  }, [globalRangeStock.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCid, setActiveCid] = useState(0)
  const [cids, setCids] = useState<number[]>([])
  // Per-company rows under each product when more than one company is in view,
  // so the register (and its Excel) says whose stock is whose.
  const [companySplit, setCompanySplit] = useState<Record<number, Row[]>>({})

  const load = useCallback(async () => {
    const sel = cids.length ? cids : undefined
    const [s, b, cs, active] = await Promise.all([
      window.api.stock.list(range.from || range.to ? range : undefined, sel),
      window.api.stock.breakdown(sel, range.from || range.to ? range : undefined),
      window.api.company.list(),
      window.api.company.getActive()
    ])
    setRows(s)
    setBreakdown(b)
    setCompanies(cs)
    setActiveCid(Number(active.id))
    // The split needs one levels call per selected company (2-3 at most).
    if (sel && sel.length > 1) {
      const per = await Promise.all(
        sel.map((id) => window.api.stock.list(range.from || range.to ? range : undefined, [id]))
      )
      const split: Record<number, Row[]> = {}
      per.forEach((list, i) => {
        const cname = String(cs.find((x) => Number(x.id) === sel[i])?.name || `Company ${sel[i]}`)
        for (const r of list) {
          const moved =
            Math.abs(Number(r.opening) || 0) + (Number(r.received) || 0) + (Number(r.produced) || 0) +
            (Number(r.transferred_in) || 0) + (Number(r.transferred_out) || 0) + (Number(r.consumed) || 0) +
            (Number(r.sold) || 0) + Math.abs(Number(r.stock) || 0)
          if (moved < 1e-9) continue
          ;(split[Number(r.id)] ??= []).push({ ...r, company: cname })
        }
      })
      setCompanySplit(split)
    } else {
      setCompanySplit({})
    }
  }, [range, cids])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const byCat = useMemo(() => (cat: string): Row[] => rows.filter((r) => r.category === cat), [rows])
  const companyPicker = (
    <CompanyPicker companies={companies} value={cids} onChange={setCids} activeId={activeCid} />
  )
  // Book Stock's three stages, moved off their own tab strip and into the
  // filter row so the register starts higher up the screen.
  const stagePicker = (
    <Select value={tab} onValueChange={setTab}>
      <SelectTrigger className="h-9 w-44 text-xs font-semibold">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(['raw', 'intermediate', 'finished'] as const).map((k) => (
          <SelectItem key={k} value={k} className="text-xs">
            {CAT_LABEL[k]} ({byCat(k).length})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <>
      <PageHeader title="Stock" subtitle="Live balance per product, and daily book-vs-actual reconciliation" hint="Book balances update automatically (purchases add raw oil, production consumes inputs and adds outputs, sales reduce finished goods). Use Day close to enter the actual physical count each day and see the difference." />
      <div className="p-5">
        {/* Two families: what the books say, and what was physically counted or
            is held for someone else. Switching family lands on its first tab. */}
        <div className="mb-3 inline-flex rounded-lg border p-0.5">
          {([
            { key: 'book', label: 'Book Stock', first: 'raw' },
            { key: 'actual', label: 'Actual Stock', first: 'sku' }
          ] as const).map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => { setStockGroup(g.key); setTab(g.first) }}
              className={cn(
                'rounded-md px-4 py-1.5 text-[13px] font-semibold transition-colors',
                stockGroup === g.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          {stockGroup !== 'book' && (
            <TabsList>
              <TabsTrigger value="sku">Packed SKU</TabsTrigger>
              <TabsTrigger value="mnc">MNC / Consignment</TabsTrigger>
              <TabsTrigger value="transfers">Transfers</TabsTrigger>
              <TabsTrigger value="dayclose">Day close (actual vs book)</TabsTrigger>
            </TabsList>
          )}
          <TabsContent value="raw" className="mt-1">
            <StockTable rows={byCat('raw')} breakdown={breakdown} label="raw" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} />
          </TabsContent>
          <TabsContent value="intermediate" className="mt-1">
            <StockTable rows={byCat('intermediate')} breakdown={breakdown} label="intermediate" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} />
          </TabsContent>
          <TabsContent value="finished" className="mt-1">
            <StockTable rows={byCat('finished')} breakdown={breakdown} label="finished" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} />
          </TabsContent>
          <TabsContent value="sku" className="mt-6">
            <SkuStock />
          </TabsContent>
          <TabsContent value="mnc" className="mt-4">
            <MncStock />
          </TabsContent>
          <TabsContent value="transfers" className="mt-6">
            <Transfers />
          </TabsContent>
          <TabsContent value="dayclose" className="mt-6">
            <DayClose />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
