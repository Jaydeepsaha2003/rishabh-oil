import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRightLeft, Boxes, Building2, CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Eye, EyeOff, Layers, Plus, SlidersHorizontal, TrendingDown, TrendingUp, Trash2, Upload, X } from 'lucide-react'
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
import { InfoTip, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { errText, formatDate, formatDateShort, formatINR, formatNum, todayISO } from '@/lib/format'
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
// number per SKU per day and nothing about how it got there -- a dispatch of
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

// The unit a packed SKU is counted in -- its Type in the Packed SKU master.
// Every quantity this screen stores, shows and accepts is a count of THESE,
// so it is the only unit named anywhere on it. The master's outer/case level
// is deliberately not shown: restating a count as cases put a second unit in
// front of people who had only ever entered the first, and where a SKU's
// per-case figure disagrees with its Type the case number was plain wrong.
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

// Pack size → MT per piece. Litres are treated 1 L ≈ 1 KG (the mill's dispatch
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

// One figure on a strip: label, number, and the unfiltered total when the
// number above is a subtotal.
//
// It replaces a card. Three cards across a 1,800px page gave "PACKED IN 0" a
// 590px box, which is not emphasis — it is distance. On one strip the same
// three figures are read in a glance instead of a sweep.
function Figure({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: string
  hint?: string
  tone: string
}): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('text-[14px] font-bold tabular-nums', tone)}>{value}</span>
      {hint && <span className="text-[10.5px] tabular-nums text-muted-foreground">{hint}</span>}
    </span>
  )
}

// A number cell that reveals a party-wise breakdown on hover.
function PartyCell({
  value,
  parties,
  uom,
  tone,
  caption
}: {
  value: number
  parties: Row[]
  uom?: string
  tone?: string
  // Named above the lines when the breakdown is not "who did we trade with" —
  // the packing hover lists SKUs, and a list of SKUs with no heading reads like
  // a list of customers.
  caption?: string
}): React.JSX.Element {
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
            {caption && (
              <div className="mb-1 border-b border-white/25 pb-1 text-[10px] font-bold uppercase tracking-wider opacity-80">
                {caption}
              </div>
            )}
            {parties.map((p, i) => (
              <div key={i} className={cn('flex justify-between gap-4', p.isReturn && 'opacity-90')}>
                <span className={cn(p.isReturn && 'italic')}>{p.party}</span>
                <span className={cn('tabular-nums font-medium', Number(p.qty) < 0 && 'text-rose-300')}>
                  {/* Pieces first when the line carries them: that is the figure
                      on the packing sheet, and the tonnage is derived from it. */}
                  {p.pieces != null && (
                    <span className="mr-2 font-normal opacity-70">{formatNum(Math.abs(Number(p.pieces) || 0))} pcs</span>
                  )}
                  {Number(p.qty) < 0 ? '−' : ''}{formatNum(Math.abs(Number(p.qty) || 0))} {uom || 'MT'}
                </span>
              </div>
            ))}
            {/* A multi-SKU breakdown is worth totalling; a single line is not. */}
            {caption && parties.length > 1 && (
              <div className="mt-1 flex justify-between gap-4 border-t border-white/25 pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">
                  <span className="mr-2 font-normal opacity-70">
                    {formatNum(parties.reduce((t, p) => t + (Number(p.pieces) || 0), 0))} pcs
                  </span>
                  {formatNum(parties.reduce((t, p) => t + (Number(p.qty) || 0), 0))} {uom || 'MT'}
                </span>
              </div>
            )}
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

function StockTable({ rows: allRows, breakdown, label = 'stock', range, onRange, companyPicker, companySplit = {}, stagePicker, companyIds = [], openingFrom = '' }: { rows: Row[]; breakdown: Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[] }>; label?: string; range: { from: string; to: string }; onRange: (r: { from: string; to: string }) => void; companyPicker?: React.ReactNode; companySplit?: Record<number, Row[]>; stagePicker?: React.ReactNode; companyIds?: number[]; openingFrom?: string }): React.JSX.Element {
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
    packed_out: sum('packed_out'),
    sold: sum('sold'),
    stock: sum('stock')
  }
  const negatives = rows.filter((r) => Number(r.stock) < -1e-9).length
  const inFlow = totals.received + totals.produced + totals.transferred_in
  const outFlow = totals.consumed + totals.sold + totals.transferred_out + totals.packed_out
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
    { header: 'Packed', key: 'packed_out', align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => Number(r.packed_out) || 0 },
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
        packed_out: x.packed_out,
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
      {/* A From earlier than the opening changes nothing here, so say so
          rather than leaving the reader to wonder why the figures did not
          move. The count superseded whatever came before it — that is what
          striking an opening means. */}
      {!!openingFrom && (!range.from || range.from < openingFrom) && (
        <span
          className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10.5px] font-semibold text-amber-900"
          title={`The opening stock was counted on ${formatDate(openingFrom)}, and a counted tank already accounts for everything bought and consumed before it. So the register starts there whatever From says — reaching back earlier would count those movements a second time. They are still on their own documents: the purchase, the dispatch, the production run.`}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          register begins {formatDate(openingFrom)}
          <button
            type="button"
            className="ml-0.5 underline underline-offset-2 hover:no-underline"
            onClick={() => onRange({ ...range, from: openingFrom })}
          >
            set From
          </button>
        </span>
      )}
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
              <Table className="ruled-slate min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">
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
                      <TableCell className="text-right tabular-nums text-rose-700">{Number(r.consumed) ? formatNum(r.consumed) : '—'}</TableCell>
                      {/* Oil drawn out of the tank to be packed into SKUs. It is
                          the answer to "the DALDA left but nobody sold it" —
                          without the column the tonnage simply vanishes, and
                          without the hover you cannot see which SKUs took it. */}
                      <PartyCell
                        value={Number(r.packed_out)}
                        parties={breakdown[r.id as number]?.packed || []}
                        tone="text-rose-700"
                        caption="Packed into"
                      />
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
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('consumed'))}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums text-teal-900">{formatNum(gSum('packed_out'))}</TableCell>
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
            <Table className="ruled-slate min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
              <TableBody>
                <TableRow className="bg-amber-100 hover:bg-amber-100">
                  <TableCell className="text-[11px] font-bold uppercase tracking-wide text-amber-900">
                    Grand total across every category
                  </TableCell>
                  {ranged && <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.opening)}</TableCell>}
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.received)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.produced)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.consumed)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.packed_out)}</TableCell>
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
    { l: 'Consumed', r: true, tone: 'text-rose-700' },
    { l: 'Packed', r: true, tone: 'text-rose-700' },
    { l: 'Dispatch', r: true, tone: 'text-rose-700' },
    { l: ranged ? 'Closing' : 'In stock', r: true, tone: 'text-sky-800' }
  ]
}

// ---------------------------------------------------------------------------
// Opening stock: what was in the tanks the morning the books begin.
//
// Book stock here is derived entirely from movements, so a mill that has been
// trading for years but whose books start on a date opens every product at
// nothing — and every gram consumed since reads as stock it never had. That is
// why thirteen products close negative, IVF worst at -532.7 MT. This screen is
// how that is answered, and every later reconciliation stands on it.
//
// The screen is built around the number that actually decides whether the
// entry is right: the CLOSING the register will show once the opening is
// applied. Typing a quantity and being told "still short 412.7" is the whole
// job; a bare list of empty boxes would leave the storekeeper guessing.
// ---------------------------------------------------------------------------
// Switching company remounts every page — App keys <main> on the active
// company so every screen refetches. That is what we want for the data, but it
// also resets which Stock view was open, and a reader who switched company
// FROM the opening sheet wants the other company's opening sheet, not the
// register. The switcher leaves this one-shot note behind; Stock honours it
// once on mount and clears it.
const RESUME_OPENING = 'stock.resumeOpening'

function OpeningStock({
  companies,
  onCompanyChange
}: {
  companies: Row[]
  onCompanyChange?: (id: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  // An opening is counted in three parts, the way the plant counts it: what is
  // in the tank (Raw), what is already in process (PP / WIP), and the
  // correction between the dip and the stock card (Adj). The register opens at
  // the TOTAL of all three, and the Day close screen shows that same total as
  // the physical count for the opening date.
  //
  // Adj is signed. It exists so a disagreement can be stated without editing
  // the figure that was actually measured — oil sitting in a line rather than
  // a vessel, a drum counted twice, a dip that reads short of the card.
  const [draft, setDraft] = useState<Record<number, { qty: string; pp: string; adj: string; rate: string; note: string }>>({})
  const [asOf, setAsOf] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // No filter tab. One sheet, every product, worked top to bottom.
  //
  // It used to open on a "Needs an answer" tab whose count (products already
  // below zero) never matched the rows on screen, because rows already filled
  // in were kept visible too. Two tabs, a count that disagreed with the list,
  // and a sheet that changed shape as it was worked down — for a screen whose
  // whole job is "go through the products and type what was in the tank".
  // Products that still need an opening carry a Short badge on the row, which
  // is where the reader is already looking.
  const [search, setSearch] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const d = await window.api.stockOpening.list()
      setData(d)
      setAsOf(String(d.as_of || d.books_from || ''))
      const next: Record<number, { qty: string; pp: string; adj: string; rate: string; note: string }> = {}
      for (const r of (d.rows as Row[]) || []) {
        next[Number(r.id)] = {
          qty: r.qty == null ? '' : String(r.qty),
          pp: r.pp_qty == null || Number(r.pp_qty) === 0 ? '' : String(r.pp_qty),
          adj: r.adj_qty == null || Number(r.adj_qty) === 0 ? '' : String(r.adj_qty),
          rate: r.rate == null ? '' : String(r.rate),
          note: r.note == null ? '' : String(r.note)
        }
      }
      setDraft(next)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  useLiveRefresh(load)

  const rows: Row[] = useMemo(() => ((data?.rows as Row[]) || []), [data])

  // What the register will close at for a row, given what is typed right now.
  // The opening a row contributes: Raw + PP + Adj together.
  const openingOf = useCallback(
    (id: number): number => {
      const d = draft[id]
      if (!d) return 0
      return (Number(d.qty) || 0) + (Number(d.pp) || 0) + (Number(d.adj) || 0)
    },
    [draft]
  )
  // Any one of the three is an answer. An adjustment on its own is a real
  // statement about a product whose tank genuinely opened at nothing.
  const answeredOf = useCallback(
    (id: number): boolean => {
      const d = draft[id]
      return !!d && (d.qty !== '' || d.pp !== '' || d.adj !== '')
    },
    [draft]
  )

  const projected = useCallback(
    (r: Row): number => Number(r.movement_closing) + openingOf(Number(r.id)),
    [openingOf]
  )

  const setField = (id: number, key: 'qty' | 'pp' | 'adj' | 'rate' | 'note', value: string): void => {
    setDraft((p) => ({
      ...p,
      [id]: {
        qty: p[id]?.qty ?? '',
        pp: p[id]?.pp ?? '',
        adj: p[id]?.adj ?? '',
        rate: p[id]?.rate ?? '',
        note: p[id]?.note ?? '',
        [key]: value
      }
    }))
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (q && !String(r.name || '').toLowerCase().includes(q) && !String(r.code || '').toLowerCase().includes(q)) {
        return false
      }
      return true
    })
  }, [rows, search])

  const stats = useMemo(() => {
    let entered = 0
    let value = 0
    let stillShort = 0
    let raw = 0
    let pp = 0
    let adj = 0
    for (const r of rows) {
      const id = Number(r.id)
      const d = draft[id]
      if (answeredOf(id)) {
        entered++
        value += openingOf(id) * (Number(d?.rate) || 0)
        raw += Number(d?.qty) || 0
        pp += Number(d?.pp) || 0
        adj += Number(d?.adj) || 0
      }
      if (projected(r) < -0.0005) stillShort++
    }
    return { entered, value, stillShort, raw, pp, adj, total: raw + pp + adj }
  }, [rows, draft, projected, answeredOf, openingOf])

  const dirty = useMemo(() => {
    for (const r of rows) {
      const d = draft[Number(r.id)] || { qty: '', pp: '', adj: '', rate: '', note: '' }
      const wasQty = r.qty == null ? '' : String(r.qty)
      const wasPp = r.pp_qty == null || Number(r.pp_qty) === 0 ? '' : String(r.pp_qty)
      const wasAdj = r.adj_qty == null || Number(r.adj_qty) === 0 ? '' : String(r.adj_qty)
      const wasRate = r.rate == null ? '' : String(r.rate)
      const wasNote = r.note == null ? '' : String(r.note)
      if (d.qty !== wasQty || d.pp !== wasPp || d.adj !== wasAdj || d.rate !== wasRate || d.note !== wasNote) {
        return true
      }
    }
    return false
  }, [rows, draft])

  async function save(): Promise<void> {
    if (!asOf) return void toast.error('Pick the date this opening is struck on')
    setSaving(true)
    try {
      const payload = rows.map((r) => ({
        product_id: Number(r.id),
        qty: draft[Number(r.id)]?.qty ?? '',
        pp_qty: draft[Number(r.id)]?.pp ?? '',
        adj_qty: draft[Number(r.id)]?.adj ?? '',
        rate: draft[Number(r.id)]?.rate ?? '',
        note: draft[Number(r.id)]?.note ?? ''
      }))
      const res = await window.api.stockOpening.save(payload, asOf)
      toast.success(
        `Opening stock saved — ${res.saved} ${res.saved === 1 ? 'product' : 'products'}` +
          (res.cleared ? `, ${res.cleared} cleared` : '')
      )
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  // Whose tanks these are. Taken from the payload rather than a separate
  // lookup, so the name on screen is the company the save will actually write
  // into — the two cannot disagree.
  const cid = Number(data?.company_id || 0)
  // Only companies still in use can be switched to, same as the sidebar: this
  // makes one active, and reviving a closed company is not a stock decision.
  const switchable = useMemo(() => companies.filter((c) => c.active), [companies])

  // Switching discards this sheet and rebuilds it for the other company, so
  // anything typed and unsaved would go with it. Say so before it happens.
  function switchTo(v: string): void {
    if (!onCompanyChange || Number(v) === cid) return
    if (
      dirty &&
      !window.confirm(
        'Switch company? The figures typed on this sheet are not saved yet, and switching discards them.'
      )
    ) {
      return
    }
    try {
      sessionStorage.setItem(RESUME_OPENING, '1')
    } catch {
      // no storage on this device — the reader lands on the register instead
    }
    onCompanyChange(v)
  }

  // The one thing worth saying about the struck-on date, if anything at all:
  // it is not set, the ledger has no start of its own to agree with, or the two
  // disagree. Resolved here so the banner shows a single footer line rather
  // than three conditional blocks stacked beside the field.
  const dateNote = useMemo((): { text: string; tip: string } | null => {
    if (!asOf) {
      return {
        text: 'Pick this date first',
        tip: 'This is the morning the books officially begin. Nothing before it is reconciled against these figures, and every register opens its default period from this day — so it has to be set before an opening can be saved.'
      }
    }
    const from = data?.books_from ? String(data.books_from).slice(0, 10) : ''
    if (!from) {
      return {
        text: 'Ledger start not set',
        tip: 'The ledger has no start date set yet (Accounts → Opening balances). Pick the morning the tanks were counted — ideally the same day the accounts begin, so stock and the ledger agree about when the books open.'
      }
    }
    if (from !== asOf) {
      return {
        text: `Ledger begins ${formatDate(from)}`,
        tip: 'Stock and the ledger normally open on the same morning. A different date here is allowed — a mill may dip its tanks on another day — but the two figures then describe two different moments.'
      }
    }
    return null
  }, [asOf, data])

  const clashes = (data?.name_clashes as Row[]) || []

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Reading the register…</div>
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- banner --
          One band carrying the title, the date the opening is struck on, and
          the four figures — instead of four stacked blocks.

          The prose that used to sit here now lives behind the (i). Four lines
          explaining WHY are worth reading once; after that they are four lines
          between the reader and the work. */}
      <div className="overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-6 py-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/20">
            <Layers className="h-5 w-5 text-white" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[16px] font-bold leading-tight text-white">Stock brought forward</h3>
              <InfoTip
                className="text-white/60 hover:text-white"
                text="The register works out every balance from movements — purchases in, production, dispatches out. Anything already in the tanks before the books opened was never a movement, so it has to be told once. Until it is, oil consumed since that morning reads as stock the mill never had, which is what puts a product below zero."
              />
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-white/65">
              What was in the tanks the morning the books began.
            </p>
          </div>

          {/* The two settings everything on this screen hangs on — whose tanks,
              and which morning — grouped in their own panel as proper labelled
              fields. They used to run along the same row as the title with
              their labels beside them and a caption stacked under each, four
              text runs deep in the space of one. */}
          <div className="shrink-0 rounded-xl bg-white/[0.08] p-3.5 ring-1 ring-inset ring-white/15">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              {!!onCompanyChange && !!cid && switchable.length > 1 && (
                <>
                  <div>
                    <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55">
                      Counting for
                      <InfoTip
                        className="text-white/45 hover:text-white"
                        text="Whose tanks are being counted. Each company keeps its own opening — one company's figures are never read into another's register. Switching here switches the whole app, exactly as the sidebar does."
                      />
                    </div>
                    <Select value={String(cid)} onValueChange={switchTo}>
                      <SelectTrigger
                        title="Switch company"
                        className="h-10 w-[15rem] border-white/20 bg-white/10 text-[13px] font-semibold text-white hover:bg-white/20 [&>svg]:opacity-70"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Building2 className="h-4 w-4 shrink-0 text-white/60" />
                          <SelectValue placeholder="Select company" />
                        </span>
                      </SelectTrigger>
                      <SelectContent className="min-w-[15rem]">
                        {switchable.map((c) => (
                          <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="h-10 w-px self-end bg-white/15" />
                </>
              )}
              <div>
                <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55">
                  <span>Struck on <span className="text-amber-300">*</span></span>
                  <InfoTip
                    className="text-white/45 hover:text-white"
                    text="The morning the books officially begin. Nothing before it is reconciled against these figures, and every register opens its default period from this day."
                  />
                </div>
                <div
                  className={cn(
                    'w-[11.5rem] [&_button]:h-10 [&_button]:text-[13px] [&_button]:font-semibold [&_button]:text-white [&_button:hover]:bg-white/20',
                    asOf
                      ? '[&_button]:border-white/20 [&_button]:bg-white/10'
                      : '[&_button]:border-amber-300 [&_button]:bg-amber-400/20'
                  )}
                >
                  <DatePicker value={asOf} onChange={setAsOf} />
                </div>
              </div>
            </div>

            {/* One footer for the notes those fields used to carry stacked
                underneath them — the warning, if there is one, first. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] leading-snug">
              {!!dateNote && (
                <>
                  <span className="flex items-center gap-1 font-semibold text-amber-200">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {dateNote.text}
                    <InfoTip className="text-amber-200/70 hover:text-amber-100" text={dateNote.tip} />
                  </span>
                  <span className="text-white/25">·</span>
                </>
              )}
              <span className="text-white/50">every register opens from this day</span>
            </div>
          </div>
        </div>

        {/* The figures those settings produce. Four cells, not five: the two
            below-zero counts are one question asked twice — how many were
            short, how many still are — so they read as a movement rather than
            as two unrelated numbers. Each cell now has room for its value AND
            a line of small print saying what the value is made of, which is
            what the long uppercase labels were straining to do on their own.

            The grid's own gap draws the dividers, so they land correctly at
            every breakpoint instead of only at the widest one. */}
        <div className="grid grid-cols-2 gap-px border-t border-[#d9d2b8] bg-[#e6dfc4] lg:grid-cols-4">
          {[
            {
              label: 'Opening total',
              tip: 'The tank figure plus the work already in process. The register opens at this total, and the Day close screen shows the same total as the physical count for this date.',
              value: <span className="text-[#1a2c56]">{formatNum(stats.total)}</span>,
              note:
                `${formatNum(stats.raw)} raw + ${formatNum(stats.pp)} in process` +
                (Math.abs(stats.adj) > 0.0005
                  ? ` ${stats.adj < 0 ? '−' : '+'} ${formatNum(Math.abs(stats.adj))} adjusted`
                  : '')
            },
            {
              label: 'Answered',
              tip: 'How many products have an opening entered — Raw or PP counts. A blank is not the same as zero: blank means not yet counted and stays off the register entirely.',
              value: (
                <span
                  className={cn(
                    stats.entered === 0
                      ? 'text-amber-700'
                      : stats.entered === rows.length
                        ? 'text-emerald-700'
                        : 'text-[#1a2c56]'
                  )}
                >
                  {stats.entered}
                  <span className="text-[15px] font-semibold text-muted-foreground"> / {rows.length}</span>
                </span>
              ),
              note: (
                <span className="block">
                  <span className="mb-1.5 flex h-1.5 overflow-hidden rounded-full bg-[#e6dfc4]">
                    <span
                      className={cn(
                        'h-full rounded-full transition-all',
                        stats.entered === rows.length ? 'bg-emerald-500' : 'bg-[#2c4a8c]'
                      )}
                      style={{ width: `${rows.length ? Math.round((stats.entered / rows.length) * 100) : 0}%` }}
                    />
                  </span>
                  {rows.length - stats.entered > 0
                    ? `${rows.length - stats.entered} still blank`
                    : 'every product counted'}
                </span>
              )
            },
            {
              label: 'Below zero',
              tip: 'Products the register would carry as a negative balance. The first number counts them on movements since the opening date alone — each has been consumed or dispatched more than it was booked in, which is the hole an opening figure is here to fill. The second counts how many would STILL close negative with what is typed right now, and is the one to drive to nil.',
              value: (
                <span className="flex items-baseline gap-2">
                  <span className={cn(Number(data?.negative_count) ? 'text-rose-700' : 'text-emerald-700')}>
                    {Number(data?.negative_count ?? 0)}
                  </span>
                  <span className="text-[15px] font-normal text-muted-foreground">→</span>
                  <span className={cn(stats.stillShort ? 'text-rose-700' : 'text-emerald-700')}>
                    {stats.stillShort}
                  </span>
                </span>
              ),
              note: 'to begin with → with what is typed'
            },
            {
              label: 'Opening value',
              tip: '(Raw + PP) × rate, summed. Only needed if the opening is to be posted to the ledger as well as the stock register; leave the rates blank otherwise.',
              value: <span className="text-[#1a2c56]">{formatINR(stats.value)}</span>,
              note: stats.value > 0 ? 'what the ledger would open at' : 'rates are optional — leave them blank to skip'
            }
          ].map((k) => (
            <div key={k.label} className="bg-[#fffdf4] px-5 py-4">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {k.label}
                </span>
                <InfoTip text={k.tip} />
              </div>
              <div className="mt-1.5 text-[22px] font-bold leading-none tabular-nums">{k.value}</div>
              <div className="mt-2 text-[10.5px] leading-snug text-muted-foreground">{k.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* --------------------------------------------------- name clashes --
          One line per clash. The paragraph explaining what a clash means, and
          why merging would be wrong, is behind the (i) — it is the same
          sentence every time and does not need re-reading on every visit. */}
      {clashes.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2">
          <span className="flex items-center gap-1.5 text-[12px] font-bold text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5" />
            {clashes.length === 1 ? 'One product name is' : `${clashes.length} product names are`} used twice
            <InfoTip
              className="text-amber-700 hover:text-amber-950"
              text="Where the categories differ these are two DIFFERENT products that happen to share a name — a raw oil and the finished oil made from it. They must not be merged: that would collapse what the mill buys into what it makes. Give one of each pair a clearer name so this sheet, and every report, can tell them apart."
            />
          </span>
          {clashes.map((cl) => (
            <span
              key={String(cl.key)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-0.5 text-[11px]"
              title={`ids ${(cl.ids as number[]).join(' and ')}`}
            >
              <span className="font-semibold text-amber-900">{String(cl.names?.[0] ?? cl.key)}</span>
              <span className="text-muted-foreground">
                {(cl.categories as string[]).map((x) => CAT_LABEL[x] || x || '—').join(' · ')}
              </span>
              {!cl.same_category && (
                <Badge variant="warning" className="text-[10px]">Different goods</Badge>
              )}
            </span>
          ))}
        </div>
      )}

      {/* --------------------------------------------------------- filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#e0d8bd] bg-white px-4 py-3 shadow-sm">
        <Input
          placeholder="Find a product…"
          className="h-10 w-64 text-[13px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* A statement of where the sheet stands, not a control. */}
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-semibold text-[#1a2c56]">
            {stats.entered} of {rows.length} filled in
          </span>
          {(() => {
            const need = rows.filter((r) => Number(r.shortfall) > 0.0005 && !answeredOf(Number(r.id))).length
            return need ? (
              <span className="rounded-md bg-rose-100 px-2 py-0.5 font-semibold text-rose-800">
                {need} still short
              </span>
            ) : (
              <span className="rounded-md bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                nothing short
              </span>
            )
          })()}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="flex items-center gap-1.5 rounded-md bg-amber-100 px-2.5 py-1 text-[11.5px] font-semibold text-amber-900">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Unsaved changes
            </span>
          )}
          <Button onClick={save} disabled={saving || !dirty} className="h-10 bg-[#1a2c56] px-5 hover:bg-[#24407e]">
            {saving ? 'Saving…' : 'Save opening stock'}
          </Button>
        </div>
      </div>

      {/* ---------------------------------------------------------- sheet */}
      {(['raw', 'intermediate', 'finished'] as const).map((cat) => {
        const catRows = shown.filter((r) => String(r.category) === cat)
        if (!catRows.length) return null
        return (
          <div key={cat} className="overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#d9d2b8] bg-[#f1ecd9] px-4 py-2.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                {CAT_LABEL[cat]}
              </span>
              <span className="flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
                {/* What this section still owes, so a long sheet can be worked
                    section by section rather than only in total. */}
                {(() => {
                  const short = catRows.reduce(
                    (t, r) => t + Math.max(0, -(Number(r.movement_closing) + Number(draft[Number(r.id)]?.qty || 0))),
                    0
                  )
                  return short > 0.0005 ? (
                    <span className="font-semibold text-rose-700">still short {formatNum(short)}</span>
                  ) : (
                    <span className="font-semibold text-emerald-700">nothing short</span>
                  )
                })()}
                <span>
                  {catRows.length} {catRows.length === 1 ? 'product' : 'products'}
                </span>
              </span>
            </div>
            {/* w-full alone let the browser squeeze nine columns into
                whatever width it had, so on a laptop the figures crushed
                together instead of scrolling. A minimum width makes the card
                slide sideways instead — it still fills a wide screen, and the
                Note column takes any slack there is. */}
            <div className="overflow-x-auto">
              <table className="ruled-cols w-full min-w-[1200px] bg-[#fffdf4] text-[13px]">
                <thead>
                  <tr className="border-b border-[#e0d8bd] bg-[#faf6e8] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                    <th className="pin-col min-w-[190px] px-3 py-2">Product</th>
                    <th className="w-[110px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Moved since
                        <InfoTip text="Everything that has happened to this product SINCE the opening date — received, produced, consumed, sold, packed. Movements before that date are deliberately left out: that morning is the fresh start. They are still in the Book Stock register if you widen the period by hand. Negative here is exactly the hole the opening has to fill." />
                      </span>
                    </th>
                    <th className="w-[150px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Raw
                        <InfoTip text="What was physically in the tanks that morning. Leave it blank if it has not been counted yet; enter 0 to state that it genuinely opened at nothing. The two are different, and only the second shows on the register." />
                      </span>
                    </th>
                    <th className="w-[110px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        PP (WIP)
                        <InfoTip text="Work already in process that morning — in the refinery, in a tanker on site, packed but not yet counted as finished. Counted separately from the tank, and the register opens at Raw + PP + Adj." />
                      </span>
                    </th>
                    <th className="w-[110px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Adj. MT
                        <InfoTip text="The correction between what was counted and what the stock card says — signed, so −2 takes two off the opening and +2 adds two. It is here so a disagreement can be stated without editing the figure that was actually measured: oil in a line rather than a vessel, a drum counted twice, a dip reading short of the card. It counts into the Total exactly like Raw and PP do." />
                      </span>
                    </th>
                    <th className="w-[100px] bg-[#f4efdd] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Total
                        <InfoTip text="Raw + PP + Adj. This is the figure the register actually opens at, and the same figure the Day close screen shows as the physical count for the opening date." />
                      </span>
                    </th>
                    <th className="w-[140px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Rate
                        <InfoTip text="Cost per unit, needed only if the opening is to carry a value as well as a quantity. The chip beside the box offers the weighted-average cost the register already uses for this product." />
                      </span>
                    </th>
                    <th className="w-[130px] px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        Closes at
                        <InfoTip text="Total + everything moved since the opening date — what the register will read once this is saved. This is the figure that decides whether the entry is right: drive it to nil or above." />
                      </span>
                    </th>
                    <th className="min-w-[160px] px-3 py-2 text-left">
                      <span className="inline-flex items-center gap-1">
                        Note
                        <InfoTip text="Why this row reads the way it does — which tank was dipped, who counted it, what the adjustment is for. It is saved with the opening and is the only place that reasoning survives; a figure with no explanation is one nobody can check a year later. A note needs a figure to hang on: a row with a note but no Raw, PP or Adj is not an opening, so it is not kept." />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catRows.map((r) => {
                    const id = Number(r.id)
                    const d = draft[id] || { qty: '', pp: '', adj: '', rate: '', note: '' }
                    const proj = projected(r)
                    const short = Number(r.shortfall)
                    const answered = answeredOf(id)
                    const rowTotal = openingOf(id)
                    return (
                      <tr
                        key={id}
                        className={cn(
                          'border-t border-[#f0ead2] transition-colors hover:bg-[#fbf6e4]',
                          // row-answered is read by .pin-col in main.css, which
                          // has to repaint the tint opaquely — see the note there.
                          answered && 'row-answered bg-emerald-50/40'
                        )}
                      >
                        <td className="pin-col px-3 py-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {/* A tick beside what is done, so a long sheet shows
                                its own progress as it is worked down. */}
                            {answered ? (
                              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            ) : (
                              <span className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span className="font-medium text-[#1a2c56]">{String(r.name)}</span>
                            {r.code ? (
                              <span className="doc-ref rounded bg-[#f1ecd9] px-1.5 text-[10.5px] text-muted-foreground">
                                {String(r.code)}
                              </span>
                            ) : null}
                            {short > 0.0005 && !answered && (
                              <Badge variant="destructive" className="text-[10px]">Short</Badge>
                            )}
                          </div>
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap px-3 py-1.5 text-right tabular-nums',
                            Number(r.movement_closing) < -0.0005 ? 'font-semibold text-rose-700' : 'text-muted-foreground'
                          )}
                        >
                          {formatNum(r.movement_closing)}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* The shortfall is the smallest opening that clears the
                                negative — offered, never applied on its own, because it
                                is a floor and not a count. */}
                            {short > 0.0005 && !answered && (
                              <button
                                type="button"
                                title={`Fill the ${formatNum(short)} needed to reach zero — then correct it to the counted figure`}
                                className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-800 hover:bg-sky-100"
                                onClick={() => setField(id, 'qty', String(short))}
                              >
                                {formatNum(short)}
                              </button>
                            )}
                            <input
                              inputMode="decimal"
                              className="doc-ref h-8 w-[84px] rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                              value={d.qty}
                              onChange={(e) => setField(id, 'qty', e.target.value.replace(/[^0-9.]/g, ''))}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end">
                            <input
                              inputMode="decimal"
                              placeholder="0"
                              className="doc-ref h-8 w-[84px] rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                              value={d.pp}
                              onChange={(e) => setField(id, 'pp', e.target.value.replace(/[^0-9.]/g, ''))}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end">
                            {/* The only quantity box on this sheet that takes a
                                minus sign — a correction that takes stock OFF
                                the count is the ordinary case, so the filter
                                has to let one through. */}
                            <input
                              inputMode="decimal"
                              placeholder="0"
                              className={cn(
                                'doc-ref h-8 w-[84px] rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20',
                                (Number(d.adj) || 0) < 0 && 'text-rose-700'
                              )}
                              value={d.adj}
                              onChange={(e) =>
                                setField(
                                  id,
                                  'adj',
                                  e.target.value.replace(/[^0-9.-]/g, '').replace(/(?!^)-/g, '')
                                )
                              }
                            />
                          </div>
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap bg-[#faf6e8] px-3 py-1.5 text-right font-semibold tabular-nums',
                            answered ? 'text-[#1a2c56]' : 'text-muted-foreground/60'
                          )}
                        >
                          {answered ? formatNum(rowTotal) : '—'}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {Number(r.suggested_rate) > 0 && d.rate === '' && (
                              <button
                                type="button"
                                title="Weighted-average cost the register already values this product at"
                                className="shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted"
                                onClick={() => setField(id, 'rate', String(r.suggested_rate))}
                              >
                                {formatNum(r.suggested_rate)}
                              </button>
                            )}
                            <input
                              inputMode="decimal"
                              className="doc-ref h-8 w-[92px] rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                              value={d.rate}
                              onChange={(e) => setField(id, 'rate', e.target.value.replace(/[^0-9.]/g, ''))}
                            />
                          </div>
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums',
                            proj < -0.0005 ? 'text-rose-700' : answered ? 'text-emerald-700' : 'text-muted-foreground'
                          )}
                        >
                          {formatNum(proj)}
                          {proj < -0.0005 ? (
                            <div className="text-[10.5px] font-normal text-rose-600">
                              still short {formatNum(-proj)}
                            </div>
                          ) : answered ? (
                            <div className="text-[10.5px] font-normal text-emerald-600">accounted for</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            className="h-8 w-full min-w-[140px] rounded-md border bg-white px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                            placeholder={
                              (Number(d.adj) || 0) !== 0 ? 'why the adjustment?' : 'tank, counter, anything worth recording'
                            }
                            value={d.note}
                            onChange={(e) => setField(id, 'note', e.target.value)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {!shown.length && (
        <div className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground">
          No product matches that search.
        </div>
      )}

      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        Blank means <b>not yet counted</b>; <span className="doc-ref">0</span> means it genuinely
        opened at nothing. Hover any heading for what it holds.
      </p>
    </div>
  )
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
  // The sheet is one day by nature — you cannot type a week's count into it —
  // so a range cannot narrow the sheet. What a range IS good for is the run of
  // closings: whether every day this month was closed, and where the
  // differences fell. That is a panel of its own, and picking a day in it jumps
  // the sheet to that day.
  const [histOpen, setHistOpen] = useState(false)
  const [histFrom, setHistFrom] = useState(() => `${todayISO().slice(0, 8)}01`)
  const [histTo, setHistTo] = useState(todayISO())
  const [hist, setHist] = useState<Row[] | null>(null)
  const [histBusy, setHistBusy] = useState(false)
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

  const loadHistory = useCallback(async () => {
    setHistBusy(true)
    try {
      setHist(await window.api.stockCount.history(histFrom, histTo))
    } catch (e) {
      toast.error(errText(e))
      setHist([])
    } finally {
      setHistBusy(false)
    }
  }, [histFrom, histTo])

  useEffect(() => {
    if (histOpen) void loadHistory()
  }, [histOpen, loadHistory])

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
              {/* Stepped, because a day close is read one day after another and
                  re-picking from a calendar each time is the slow way to do it. */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title="Previous day"
                  onClick={() => setDate(shiftDate(date, -1))}
                  className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md border bg-white hover:bg-muted"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <DatePicker max={todayISO()} value={date} onChange={(v) => setDate(v || todayISO())} className="w-40" />
                <button
                  type="button"
                  title="Next day"
                  disabled={date >= todayISO()}
                  onClick={() => setDate(shiftDate(date, 1))}
                  className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md border bg-white hover:bg-muted disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                {date !== todayISO() && (
                  <Button variant="outline" className="h-9 px-2 text-xs" onClick={() => setDate(todayISO())}>
                    Today
                  </Button>
                )}
                <Button
                  variant={histOpen ? 'default' : 'outline'}
                  className="h-9 gap-1 px-2 text-xs"
                  title="Which days have been closed over a period, and how each came out"
                  onClick={() => setHistOpen((o) => !o)}
                >
                  <CalendarRange className="h-3.5 w-3.5" /> Date range
                </Button>
              </div>
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
        {histOpen && (
          <div className="mt-4 overflow-hidden rounded-lg border border-[#d9d2b8] bg-[#fffdf4]">
            <div className="flex flex-wrap items-end gap-3 border-b border-[#e5dfc8] bg-[#f7f4e8] px-3 py-2">
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">From</Label>
                <DatePicker value={histFrom} max={histTo} onChange={(v) => setHistFrom(v || histFrom)} className="h-8 w-36 text-[12px]" />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">To</Label>
                <DatePicker value={histTo} min={histFrom} max={todayISO()} onChange={(v) => setHistTo(v || histTo)} className="h-8 w-36 text-[12px]" />
              </div>
              {/* The periods actually asked for, rather than making the user
                  count back to the first of the month every time. */}
              {(
                [
                  ['This month', `${todayISO().slice(0, 8)}01`, todayISO()],
                  ['Last 7 days', shiftDate(todayISO(), -6), todayISO()],
                  ['Last 30 days', shiftDate(todayISO(), -29), todayISO()]
                ] as const
              ).map(([label, f, t]) => (
                <Button
                  key={label}
                  variant="outline"
                  className="h-8 bg-white px-2 text-[11px]"
                  onClick={() => { setHistFrom(f); setHistTo(t) }}
                >
                  {label}
                </Button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {histBusy ? 'Loading…' : `${(hist || []).length} day${(hist || []).length === 1 ? '' : 's'} closed in this period`}
              </span>
            </div>
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-[#f1ecd9]">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                    <th className="px-3 py-1.5">Closing date</th>
                    <th className="px-3 py-1.5 text-right">Products</th>
                    <th className="px-3 py-1.5 text-right">Mismatches</th>
                    <th className="px-3 py-1.5 text-right">Net difference</th>
                    <th className="px-3 py-1.5 text-right">Actual value</th>
                    <th className="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {(hist || []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                        {histBusy ? 'Loading…' : 'No day close saved in this period.'}
                      </td>
                    </tr>
                  ) : (
                    (hist || []).map((h) => {
                      const diff = Number(h.net_diff) || 0
                      const mis = Number(h.mismatches) || 0
                      return (
                        <tr
                          key={String(h.count_date)}
                          className={cn(
                            'cursor-pointer border-b border-dotted hover:bg-amber-50',
                            String(h.count_date) === date && 'bg-amber-100/70'
                          )}
                          style={{ borderColor: '#e5dfc8' }}
                          onClick={() => setDate(String(h.count_date))}
                          title="Open this day in the sheet"
                        >
                          <td className="px-3 py-1.5 font-medium tabular-nums">{formatDate(h.count_date)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(h.products)}</td>
                          <td className={cn('px-3 py-1.5 text-right tabular-nums', mis > 0 && 'font-semibold text-rose-700')}>
                            {mis || '—'}
                          </td>
                          <td className={cn('px-3 py-1.5 text-right tabular-nums', Math.abs(diff) > 0.0005 && 'font-semibold text-rose-700')}>
                            {Math.abs(diff) > 0.0005 ? formatNum(diff) : '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatINR(h.actual_value)}</td>
                          <td className="px-3 py-1.5 text-right text-[11px] text-muted-foreground">open →</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
              One row per day that has a close saved. A date missing from this list was never closed — which is the
              thing a single-day sheet cannot tell you. Click a row to open that day.
            </div>
          </div>
        )}
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

// Packs on the shelf the morning the books began.
// -----------------------------------------------------------------------------
// The tanks got this first, on the Book Stock side. The packed shelf needed it
// for the same reason and it reads the same way: state what was counted, and
// every figure after it is worked forward from that rather than from the whole
// history. Movements before the counted morning are superseded — still listed
// against their SKU, simply not arithmetic any more.
function SkuOpeningStock({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [draft, setDraft] = useState<Record<number, { qty: string; note: string }>>({})
  const [asOf, setAsOf] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  // `seed` distinguishes the first read from a re-read: only the first sets the
  // date and fills the draft, so changing the date recomputes "moved since"
  // without wiping what is being typed.
  const load = useCallback(async (asOfOverride?: string): Promise<void> => {
    const seed = asOfOverride == null
    if (seed) setLoading(true)
    try {
      const d = await window.api.skuOpening.list(asOfOverride)
      setData(d)
      if (seed) {
        // No count struck yet: default to the day the TANKS were counted, so
        // the two halves of one stocktake do not drift apart by accident.
        setAsOf(String(d.as_of || (await window.api.stockOpening.date().catch(() => '')) || ''))
        const next: Record<number, { qty: string; note: string }> = {}
        for (const r of (d.rows as Row[]) || []) {
          next[Number(r.id)] = {
            qty: r.qty == null ? '' : String(r.qty),
            note: r.note == null ? '' : String(r.note)
          }
        }
        setDraft(next)
      }
    } catch (e) {
      toast.error(errText(e))
    } finally {
      if (seed) setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  useLiveRefresh(load)

  // Moving the date re-asks "what has moved since?" straight away, so the
  // shortfall on every row is the one for the morning actually being counted.
  useEffect(() => {
    if (!asOf) return
    void load(asOf)
  }, [asOf, load])

  const rows: Row[] = useMemo(() => ((data?.rows as Row[]) || []), [data])
  const answeredOf = useCallback((id: number): boolean => (draft[id]?.qty ?? '') !== '', [draft])
  const projected = useCallback(
    (r: Row): number => Number(r.movement_closing) + (Number(draft[Number(r.id)]?.qty) || 0),
    [draft]
  )

  const setField = (id: number, key: 'qty' | 'note', value: string): void => {
    setDraft((p) => ({ ...p, [id]: { qty: p[id]?.qty ?? '', note: p[id]?.note ?? '', [key]: value } }))
  }

  const stats = useMemo(() => {
    let entered = 0
    let pcs = 0
    let stillShort = 0
    for (const r of rows) {
      const id = Number(r.id)
      if (answeredOf(id)) {
        entered++
        pcs += Number(draft[id]?.qty) || 0
      }
      if (projected(r) < -0.0005) stillShort++
    }
    return { entered, pcs, stillShort }
  }, [rows, draft, answeredOf, projected])

  const dirty = useMemo(() => {
    for (const r of rows) {
      const d = draft[Number(r.id)] || { qty: '', note: '' }
      if (d.qty !== (r.qty == null ? '' : String(r.qty))) return true
      if (d.note !== (r.note == null ? '' : String(r.note))) return true
    }
    return false
  }, [rows, draft])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        String(r.name || '').toLowerCase().includes(q) ||
        String(r.product_name || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  async function save(): Promise<void> {
    if (!asOf) return void toast.error('Pick the date this count was taken')
    setSaving(true)
    try {
      const payload = rows.map((r) => ({
        packaging_id: Number(r.id),
        qty: draft[Number(r.id)]?.qty ?? '',
        note: draft[Number(r.id)]?.note ?? ''
      }))
      const res = await window.api.skuOpening.save(payload, asOf)
      toast.success(
        `Packed opening saved — ${res.saved} ${res.saved === 1 ? 'SKU' : 'SKUs'}` +
          (res.cleared ? `, ${res.cleared} cleared` : '')
      )
      await load()
      onSaved()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Reading the shelf…</div>
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-6 py-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/20">
            <Boxes className="h-5 w-5 text-white" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[16px] font-bold leading-tight text-white">Packs brought forward</h3>
              <InfoTip
                className="text-white/60 hover:text-white"
                text="What was already in packs on the shelf the morning the books began. The packed register works every balance out from packing entries and dispatches, so packs made before that morning would otherwise be counted twice — once in this count and once in their own entry. Once this is struck, nothing before it is packed-SKU arithmetic any more."
              />
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-white/65">
              Counted in pieces, per SKU — the shelf's own opening.
            </p>
          </div>
          <div className="shrink-0 rounded-xl bg-white/[0.08] p-3.5 ring-1 ring-inset ring-white/15">
            <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55">
              <span>Counted on <span className="text-amber-300">*</span></span>
              <InfoTip
                className="text-white/45 hover:text-white"
                text="The morning the shelf was counted. Nothing before it is reconciled against these figures. It defaults to the day the tanks were counted, because the two halves of one stocktake belong on the same date."
              />
            </div>
            <div
              className={cn(
                'w-[11.5rem] [&_button]:h-10 [&_button]:text-[13px] [&_button]:font-semibold [&_button]:text-white [&_button:hover]:bg-white/20',
                asOf
                  ? '[&_button]:border-white/20 [&_button]:bg-white/10'
                  : '[&_button]:border-amber-300 [&_button]:bg-amber-400/20'
              )}
            >
              <DatePicker value={asOf} onChange={setAsOf} />
            </div>
            <div className="mt-2.5 text-[10.5px] leading-snug text-white/50">
              the packed register opens from this day
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border-t border-[#d9d2b8] bg-[#e6dfc4] lg:grid-cols-4">
          {[
            {
              label: 'Opening pieces',
              tip: 'Every SKU\u2019s counted pieces, added up. This is what the packed register opens at.',
              value: <span className="text-[#1a2c56]">{formatNum(stats.pcs)}</span>,
              note: 'across every SKU counted'
            },
            {
              label: 'Answered',
              tip: 'How many SKUs have a count entered. A blank is not nought: blank means not counted yet and stays off the register entirely.',
              value: (
                <span
                  className={cn(
                    stats.entered === 0
                      ? 'text-amber-700'
                      : stats.entered === rows.length
                        ? 'text-emerald-700'
                        : 'text-[#1a2c56]'
                  )}
                >
                  {stats.entered}
                  <span className="text-[15px] font-semibold text-muted-foreground"> / {rows.length}</span>
                </span>
              ),
              note: `${Math.max(0, rows.length - stats.entered)} still blank`
            },
            {
              label: 'Below zero',
              tip: 'SKUs the register would carry as a negative. The first counts them on movements since the counted morning alone — each has shipped more than was packed, which is the hole this count fills. The second counts how many would STILL be negative with what is typed, and is the one to drive to nil.',
              value: (
                <span className="flex items-baseline gap-2">
                  <span className={cn(Number(data?.negative_count) ? 'text-rose-700' : 'text-emerald-700')}>
                    {Number(data?.negative_count ?? 0)}
                  </span>
                  <span className="text-[15px] font-normal text-muted-foreground">→</span>
                  <span className={cn(stats.stillShort ? 'text-rose-700' : 'text-emerald-700')}>
                    {stats.stillShort}
                  </span>
                </span>
              ),
              note: 'to begin with → with what is typed'
            },
            {
              label: 'Counted on',
              tip: 'The morning this count belongs to. Every packed figure is worked forward from it.',
              value: <span className="text-[#1a2c56]">{asOf ? formatDate(asOf) : '—'}</span>,
              note: data?.as_of ? 'already struck' : 'not struck yet'
            }
          ].map((k) => (
            <div key={k.label} className="bg-[#fffdf4] px-5 py-4">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {k.label}
                </span>
                <InfoTip text={k.tip} />
              </div>
              <div className="mt-1.5 text-[22px] font-bold leading-none tabular-nums">{k.value}</div>
              <div className="mt-2 text-[10.5px] leading-snug text-muted-foreground">{k.note}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#e0d8bd] bg-white px-4 py-3 shadow-sm">
        <Input
          placeholder="Find an SKU…"
          className="h-10 w-64 text-[13px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-[12px] font-semibold text-[#1a2c56]">
          {stats.entered} of {rows.length} counted
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="flex items-center gap-1.5 rounded-md bg-amber-100 px-2.5 py-1 text-[11.5px] font-semibold text-amber-900">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Unsaved changes
            </span>
          )}
          <Button onClick={save} disabled={saving || !dirty} className="h-10 bg-[#1a2c56] px-5 hover:bg-[#24407e]">
            {saving ? 'Saving…' : 'Save packed opening'}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm">
        <div className="overflow-x-auto">
          <table className="ruled-cols w-full min-w-[900px] bg-[#fffdf4] text-[13px]">
            <thead>
              <tr className="border-b border-[#e0d8bd] bg-[#faf6e8] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="pin-col min-w-[220px] px-3 py-2">SKU</th>
                <th className="w-[110px] px-3 py-2 text-right">Pack</th>
                <th className="w-[130px] px-3 py-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    Moved since
                    <InfoTip text="Packed in less dispatched SINCE the counted morning. Movements before it are deliberately left out — that morning is the fresh start. Negative here is exactly the hole this count has to fill." />
                  </span>
                </th>
                <th className="w-[130px] bg-[#f4efdd] px-3 py-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    Opening (pcs)
                    <InfoTip text="Pieces physically on the shelf that morning. Leave it blank if the SKU has not been counted; enter 0 to state that it genuinely had none. The two are different, and only the second shows on the register." />
                  </span>
                </th>
                <th className="w-[140px] px-3 py-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    Closes at
                    <InfoTip text="Opening + everything moved since — what the packed register will read once this is saved. This is the figure that decides whether the entry is right: drive it to nil or above." />
                  </span>
                </th>
                <th className="min-w-[160px] px-3 py-2 text-left">
                  <span className="inline-flex items-center gap-1">
                    Note
                    <InfoTip text="Why this row reads the way it does — which rack was counted, who counted it. Saved with the opening; a note needs a figure to hang on, so a row with only a note is not kept." />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const id = Number(r.id)
                const d = draft[id] || { qty: '', note: '' }
                const answered = answeredOf(id)
                const proj = projected(r)
                const short = Number(r.shortfall)
                return (
                  <tr
                    key={id}
                    className={cn(
                      'border-t border-[#f0ead2] transition-colors hover:bg-[#fbf6e4]',
                      answered && 'row-answered bg-emerald-50/40'
                    )}
                  >
                    <td className="pin-col px-3 py-1.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {answered ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        ) : (
                          <span className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="font-medium text-[#1a2c56]">{String(r.name)}</span>
                        {r.product_name ? (
                          <span className="rounded bg-[#f1ecd9] px-1.5 text-[10.5px] text-muted-foreground">
                            {String(r.product_name)}
                          </span>
                        ) : null}
                        {short > 0.0005 && !answered && (
                          <Badge variant="destructive" className="text-[10px]">Short</Badge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-[12px] text-muted-foreground">
                      {Number(r.unit_size) > 0
                        ? `${formatNum(r.unit_size)} ${String(r.unit_uom || '')}`.trim()
                        : `${formatNum(r.base_per_pouch)} ${String(r.base_uom || '')}`.trim()}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-1.5 text-right tabular-nums',
                        Number(r.movement_closing) < -0.0005
                          ? 'font-semibold text-rose-700'
                          : 'text-muted-foreground'
                      )}
                    >
                      {formatNum(r.movement_closing)}
                    </td>
                    <td className="bg-[#faf6e8] px-3 py-1.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {short > 0.0005 && d.qty === '' && (
                          <button
                            type="button"
                            title="The smallest count that clears the shortfall"
                            className="shrink-0 rounded border px-1.5 py-0.5 text-[10.5px] text-rose-700 hover:bg-rose-50"
                            onClick={() => setField(id, 'qty', String(short))}
                          >
                            {formatNum(short)}
                          </button>
                        )}
                        <input
                          inputMode="decimal"
                          className="doc-ref h-8 w-[84px] rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                          value={d.qty}
                          onChange={(e) => setField(id, 'qty', e.target.value.replace(/[^0-9.]/g, ''))}
                        />
                      </div>
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums',
                        proj < -0.0005 ? 'text-rose-700' : answered ? 'text-emerald-700' : 'text-muted-foreground'
                      )}
                    >
                      {formatNum(proj)}
                      {proj < -0.0005 ? (
                        <div className="text-[10.5px] font-normal text-rose-600">still short {formatNum(-proj)}</div>
                      ) : answered ? (
                        <div className="text-[10.5px] font-normal text-emerald-600">accounted for</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        className="h-8 w-full min-w-[140px] rounded-md border bg-white px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                        placeholder="rack, counter, anything worth recording"
                        value={d.note}
                        onChange={(e) => setField(id, 'note', e.target.value)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
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
    // Real packing off the line, or a hand fix to a wrong count. The register
    // used to guess this from the sign, which made every correction that ADDED
    // stock look like a day's production.
    kind: 'packing' | 'correction'
  }>({
    mode: 'add',
    kind: 'packing',
    amount: '',
    note: '',
    date: todayISO()
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The hand entries behind the SKU being updated. Loaded with the dialog,
  // because the dialog is where they were made and where a wrong one has to be
  // findable — an on-hand of 1,548 with no sight of the entries behind it is a
  // figure nobody can check.
  const [adjLog, setAdjLog] = useState<Row[]>([])
  const [adjLogLoading, setAdjLogLoading] = useState(false)

  // Which period the register is read over.
  //
  //   'day'   — one date, walked with the arrows: the mill's own daily sheet,
  //             and what Count sheet / Upload closing are keyed to.
  //   'range' — From..To, for "what moved this month".
  //   'all'   — running totals since the beginning.
  //
  // 'day' and 'range' are the same arithmetic (opening b/f + packed in −
  // dispatched = closing) over a different number of days, which is why the
  // whole page keeps reading `dayMode` — derived below — rather than growing a
  // second set of branches that could disagree with the first.
  // Which half of the packed screen is being read: the moving register, or the
  // count it starts from. Same arrangement as Book Stock, because it is the
  // same pair of jobs.
  const [skuView, setSkuView] = useState<'register' | 'opening'>('register')
  const [spanMode, setSpanMode] = useState<'day' | 'range' | 'all'>('day')
  const [date, setDate] = useState(todayISO())
  const [skuRange, setSkuRange] = useState({ from: '', to: '' })
  const dayMode = spanMode !== 'all'
  // Count sheet and Upload closing set ONE day's closing, so over a range they
  // act on its last day — the date the closing figure belongs to.
  const sheetDate =
    spanMode === 'day' ? date : spanMode === 'range' ? skuRange.to || todayISO() : todayISO()

  // A period broadcast to the stock screens (Alt+F2) seeds the range, so the
  // dates are already there when Range is picked. The MODE is left alone: the
  // day sheet is the workflow this page is built around, and switching it out
  // from under the reader on load would be a surprise.
  const globalRangeSku = useGlobalDateRange()
  useEffect(() => {
    if (!globalRangeAppliesTo(globalRangeSku, 'stock')) return
    if (!globalRangeSku.from && !globalRangeSku.to) return
    setSkuRange({ from: globalRangeSku.from, to: globalRangeSku.to })
  }, [globalRangeSku.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true)
    // The SAME period object goes to both, so the hover can never cover a
    // different stretch from the cell it explains.
    const when =
      spanMode === 'day'
        ? date
        : spanMode === 'range'
          ? { from: skuRange.from, to: skuRange.to }
          : undefined
    const [list, breakdown] = await Promise.all([
      window.api.skuStock.list(when),
      // The workings behind the figures, for the hover. Asked for once for the
      // whole page, so a tooltip costs nothing when it opens.
      window.api.skuStock.breakdown(when).catch(() => [] as Row[])
    ])
    setRows(list)
    setParts(new Map(breakdown.map((b) => [Number(b.sku), b])))
    setLoading(false)
  }, [spanMode, date, skuRange.from, skuRange.to])
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

  const loadAdjLog = useCallback(async (pid: number): Promise<void> => {
    if (!pid) return
    setAdjLogLoading(true)
    try {
      setAdjLog(await window.api.skuStock.adjustments(pid))
    } catch {
      setAdjLog([])
    } finally {
      setAdjLogLoading(false)
    }
  }, [])

  // Removing an entry moves the plant tank as well as the shelf when it was a
  // PACKING entry, so the confirmation says so — that is the half people do not
  // expect, and it is the half that put DALDA at -3.583.
  async function removeAdj(a: Row): Promise<void> {
    if (!adjustRow) return
    const pcs = Number(a.delta) || 0
    const mt = Number(a.mt) || 0
    const packing = String(a.kind) === 'packing'
    const label = pieceLabel(adjustRow).toLowerCase()
    if (
      !window.confirm(
        `Remove this ${packing ? 'packing' : 'correction'} entry — ` +
          `${pcs < 0 ? '−' : '+'}${formatNum(Math.abs(pcs))} ${label} on ${formatDate(a.adj_date)}?` +
          (packing && Math.abs(mt) > 0.0005
            ? `\n\n${formatNum(Math.abs(mt))} MT goes back to the plant tank.`
            : '\n\nThis only moves pieces on the shelf; no oil moves.')
      )
    ) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.skuStock.deleteAdjustment(Number(a.id))
      toast.success('Entry removed')
      const pid = Number(adjustRow.id)
      await loadAdjLog(pid)
      // The dialog's own "On hand" read-out is derived from the row, so the row
      // has to be refreshed too or it keeps quoting the figure it opened with.
      const fresh = await window.api.skuStock.list(
        spanMode === 'day' ? date : spanMode === 'range' ? { from: skuRange.from, to: skuRange.to } : undefined
      )
      setRows(fresh)
      const mine = fresh.find((r) => Number(r.id) === pid)
      if (mine) setAdjustRow(mine)
      void load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    void loadAdjLog(Number(row.id))
    // Default the entry to the day being viewed, so day-wise updates land there.
    // Counted in cases by default: that is how packed output comes off the line,
    // and it is what was being typed into a field that meant pieces.
    setAdjustForm({ mode: 'add', kind: 'packing', amount: '', note: '', date: sheetDate })
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
    const pieces = amt
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
        `${adjustForm.mode === 'add' ? 'Added' : 'Removed'} ${formatNum(Math.abs(pieces))} ${pieceLabel(adjustRow)} — ${adjustRow.name}`
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
        sheetDate,
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
      const when = sheetDate
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
        // MORE on the floor than the software expected is the day's packing:
        // it draws the oil off the plant tank, which is the whole point of
        // uploading the sheet.
        //
        // LESS is not negative packing — no oil goes back into the tank because
        // a shelf came up short. That is a correction, and it says so, so the
        // register does not read a shrinkage as a day of production run backwards.
        const isPacking = delta > 0
        await window.api.skuStock.adjust(
          Number(row.id),
          delta,
          p.note || (isPacking ? `Packed ${formatDate(when)}` : `Closing count ${formatDate(when)} — short`),
          when,
          isPacking ? 'packing' : 'correction'
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
    <div className="space-y-2">
      {/* Three thin rows, not six tall ones.
          ---------------------------------------------------------------------
          Every level of this screen used to claim a line of its own — the view
          toggle, the period, the filters, then three stat cards a third of the
          page wide, then the alert. Each was legible and the stack was not:
          six bands of chrome before a single figure of stock.

          So they are grouped by what the reader is doing, and each group is one
          strip: WHICH VIEW AND WHEN (with its actions), WHAT IS IN VIEW, and
          WHAT IT COMES TO (with the warning that belongs to it). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex shrink-0 rounded-lg border p-0.5">
          {(
            [
              ['register', 'Register'],
              ['opening', 'Opening stock']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSkuView(k)}
              className={cn(
                'rounded-md px-3 py-1 text-[12.5px] font-semibold transition',
                skuView === k ? 'bg-[#1a2c56] text-white' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {skuView === 'register' && (
          <>
        <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-border sm:block" />
        <div className="inline-flex rounded-lg border p-0.5">
          {(
            [
              ['day', 'Day wise'],
              ['range', 'Range'],
              ['all', 'All time']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                // Picking Range with nothing in it would read as all-time and
                // look broken, so it opens on the month the viewed day sits in.
                if (k === 'range' && !skuRange.from && !skuRange.to) {
                  setSkuRange({ from: `${date.slice(0, 7)}-01`, to: date })
                }
                setSpanMode(k)
              }}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] font-medium transition',
                spanMode === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {spanMode === 'range' && (
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground">From</span>
            <DatePicker
              value={skuRange.from}
              max={skuRange.to || todayISO()}
              onChange={(v) => setSkuRange((p) => ({ ...p, from: v || '' }))}
              className="w-36"
            />
            <span className="text-muted-foreground">To</span>
            <DatePicker
              value={skuRange.to}
              min={skuRange.from || undefined}
              max={todayISO()}
              onChange={(v) => setSkuRange((p) => ({ ...p, to: v || '' }))}
              className="w-36"
            />
            {/* Opening is what the shelf held the morning the period began, so
                say which morning that is rather than leaving "Opening" to mean
                whatever the reader assumes. */}
            <span className="text-[11px] text-muted-foreground">
              {skuRange.from
                ? `opening as at ${formatDate(skuRange.from)}`
                : 'opening at nil — no start date set'}
            </span>
          </div>
        )}
        {spanMode === 'day' && (
          <div className="flex items-center gap-1.5 text-[13px]">
            {/* Reading a day-wise register means walking day by day, and going
                through the calendar for each step is the slow way round.
                Forward stops at today, since there is no stock after it. The
                word "Date" is gone: a calendar between two arrows is not
                mistakable for anything else. */}
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
            filename={`packed-sku-stock-${spanMode === 'range' ? `${skuRange.from || 'start'}-to-${skuRange.to || todayISO()}` : sheetDate}`}
            sheetName="Packed SKU stock"
            title={`Packed SKU stock${
              spanMode === 'day'
                ? ` — ${formatDate(date)}`
                : spanMode === 'range'
                  ? ` — ${formatDate(skuRange.from || '')} to ${formatDate(skuRange.to || todayISO())}`
                  : ''
            }`}
            columns={
              dayMode
                ? [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Type', key: 'type', value: (r) => pieceLabel(r) },
                    { header: 'Opening (pcs)', key: 'opening', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.opening) || 0 },
                    { header: 'Packed in', key: 'added_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added_on) || 0 },
                    { header: 'Dispatch', key: 'sold_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold_on) || 0 },
                    { header: 'Closing (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'Closing (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
                : [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Type', key: 'type', value: (r) => pieceLabel(r) },
                    { header: 'Packed in', key: 'added', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added) || 0 },
                    { header: 'Sold (packed)', key: 'sold', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold) || 0 },
                    { header: 'On hand (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'On hand (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
            }
            rows={shown}
          />
        </div>
          </>
        )}
      </div>

      {skuView === 'opening' ? (
        <SkuOpeningStock onSaved={() => void load()} />
      ) : (
      <>
      {/* Row 2: what is in view. Quieter than the row above it on purpose —
          these narrow the list, they do not change what is being asked. */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU or product…"
          className="h-8 w-52 text-[13px]"
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
        {/* The SKU count was a stat card of its own, which spent a fifth of the
            band on a number nobody reconciles. It belongs beside the filters
            that change it. */}
        <span className="ml-auto text-[12px] text-muted-foreground">
          {shown.length === rows.length
            ? `${rows.length} SKUs`
            : `${shown.length} of ${rows.length} SKUs`}
        </span>
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
          // Three figures on ONE strip. Pieces and tonnes are two readings of a
          // single closing balance so they sit together, the SKU count moved up
          // beside the filters that change it, and the below-zero warning rides
          // here rather than claiming a band of its own — it is a fact about
          // these very figures.
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-muted/20 px-3.5 py-2">
            <Figure
              label={dayMode ? 'Packed in' : 'Packed (total)'}
              value={formatNum(sum(shown, inOf))}
              hint={all(formatNum(sum(rows, inOf)))}
              tone="text-emerald-700"
            />
            <span className="hidden h-4 w-px bg-border sm:block" />
            <Figure
              label={dayMode ? 'Dispatched' : 'Sold (packed)'}
              value={formatNum(sum(shown, outOf))}
              hint={all(formatNum(sum(rows, outOf)))}
              tone="text-rose-700"
            />
            <span className="hidden h-4 w-px bg-border sm:block" />
            <Figure
              label={dayMode ? 'Closing' : 'On hand'}
              value={`${formatNum(sum(shown, handOf))} pcs · ${formatNum(shownMT)} MT`}
              hint={all(`${formatNum(totalOnHand)} pcs · ${formatNum(totalMT)} MT`)}
              tone="text-sky-800"
            />
            {negatives > 0 && (
              <span className="ml-auto flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-0.5 text-[11.5px] font-semibold text-red-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {negatives} below zero
                <InfoTip
                  className="text-red-700 hover:text-red-900"
                  text="More has been dispatched than was ever packed in. Either the packing was never entered, or the shelf was never counted. Open the SKU with the sliders icon to see the entries behind it, or strike an opening count on the Opening stock tab if the packs predate the books."
                />
              </span>
            )}
          </div>
        )
      })()}

      <div className="rounded-xl border bg-card shadow-sm">
        <Table
          wrapperClassName="max-h-[calc(100vh-360px)] rounded-xl"
          className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-slate-200 hover:bg-slate-200">
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">SKU</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Pack</TableHead>
              {/* The unit every figure on the row is counted in — the SKU's own
                  Type off the Packed SKU master. Without it the numbers across
                  the row are bare counts of an unnamed thing: Pack size alone
                  does not say whether 3,303 is jars, tins or pouches. */}
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Type</TableHead>
              {dayMode && (
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">Opening</TableHead>
              )}
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Packed in' : 'Packed (total)'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Dispatch' : 'Sold'}
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
              <TableRow><TableCell colSpan={dayMode ? 9 : 8} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={dayMode ? 9 : 8} className="py-12 text-center text-muted-foreground">
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
                  // A quantity in the SKU's OWN Type, and nothing else.
                  //
                  // This used to append the same figure divided by the master's
                  // per-case count: 100 packed showed as "100 (2.5 case)". Every
                  // number the register holds for this SKU is a count of its own
                  // Type, so restating it as cases put a second unit on the row
                  // that no entry was ever made in — and where the master's
                  // per-case figure disagrees with the Type, that second number
                  // was simply wrong.
                  const asCases = (pieces: number): string =>
                    `${formatNum(pieces)} ${pieceLabel(r)}`
                  // Who took it. One line per invoice, so a party appearing on
                  // two invoices shows as two lines rather than one lump.
                  const outLines = ((part?.dispatch || []) as Row[]).map((dr) => ({
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
                              footer={`Net ${fixNet > 0 ? '+' : ''}${asCases(fixNet)} by hand — typed in, not counted off a production or dispatch entry.`}
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{unitLabel(r)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                          {pieceLabel(r)}
                        </span>
                      </TableCell>
                      {dayMode && (
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {Number(r.opening) ? (
                            <CellWithWorkings
                              value={formatNum(r.opening)}
                              title={`Brought forward into ${formatDate(date)}`}
                              lines={[
                                { left: 'Packed in', mid: 'everything before this date', right: asCases(Number(r.added_before) || 0) },
                                { left: 'Dispatched', mid: 'everything before this date', right: `−${asCases(Number(r.sold_before) || 0)}` }
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
                            title={dayMode ? `Dispatched on ${formatDate(date)} — by party` : 'Dispatched — by party'}
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
                                  { left: 'Dispatched', right: `−${asCases(outQty)}` }
                                ]
                              : [
                                  { left: 'Packed in', right: asCases(Number(r.added) || 0) },
                                  { left: 'Dispatched', right: `−${asCases(Number(r.sold) || 0)}` }
                                ]
                          }
                          footer={
                            onHand < -1e-6
                              ? r.negative_since
                                ? `= ${asCases(onHand)} — below zero since ${formatDate(r.negative_since)}` +
                                  `${daysApart(String(r.negative_since), sheetDate) > 0 ? `, ${daysApart(String(r.negative_since), sheetDate)} days now` : ' — today'}` +
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
                                      <span className="text-white/60">Dispatched that day</span>
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
                  <TableCell colSpan={dayMode ? 4 : 3} className="font-bold uppercase tracking-wide text-amber-900">
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
          ? 'Day wise: opening (brought forward) + packed in on this date − dispatched on this date = closing. Rows with movement on the day are tinted. Closing (MT) = pieces × pack size (1 L counted as 1 KG). Use the sliders icon for one SKU, or Count sheet → Upload closing to set the whole day at once.'
          : 'All time: packs added − packs sold on dispatched PACKED sales = on hand. On hand (MT) = pieces × pack size (1 L counted as 1 KG).'}
      </p>
      </>
      )}

      <Dialog open={!!adjustRow} onOpenChange={(o) => !o && setAdjustRow(null)}>
        {/* Wider and scrollable: it now carries the entry list as well as the
            form, and a 14-entry SKU should not push Save off the screen. */}
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Update packed stock — {adjustRow?.name}</DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const onHand = Number(adjustRow.on_hand) || 0
            const amt = Number(adjustForm.amount) || 0
            const pieces = amt
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
                      onClick={() =>
                        setAdjustForm((p) => ({ ...p, kind: k, mode: k === 'packing' ? 'add' : p.mode }))
                      }
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
{/* Packing only ever ADDS — it is what came off the line, and a negative
                    run does not exist. A correction can go either way, because the
                    count being wrong is as often too high as too low. */}
                {adjustForm.kind === 'correction' && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))}
                      className={cn(
                        'flex-1 rounded-md border px-3 py-2 text-sm font-medium',
                        adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40'
                      )}
                    >
                      + Count was too low
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))}
                      className={cn(
                        'flex-1 rounded-md border px-3 py-2 text-sm font-medium',
                        adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40'
                      )}
                    >
                      − Count was too high
                    </button>
                  </div>
                )}
{/* Always the SKU's own Type — the unit the Packaging master calls
                    it and the unit the register counts in. It used to offer Case as
                    well, and on a 40-per-case SKU that is the difference between 12
                    and 480: cases typed here were read as pieces and sent an SKU tens
                    of thousands negative. One unit, no conversion to get wrong. The
                    case equivalent is shown underneath for anyone counting in cases. */}
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
                    <div className="flex h-9 shrink-0 items-center rounded-md bg-muted px-3 text-[13px] font-medium text-muted-foreground">
                      {pieceLabel(adjustRow)}
                    </div>
                  </div>
                  {/* The tonnage with its working shown, in the SKU's own
                      Type and nothing else. It used to print the MT alone and
                      then the same quantity again as a Case count, which put
                      two units in front of someone who had typed one — and
                      hid which figure off the Packaging master it had used.
                      Spelling out "× N per box" makes a wrong master figure
                      visible here instead of only in the tonnage. */}
                  {amt > 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      {formatNum(amt)} {pieceLabel(adjustRow)} × {formatNum(adjustRow.base_per_pouch)}{' '}
                      {String(adjustRow.base_uom || 'KG')} per {pieceLabel(adjustRow).toLowerCase()} ={' '}
                      <b className="text-foreground">
                        {formatNum((amt * Number(adjustRow.base_per_pouch || 0)) / 1000)} MT
                      </b>{' '}
                      off the plant tank
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
                      That would take this SKU below zero — this box counts in{' '}
                      {pieceLabel(adjustRow).toLowerCase()}s, so check the figure is not a case or kilo total.
                    </div>
                  )}
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}

                {/* What is already on this SKU.
                    ---------------------------------------------------------
                    Each row says whether it moved OIL or only pieces, because
                    those are different acts and the difference is invisible
                    otherwise: a +1,000 packing followed by a −1,000 correction
                    nets to nil on the shelf and still leaves the plant tank 15
                    MT down. Deleting the packing entry is what puts that back.

                    Dispatches are not listed. They are sale lines, undone by
                    editing the invoice — showing them here with a bin beside
                    them would offer a deletion this screen must not perform. */}
                <div className="overflow-hidden rounded-lg border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                    <span className="text-[10.5px] font-bold uppercase tracking-wide text-[#334155]">
                      Entries on this SKU
                    </span>
                    <span className="text-[11px] text-[#475569]">
                      {adjLog.length} hand {adjLog.length === 1 ? 'entry' : 'entries'} · dispatches live on the
                      invoice
                    </span>
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    {adjLogLoading ? (
                      <div className="px-3 py-6 text-center text-[12px] text-[#475569]">Reading the entries…</div>
                    ) : adjLog.length === 0 ? (
                      <div className="px-3 py-6 text-center text-[12px] text-[#475569]">
                        Nothing has been entered by hand against this SKU yet.
                      </div>
                    ) : (
                      adjLog.map((a) => {
                        const pcs = Number(a.delta) || 0
                        const mt = Number(a.mt) || 0
                        const packing = String(a.kind) === 'packing'
                        return (
                          <div
                            key={String(a.id)}
                            className="flex items-start gap-2 border-b px-3 py-2 last:border-0"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="text-[12px] font-semibold tabular-nums text-[#0b1728]">
                                  {formatDate(a.adj_date)}
                                </span>
                                <span
                                  className={cn(
                                    'text-[12.5px] font-bold tabular-nums',
                                    pcs < 0 ? 'text-rose-700' : 'text-emerald-700'
                                  )}
                                >
                                  {pcs < 0 ? '−' : '+'}
                                  {formatNum(Math.abs(pcs))} {pieceLabel(adjustRow)}
                                </span>
                                <Badge
                                  variant={packing ? 'default' : 'warning'}
                                  className="text-[9.5px] uppercase"
                                >
                                  {packing ? 'Packing' : 'Correction'}
                                </Badge>
                                <span className="text-[11px] font-medium text-[#475569]">
                                  {!packing
                                    ? 'shelf only — no oil moved'
                                    : mt > 0.0005
                                      ? `−${formatNum(mt)} MT from the plant tank`
                                      : mt < -0.0005
                                        ? `+${formatNum(-mt)} MT back to the plant tank`
                                        : 'no oil moved'}
                                </span>
                              </div>
                              <div className="truncate text-[11px] text-[#475569]">
                                {String(a.created_by || 'unknown')}
                                {a.created_at ? ` · ${String(a.created_at).slice(0, 16).replace('T', ' ')}` : ''}
                                {a.note ? ` · “${String(a.note)}”` : ''}
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-600"
                              title="Remove this entry"
                              disabled={saving}
                              onClick={() => void removeAdj(a)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={saving}>Close</Button>
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
      window.api.consignment.list('stock'),
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

export function Stock({ onCompanyChange }: { onCompanyChange?: (id: string) => void }): React.JSX.Element {
  const [stockGroup, setStockGroup] = useState<'book' | 'actual'>('book')
  const [tab, setTab] = useState('raw')
  const [bookView, setBookView] = useState<'register' | 'opening'>('register')
  // Honour the note the opening sheet's company switcher left behind, so a
  // switch made there comes back to the opening sheet for the other company
  // instead of dropping the reader on the register. Runs once, then clears —
  // ordinary navigation to Stock still opens on the register.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(RESUME_OPENING) !== '1') return
      sessionStorage.removeItem(RESUME_OPENING)
      setStockGroup('book')
      setBookView('opening')
    } catch {
      // no storage — nothing to resume
    }
  }, [])
  const [rows, setRows] = useState<Row[]>([])
  const [breakdown, setBreakdown] = useState<Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[] }>>({})
  const [range, setRange] = useState({ from: '', to: '' })
  const ranged = !!(range.from || range.to)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRangeStock = useGlobalDateRange()

  // The morning the opening stock was struck is where this page's period
  // starts.
  //
  // Everything on the stock screens is reconciled against that count, so a
  // period beginning earlier shows movements that predate every figure they
  // would be checked against — stock the mill never had. That is exactly what
  // an inherited period was doing here: a global 1 July on a book whose
  // opening is struck 1 September, so two months of pre-opening movement led
  // the register.
  //
  // A FLOOR on the inherited period, not a wall. A period picked on this page,
  // or broadcast to this page by name (Alt+F2 scoped to Stock), is honoured
  // exactly as asked — pre-opening movement is still there for anyone who
  // deliberately goes looking, and the strip says so when they do.
  const [openingFrom, setOpeningFrom] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      const d = await window.api.stockOpening.date().catch(() => '')
      if (live && d) setOpeningFrom(String(d).slice(0, 10))
    })()
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!globalRangeAppliesTo(globalRangeStock, 'stock')) return
    const asked = globalRangeStock.from
    // Named for this page = deliberate, so nothing is raised.
    const floor = globalRangeStock.scope === 'page' || !openingFrom ? '' : openingFrom
    setRange({
      from: floor && (!asked || asked < floor) ? floor : asked,
      to: globalRangeStock.to
    })
    // openingFrom lands a moment after the period does, so this has to re-run
    // when it arrives or the first paint keeps the unfloored dates.
  }, [globalRangeStock.version, openingFrom]) // eslint-disable-line react-hooks/exhaustive-deps
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
            (Number(r.sold) || 0) + (Number(r.packed_out) || 0) + Math.abs(Number(r.stock) || 0)
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
        {/* Opening stock is not a stage of the register — it is where the
            register starts — so it is its own view rather than a fourth stage
            inside the stage picker. Kept out of `tab` on purpose: that value is
            raw / intermediate / finished, so a tab trigger for the register
            would go dark the moment anyone picked Intermediate. */}
        {stockGroup === 'book' && (
          <div className="mb-3 ml-2 inline-flex rounded-lg border p-0.5 align-top">
            {([
              { key: 'register', label: 'Register' },
              { key: 'opening', label: 'Opening stock' }
            ] as const).map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setBookView(v.key)}
                className={cn(
                  'rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors',
                  bookView === v.key ? 'bg-[#1a2c56] text-white' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        {stockGroup === 'book' && bookView === 'opening' ? (
          <OpeningStock companies={companies} onCompanyChange={onCompanyChange} />
        ) : (
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
            <StockTable rows={byCat('raw')} breakdown={breakdown} label="raw" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} openingFrom={openingFrom} />
          </TabsContent>
          <TabsContent value="intermediate" className="mt-1">
            <StockTable rows={byCat('intermediate')} breakdown={breakdown} label="intermediate" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} openingFrom={openingFrom} />
          </TabsContent>
          <TabsContent value="finished" className="mt-1">
            <StockTable rows={byCat('finished')} breakdown={breakdown} label="finished" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} stagePicker={stagePicker} companyIds={cids} openingFrom={openingFrom} />
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
        )}
      </div>
    </>
  )
}
