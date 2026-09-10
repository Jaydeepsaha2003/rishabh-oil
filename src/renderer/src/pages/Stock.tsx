import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRightLeft, BookOpen, Boxes, Building2, CalendarCheck, CalendarRange, ClipboardCheck, Factory, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Eye, EyeOff, Layers, Loader2, Plus, SlidersHorizontal, TrendingDown, TrendingUp, Trash2, Upload, X } from 'lucide-react'
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
import { downloadProductionReport } from '@/lib/productionReportExcel'
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
import { HelpTip, InfoTip, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { PpBreakdown } from '@/components/PpBreakdown'
import { useIsMobile } from '@/lib/useIsMobile'
import { StockMobile } from './StockMobile'
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
  // The document's own date, and first, because that is what a register is
  // reconciled by: the bill's date leads, then the lorry's two dates. A
  // purchase billed on the 27th and received on the 2nd, or an invoice raised
  // one month and unloaded the next, could not be tied to the ledger from
  // this sheet at all before — the ledger posts on the invoice date and the
  // register only carried movement dates. On a return line it is the note's
  // own date.
  { header: 'Invoice date', key: 'invoice_date', width: 14, value: (r) => (r.invoice_date ? formatDate(r.invoice_date) : '') },
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
  // What KIND of goods moved, before which goods they were. Both registers
  // run to hundreds of lines across oil, husk and packaging, and reading them
  // by kind meant knowing every product name by heart.
  { header: 'Category', key: 'category', width: 16, divider: true, value: (r) => r.category || '' },
  { header: 'Oil type', key: 'oil_type', width: 18, value: (r) => r.oil_type || '' },
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
  wash,
  caption
}: {
  value: number
  parties: Row[]
  // The row's own unit. Optional in the type only because the packed-SKU
  // sheet has its own labelling; every product-register call passes it, and
  // the 'MT' fallback below is what made a PCS product's dispatch hover as
  // "526.04 MT".
  uom?: string
  tone?: string
  // The column-group wash. Separate from `tone` because tone is the figure's
  // own colour — in or out — and the wash is which block the column sits in.
  wash?: string
  // Named above the lines when the breakdown is not "who did we trade with" —
  // the packing hover lists SKUs, and a list of SKUs with no heading reads like
  // a list of customers.
  caption?: string
}): React.JSX.Element {
  const cell = <span className="tabular-nums">{formatNum(value)}</span>
  // A dash is not a quantity. Painting it the column's own green or red — as
  // the desktop does, because there it is one dash among figures — turns a
  // register whose columns are mostly empty into a field of coloured marks.
  // On the website the zero goes grey and the colour is left to mean something.
  const cls = cn(
    'text-right tabular-nums',
    tone || 'text-emerald-700',
    wash,
    __WEB__ && !value && '!text-[#C3D2C6]'
  )
  // A figure with no breakdown behind it still gets a hover, saying so.
  //
  // It used to return a bare cell, which is indistinguishable from a figure
  // that HAS a breakdown the tooltip failed to open — and that is exactly the
  // report that kept coming back: "the hover does not work on this one". A
  // dead-silent cell cannot tell you whether there is nothing to show or
  // something went wrong, so now it says which.
  const empty = !parties || parties.length === 0
  if (empty && !value) return <TableCell className={cls}>—</TableCell>
  const hasReturn = !empty && parties.some((p) => p.isReturn)
  return (
    <TableCell className={cls}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'cursor-help underline decoration-dotted underline-offset-4',
              hasReturn ? 'decoration-rose-400 decoration-2' : 'decoration-slate-400'
            )}
          >
            {cell}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          {empty ? (
            <div className="text-[11px] leading-snug">
              No party breakdown came back for this figure. The quantity is right — it is the
              detail behind it that is missing, which usually means the breakdown was read for a
              different company or period than the register.
            </div>
          ) : (
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
          )}
        </TooltipContent>
      </Tooltip>
    </TableCell>
  )
}

// The three things a reader comes to this page to do, from the handoff. They
// were two strips before — a Book/Actual pair with a Register/Opening pair
// tucked under one of them — which made "where the register starts" look like
// a mode of the register rather than the thing the register is built on.
//
// Each carries a subtitle because the labels alone do not separate them: "Book
// Stock" and "Actual Stock" are the same three words rearranged until you are
// told one is what the ledger says and the other is what somebody counted.
// Which view the page was on, kept across a refresh.
//
// App.tsx already puts the PAGE in the URL, so F5 on /stock comes back on
// Stock — but which of its three menus, and which tab under them, was ordinary
// component state, so a reload always landed on Book Stock. Someone working
// down the Packed SKU register lost their place every time they refreshed.
//
// sessionStorage rather than the query string, deliberately. App.tsx owns the
// path and rewrites the whole URL whenever `page` changes; a child writing
// search params into that same URL races the parent's effect and loses — and
// child effects run first, so on the render that navigates here it would write
// the view onto the PREVIOUS page's URL. Storage has no such ordering problem.
//
// Per tab and per session on purpose: two tabs can sit on different views, and
// tomorrow starts on Book Stock rather than wherever last week ended.
const STOCK_VIEW_KEY = 'stock.view'

function readStockView<T extends string>(field: string, allowed: readonly T[], fallback: T): T {
  if (!__WEB__) return fallback
  try {
    const raw = sessionStorage.getItem(STOCK_VIEW_KEY)
    if (!raw) return fallback
    const v = (JSON.parse(raw) as Record<string, unknown>)[field]
    return (allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback
  } catch {
    // Private windows, and browsers set to block site data, throw on the
    // accessor itself. Losing the place on refresh is the old behaviour, so
    // falling back to it costs nothing.
    return fallback
  }
}

function writeStockView(view: Record<string, string>): void {
  if (!__WEB__) return
  try {
    sessionStorage.setItem(STOCK_VIEW_KEY, JSON.stringify(view))
  } catch {
    /* see above */
  }
}

const STOCK_MENUS = [
  { key: 'book', label: 'Book / Theoretical Stock', sub: 'WHAT THE BOOKS SAY', icon: BookOpen },
  { key: 'actual', label: 'Actual Stock', sub: 'WHAT WAS COUNTED', icon: ClipboardCheck },
  { key: 'opening', label: 'Opening Stock', sub: 'WHERE IT ALL STARTS', icon: CalendarCheck }
] as const

type StockMenu = (typeof STOCK_MENUS)[number]['key']

// A figure, what it is measured in, and the one line that says why it matters.
// The accent is a 3px rule along the top rather than a tint behind the whole
// card: four tinted cards in a row read as four warnings.
// The KPI strip, folded away.
//
// Every view on this page opens with four cards summarising the table beneath
// it, which on a laptop spent a third of the screen restating what the reader
// had come to read. They fold, shut by default.
//
// Collapsed is not a bare chevron. The same figures stay on one line — all of
// them, whatever the view — so the strip still answers "is anything wrong here"
// at a glance and only has to be opened for the detail behind it. It never
// wraps: past the width it has, the line scrolls sideways rather than pushing
// the control to two rows and giving back the space the fold just saved.
function KpiFold({
  line,
  children
}: {
  line: { k: string; v: string; fg?: string; tip?: string }[]
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 text-left transition-colors hover:bg-[#F7FAF6]',
          open ? 'h-[38px] rounded-b-none border-b-0' : 'h-[42px]'
        )}
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 text-[#5A6B62] transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
          Summary
        </span>
        {!open && (
          <span className="no-scrollbar flex min-w-0 items-baseline gap-x-5 overflow-x-auto">
            {line.map((f) => (
              <span key={f.k} title={f.tip} className="flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="text-[10.5px] font-bold uppercase tracking-[.08em] text-[#8FA79B]">
                  {f.k}
                </span>
                <span className="doc-ref text-[12.5px] font-bold" style={{ color: f.fg || '#0A1F17' }}>
                  {f.v}
                </span>
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="grid gap-2.5 rounded-[4px] rounded-t-none border border-t-0 border-[#D6E2D6] bg-[#F7FAF6] p-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]">
          {children}
        </div>
      )}
    </div>
  )
}

function StockKpi({
  label,
  value,
  unit,
  sub,
  accent,
  fg
}: {
  label: string
  value: string
  unit?: string
  sub: string
  accent: string
  fg?: string
}): React.JSX.Element {
  return (
    <div
      className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
      style={{ borderTop: `3px solid ${accent}` }}
    >
      <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <div
          className="doc-ref min-w-0 truncate text-[21px] font-bold tracking-[-0.03em]"
          style={{ color: fg || '#0A1F17' }}
        >
          {value}
        </div>
        {!!unit && <div className="text-[11px] font-bold text-[#5A6B62]">{unit}</div>}
      </div>
      <div className="mt-1 text-[11.5px] font-semibold leading-[1.45] text-[#5A6B62]">{sub}</div>
    </div>
  )
}

// Stock is read by FACTORY. The oil stands in one set of tanks and the tanks
// do not know which company paid for it — one company can buy while another
// manufactures, and that is still one physical stock.
//
// So the default is the whole site, and the company entries below it are a
// BREAKDOWN of that site, not a different register. Picking one narrows the
// movements to that company's own purchases and sales; the opening drops to
// zero there, because the opening belongs to the site and crediting one
// company with all of it would hand it oil the other company paid for.
function FactoryPicker({
  companies,
  value,
  onChange,
  factoryName
}: {
  companies: Row[]
  value: number[]
  onChange: (ids: number[]) => void
  factoryName: string
}): React.JSX.Element {
  const current = value.length === 0 || value.length === companies.length ? 'factory' : String(value[0])
  const site = factoryName || 'Factory'
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        if (v === 'factory') onChange([])
        else onChange([Number(v)])
      }}
      showCheckbox
    >
      {/* The trigger says WHICH site, not which site plus the word for
          looking at all of it. "— whole site" is the meaningful half only
          inside the open menu, where it distinguishes the site from the
          companies listed under it; on the face of a closed control it is
          six characters of nothing, and it was pushing the name itself into
          an ellipsis. */}
      <SelectTrigger className={cn('h-9 w-[15rem] text-xs', __WEB__ && '!w-auto !min-w-[150px] !max-w-[230px]')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Factory className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', __WEB__ && '!text-[#5A6B62]')} />
          {__WEB__ ? (
            <span className="truncate">
              {current === 'factory'
                ? site
                : companies.find((c) => String(c.id) === current)?.name || site}
            </span>
          ) : (
            <SelectValue />
          )}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="factory">{site} — whole site</SelectItem>
        {companies.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)}>
            {c.name} — movements only
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function StockTable({ rows: allRows, breakdown, label = 'stock', range, onRange, companyPicker, companySplit = {}, stagePicker, companyIds = [], openingFrom = '' }: { rows: Row[]; breakdown: Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[]; produced: Row[]; consumed: Row[] }>; label?: string; range: { from: string; to: string }; onRange: (r: { from: string; to: string }) => void; companyPicker?: React.ReactNode; companySplit?: Record<number, Row[]>; stagePicker?: React.ReactNode; companyIds?: number[]; openingFrom?: string }): React.JSX.Element {
  const ranged = !!(range.from || range.to)
  // A product with no opening, no movement and no closing balance is just noise
  // in a long list, so it can be folded away. Everything below — KPIs, section
  // counts, the grid and the Excel export — reads the filtered set, so what is
  // downloaded is always what is on screen.
  const [hideIdle, setHideIdle] = useState(false)
  // Which category sections are folded shut. Keyed by shut rather than open so
  // the default — every section showing — needs no seeding when the categories
  // on screen change with the filters.
  const [shut, setShut] = useState<Record<string, boolean>>({})
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
          // Always, and before the party — whose book the movement belongs to
          // is read before whose goods they were.
          //
          // It used to appear only when several companies were selected,
          // which is the case where it is least needed: a sheet exported from
          // one company still leaves the desk, gets mailed on and printed,
          // and by then nothing on it says which of the two books it came
          // from. The column costs one cell per row and settles that.
          base.splice(base.findIndex((c) => c.key === 'party'), 0, COMPANY_COLUMN)
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

  // The Complete Production Report: one line per batch, every product it
  // touched as a column. Built in lib/productionReportExcel so this page does
  // not carry thirty lines of column definitions it never draws.
  async function downloadProduction(): Promise<void> {
    setDlBusy('production')
    try {
      const written = await downloadProductionReport(ranged ? range : undefined, companyIds, nowStamp())
      if (!written) toast.error('No production in this period')
      else toast.success(`Exported ${written} production row${written === 1 ? '' : 's'}`)
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
    {/* Superseded on the website by the KPI row above the menu's tables, which
        says the same four things and names the products that closed negative
        instead of only counting them. Two strips of the same figures, one
        under the other, is worse than either. */}
    {!__WEB__ && (
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MiniStat label="Products" value={String(rows.length)} tone="slate" />
        <MiniStat label="Total in" value={formatNum(inFlow)} tone="emerald" />
        <MiniStat label="Total out" value={formatNum(outFlow)} tone="rose" />
        <MiniStat label={negatives ? `In stock · ${negatives} negative` : 'In stock'} value={formatNum(totals.stock)} tone={negatives ? 'amber' : 'sky'} />
      </div>
    )}
    <div className={cn('flex flex-wrap items-center justify-end gap-2', __WEB__ && cn(SK_BAR, '!justify-start !gap-2.5'))}>
      {stagePicker}
      {idleCount > 0 && (
        <Button
          variant={hideIdle ? 'default' : 'outline'}
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            __WEB__ &&
              (hideIdle
                ? '!h-[38px] !gap-[7px] !rounded-[4px] !border !border-[#0B3D2E] !bg-[#0B3D2E] !px-[13px] !text-[12.5px] !font-bold !text-white hover:!bg-[#072B20]'
                : cn(SK_BTN, '!text-[#5A6B62]'))
          )}
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
      {__WEB__ && <span className="mx-0.5 hidden h-[26px] w-px shrink-0 bg-[#DCE7DB] sm:block" />}
      {companyPicker}
      {__WEB__ && <span className="mx-0.5 hidden h-[26px] w-px shrink-0 bg-[#DCE7DB] sm:block" />}
      {/* w-28 could not hold "Custom range", so the one control that tells you
          the period is not a named FY was the one showing an ellipsis. */}
      <FyPicker from={range.from} to={range.to} onRange={(f, t) => onRange({ from: f, to: t })} className={cn('h-9 w-28 text-xs', __WEB__ && '!w-[148px]')} />
      {/* Period for the register: opening balance before it, flows within it. */}
      {!__WEB__ && <span className="text-[11px] font-semibold text-muted-foreground">From</span>}
      <div className="w-40"><DatePicker value={range.from} onChange={(v) => onRange({ ...range, from: v })} max={range.to || undefined} /></div>
      {/* A From earlier than the opening changes nothing here, so say so
          rather than leaving the reader to wonder why the figures did not
          move. The count superseded whatever came before it — that is what
          striking an opening means. */}
      {!!openingFrom && (!range.from || range.from < openingFrom) && (
        <span
          className={cn(
            'flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10.5px] font-semibold text-amber-900',
            // Not a warning — nothing is wrong. It is the opening count
            // telling you where the register starts, so it takes the violet
            // the handoff reserves for exactly that.
            __WEB__ && cn(SK_NOTE, '!rounded-[4px] !border-l-[3px] !px-2.5 !py-1 !text-[11px] !font-bold !text-[#3D3179]')
          )}
          title={`The opening stock was counted on ${formatDate(openingFrom)}, and a counted tank already accounts for everything bought and consumed before it. So the register starts there whatever From says — reaching back earlier would count those movements a second time. They are still on their own documents: the purchase, the dispatch, the production run.`}
        >
          <AlertTriangle className={cn('h-3 w-3 shrink-0', __WEB__ && '!text-[#5B4BA8]')} />
          register begins {formatDate(openingFrom)}
          <button
            type="button"
            className={cn('ml-0.5 underline underline-offset-2 hover:no-underline', __WEB__ && '!font-extrabold !text-[#5B4BA8]')}
            onClick={() => onRange({ ...range, from: openingFrom })}
          >
            set From
          </button>
        </span>
      )}
      <span className={cn('text-[11px] font-semibold text-muted-foreground', __WEB__ && '!-mx-1 !text-[11.5px] !font-semibold !text-[#8FA79B]')}>{__WEB__ ? 'to' : 'To'}</span>
      <div className="w-40"><DatePicker value={range.to} onChange={(v) => onRange({ ...range, to: v })} min={range.from || undefined} /></div>
      {ranged && (
        <Button variant="ghost" size="sm" className={cn('h-8 px-2 text-xs', __WEB__ && SK_CLEAR)} onClick={() => onRange({ from: '', to: '' })}>
          Clear
        </Button>
      )}
      {__WEB__ && (
        <HelpTip
          className="ml-auto mr-0.5 shrink-0 !text-[#8FA79B] hover:!text-[#0B3D2E] [&_svg]:!h-[17px] [&_svg]:!w-[17px]"
          text="Closing = Opening + Receipt + Produced − Consumed − Packed − Dispatch. Balances move on their own: a purchase adds raw oil, a production run consumes inputs and adds outputs, a sale reduces finished goods. A negative closing is a real shortage, never blocked at save."
        />
      )}
      <Popover open={dlOpen} onOpenChange={setDlOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            className={cn(
              'h-9 w-9 bg-emerald-700 text-white shadow-sm hover:bg-emerald-800',
              __WEB__ && '!h-[38px] !w-[38px] !rounded-[4px] !bg-[#0B3D2E] hover:!bg-[#072B20]'
            )}
            title="Download a register as Excel"
            aria-label="Download a register as Excel"
          >
            <Download className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        {/* A LIST of what can be downloaded, and nothing else.
            It used to explain each sheet in two lines of prose, which made a
            four-item menu 22rem wide and taller than the filter row it hangs
            off — and the explanations were read once and then scrolled past
            forever. The four icon colours came from four different palettes
            (emerald, rose, sky, indigo) and none of them was this page's. */}
        <PopoverContent
          align="end"
          className={cn(
            'w-56 p-1',
            __WEB__ && '!w-[236px] !rounded-[4px] !border-[#D6E2D6] !p-[5px] !shadow-[0_10px_30px_rgba(11,61,46,0.13)]'
          )}
        >
          <p
            className={cn(
              'px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
              __WEB__ && '!px-[7px] !pb-[5px] !text-[9.5px] !font-extrabold !tracking-[0.1em] !text-[#7C9188]'
            )}
          >
            {periodLabel}
          </p>
          {([
            { key: 'receipt', icon: TrendingUp, label: 'Receipt register', run: () => downloadMovement('receipt') },
            { key: 'dispatch', icon: TrendingDown, label: 'Dispatch register', run: () => downloadMovement('dispatch') },
            { key: 'flow', icon: Layers, label: 'Stock flow', run: () => downloadFlow(false) },
            { key: 'flowparty', icon: Building2, label: 'Stock flow, by party', run: () => downloadFlow(true) },
            // The production report is a report on the same period as the four
            // above it, so it belongs on the same menu rather than behind a
            // view of its own. Thirty-six columns is a spreadsheet's job.
            { key: 'production', icon: Factory, label: 'Production report', run: () => downloadProduction() }
          ] as const).map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={!!dlBusy}
              onClick={() => void o.run()}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-[7px] text-left text-[13px] font-semibold hover:bg-accent disabled:cursor-wait disabled:opacity-60',
                __WEB__ &&
                  '!gap-[9px] !rounded-[3px] !px-[7px] !py-[7px] !text-[12.5px] !font-bold !text-[#0A1F17] hover:!bg-[#EAF0E9]'
              )}
            >
              {/* One ink for every row — this page's forest green — so the
                  menu reads as part of the register it sits on rather than as
                  four unrelated buttons. */}
              <o.icon className={cn('h-4 w-4 shrink-0 text-emerald-700', __WEB__ && '!h-[15px] !w-[15px] !text-[#0B3D2E]')} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {dlBusy === o.key && <Loader2 className={cn('h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground', __WEB__ && '!text-[#0B3D2E]')} />}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
    {rows.length === 0 ? (
      <div className={cn('rounded-xl border bg-card py-10 text-center text-muted-foreground shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !shadow-none')}>
        {hideIdle && allRows.length ? 'Every product here is at zero for this period.' : 'Nothing here yet.'}
      </div>
    ) : __WEB__ ? (
      /* ONE table, not one per category.
         A card per category gave every section its own header band and its own
         total, so a register of three categories repeated the column names
         three times and ended in four totals. The reader's question — how does
         this product compare with that one — was being asked across four
         separate grids.
         So: one head, one grand total, and the categories become rows inside
         the body that fold. A folded section still states its own totals, so
         collapsing it loses the detail and not the arithmetic. */
      (() => {
        const cols = STOCK_TABLE_COLS(ranged)
        const dash = <span className="text-[#C3D2C6]">—</span>
        const fig = (v: number, fg: string): React.JSX.Element =>
          Math.abs(v) > 1e-9 ? <span style={{ color: fg }}>{formatNum(v)}</span> : dash
        const IN_FG = '#0B6B45'
        const OUT_FG = '#8C2F26'
        return (
          <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6]">
            {/* The wrapper is the scroll container, and a sticky <thead>
                sticks to whichever container scrolls. Without a max-height
                here that container is the PAGE, so the column names peeled off
                the card and rode up over the Stock title and the company
                picker. Bounded, the head stays inside its own card — the same
                arrangement the Packed SKU register already uses. */}
            <Table
              wrapperClassName="max-h-[calc(100vh-330px)]"
              className="doc-ref min-w-[820px] text-[12px] [&_td]:border-l [&_td]:border-l-[#DCE7DB] [&_td]:px-[9px] [&_td]:py-[5px] [&_td:first-child]:border-l-0 [&_th]:h-11 [&_th]:px-[9px]"
            >
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[30px] [&>th]:!p-0 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-[#8FBFA8]">
                  <TableHead />
                  {ranged && <TableHead className={cn('!text-center', SK_RULE, SK_OPEN)}>Open</TableHead>}
                  <TableHead colSpan={2} className={cn('!text-center !text-[#9FE3BF]', SK_RULE, SK_IN)}>In</TableHead>
                  <TableHead colSpan={3} className={cn('!text-center !text-[#F0AFAA]', SK_RULE, SK_OUT)}>Out</TableHead>
                  <TableHead className={cn('!text-center !text-[#C7F03F]', SK_RULE, SK_CLOSE)}>Close</TableHead>
                </TableRow>
                <TableRow className="!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]">
                  {cols.map((h) => (
                    <TableHead
                      key={h.l}
                      className={cn(
                        '!bg-transparent !text-[11px] !font-extrabold !uppercase !tracking-[.07em] !text-[#8FBFA8]',
                        h.r && 'text-right',
                        h.wash,
                        h.fg,
                        !h.r && '!text-white'
                      )}
                    >
                      {h.l}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((grp) => {
                  const gSum = (k: string): number => grp.rows.reduce((t, r) => t + (Number(r[k]) || 0), 0)
                  const gStock = gSum('stock')
                  const open = !shut[grp.label]
                  return (
                    <Fragment key={grp.label}>
                      <TableRow
                        onClick={() => setShut((prev) => ({ ...prev, [grp.label]: !!open }))}
                        className="cursor-pointer !border-y !border-y-[#DCE7DB] !bg-[#EFF5EC] hover:!bg-[#E8F1E4]"
                      >
                        <TableCell className="!py-[7px]">
                          <span className="flex items-center gap-2">
                            <ChevronRight
                              className={cn('h-4 w-4 shrink-0 text-[#5A6B62] transition-transform', open && 'rotate-90')}
                            />
                            <span className="text-[11px] font-extrabold uppercase tracking-[.11em] text-[#0A1F17]">
                              {titleCase(grp.label)}
                            </span>
                            <span className="text-[10.5px] font-bold text-[#5A6B62]">· {grp.rows.length}</span>
                          </span>
                        </TableCell>
                        {ranged && <TableCell className={cn('text-right font-bold', SK_BRULE)}>{fig(gSum('opening'), '#33473E')}</TableCell>}
                        <TableCell className={cn('text-right font-bold', SK_BRULE)}>{fig(gSum('received'), IN_FG)}</TableCell>
                        <TableCell className="text-right font-bold">{fig(gSum('produced'), IN_FG)}</TableCell>
                        <TableCell className={cn('text-right font-bold', SK_BRULE)}>{fig(gSum('consumed'), OUT_FG)}</TableCell>
                        <TableCell className="text-right font-bold">{fig(gSum('packed_out'), OUT_FG)}</TableCell>
                        <TableCell className="text-right font-bold">{fig(gSum('sold'), OUT_FG)}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right !text-[13px] font-bold !tracking-[-0.02em] !bg-[#EAF2E6]',
                            SK_BRULE,
                            gStock < -1e-9 ? '!text-[#B3261E]' : '!text-[#0A1F17]'
                          )}
                        >
                          {formatNum(gStock)}
                        </TableCell>
                      </TableRow>
                      {open &&
                        grp.rows.map((r) => {
                          const closing = Number(r.stock) || 0
                          const neg = closing < -1e-9
                          // How much of everything that came in is still here.
                          // A bar rather than a second figure: the question it
                          // answers — is this tank nearly empty — is a shape.
                          const inflow =
                            (Number(r.opening) || 0) + (Number(r.received) || 0) + (Number(r.produced) || 0)
                          const pct = inflow > 0 ? Math.max(0, Math.min(100, (closing / inflow) * 100)) : 0
                          const mark = neg ? '#B3261E' : pct < 12 && inflow > 0 ? '#C2700A' : 'transparent'
                          return (
                            <TableRow key={r.id as number} className="!border-b-[#DCE7DB] !bg-transparent">
                              <TableCell
                                className="!py-[5px]"
                                style={mark === 'transparent' ? undefined : { boxShadow: `inset 3px 0 0 ${mark}` }}
                              >
                                <span className="flex items-center gap-1.5">
                                  <span className="text-[12.5px] font-bold tracking-[-0.01em] text-[#0A1F17]">{r.name}</span>
                                  {neg && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#B3261E]" />}
                                </span>
                              </TableCell>
                              {ranged && (
                                <TableCell className={cn('text-right', SK_NUM, SK_BRULE, SK_BOPEN)}>
                                  {/* Opening is two different things added
                                      together — the count struck on the
                                      opening morning, and everything that
                                      moved between then and the From date —
                                      and the row could not say which. */}
                                  {Math.abs(Number(r.opening) || 0) > 1e-9 ? (
                                    <CellWithWorkings
                                      value={formatNum(r.opening)}
                                      className="!text-[#33473E]"
                                      title="What this product opened the period at"
                                      lines={[
                                        { left: 'Brought forward', mid: 'the counted opening', right: formatNum(r.opening_brought) },
                                        {
                                          left: 'Moved before this period',
                                          mid: 'received, produced, consumed, dispatched',
                                          right: formatNum((Number(r.opening) || 0) - (Number(r.opening_brought) || 0))
                                        }
                                      ]}
                                      footer={`= ${formatNum(r.opening)} at the start of ${periodLabel}`}
                                    />
                                  ) : (
                                    dash
                                  )}
                                </TableCell>
                              )}
                              <PartyCell
                                uom={String(r.uom || 'MT')}
                                value={Number(r.received)}
                                parties={breakdown[r.id as number]?.receipt || []}
                                wash={cn(SK_NUM, SK_BRULE, SK_BIN)}
                              />
                              <PartyCell
                                uom={String(r.uom || 'MT')}
                                value={Number(r.produced)}
                                parties={breakdown[r.id as number]?.produced || []}
                                wash={cn(SK_NUM, SK_BIN)}
                                caption="Produced by"
                              />
                              <PartyCell
                                uom={String(r.uom || 'MT')}
                                value={Number(r.consumed)}
                                parties={breakdown[r.id as number]?.consumed || []}
                                tone="text-rose-700"
                                wash={cn(SK_NUM, SK_BRULE, SK_BOUT)}
                                caption="Consumed by"
                              />
                              <PartyCell
                                uom={String(r.uom || 'MT')}
                                value={Number(r.packed_out)}
                                parties={breakdown[r.id as number]?.packed || []}
                                tone="text-rose-700"
                                wash={cn(SK_NUM, SK_BOUT)}
                                caption="Packed into"
                              />
                              <PartyCell
                                uom={String(r.uom || 'MT')}
                                value={Number(r.sold)}
                                parties={breakdown[r.id as number]?.dispatch || []}
                                tone="text-rose-700"
                                wash={cn(SK_NUM, SK_BOUT)}
                              />
                              <TableCell
                                className={cn('!py-[5px]', SK_BRULE)}
                                style={{ background: neg ? '#FDF3F2' : '#F7FBF4' }}
                              >
                                <span
                                  className="block text-right text-[13.5px] font-bold tracking-[-0.02em]"
                                  style={{ color: neg ? '#B3261E' : '#0A1F17' }}
                                >
                                  {/* The row's own sum, so the one figure
                                      everybody reads can be checked without
                                      adding six cells across by eye. */}
                                  <CellWithWorkings
                                    value={formatNum(closing)}
                                    title={neg ? 'How this closed below nil' : 'How this closing was reached'}
                                    lines={[
                                      ...(ranged ? [{ left: 'Opening', right: formatNum(r.opening) }] : []),
                                      { left: 'Receipt', right: `+ ${formatNum(r.received)}` },
                                      { left: 'Produced', right: `+ ${formatNum(r.produced)}` },
                                      { left: 'Consumed', right: `− ${formatNum(r.consumed)}` },
                                      { left: 'Packed', right: `− ${formatNum(r.packed_out)}` },
                                      { left: 'Dispatch', right: `− ${formatNum(r.sold)}` }
                                    ]}
                                    footer={
                                      neg
                                        ? `= ${formatNum(closing)} — more has gone out than ever came in, so the register is carrying a balance the mill never had`
                                        : `= ${formatNum(closing)} MT`
                                    }
                                  />
                                </span>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                    </Fragment>
                  )
                })}
                <TableRow className="!border-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]">
                  <TableCell className="!text-[11.5px] !font-extrabold !uppercase !tracking-[.09em] !text-white">
                    Grand total <span className="font-bold text-[#8FBFA8]">· {rows.length} {rows.length === 1 ? 'product' : 'products'}</span>
                  </TableCell>
                  {ranged && <TableCell className={cn('text-right font-bold !text-[#C3D2C6]', SK_RULE)}>{formatNum(totals.opening)}</TableCell>}
                  <TableCell className={cn('text-right font-bold !text-[#9FE3BF]', SK_RULE)}>{formatNum(totals.received)}</TableCell>
                  <TableCell className="text-right font-bold !text-[#9FE3BF]">{formatNum(totals.produced)}</TableCell>
                  <TableCell className={cn('text-right font-bold !text-[#F0AFAA]', SK_RULE)}>{formatNum(totals.consumed)}</TableCell>
                  <TableCell className="text-right font-bold !text-[#F0AFAA]">{formatNum(totals.packed_out)}</TableCell>
                  <TableCell className="text-right font-bold !text-[#F0AFAA]">{formatNum(totals.sold)}</TableCell>
                  <TableCell className={cn('text-right !text-[14px] font-bold !tracking-[-0.02em] !text-[#C7F03F]', SK_RULE, SK_CLOSE)}>
                    {formatNum(totals.stock)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )
      })()
    ) : (
      <div className="space-y-3">
        {groups.map((grp) => {
          const gSum = (k: string): number => grp.rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
          const gStock = gSum('stock')
          return (
            <div key={grp.label} className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !shadow-none')}>
              <div
                className={cn(
                  'flex items-center justify-between bg-[#1a2c56] px-3.5 py-2',
                  __WEB__ && '!bg-[#0B3D2E]'
                )}
              >
                <span className={cn('text-[12px] font-bold uppercase tracking-wide text-white', __WEB__ && '!text-[13px] !font-extrabold !tracking-[.09em]')}>{titleCase(grp.label)}</span>
                <span className={cn('text-[11px] font-medium text-white/70', __WEB__ && '!text-[11.5px] !font-semibold !text-[#8FBFA8]')}>{grp.rows.length} product{grp.rows.length === 1 ? '' : 's'}</span>
              </div>
              <Table
                className={cn(
                  'ruled-slate min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3',
                  __WEB__ && 'doc-ref'
                )}
              >
                <TableHeader>
                  {/* A band naming what the column sets below mean, so Receipt
                      and Produced read as one idea and Consumed / Packed /
                      Dispatch as another — without renaming or merging any
                      column. */}
                  {__WEB__ && (
                    <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[30px] [&>th]:!p-0 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-[#8FBFA8]">
                      <TableHead />
                      {ranged && <TableHead className={cn('!text-center', SK_RULE, SK_OPEN)}>Open</TableHead>}
                      <TableHead colSpan={2} className={cn('!text-center !text-[#9FE3BF]', SK_RULE, SK_IN)}>In</TableHead>
                      <TableHead colSpan={3} className={cn('!text-center !text-[#F0AFAA]', SK_RULE, SK_OUT)}>Out</TableHead>
                      <TableHead className={cn('!text-center !text-[#C7F03F]', SK_RULE, SK_CLOSE)}>Close</TableHead>
                    </TableRow>
                  )}
                  <TableRow className={cn(__WEB__ && '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]')}>
                    {STOCK_TABLE_COLS(ranged).map((h) => (
                      <TableHead
                        key={h.l}
                        className={cn(
                          'bg-slate-100 text-[10px] font-semibold uppercase tracking-wide',
                          h.tone || 'text-slate-700',
                          h.r && 'text-right',
                          __WEB__ &&
                            '!bg-transparent !text-[12px] !font-extrabold !tracking-[.05em] !text-[#8FBFA8]',
                          __WEB__ && h.wash,
                          __WEB__ && h.fg,
                          __WEB__ && !h.r && '!text-white'
                        )}
                      >
                        {h.l}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grp.rows.map((r, i) => (
                    /* The zebra goes on the website: striping rows ACROSS the
                       column washes cross-hatches the grid and both readings
                       get harder. The washes do the work the stripes were
                       doing, and they run the way the meaning does. */
                    <TableRow
                      key={r.id as number}
                      className={cn(
                        'border-b',
                        i % 2 === 1 && 'bg-muted/30',
                        // No hover tint here: a cell background paints over its row's, so
                        // with the column washes on, a row hover would light up the
                        // product name and nothing else. The washes are the guide.
                        __WEB__ && '!border-b-[#DCE7DB] !bg-transparent'
                      )}
                    >
                      <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !tracking-[-0.01em] !text-[#0A1F17]')}>{r.name}</TableCell>
                      {ranged && (
                        <TableCell className={cn('text-right tabular-nums text-slate-700', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOPEN))}>
                          {Number(r.opening) ? formatNum(r.opening) : '—'}
                        </TableCell>
                      )}
                      <PartyCell uom={String(r.uom || 'MT')} value={Number(r.received)} parties={breakdown[r.id as number]?.receipt || []} wash={__WEB__ ? cn(SK_NUM, SK_BRULE, SK_BIN) : undefined} />
                      <TableCell className={cn('text-right tabular-nums text-emerald-700', __WEB__ && cn(SK_NUM, SK_BIN))}>
                        {Number(r.produced) ? formatNum(r.produced) : '—'}
                        {/* Oil run back through the plant to keep it turning
                            while the mill was idle. It is NOT part of the
                            figure above and never moves the closing balance —
                            the same oil went in and came out — but it did
                            happen, and a register that shows nothing at all
                            cannot answer "what was the plant doing that
                            week". Written as the +N -N it is. */}
                        {Number(r.recirculated) > 0 ? (
                          <div
                            className="mt-0.5 whitespace-nowrap text-[10.5px] font-bold tabular-nums text-[#1B4E82]"
                            title="Recirculated — put through the plant and taken off again. No stock moved."
                          >
                            +{formatNum(r.recirculated)} −{formatNum(r.recirculated)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums text-rose-700', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOUT))}>{Number(r.consumed) ? formatNum(r.consumed) : '—'}</TableCell>
                      {/* Oil drawn out of the tank to be packed into SKUs. It is
                          the answer to "the DALDA left but nobody sold it" —
                          without the column the tonnage simply vanishes, and
                          without the hover you cannot see which SKUs took it. */}
                      <PartyCell
                        uom={String(r.uom || 'MT')}
                        value={Number(r.packed_out)}
                        parties={breakdown[r.id as number]?.packed || []}
                        tone="text-rose-700"
                        wash={__WEB__ ? cn(SK_NUM, SK_BOUT) : undefined}
                        caption="Packed into"
                      />
                      <PartyCell uom={String(r.uom || 'MT')} value={Number(r.sold)} parties={breakdown[r.id as number]?.dispatch || []} tone="text-rose-700" wash={__WEB__ ? cn(SK_NUM, SK_BOUT) : undefined} />
                      <TableCell
                        className={cn(
                          'text-right font-bold tabular-nums',
                          Number(r.stock) < -1e-9 ? 'text-red-600' : 'text-sky-900',
                          __WEB__ &&
                            cn(
                              'doc-ref !text-[13.5px] !font-bold !tracking-[-0.02em]',
                              SK_BRULE,
                              SK_BCLOSE,
                              Number(r.stock) < -1e-9 ? '!text-[#B3261E]' : '!text-[#0A1F17]'
                            )
                        )}
                      >
                        {formatNum(r.stock)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {/* The section's own total, in the pale sage the handoff
                      gives a summary row — one step darker than the body so it
                      closes the block without competing with the grand total
                      below. */}
                  <TableRow className={cn('border-t-2 border-teal-500 bg-teal-50 hover:bg-teal-50', __WEB__ && '!border-t !border-t-[#DCE7DB] !bg-[#EFF5EC] hover:!bg-[#EFF5EC]')}>
                    <TableCell className={cn('text-[11px] font-bold uppercase tracking-wide text-teal-900', __WEB__ && '!text-[11px] !font-extrabold !tracking-[.11em] !text-[#0A1F17]')}>
                      {titleCase(grp.label)} total
                    </TableCell>
                    {ranged && <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, SK_BRULE, '!font-bold !text-[#33473E]'))}>{formatNum(gSum('opening'))}</TableCell>}
                    <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, SK_BRULE, '!font-bold !text-[#0B6B45]'))}>{formatNum(gSum('received'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#0B6B45]'))}>{formatNum(gSum('produced'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, SK_BRULE, '!font-bold !text-[#8C2F26]'))}>{formatNum(gSum('consumed'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#8C2F26]'))}>{formatNum(gSum('packed_out'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums text-teal-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#8C2F26]'))}>{formatNum(gSum('sold'))}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums', gStock < -1e-9 ? 'text-red-600' : 'text-teal-900', __WEB__ && cn('doc-ref !text-[13px] !font-bold !tracking-[-0.02em]', SK_BRULE, '!bg-[#EAF2E6]', gStock < -1e-9 ? '!text-[#B3261E]' : '!text-[#0A1F17]'))}>{formatNum(gStock)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )
        })}
        {groups.length > 1 && (
          <div className={cn('overflow-hidden rounded-xl border-2 border-amber-500 bg-amber-100 shadow-sm', __WEB__ && '!rounded-[4px] !border !border-[#0B3D2E] !bg-[#0B3D2E] !shadow-none')}>
            <Table className="ruled-slate min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
              <TableBody>
                <TableRow className={cn('bg-amber-100 hover:bg-amber-100', __WEB__ && '!border-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]')}>
                  <TableCell className={cn('text-[11px] font-bold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.09em] !text-white')}>
                    Grand total across every category
                  </TableCell>
                  {ranged && <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#C3D2C6]'))}>{formatNum(totals.opening)}</TableCell>}
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#9FE3BF]'))}>{formatNum(totals.received)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#9FE3BF]'))}>{formatNum(totals.produced)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#F0AFAA]'))}>{formatNum(totals.consumed)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#F0AFAA]'))}>{formatNum(totals.packed_out)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#F0AFAA]'))}>{formatNum(totals.sold)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn('doc-ref !text-[14px] !font-bold !tracking-[-0.02em]', SK_RULE, SK_CLOSE, '!text-[#C7F03F]'))}>{formatNum(totals.stock)}</TableCell>
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

// Column banding for the register, from the handoff. Eight columns of figures
// give the eye nothing to hold on to, so they are grouped into the four
// readings the row actually contains — what it opened at, what came in, what
// went out, what it closed at — with a lime hairline opening each group and a
// wash behind it. The closing pair takes the lime, because it is the answer
// the row exists to give.
// The register head, shared by every table on the page. Forest with a lime
// hairline between column groups; the two opening sheets take the violet
// instead, because they are the one surface that is not a register.
const SK_HEAD =
  '!bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&_th]:!h-11 [&_th]:!text-[9.5px] [&_th]:!font-extrabold [&_th]:!uppercase [&_th]:!tracking-[.11em] [&_th]:!text-[#8FBFA8]'

// The filter strip from the handoff: a white band under the menu, its controls
// all 38px on a 4px corner in the sage outline. Applied as one descendant rule
// rather than at each call site, because a strip is built from six different
// components — a Select, two DatePickers, a Switch, an Input, a Popover
// trigger — and the one thing that must be true of them is that they line up.
// Dates go mono, so a column of them reads as a column.
const SK_BAR =
  '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3 !py-2.5 ' +
  // A filter strip is read as one object, so its controls share one outline
  // weight and one corner. Hover lifts the border rather than the fill: a
  // filling control on a white strip reads as selected, which none of these
  // are until you open them.
  '[&_[data-slot=select-trigger]]:hover:!border-[#8FA79B] [&_[data-slot=date-picker]]:hover:!border-[#8FA79B] [&_[data-slot=select-trigger]]:!shadow-none ' +
  "[&_[data-slot=select-trigger]]:!h-[38px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-trigger]]:!text-[#0A1F17] " +
  // A DatePicker is a Popover trigger, not an <input> — it renders a Button
  // carrying data-slot="date-picker". Reaching it by that slot rather than by
  // element is the difference between the dates going mono and the SEARCH box
  // going mono while the dates keep the app's default height.
  "[&_[data-slot=date-picker]]:!h-[38px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[12.5px] [&_[data-slot=date-picker]]:!font-medium [&_[data-slot=date-picker]]:!text-[#0A1F17] " +
  '[&_input]:!h-[38px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[12.5px] [&_input]:!font-medium [&_input]:!text-[#0A1F17]'

// The segmented control — Register/Opening, Day wise/Range/All time. A tray in
// the pale sage with the live segment lifted out of it in forest, rather than
// the app's blue pill: on this page the forest is what "selected" looks like.
const SK_SEG = '!gap-[3px] !rounded-[4px] !border !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]'
const SK_SEG_ON = '!rounded-[2px] !bg-[#0B3D2E] !px-3 !text-[12px] !font-extrabold !text-white'
const SK_SEG_OFF =
  '!rounded-[2px] !bg-transparent !px-3 !text-[12px] !font-bold !text-[#5A6B62] hover:!bg-white/70 hover:!text-[#0A1F17]'
const SK_SEG_ITEM = '!h-[30px] !py-0 !leading-none !transition-colors'

// Radix drives the tab strip off data-state rather than a ternary, so the live
// segment has to be described the same way — same tray, same lift, one styling
// vocabulary for both kinds of picker on the page.
const SK_TAB =
  '!h-[30px] !rounded-[2px] !px-3 !py-0 !text-[12px] !font-bold !leading-none !text-[#5A6B62] !shadow-none data-[state=active]:!bg-[#0B3D2E] data-[state=active]:!font-extrabold data-[state=active]:!text-white'

// CLEAR is a link, not a button: it undoes a filter rather than doing
// anything, and giving it a border would put it on a level with the controls
// it cancels.
const SK_CLEAR =
  '!h-[38px] !px-2.5 !text-[11.5px] !font-extrabold !tracking-[.05em] !text-[#0B6B45] hover:!bg-[#EAF0E9] hover:!text-[#0B3D2E]'

// A control that carries an action rather than a filter: the outlined button
// from the handoff, and its lime primary.
const SK_BTN =
  '!h-[38px] !gap-[7px] !rounded-[4px] !border !border-[#C3D2C6] !bg-white !px-[13px] !text-[12.5px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6]'
const SK_BTN_GO =
  '!h-[38px] !gap-1.5 !rounded-[4px] !border-0 !bg-[#C7F03F] !px-[15px] !text-[12.5px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#B9E52C]'

// The violet notice, from the handoff. Reserved for things the opening count
// is telling you — it is the one surface on the page that is not a register,
// and it says so in its own colour rather than borrowing the warning amber.
const SK_NOTE =
  '!rounded-[4px] !border !border-[#D6CEF5] !border-l-4 !border-l-[#5B4BA8] !bg-[#EDE9FB] !px-3.5 !py-[11px]'

// An entry form, as opposed to a filter strip. Same vocabulary, one size up:
// the handoff draws form fields at 42px against the strip's 38px, because
// typing a quantity into something is a heavier act than narrowing a list.
const SK_FORM =
  "[&_[data-slot=select-trigger]]:!h-[42px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-semibold [&_[data-slot=select-trigger]]:!text-[#0A1F17] " +
  '[&_input]:!h-[42px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[12.5px] [&_input]:!font-semibold [&_input]:!text-[#0A1F17] ' +
  '[&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62]'

// The same four groups again, carried down into the body. The head alone was
// only half the idea: below it the eye still met eight identical white columns
// and had to count across to know whether a figure was something coming in or
// going out. So each group gets the palest wash of its own meaning — barely a
// tint, enough to read as a block — and the hairline continues in the body's
// lighter grey rather than the head's lime.
const SK_BRULE = '!border-l !border-l-[#C3D2C6]'
const SK_BOPEN = '!bg-[#FCFDFB] !text-[#33473E]'
const SK_BIN = '!bg-[#F5FBF7] !text-[#0B6B45]'
const SK_BOUT = '!bg-[#FDF8F7] !text-[#8C2F26]'
const SK_BCLOSE = '!bg-[#F2F7EE]'
// Consignment and the opening sheets are the two surfaces on this page that
// are not the mill's own register — someone else's oil, and the day before the
// books start — so their bodies wash violet where a register washes green.
const SK_VOPEN = '!bg-[#FBFAFE] !text-[#33473E]'
const SK_VIN = '!bg-[#F5FBF7] !text-[#0B6B45]'
const SK_VOUT = '!bg-[#FDF8F7] !text-[#8C2F26]'
const SK_VCLOSE = '!bg-[#F4F1FD]'
const SK_VRULE = '!border-l !border-l-[#D6CEF5]'
// Figures take doc-ref, not a second typeface. The handoff sets its numbers
// in IBM Plex Mono; the app is set in Inter and stays that way, and doc-ref
// already gets what the mono was wanted for — tabular figures on a fixed
// pitch, a slashed zero, a little tracking — out of the font we have.
// 14px, not 12.5. This register's whole job is the four counts across a row,
// and they were set smaller than the SKU name beside them — the label read
// louder than the figure it labels.
const SK_NUM = 'doc-ref !text-[14px] !font-bold'

const SK_RULE = '!border-l !border-l-[#C7F03F]/[.18]'
const SK_OPEN = '!bg-white/[0.03]'
const SK_IN = '!bg-[#12855A]/[.16]'
const SK_OUT = '!bg-[#B3261E]/[.14]'
const SK_CLOSE = '!bg-[#C7F03F]/[.1]'

// Shared column header set for every per-category stock table.
function STOCK_TABLE_COLS(
  ranged: boolean
): { l: string; r?: boolean; tone?: string; wash?: string; fg?: string }[] {
  return [
    { l: 'Product' },
    ...(ranged ? [{ l: 'Opening', r: true, tone: 'text-slate-700', wash: cn(SK_RULE, SK_OPEN) }] : []),
    { l: 'Receipt', r: true, tone: 'text-emerald-700', wash: cn(SK_RULE, SK_IN) },
    { l: 'Produced', r: true, tone: 'text-emerald-700', wash: SK_IN },
    { l: 'Consumed', r: true, tone: 'text-rose-700', wash: cn(SK_RULE, SK_OUT) },
    { l: 'Packed', r: true, tone: 'text-rose-700', wash: SK_OUT },
    { l: 'Dispatch', r: true, tone: 'text-rose-700', wash: SK_OUT },
    {
      l: ranged ? 'Closing' : 'In stock',
      r: true,
      tone: 'text-sky-800',
      wash: cn(SK_RULE, SK_CLOSE),
      fg: '!text-[#C7F03F]'
    }
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
  // The four figures, folded away by default like every other view's. This
  // sheet is worked down over twenty minutes and the cards were holding the
  // top of the screen the whole time.
  const [openKpis, setOpenKpis] = useState(false)
  // Which product's PP breakdown is open. PP is one number on this sheet and
  // seven vessels on the plant's own — see components/PpBreakdown.
  const [ppRow, setPpRow] = useState<Row | null>(null)

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

  // A saved breakdown patches its own row and nothing else.
  //
  // Reloading the sheet here would be the obvious move and the wrong one: this
  // screen holds an unsaved draft of every product on it, worked down over
  // twenty minutes, and load() clears the lot. So the one row that changed is
  // updated in place.
  const applyPp = useCallback((productId: number, total: number, lines: Row[]): void => {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        rows: ((prev.rows as Row[]) || []).map((r) =>
          Number(r.id) === productId ? { ...r, pp_lines: lines, pp_qty: lines.length ? total : r.pp_qty } : r
        )
      }
    })
    setDraft((p) => ({
      ...p,
      [productId]: {
        qty: p[productId]?.qty ?? '',
        adj: p[productId]?.adj ?? '',
        rate: p[productId]?.rate ?? '',
        note: p[productId]?.note ?? '',
        // Cleared rather than zeroed when the last stage goes: PP is back to
        // being a figure nobody has stated, which is not the same as nil.
        pp: lines.length ? String(total) : ''
      }
    }))
    setPpRow((cur) => (cur && Number(cur.id) === productId ? { ...cur, pp_lines: lines } : cur))
  }, [])

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
  // The SITE this sheet belongs to. Opening stock is the oil standing in the
  // tanks that morning, and the tanks are not divided between the companies
  // trading through the plant — so there is one sheet per factory, and the
  // company only records who struck it.
  const facName = String(data?.factory_name || '')
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
  // Every product caught in one of those clashes, so a row can ask whether
  // its own name is ambiguous.
  const clashIds = useMemo(
    () => new Set<number>(clashes.flatMap((c) => ((c.ids as number[]) || []).map(Number))),
    [clashes]
  )

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
      <div className={cn('overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6CEF5] !shadow-none')}>
        <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-4 bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-6 py-5', __WEB__ && '!items-center !gap-x-4 !gap-y-2.5 !border-b !border-b-[#D6CEF5] !bg-none !bg-[#EDE9FB] !px-4 !py-3')}>
          <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/20', __WEB__ && '!h-auto !w-auto !bg-transparent !ring-0')}>
            <Layers className={cn('h-5 w-5 text-white', __WEB__ && '!h-[19px] !w-[19px] !text-[#5B4BA8]')} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className={cn('text-[16px] font-bold leading-tight text-white', __WEB__ && '!text-[11px] !font-extrabold !uppercase !tracking-[.13em] !text-[#3D3179]')}>{__WEB__ ? 'Counted on the opening morning' : 'Stock brought forward'}</h3>
              <InfoTip
                className={cn('text-white/60 hover:text-white', __WEB__ && '!text-[#5B4BA8] hover:!text-[#3D3179]')}
                text="The register works out every balance from movements — purchases in, production, dispatches out. Anything already in the tanks before the books opened was never a movement, so it has to be told once. Until it is, oil consumed since that morning reads as stock the mill never had, which is what puts a product below zero."
              />
            </div>
            <p className={cn('mt-1 text-[12px] leading-relaxed text-white/65', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !leading-[1.5] !text-[#4A3D8C]')}>
              {__WEB__
                ? 'Book stock here is derived entirely from movements, so a mill already running needs this count once — the register starts from it and never reaches behind it.'
                : 'What was in the tanks the morning the books began.'}
            </p>
          </div>

          {/* The two settings everything on this screen hangs on — whose tanks,
              and which morning — grouped in their own panel as proper labelled
              fields. They used to run along the same row as the title with
              their labels beside them and a caption stacked under each, four
              text runs deep in the space of one. */}
          <div className={cn('shrink-0 rounded-xl bg-white/[0.08] p-3.5 ring-1 ring-inset ring-white/15', __WEB__ && '!rounded-none !bg-transparent !p-0 !ring-0')}>
            <div className={cn('flex flex-wrap items-end gap-x-4 gap-y-3', __WEB__ && '!items-center !gap-x-3')}>
              {/* The factory, not a company picker. Switching company used to
                  rebuild this sheet for the other set of books; there is one
                  sheet per site now, so a switcher here would look like it
                  changed the figures and change nothing. */}
              {!!facName && (
                <>
                  <div>
                    <div className={cn('mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55', __WEB__ && '!mb-1 !text-[9px] !font-extrabold !tracking-[.13em] !text-[#5B4BA8]')}>
                      Counting for
                      <InfoTip
                        className={cn('text-white/45 hover:text-white', __WEB__ && '!text-[#8478C4] hover:!text-[#3D3179]')}
                        text="Which plant's tanks are being counted. Opening stock belongs to the factory, not to a company: every company trading through this site reads and writes the same sheet, because there is one set of tanks. Purchases, sales and the ledgers stay with the company that booked them."
                      />
                    </div>
                    <div className={cn('flex h-10 w-[15rem] items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 text-[13px] font-semibold text-white', __WEB__ && '!h-9 !w-auto !min-w-[130px] !rounded-[4px] !border-[#C7BCF0] !bg-white !px-3 !text-[12.5px] !font-bold !text-[#3D3179]')}>
                      <Factory className={cn('h-4 w-4 shrink-0 text-white/60', __WEB__ && '!text-[#5B4BA8]')} />
                      <span className="truncate">{facName}</span>
                    </div>
                  </div>
                  <div className={cn('h-10 w-px self-end bg-white/15', __WEB__ && '!h-6 !self-center !bg-[#D6CEF5]')} />
                </>
              )}
              <div>
                <div className={cn('mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55', __WEB__ && '!mb-1 !text-[9px] !font-extrabold !tracking-[.13em] !text-[#5B4BA8]')}>
                  <span>Struck on <span className={cn('text-amber-300', __WEB__ && '!text-[#B3261E]')}>*</span></span>
                  <InfoTip
                    className={cn('text-white/45 hover:text-white', __WEB__ && '!text-[#8478C4] hover:!text-[#3D3179]')}
                    text="The morning the books officially begin. Nothing before it is reconciled against these figures, and every register opens its default period from this day."
                  />
                </div>
                <div
                  className={cn(
                    'w-[11.5rem] [&_button]:h-10 [&_button]:text-[13px] [&_button]:font-semibold [&_button]:text-white [&_button:hover]:bg-white/20',
                    asOf
                      ? '[&_button]:border-white/20 [&_button]:bg-white/10'
                      : '[&_button]:border-amber-300 [&_button]:bg-amber-400/20',
                    __WEB__ &&
                      cn(
                        '!w-[150px] [&_button]:!h-9 [&_button]:!rounded-[4px] [&_button]:!bg-white [&_button]:!text-[12.5px] [&_button]:!font-bold [&_button]:!text-[#3D3179] [&_button:hover]:!bg-[#F8F6FE]',
                        asOf ? '[&_button]:!border-[#C7BCF0]' : '[&_button]:!border-[#B3261E]'
                      )
                  )}
                >
                  <DatePicker value={asOf} onChange={setAsOf} />
                </div>
              </div>
            </div>

            {/* One footer for the notes those fields used to carry stacked
                underneath them — the warning, if there is one, first. */}
            <div className={cn('mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] leading-snug', __WEB__ && '!mt-1.5')}>
              {!!dateNote && (
                <>
                  <span className={cn('flex items-center gap-1 font-semibold text-amber-200', __WEB__ && '!font-bold !text-[#8A5300]')}>
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {dateNote.text}
                    <InfoTip className={cn('text-amber-200/70 hover:text-amber-100', __WEB__ && '!text-[#C2700A] hover:!text-[#8A5300]')} text={dateNote.tip} />
                  </span>
                  <span className={cn('text-white/25', __WEB__ && '!text-[#C7BCF0]')}>·</span>
                </>
              )}
              <span className={cn('text-white/50', __WEB__ && '!font-semibold !text-[#8478C4]')}>every register opens from this day</span>
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
        {/* The handoff gives the opening its own colour — a violet used
            nowhere else in the app, because "where the register starts" is not
            a warning, not a result and not money. It is a beginning, and it
            wanted a hue that says so. */}
        {__WEB__ && (() => {
          const moved = rows.reduce((t, r) => t + (Number(r.movement_closing) || 0), 0)
          const blanks = rows.length - stats.entered
          const line: { k: string; v: string; fg?: string }[] = [
            { k: 'Opens at', v: `${formatNum(stats.total)} MT`, fg: '#3D3179' },
            { k: 'Movements', v: `${formatNum(moved)} MT`, fg: moved < -0.0005 ? '#8C2F26' : '#0A1F17' },
            {
              k: 'Still negative',
              v: stats.stillShort ? String(stats.stillShort) : 'none',
              fg: stats.stillShort ? '#B3261E' : '#0B6B45'
            },
            { k: 'Not counted', v: blanks ? String(blanks) : 'none', fg: blanks ? '#8A5300' : '#0B6B45' }
          ]
          return (
            <button
              type="button"
              onClick={() => setOpenKpis((o) => !o)}
              aria-expanded={openKpis}
              className={cn(
                'flex h-[40px] w-full items-center gap-3 bg-white px-4 text-left transition-colors hover:bg-[#F8F6FE]',
                openKpis && 'border-b border-b-[#EDE9FB]'
              )}
            >
              <ChevronRight
                className={cn('h-4 w-4 shrink-0 text-[#5B4BA8] transition-transform', openKpis && 'rotate-90')}
              />
              <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5B4BA8]">
                Summary
              </span>
              {!openKpis && (
                <span className="no-scrollbar flex min-w-0 items-baseline gap-x-5 overflow-x-auto">
                  {line.map((f) => (
                    <span key={f.k} className="flex items-baseline gap-1.5 whitespace-nowrap">
                      <span className="text-[10.5px] font-bold uppercase tracking-[.08em] text-[#8FA79B]">{f.k}</span>
                      <span className="doc-ref text-[12.5px] font-bold" style={{ color: f.fg || '#0A1F17' }}>
                        {f.v}
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </button>
          )
        })()}
        {(!__WEB__ || openKpis) && (
        <div
          className={cn(
            'grid grid-cols-2 gap-px border-t border-[#d9d2b8] bg-[#e6dfc4] lg:grid-cols-4',
            __WEB__ &&
              '!grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] !gap-2.5 !border-t-0 !bg-transparent !p-4'
          )}
        >
          {(__WEB__
            ? (() => {
                const moved = rows.reduce((t, r) => t + (Number(r.movement_closing) || 0), 0)
                const blanks = rows.length - stats.entered
                const shortNames = rows
                  .filter((r) => Number(r.shortfall) > 0.0005 && !answeredOf(Number(r.id)))
                  .map((r) => String(r.name))
                return [
                  {
                    accent: '#5B4BA8',
                    fg: '#3D3179',
                    label: 'Register opens at',
                    tip: 'The tank figure plus the work already in process, plus any adjustment. The register opens at this total, and the Day close screen shows the same total as the physical count for this date.',
                    value: <span>{formatNum(stats.total)}</span>,
                    unit: 'MT',
                    note:
                      `${stats.entered} of ${rows.length} products counted` +
                      (stats.value > 0 ? ` · ${formatINR(stats.value)}` : '')
                  },
                  {
                    accent: '#0B3D2E',
                    fg: moved < -0.0005 ? '#8C2F26' : '#0A1F17',
                    label: 'Movements since',
                    tip: 'Everything the register has booked after the opening date — purchases in, production, dispatches out. Where this is negative it is the hole the opening figures have to fill; a product consumed before it was ever booked in reads as stock the mill never had.',
                    value: <span>{formatNum(moved)}</span>,
                    unit: 'MT',
                    note: asOf ? `everything booked after ${formatDate(asOf)}` : 'pick the opening date first'
                  },
                  {
                    accent: '#B3261E',
                    fg: stats.stillShort ? '#B3261E' : '#0B6B45',
                    label: 'Still closing negative',
                    tip: 'How many products would STILL close below nil with what is typed right now. This is the number to drive to zero: while it is above zero, the register carries balances the mill never had.',
                    value: <span>{stats.stillShort}</span>,
                    unit: stats.stillShort === 1 ? 'product' : 'products',
                    note: shortNames.length
                      ? `drive this to nil: ${shortNames.slice(0, 3).join(', ')}${shortNames.length > 3 ? ` +${shortNames.length - 3} more` : ''}`
                      : 'every product closes at nil or above'
                  },
                  {
                    accent: '#C2700A',
                    fg: blanks ? '#8A5300' : '#0B6B45',
                    label: 'Not counted yet',
                    tip: 'Products with nothing entered at all. A blank is not the same as a counted nil: blank stays off the register entirely, while a typed 0 says the tank was looked at and found empty.',
                    value: <span>{blanks}</span>,
                    unit: blanks === 1 ? 'product' : 'products',
                    note: 'blank is not the same as a counted nil'
                  }
                ]
              })()
            : [
            {
              accent: '#5B4BA8',
              fg: '#3D3179',
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
              accent: '#C2700A',
              fg: '#8A5300',
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
              accent: '#B3261E',
              fg: '#B3261E',
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
              accent: '#12855A',
              fg: '#0B6B45',
              label: 'Opening value',
              tip: '(Raw + PP) × rate, summed. Only needed if the opening is to be posted to the ledger as well as the stock register; leave the rates blank otherwise.',
              value: <span className="text-[#1a2c56]">{formatINR(stats.value)}</span>,
              note: stats.value > 0 ? 'what the ledger would open at' : 'rates are optional — leave them blank to skip'
            }
          ]).map((k) => (
            <div
              key={k.label}
              className={cn(
                'bg-[#fffdf4] px-5 py-4',
                __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3.5 !py-3'
              )}
              style={__WEB__ ? { borderTop: `3px solid ${k.accent}` } : undefined}
            >
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    'text-[10px] font-bold uppercase tracking-widest text-muted-foreground',
                    __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]'
                  )}
                >
                  {k.label}
                </span>
                <InfoTip text={k.tip} />
              </div>
              {/* text-inherit so the figure takes the card's own accent rather
                  than the navy each value carries for the desktop. */}
              <div
                className={cn(
                  'mt-1.5 text-[22px] font-bold leading-none tabular-nums',
                  __WEB__ && 'doc-ref !mt-1.5 !text-[21px] !tracking-[-0.03em] [&_span]:!text-inherit'
                )}
                style={__WEB__ ? { color: k.fg } : undefined}
              >
                {k.value}
                {__WEB__ && 'unit' in k && !!k.unit && (
                  <span className="ml-1.5 !text-[11px] !font-bold !text-[#5A6B62]" style={{ color: '#5A6B62' }}>
                    {k.unit}
                  </span>
                )}
              </div>
              <div
                className={cn(
                  'mt-2 text-[10.5px] leading-snug text-muted-foreground',
                  __WEB__ && '!mt-1 !text-[11.5px] !font-semibold !leading-[1.45] !text-[#5A6B62]'
                )}
              >
                {k.note}
              </div>
            </div>
          ))}
        </div>
        )}
      </div>

      {/* --------------------------------------------------- name clashes --
          One line per clash. The paragraph explaining what a clash means, and
          why merging would be wrong, is behind the (i) — it is the same
          sentence every time and does not need re-reading on every visit. */}
      {!__WEB__ && clashes.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2', __WEB__ && '!rounded-[4px] !border-[#F0DCB4] !border-l-4 !border-l-[#C2700A] !bg-[#FFFBF2]')}>
          <span className={cn('flex items-center gap-1.5 text-[12px] font-bold text-amber-900', __WEB__ && '!text-[12.5px] !font-extrabold !text-[#8A5300]')}>
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
      <div className={cn('flex flex-wrap items-center gap-3 rounded-xl border border-[#e0d8bd] bg-white px-4 py-3 shadow-sm', __WEB__ && cn(SK_BAR, '!shadow-none'))}>
        <Input
          placeholder="Find a product…"
          className={cn('h-10 w-64 text-[13px]', __WEB__ && '!w-72')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* A statement of where the sheet stands, not a control. */}
        <div className="flex items-center gap-2 text-[12px]">
          <span className={cn('font-semibold text-[#1a2c56]', __WEB__ && '!text-[12.5px] !font-extrabold !text-[#0B3D2E]')}>
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
          <Button onClick={save} disabled={saving || !dirty} className={cn('h-10 bg-[#1a2c56] px-5 hover:bg-[#24407e]', __WEB__ && SK_BTN_GO)}>
            {saving ? 'Saving…' : 'Save opening stock'}
          </Button>
        </div>
      </div>

      {/* ---------------------------------------------------------- sheet */}
      {(['raw', 'intermediate', 'finished'] as const).map((cat) => {
        const catRows = shown.filter((r) => String(r.category) === cat)
        if (!catRows.length) return null
        return (
          <div key={cat} className={cn('overflow-hidden rounded-xl border border-[#d9d2b8] shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6CEF5] !shadow-none')}>
            <div className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-[#d9d2b8] bg-[#f1ecd9] px-4 py-2.5', __WEB__ && '!border-b-[#D6CEF5] !bg-[#F8F6FE]')}>
              <span className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.16em] !text-[#3D3179]')}>
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
              <table className={cn('ruled-cols w-full min-w-[1200px] bg-[#fffdf4] text-[13px]', __WEB__ && cn('!bg-white', '[&_input:focus]:!border-[#5B4BA8] [&_input:focus]:!ring-[#5B4BA8]/20 [&_input]:!rounded-[3px] [&_input]:!border-[#DCE7DB]'))}>
                <thead>
                  {/* What the sheet is actually asking, named once above the
                      columns: what has happened since that morning, what was
                      counted on it, and what the register therefore opens at. */}
                  {__WEB__ && (
                    <tr className="!bg-[#3D3179] text-left text-[11px] font-extrabold uppercase tracking-[.1em] text-[#C7BCF0]">
                      <th className="h-[30px] p-0" />
                      <th className="h-[30px] border-l border-l-white/20 bg-white/[.06] p-0 text-center">Since opening</th>
                      <th colSpan={3} className="h-[30px] border-l border-l-white/20 bg-white/10 p-0 text-center text-white">Counted that morning</th>
                      <th className="h-[30px] border-l border-l-white/20 bg-[#C7F03F]/[.16] p-0 text-center text-[#DDF58F]">Register opens at</th>
                      <th colSpan={3} className="h-[30px] border-l border-l-white/20 p-0" />
                    </tr>
                  )}
                  <tr className={cn('border-b border-[#e0d8bd] bg-[#faf6e8] text-left text-[10px] uppercase tracking-widest text-muted-foreground', __WEB__ && '!border-b-0 !bg-[#5B4BA8] !text-[12px] !font-extrabold !tracking-[.05em] !text-[#DAD2F5]')}>
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
                        <InfoTip text="Work already in process that morning — in the refinery, in a tanker on site, packed but not yet counted as finished. Counted separately from the tank, and the register opens at Raw + PP + Adj. The button beside the box breaks it down by vessel — bleacher, deo scrubber, filter press — with a With FFA / W/O FFA mark on each. Once a breakdown exists it is the only way in, so the register can never disagree with the count it came from." />
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
                    const ppCount = Array.isArray(r.pp_lines) ? (r.pp_lines as Row[]).length : 0
                    return (
                      <tr
                        key={id}
                        className={cn(
                          'border-t border-[#f0ead2] transition-colors hover:bg-[#fbf6e4]',
                          // row-answered is read by .pin-col in main.css, which
                          // has to repaint the tint opaquely — see the note there.
                          answered && 'row-answered bg-emerald-50/40',
                          // The sheet's head is violet, so its rows are too —
                          // the beige belonged to the design this replaced.
                          __WEB__ && cn('!border-t-[#D6CEF5] hover:!bg-[#F8F6FE]', answered && '!bg-[#F3FAF5]')
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
                            <span className={cn('font-medium text-[#1a2c56]', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{String(r.name)}</span>
                            {!__WEB__ && r.code ? (
                              <span className="doc-ref rounded bg-[#f1ecd9] px-1.5 text-[10.5px] text-muted-foreground">
                                {String(r.code)}
                              </span>
                            ) : null}
                            {short > 0.0005 && !answered && (
                              <Badge variant="destructive" className={cn('text-[10px]', __WEB__ && '!rounded-[2px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-[6px] !py-[2px] !text-[9.5px] !font-extrabold !tracking-[.05em] !text-[#B3261E]')}>
                                {__WEB__ ? 'STILL SHORT' : 'Short'}
                              </Badge>
                            )}
                            {/* Blank and zero are different answers, and only
                                one of them means the tank was looked at. */}
                            {__WEB__ && !answered && (
                              <span className="rounded-[2px] bg-[#EAF0E9] px-[6px] py-[2px] text-[9.5px] font-extrabold tracking-[.05em] text-[#5A6B62]">
                                NOT COUNTED
                              </span>
                            )}
                          </div>
                          {/* Only when the name does not identify the row on
                              its own.
                              This line used to be under every product —
                              "CORN OIL · Raw · MT" beside a row already
                              headed CORN OIL — which is the same fact said
                              twice on forty rows to disambiguate the two that
                              need it. RPL appears in this mill once raw and
                              once finished, and THOSE two cannot be told
                              apart by name; everything else can. So the line
                              is kept for a clashing name and dropped for the
                              rest. */}
                          {__WEB__ && clashIds.has(Number(r.id)) && (
                            <div className="doc-ref mt-[3px] text-[10.5px] font-semibold text-[#5A6B62]">
                              {[r.code ? String(r.code) : null, CAT_LABEL[String(r.category)] || null, 'MT']
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          )}
                        </td>
                        <td
                          className={cn(
                            'whitespace-nowrap px-3 py-1.5 text-right tabular-nums',
                            Number(r.movement_closing) < -0.0005 ? 'font-semibold text-rose-700' : 'text-muted-foreground',
                            __WEB__ && cn('doc-ref !text-[12.5px] !font-bold', SK_VRULE, '!bg-[#FCFDFB]')
                          )}
                        >
                          {formatNum(r.movement_closing)}
                          {/* A bare negative here is the most misread figure on
                              the page: it is not a loss, it is the size of the
                              opening this row still needs. Naming it is the
                              difference between "something is wrong" and "type
                              this much". */}
                          {__WEB__ && (
                            <span className="mt-[2px] block text-[9px] font-extrabold uppercase tracking-[.06em] text-[#8FA79B]">
                              {Number(r.movement_closing) < -0.0005 ? 'the hole to fill' : 'net added'}
                            </span>
                          )}
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
                          <div className="flex items-center justify-end gap-1">
                            {/* Locked once a breakdown exists. Two places to
                                type the same figure is how a register ends up
                                disagreeing with the count it was made from, so
                                while the stages are there they are the only
                                way in. */}
                            <input
                              inputMode="decimal"
                              placeholder="0"
                              readOnly={ppCount > 0}
                              title={
                                ppCount > 0
                                  ? `${ppCount} stage${ppCount === 1 ? '' : 's'} add up to this - open the breakdown to change it`
                                  : undefined
                              }
                              className={cn(
                                'doc-ref h-8 w-[74px] rounded-md border px-2 text-right text-[13px] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20',
                                ppCount > 0 ? 'cursor-default bg-muted/60 font-semibold' : 'bg-white'
                              )}
                              value={d.pp}
                              onChange={(e) => setField(id, 'pp', e.target.value.replace(/[^0-9.]/g, ''))}
                            />
                            <button
                              type="button"
                              title={
                                ppCount > 0
                                  ? `PP is made of ${ppCount} stage${ppCount === 1 ? '' : 's'} - open the breakdown`
                                  : 'Break PP down by stage - bleacher, deo scrubber, filter press...'
                              }
                              onClick={() => setPpRow(r)}
                              className={cn(
                                'flex h-8 shrink-0 items-center gap-0.5 rounded-md border px-1.5 text-[10.5px] font-bold transition-colors',
                                ppCount > 0
                                  ? 'border-[#5B4BA8]/40 bg-[#EDE9FB] text-[#3D3179] hover:bg-[#E1DAF8]'
                                  : 'border-input bg-white text-muted-foreground hover:bg-muted'
                              )}
                            >
                              <Layers className="h-3.5 w-3.5" />
                              {ppCount > 0 ? ppCount : null}
                            </button>
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

      <PpBreakdown
        product={ppRow}
        open={!!ppRow}
        onOpenChange={(o) => !o && setPpRow(null)}
        onSaved={applyPp}
      />
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
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
                  className={cn('flex h-9 w-7 shrink-0 items-center justify-center rounded-md border bg-white hover:bg-muted', __WEB__ && '!h-[38px] !w-[30px] !rounded-[4px] !border-[#C3D2C6] !text-[#33473E] hover:!bg-[#EAF0E9]')}
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
            <TabsList className={cn(__WEB__ && SK_SEG)}>
              {DAY_SECTIONS.map((s) => (
                <TabsTrigger key={s.key} value={s.key} className={cn(__WEB__ && SK_TAB)}>{s.title}</TabsTrigger>
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
        {/* The handoff leads on the two figures being compared — what the
            register carries and what was actually counted — rather than on how
            many rows have been filled in. The count of products moves into the
            caption under the total, where it belongs: it qualifies the figure
            rather than competing with it. */}
        {__WEB__ ? (
          <div className="min-w-0 flex-1">
          <KpiFold
            line={[
              { k: 'Book', v: `${formatNum(rows.reduce((a, r) => a + (Number(r.book_qty) || 0), 0))} MT` },
              { k: 'Counted', v: `${formatNum(counted.reduce((a, r) => a + totalOf(r), 0))} MT` },
              {
                k: 'Difference',
                v: formatNum(Math.abs(totalDiff) < 0.0005 ? 0 : totalDiff),
                fg: Math.abs(totalDiff) < 0.0005 ? '#0B6B45' : '#8A5300'
              },
              { k: 'Value', v: formatINR(totalActualValue), fg: '#0B6B45' }
            ]}
          >
            <StockKpi
              label="Book qty"
              value={formatNum(rows.reduce((a, r) => a + (Number(r.book_qty) || 0), 0))}
              unit="MT"
              sub="what the register carries for this date"
              accent="#0B3D2E"
            />
            <StockKpi
              label="Counted total"
              value={formatNum(counted.reduce((a, r) => a + totalOf(r), 0))}
              unit="MT"
              sub={`${counted.length} of ${rows.length} products counted`}
              accent="#C7F03F"
            />
            <StockKpi
              label="Net difference"
              value={formatNum(Math.abs(totalDiff) < 0.0005 ? 0 : totalDiff)}
              unit="MT"
              sub={
                Math.abs(totalDiff) < 0.0005
                  ? 'books and count agree'
                  : totalDiff > 0
                    ? 'physical stock is short of the books'
                    : 'more counted than the books carry'
              }
              accent="#C2700A"
              fg={Math.abs(totalDiff) < 0.0005 ? '#0B6B45' : '#8A5300'}
            />
            <StockKpi
              label="Actual value"
              value={formatINR(totalActualValue)}
              sub={mismatches ? `${mismatches} product${mismatches === 1 ? '' : 's'} disagree with the books` : 'counted total at the rates below'}
              accent="#12855A"
              fg="#0B6B45"
            />
          </KpiFold>
          </div>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 flex-1">
          <StatCard label="Products counted" value={`${counted.length} / ${rows.length}`} />
          <StatCard label="Mismatches" value={String(mismatches)} tone={mismatches ? 'text-amber-700' : 'text-emerald-700'} />
          <StatCard label="Net difference (book − actual)" value={`${formatNum(totalDiff)}`} tone={Math.abs(totalDiff) > 0.0005 ? 'text-amber-700' : ''} />
          <StatCard label="Section actual value" value={formatINR(totalActualValue)} />
        </div>
        )}
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
            {/* Books against Counted, the gap between them, then the money that
                follows from it — the four readings this sheet exists to
                compare, named so the eye can find them. */}
            {__WEB__ && (
              <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[30px] [&>th]:!p-0 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-[#8FBFA8]">
                <TableHead colSpan={2} />
                <TableHead className={cn('!text-center', SK_RULE, SK_OPEN)}>Books</TableHead>
                <TableHead colSpan={3} className={cn('!text-center !text-[#C7F03F]', SK_RULE, SK_CLOSE)}>Counted</TableHead>
                <TableHead className={cn('!text-center !text-[#F0C98A]', SK_RULE, '!bg-[#C2700A]/[.18]')}>Gap</TableHead>
                <TableHead colSpan={2} className={cn('!text-center', SK_RULE, SK_OPEN)}>Valuation</TableHead>
                <TableHead />
              </TableRow>
            )}
            <TableRow className={cn('bg-[#dce6f5] hover:bg-[#dce6f5] [&_th]:h-9 [&_th]:py-0 [&_th]:text-[10px] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-widest [&_th]:text-[#1a2c56]', __WEB__ && SK_HEAD)}>
              <TableHead className={cn(__WEB__ && '!text-white')}>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className={cn('text-right', __WEB__ && cn(SK_RULE, SK_OPEN))}>Book qty</TableHead>
              <TableHead className={cn('w-[130px] bg-[#cfe0f7] text-right', __WEB__ && cn('!bg-[#C7F03F]/[.1]', SK_RULE))}>Raw qty</TableHead>
              <TableHead className={cn('w-[120px] bg-[#cfe0f7] text-right', __WEB__ && '!bg-[#C7F03F]/[.1]')}>PP</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SK_CLOSE)}>Total</TableHead>
              <TableHead className={cn('text-right', __WEB__ && cn(SK_RULE, '!bg-[#C2700A]/[.18]'))}>Difference</TableHead>
              <TableHead className={cn('text-right', __WEB__ && cn(SK_RULE, SK_OPEN))}>Rate (₹)</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SK_OPEN)}>Actual value (₹)</TableHead>
              <TableHead className={cn('w-[180px]', __WEB__ && SK_RULE)}>Note</TableHead>
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
                      off && 'bg-amber-50/70 hover:bg-amber-50',
                      // On the website the columns carry the tinting, so a row
                      // tint would only reach the cells that have none. The
                      // disagreement is marked on the name instead, and the Gap
                      // column says it in figures.
                      __WEB__ && '!border-b-[#DCE7DB] !bg-transparent hover:!bg-transparent'
                    )}
                  >
                    <TableCell className={cn('py-1.5 text-[13px] font-semibold', __WEB__ && cn('!text-[12.5px] !font-bold !text-[#0A1F17]', off && '!bg-[#FFFBF2] !shadow-[inset_3px_0_0_#C2700A]'))}>{r.name}</TableCell>
                    <TableCell className="py-1.5">
                      <span className={cn('rounded border border-[#d9d2b8] bg-[#f4f1e2] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1a2c56]', __WEB__ && '!rounded-[2px] !border-[#DCE7DB] !bg-[#EAF0E9] !px-[7px] !text-[9.5px] !font-extrabold !tracking-[.09em] !text-[#33473E]')}>
                        {CAT_LABEL[r.category] || r.category}
                      </span>
                    </TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] tabular-nums text-muted-foreground', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOPEN))}>{formatNum(r.book_qty)}</TableCell>
                    <TableCell className={cn('bg-[#f2f7ff]/70 py-1.5 text-right', __WEB__ && cn(SK_BRULE, '!bg-[#F6FBEE]'))}>
                      <Input
                        type="number"
                        className={cn('h-7 w-28 bg-white text-right text-[13px]', __WEB__ && '!h-[30px] !rounded-[3px] !border-[#C3D2C6] !text-[12.5px] !font-bold')}
                        placeholder="—"
                        value={r.actual_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'actual_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className={cn('bg-[#f2f7ff]/70 py-1.5 text-right', __WEB__ && '!bg-[#F6FBEE]')}>
                      <Input
                        type="number"
                        className={cn('h-7 w-24 bg-white text-right text-[13px]', __WEB__ && '!h-[30px] !rounded-[3px] !border-[#DCE7DB] !text-[12.5px] !font-semibold')}
                        placeholder="—"
                        value={r.pp_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'pp_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn('doc-ref !text-[13px] !font-bold', '!bg-[#F6FBEE] !text-[#0A1F17]'))}>
                      {has ? formatNum(totalOf(r)) : '—'}
                    </TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] font-semibold tabular-nums', off ? (diff > 0 ? 'text-amber-700' : 'text-red-600') : 'text-muted-foreground', __WEB__ && cn(SK_NUM, SK_BRULE, '!bg-[#FFFBF2] !font-bold', off ? '!text-[#8A5300]' : '!text-[#8FA79B]'))}>
                      {has ? formatNum(diff) : '—'}
                    </TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] tabular-nums text-muted-foreground', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOPEN, '!font-medium !text-[#5A6B62]'))}>{rateOf(r) ? formatNum(rateOf(r)) : '—'}</TableCell>
                    <TableCell className={cn('py-1.5 text-right text-[13px] font-medium tabular-nums', __WEB__ && cn(SK_NUM, SK_BOPEN, '!font-bold !text-[#0A1F17]'))}>{has ? formatINR(actualValueOf(r)) : '—'}</TableCell>
                    <TableCell className={cn('py-1.5', __WEB__ && SK_BRULE)}>
                      <Input
                        className={cn('h-7 bg-white text-[13px]', __WEB__ && '!h-[30px] !rounded-[3px] !border-[#DCE7DB] !text-[12.5px] !font-medium')}
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
              <TableRow className={cn('border-t-2 border-[#1a2c56] bg-[#f0ecd9] text-[#1a2c56] hover:bg-[#f0ecd9]', __WEB__ && '!border-0 !bg-[#0B3D2E] !text-white hover:!bg-[#0B3D2E]')}>
                <TableCell colSpan={2} className={cn('py-2 text-[12px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.09em] !text-white')}>Grand total</TableCell>
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
                  {formatNum(rows.reduce((a, r) => a + (Number(r.book_qty) || 0), 0))}
                </TableCell>
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
                  {formatNum(rows.reduce((a, r) => a + (Number(r.actual_qty) || 0), 0))}
                </TableCell>
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
                  {formatNum(rows.reduce((a, r) => a + (Number(r.pp_qty) || 0), 0))}
                </TableCell>
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
                  {formatNum(rows.reduce((a, r) => a + totalOf(r), 0))}
                </TableCell>
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
                  {formatNum(
                    rows.reduce(
                      (a, r) =>
                        a + ((r.actual_qty !== null && r.actual_qty !== '') || (r.pp_qty !== null && r.pp_qty !== '') ? diffOf(r) : 0),
                      0
                    )
                  )}
                </TableCell>
                <TableCell className="py-2" />
                <TableCell className={cn('py-2 text-right text-[13px] font-bold tabular-nums', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold !text-[#C3D2C6]'))}>
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
          // The same hook select.tsx exposes, so a strip that sizes its
          // dropdowns sizes this one too. Without it this was the one control
          // on the row still at 32px with a 6px corner.
          data-slot="select-trigger"
          className={cn(
            'flex h-8 min-w-[11rem] max-w-xs items-center gap-1.5 rounded-md border bg-white px-2.5 text-[13px]',
            'focus:outline-none focus:ring-2 focus:ring-primary/40',
            !value.length && 'text-muted-foreground',
            __WEB__ && '!min-w-[140px] !max-w-[190px] !shrink-0'
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
  // This load takes an as-of date, not the background flag — wrapped so the
  // hook cannot pass one into it. It raises no spinner, so it never blinked.
  useLiveRefresh(() => load())

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
            <div className={cn('mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-white/55', __WEB__ && '!mb-1 !text-[9px] !font-extrabold !tracking-[.13em] !text-[#5B4BA8]')}>
              <span>Counted on <span className="text-amber-300">*</span></span>
              <InfoTip
                className={cn('text-white/45 hover:text-white', __WEB__ && '!text-[#8478C4] hover:!text-[#3D3179]')}
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
          <table className={cn('ruled-cols w-full min-w-[900px] bg-[#fffdf4] text-[13px]', __WEB__ && cn('!bg-white', '[&_input:focus]:!border-[#5B4BA8] [&_input:focus]:!ring-[#5B4BA8]/20 [&_input]:!rounded-[3px] [&_input]:!border-[#DCE7DB]'))}>
            <thead>
              <tr className={cn('border-b border-[#e0d8bd] bg-[#faf6e8] text-left text-[10px] uppercase tracking-widest text-muted-foreground', __WEB__ && '!border-b-0 !bg-[#5B4BA8] !text-[12px] !font-extrabold !tracking-[.05em] !text-[#DAD2F5]')}>
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
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

  // What a full pack of this SKU weighs — the Box, Jar, Pouch or Case
  // itself, not the stock standing in it.
  //
  // base_per_pouch is one COUNTED piece and pouches_per_box is how many of
  // them a case holds, so the product is the pack. For most SKUs the case
  // holds one piece and this equals the Pack column beside it; where it does
  // not — 90 pouches of 200 ML, 12 bottles of 1 L — the pack weight is the
  // figure nobody can work out in their head, and it is the one a loading
  // sheet is written from.
  //
  // Kept in the SKU's own base unit rather than converted: a KG SKU and an L
  // SKU do not belong in one column of numbers, and saying which is which is
  // what stops them being added together.
  const packTotal = (r: Row): { qty: number; uom: string } => ({
    qty: (Number(r.base_per_pouch) || 0) * (Number(r.pouches_per_box) || 1),
    uom: String(r.base_uom || 'KG')
  })

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
      <div className={cn('flex flex-wrap items-center gap-2', __WEB__ && cn(SK_BAR, '!gap-2.5'))}>
        {!__WEB__ && (
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
        )}
        {skuView === 'register' && (
          <>
        {!__WEB__ && <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-border sm:block" />}
        <div className={cn('inline-flex rounded-lg border p-0.5', __WEB__ && SK_SEG)}>
          {(
            [
              ['day', __WEB__ ? 'Day' : 'Day wise'],
              ['range', 'Range'],
              ['all', __WEB__ ? 'All' : 'All time']
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
                spanMode === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                __WEB__ && cn(SK_SEG_ITEM, spanMode === k ? SK_SEG_ON : SK_SEG_OFF)
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
        {__WEB__ && (
          <>
            <span className="mx-0.5 hidden h-[26px] w-px shrink-0 bg-[#DCE7DB] sm:block" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU…"
              className="!h-[38px] !min-w-[130px] !flex-1 !rounded-[4px] !border-[#C3D2C6] !text-[12.5px] !font-medium"
            />
            <SkuMultiSelect
              skus={rows}
              value={skuPick}
              onChange={(v) => {
                allPicked.current = v.length === rows.length
                setSkuPick(v)
              }}
            />
            {/* A switch with a label beside it was two objects for one binary,
                and it did not line up with anything else on the strip. It is
                the same toggle Book Stock uses now. */}
            <Button
              type="button"
              variant={hideEmpty ? 'default' : 'outline'}
              size="sm"
              onClick={() => setHideEmpty(!hideEmpty)}
              className={cn(
                'shrink-0',
                hideEmpty
                  ? '!h-[38px] !gap-[7px] !rounded-[4px] !border !border-[#0B3D2E] !bg-[#0B3D2E] !px-[13px] !text-[12.5px] !font-bold !text-white hover:!bg-[#072B20]'
                  : cn(SK_BTN, '!shrink-0 !text-[#5A6B62]')
              )}
            >
              {hideEmpty ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              Untouched
            </Button>
            <span className="shrink-0 whitespace-nowrap text-[11px] font-bold text-[#8FA79B]">
              {shown.length === rows.length
                ? `${rows.length} SKUs`
                : `${shown.length}/${rows.length}`}
            </span>
            <span className="mx-0.5 hidden h-[26px] w-px shrink-0 bg-[#DCE7DB] sm:block" />
          </>
        )}
        <div className={cn('ml-auto flex items-center gap-2', __WEB__ && '!ml-0 !gap-2')}>
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
          <Button
            variant="outline"
            size="sm"
            onClick={downloadCountSheet}
            disabled={!shown.length}
            title={__WEB__ ? 'Download a blank count sheet for this day' : undefined}
            className={cn(__WEB__ && '!h-[38px] !w-[38px] !rounded-[4px] !border-[#C3D2C6] !p-0 !text-[#33473E] hover:!bg-[#F7FAF6]')}
          >
            <Download className="h-4 w-4" /> {!__WEB__ && 'Count sheet'}
          </Button>
          <Button
            size="sm"
            className={cn('bg-emerald-600 hover:bg-emerald-700', __WEB__ && cn(SK_BTN_GO, '!shrink-0'))}
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            <Upload className="h-4 w-4" /> {importing ? 'Uploading…' : __WEB__ ? 'Upload' : 'Upload closing'}
          </Button>
          {__WEB__ && (
            <HelpTip
              className="mr-0.5 shrink-0 !text-[#8FA79B] hover:!text-[#0B3D2E] [&_svg]:!h-[17px] [&_svg]:!w-[17px]"
              text={
                dayMode
                  ? 'Day wise: opening (brought forward) + packed in on this date − dispatched on this date = closing. Rows with movement on the day are tinted. Closing (MT) = pieces × pack size (1 L counted as 1 KG). Use the sliders icon for one SKU, or Count sheet → Upload closing to set the whole day at once.'
                  : 'All time: packs added − packs sold on dispatched PACKED sales = on hand. On hand (MT) = pieces × pack size (1 L counted as 1 KG).'
              }
            />
          )}
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
                    { header: 'Total', key: 'pack_total', value: (r) => (packTotal(r).qty > 0 ? `${formatNum(packTotal(r).qty)} ${packTotal(r).uom}` : '') },
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
                    { header: 'Total', key: 'pack_total', value: (r) => (packTotal(r).qty > 0 ? `${formatNum(packTotal(r).qty)} ${packTotal(r).uom}` : '') },
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

      {!__WEB__ && skuView === 'opening' ? (
        <SkuOpeningStock onSaved={() => void load()} />
      ) : (
      <>
      {/* The filters that used to sit here are on the strip above, which is
          where they belong: narrowing the list and choosing the period are the
          same act of deciding what to look at. Desktop keeps its own second
          row — it has less width to play with and no reason to change. */}
      {!__WEB__ && (
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
        <span className="ml-auto text-[12px] text-muted-foreground">
          {shown.length === rows.length
            ? `${rows.length} SKUs`
            : `${shown.length} of ${rows.length} SKUs`}
        </span>
      </div>
      )}

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
          __WEB__ ? (
            /* Four cards, same language as Book Stock and the opening sheet.
               Pieces and tonnage were one cell reading "1,621 pcs · 23.943 MT"
               — two different questions wedged into one figure, and neither
               could be read at a glance. They get a card each. */
            <div className="space-y-2.5">
              <KpiFold
                line={[
                  { k: 'Closing', v: `${formatNum(sum(shown, handOf))} pcs` },
                  { k: 'Tonnage', v: `${formatNum(shownMT)} MT` },
                  { k: dayMode ? 'Packed in' : 'Packed', v: formatNum(sum(shown, inOf)), fg: '#0B6B45' },
                  { k: dayMode ? 'Dispatched' : 'Sold', v: formatNum(sum(shown, outOf)), fg: '#8C2F26' },
                  {
                    k: 'Below zero',
                    v: negatives ? `${negatives} SKU${negatives === 1 ? '' : 's'}` : 'none',
                    fg: negatives ? '#B3261E' : '#0B6B45',
                    tip: negatives
                      ? 'More has been dispatched than was ever packed in. Either the packing was never entered, or the shelf was never counted. Open the SKU with the sliders icon to see the entries behind it, or strike an opening count on Opening Stock → Packed SKU if the packs predate the books.'
                      : undefined
                  }
                ]}
              >
                <StockKpi
                  label={dayMode ? 'Closing' : 'On the shelf'}
                  value={formatNum(sum(shown, handOf))}
                  unit="pcs"
                  sub={`${shown.length} SKU${shown.length === 1 ? '' : 's'}${part ? ` of ${rows.length}` : ''}`}
                  accent="#C7F03F"
                />
                <StockKpi
                  label="As tonnage"
                  value={formatNum(shownMT)}
                  unit="MT"
                  sub="each count at its own pack size"
                  accent="#0B3D2E"
                />
                <StockKpi
                  label={dayMode ? 'Packed in' : 'Packed (total)'}
                  value={formatNum(sum(shown, inOf))}
                  unit="pcs"
                  sub={dayMode ? 'on the day shown' : 'since the counted morning'}
                  accent="#12855A"
                  fg="#0B6B45"
                />
                <StockKpi
                  label={dayMode ? 'Dispatched' : 'Sold (packed)'}
                  value={formatNum(sum(shown, outOf))}
                  unit="pcs"
                  sub={dayMode ? 'on the day shown' : 'since the counted morning'}
                  accent="#B3261E"
                  fg="#8C2F26"
                />
              </KpiFold>
              {!__WEB__ && negatives > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#F0D6D4] bg-[#FDF3F2] px-2.5 py-1 text-[11.5px] font-bold text-[#B3261E]">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {negatives} below zero
                  <InfoTip
                    className="text-[#B3261E] hover:text-[#8C2F26]"
                    text="More has been dispatched than was ever packed in. Either the packing was never entered, or the shelf was never counted. Open the SKU with the sliders icon to see the entries behind it, or strike an opening count on the Opening stock tab if the packs predate the books."
                  />
                </span>
              )}
            </div>
          ) : (
          /* Desktop keeps the one strip: three figures, pieces and tonnes read
             together as one closing balance, and the below-zero warning riding
             alongside rather than claiming a band of its own. */
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
        )
      })()}

      <div className={cn('rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !shadow-none')}>
        <Table
          wrapperClassName={cn('max-h-[calc(100vh-360px)] rounded-xl', __WEB__ && '!rounded-[4px]')}
          className={cn('text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3', __WEB__ && 'doc-ref')}
        >
          <TableHeader className="sticky top-0 z-10">
            {/* The same four readings as the Book Stock register — what it
                opened at, what came in, what went out, what it closed at — so
                a reader moving between the two tabs is not learning a second
                table. Closing spans two because pieces and tonnage are one
                answer counted twice. */}
            {__WEB__ && (
              <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[30px] [&>th]:!p-0 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-[#8FBFA8]">
                <TableHead colSpan={4} />
                {dayMode && <TableHead className={cn('!text-center', SK_RULE, SK_OPEN)}>Open</TableHead>}
                <TableHead className={cn('!text-center !text-[#9FE3BF]', SK_RULE, SK_IN)}>In</TableHead>
                <TableHead className={cn('!text-center !text-[#F0AFAA]', SK_RULE, SK_OUT)}>Out</TableHead>
                <TableHead className={cn('!text-center !text-[#C7F03F]', SK_RULE, SK_CLOSE)}>Close</TableHead>
                <TableHead />
              </TableRow>
            )}
            <TableRow className={cn('bg-slate-200 hover:bg-slate-200', __WEB__ && cn(SK_HEAD, '!border-b-0'))}>
              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && '!text-white')}>SKU</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Pack</TableHead>
              {/* What a full pack weighs, beside the size of one piece. */}
              <TableHead className={cn('text-left text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && '!text-white')}>
                Total
              </TableHead>
              {/* The unit every figure on the row is counted in — the SKU's own
                  Type off the Packed SKU master. Without it the numbers across
                  the row are bare counts of an unnamed thing: Pack size alone
                  does not say whether 3,303 is jars, tins or pouches. */}
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Type</TableHead>
              {dayMode && (
                <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && cn(SK_RULE, SK_OPEN))}>Opening</TableHead>
              )}
              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && cn(SK_RULE, SK_IN))}>
                {dayMode ? 'Packed in' : 'Packed (total)'}
              </TableHead>
              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && cn(SK_RULE, SK_OUT))}>
                {dayMode ? 'Dispatch' : 'Sold'}
              </TableHead>
              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && cn(SK_RULE, SK_CLOSE, '!text-[#C7F03F]'))}>
                {dayMode ? 'Closing' : 'On hand'}
              </TableHead>
              {!__WEB__ && (
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Closing (MT)' : 'On hand (MT)'}
              </TableHead>
              )}
              <TableHead className={cn('w-[64px] text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && SK_RULE)}>
                Update
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={(dayMode ? 10 : 9) - (__WEB__ ? 1 : 0)} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={(dayMode ? 10 : 9) - (__WEB__ ? 1 : 0)} className="py-12 text-center text-muted-foreground">
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
                  // Pieces and tonnage are two different questions and the row
                  // was only answering the second one at Closing. A pack count
                  // means nothing across SKUs of different sizes — 45 boxes of
                  // 8.4kg and 45 tins of 15kg are not comparable quantities —
                  // so every count states what it weighs underneath it.
                  const mtOf = (pieces: number): number =>
                    (pieces * Number(r.base_per_pouch || 0)) / 1000
                  // The tonnage as a chip, not a slash.
                  //
                  // "1,548 / 23.22 MT" is one string doing two jobs: the count
                  // in the SKU's own Type, which is what was entered, and what
                  // that weighs, which is what compares across SKUs. Run
                  // together they read as a fraction. Boxed, the count stays
                  // the figure and the weight sits beside it as a second fact.
                  const mtLine = (pieces: number): React.JSX.Element | null =>
                    Math.abs(pieces) > 1e-9 && Number(r.base_per_pouch || 0) > 0 ? (
                      <span className="ml-1.5 inline-block whitespace-nowrap rounded-[2px] border border-[#D6E2D6] bg-[#F1F5EF] px-[6px] py-[1px] align-middle text-[11.5px] font-bold text-[#33473E]">
                        {formatNum(mtOf(pieces))} MT
                      </span>
                    ) : null
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
                      className={cn(
                        'border-b',
                        i % 2 === 1 && 'bg-muted/30',
                        touched && 'bg-sky-50/70 hover:bg-sky-50',
                        // The zebra and the moved-today tint both painted the
                        // whole row, which the column washes now do better and
                        // more meaningfully. "Moved today" survives as a mark
                        // on the name cell — see below — because a cell
                        // background covers its row's anyway.
                        __WEB__ && '!border-b-[#DCE7DB] !bg-transparent'
                      )}
                    >
                      <TableCell className={cn('font-medium', __WEB__ && cn('!text-[12.5px] !font-bold !text-[#0A1F17]', touched && '!bg-[#F5FBF7] !shadow-[inset_3px_0_0_#C7F03F]'))}>
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
                      <TableCell className={cn('whitespace-nowrap text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>{unitLabel(r)}</TableCell>
                      {/* A property of the SKU, so it is here whether or not
                          any is on hand — an empty shelf does not change what
                          a case weighs. */}
                      <TableCell className={cn('whitespace-nowrap text-left tabular-nums', __WEB__ && (packTotal(r).qty > 0 ? '!text-[12.5px] !font-bold !text-[#0A1F17]' : '!text-[12.5px] !font-semibold !text-[#C3D2C6]'))}>
                        {packTotal(r).qty > 0 ? (
                          <>
                            {formatNum(packTotal(r).qty)}
                            <span className="ml-1 text-[10.5px] font-semibold text-[#5A6B62]">{packTotal(r).uom}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className={cn('rounded bg-slate-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-600', __WEB__ && '!rounded-[2px] !border !border-[#DCE7DB] !bg-[#EAF0E9] !px-[7px] !py-[2px] !text-[9.5px] !font-extrabold !tracking-[.09em] !text-[#33473E]')}>
                          {pieceLabel(r)}
                        </span>
                      </TableCell>
                      {dayMode && (
                        <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOPEN))}>
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
                          {__WEB__ && mtLine(Number(r.opening) || 0)}
                        </TableCell>
                      )}
                      <TableCell className={cn('text-right font-medium tabular-nums text-emerald-700', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BIN))}>
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
                        {__WEB__ && mtLine(inQty)}
                      </TableCell>
                      <TableCell className={cn('text-right font-medium tabular-nums text-red-600', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BOUT))}>
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
                        {__WEB__ && mtLine(outQty)}
                      </TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', onHand < -1e-6 ? 'text-red-600' : 'text-slate-900', __WEB__ && cn('doc-ref !text-[13px] !font-bold', SK_BRULE, SK_BCLOSE, onHand < -1e-6 ? '!text-[#B3261E]' : '!text-[#0A1F17]'))}>
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
                        {__WEB__ && mtLine(onHand)}
                      </TableCell>
                      {/* ...so the column that existed only to carry it goes.
                          Two cells side by side saying the same thing is worse
                          than either of them alone. */}
                      {!__WEB__ && (
                      <TableCell className="text-right tabular-nums text-violet-700">{formatNum(skuMT(r))}</TableCell>
                      )}
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
                <TableRow className={cn('border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100', __WEB__ && '!border-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]')}>
                  {/* Nothing is summed under Total: adding pack weights
                      answers no question, and adding KG to L answers a wrong
                      one. The sheet's tonnage is at Closing, where it has
                      always been. */}
                  <TableCell colSpan={dayMode ? 5 : 4} className={cn('font-bold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.09em] !text-white')}>
                    Total{shown.length !== rows.length ? ' (filtered)' : ''}
                  </TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#9FE3BF]'))}>
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0), 0))}
                  </TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, '!font-bold', '!text-[#F0AFAA]'))}>
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0), 0))}
                  </TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, SK_RULE, SK_CLOSE, '!font-bold', '!text-[#C7F03F]'))}>
                    {formatNum(shown.reduce((s, r) => s + (Number(r.on_hand) || 0), 0))}
                    {__WEB__ && (
                      <span className="whitespace-nowrap text-[11px] font-semibold text-[#DDF58F]">
                        <span className="text-[#8FBFA8]">{' / '}</span>
                        {formatNum(shownMT)} MT
                      </span>
                    )}
                  </TableCell>
                  {!__WEB__ && (
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(shownMT)} MT</TableCell>
                  )}
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
      {!__WEB__ && (
      <p className="text-xs text-muted-foreground">
        {dayMode
          ? 'Day wise: opening (brought forward) + packed in on this date − dispatched on this date = closing. Rows with movement on the day are tinted. Closing (MT) = pieces × pack size (1 L counted as 1 KG). Use the sliders icon for one SKU, or Count sheet → Upload closing to set the whole day at once.'
          : 'All time: packs added − packs sold on dispatched PACKED sales = on hand. On hand (MT) = pieces × pack size (1 L counted as 1 KG).'}
      </p>
      )}
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
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
      {/* The same four cards as every other view, in consignment's violet.
          They were MiniStats — a different, smaller object saying the same
          kind of thing — which made this tab look like a different app. */}
      {__WEB__ ? (
        <KpiFold
          line={[
            { k: 'Parties', v: String(byParty.length) },
            { k: 'Deposited', v: `${formatNum(tot.deposited)} MT`, fg: '#0B6B45' },
            { k: 'Invoiced', v: `${formatNum(tot.invoiced)} MT`, fg: '#8C2F26' },
            { k: mncRanged ? 'Closing' : 'Balance', v: `${formatNum(tot.balance)} MT`, fg: '#3D3179' }
          ]}
        >
          <StockKpi
            label="Parties"
            value={String(byParty.length)}
            unit={byParty.length === 1 ? 'supplier' : 'suppliers'}
            sub="holding stock at this site"
            accent="#5B4BA8"
            fg="#3D3179"
          />
          <StockKpi
            label={mncRanged ? 'Deposited (period)' : 'Deposited'}
            value={formatNum(tot.deposited)}
            unit="MT"
            sub="brought in and still theirs"
            accent="#12855A"
            fg="#0B6B45"
          />
          <StockKpi
            label={mncRanged ? 'Invoiced (period)' : 'Invoiced (became ours)'}
            value={formatNum(tot.invoiced)}
            unit="MT"
            sub="billed to us, so now our stock"
            accent="#B3261E"
            fg="#8C2F26"
          />
          <StockKpi
            label={mncRanged ? 'Closing (supplier owned)' : 'Balance (supplier owned)'}
            value={formatNum(tot.balance)}
            unit="MT"
            sub="in our tanks, on their books"
            accent="#3D3179"
            fg="#3D3179"
          />
        </KpiFold>
      ) : (
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MiniStat label="Parties" value={String(byParty.length)} tone="violet" />
        <MiniStat label={mncRanged ? 'Deposited (period)' : 'Deposited'} value={formatNum(tot.deposited)} tone="emerald" />
        <MiniStat label={mncRanged ? 'Invoiced (period)' : 'Invoiced (became ours)'} value={formatNum(tot.invoiced)} tone="rose" />
        <MiniStat label={mncRanged ? 'Closing (supplier owned)' : 'Balance (supplier owned)'} value={formatNum(tot.balance)} tone="violet" />
      </div>
      )}
      <div className={cn('flex flex-wrap items-center justify-between gap-2', __WEB__ && SK_BAR)}>
        <div className="flex flex-wrap items-center gap-2">
          <FyPicker from={mncFrom} to={mncTo} onRange={(f, t) => { setMncFrom(f); setMncTo(t) }} className="h-9 w-28 text-xs" />
          <span className={cn('text-[11px] font-semibold text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !uppercase !tracking-[.11em] !text-[#8FA79B]')}>From</span>
          <div className="w-40"><DatePicker value={mncFrom} onChange={(v) => setMncFrom(v || '')} max={mncTo || undefined} /></div>
          <span className={cn('text-[11px] font-semibold text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !uppercase !tracking-[.11em] !text-[#8FA79B]')}>To</span>
          <div className="w-40"><DatePicker value={mncTo} onChange={(v) => setMncTo(v || '')} min={mncFrom || undefined} /></div>
          {mncRanged && (
            <Button variant="ghost" size="sm" className={cn('h-8 px-2 text-xs', __WEB__ && SK_CLEAR)} onClick={() => { setMncFrom(''); setMncTo('') }}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className={cn(__WEB__ && SK_BTN)} onClick={() => openOpeningStock()}>
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
      <div className={cn('rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !shadow-none')}>
        <Table
          wrapperClassName={cn('max-h-[calc(100vh-330px)] rounded-xl', __WEB__ && '!rounded-[4px]')}
          className="min-w-[720px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader>
            <TableRow>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-white')}>Party / product</TableHead>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-[#C7BCF0]')}>Opening</TableHead>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-emerald-700', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-[#9FE3BF]')}>Deposited</TableHead>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-rose-700', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-[#F0AFAA]')}>Invoiced</TableHead>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-violet-900', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-white')}>{mncRanged ? 'Closing' : 'Balance'}</TableHead>
              <TableHead className={cn('sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900', __WEB__ && '!bg-[#3D3179] !text-[12px] !font-extrabold !tracking-[.05em] !text-white')}>UOM</TableHead>
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
                    <TableRow className={cn('border-y-2 border-violet-300 bg-violet-50 hover:bg-violet-50', __WEB__ && '!border-y !border-y-[#DAD2F5] !bg-[#F3F0FC] hover:!bg-[#EDE9FB]')}>
                      <TableCell className={cn('text-[11px] font-bold uppercase tracking-wide text-violet-900', __WEB__ && '!text-[11px] !font-extrabold !tracking-[.11em] !text-[#3D3179]')}>
                        {g.name}
                        <span className={cn('ml-1 font-medium normal-case tracking-normal text-violet-500', __WEB__ && '!text-[10.5px] !font-bold !text-[#5B4BA8]')}>· {g.rows.length} product{g.rows.length === 1 ? '' : 's'}</span>
                      </TableCell>
                      <TableCell className={cn('text-right text-[11px] font-bold tabular-nums text-slate-700', __WEB__ && cn(SK_NUM, SK_VRULE, '!font-bold !text-[#33473E]'))}>{g.opening ? formatNum(g.opening) : '—'}</TableCell>
                      <TableCell className={cn('text-right text-[11px] font-bold tabular-nums text-violet-900', __WEB__ && cn(SK_NUM, SK_VRULE, '!font-bold !text-[#0B6B45]'))}>{formatNum(g.deposited)}</TableCell>
                      <TableCell className={cn('text-right text-[11px] font-bold tabular-nums text-violet-900', __WEB__ && cn(SK_NUM, SK_VRULE, '!font-bold !text-[#8C2F26]'))}>{formatNum(g.invoiced)}</TableCell>
                      <TableCell className={cn('text-right text-[11px] font-bold tabular-nums text-violet-900', __WEB__ && cn(SK_NUM, SK_VRULE, '!bg-[#E9E4FA] !font-bold !text-[#3D3179]'))}>{formatNum(g.balance)}</TableCell>
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
                          <TableRow className={cn('cursor-pointer border-b', isOpen && 'bg-slate-100', __WEB__ && cn('!border-b-[#D6CEF5] !bg-transparent', isOpen && '!bg-transparent'))} onClick={() => toggle(k)}>
                            <TableCell className={cn('font-medium', __WEB__ && cn('!text-[12.5px] !font-bold !text-[#0A1F17]', isOpen && '!bg-[#F8F6FE] !shadow-[inset_3px_0_0_#5B4BA8]'))}>
                              <span className="inline-flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground', __WEB__ && '!text-[#5B4BA8]')} /> : <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground', __WEB__ && '!text-[#8FA79B]')} />}
                                {r.product_code || r.product_name}
                              </span>
                            </TableCell>
                            <TableCell className={cn('text-right tabular-nums text-slate-600', __WEB__ && cn(SK_NUM, SK_VRULE, SK_VOPEN))}>
                              {(() => {
                                const o = openingFor(r)
                                return o ? formatNum(o) : '—'
                              })()}
                            </TableCell>
                            <TableCell className={cn('text-right tabular-nums text-emerald-700', __WEB__ && cn(SK_NUM, SK_VRULE, SK_VIN))}>{formatNum(r.deposited)}</TableCell>
                            <TableCell className={cn('text-right tabular-nums text-rose-700', __WEB__ && cn(SK_NUM, SK_VRULE, SK_VOUT))}>{Number(r.invoiced) ? formatNum(r.invoiced) : '—'}</TableCell>
                            <TableCell className={cn('text-right font-bold tabular-nums', Number(r.balance) < -1e-9 ? 'text-red-600' : 'text-violet-900', __WEB__ && cn('doc-ref !text-[13px] !font-bold', SK_VRULE, SK_VCLOSE, Number(r.balance) < -1e-9 ? '!text-[#B3261E]' : '!text-[#3D3179]'))}>{formatNum(r.balance)}</TableCell>
                            <TableCell className={cn('text-muted-foreground', __WEB__ && cn(SK_VRULE, '!text-[11.5px] !font-semibold !text-[#5A6B62]'))}>
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
                <TableRow className={cn('border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100', __WEB__ && '!border-0 !bg-[#3D3179] hover:!bg-[#3D3179]')}>
                  <TableCell className={cn('text-[11px] font-bold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.09em] !text-white')}>Grand total</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#C7BCF0]'))}>{formatNum(totOpening)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#9FE3BF]'))}>{formatNum(tot.deposited)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, '!font-bold !text-[#F0AFAA]'))}>{formatNum(tot.invoiced)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums text-amber-900', __WEB__ && cn(SK_NUM, '!bg-white/[.07] !text-[14px] !font-bold !text-white'))}>{formatNum(tot.balance)}</TableCell>
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
      {/* The one entry form on this page. It takes the strip's control
          sizing so a Select here is the same object as a Select on a filter
          bar — the handoff draws its form fields taller than its filters, at
          42px, because typing into something is a heavier act than narrowing
          a list. */}
      <div className={cn('rounded-xl border bg-card p-5 shadow-sm', __WEB__ && cn('!rounded-[4px] !border-[#D6E2D6] !shadow-none', SK_FORM))}>
        <h3 className={cn('mb-1 font-medium', __WEB__ && '!text-[14px] !font-extrabold !tracking-[-0.01em] !text-[#0A1F17]')}>Transfer stock to another company</h3>
        <p className={cn('mb-4 text-xs text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !leading-[1.55] !text-[#5A6B62]')}>
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
            <Button className={cn('w-full', __WEB__ && cn(SK_BTN_GO, '!h-[42px] !w-full'))} onClick={submit} disabled={saving}>
              <ArrowRightLeft className="h-4 w-4" /> {saving ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <div className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !shadow-none')}>
        <Table>
          <TableHeader>
            <TableRow className={cn(__WEB__ && SK_HEAD)}>
              <TableHead className={cn(__WEB__ && '!text-white')}>Date</TableHead>
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
              <TableRow><TableCell colSpan={7} className={cn('py-10 text-center text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#8FA79B]')}>No transfers yet.</TableCell></TableRow>
            ) : (
              transfers.map((t) => (
                <TableRow key={t.id as number} className={cn(__WEB__ && '!border-b-[#DCE7DB]')}>
                  <TableCell className={cn(__WEB__ && cn(SK_NUM, '!font-semibold !text-[#33473E]'))}>{formatDate(t.transfer_date)}</TableCell>
                  <TableCell>
                    {/* Direction is the one thing a transfer row is really
                        saying, so it takes the in/out colours the rest of the
                        page uses for the same idea rather than a grey pill. */}
                    <Badge
                      variant={t.direction === 'out' ? 'secondary' : 'default'}
                      className={cn(
                        __WEB__ &&
                          cn(
                            '!rounded-[2px] !px-[7px] !py-[2px] !text-[9.5px] !font-extrabold !uppercase !tracking-[.09em]',
                            t.direction === 'out'
                              ? '!bg-[#FDF3F2] !text-[#8C2F26]'
                              : '!bg-[#F1FAF4] !text-[#0B6B45]'
                          )
                      )}
                    >
                      {t.direction === 'out' ? 'Out' : 'In'}
                    </Badge>
                  </TableCell>
                  <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{t.product_code || t.product_name}</TableCell>
                  <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>{t.from_company_name} → {t.to_company_name}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', __WEB__ && cn(SK_NUM, SK_BRULE, SK_BCLOSE, '!font-bold !text-[#0A1F17]'))}>{formatNum(t.qty)} {t.uom}</TableCell>
                  <TableCell className={cn('max-w-[200px] truncate text-muted-foreground', __WEB__ && cn(SK_BRULE, '!text-[11.5px] !font-medium !text-[#5A6B62]'))}>{t.note || '—'}</TableCell>
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
  const isMobile = useIsMobile()
  const [stockGroup, setStockGroup] = useState<'book' | 'actual'>(() =>
    readStockView('group', ['book', 'actual'] as const, 'book')
  )
  // Explicitly a string: Tabs' onValueChange hands back a plain string, and
  // letting the restore narrow this to a union makes setTab unassignable to it.
  const [tab, setTab] = useState<string>(() =>
    readStockView(
      'tab',
      ['raw', 'intermediate', 'finished', 'sku', 'mnc', 'transfers', 'dayclose'] as const,
      'raw'
    )
  )
  const [bookView, setBookView] = useState<'register' | 'opening'>(() =>
    readStockView('bookView', ['register', 'opening'] as const, 'register')
  )
  // Which opening sheet: the tanks, or the packed shelf. The packed one used
  // to hide behind a picker on the Packed SKU strip, which put "where the
  // packed register starts" inside the packed register.
  const [openingTab, setOpeningTab] = useState<'products' | 'sku'>(() =>
    readStockView('openingTab', ['products', 'sku'] as const, 'products')
  )

  // Written as one object so the four can never be restored out of step with
  // each other — a saved tab of 'sku' under a saved group of 'book' would show
  // a register with no rows in it.
  useEffect(() => {
    writeStockView({ group: stockGroup, tab, bookView, openingTab })
  }, [stockGroup, tab, bookView, openingTab])
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
  const [breakdown, setBreakdown] = useState<Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[]; produced: Row[]; consumed: Row[] }>>({})
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
  const [factoryName, setFactoryName] = useState('')
  const [activeCid, setActiveCid] = useState(0)
  const [cids, setCids] = useState<number[]>([])
  // Per-company rows under each product when more than one company is in view,
  // so the register (and its Excel) says whose stock is whose.
  const [companySplit, setCompanySplit] = useState<Record<number, Row[]>>({})

  const load = useCallback(async () => {
    const sel = cids.length ? cids : undefined
    const [s, b, cs, active, fac] = await Promise.all([
      window.api.stock.list(range.from || range.to ? range : undefined, sel),
      window.api.stock.breakdown(sel, range.from || range.to ? range : undefined),
      window.api.company.list(),
      window.api.company.getActive(),
      window.api.factory.active().catch(() => null)
    ])
    setFactoryName(String(fac?.name || ''))
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
    <FactoryPicker
      companies={companies}
      value={cids}
      onChange={setCids}
      factoryName={factoryName}
    />
  )
  // Book Stock's three stages, moved off their own tab strip and into the
  // filter row so the register starts higher up the screen.
  const stagePicker = __WEB__ ? (
    <div className={cn('inline-flex shrink-0', SK_SEG)}>
      {(['raw', 'intermediate', 'finished'] as const).map((k) => {
        const on = tab === k
        return (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn('flex items-center gap-[7px]', SK_SEG_ITEM, on ? SK_SEG_ON : SK_SEG_OFF)}
          >
            {CAT_LABEL[k]}
            <span className={cn('doc-ref text-[10.5px] font-bold', on ? 'text-[#C7F03F]' : 'text-[#8FA79B]')}>
              {byCat(k).length}
            </span>
          </button>
        )
      })}
    </div>
  ) : (
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

  // Phone. After every hook, so the order cannot change between renders.
  if (__WEB__ && isMobile) return <StockMobile />

  return (
    <>
      <PageHeader title="Stock" subtitle="Live balance per product, and daily book-vs-actual reconciliation" hint="Book balances update automatically (purchases add raw oil, production consumes inputs and adds outputs, sales reduce finished goods). Use Day close to enter the actual physical count each day and see the difference." />
      <div className="p-5">
        {/* Two families: what the books say, and what was physically counted or
            is held for someone else. Switching family lands on its first tab. */}
        {/* Website: one menu of three, per the handoff. Opening Stock is a peer
            of the other two rather than a mode hidden under Book Stock — it is
            where the register begins, not a way of looking at it. The state
            underneath is unchanged, so every existing view still lands exactly
            where it did. */}
        {__WEB__ ? (
          <div className="mb-3 flex flex-wrap items-end gap-1 border-b border-b-[#D6E2D6]">
            {STOCK_MENUS.map((m) => {
              const on = m.key === (bookView === 'opening' && stockGroup === 'book' ? 'opening' : stockGroup)
              const Icon = m.icon
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => {
                    if (m.key === 'opening') {
                      setStockGroup('book')
                      setBookView('opening')
                      return
                    }
                    setStockGroup(m.key)
                    setBookView('register')
                    setTab(m.key === 'book' ? 'raw' : 'sku')
                  }}
                  className={cn(
                    'flex h-[46px] items-center gap-[9px] rounded-t-[4px] px-4 text-left transition-colors',
                    'border-b-[3px]',
                    on ? 'border-b-[#C7F03F] bg-[#F1F5EF]' : 'border-b-transparent hover:bg-[#F7FAF6]'
                  )}
                >
                  <Icon className={cn('h-[19px] w-[19px] shrink-0', on ? 'text-[#0B3D2E]' : 'text-[#8CA396]')} />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block whitespace-nowrap text-[13.5px] font-extrabold tracking-[-0.01em]',
                        on ? 'text-[#0A1F17]' : 'text-[#5A6B62]'
                      )}
                    >
                      {m.label}
                    </span>
                    <span
                      className={cn(
                        'block whitespace-nowrap text-[10px] font-bold tracking-[.02em]',
                        on ? 'text-[#0B6B45]' : 'text-[#8CA396]'
                      )}
                    >
                      {m.sub}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
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
        )}
        {/* Opening stock is not a stage of the register — it is where the
            register starts — so it is its own view rather than a fourth stage
            inside the stage picker. Kept out of `tab` on purpose: that value is
            raw / intermediate / finished, so a tab trigger for the register
            would go dark the moment anyone picked Intermediate. */}
        {!__WEB__ && stockGroup === 'book' && (
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
        {/* Four figures the register cannot state for itself: what it comes
            to, what came in, what went out, and whether anything closed below
            nil. The last is the one worth the space — a negative balance is a
            bookkeeping hole, and it used to be findable only by reading every
            row of every category. */}
        {__WEB__ && stockGroup === 'book' && bookView !== 'opening' && (() => {
          const inView = rows.filter((r) => r.category === tab)
          const t = (k: string): number => inView.reduce((a, r) => a + (Number(r[k]) || 0), 0)
          const closing = t('stock')
          const inQty = t('received') + t('produced')
          const outQty = t('consumed') + t('sold') + t('packed_out')
          const neg = inView.filter((r) => Number(r.stock) < -1e-9)
          const line: { k: string; v: string; fg?: string }[] = [
            { k: 'Closing', v: `${formatNum(closing)} MT` },
            { k: 'In', v: formatNum(inQty), fg: '#0B6B45' },
            { k: 'Out', v: formatNum(outQty), fg: '#8C2F26' },
            {
              k: 'Negative',
              v: neg.length ? `${neg.length} product${neg.length === 1 ? '' : 's'}` : 'none',
              fg: neg.length ? '#B3261E' : '#0B6B45'
            }
          ]
          return (
            <div className="mb-3">
              <KpiFold line={line}>
              <StockKpi
                label="Closing balance"
                value={formatNum(closing)}
                unit="MT"
                sub={`${inView.length} product${inView.length === 1 ? '' : 's'} in view`}
                accent="#C7F03F"
              />
              <StockKpi
                label="In this period"
                value={formatNum(inQty)}
                unit="MT"
                sub={`${formatNum(t('received'))} received · ${formatNum(t('produced'))} produced`}
                accent="#12855A"
                fg="#0B6B45"
              />
              <StockKpi
                label="Out this period"
                value={formatNum(outQty)}
                unit="MT"
                sub={`${formatNum(t('consumed'))} consumed · ${formatNum(t('packed_out'))} packed · ${formatNum(t('sold'))} dispatched`}
                accent="#B3261E"
                fg="#8C2F26"
              />
              <StockKpi
                label="Negative balances"
                value={String(neg.length)}
                unit={neg.length === 1 ? 'product' : 'products'}
                sub={neg.length ? neg.map((r) => String(r.name)).join(', ') : 'Every product closes at nil or above'}
                accent={neg.length ? '#B3261E' : '#C3D2C6'}
                fg={neg.length ? '#B3261E' : '#0A1F17'}
              />
              </KpiFold>
            </div>
          )
        })()}
        {stockGroup === 'book' && bookView === 'opening' ? (
          __WEB__ ? (
            /* Two sheets, one question: what was standing here the morning the
               books opened. Oil in the tanks, and packs on the shelf. */
            <div className="space-y-3">
              <div className="flex items-end gap-1 border-b border-b-[#D6E2D6]">
                {(
                  [
                    ['products', 'Products', Layers],
                    ['sku', 'Packed SKU', Boxes]
                  ] as const
                ).map(([k, label, Icon]) => {
                  const on = openingTab === k
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setOpeningTab(k)}
                      className={cn(
                        'flex h-[38px] items-center gap-2 border-b-2 px-3.5 text-[13px] font-bold transition-colors',
                        on
                          ? 'border-b-[#3D3179] text-[#0A1F17]'
                          : 'border-b-transparent text-[#5A6B62] hover:text-[#0A1F17]'
                      )}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', on ? 'text-[#5B4BA8]' : 'text-[#8FA79B]')} />
                      {label}
                    </button>
                  )
                })}
              </div>
              {openingTab === 'products' ? (
                <OpeningStock companies={companies} onCompanyChange={onCompanyChange} />
              ) : (
                <SkuOpeningStock onSaved={() => undefined} />
              )}
            </div>
          ) : (
          <OpeningStock companies={companies} onCompanyChange={onCompanyChange} />
          )
        ) : (
        <Tabs value={tab} onValueChange={setTab}>
          {stockGroup !== 'book' && (
            <TabsList className={cn(__WEB__ && SK_SEG)}>
              {(
                [
                  ['sku', 'Packed SKU'],
                  ['mnc', 'MNC / Consignment'],
                  ['transfers', 'Transfers'],
                  ['dayclose', 'Day close (actual vs book)']
                ] as const
              ).map(([k, label]) => (
                <TabsTrigger key={k} value={k} className={cn(__WEB__ && SK_TAB)}>
                  {label}
                </TabsTrigger>
              ))}
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
