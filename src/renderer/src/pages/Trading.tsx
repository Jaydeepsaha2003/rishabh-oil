import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, CalendarClock, Check, CheckCircle2, ChevronDown, Clock, Lock, Zap, ChevronRight, FileSpreadsheet, Inbox, Info, Loader2, Pencil, Plus, Receipt, Repeat, Search, TrendingDown, TrendingUp, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RowActions } from '@/components/ui/row-actions'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { computeMoney } from '@/lib/orderCalc'
import { isTradingParty } from '@/lib/constants'
import { exportTradingDeals } from '@/lib/tradingExcel'
import { useEntryWindow } from '@/lib/useEntryWindow'
import { useIsMobile } from '@/lib/useIsMobile'
import { TradingMobile } from './TradingMobile'
import { tierTds } from '@/lib/tdsSlab'
import { TdsExplainer, type TdsParty } from '@/components/TdsExplainer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// TDS on one invoice, on the party master's slab — the same tiering the main
// process applies on save. Now in lib/tdsSlab, so the explainer that shows the
// working and the form that previews the figure cannot drift apart.

// Each invoice on a side is posted in turn, so every one moves the party's
// year-to-date total along and the next one sits further up the slab. Walking
// the lines in the same order is the only way the preview can agree with what
// gets saved.
//
// `on` is what the withholding is struck on. BOTH sides now use 'taxable':
// the goods alone, because GST is the government's money passing through and
// taking a slice of it withholds tax on tax, while the rupee round-off is a
// presentation artifact with no business moving the figure.
//
// 'total' — taxable + GST + round off — is what the purchase side used to
// run on, and it deducted Rs 1,47,000 where Rs 1,40,000 was due on a
// Rs 14 crore invoice at 0.1%. It is kept only so a historical figure can
// still be reproduced when one needs explaining.
function slabTdsTotal(
  lines: { qty: number; rate: number }[],
  taxableOf: (l: { qty: number; rate: number }) => number,
  gstPct: number,
  roundOff: number,
  pct: number,
  master: { tds_threshold?: unknown; tds_above_only?: unknown } | undefined,
  priorAtStart: number,
  on: 'total' | 'taxable' = 'taxable'
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
//
// On the website it is ruled like the register it feeds: a labelled header,
// one line per invoice with the money right-aligned, and a totals band in the
// side's own colour. It also shows each line's VALUE, which the grid never
// did — you typed a quantity and a rate and had to multiply them in your
// head to know whether the invoice you were entering was the right one.
// GRID is shared by the header, the rows and the foot so the three cannot
// drift apart.
const LINE_GRID_APP = 'grid grid-cols-[1.5rem_1fr_6rem_7.5rem_1.75rem] items-center gap-2'
const LINE_GRID_WEB = '!grid-cols-[2rem_minmax(150px,1fr)_100px_120px_130px_2.5rem] !gap-2.5'
function InvoiceLines({
  title,
  rows,
  uom,
  totalQty,
  tone,
  onChange,
  onAdd,
  onRemove
}: {
  title: string
  rows: Row[]
  uom: string
  totalQty: number
  tone: 'rose' | 'emerald'
  onChange: (i: number, key: string, value: string) => void
  onAdd: () => void
  onRemove: (i: number) => void
}): React.JSX.Element {
  const rose = tone === 'rose'
  const totalValue = rows.reduce((acc, l) => acc + n(l.qty) * n(l.rate), 0)
  return (
    <div
      className={cn(
        'rounded border border-[#e5dfc8] bg-[#fdfcf6]',
        __WEB__ && '!overflow-hidden !rounded-[4px] !bg-white',
        __WEB__ && (rose ? '!border-[#F0D6D4]' : '!border-[#BFE3CB]')
      )}
    >
      {/* Sideways rather than squeezed: a rate box narrow enough to fit a
          phone is too narrow to read a rate in. */}
      <div className={cn(__WEB__ && 'overflow-x-auto')}>
        <div className={cn(__WEB__ && 'min-w-[620px]')}>
          <div
            className={cn(
              LINE_GRID_APP,
              'border-b border-[#e5dfc8] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
              __WEB__ && LINE_GRID_WEB,
              __WEB__ && '!h-[34px] !border-b-[#D6E2D6] !bg-[#EAF0E9] !px-3 !py-0 !text-[9.5px] !font-extrabold !tracking-[.09em] !text-[#33473E]'
            )}
          >
            <span>#</span>
            <span>{title} invoice no.</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Rate (₹)</span>
            {__WEB__ && <span className="text-right">Value</span>}
            <span />
          </div>
          {rows.map((l, i) => {
            // Each line of a deal becomes an invoice of its own, so a number
            // used twice down this grid is two documents with one name.
            // Marked on the later line, the one that would have to change.
            const k = String(l.invoice_no ?? '').trim().toUpperCase()
            const dupOf = k ? rows.findIndex((o) => String(o.invoice_no ?? '').trim().toUpperCase() === k) : -1
            const repeated = dupOf >= 0 && dupOf < i
            const value = n(l.qty) * n(l.rate)
            return (
              <div
                key={i}
                className={cn(
                  LINE_GRID_APP,
                  'border-b border-dotted border-[#e5dfc8] px-2.5 py-1 last:border-0',
                  __WEB__ && LINE_GRID_WEB,
                  __WEB__ && '!border-b-[#EAF0E9] !border-solid !px-3 !py-2 last:!border-b-0',
                  __WEB__ && repeated && '!bg-[#FDF3F2]'
                )}
              >
                <span className={cn('text-[11px] tabular-nums text-muted-foreground', __WEB__ && '!text-[10.5px] !font-bold !text-[#5A6B62]')}>
                  {i + 1}
                </span>
                <Input
                  className={cn(
                    'doc-ref h-8',
                    repeated && 'border-rose-400 focus-visible:ring-rose-300',
                    __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13px] !font-semibold',
                    __WEB__ && repeated && '!border-[#B3261E]'
                  )}
                  placeholder={__WEB__ ? 'Invoice no.' : undefined}
                  title={repeated ? `Same number as line ${dupOf + 1} — each line needs its own` : undefined}
                  value={String(l.invoice_no ?? '')}
                  onChange={(e) => onChange(i, 'invoice_no', e.target.value)}
                />
                <Input
                  className={cn('h-8 text-right', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13px] !font-semibold !tabular-nums')}
                  type="number"
                  placeholder={__WEB__ ? '0' : undefined}
                  value={String(l.qty ?? '')}
                  onChange={(e) => onChange(i, 'qty', e.target.value)}
                />
                <Input
                  className={cn('h-8 text-right', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13px] !font-semibold !tabular-nums')}
                  type="number"
                  placeholder={__WEB__ ? '0.00' : undefined}
                  value={String(l.rate ?? '')}
                  onChange={(e) => onChange(i, 'rate', e.target.value)}
                />
                {/* Not a field — qty times rate, shown so the line can be
                    checked against the invoice in front of you. Greyed until
                    both halves are in, rather than asserting a confident
                    ₹0.00 for a line nobody has finished typing. */}
                {__WEB__ && (
                  <span
                    className={cn(
                      'text-right text-[13px] font-bold tabular-nums',
                      value > 0 ? 'text-[#0A1F17]' : 'text-[#8FA79B]'
                    )}
                  >
                    {formatINR(value)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-6 w-6 text-muted-foreground hover:text-red-600',
                    // Never the only line: a side with no invoice row has
                    // nothing to type into, so the last one stays put.
                    __WEB__ && '!h-9 !w-9 !rounded-[4px] !text-[#8FA79B] hover:!bg-[#FDF3F2] hover:!text-[#B3261E]',
                    __WEB__ && rows.length < 2 && '!pointer-events-none !opacity-30'
                  )}
                  title={rows.length < 2 ? 'A side needs at least one invoice line' : 'Remove this invoice'}
                  onClick={() => onRemove(i)}
                >
                  <Trash2 className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} />
                </Button>
              </div>
            )
          })}
          <div
            className={cn(
              'flex items-center justify-between gap-2 bg-[#f5f2e4] px-2.5 py-1',
              __WEB__ && LINE_GRID_WEB,
              __WEB__ && '!grid !items-center !px-3 !py-2',
              __WEB__ && (rose ? '!bg-[#F7EDEC]' : '!bg-[#EAF6EC]')
            )}
          >
            {/* Blue on the app: one more line on THIS grid, the same colour
                as the column headers above it. On the website it takes the
                side's colour for the same reason. */}
            <Button
              type="button"
              size="sm"
              className={cn(
                'h-7 gap-1 border border-[#1a2c56]/25 bg-[#dce6f5] text-[11px] font-semibold text-[#1a2c56] shadow-sm hover:bg-[#c6d8f2]',
                __WEB__ && '!col-span-2 !h-9 !w-fit !gap-1.5 !rounded-[4px] !border !bg-white !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !shadow-none',
                __WEB__ &&
                  (rose
                    ? '!border-[#E3A79A] !text-[#8C2F26] hover:!bg-[#FDF3F2]'
                    : '!border-[#9CCFAE] !text-[#0B6B45] hover:!bg-[#F4FBF6]')
              )}
              onClick={onAdd}
            >
              <Plus className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} /> Add invoice
            </Button>
            {/* On the website the totals sit under the columns they total.
                Rolled into one sentence on the app, where the grid is
                narrower and there is no Value column to line up with. */}
            {__WEB__ ? (
              <>
                <span className={cn('text-right text-[12.5px] font-bold tabular-nums', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
                  {formatNum(totalQty)}
                </span>
                <span className={cn('text-right text-[10px] font-extrabold uppercase tracking-[.08em]', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
                  {rows.length} invoice{rows.length === 1 ? '' : 's'}
                </span>
                <span className={cn('text-right text-[13.5px] font-bold tabular-nums', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
                  {formatINR(totalValue)}
                </span>
                <span />
              </>
            ) : (
              <span className="text-[11px] font-semibold tabular-nums">
                {rows.length} invoice{rows.length === 1 ? '' : 's'} · {formatNum(totalQty)} {uom}
              </span>
            )}
          </div>
        </div>
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
        <span
          className={cn(
            'inline-flex cursor-help items-center gap-1.5 rounded-full border border-[#1a2c56]/20 bg-[#eef4ff] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[#1a2c56] transition-colors hover:border-[#1a2c56]/45 hover:bg-[#dce6f5]',
            // The pill was carrying the whole split on hover because there
            // was nowhere else for it. The expanded row now lays that split
            // out in full, so the cell can read as a party name like every
            // other row does and the hover stays a shortcut, not the only way
            // to see who bought what.
            __WEB__ &&
              '!gap-1.5 !rounded-none !border-0 !bg-transparent !px-0 !py-0 !text-[13px] !normal-case !tracking-normal !text-[#0A1F17] hover:!bg-transparent hover:!underline'
          )}
        >
          <Users className={cn('h-3 w-3 shrink-0', __WEB__ && '!h-4 !w-4 !text-[#0B6B45]')} />
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

// The deal form's step cards on the website: a tinted title strip over a white
// body, with every control in them at one height. Named rather than repeated
// inline because the three sections have to stay identical.
const SECTION_WEB =
  '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white !p-0 [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:!tracking-[.12em] [&_label]:!text-[#5A6B62] [&_input]:!h-[46px] [&_input]:!rounded-[4px] [&_input]:!text-[13.5px] [&_[data-slot=select-trigger]]:!h-[46px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!text-[13.5px] [&_[data-slot=date-picker]]:!h-[46px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[14px]'
const SECTION_HEAD =
  '!mb-0 !border-b !border-b-[#E4ECE3] !border-dotted-0 !bg-[#F7FAF6] !px-4 !py-3 !text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]'

// A labelled figure in the expanded deal's summary strip.
function Fact({
  label,
  value,
  hint,
  strong,
  warn,
  tone = 'emerald'
}: {
  label: string
  value: string
  hint?: string
  strong?: boolean
  // Which side of the trade the emphasised cell belongs to. The sale side's
  // net is money coming in and reads green; the purchase side's is money
  // going out and has to read red, or the two strips claim the same thing.
  tone?: 'rose' | 'emerald'
  // A figure that comes OFF the total rather than making it up — TDS. Amber,
  // the same as every other withholding on this page.
  warn?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'min-w-0',
        // On the website these are cells in a ruled strip rather than loose
        // text, so each carries its own ground and the hairlines are the
        // gaps between them.
        __WEB__ && '!bg-white !px-3.5 !py-2.5',
        __WEB__ && strong && (tone === 'rose' ? '!bg-[#F7EDEC]' : '!bg-[#EAF6EC]')
      )}
    >
      <div
        className={cn(
          'text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
          __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.1em] !text-[#5A6B62]',
          __WEB__ && strong && (tone === 'rose' ? '!text-[#8C2F26]' : '!text-[#0B6B45]')
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          'truncate text-[13px] font-semibold tabular-nums text-[#1a2c56]',
          __WEB__ && '!mt-1 !text-[13.5px] !font-bold !text-[#0A1F17]',
          __WEB__ && warn && '!text-[#8A5300]',
          __WEB__ && strong && (tone === 'rose' ? '!text-[15px] !text-[#8C2F26]' : '!text-[15px] !text-[#0B6B45]')
        )}
      >
        {value}
      </div>
      {/* Under the value, not beside it. Inline, a long figure and its hint
          together overran the column, and the hint was the half that got cut —
          "Net receivable ₹7,32,66,111.00 (TDS…" told the reader nothing. */}
      {hint && (
        <div className={cn('truncate text-[10.5px] text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11px] !font-semibold !text-[#5A6B62]')}>
          {hint}
        </div>
      )}
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
    <div className={cn('overflow-hidden rounded border border-[#d9d2b8] bg-[#fffdf4] shadow-sm', __WEB__ && '!rounded-[4px] !bg-white !shadow-none', __WEB__ && (tone === 'rose' ? '!border-[#F0D6D4]' : '!border-[#BFE3CB]'))}>
      <div
        className={cn(
          'flex items-baseline justify-between gap-2 border-b px-3 py-1.5',
          tone === 'rose'
            ? 'border-rose-200 bg-rose-50/80 text-rose-900'
            : 'border-emerald-200 bg-emerald-50/80 text-emerald-900',
          __WEB__ && '!px-3 !py-2.5',
          __WEB__ && (tone === 'rose' ? '!border-b-[#F0D6D4] !bg-[#FDF3F2] !text-[#8C2F26]' : '!border-b-[#BFE3CB] !bg-[#F4FBF6] !text-[#0B6B45]')
        )}
      >
        <span className={cn('text-[10px] font-bold uppercase tracking-widest', __WEB__ && '!text-[10.5px] !font-extrabold !tracking-[.14em]')}>
          {heading}
        </span>
        <span className={cn('truncate text-[11px] font-semibold', __WEB__ && '!text-[11.5px] !font-extrabold')}>{party}</span>
      </div>
      <table className="w-full border-collapse text-[12px] [&_td]:border-r [&_td]:border-[#e8e2cc] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#e8e2cc] [&_th:last-child]:border-r-0">
        <thead>
          <tr className={cn('border-b border-[#d9d2b8] bg-[#dce6f5] text-[10px] uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!border-b-[#D6E2D6] !bg-[#EAF0E9] !text-[10px] !tracking-[.09em] !text-[#33473E] [&>th]:!h-8 [&>th]:!py-0')}>
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
              <tr key={i} className={cn('border-b border-[#efe9d5] last:border-0', i % 2 === 1 && 'bg-[#faf7ea]', __WEB__ && '!border-b-[#EAF0E9] !bg-white [&>td]:!h-10 [&>td]:!py-0')}>
                <td className={cn('px-2 py-1 tabular-nums text-muted-foreground', __WEB__ && '!text-[10px] !font-bold !text-[#5A6B62]')}>{i + 1}</td>
                <td className={cn('px-2 py-1 font-medium', __WEB__ && '!text-[12.5px] !font-bold')}>{String(l.invoice_no || '—')}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatNum(l.qty)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(l.rate)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(n(l.qty) * n(l.rate))}</td>
              </tr>
            ))
          )}
        </tbody>
        {lines.length > 0 && (
          <tfoot>
            <tr className={cn('border-t-2 border-[#1a2c56] bg-[#f0ecd9] font-bold text-[#1a2c56]', __WEB__ && '!border-t-0 [&>td]:!h-10 [&>td]:!py-0', __WEB__ && (tone === 'rose' ? '!bg-[#F7EDEC] !text-[#8C2F26]' : '!bg-[#EAF6EC] !text-[#0B6B45]'))}>
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

// What the product chips group a deal under. The code is what the register
// shows and what a trader says out loud; the name is the fallback for a
// product that never got one.
function dealProduct(d: Row): string {
  return String(d.product_code || d.product_name || '').trim()
}

// One column ruler for every invoice line in the drawer — the purchase panel,
// the sale panel and each buyer's card all measure to it, so the figures line
// up down the whole drawer instead of each block ragging to its own content.
//
// A grid rather than a flex row: flex sizes each line to its own text, so an
// invoice for 90 MT and one for 1,000 MT put their rates in different places
// and the column cannot be read downwards. Fixed tracks with the money
// right-aligned is what a register does, and it is what these are.
const INV_COLS =
  'grid grid-cols-[minmax(110px,1.3fr)_100px_140px_minmax(125px,1fr)] items-center gap-x-3 px-3.5'

// The label strip over those columns.
function InvoiceHead(): React.JSX.Element {
  return (
    <div className={cn(INV_COLS, 'h-[30px] bg-[#EAF0E9] text-[9.5px] font-extrabold uppercase tracking-[.09em] text-[#33473E]')}>
      <span>Invoice no.</span>
      <span className="text-right">Qty</span>
      <span className="text-right">Rate</span>
      <span className="text-right">Value</span>
    </div>
  )
}

// One invoice, measured to INV_COLS.
function InvoiceRow({ line, uom }: { line: Row; uom: string }): React.JSX.Element {
  return (
    <div className={cn(INV_COLS, 'border-b border-b-[#EAF0E9] py-2.5')}>
      <span className="truncate text-[13px] font-bold">{String(line.invoice_no || '\u2014')}</span>
      <span className="text-right text-[12.5px] font-semibold tabular-nums">
        {formatNum(line.qty)} <span className="text-[9.5px] font-bold text-[#5A6B62]">{uom}</span>
      </span>
      <span className="text-right text-[12.5px] font-semibold tabular-nums text-[#5A6B62]">{formatINR(line.rate)}</span>
      <span className="text-right text-[13.5px] font-bold tabular-nums">{formatINR(n(line.qty) * n(line.rate))}</span>
    </div>
  )
}

// One side's invoices in the detail drawer.
//
// The register's own expanded row rules five columns because it has the width
// for them; this is 720px against the edge of the screen, so the row number
// goes and the four that carry meaning stay. It scrolls sideways rather than
// wrapping when the drawer is narrower than the ruler — a wrapped invoice
// line stops being a line.
function InvoicePanel({
  heading,
  party,
  lines,
  uom,
  total,
  tone
}: {
  heading: string
  party: string
  lines: Row[]
  uom: string
  total: number
  tone: 'rose' | 'emerald'
}): React.JSX.Element {
  const rose = tone === 'rose'
  const qty = lines.reduce((a, l) => a + n(l.qty), 0)
  return (
    <div className={cn('overflow-hidden rounded-[4px] border bg-white', rose ? 'border-[#F0D6D4]' : 'border-[#BFE3CB]')}>
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2.5 border-b px-3.5 py-2.5',
          rose ? 'border-b-[#F0D6D4] bg-[#FDF3F2]' : 'border-b-[#BFE3CB] bg-[#F4FBF6]'
        )}
      >
        <span
          className={cn(
            'text-[10.5px] font-extrabold uppercase tracking-[.14em]',
            rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
          )}
        >
          {heading}
        </span>
        <span className={cn('min-w-0 truncate text-[11.5px] font-extrabold', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
          {party}
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[500px]">
          {lines.length === 0 ? (
            <div className="px-3.5 py-4 text-center text-[12.5px] font-semibold text-[#5A6B62]">No invoices.</div>
          ) : (
            <>
              <InvoiceHead />
              {lines.map((l, i) => (
                <InvoiceRow key={i} line={l} uom={uom} />
              ))}
            </>
          )}
          {/* The side's totals sit under the columns they total, not off in a
              sentence of their own. */}
          <div className={cn(INV_COLS, 'py-2.5', rose ? 'bg-[#F7EDEC]' : 'bg-[#EAF6EC]')}>
            <span
              className={cn(
                'text-[10.5px] font-extrabold uppercase tracking-[.06em]',
                rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
              )}
            >
              {lines.length} invoice{lines.length === 1 ? '' : 's'}
            </span>
            <span
              className={cn('text-right text-[12.5px] font-bold tabular-nums', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}
            >
              {formatNum(qty)} <span className="text-[9.5px]">{uom}</span>
            </span>
            <span />
            <span
              className={cn('text-right text-[14px] font-bold tabular-nums', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}
            >
              {formatINR(total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// One colour per buyer, reused by the share bar, its legend and the card that
// buyer gets — so a slice of the bar and the card below it are the same thing.
const BUYER_COLORS = ['#0B6B45', '#12855A', '#3EA372']

// How a split deal was divided, before the buyers themselves.
//
// A deal bought in one lot and sold on to several is really one question —
// who took how much — and answering it in a stacked bar means it can be read
// without adding up three cards. The arithmetic is spelled out beside it
// (500 + 315 + 185 = 1,000 MT) because a bar shows proportion, not quantity,
// and the quantities are what get reconciled against the purchase.
function BuyerSplit({ parties, uom }: { parties: Row[]; uom: string }): React.JSX.Element {
  const total = parties.reduce((a, b) => a + n(b.qty), 0)
  const share = (q: unknown): number => (total ? (n(q) / total) * 100 : 0)
  return (
    <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-[.11em] text-[#0A1F17]">
          <Users className="h-4 w-4 text-[#5A6B62]" />
          Sale invoices
        </span>
        <span className="text-[12.5px] font-bold tabular-nums text-[#33473E]">
          {/* The buyer count moved here from the heading. It is a fact about
              the split, not the name of the card — and the card is the sale
              side's invoices whether they went to one buyer or five. */}
          {parties.length} buyers · {formatNum(total)} {uom} in total
        </span>
      </div>

      {/* The bar carries its own percentages. They were only in the legend
          below, which meant reading a slice meant finding its colour in a
          separate line of text — the number belongs on the thing it measures.
          A slice too narrow to hold a label keeps it in the legend. */}
      <div className="px-4 pb-3 pt-3.5">
        <div className="flex h-[22px] gap-0.5 overflow-hidden rounded-[2px]">
          {parties.map((b, i) => {
            const pct = share(b.qty)
            return (
              <div
                key={i}
                className="flex h-full items-center justify-center"
                style={{ width: `${pct}%`, background: BUYER_COLORS[i % BUYER_COLORS.length] }}
                title={`${String(b.customer_name || '—')} — ${formatNum(b.qty)} ${uom}`}
              >
                {pct >= 11 && (
                  <span className="text-[11px] font-extrabold tabular-nums text-white">{Math.round(pct)}%</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* One line per buyer rather than a run-on legend. Three long company
          names separated by nothing but a swatch ran together across the
          wrap, and there was no way to see where one entry ended. Ruled
          rows in the same order as the cards below, so BUYER 2 here and
          BUYER 2 down there are plainly the same party. */}
      <div className="border-t border-t-[#EAF0E9]">
        {parties.map((b, i) => {
          const color = BUYER_COLORS[i % BUYER_COLORS.length]
          return (
            <div
              key={i}
              className="flex items-center gap-2.5 border-b border-b-[#EAF0E9] px-4 py-2 last:border-b-0"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
              <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">
                Buyer {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#33473E]">
                {String(b.customer_name || '—')}
              </span>
              <span className="shrink-0 whitespace-nowrap text-[12.5px] font-bold tabular-nums text-[#33473E]">
                {formatNum(b.qty)} <span className="text-[9.5px] font-bold text-[#5A6B62]">{uom}</span>
              </span>
              <span className="w-[44px] shrink-0 text-right text-[12.5px] font-extrabold tabular-nums" style={{ color }}>
                {Math.round(share(b.qty))}%
              </span>
            </div>
          )
        })}
      </div>

      {/* The arithmetic written out. A bar shows proportion, not quantity,
          and the quantities are what get reconciled against the purchase
          invoices above — so the sum is spelled out to be checked. */}
      <div className="border-t border-t-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[11.5px] font-bold tabular-nums text-[#5A6B62]">
        {parties.map((b) => formatNum(b.qty)).join(' + ')} = {formatNum(total)} {uom}
      </div>
    </div>
  )
}

// One buyer of a split deal, as a card rather than a row in a shared table.
//
// Each buyer is invoiced on its own: its own GST, its own TDS slab, its own
// money still to come in. A merged table hides whose money is outstanding,
// and outstanding money belongs to a name — so the name, the tax and the
// balance stay together, and the card carries the buyer's colour from the
// split bar above it so the two read as one picture.
function BuyerCard({
  party,
  index,
  total,
  uom
}: {
  party: Row
  index: number
  total: number
  uom: string
}): React.JSX.Element {
  const color = BUYER_COLORS[index % BUYER_COLORS.length]
  const rows: Row[] = Array.isArray(party.lines) ? party.lines : []
  const share = total ? Math.round((n(party.qty) / total) * 100) : 0
  const due = n(party.net_receivable)
  const paid = Math.min(due, Math.max(0, n(party.paid)))
  const outstanding = Math.max(0, due - paid)
  const settled = !!party.fully_paid || (due > 0 && outstanding < 0.005)
  return (
    <div
      className="overflow-hidden rounded-[4px] border border-l-4 border-[#BFE3CB] bg-white"
      style={{ borderLeftColor: color }}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-b-[#BFE3CB] bg-[#F4FBF6] px-3.5 py-3">
        <span
          className="shrink-0 rounded-[2px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.09em] leading-none text-white"
          style={{ background: color }}
        >
          Buyer {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold text-[#0B6B45]">
          {String(party.customer_name || '—')}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-[12.5px] font-extrabold tabular-nums text-[#0B6B45]">
            {formatNum(party.qty)} {uom}
          </span>
          {/* The share carries the buyer's own colour so the card ties back
              to its slice of the split bar above without a second legend. */}
          <span
            className="whitespace-nowrap rounded-[2px] px-1.5 py-1 text-[11px] font-extrabold tabular-nums leading-none text-white"
            style={{ background: color }}
          >
            {share}%
          </span>
        </span>
      </div>
      {/* The buyer's invoices on the same ruler as the purchase panel above,
          so the money in a split deal lines up down the whole drawer. No
          repeat of the column labels — the panel above has already named
          them, and three buyers would mean three copies of the same strip. */}
      <div className="overflow-x-auto">
        <div className="min-w-[500px]">
          {rows.length === 0 ? (
            <div className="px-3.5 py-3 text-center text-[12px] font-semibold text-[#5A6B62]">No invoices.</div>
          ) : (
            rows.map((l, i) => <InvoiceRow key={i} line={l} uom={uom} />)
          )}
          <div className={cn(INV_COLS, 'border-b border-b-[#BFE3CB] bg-[#EAF6EC] py-2.5')}>
            <span className="text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">
              {rows.length} invoice{rows.length === 1 ? '' : 's'}
            </span>
            <span className="text-right text-[12.5px] font-bold tabular-nums text-[#0B6B45]">
              {formatNum(party.qty)} <span className="text-[9.5px]">{uom}</span>
            </span>
            <span />
            <span className="text-right text-[14px] font-bold tabular-nums text-[#0B6B45]">
              {formatINR(party.taxable)}
            </span>
          </div>
        </div>
      </div>
      {/* The four money figures on one line so they can be read across, and
          across the three cards. They were three stacked bands — tax, then
          net, then a full-width balance strip — which made a card five
          ruled rows deep and put the one figure anybody chases, the
          outstanding, furthest from the name it belongs to.
          gap-px over a coloured ground draws the hairlines: the cells are
          white, the gaps are the border showing through. */}
      <div className="grid gap-px bg-[#EAF0E9] [grid-template-columns:repeat(auto-fit,minmax(min(50%,150px),1fr))]">
        {[
          { k: 'GST', v: `${formatNum(party.gst_pct)}%`, tone: 'text-[#0A1F17]' },
          { k: 'TDS', v: formatINR(party.tds_amount), tone: 'text-[#8A5300]' },
          { k: 'Net due', v: formatINR(due), tone: 'text-[#0A1F17]' }
        ].map((c) => (
          <div key={c.k} className="min-w-0 bg-white px-3.5 py-2.5">
            <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{c.k}</div>
            <div className={cn('mt-1 whitespace-nowrap text-[12.5px] font-bold tabular-nums', c.tone)}>{c.v}</div>
          </div>
        ))}
        {/* A settled buyer says so with the money that came in rather than a
            zero, which reads as missing data. */}
        <div className={cn('min-w-0 px-3.5 py-2.5', settled ? 'bg-[#F4FBF6]' : 'bg-[#FFFBF2]')}>
          <div
            className={cn(
              'flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-[.1em]',
              settled ? 'text-[#0B6B45]' : 'text-[#8A5300]'
            )}
          >
            {settled ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <Clock className="h-3.5 w-3.5 shrink-0" />}
            {settled ? 'Settled' : 'Outstanding'}
          </div>
          <div
            className={cn(
              'mt-1 whitespace-nowrap text-[13px] font-bold tabular-nums',
              settled ? 'text-[#0B6B45]' : 'text-[#8A5300]'
            )}
          >
            {formatINR(settled ? due : outstanding)}
          </div>
        </div>
      </div>
      {/* How much of this buyer's money is actually in, as the bottom edge of
          the card. A part-paid buyer is neither settled nor untouched, and
          the two figures above cannot show that on their own. */}
      {due > 0 && (
        <div
          className="flex h-[5px] bg-[#EAF0E9]"
          title={`${formatINR(paid)} received of ${formatINR(due)}`}
        >
          <div className="h-full" style={{ width: `${(paid / due) * 100}%`, background: settled ? '#12855A' : color }} />
        </div>
      )}
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
    <div
      className={cn(
        'flex items-center justify-between gap-2 py-1.5 text-sm',
        __WEB__ && '!border-b !border-b-[#EAF0E9] !py-2 !text-[12.5px]'
      )}
    >
      <span className={cn('text-muted-foreground', __WEB__ && '!flex !items-center !gap-1.5 !font-semibold !text-[#5A6B62]')}>
        {label}{' '}
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide',
            // On the website the tag is a chip: whether this figure is the
            // one the app worked out or one somebody typed over it changes
            // how much it should be trusted, and a grey parenthesis said
            // that too quietly to be noticed.
            __WEB__ && '!rounded-[2px] !px-1.5 !py-0.5 !text-[9px] !font-extrabold !tracking-[.08em]',
            __WEB__ && (manual ? '!bg-[#FFEDD0] !text-[#8A5300]' : '!bg-[#EAF0E9] !text-[#5A6B62]')
          )}
        >
          {manual ? '(manual)' : '(auto)'}
        </span>
      </span>
      <Input
        type="number"
        placeholder="0.00"
        title="Rounds the invoice to whole rupees. Clear it to go back to the automatic value."
        className={cn(
          'h-7 w-28 bg-white text-right text-sm tabular-nums',
          manual && 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400',
          __WEB__ && '!h-9 !w-[110px] !rounded-[4px] !border-[#C3D2C6] !text-[13px] !font-bold',
          __WEB__ && manual && '!border-[#F0D9AE] !bg-[#FFFBF2]'
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// One line of a summary card. `foot` promotes it to the card's closing
// band: full-bleed, tinted in the side's colour, and the largest figure in
// the card — because "net payable to the supplier" is the number the whole
// column was adding up to, and as another 14px row among a dozen others it
// read as no more important than the GST four lines above it.
function MoneyRow({
  label,
  value,
  strong,
  muted,
  foot
}: {
  label: string
  value: string
  strong?: boolean
  muted?: boolean
  foot?: 'rose' | 'emerald'
}): React.JSX.Element {
  const rose = foot === 'rose'
  return (
    <div
      className={cn(
        'flex items-center justify-between py-1.5 text-sm',
        __WEB__ && '!items-baseline !gap-3 !border-b !border-b-[#EAF0E9] !py-2 !text-[12.5px]',
        __WEB__ && foot && '!-mx-3.5 !-mb-3.5 !mt-2.5 !border-b-0 !px-3.5 !py-3',
        __WEB__ && foot && (rose ? '!bg-[#F7EDEC]' : '!bg-[#EAF6EC]')
      )}
    >
      <span
        className={cn(
          strong ? 'font-semibold text-foreground' : muted ? 'text-muted-foreground' : 'text-foreground/80',
          __WEB__ && (strong ? '!font-bold !text-[#0A1F17]' : '!font-semibold !text-[#5A6B62]'),
          __WEB__ && foot && '!text-[10px] !font-extrabold !uppercase !tracking-[.1em]',
          __WEB__ && foot && (rose ? '!text-[#8C2F26]' : '!text-[#0B6B45]')
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          strong ? 'font-semibold tabular-nums' : 'tabular-nums',
          __WEB__ && '!whitespace-nowrap !text-[13px] !font-bold',
          __WEB__ && foot && '!text-[15px]',
          __WEB__ && foot && (rose ? '!text-[#8C2F26]' : '!text-[#0B6B45]')
        )}
      >
        {value}
      </span>
    </div>
  )
}

// The asterisk on a required field. Grey among grey label text it was
// decoration; in the alert red used everywhere else on this page it is a
// mark, and the footer's checklist names the same fields.
function Req(): React.JSX.Element {
  return <span className={cn('text-destructive', __WEB__ && '!ml-0.5 !text-[#B3261E]')}>*</span>
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

// One side's tax and what is left owing, as its own card.
//
// Lifted out of the drawer body so the purchase card can sit in the seller
// column and the sale card in the buyer column — under the invoices each
// belongs to, rather than in a row of their own further down where the
// reader has to carry the side across from one block to the next.
function TaxCard({
  rose,
  head,
  party,
  onExplain,
  gstPct,
  gstAmt,
  tdsPct,
  tdsAmt,
  netLabel,
  net
}: {
  rose: boolean
  head: string
  // Only when it says something the card does not: "3 buyers" explains the
  // per-buyer rates below it. A single party's NAME is not that — it is
  // already the heading of the invoice panel directly above, and repeating it
  // here just crowds the strip.
  party: string
  onExplain?: () => void
  gstPct: string
  gstAmt: number
  tdsPct: string
  tdsAmt: number
  netLabel: string
  net: number
}): React.JSX.Element {
  return (
    <div className={cn('overflow-hidden rounded-[4px] border bg-white', rose ? 'border-[#F0D6D4]' : 'border-[#BFE3CB]')}>
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5',
          rose ? 'border-b-[#F0D6D4] bg-[#FDF3F2]' : 'border-b-[#BFE3CB] bg-[#F4FBF6]'
        )}
      >
        <span
          className={cn(
            'text-[10.5px] font-extrabold uppercase tracking-[.14em]',
            rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
          )}
        >
          {head}
        </span>
        {party ? (
          <span className={cn('min-w-0 truncate text-[11px] font-extrabold', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
            {party}
          </span>
        ) : null}
      </div>
      {/* Rate beside the label, money on the right — the rate explains the
          figure, so they belong on the same line rather than stacked as a
          footnote. */}
      {[
        { k: 'GST', pct: gstPct, v: gstAmt, tone: '', explain: false },
        { k: 'TDS', pct: tdsPct, v: tdsAmt, tone: 'text-[#8A5300]', explain: true }
      ].map((r) => (
        <div key={r.k} className="flex items-center gap-2.5 border-b border-b-[#EAF0E9] px-3.5 py-2.5">
          <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{r.k}</span>
          <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-extrabold tabular-nums text-[#33473E]">
            {r.pct}
          </span>
          {/* The one figure on this card nobody can check by eye — the rate
              does not run on the whole invoice once the party's yearly slab
              is in play. */}
          {r.explain && onExplain ? (
            <button
              type="button"
              onClick={onExplain}
              title="How this TDS is worked out — the slab, the year to date, and each invoice against it"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-[#5A6B62] transition-colors hover:bg-[#EAF0E9] hover:text-[#0B3D2E]"
            >
              <Info className="h-4 w-4" />
            </button>
          ) : null}
          <span className={cn('ml-auto whitespace-nowrap text-[13px] font-bold tabular-nums', r.tone)}>
            {formatINR(r.v)}
          </span>
        </div>
      ))}
      <div className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3.5 py-3', rose ? 'bg-[#F7EDEC]' : 'bg-[#EAF6EC]')}>
        <span className={cn('text-[10px] font-extrabold uppercase tracking-[.1em]', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
          {netLabel}
        </span>
        <span
          className={cn(
            'ml-auto whitespace-nowrap text-[15px] font-bold tabular-nums',
            rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
          )}
        >
          {formatINR(net)}
        </span>
      </div>
    </div>
  )
}

// The rule that names a column: a mark, the side, a hairline, and that
// side's total at the far end — so each half of the drawer states what it
// comes to before the invoices under it are read.
//
// The trending arrows are gone from here and from every heading below. Four
// of them in one drawer, on rows that already say PURCHASE and SALE in the
// colour of their side, were decoration standing in for a distinction the
// words and the colour make on their own — and a chart arrow beside a list
// of invoices reads as a change over time, which is not what it meant. The
// short bar left behind is a printer's rule, matching the coloured edge each
// card already carries.
function SideHead({ rose, label, total }: { rose: boolean; label: string; total: number }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 pb-0.5">
      <span className={cn('h-[15px] w-[3px] shrink-0 rounded-full', rose ? 'bg-[#B3261E]' : 'bg-[#12855A]')} />
      <span
        className={cn(
          'text-[11.5px] font-extrabold uppercase tracking-[.16em]',
          rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
        )}
      >
        {label}
      </span>
      <span className={cn('h-px flex-1', rose ? 'bg-[#F0D6D4]' : 'bg-[#BFE3CB]')} />
      <span
        className={cn(
          'whitespace-nowrap text-[12px] font-bold tabular-nums',
          rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
        )}
      >
        {formatINR(total)}
      </span>
    </div>
  )
}

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
  // Which product the register is narrowed to, 'ALL' for none. Website only —
  // the desktop register keeps its single search box.
  const [prodFilter, setProdFilter] = useState('ALL')
  // The deal the detail drawer is open on. Website only: the desktop register
  // opens a deal in place, underneath its own row.
  const [detailDeal, setDetailDeal] = useState<Row | null>(null)
  const isMobile = useIsMobile()
  // Which side's withholding is being explained, if either.
  const [tdsSide, setTdsSide] = useState<'purchase' | 'sale' | null>(null)
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
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
      if (prodFilter !== 'ALL' && dealProduct(d) !== prodFilter) return false
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
  }, [deals, search, globalRange, prodFilter])

  // Chips for whatever this book actually trades, not a fixed list — a
  // company dealing only in CPO gets one chip, and the counts are struck
  // BEFORE the product filter so picking one does not empty the others out
  // from under the cursor. The date range and search do narrow them, because
  // a chip claiming 6 deals that opens 2 is worse than no chip.
  const prodChips = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inRange = globalRangeAppliesTo(globalRange, 'trading')
    const pool = deals.filter((d) => {
      if (inRange) {
        const dd = String(d.deal_date || '').slice(0, 10)
        if (dd < globalRange.from || dd > globalRange.to) return false
      }
      if (!q) return true
      const invoiceNos = [
        ...(Array.isArray(d.purchase_lines) ? d.purchase_lines : []),
        ...(Array.isArray(d.sale_lines) ? d.sale_lines : [])
      ].map((l: Row) => l.invoice_no)
      const buyers = Array.isArray(d.customer_names) ? d.customer_names : [d.customer_name]
      return [d.product_code, d.product_name, d.supplier_name, ...buyers, ...invoiceNos]
        .some((f) => String(f || '').toLowerCase().includes(q))
    })
    const counts = new Map<string, number>()
    pool.forEach((d) => {
      const k = dealProduct(d)
      if (k) counts.set(k, (counts.get(k) || 0) + 1)
    })
    return [
      { label: 'All', value: 'ALL', count: pool.length },
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ label: value, value, count }))
    ]
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

  // Phone. Same fork Sales.tsx and Treasury.tsx make, and in the same place:
  // after every hook, so the order of hooks cannot change between renders.
  //
  // Below the new-deal form on purpose — a deal being entered stays in the
  // form even if the window is narrowed mid-entry, rather than throwing the
  // work away to show a read-only list.
  if (__WEB__ && isMobile && !formPage) return <TradingMobile />

  if (formPage) {
    return (
      <div className="px-4 py-4">
        <div className={cn('rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg', __WEB__ && '!rounded-[4px] !border-0 !bg-transparent !shadow-none')}>
          {/* Pinned to the top of the window, the way the actions are
              pinned to the bottom. This form is several screens long, and
              Back — the only way out of it — used to scroll away with the
              first section, leaving nothing on screen to say which deal was
              even open. */}
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]',
              __WEB__ &&
                '!sticky !top-0 !z-20 !gap-x-3.5 !gap-y-2 !rounded-[4px] !bg-[#0B3D2E] !px-5 !py-3 !text-white !shadow-[0_8px_20px_-12px_rgba(10,31,23,0.55)]'
            )}
          >
            {/* Lime, not a faint white outline. It is the only way off this
                page, and at 35% it read as a disabled control. */}
            <button
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline',
                __WEB__ &&
                  '!h-10 !gap-2 !rounded-[4px] !border-[1.5px] !border-[#C7F03F]/70 !px-3.5 !text-[13px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] !no-underline hover:!bg-[#C7F03F] hover:!text-[#12280B]'
              )}
              onClick={() => { setFormPage(false); setEditingDeal(null) }}
            >
              <ArrowLeft className={cn('h-3.5 w-3.5', __WEB__ && '!h-[19px] !w-[19px]')} /> Back
            </button>
            <div className={cn('h-4 border-l border-[#1a2c56]/30', __WEB__ && '!h-6 !border-l-white/20')} />
            <h2 className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[14px] !font-extrabold !tracking-[.12em]')}>
              {editingDeal ? 'Alter trading deal' : 'New trading deal'}
            </h2>
            {/* Which deal is being altered. Editing opens on a form that looks
                identical to a new one, and the date and product are what tell
                them apart at a glance — bounded, because loose beside the
                heading it read as part of the title. */}
            {__WEB__ && editingDeal && (
              <span className="rounded-[3px] border border-white/20 bg-white/10 px-2.5 py-1.5 text-[12.5px] font-bold tabular-nums text-[#DCEFE4]">
                {formatDate(editingDeal.deal_date)} · {String(editingDeal.product_code || editingDeal.product_name || '')}
              </span>
            )}
            {/* What makes this page different from Purchases and Sales, so it
                keeps its lime bolt — but on the ground rather than in a grey
                pill, which had it reading as a disabled button. */}
            <span className={cn('ml-auto text-[11px] font-medium', __WEB__ && '!flex !items-center !gap-2 !text-[12px] !font-bold !text-[#8FBFA8]')}>
              {__WEB__ && (
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[3px] bg-[#C7F03F]/15">
                  <Zap className="h-4 w-4 text-[#C7F03F]" />
                </span>
              )}
              Raw pass-through — no bargain, no tanker, no stock
            </span>
          </div>

          <div className={cn('grid gap-4 p-4 xl:grid-cols-[1fr_360px]', __WEB__ && '!gap-3.5 !p-0 !pt-3.5')}>
            <div className="space-y-4">
              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground', __WEB__ && SECTION_WEB)}>
                <h3 className={cn('mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && cn(SECTION_HEAD, '!flex !items-center !gap-2.5'))}>
                  {__WEB__ && !editingDeal && <span className="rounded-[2px] bg-[#0B3D2E] px-2 py-1 text-[10.5px] font-extrabold tracking-normal text-[#C7F03F]">1</span>}
                  {/* The two sections below carry an icon for their side of
                      the trade; this one had none, so the first heading on
                      the page was the only one that did not look like the
                      others. The page's own mark — goods swapped straight
                      through — is the right one for the section that says
                      what is being traded. */}
                  {__WEB__ && <Repeat className="h-[18px] w-[18px] text-[#0B3D2E]" />}
                  Deal details
                  {/* What has been chosen so far, in the same chip the other
                      two sections use for their running totals. Worth having
                      here because the product and the date are what every
                      figure below is struck against — the rate is per MT of
                      THIS product, and the date is what decides which rung of
                      the year's TDS slab the invoices land on. */}
                  {__WEB__ && (() => {
                    const prod = products.find((x) => String(x.id) === String(form.product_id || ''))
                    const label = prod ? String(prod.code || prod.name || '') : ''
                    return (
                      <span
                        className={cn(
                          'ml-auto rounded-[3px] border px-2.5 py-1.5 text-[12px] font-bold normal-case tabular-nums tracking-normal',
                          label ? 'border-[#D6E2D6] bg-white text-[#0A1F17]' : 'border-[#DCE7DB] bg-[#F7FAF6] text-[#7C9188]'
                        )}
                      >
                        {label ? `${label} · ${formatDate(form.deal_date)}` : 'No product chosen yet'}
                      </span>
                    )
                  })()}
                </h3>
                {/* UOM holds "MT". It had a full quarter of the row while
                    the product picker — which holds a company's product name
                    — had the same, so one was mostly empty and the other was
                    truncating. Sized to what they carry on the website. */}
                <div className={cn('grid gap-4 md:grid-cols-4', __WEB__ && '!gap-3.5 !p-4 md:!grid-cols-[1.2fr_1.2fr_1fr_110px]')}>
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
                    <Label>Product <Req /></Label>
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
                    <Label>
                      Quantity{' '}
                      <span
                        className={cn(
                          'text-[10px] font-normal normal-case text-muted-foreground',
                          __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-1.5 !py-0.5 !text-[9px] !font-extrabold !uppercase !tracking-[.08em] !text-[#5A6B62]'
                        )}
                      >
                        {__WEB__ ? 'from invoices' : '(from the invoices below)'}
                      </span>
                    </Label>
                    {/* Not a field on the website. It was a disabled input that
                        rendered EMPTY until a purchase line had a quantity in
                        it, so the commonest thing this box ever showed was a
                        grey blank — which reads as something you forgot to
                        fill in, not as a total the form works out for you. A
                        locked readout that always carries a figure says which
                        of the two it is. */}
                    {__WEB__ ? (
                      <div
                        className={cn(
                          'flex h-[46px] items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-[#F1F5EF] px-3',
                          purchaseQty > 0 ? 'text-[#0A1F17]' : 'text-[#8FA79B]'
                        )}
                        title="Added up from the purchase invoices below — it is not typed here"
                      >
                        <Lock className="h-[15px] w-[15px] shrink-0 text-[#8FA79B]" />
                        <span className="text-[14px] font-bold tabular-nums">{formatNum(purchaseQty)}</span>
                        <span className="text-[11px] font-bold text-[#5A6B62]">{form.uom || 'MT'}</span>
                      </div>
                    ) : (
                      <Input
                        disabled
                        className="bg-muted/50 text-muted-foreground"
                        value={purchaseQty > 0 ? `${formatNum(purchaseQty)} ${form.uom || 'MT'}` : ''}
                      />
                    )}
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
                  {/* A date is eight characters and a note is a sentence,
                      and on the row above they were sharing a column ruler
                      built for the pickers — so the date sat in a box three
                      times wider than anything it can hold while the note,
                      the one field here that benefits from every pixel, made
                      do with what was left. Sized to their jobs on the
                      website; display:contents leaves the desktop grid alone. */}
                  <div className={cn('contents', __WEB__ && '!col-span-full !flex !flex-wrap !items-start !gap-3.5')}>
                    <div className={cn('flex flex-col gap-1.5', __WEB__ && '!w-[210px]')}>
                      <Label>Deal date</Label>
                      <DatePicker min={minDate} value={String(form.deal_date || '')} onChange={(v) => setForm((p) => ({ ...p, deal_date: v }))} />
                      {/* The calendar simply refuses to open on a day before
                          the window your login is allowed to post in, with
                          nothing on screen saying why. The limit is a
                          per-user setting, so it is not something a clerk can
                          work out from the form. */}
                      {__WEB__ && !!minDate && (
                        <span className="text-[11px] font-semibold leading-snug text-[#5A6B62]">
                          Your login cannot post before {formatDate(minDate)}
                        </span>
                      )}
                    </div>
                    <div className={cn('flex flex-col gap-1.5 md:col-span-3', __WEB__ && '!min-w-[260px] !flex-1')}>
                      <Label>
                        Note{' '}
                        <span
                          className={cn(
                            'text-[10px] font-normal normal-case text-muted-foreground',
                            __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-1.5 !py-0.5 !text-[9px] !font-extrabold !uppercase !tracking-[.08em] !text-[#5A6B62]'
                          )}
                        >
                          optional
                        </span>
                      </Label>
                      <Input
                        placeholder={__WEB__ ? 'Anything worth recording against this deal' : undefined}
                        value={form.note ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
                      />
                      {/* The note travels with the deal into the register's
                          detail panel, so it is worth a line saying who ends
                          up reading it. */}
                      {__WEB__ && (
                        <span className="text-[11px] font-semibold leading-snug text-[#5A6B62]">
                          Shown on this deal in the register
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground', __WEB__ && cn(SECTION_WEB, '!border-[#F0D6D4]'))}>
                <h3 className={cn('mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && cn(SECTION_HEAD, '!flex !items-center !gap-2.5 !border-b-[#F0D6D4] !bg-[#FDF3F2] !text-[#8C2F26]'))}>
                  {__WEB__ && !editingDeal && <span className="rounded-[2px] bg-[#8C2F26] px-2 py-1 text-[10.5px] font-extrabold tracking-normal text-white">2</span>}
                  {__WEB__ && <TrendingDown className="h-[18px] w-[18px]" />}
                  Purchase (in)
                  {/* What this side adds up to so far, bounded so it reads
                      as a figure rather than as a continuation of the heading
                      — it was inheriting the h3's own capitals, so a count
                      came out as "0 INVOICES · 0 MT". Before anything is
                      entered it says so in words: a row of zeroes in the same
                      weight as a real total looks like a total that came out
                      to nothing. */}
                  {__WEB__ && (() => {
                    const empty = purchaseQty <= 0 && purchaseCalc.taxableValue <= 0
                    return (
                      <span
                        className={cn(
                          'ml-auto rounded-[3px] border px-2.5 py-1.5 text-[12px] font-bold normal-case tabular-nums tracking-normal',
                          empty ? 'border-[#DCE7DB] bg-[#F7FAF6] text-[#7C9188]' : 'border-[#F0D6D4] bg-white text-[#8C2F26]'
                        )}
                      >
                        {empty ? (
                          'Nothing entered yet'
                        ) : (
                          <>
                            {purchaseLines.length} invoice{purchaseLines.length === 1 ? '' : 's'} ·{' '}
                            {formatNum(purchaseQty)} {form.uom || 'MT'}
                            {purchaseCalc.taxableValue > 0 && ` · ${formatINR(purchaseCalc.taxableValue)}`}
                          </>
                        )}
                      </span>
                    )
                  })()}
                </h3>
                <div className={cn('grid gap-4 md:grid-cols-3', __WEB__ && '!gap-3.5 !p-4')}>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label>Supplier <Req /></Label>
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
                    <Label>Purchase invoices <Req /></Label>
                    <InvoiceLines
                      title="Purchase"
                      tone="rose"
                      rows={lines('purchase_lines')}
                      uom={String(form.uom || 'MT')}
                      totalQty={purchaseQty}
                      onChange={(i, k, v) => setLine('purchase_lines', i, k, v)}
                      onAdd={() => addLine('purchase_lines')}
                      onRemove={(i) => removeLine('purchase_lines', i)}
                    />
                  </div>
                  {/* The tax on this side, in a strip of its own.
                      A percentage is two characters and these had a whole
                      grid column each, so "5" sat in a box wide enough for a
                      company name while GST type — the one that actually
                      needs the room — got the same. Boxed and sized to what
                      they hold, and tinted to say they belong to the purchase.
                      display:contents keeps the desktop grid exactly as it
                      was: the three fields go on being direct children of the
                      section's own columns, as if this wrapper were absent. */}
                  <div
                    className={cn(
                      'contents',
                      __WEB__ &&
                        '!col-span-full !flex !flex-wrap !items-end !gap-x-4 !gap-y-3 !rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF7F6] !px-3.5 !py-3'
                    )}
                  >
                    <div className={cn('flex flex-col gap-1.5', __WEB__ && '!w-[130px]')}>
                      <Label>GST % {autoFields.has('purchase_gst_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                      <Input
                        type="number"
                        className={cn(autoFields.has('purchase_gst_pct') ? AUTO_CLASS : '', __WEB__ && '!text-right !tabular-nums')}
                        value={form.purchase_gst_pct ?? ''}
                        onChange={(e) => setField('purchase_gst_pct', e.target.value)}
                      />
                    </div>
                    <div className={cn('flex flex-col gap-1.5', __WEB__ && '!w-[210px]')}>
                      <Label>GST type</Label>
                      <Select value={form.purchase_gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, purchase_gst_type: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                          <SelectItem value="IGST">IGST</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className={cn('flex flex-col gap-1.5', __WEB__ && '!w-[130px]')}>
                      <Label>TDS % {autoFields.has('purchase_tds_pct') && <span className="text-amber-700">(auto)</span>}</Label>
                      <Input
                        type="number"
                        className={cn(autoFields.has('purchase_tds_pct') ? AUTO_CLASS : '', __WEB__ && '!text-right !tabular-nums')}
                        value={form.purchase_tds_pct ?? ''}
                        onChange={(e) => setField('purchase_tds_pct', e.target.value)}
                      />
                    </div>
                  </div>
                  {/* What the rates above actually come to, on the side that
                      pays them — the same strip each buyer carries, so the two
                      halves of a deal can be read the same way. A percentage
                      typed into a box is not a figure anybody can check
                      against a supplier's invoice; the rupees are.
                      Round off is not repeated here: it is edited once, in the
                      Purchase summary beside the total it moves, and a second
                      box bound to the same field would be two controls for one
                      number. */}
                  {__WEB__ && purchaseCalc.taxableValue > 0 && (
                    <div className="col-span-full grid gap-px overflow-hidden rounded-[4px] border border-[#F0D6D4] bg-[#F0D6D4] [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
                      <Fact label="Taxable" value={formatINR(purchaseCalc.taxableValue)} />
                      <Fact label={`GST ${formatNum(form.purchase_gst_pct)}%`} value={formatINR(purchaseCalc.gstAmount)} />
                      <Fact label="Invoice total" value={formatINR(purchaseCalc.roundedTotal)} />
                      <Fact label={`TDS ${formatNum(form.purchase_tds_pct)}%`} value={formatINR(purchaseTds)} warn />
                      <Fact label="Net payable" value={formatINR(purchaseNet)} strong tone="rose" />
                    </div>
                  )}
                </div>
              </section>

              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground', __WEB__ && cn(SECTION_WEB, '!border-[#BFE3CB]'))}>
                <div className={cn('mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-dotted border-[#e5dfc8] pb-1.5', __WEB__ && '!mb-0 !items-center !border-b-[#BFE3CB] !border-solid !bg-[#F4FBF6] !px-4 !py-3')}>
                  <h3 className={cn('text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!flex !items-center !gap-2.5 !text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0B6B45]')}>
                    {__WEB__ && !editingDeal && <span className="rounded-[2px] bg-[#0B6B45] px-2 py-1 text-[10.5px] font-extrabold tracking-normal text-white">3</span>}
                    {__WEB__ && <TrendingUp className="h-[18px] w-[18px]" />}
                    Sale (out)
                  </h3>
                  {/* The purchase side's chip, mirrored. With one buyer
                      there is no split to report, so the space says what the
                      section is FOR instead — which is the one place on this
                      form where a reader learns a deal can go to several. */}
                  <span
                    className={cn(
                      'text-[11px] text-muted-foreground',
                      __WEB__ && '!text-[12px] !font-bold !text-[#5A6B62]',
                      __WEB__ &&
                        parties().length > 1 &&
                        '!rounded-[3px] !border !border-[#BFE3CB] !bg-white !px-2.5 !py-1.5 !tabular-nums !text-[#0B6B45]'
                    )}
                  >
                    {parties().length === 1
                      ? 'One buyer — add another to split this purchase between several'
                      : `${parties().length} buyers · ${formatNum(saleQty)} ${form.uom || 'MT'} · ${saleLines.length} invoice${saleLines.length === 1 ? '' : 's'}`}
                  </span>
                </div>

                {/* One card per buyer. The goods came in on one purchase and go
                    out to whoever takes them, so each buyer gets its own
                    invoices AND its own tax treatment — a buyer in another
                    state is IGST where one in this state is CGST+SGST, and
                    each withholds TDS on its own slab. */}
                <div className={cn('space-y-3', __WEB__ && '!p-4')}>
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
                          repeated ? 'border-rose-400' : 'border-[#d9d2b8]',
                          // The card was on the desktop's cream ground, which
                          // is what put a yellow cast behind every field in
                          // it. White, with the buyer's own colour down the
                          // left edge — the same three colours the detail
                          // drawer gives these buyers, so a deal looks the
                          // same whether it is being entered or read back.
                          __WEB__ && '!rounded-[4px] !border-l-4 !bg-white !shadow-none',
                          __WEB__ && (repeated ? '!border-[#F0D6D4]' : '!border-[#BFE3CB]')
                        )}
                        style={
                          __WEB__
                            ? { borderLeftColor: repeated ? '#B3261E' : BUYER_COLORS[pi % BUYER_COLORS.length] }
                            : undefined
                        }
                      >
                        {/* The picker IS the heading.
                            ---------------------------------------------------
                            This strip used to print the buyer's name and then
                            a full-width field below offered the same name
                            again — one row of the card spent repeating the row
                            above it, on a card that is repeated per buyer. The
                            field lives here now, and the three tax numbers sit
                            on one line with their labels beside them rather
                            than stacked over them. Three buyers is three of
                            these, so every row saved is saved three times. */}
                        <div
                          className={cn(
                            'flex flex-wrap items-center gap-2 rounded-t border-b px-2.5 py-2',
                            repeated ? 'border-rose-300 bg-rose-50/70' : 'border-emerald-200 bg-emerald-50/80',
                            __WEB__ && '!gap-2.5 !px-3 !py-2.5',
                            __WEB__ && (repeated ? '!border-b-[#F0D6D4] !bg-[#FDF3F2]' : '!border-b-[#BFE3CB] !bg-[#F4FBF6]')
                          )}
                        >
                          <span
                            className={cn('shrink-0 rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white', __WEB__ && '!rounded-[2px] !px-2.5 !py-1.5 !text-[10.5px] !font-extrabold !tracking-[.09em]')}
                            style={
                              __WEB__
                                ? { background: repeated ? '#B3261E' : BUYER_COLORS[pi % BUYER_COLORS.length] }
                                : undefined
                            }
                          >
                            Buyer {pi + 1}
                          </span>
                          <Select
                            value={String(sp?.customer_id || '')}
                            onValueChange={(v) => chooseCustomer(pi, v)}
                          >
                            <SelectTrigger
                              className={cn(
                                'h-8 w-[17rem] border-emerald-300 bg-white text-[12px] font-semibold text-emerald-950',
                                repeated && 'border-rose-400 focus-visible:ring-rose-300',
                                __WEB__ && '!h-[42px] !w-auto !min-w-[200px] !flex-1 !rounded-[4px] !border-[#C3D2C6] !text-[13px] !font-extrabold !text-[#0A1F17]'
                              )}
                            >
                              {/* Falls back to the name from the FULL customer
                                  list: a deal saved against a party since taken
                                  off Trading is not in the options below, and
                                  the field would otherwise read as empty. */}
                              <SelectValue placeholder="Select customer">{name}</SelectValue>
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
                          {/* This buyer's running total, once. It was
                              printed twice on the same line — a second copy
                              beside the picker and this one by the delete
                              button — reading as two figures that happened to
                              agree. The one by the button is the keeper: it is
                              right-aligned, so with three buyers the totals
                              stack into a column. */}
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {c && c.invoiceCount > 0 && (
                              <span
                                className={cn(
                                  'text-[11px] font-medium tabular-nums text-emerald-800',
                                  // Bounded on the website so it reads as this
                                  // buyer's total rather than as a caption
                                  // trailing off the picker beside it.
                                  __WEB__ &&
                                    '!rounded-[3px] !border !border-[#BFE3CB] !bg-white !px-2.5 !py-1.5 !text-[12px] !font-bold !text-[#0B6B45]'
                                )}
                              >
                                {c.invoiceCount} invoice{c.invoiceCount === 1 ? '' : 's'} · {formatNum(c.qty)}{' '}
                                {form.uom || 'MT'} · {formatINR(c.amount)}
                                {/* What share of the purchase this buyer is
                                    taking. Splitting a lot between three
                                    parties is the whole job of this section,
                                    and doing it meant dividing in your head
                                    against a quantity two cards away. Only
                                    where there is a split to describe. */}
                                {__WEB__ && parties().length > 1 && purchaseQty > 0 && (
                                  <span
                                    className="ml-2 rounded-[2px] px-1.5 py-0.5 text-[11px] font-extrabold text-white"
                                    style={{ background: BUYER_COLORS[pi % BUYER_COLORS.length] }}
                                    title={`${formatNum(c.qty)} of the ${formatNum(purchaseQty)} ${form.uom || 'MT'} bought`}
                                  >
                                    {Math.round((c.qty / purchaseQty) * 100)}%
                                  </span>
                                )}
                              </span>
                            )}
                            {parties().length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  'h-7 w-7 text-muted-foreground hover:text-red-600',
                                  __WEB__ && '!h-9 !w-9 !rounded-[4px] !text-[#8FA79B] hover:!bg-[#FDF3F2] hover:!text-[#B3261E]'
                                )}
                                title="Remove this buyer and all of its invoices"
                                onClick={() => removeParty(pi)}
                              >
                                <Trash2 className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} />
                              </Button>
                            )}
                          </span>
                        </div>
                        {repeated && (
                          <p
                            className={cn(
                              'border-b border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700',
                              __WEB__ &&
                                '!flex !items-start !gap-2 !border-b-[#F0D6D4] !bg-[#FDF3F2] !px-3 !py-2.5 !text-[11.5px] !font-semibold !leading-relaxed !text-[#8C2F26]'
                            )}
                          >
                            {__WEB__ && <AlertTriangle className="h-4 w-4 shrink-0 translate-y-px text-[#B3261E]" />}
                            Already listed as buyer {dupOf + 1} — put all of that buyer&rsquo;s invoices under the
                            one card, or the party&rsquo;s TDS slab is split in two.
                          </p>
                        )}

                        <div className="space-y-2 p-2.5">
                          <InvoiceLines
                            title="Sale"
                            tone="emerald"
                            rows={Array.isArray(sp?.lines) ? (sp.lines as Row[]) : []}
                            uom={String(form.uom || 'MT')}
                            totalQty={c?.qty ?? 0}
                            onChange={(i, k, v) => setPartyLine(pi, i, k, v)}
                            onAdd={() => addPartyLine(pi)}
                            onRemove={(i) => removePartyLine(pi, i)}
                          />
                          {/* The same strip as the purchase side carries,
                              in this side's colour. It used to be inline
                              labels beside 4.5rem boxes while the supplier's
                              were stacked labels over full-width ones — the
                              same three fields, entered twice on one screen,
                              looking like two different things. */}
                          <div
                            className={cn(
                              'flex flex-wrap items-center gap-x-4 gap-y-2',
                              __WEB__ &&
                                '!items-end !gap-x-4 !gap-y-3 !rounded-[4px] !border !border-[#BFE3CB] !bg-[#F6FBF8] !px-3.5 !py-3'
                            )}
                          >
                            <div className={cn('flex items-center gap-1.5', __WEB__ && '!w-[130px] !flex-col !items-stretch !gap-1.5')}>
                              <Label className="whitespace-nowrap">
                                GST %{' '}
                                {autoFields.has(partyKey(pi, 'gst_pct')) && (
                                  <span className="text-amber-700">(auto)</span>
                                )}
                              </Label>
                              <Input
                                type="number"
                                className={cn(
                                  'h-8 w-[4.5rem] text-right tabular-nums',
                                  autoFields.has(partyKey(pi, 'gst_pct')) && AUTO_CLASS,
                                  __WEB__ && '!w-full'
                                )}
                                value={sp?.gst_pct ?? ''}
                                onChange={(e) => setPartyField(pi, 'gst_pct', e.target.value)}
                              />
                            </div>
                            <div className={cn('flex items-center gap-1.5', __WEB__ && '!w-[210px] !flex-col !items-stretch !gap-1.5')}>
                              <Label className="whitespace-nowrap">GST type</Label>
                              <Select
                                value={sp?.gst_type || 'CGST_SGST'}
                                onValueChange={(v) => patchParty(pi, { gst_type: v })}
                              >
                                <SelectTrigger className={cn('h-8 w-[9.5rem] text-[12px]', __WEB__ && '!w-full')}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                                  <SelectItem value="IGST">IGST</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className={cn('flex items-center gap-1.5', __WEB__ && '!w-[130px] !flex-col !items-stretch !gap-1.5')}>
                              <Label className="whitespace-nowrap">
                                TDS %{' '}
                                {autoFields.has(partyKey(pi, 'tds_pct')) && (
                                  <span className="text-amber-700">(auto)</span>
                                )}
                              </Label>
                              <Input
                                type="number"
                                className={cn(
                                  'h-8 w-[4.5rem] text-right tabular-nums',
                                  autoFields.has(partyKey(pi, 'tds_pct')) && AUTO_CLASS,
                                  __WEB__ && '!w-full'
                                )}
                                value={sp?.tds_pct ?? ''}
                                onChange={(e) => setPartyField(pi, 'tds_pct', e.target.value)}
                              />
                            </div>
                          </div>
                        </div>

                        {/* This buyer's own invoice, totalled where it is
                            entered — so the figure is checked against the
                            document in hand, not against a deal-wide total
                            that belongs to nobody. */}
                        {/* Ruled cells on the sale side's own colours. It was
                            carrying the desktop's cream ledger ground, which
                            on a white-and-green card read as a stray yellow
                            band, and the figures sat on it as loose text with
                            the round-off box floating between them. Net
                            receivable takes the green cell: it is what this
                            buyer will actually pay, and it was the same size
                            as the GST four cells to its left. */}
                        {!!c && c.invoiceCount > 0 && (
                          <div
                            className={cn(
                              'grid gap-x-4 gap-y-1.5 rounded-b border-t border-[#e5dfc8] bg-[#f7f2e2] px-2.5 py-1.5 sm:grid-cols-3 lg:grid-cols-5',
                              __WEB__ &&
                                '!gap-px !overflow-hidden !rounded-[4px] !border !border-[#BFE3CB] !bg-[#DCE7DB] !p-0 sm:!grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] lg:!grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))]'
                            )}
                          >
                            <Fact label="Taxable" value={formatINR(c.amount)} />
                            <Fact label={`GST ${formatNum(sp?.gst_pct)}%`} value={formatINR(c.gstAmount)} />
                            <div className={cn('min-w-0', __WEB__ && '!bg-white !px-3.5 !py-2.5')}>
                              <div
                                className={cn(
                                  'text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                                  __WEB__ && '!flex !items-center !gap-1.5 !text-[9.5px] !font-extrabold !tracking-[.1em] !text-[#5A6B62]'
                                )}
                              >
                                Round off{' '}
                                <span
                                  className={cn(
                                    __WEB__ && '!rounded-[2px] !px-1.5 !py-0.5 !text-[9px] !font-extrabold !tracking-[.08em]',
                                    __WEB__ &&
                                      (sp?.round_off_manual ? '!bg-[#FFEDD0] !text-[#8A5300]' : '!bg-[#EAF0E9] !text-[#5A6B62]')
                                  )}
                                >
                                  {sp?.round_off_manual ? '(manual)' : '(auto)'}
                                </span>
                              </div>
                              <Input
                                type="number"
                                placeholder="0.00"
                                title="Rounds this buyer's invoice to whole rupees. Clear it to go back to the automatic value."
                                className={cn(
                                  'h-6 w-20 bg-white px-1.5 text-right text-[12px] tabular-nums',
                                  sp?.round_off_manual && 'border-amber-300 bg-amber-50 focus-visible:ring-amber-400',
                                  __WEB__ && '!mt-1 !h-8 !w-full !rounded-[4px] !border-[#C3D2C6] !px-2 !text-[13px] !font-bold',
                                  __WEB__ && sp?.round_off_manual && '!border-[#F0D9AE] !bg-[#FFFBF2]'
                                )}
                                value={String(sp?.round_off ?? '')}
                                onChange={(e) =>
                                  patchParty(pi, { round_off: e.target.value, round_off_manual: e.target.value !== '' })
                                }
                              />
                            </div>
                            <Fact label="Invoice total" value={formatINR(c.total)} />
                            {/* TDS on its own, in the order the money actually
                                moves: invoice total, less the withholding,
                                leaves the net. It was a grey sub-line under
                                Net receivable, which put the deduction after
                                the figure it had already been taken out of. */}
                            <Fact label="TDS" value={formatINR(c.tdsAmount)} warn />
                            <Fact label="Net receivable" value={formatINR(c.netReceivable)} strong />
                            {n(sp?.tds_pct) > 0 && (() => {
                              const b = tdsBasis(c.amount, c.master, n(salePriors[String(sp?.customer_id || '')]))
                              return (
                                <p
                                  className={cn(
                                    'sm:col-span-3 lg:col-span-5 text-[11px] leading-snug',
                                    b.hasSlab && !b.exempt ? 'text-amber-800' : 'text-muted-foreground',
                                    // Its own row across the strip, on the
                                    // warning ground it earns: this is the
                                    // sentence that explains why two buyers at
                                    // one rate owe different TDS.
                                    __WEB__ &&
                                      '!col-span-full !m-0 !bg-[#FFFBF2] !px-3.5 !py-2.5 !text-[11.5px] !font-semibold !leading-relaxed !text-[#8A5300]'
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
                  {/* Green to match the buyer cards it creates, and heavier
                      than Add invoice: this one adds a whole party — its own
                      invoices, its own GST and its own TDS slab — so it
                      should not look like one more row. */}
                  {/* On the website it is a slot rather than a button: a
                      dashed outline the full width of the sale side, which
                      reads as the place the next buyer's card will appear.
                      Solid green, it was the second-heaviest control on the
                      screen and sat a few pixels above BOOK DEAL competing
                      with it — and this adds a card to fill in, it does not
                      finish anything.
                      Forest and lime rather than green: this sits ON the
                      sale side's green ground, and a green slot on a green
                      card had nothing to stand against. Filling with forest
                      on hover makes the whole strip answer the pointer,
                      which a border colour change alone never did. */}
                  <Button
                    type="button"
                    size="sm"
                    className={cn(
                      'h-9 gap-1.5 bg-emerald-600 px-4 text-[12px] font-bold text-white shadow-md hover:bg-emerald-700',
                      __WEB__ &&
                        '!h-[48px] !w-full !gap-2.5 !rounded-[4px] !border !border-dashed !border-[#A9BFB2] !bg-white !text-[12.5px] !font-extrabold !uppercase !tracking-[.06em] !text-[#0B3D2E] !shadow-none hover:!border-solid hover:!border-[#0B3D2E] hover:!bg-[#0B3D2E] hover:!text-[#C7F03F]'
                    )}
                    onClick={addParty}
                  >
                    {__WEB__ ? (
                      <span className="flex h-[24px] w-[24px] items-center justify-center rounded-[3px] bg-[#C7F03F] text-[#12280B]">
                        <Plus className="h-4 w-4" />
                      </span>
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}{' '}
                    Add another buyer
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

              {/* A save that failed is the one message on this page that
                  must not be missed, and as bare red body text above the
                  buttons it looked like a caption. */}
              {error && (
                <p
                  className={cn(
                    'text-sm text-destructive',
                    __WEB__ &&
                      '!flex !items-center !gap-2 !rounded-[4px] !border !border-[#F0D6D4] !border-l-[3px] !border-l-[#B3261E] !bg-[#FDF3F2] !px-3.5 !py-3 !text-[12.5px] !font-bold !text-[#8C2F26]'
                  )}
                >
                  {__WEB__ && <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-[#B3261E]" />}
                  {error}
                </p>
              )}
              {/* Every row becomes a real invoice, posted one after another so
                  each lands on the right rung of the TDS slab — with a dozen
                  rows that genuinely takes a moment, so say so rather than
                  looking frozen. */}
              {/* Pinned to the bottom of the window on the website. This
                  form runs well past a screen, and both the actions AND the
                  list of what is still missing were parked at the end of it —
                  so the checklist was only readable once there was nothing
                  left to check, and saving meant scrolling past everything
                  you had just typed. */}
              <div
                className={cn(
                  'flex flex-wrap items-center justify-end gap-3',
                  __WEB__ &&
                    '!sticky !bottom-0 !z-10 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-4 !py-3.5 !shadow-[0_-6px_18px_-8px_rgba(10,31,23,0.28)]'
                )}
              >
                {__WEB__ && !saving && (() => {
                  const missing = [
                    form.product_id ? '' : 'Product',
                    form.supplier_id ? '' : 'Supplier',
                    purchaseLines.length ? '' : 'Purchase invoice',
                    saleLines.length ? '' : 'Sale invoice'
                  ].filter(Boolean)
                  return missing.length ? (
                    /* One chip per missing thing rather than a comma list.
                       Four items run together as a sentence read as prose to
                       be skimmed; as chips they can be counted, and each one
                       disappears as it is filled in. The icon was a falling
                       trend arrow, which on this page means a deal that lost
                       money. */
                    <span className="mr-auto flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[.08em] text-[#8A5300]">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-[#C2700A]" />
                        Still needed
                      </span>
                      {missing.map((m) => (
                        <span
                          key={m}
                          className="rounded-[3px] border border-[#F0D9AE] bg-[#FFFBF2] px-2 py-1 text-[11.5px] font-bold text-[#8A5300]"
                        >
                          {m}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mr-auto flex items-center gap-2 rounded-[3px] border border-[#BFE3CB] bg-[#F4FBF6] px-2.5 py-1.5 text-[12px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-[#12855A]" />
                      Ready to {editingDeal ? 'save' : 'create'}
                    </span>
                  )
                })()}
                {saving && (
                  <span className="text-[12px] text-muted-foreground">
                    Posting {purchaseLines.length + saleLines.length} invoice
                    {purchaseLines.length + saleLines.length === 1 ? '' : 's'} — please wait, do not close this window.
                  </span>
                )}
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => { setFormPage(false); setEditingDeal(null) }}
                  className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
                >
                  Cancel
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void saveDeal()}
                  className={cn('h-11 min-w-[13rem] gap-2 bg-emerald-600 px-6 text-[15px] font-bold shadow-md hover:bg-emerald-700 disabled:opacity-90', __WEB__ && '!h-12 !min-w-0 !rounded-[4px] !bg-[#0B3D2E] !px-7 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] !shadow-none hover:!bg-[#0F4A38]')}
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {editingDeal ? 'Saving changes…' : 'Booking deal…'}
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      {/* The invoice count says how many documents this
                          is about to post, which is worth knowing — but not
                          before there are any: "Book deal (0 invoices)" reads
                          as a button that will do nothing. */}
                      {editingDeal
                        ? 'Save changes'
                        : purchaseLines.length + saleLines.length > 0
                          ? `Book deal · ${purchaseLines.length + saleLines.length} invoice${purchaseLines.length + saleLines.length === 1 ? '' : 's'}`
                          : 'Book deal'}
                    </>
                  )}
                </Button>
              </div>
            </div>

            <aside className={cn('h-fit space-y-4 xl:sticky xl:top-6', __WEB__ && '!space-y-3')}>
              {/* The two questions the form is actually filled in to answer,
                  put above the tax breakdowns rather than under them: what does
                  this deal make, and is all of it sold on. Both read off the
                  same margin / qty figures the summaries below use. */}
              {__WEB__ && (
                <>
                  <div
                    className={cn(
                      'rounded-[4px] border border-l-4 px-4 py-3.5',
                      margin < 0 ? 'border-[#F0D6D4] border-l-[#B3261E] bg-[#FDF3F2]' : 'border-[#BFE3CB] border-l-[#12855A] bg-[#F4FBF6]'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {margin < 0 ? <TrendingDown className="h-[19px] w-[19px] text-[#B3261E]" /> : <TrendingUp className="h-[19px] w-[19px] text-[#12855A]" />}
                      <span className={cn('text-[9.5px] font-extrabold uppercase tracking-[.13em]', margin < 0 ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
                        {margin < 0 ? 'Loss on this deal' : 'Margin on this deal'}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-2.5">
                      <span className={cn('text-[26px] font-bold leading-none tracking-[-0.035em] tabular-nums', margin < 0 ? 'text-[#B3261E]' : 'text-[#0B6B45]')}>
                        {formatINR(margin)}
                      </span>
                      <span className={cn('text-[14px] font-bold tabular-nums', margin < 0 ? 'text-[#B3261E]' : 'text-[#0B6B45]')}>
                        {marginPct.toFixed(2)}%
                      </span>
                    </div>
                    <div className={cn('mt-1.5 text-[11.5px] font-bold', margin < 0 ? 'text-[#8C2F26]' : 'text-[#0B6B45]')}>
                      {purchaseCalc.taxableValue > 0
                        ? `${formatINR(saleCalc.amount)} sold against ${formatINR(purchaseCalc.taxableValue)} bought`
                        : 'Enter the purchase and sale invoices to value this deal'}
                    </div>
                  </div>

                  {/* Break-even: the rate the sale has to clear for this deal
                      not to lose money. It is the purchase side's own adjusted
                      rate, named as the thing to beat. */}
                  {purchaseQty > 0 && (
                    <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-3">
                      <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Break-even rate</div>
                      <div className="mt-1.5 flex items-baseline justify-between gap-2.5">
                        <span className="text-[19px] font-bold leading-none tracking-[-0.03em] tabular-nums">
                          {formatINR(purchaseCalc.taxableValue / purchaseQty)}
                        </span>
                        <span className="text-[10.5px] font-bold text-[#5A6B62]">per {form.uom || 'MT'}</span>
                      </div>
                      {saleQty > 0 && (() => {
                        const sellRate = saleCalc.amount / saleQty
                        const breakEven = purchaseCalc.taxableValue / purchaseQty
                        const gap = sellRate - breakEven
                        return (
                          <>
                            <div className="mt-2.5 flex items-baseline justify-between gap-2.5 border-t border-t-[#EAF0E9] pt-2.5">
                              <span className="text-[12px] font-bold text-[#33473E]">Your sale rate</span>
                              <span className="text-[13.5px] font-bold tabular-nums">{formatINR(sellRate)}</span>
                            </div>
                            <div className="mt-1.5 flex items-baseline justify-between gap-2.5">
                              <span className="text-[12px] font-bold text-[#33473E]">Gap</span>
                              <span className={cn('text-[13.5px] font-bold tabular-nums', gap < 0 ? 'text-[#B3261E]' : 'text-[#0B6B45]')}>
                                {gap < 0 ? '−' : '+'}{formatINR(Math.abs(gap))}
                              </span>
                            </div>
                          </>
                        )
                      })()}
                    </div>
                  )}

                  {/* How much of what was bought has actually been sold on. A
                      deal saved part-allocated is legal — the rest is invoiced
                      later — so this reports rather than blocks. */}
                  {purchaseQty > 0 && (
                    <div
                      className={cn(
                        'rounded-[4px] border px-4 py-3',
                        Math.abs(qtyDiff) < 0.0005 ? 'border-[#BFE3CB] bg-[#F4FBF6]' : 'border-[#F0D9AE] bg-[#FFFBF2]'
                      )}
                    >
                      <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Quantity allocated to buyers</div>
                      <div className="mt-1.5 flex items-baseline gap-1.5">
                        <span className={cn('text-[19px] font-bold leading-none tracking-[-0.03em] tabular-nums', Math.abs(qtyDiff) < 0.0005 ? 'text-[#0B6B45]' : 'text-[#8A5300]')}>
                          {formatNum(saleQty)}
                        </span>
                        <span className="text-[11.5px] font-bold text-[#5A6B62]">of {formatNum(purchaseQty)} {form.uom || 'MT'} bought</span>
                      </div>
                      <div className="mt-2.5 h-[7px] overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                        <div
                          className="h-full"
                          style={{
                            width: `${Math.min(100, (saleQty / purchaseQty) * 100)}%`,
                            background: Math.abs(qtyDiff) < 0.0005 ? '#12855A' : '#C2700A'
                          }}
                        />
                      </div>
                      <div className={cn('mt-2 text-[11.5px] font-bold', Math.abs(qtyDiff) < 0.0005 ? 'text-[#0B6B45]' : 'text-[#8A5300]')}>
                        {Math.abs(qtyDiff) < 0.0005
                          ? 'Fully allocated'
                          : `${formatNum(Math.abs(qtyDiff))} ${form.uom || 'MT'} ${qtyDiff > 0 ? 'still unsold' : 'oversold'}`}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className={cn('rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#F0D6D4] !bg-white !p-3.5')}>
                <h3 className={cn('mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!-mx-3.5 !-mt-3.5 !mb-2.5 !border-b-[#F0D6D4] !bg-[#FDF3F2] !px-3.5 !py-2.5 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#8C2F26]')}>Purchase summary</h3>
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
                <div className={cn('my-2 border-t', __WEB__ && '!hidden')} />
                <MoneyRow label="Total after round off" value={formatINR(purchaseCalc.roundedTotal)} />
                <MoneyRow label="TDS" value={formatINR(purchaseTds)} muted />
                {!!supplierMaster?.tds_above_only && n(supplierMaster?.tds_threshold) > 0 && (
                  <p className={cn('pb-1 text-[11px] text-muted-foreground', __WEB__ && '!mt-2 !rounded-[4px] !border !border-[#F0D9AE] !bg-[#FFFBF2] !px-2.5 !py-2 !text-[11px] !font-semibold !leading-snug !text-[#8A5300]')}>
                    No TDS below ₹{formatNum(supplierMaster.tds_threshold)} a year — {formatINR(purchasePrior)} already
                    billed to this supplier, so the slab applies from there.
                  </p>
                )}
                <div className={cn('my-2 border-t-2 border-[#1a2c56]', __WEB__ && '!hidden')} />
                <MoneyRow label="Net payable to supplier" value={formatINR(purchaseNet)} strong foot="rose" />
              </div>

              <div className={cn('rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#BFE3CB] !bg-white !p-3.5')}>
                <h3 className={cn('mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!-mx-3.5 !-mt-3.5 !mb-2.5 !border-b-[#BFE3CB] !bg-[#F4FBF6] !px-3.5 !py-2.5 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0B6B45]')}>
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
                  <div className={cn('mb-2.5 space-y-1.5 border-b border-dotted border-[#d9d2b8] pb-2.5', __WEB__ && '!mb-3 !border-b-[#E4ECE3] !border-solid !pb-3')}>
                    <div className={cn('flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-widest text-muted-foreground', __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.12em] !text-[#5A6B62]')}>
                      <span>Per buyer</span>
                      <span>Net receivable</span>
                    </div>
                    {partyCalcs.map((c, pi) => {
                      const sp = parties()[pi]
                      const name = customers.find((x) => String(x.id) === String(sp?.customer_id || ''))?.name
                      return (
                        <div key={pi} className={cn('rounded border border-[#e5dfc8] bg-white px-2 py-1.5', __WEB__ && '!rounded-[4px] !border-l-[3px] !border-[#BFE3CB] !border-l-[#12855A] !px-2.5 !py-2')}>
                          <div
                            className={cn('truncate text-[11.5px] font-semibold leading-tight text-[#1a2c56]', __WEB__ && '!text-[12px] !font-extrabold !text-[#0B6B45]')}
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
                            <span className={cn('shrink-0 text-[12.5px] font-bold tabular-nums text-[#1a2c56]', __WEB__ && '!text-[13px] !text-[#0B6B45]')}>
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
                <div className={cn('my-2 border-t-2 border-[#1a2c56]', __WEB__ && '!hidden')} />
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
                  foot="emerald"
                />
              </div>

              {/* The app closes the column with the margin. The website
                  already opens it with the same two figures, in a card built
                  to carry them — stating them again at the bottom of a long
                  scroll invites the reader to check whether the two agree. */}
              {!__WEB__ && (
                <div className="rounded border border-[#1a2c56]/30 bg-white p-4">
                  <MoneyRow label="Deal margin (sale − purchase, on taxable value)" value={formatINR(margin)} strong />
                  <MoneyRow label="Margin %" value={`${marginPct.toFixed(2)}%`} muted />
                </div>
              )}
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
            {/* The period this register is showing — and the way to change
                it. Trading is the one page with no From/To inputs of its own,
                so this used to be a dead label whose tooltip pointed at
                Alt+F2: a shortcut a browser user will never find, and one
                some keyboards and window managers swallow before the page
                sees it. It is a button now, and it is always here — with no
                range set it reads All dates, so the period is settable from
                the page rather than only from a key nobody pressed. */}
            {(() => {
              const on = globalRangeAppliesTo(globalRange, 'trading')
              return (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new Event('open-period'))}
                  title={
                    on
                      ? globalRange.scope === 'page'
                        ? 'Period applied to this page only — click, or Alt+F2, to change it'
                        : 'Period applied across every page — click, or Alt+F2, to change it'
                      : 'Showing every deal on the books — click, or Alt+F2, to set a period'
                  }
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border border-[#d9d2b8] bg-[#fffdf4] px-3 py-1.5 text-[11px] font-medium text-[#1a2c56] transition-colors hover:bg-[#f7f2e2]',
                    // On the website it stands in a row of white 36px
                    // controls, where a short cream pill read as something
                    // that had strayed in from another screen.
                    __WEB__ &&
                      '!gap-2 !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13px] !font-semibold !text-[#0A1F17] hover:!bg-[#F7FAF6]'
                  )}
                >
                  <CalendarClock className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#5A6B62]')} />
                  {on ? (
                    <span className={cn(__WEB__ && 'tabular-nums')}>
                      {formatDate(globalRange.from)} → {formatDate(globalRange.to)}
                    </span>
                  ) : (
                    'All dates'
                  )}
                  {/* Which pages the period is holding on. Worth saying out
                      loud: a range set for one page only, seen on another,
                      is how a register ends up read for the wrong months. */}
                  {__WEB__ && on && globalRange.scope === 'page' && (
                    <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">
                      This page
                    </span>
                  )}
                </button>
              )
            })()}
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

      {/* Summary tiles. Every figure is read off filteredDeals — the same
          array the register below is drawn from — so a tile can never state
          something the table under it contradicts. */}
      {__WEB__ ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              k: 'Total deals',
              v: String(filteredDeals.length),
              sub: `${new Set(filteredDeals.map((d) => String(d.product_code || d.product_name || ''))).size} product${new Set(filteredDeals.map((d) => String(d.product_code || d.product_name || ''))).size === 1 ? '' : 's'}`,
              accent: '#0B3D2E',
              Icon: Repeat,
              iconBg: '#EAF0E9',
              iconFg: '#0B3D2E',
              vFg: '#0A1F17'
            },
            {
              k: 'Total purchase (taxable)',
              v: formatINR(totalPurchase),
              sub: 'bought in',
              accent: '#B3261E',
              Icon: TrendingDown,
              iconBg: '#FDF3F2',
              iconFg: '#B3261E',
              vFg: '#0A1F17'
            },
            {
              k: 'Total sale (taxable)',
              v: formatINR(totalSale),
              sub: 'sold out',
              accent: '#12855A',
              Icon: TrendingUp,
              iconBg: '#E9F5EE',
              iconFg: '#0B6B45',
              vFg: '#0A1F17'
            },
            {
              k: 'Total margin',
              v: formatINR(totalMargin),
              sub: totalPurchase > 0 ? `${((totalMargin / totalPurchase) * 100).toFixed(2)}% on cost` : 'nothing bought',
              accent: totalMargin < 0 ? '#B3261E' : '#C7F03F',
              Icon: totalMargin < 0 ? TrendingDown : TrendingUp,
              iconBg: totalMargin < 0 ? '#FDF3F2' : '#E9F5EE',
              iconFg: totalMargin < 0 ? '#B3261E' : '#0B6B45',
              vFg: totalMargin < 0 ? '#B3261E' : '#0B6B45'
            }
          ].map((k) => (
            <div
              key={k.k}
              className="flex items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
              style={{ borderTop: `3px solid ${k.accent}` }}
            >
              <div
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[3px]"
                style={{ background: k.iconBg, color: k.iconFg }}
              >
                <k.Icon className="h-[21px] w-[21px]" />
              </div>
              <div className="min-w-0">
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
                <div className="mt-0.5 truncate text-[19px] font-bold leading-tight tracking-[-0.035em] tabular-nums" style={{ color: k.vFg }} title={k.v}>
                  {k.v}
                </div>
                <div className="mt-0.5 text-[11.5px] font-bold text-[#5A6B62]">{k.sub}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
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
      )}

      <div className={cn('relative w-72', __WEB__ && '!flex !w-full !items-center !gap-2.5')}>
        <div className={cn(__WEB__ && 'relative min-w-[240px] flex-1')}>
          <Search className={cn('pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground', __WEB__ && '!left-3 !h-4 !w-4 !text-[#5A6B62]')} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, party, invoice no…"
            className={cn('h-9 pl-8', __WEB__ && '!h-[42px] !rounded-[4px] !border-[#C3D2C6] !pl-9 !text-[13px]')}
          />
        </div>
        {/* Products this book trades, as a segmented control rather than a
            dropdown: two or three is the usual number, they fit, and a count
            on each says what picking one is going to leave. Hidden when
            there is only one product — a filter with a single option filters
            nothing. */}
        {__WEB__ && prodChips.length > 2 && (
          <div className="flex shrink-0 items-center gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
            {prodChips.map((c) => {
              const on = prodFilter === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setProdFilter(c.value)}
                  className={cn(
                    'flex h-[34px] items-center gap-1.5 rounded-[2px] px-3 text-[12px] font-extrabold transition-colors',
                    on ? 'bg-[#0B3D2E] text-white' : 'text-[#5A6B62] hover:bg-white/70'
                  )}
                >
                  {c.label}
                  <span
                    className={cn(
                      'rounded-[2px] px-1.5 py-0.5 text-[10.5px] tabular-nums',
                      on ? 'bg-[#C7F03F]/20 text-[#C7F03F]' : 'bg-[#DCE7DB] text-[#33473E]'
                    )}
                  >
                    {c.count}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {/* Expand all lived here while the website unfolded its detail in
            place. A row now opens one deal in a drawer, so there is nothing
            left for it to expand. */}
      </div>

      {/* Tally-style register: ruled columns, tight rows, figures right-aligned
          on a cream ledger, and a grand total pinned at the foot.
          -mx-4 breaks it out of the page padding so the register runs the full
          width of the screen — fifteen money columns need every pixel, and the
          side gaps bought nothing. The header and search above keep their
          margin; only the table goes edge to edge, so the rounding and the
          left/right border go with it. */}
      <div className={cn('-mx-4 overflow-hidden border-y border-[#d9d2b8] bg-[#fffdf4] shadow-lg', __WEB__ && '!mx-0 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !shadow-none')}>
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
          <Table className={cn('[&_td]:border-r [&_td]:border-[#e8e2cc] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#b9c9e4] [&_th:last-child]:border-r-0', __WEB__ && '!min-w-[1240px] [&_td]:!whitespace-nowrap [&_td]:!border-r-[#F1F5EF] [&_th]:!whitespace-nowrap [&_th]:!border-r-[#12553F]')}>
            <TableHeader>
              <TableRow className={cn('bg-[#dce6f5] hover:bg-[#dce6f5]', __WEB__ && '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E]')}>
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
                      h.right && 'text-right',
                      __WEB__ && '!h-11 !text-[12px] !font-extrabold !tracking-[.07em] !text-[#DCEFE4]',
                      // Margin and Margin % are what the page is read for, so
                      // they get the lime the rest of the app reserves for the
                      // one column that matters.
                      __WEB__ && (h.label === 'Margin' || h.label === 'Margin %') && '!bg-[#1A4D2E] !text-[#C7F03F]'
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
                    open && 'bg-[#e8f0ff] hover:bg-[#e8f0ff]',
                    // Zebra stripes go: a left mark carries whether the deal
                    // made money, which is the only distinction worth colour
                    // here, and an open row goes white to join the panel below.
                    __WEB__ && '!border-b-[#EAF0E9] !border-l-[3px] [&>td]:!py-2.5',
                    __WEB__ && (n(d.margin) < 0 ? '!border-l-[#B3261E]' : '!border-l-[#12855A]'),
                    __WEB__ && (open ? '!bg-white hover:!bg-white' : '!bg-white hover:!bg-[#F7FAF6]')
                  )}
                  onClick={() => (__WEB__ ? setDetailDeal(d) : toggleExpanded(Number(d.id)))}
                >
                  <TableCell className={cn('py-1.5 text-[13px] tabular-nums text-[#1a2c56]', __WEB__ && '!text-[13px] !font-bold !text-[#0A1F17]')}>
                    <span className="inline-flex items-center gap-1.5">
                      {/* Desktop turns the caret down because the detail
                          unfolds under the row. The website's caret points
                          right at a panel that slides in from the right, so
                          it stays where it is. */}
                      {open && !__WEB__ ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', __WEB__ && '!h-[18px] !w-[18px] !text-[#5A6B62]')} />}
                      {formatDate(d.deal_date)}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-[13px] font-semibold">
                    {__WEB__ ? (
                      <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[11px] font-extrabold tracking-[.06em] text-[#33473E]">
                        {String(d.product_code || d.product_name || '—')}
                      </span>
                    ) : (d.product_code || d.product_name)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right text-[13px] tabular-nums">
                    {formatNum(d.purchase_qty)} <span className="text-[11px] text-muted-foreground">{d.purchase_uom}</span>
                  </TableCell>
                  {/* Invoice numbers live in the expanded view, not here. */}
                  <TableCell className={cn('py-1.5 text-[13px] font-medium', __WEB__ && '!font-bold')}>{d.supplier_name || '—'}</TableCell>
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
                      n(d.margin) < 0 ? 'text-red-700' : 'text-emerald-700',
                      __WEB__ && '!text-[13.5px] !font-bold',
                      __WEB__ && (n(d.margin) < 0 ? '!bg-[#FDF3F2] !text-[#B3261E]' : '!bg-[#F4FBF6] !text-[#0B6B45]')
                    )}
                  >
                    {formatINR(d.margin)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'py-1.5 text-right text-[13px] tabular-nums',
                      n(d.margin_pct) < 0 ? 'text-red-700' : 'text-emerald-700',
                      __WEB__ && '!text-[12.5px] !font-bold',
                      __WEB__ && (n(d.margin_pct) < 0 ? '!bg-[#FDF3F2] !text-[#B3261E]' : '!bg-[#F4FBF6] !text-[#0B6B45]')
                    )}
                  >
                    {n(d.margin_pct).toFixed(2)}%
                  </TableCell>
                  <TableCell className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {/* One ⋮ rather than two boxed icons. The row already
                        opens the deal, so Edit beside it was the same action
                        twice — and a red bin standing in every row is a lot of
                        weight for the one action nobody wants to hit by
                        accident. Matches the Purchases, Bargains and
                        Formulation registers. */}
                    {__WEB__ ? (
                      <div className="flex justify-end">
                        <RowActions
                          actions={[
                            { label: 'Edit this deal', icon: Pencil, onClick: () => openEdit(d) },
                            {
                              label: 'Delete this deal — removes its invoices too',
                              icon: Trash2,
                              danger: true,
                              onClick: () => void removeDeal(d)
                            }
                          ]}
                        />
                      </div>
                    ) : (
                      <div className="flex justify-end gap-1 opacity-60 group-hover:opacity-100">
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit this deal" onClick={() => openEdit(d)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete this deal" onClick={() => void removeDeal(d)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                {!__WEB__ && open && (
                  <TableRow className="border-b-2 border-[#d9d2b8] bg-[#f4f7fd] hover:bg-[#f4f7fd] [&>td]:border-r-0">
                    <TableCell colSpan={10} className="p-0">
                      <div className={cn('grid gap-3 border-l-[3px] border-[#1a2c56] px-4 py-3 lg:grid-cols-2', __WEB__ && '!border-l-[#C3D2C6] !gap-3 !px-4 !py-3.5')}>
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

      {/* The deal, opened from its row.
          The register is one line per deal and a trade is a stack of invoices
          on both sides, so the detail cannot live in the row — it used to
          unfold underneath it, which pushed every other deal off the screen
          and made comparing two of them impossible. A drawer keeps the
          register where it is and puts one deal beside it. Website only: the
          desktop register keeps the in-place unfold its users know. */}
      {__WEB__ && (
        <Dialog open={!!detailDeal} onOpenChange={(o) => !o && setDetailDeal(null)}>
          <DialogContent className="!bottom-0 !left-auto !right-0 !top-0 !grid-rows-[auto_minmax(0,1fr)_auto] !h-screen !max-h-screen !w-[1160px] !max-w-[96vw] !min-w-0 !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-[18px] [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100">
            {detailDeal && (() => {
              const d = detailDeal
              const uom = String(d.purchase_uom || 'MT')
              const pl: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
              const sl: Row[] = Array.isArray(d.sale_lines) ? d.sale_lines : []
              const sp: Row[] = Array.isArray(d.sale_parties) ? d.sale_parties : []
              const multi = sp.length > 1
              // A deal with no invoice on either side. Rare, but it renders as
              // two empty panels facing each other, which reads as a loading
              // failure rather than as "nothing has been invoiced yet".
              const noDetail = !pl.length && !sl.length && !sp.length
              const loss = n(d.margin) < 0
              const totalQty = sp.reduce((a, b) => a + n(b.qty), 0)
              return (
                <>
                  <DialogHeader className="!block !space-y-0 !bg-[#0B3D2E] !px-5 !pb-5 !pt-5 !text-left">
                    <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Trading deal</div>
                    <DialogTitle className="!mt-2.5 !flex !flex-wrap !items-center !gap-x-3.5 !gap-y-2 !pr-10">
                      <span className="text-[21px] font-bold leading-none tracking-[-0.02em] tabular-nums text-white">
                        {formatDate(d.deal_date)}
                      </span>
                      <span className="rounded-[3px] border border-white/20 bg-white/[0.12] px-2.5 py-[5px] text-[11px] font-extrabold uppercase tracking-[.06em] leading-none text-white">
                        {String(d.product_code || d.product_name || '—')}
                      </span>
                      {/* A hairline rather than another chip — the quantity
                          belongs to the date and product, not beside them as
                          a third label of equal weight. */}
                      <span className="h-4 w-px shrink-0 bg-white/25" />
                      <span className="text-[14px] font-bold leading-none tabular-nums text-[#C7F03F]">
                        {formatNum(d.purchase_qty)} {uom}
                      </span>
                    </DialogTitle>
                    {/* The one figure the deal is judged on, in the header
                        rather than at the foot of a scroll — a loss is the
                        reason a deal gets opened.
                        Opaque, not a tinted overlay: red at 28% over the
                        forest header composites to an olive-brown that reads
                        as neither colour, and the pale text on it goes muddy
                        with it. A solid ground and a bright rule down the
                        left say loss at a glance instead. */}
                    <div
                      className={cn(
                        'mt-[18px] flex flex-wrap items-center gap-x-3 gap-y-1.5 overflow-hidden rounded-[3px] border-l-[3px] px-3.5 py-3',
                        loss ? 'border-l-[#FF8379] bg-[#6E211B]' : 'border-l-[#C7F03F] bg-[#0E5B3E]'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[3px]',
                          loss ? 'bg-[#8C2F26]' : 'bg-[#12855A]'
                        )}
                      >
                        {loss ? (
                          <TrendingDown className="h-[16px] w-[16px] text-[#FFD3CF]" />
                        ) : (
                          <TrendingUp className="h-[16px] w-[16px] text-[#C7F03F]" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'text-[10.5px] font-extrabold uppercase tracking-[.12em]',
                          loss ? 'text-[#FFC4BE]' : 'text-[#C7F03F]'
                        )}
                      >
                        {loss ? 'Loss on deal' : 'Margin on deal'}
                      </span>
                      <span className="ml-auto flex items-baseline gap-2.5">
                        <span className="whitespace-nowrap text-[19px] font-bold tracking-[-0.02em] tabular-nums text-white">
                          {formatINR(d.margin)}
                        </span>
                        {/* The percentage is the smaller of the two figures
                            and kept as one: boxed, it stops competing with
                            the rupees beside it. */}
                        <span
                          className={cn(
                            'whitespace-nowrap rounded-[3px] px-2 py-1 text-[12px] font-extrabold tabular-nums',
                            loss ? 'bg-[#8C2F26] text-[#FFD3CF]' : 'bg-[#12855A] text-[#EAFBC9]'
                          )}
                        >
                          {n(d.margin_pct).toFixed(2)}%
                        </span>
                      </span>
                    </div>
                  </DialogHeader>

                  {/* [&>*]:shrink-0 is load-bearing, not tidying.
                      In a column flex container a child's automatic minimum
                      size normally stops it being squashed below its own
                      content — EXCEPT when the child is itself a scroll
                      container, and overflow:hidden counts. Both the invoice
                      panels and the buyer cards clip their corners with
                      overflow-hidden, so their minimum went to 0, and once
                      this column overflowed they were shrunk to their top
                      edge: every card rendered as its header strip alone with
                      the invoice rows and totals clipped away, while the
                      split card and the tax card beside them — which have no
                      overflow-hidden — stayed whole. */}
                  <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4 [&>*]:shrink-0">
                    {/* Both sides at a glance, before any invoice detail:
                        what went out to the supplier and what came back from
                        the buyers, each with the party's name under it. */}
                    <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
                      <div className="rounded-[4px] border border-l-4 border-[#F0D6D4] border-l-[#B3261E] bg-white px-3.5 py-3">
                        <span className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#5A6B62]">
                          Bought for
                        </span>
                        <div className="mt-1.5 whitespace-nowrap text-[16px] font-bold tabular-nums">
                          {formatINR(d.purchase_taxable)}
                        </div>
                        <div className="mt-1 truncate text-[11.5px] font-bold text-[#5A6B62]">
                          {String(d.supplier_name || '—')}
                        </div>
                      </div>
                      <div className="rounded-[4px] border border-l-4 border-[#BFE3CB] border-l-[#12855A] bg-white px-3.5 py-3">
                        <span className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#5A6B62]">
                          Sold for
                        </span>
                        <div className="mt-1.5 whitespace-nowrap text-[16px] font-bold tabular-nums">
                          {formatINR(d.sale_amount)}
                        </div>
                        <div className="mt-1 truncate text-[11.5px] font-bold text-[#5A6B62]">
                          {multi ? `${sp.length} buyers` : String(d.customer_name || '—')}
                        </div>
                      </div>
                    </div>

                    {/* A trade has two halves, and they are read against
                        each other: what it cost on the left, what it fetched
                        on the right. Stacked in one narrow column the buyer
                        side began below the fold, so the two sides of the
                        same deal were never on screen together — which is the
                        one comparison this drawer exists to make.

                        auto-fit with a 380px floor, so a narrow window folds
                        them back into one column rather than crushing both.

                        [&>*]:shrink-0 on each column for the same reason it
                        is on the scroller: the invoice panels and buyer cards
                        clip their corners, and an overflow-hidden child of a
                        flex column has a minimum size of 0 — without it they
                        collapse to their header strip. */}
                    {noDetail ? (
                      <div className="flex flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-7">
                        <Receipt className="h-7 w-7 text-[#C3D2C6]" />
                        <span className="text-[12.5px] font-semibold text-[#5A6B62]">
                          No invoices are recorded against this deal yet.
                        </span>
                      </div>
                    ) : (
                      <div className="grid items-start gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
                        <div className="flex min-w-0 flex-col gap-2.5 [&>*]:shrink-0">
                          <SideHead rose label="Seller side" total={n(d.purchase_taxable)} />
                          <InvoicePanel
                            heading="Purchase invoices"
                            party={String(d.supplier_name || '—')}
                            lines={pl}
                            uom={uom}
                            total={n(d.purchase_taxable)}
                            tone="rose"
                          />
                          <TaxCard
                            rose
                            head="Purchase"
                            party=""
                            onExplain={() => setTdsSide('purchase')}
                            gstPct={`${formatNum(d.purchase_gst_pct)}%`}
                            gstAmt={n(d.purchase_gst_amount)}
                            tdsPct={`${formatNum(d.purchase_tds_pct)}%`}
                            tdsAmt={n(d.purchase_tds_amount)}
                            netLabel="Net payable to supplier"
                            net={n(d.purchase_net)}
                          />
                        </div>

                        <div className="flex min-w-0 flex-col gap-2.5 [&>*]:shrink-0">
                          <SideHead rose={false} label="Buyer side" total={n(d.sale_amount)} />
                          {multi ? (
                            <>
                              <BuyerSplit parties={sp} uom={uom} />
                              {sp.map((party: Row, pi: number) => (
                                <BuyerCard key={pi} party={party} index={pi} total={totalQty} uom={uom} />
                              ))}
                            </>
                          ) : (
                            <InvoicePanel
                              heading="Sale invoices"
                              party={String(sp[0]?.customer_name || d.customer_name || '—')}
                              lines={sp.length ? (Array.isArray(sp[0]?.lines) ? sp[0].lines : []) : sl}
                              uom={uom}
                              total={n(d.sale_amount)}
                              tone="emerald"
                            />
                          )}
                          {/* A split deal has no single rate to quote: each
                              buyer is invoiced on its own GST and its own TDS
                              slab, and the cards above carry the real
                              figures. */}
                          <TaxCard
                            rose={false}
                            head="Sale"
                            party={multi ? `${sp.length} buyers` : ''}
                            onExplain={() => setTdsSide('sale')}
                            gstPct={multi ? 'per buyer' : `${formatNum(d.sale_gst_pct)}%`}
                            gstAmt={n(d.sale_gst_amount)}
                            tdsPct={multi ? 'per buyer' : `${formatNum(d.sale_tds_pct)}%`}
                            tdsAmt={n(d.sale_tds_amount)}
                            netLabel="Net receivable"
                            net={n(d.sale_net_receivable)}
                          />
                        </div>
                      </div>
                    )}

                    {/* The LC this deal was funded on, and whether the bank
                        has been repaid. Carried over from the in-place panel
                        — it only shows when there is an LC behind the deal. */}
                    {!!d.lc_id && (
                      <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3">
                        <span className="text-[11px] font-extrabold uppercase tracking-[.08em] text-[#0A1F17]">
                          LC {String(d.lc_no || `#${d.lc_id}`)}
                        </span>
                        <span
                          className={cn(
                            'rounded-[3px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.05em]',
                            d.lc_bank_repaid ? 'bg-[#EAF6EC] text-[#0B6B45]' : 'bg-[#FFEDD0] text-[#8A5300]'
                          )}
                        >
                          {d.lc_bank_repaid ? 'Bank repaid' : 'Bank outstanding'}
                        </span>
                        <span
                          className={cn(
                            'rounded-[3px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.05em]',
                            d.sale_fully_paid ? 'bg-[#EAF6EC] text-[#0B6B45]' : 'bg-[#FFEDD0] text-[#8A5300]'
                          )}
                        >
                          {d.sale_fully_paid
                            ? 'Sale paid'
                            : `Sale outstanding ${formatINR(Math.max(0, n(d.sale_net_receivable) - n(d.sale_paid)))}`}
                        </span>
                        {!!d.trading_lc_closed && (
                          <span className="rounded-[3px] bg-[#EAF0E9] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#33473E]">
                            LC closed
                          </span>
                        )}
                      </div>
                    )}

                    {(!d.qty_matched || !!d.note) && (
                      <div className="flex flex-wrap items-center gap-2.5 rounded-[4px] border border-[#F0D9AE] bg-[#FFFBF2] px-3.5 py-3">
                        {!d.qty_matched && (
                          <span className="text-[12px] font-bold text-[#8A5300]">
                            {formatNum(Math.abs(n(d.purchase_qty) - n(d.sale_qty)))} {uom}{' '}
                            {n(d.purchase_qty) > n(d.sale_qty) ? 'still unsold' : 'oversold'}
                          </span>
                        )}
                        {!!d.note && <span className="text-[12px] font-semibold text-[#33473E]">Note: {String(d.note)}</span>}
                      </div>
                    )}
                  </div>

                  {/* Close and Edit. The handoff draws a Print between them,
                      but this page has no per-deal print to wire it to — the
                      only export it owns is the whole register to Excel, from
                      the header — so a button that did nothing is left out. */}
                  <div className="flex flex-wrap items-center gap-2.5 border-t border-[#D6E2D6] bg-white px-5 py-3.5">
                    <button
                      type="button"
                      onClick={() => setDetailDeal(null)}
                      className="flex h-12 items-center rounded-[4px] border-[1.5px] border-[#C3D2C6] px-5 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#EAF0E9]"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDetailDeal(null); openEdit(d) }}
                      className="ml-auto flex h-12 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-6 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] transition-colors hover:bg-[#0F4A38]"
                    >
                      <Pencil className="h-5 w-5" /> Edit deal
                    </button>
                  </div>
                </>
              )
            })()}
          </DialogContent>
        </Dialog>
      )}

      {/* The working behind whichever side's TDS was asked about. Built here
          rather than inside the drawer's IIFE because it outlives a re-render
          of the drawer body and needs the party masters, which are page
          state. */}
      {__WEB__ && tdsSide && detailDeal && (() => {
        const d = detailDeal
        const sp: Row[] = Array.isArray(d.sale_parties) ? d.sale_parties : []
        const parties: TdsParty[] =
          tdsSide === 'purchase'
            ? (() => {
                const master = suppliers.find((x) => String(x.id) === String(d.supplier_id || ''))
                const lines: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
                return [
                  {
                    partyId: n(d.supplier_id),
                    name: String(d.supplier_name || '—'),
                    pct: n(d.purchase_tds_pct),
                    // On the goods alone, the same as the sale side — GST is
                    // not withheld on.
                    on: 'taxable' as const,
                    gstPct: n(d.purchase_gst_pct),
                    roundOff: n(d.purchase_round_off),
                    invoices: lines.map((l) => ({
                      id: n(l.order_id),
                      label: String(l.invoice_no || `Invoice #${n(l.order_id)}`),
                      taxable: round2(n(l.qty) * n(l.rate))
                    })),
                    posted: n(d.purchase_tds_amount),
                    threshold: n(master?.tds_threshold),
                    aboveOnly: !!master?.tds_above_only
                  }
                ]
              })()
            : (sp.length
                ? sp
                : [
                    {
                      customer_id: d.customer_id,
                      customer_name: d.customer_name,
                      tds_pct: d.sale_tds_pct,
                      tds_amount: d.sale_tds_amount,
                      gst_pct: d.sale_gst_pct,
                      round_off: d.sale_round_off,
                      lines: Array.isArray(d.sale_lines) ? d.sale_lines : []
                    } as Row
                  ]
              ).map((b: Row) => {
                const master = customers.find((x) => String(x.id) === String(b.customer_id || ''))
                const lines: Row[] = Array.isArray(b.lines) ? b.lines : []
                return {
                  partyId: n(b.customer_id),
                  name: String(b.customer_name || '—'),
                  pct: n(b.tds_pct),
                  // A sale withholds on the GOODS alone: GST is the
                  // government's money passing through, and the round-off is
                  // a presentation artifact.
                  on: 'taxable' as const,
                  gstPct: n(b.gst_pct),
                  roundOff: n(b.round_off),
                  invoices: lines.map((l) => ({
                    id: n(l.sale_id),
                    label: String(l.invoice_no || `Invoice #${n(l.sale_id)}`),
                    taxable: round2(n(l.qty) * n(l.rate))
                  })),
                  posted: n(b.tds_amount),
                  threshold: n(master?.tds_threshold),
                  aboveOnly: !!master?.tds_above_only
                }
              })
        return (
          <TdsExplainer
            open
            onClose={() => setTdsSide(null)}
            side={tdsSide}
            dealDate={String(d.deal_date || '')}
            parties={parties}
          />
        )
      })()}
    </div>
  )
}
