import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  History,
  FileText,
  LayoutGrid,
  Landmark,
  List,
  Paperclip,
  Pencil,
  Percent,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Users
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { InfoTip } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { PageHeader } from '@/components/PageHeader'
import { PeriodPicker } from '@/components/PeriodPicker'
import { RowActions } from '@/components/ui/row-actions'
import { formatDate, formatDateShort, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { exportLcRegister } from '@/lib/lcExcel'
import { HistoryDialog, useHistoryDialog } from '@/components/HistoryDialog'
import { BillDiscounting } from './BillDiscounting'
import { ColumnFilter } from '@/components/ui/column-filter'
import { canAccess } from '@/lib/modules'
import { loadUser } from '@/lib/session'
import { useIsMobile } from '@/lib/useIsMobile'
import { TreasuryMobile } from './TreasuryMobile'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// The six cells under the facility bar. Centred text is right when a cell
// is a lone KPI tile; in a row of six it makes every figure start at a
// different x, so they cannot be compared down the row. Left-aligned on the
// website, and the label small caps over the money.
const LIMIT_CELL = __WEB__ ? '!bg-white !px-3.5 !py-3 !text-left' : ''
const LIMIT_K = __WEB__ ? '!text-[9px] !font-extrabold !tracking-[.12em] !text-[#5A6B62]' : ''
const LIMIT_V = __WEB__ ? '!mt-1 !whitespace-nowrap !text-[14.5px] !font-bold !text-[#0A1F17]' : ''

function daysTo(date: unknown): number | null {
  const s = String(date || '').slice(0, 10)
  if (!s) return null
  return Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

// Same action either way — winding the LC up posts a repayment — just named
// for what's actually happening: still early (Preclose) vs. simply repaying
// an LC that's already run its natural course (Repay).
function isLcPastMaturity(l: Row): boolean {
  const expiry = String(l.expiry_date || '').slice(0, 10)
  return !!expiry && todayISO() >= expiry
}

// Cumulative "due within" windows — matching how these filters actually read:
// "This week" means everything due within 7 days (including what's already
// overdue or due tomorrow), not only the items landing in a 2-7 day slice.
const DUE_PERIODS: { key: string; label: string; maxDays?: number }[] = [
  { key: 'all', label: 'All' },
  { key: 't1', label: 'T+1 due', maxDays: 1 },
  { key: 'week', label: 'This week', maxDays: 7 },
  { key: 'fortnight', label: 'Fortnight', maxDays: 14 },
  // Rolling 30 days, not the calendar month — every other bucket here counts
  // forward from today, and one that jumped to a month boundary would answer a
  // different question from the two beside it.
  { key: 'month', label: 'This month', maxDays: 30 }
]

// Countdown chip: red overdue, amber close, muted otherwise.
// Days left, coloured by how much of the LC's OWN term has gone rather than by
// a flat number of days. 103 days left is nothing on a 365-day credit and most
// of the way through a 120-day one, so a fixed 7-day threshold said little:
// every LC read "muted" until the week it fell due. Pass `l` and the badge
// knows the term; without it, it falls back to the flat threshold.
function DueBadge({ date, l }: { date: unknown; l?: Row }): React.JSX.Element | null {
  const d = daysTo(date)
  if (d == null) return null
  const label = d < 0 ? `${-d}D overdue` : d === 0 ? 'due today' : `${d}D left`
  if (__WEB__) {
    const start = String(l?.opened_date || l?.open_date || '').slice(0, 10)
    const end = String(date || '').slice(0, 10)
    const term =
      /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
        ? Math.round((Date.parse(end) - Date.parse(start)) / 86400000)
        : 0
    const gone = term > 0 ? ((term - d) / term) * 100 : null
    // Overdue is always hot. Otherwise past 85% of the term, or — with no term
    // to measure against — inside the last week.
    const hot = d < 0 || (gone != null ? gone > 85 : d <= 7)
    return (
      <span
        className={cn(
          'inline-block whitespace-nowrap rounded-[2px] px-2.5 py-1 text-[12.5px] font-extrabold tabular-nums',
          hot ? 'bg-[#FDF3F2] text-[#B3261E]' : 'bg-[#FFF4E0] text-[#8A5300]'
        )}
        title={gone != null ? `${Math.round(gone)}% of the ${term}-day term gone` : undefined}
      >
        {label}
      </span>
    )
  }
  return (
    <Badge variant={d < 0 ? 'destructive' : d <= 7 ? 'warning' : 'muted'} className="tabular-nums">
      {label}
    </Badge>
  )
}

const STAGE_LABEL: Record<string, string> = {
  application: 'Application',
  open: 'Open',
  payment_received: 'Payment received'
}

// The LC's own lifecycle — Application → Open → Payment received.
// The three stages read as a journey, and the colours follow it: nothing has
// happened yet, the bank has agreed, the money has moved.
//
// Application is SLATE, deliberately unsaturated. It used to be amber, which
// says "attention" — and an application needs none: it is a request sitting
// with the bank, not something going wrong. Amber is also what a genuine
// warning uses here (Awaiting Payment IN, Closed late), so an LC that had done
// nothing wrong wore the same colour as one that had. Grey says "not yet",
// which is exactly what it is, and gives amber back its meaning.
function StageBadge({ stage }: { stage: string }): React.JSX.Element {
  const tone =
    stage === 'payment_received'
      ? 'bg-emerald-100 text-emerald-800'
      : stage === 'open'
        ? 'bg-sky-100 text-sky-800'
        : stage === 'application'
          ? 'bg-slate-200 text-slate-700'
          : 'bg-amber-100 text-amber-800'
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        tone,
        __WEB__ && '!px-2.5 !py-[3px] !text-[11px] !font-bold'
      )}
    >
      {STAGE_LABEL[stage] || stage}
    </span>
  )
}

// A row's stage reads at a glance from its own left border + tint, the same
// amber/sky/emerald the badge already uses — no need to read the text to know
// where an LC sits in Application → Open → Payment received. The row also
// carries a dotted BOTTOM divider, and `border-style` isn't a per-side
// Tailwind utility — `border-dotted` there would flatten this left border's
// style too, so it's pinned back to solid with an explicit arbitrary property.
// The register's chrome on the website. Named because the header row, its
// cells and the totals band have to agree, and a sticky header composites
// each of its own cells over whatever is behind it — a translucent tint
// there renders as a pale block, not as the header's colour.
// Every LC screen on the website comes in from the right: opening one, moving
// it a stage, winding it up. A centred modal over a register asks the reader to
// let go of where they were; a drawer keeps the row they clicked in view down
// the left, which is what they are working from. 720px is the handoff's width —
// wide enough for the two-column sections, narrow enough to leave the table
// legible behind it.
//
// Header and footer are pinned and only the middle scrolls: these forms run
// past a screen, and Save at the bottom of a long scroll is Save that gets
// missed.
const LC_DRAWER = __WEB__
  //
  // The width steps with the screen. 720px is the handoff's figure and it is
  // right on a laptop, but on a desktop it left two thirds of the window dark
  // while the fields inside sat three to a row. The section grids are auto-fit
  // at minmax(190px, 1fr), so every extra 200px of drawer becomes another
  // field on the line rather than more whitespace — the form gets shorter as
  // the screen gets wider, which is the point.
  //
  // Capped in vw as well as px so a small laptop still gets a sliver of the
  // register behind it to keep its place.
  ? '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[min(100vw,720px)] lg:!w-[min(94vw,880px)] xl:!w-[min(92vw,1000px)] 2xl:!w-[min(90vw,1120px)] !max-w-none !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5'
  : ''
// The forest band at the top of each of them: kind above name, so
// "Letter of credit / Open new LC" reads as a heading rather than a sentence.
const LC_BAND = __WEB__ ? '!bg-[#0B3D2E] !bg-none !px-5 !py-4' : ''
const LC_EYEBROW = 'text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]'
const LC_TITLE = __WEB__ ? '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em]' : ''
const LC_SUB = __WEB__ ? '!mt-1 !text-[12px] !font-semibold !text-[#8FBFA8]' : ''
// The scrolling middle, and the white bar under it.
const LC_BODY = __WEB__ ? '!min-h-0 !content-start !gap-3.5 !overflow-y-auto !p-4' : ''
const LC_FOOT = __WEB__
  ? '!flex-wrap !items-center !gap-2.5 !border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5'
  : ''
const LC_CANCEL = __WEB__
  ? '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !bg-white !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E] hover:!bg-[#EAF0E9]'
  : ''
const LC_SAVE = __WEB__
  ? '!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-7 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]'
  : ''

// The LC form's step cards on the website: a tinted title strip over a white
// body, every control in them at one height. Named because the three sections
// have to stay identical, and because the dialog sets the field size once for
// all of them rather than each field carrying its own.
const LC_DIALOG = __WEB__
  ? '!rounded-[4px] !border-[#D6E2D6] !bg-white !p-0 !shadow-none'
  : ''
const LC_SECTION_HEAD = __WEB__
  ? '!mb-0 !gap-2 !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[15px] !py-[11px] !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0A1F17] [&>span:first-child]:!hidden'
  : ''

// One grid for every section body in the LC screens. The handoff flows its
// fields — repeat(auto-fit, minmax(min(100%,190px),1fr)) — rather than fixing
// two columns, so a 720px drawer fits three short fields on a line and a
// narrow window drops to one without a breakpoint being involved. 15px of
// padding and a 13px gutter, as drawn.
const LC_GRID = __WEB__
  ? '!grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] !gap-[13px] !p-[15px] [&>div]:!min-w-0'
  : ''
const LC_FIELDS = __WEB__
  // min-h on the labels because some carry an (i) and some do not: a 14px icon
  // makes its label taller than its neighbour's, and the two inputs below then
  // start 4px apart on the same row.
  //
  // Uppercase and a shade darker, at 11px: mixed-case 10px grey read as a
  // caption rather than as the name of the field under it. The nested spans go
  // back to normal case — a required asterisk does not care, but a
  // parenthetical like "(repayments go out of this)" is a sentence and gets
  // hard to read shouted.
  ? '[&_label]:!min-h-[18px] [&_label]:!items-center [&_label]:!text-[11px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.1em] [&_label]:!text-[#33473E] [&_label>span]:!normal-case [&_label>span]:!tracking-normal [&_input]:!h-11 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[13px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=date-picker]]:!h-11 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!text-[13.5px]'
  : ''

// A row of preview figures: hairline cells, label small caps over the money,
// left-aligned so the column can be read downwards.
// The four figures on an LC card. Same shape as the register's cells: label
// in small caps over the money, so a card and a row read alike.
const CARD_CELLS =
  '!gap-2 [&>div]:!rounded-[4px] [&>div]:!px-3 [&>div]:!py-2.5 [&>div>div:first-child]:!text-[9px] [&>div>div:first-child]:!font-extrabold [&>div>div:first-child]:!uppercase [&>div>div:first-child]:!tracking-[.11em] [&>div>div:first-child]:!text-[#5A6B62] [&>div>div:last-child]:!mt-1 [&>div>div:last-child]:!whitespace-nowrap [&>div>div:last-child]:!text-[13px] [&>div>div:last-child]:!font-bold'

const PREVIEW_CELLS =
  '!gap-px !bg-[#E4ECE3] !text-left [&>div]:!bg-white [&>div]:!px-3.5 [&>div]:!py-3 [&>div>div:first-child]:!text-[9px] [&>div>div:first-child]:!font-extrabold [&>div>div:first-child]:!tracking-[.12em] [&>div>div:first-child]:!text-[#5A6B62] [&>div>div:last-child]:!mt-1 [&>div>div:last-child]:!whitespace-nowrap [&>div>div:last-child]:!text-[14.5px] [&>div>div:last-child]:!font-bold'

const TRACKER_HEAD =
  __WEB__
    ? '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&>th]:!h-auto [&>th]:!bg-[#0B3D2E] [&>th]:!py-2.5 [&>th]:!text-[9.5px] [&>th]:!font-extrabold [&>th]:!tracking-[.13em] [&>th]:!text-white'
    : ''
// The row's own actions. Fixed heights and a floor on the width so the column
// reads as one stack of buttons rather than a ragged edge — min, not a hard
// width, because "Mark Payment received" is twice the length of "Preclose"
// and the handoff's 126px would cut it off.
const LC_ACT_GO =
  '!h-[30px] !min-w-[118px] !rounded-[3px] !border-0 !bg-[#0B3D2E] !px-3 !text-[12.5px] !font-extrabold !text-white hover:!bg-[#0F4A38]'
const LC_ACT_2ND =
  '!h-[30px] !w-[78px] !rounded-[3px] !border !border-[#C3D2C6] !bg-white !px-0 !text-[12.5px] !font-extrabold !text-[#33473E] hover:!bg-[#F7FAF6]'
const LC_HEAD =
  __WEB__
    ? '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&>th]:!h-auto [&>th]:!bg-[#0B3D2E] [&>th]:!py-3 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!tracking-[.1em] [&>th]:!text-white [&_button]:!text-[11px] [&_button]:!uppercase [&_button]:!tracking-[.1em] [&_button]:!text-white'
    : ''
const LC_TOTAL =
  __WEB__
    ? '!border-b-2 !border-b-[#C7F03F] !bg-[#EFF5EC] hover:!bg-[#EFF5EC] [&>td]:!py-3 [&>td]:!text-[#0A1F17]'
    : ''

// Stage colour on the left edge only, on the app's own palette.
const STAGE_MARK_WEB: Record<string, string> = {
  application: '!border-l-[#8FA79B]',
  open: '!border-l-[#C2700A]',
  payment_received: '!border-l-[#12855A]'
}

const STAGE_ROW_TONE: Record<string, { row: string; hover: string }> = {
  // Slate, matching the badge — the border and the chip are two readings of the
  // same fact and must not disagree.
  application: { row: "border-l-4 border-l-slate-400 bg-slate-50/60 [border-left-style:solid]", hover: 'hover:bg-slate-100/70' },
  open: { row: "border-l-4 border-l-sky-400 bg-sky-50/50 [border-left-style:solid]", hover: 'hover:bg-sky-100/60' },
  payment_received: { row: "border-l-4 border-l-emerald-400 bg-emerald-50/50 [border-left-style:solid]", hover: 'hover:bg-emerald-100/60' }
}

interface Props {
  onCompanyChange: (id: string) => void
}

// What the beneficiary actually receives, shown as the arithmetic rather than
// as a number to be taken on trust.
//
// A derived figure with no working is a figure nobody can check. This one is
// three deductions off the open amount, and each of them has a source: a rate
// and a day count that were entered on the LC, and a commission the bank
// quoted. Putting the sum on screen means a disagreement can be traced to the
// input that caused it instead of being argued about.
//
// Opens on hover AND on click: hover to glance, click to keep it open while
// reading the numbers off.
function PayableBreakdown({ l, children }: { l: Row; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const amount = n(l.amount)
  const upfront = !!l.interest_upfront
  const rate = n(l.interest_pct)
  const days = n(l.usance_days)
  // The base the LEDGER used, not the open amount: this popover exists to
  // explain a voucher, and recomputing from the open amount made it contradict
  // the very figure it was explaining on any LC with an adjusted base.
  const base = lcInterestBaseOf(l)
  const interest = upfront ? 0 : lcInterestOf(l)
  const charges = upfront ? 0 : Math.round(n(l.charges) * 100) / 100
  // What the bank actually released, when it has released anything. The
  // expectation below it is only that — an expectation — and where the two
  // differ the recorded figure is the one that happened.
  const paid = l.paid_to_party == null ? null : n(l.paid_to_party)
  const expected = n(l.paid_expected)
  const net = paid ?? expected
  const drift = paid == null ? 0 : Math.round((paid - expected) * 100) / 100
  const party = String(l.supplier_name || 'the beneficiary')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className="cursor-help"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
        >
          {children}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[19rem] p-0 text-[12px]"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rounded-t-md bg-[#1a2c56] px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-white">
          Payment rec
        </div>
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Open amount</span>
            <span className="font-medium tabular-nums">{formatINR(amount)}</span>
          </div>

          {upfront ? (
            <div className="rounded border border-sky-200 bg-sky-50 px-2 py-1.5 text-[11px] leading-snug text-sky-900">
              Interest and charges are settled <b>upfront from the bank</b> on this LC, so nothing is
              deducted here — {party} receives the full open amount.
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  less Interest
                  <span className="ml-1 text-[10.5px] text-muted-foreground/70">
                    {rate}% · {days}d
                  </span>
                </span>
                <span className="tabular-nums text-rose-700">− {formatINR(interest)}</span>
              </div>
              {/* The sum itself, so the rate and the day count can be checked
                  against the bank's own working rather than guessed at. */}
              <div className="doc-ref pl-2 text-[10.5px] text-muted-foreground/70">
                {formatINR(base)} × {rate}% × {days} ÷ 365
              </div>
              {/* Where the base is not the open amount, say what it is — two
                  LCs at the same rate on the same amount otherwise carry
                  different interest for no reason the reader can see. */}
              {Math.abs(base - amount) > 0.005 && (
                <div className="pl-2 text-[10.5px] leading-snug text-muted-foreground/70">
                  on {String(l.interest_basis || 'an adjusted base')} — {lcInterestBaseWorking(l)}
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">less Bank charges</span>
                <span className="tabular-nums text-rose-700">− {formatINR(charges)}</span>
              </div>
            </>
          )}

          <div className="!mt-2 flex items-baseline justify-between gap-3 border-t pt-2">
            <span className="font-semibold">
              {paid == null ? 'Would reach' : 'Paid to'} {party}
            </span>
            <span className="font-bold tabular-nums text-emerald-700">{formatINR(net)}</span>
          </div>

          {/* The bill the bank raised need not match the arithmetic above it —
              a rate struck over different days, a commission waived. When it
              does not, say so and name the gap rather than quietly showing one
              figure in the register and the other in the ledger. */}
          {Math.abs(drift) > 0.005 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10.5px] leading-snug text-amber-900">
              The bill the bank raised is <b>{formatINR(Math.abs(drift))}</b> {drift > 0 ? 'more' : 'less'} than the
              sum above ({formatINR(expected)}). The bill is what {party} was paid, and it is what the ledger carries.
            </div>
          )}
          {paid == null && (
            <div className="rounded border border-sky-200 bg-sky-50 px-2 py-1.5 text-[10.5px] leading-snug text-sky-900">
              No bill has been raised yet, so nothing has reached {party}. This is what the LC would release.
            </div>
          )}
        </div>
        <div className="rounded-b-md border-t bg-muted/40 px-3 py-2 text-[10.5px] leading-snug text-muted-foreground">
          The bank keeps its interest and commission out of the credit before releasing the rest. You repay
          the <b>open amount</b> at maturity, not this figure.
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Whether an LC can be wound up at all. Only once the bank has PAID under the
// credit: before that there is no advance to repay, no interest running, and
// nothing the preclosure arithmetic can work from.
//
// The button used to appear on every LC that was not already preclosed, so an
// application the bank had not even opened offered to be closed early. The
// server refuses it too — this only stops the offer being made.
function canPreclose(l: Row): boolean {
  return !l?.preclosed_date && String(l?.stage || 'application') === 'payment_received'
}

// One dated line in the validity column: a fixed-width tag, then the date.
//
// The tag box is fixed because "Op" and "Mat" are different lengths, and a
// label that flows pushes its date sideways — which is what made the column
// look ragged when every date in it is in fact the same width. Columned dates
// can be compared down the page at a glance; staggered ones cannot.
// The tally beside a filter chip. Mono, because it is read as a number and
// lines up down the bar; inverted when the chip is on, so the count stays
// legible against the forest fill instead of going near-black on near-black.
function ChipCount({ n: count, on }: { n: number; on: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'ml-1.5 inline-block rounded-[2px] px-[5px] py-[2px] align-middle font-mono text-[10.5px] font-bold tabular-nums',
        on ? 'bg-white/20 text-white' : 'bg-[#EAF0E9] text-[#33473E]'
      )}
    >
      {count}
    </span>
  )
}

// Opened over maturity, one under the other, with the tags in a fixed gutter
// so the two dates line up as a column. Set in the app's own face (doc-ref is
// Inter with tabular figures) rather than a mono face — the register is read
// down, and a second typeface for four dates is a change of voice for nothing.
function ValidityInline({ l }: { l: Row }): React.JSX.Element {
  const opened = !!l.opened_date
  const early = closureKind(l) === 'early'
  const Line = ({
    tag,
    tagClass,
    date,
    valueClass,
    title
  }: {
    tag: string
    tagClass: string
    date?: string | null
    valueClass: string
    title?: string
  }): React.JSX.Element => (
    <div className="flex items-baseline gap-2">
      <span
        className={cn('w-[27px] flex-none text-[10px] font-extrabold uppercase tracking-[.08em]', tagClass)}
        title={title}
      >
        {tag}
      </span>
      <span className={cn('doc-ref whitespace-nowrap text-[13.5px]', valueClass)}>
        {date ? formatDateShort(date) : <span className="text-[#C3D2C6]">—</span>}
      </span>
    </div>
  )
  return (
    <div className="flex min-w-0 flex-col gap-[2px] leading-[1.35]">
      <Line
        tag={opened ? 'Op' : 'App'}
        tagClass={opened ? 'text-[#5A6B62]' : 'text-[#C2700A]'}
        date={l.opened_date || l.open_date}
        valueClass="font-semibold text-[#0A1F17]"
        title={opened ? 'Opened by the bank' : 'Applied for — the bank has not opened it yet'}
      />
      <Line
        tag="Mat"
        tagClass="text-[#A8B8AE]"
        date={l.expiry_date}
        valueClass={cn('font-semibold', early ? 'text-[#A8B8AE] line-through decoration-[#C3D2C6]' : 'text-[#5A6B62]')}
        title={early ? 'Wound up early — this date never came' : 'Maturity'}
      />
      {!!l.preclosed_date && (
        <Line
          tag="Cls"
          tagClass="text-[#0B6B45]"
          date={l.preclosed_date}
          valueClass="font-semibold text-[#0B6B45]"
          title={`Closed ${formatDate(l.preclosed_date)}`}
        />
      )}
    </div>
  )
}

function LcPreviewRow({
  label,
  value,
  sub,
  tone,
  strong,
  last
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  strong?: boolean
  last?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('py-[9px]', !last && 'border-b border-b-[#EAF0E9]')}>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            'min-w-0 text-[12.5px]',
            strong ? 'font-extrabold text-[#0A1F17]' : 'font-semibold text-[#33473E]'
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            'doc-ref flex-none whitespace-nowrap font-bold tabular-nums',
            strong ? 'text-[17px]' : 'text-[13.5px]',
            tone || 'text-[#0A1F17]'
          )}
        >
          {value}
        </span>
      </div>
      {!!sub && <div className="doc-ref mt-[3px] text-[11px] font-semibold tabular-nums text-[#5A6B62]">{sub}</div>}
    </div>
  )
}

function DateLine({
  tag,
  date,
  title,
  tone,
  struck
}: {
  tag: string
  date?: string | null
  title?: string
  tone?: string
  struck?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex items-baseline gap-1.5 leading-[1.45]', struck && 'text-muted-foreground')}>
      <span
        className={cn(
          'inline-block w-[26px] shrink-0 text-[9.5px] font-semibold uppercase tracking-wider',
          tone || 'text-muted-foreground/70'
        )}
        title={title}
      >
        {tag}
      </span>
      <span className={cn('text-[12.5px] tabular-nums', struck && 'line-through decoration-muted-foreground/50')}>
        {date ? formatDateShort(date) : <span className="text-muted-foreground/50">—</span>}
      </span>
    </div>
  )
}

// What the bank charges interest ON — the whole open amount, or the open amount
// with the commission taken off first. Mirrors lcInterest() in the main process
// exactly; the form previewing one figure while the ledger posts another is the
// whole reason this is a function and not three copies of the arithmetic.
// The figure interest is actually struck on: the open amount, less the
// commission where the bank funds the credit net of it, then plus or minus
// whatever adjustment the bank's own advice shows. An open amount of 100 with
// an adjustment of -2 accrues on 98.
//
// The adjustment moves THIS. The margin, the facility limit and the exposure
// outstanding all stay on the open amount; the interest and its vouchers
// follow, and so does an auto-raised bill, which is sized at what the bank
// actually released.
function lcInterestBaseOf(v: Row): number {
  const gross = v?.interest_excl_charges ? round2(n(v.amount) - n(v.charges)) : n(v.amount)
  return Math.max(0, round2(gross + n(v.interest_adj)))
}

function lcInterestOf(v: Row): number {
  return round2((lcInterestBaseOf(v) * n(v.interest_pct) * n(v.usance_days)) / (100 * 365))
}

// Interest over a stated number of days rather than the whole usance — what
// pre-closure needs, for the days elapsed and for the days that will not
// happen.
function lcInterestOfDays(v: Row, days: number): number {
  return round2((lcInterestBaseOf(v) * n(v.interest_pct) * n(days)) / (100 * 365))
}

// The chain that produced the base, for a read-out: "1,00,000 - 3,360 - 2 =
// 96,638". Only the parts that are actually in play appear.
function lcInterestBaseWorking(v: Row): string {
  const amount = n(v.amount)
  const chg = round2(n(v.charges))
  const adj = round2(n(v.interest_adj))
  const parts = [fmtPlain(amount)]
  if (v?.interest_excl_charges && Math.abs(chg) > 0.005) parts.push(`- ${fmtPlain(chg)}`)
  if (Math.abs(adj) > 0.005) parts.push(`${adj < 0 ? '-' : '+'} ${fmtPlain(Math.abs(adj))}`)
  if (parts.length === 1) return ''
  return `${parts.join(' ')} = ${fmtPlain(lcInterestBaseOf(v))}`
}

function fmtPlain(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// The LC already wearing this number, if there is one. Matched the way the
// main process matches it — trimmed, case-insensitively, within the company —
// so the form's warning and the refusal on save agree about what a collision is.
//
// `lcs` is already scoped to the active company, which is the whole point: the
// two books number their credits independently, so KR FOODS LC-1 says nothing
// about KR FINMARK LC-1.
function lcNoClash(lcs: Row[], lcNo: unknown, selfId?: unknown): Row | null {
  const want = String(lcNo || '').trim().toUpperCase()
  if (!want) return null
  return (
    lcs.find(
      (x) => String(x.lc_no || '').trim().toUpperCase() === want && Number(x.id) !== Number(selfId || 0)
    ) || null
  )
}

// Marks a number that more than one LC in this company is wearing. New ones
// are refused outright now, but the eight that predate the rule are still here,
// and a rule nobody can see the exceptions to is no help — this is how you find
// them to renumber.
function DuplicateNoBadge({ lcs, l }: { lcs: Row[]; l: Row }): React.JSX.Element | null {
  const other = lcNoClash(lcs, l.lc_no, l.id)
  if (!other) return null
  return (
    <Badge
      variant="warning"
      title={
        `This number is on two LCs in this company — also ${String(other.bank || 'unknown bank')}` +
        `${other.open_date ? `, opened ${formatDate(other.open_date)}` : ''}` +
        `${Number(other.amount) ? `, ${formatINR(other.amount)}` : ''}. ` +
        'Both settlement vouchers carry it, so the ledger cannot tell them apart. Renumber one.'
      }
    >
      Number used twice
    </Badge>
  )
}

// How an LC's closure sits against its maturity. Only 'early' is a preclosure.
function closureKind(l: Row): 'none' | 'early' | 'on_time' | 'late' {
  const closed = String(l?.preclosed_date || '').slice(0, 10)
  if (!closed) return 'none'
  const mat = String(l?.expiry_date || '').slice(0, 10)
  if (!mat) return 'on_time'
  if (closed < mat) return 'early'
  if (closed > mat) return 'late'
  return 'on_time'
}

// The badge each of those deserves, or null when the LC is still open.
function ClosureBadge({ l, withDate }: { l: Row; withDate?: boolean }): React.JSX.Element | null {
  const kind = closureKind(l)
  if (kind === 'none') return null
  const on = withDate ? ` ${formatDate(l.preclosed_date)}` : ''
  if (kind === 'early') {
    return (
      <Badge variant="muted" title={`Wound up early on ${formatDate(l.preclosed_date)} — ${formatDate(l.expiry_date)} never came`}>
        Preclosed{on}
      </Badge>
    )
  }
  if (kind === 'late') {
    return (
      <Badge variant="warning" title={`Closed on ${formatDate(l.preclosed_date)}, after its ${formatDate(l.expiry_date)} maturity`}>
        Closed late{on}
      </Badge>
    )
  }
  return (
    <Badge variant="muted" title={`Closed on maturity, ${formatDate(l.preclosed_date)}`}>
      Closed{on}
    </Badge>
  )
}

export function Treasury({ onCompanyChange }: Props): React.JSX.Element {
  // A phone gets its own screen rather than this one narrowed: the registers
  // here are wide tables of figures, and a table that has to scroll sideways
  // on a phone is a table nobody reads. Website only — the desktop app's
  // window is never this narrow. Same fork Sales.tsx makes for SalesMobile.
  const isMobile = useIsMobile()
  if (__WEB__ && isMobile) return <TreasuryMobile />

  // Treasury's three sections are granted separately. A user reaches this page
  // through the Treasury permission, then sees only the sections they hold —
  // the LC desk, the discounting decision and collections are different jobs.
  //
  // A section with no grant is not rendered at all rather than shown disabled:
  // the figures on these tabs are the whole content, so a disabled tab would
  // still be displaying them.
  const sessionUser = useMemo(() => loadUser(), [])
  const TREASURY_TABS = useMemo(
    () =>
      [
        { key: 'lc', module: 'treasuryLc', label: 'Letters of Credit' },
        { key: 'bd', module: 'treasuryBd', label: 'Bill Discounting' },
        { key: 'tracker', module: 'treasuryTracker', label: 'Payment Tracker' }
      ].filter((t) => !sessionUser || canAccess(sessionUser, t.module)),
    [sessionUser]
  )
  const [tab, setTab] = useState(() => TREASURY_TABS[0]?.key || 'lc')

  // If the tab in hand is one they may not see — a permission changed under
  // them, or it was restored from a previous session — fall to the first they
  // can.
  useEffect(() => {
    if (TREASURY_TABS.length && !TREASURY_TABS.some((t) => t.key === tab)) setTab(TREASURY_TABS[0].key)
  }, [TREASURY_TABS, tab])
  const [lcs, setLcs] = useState<Row[]>([])
  const [bills, setBills] = useState<Row[]>([])
  const [alerts, setAlerts] = useState<Row | null>(null)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [sales, setSales] = useState<Row[]>([])
  const [orders, setOrders] = useState<Row[]>([])
  const [tradingDeals, setTradingDeals] = useState<Row[]>([])
  const [issuances, setIssuances] = useState<Record<number, Row[]>>({})
  const [repayments, setRepayments] = useState<Record<number, Row[]>>({})
  const [paymentIns, setPaymentIns] = useState<Record<number, Row[]>>({})
  // The lender picker in the header names BANKS on the LC tab and NBFCs on Bill
  // Discounting — a discounted bill is against an NBFC, so naming it "bank"
  // there was wrong and it scoped nothing.
  const [nbfcs, setNbfcs] = useState<Row[]>([])
  const [activeNbfc, setActiveNbfc] = useState('')
  const [lcDetailId, setLcDetailId] = useState<number | null>(null)
  const [lcView, setLcView] = useState<'cards' | 'table'>('table')
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null)
  // T+1 / this week / fortnight / monthly / quarterly, by whichever is nearer:
  // an outstanding bill's due date, or (no outstanding bill) the LC's expiry.
  const [lcDuePeriod, setLcDuePeriod] = useState('all')
  const [lcStageFilter, setLcStageFilter] = useState<string | null>(null)
  const [lcPurposeFilter, setLcPurposeFilter] = useState<string | null>(null)
  // 'all' = every LC; 'matured' = past its own expiry but not yet repaid;
  // A closure is a PRECLOSURE only when it happened BEFORE maturity. Closed on
  // the maturity date is the LC running its natural course, and closed after it
  // is late — neither is a preclosure.
  //
  // Every badge keyed off the closure date merely existing, so an LC repaid
  // exactly on its due date was labelled "Preclosed" and had its maturity
  // struck through as though the date never came. It came; that is the day it
  // was paid.
  //
  // Signature: 'none' | 'early' | 'on_time' | 'late'.
  // 'repaid' = preclosed/repaid already.
  const [lcStatusFilter, setLcStatusFilter] = useState<'all' | 'matured' | 'repaid'>('all')
  // Every LC bill and discounted bill in one due-date-sorted list, regardless
  // of urgency — the alerts above only surface what's already close.
  const [tracker, setTracker] = useState<Row[]>([])
  const [trackerShowSettled, setTrackerShowSettled] = useState(false)
  const [activeCompany, setActiveCompany] = useState(0)
  const [companies, setCompanies] = useState<Row[]>([])
  const [lcLimit, setLcLimit] = useState<Row | null>(null)
  const [banks, setBanks] = useState<Row[]>([])
  // Which bank the page is looking at. '' = every bank rolled together, the
  // same idea as the company switcher's "All companies".
  const [activeBank, setActiveBank] = useState('')
  // Narrows the LC Facility Limit KPI (Utilised/Available) to LCs opened in
  // this window — empty means every currently-outstanding LC, unfiltered.
  const [lcKpiFrom, setLcKpiFrom] = useState('')
  const [lcKpiTo, setLcKpiTo] = useState('')
  // Admin-only Settings toggle (General tab) — mirrors the backend's default
  // when off (require a linked invoice); '0' relaxes it everywhere.
  const [relaxedInvoiceRule, setRelaxedInvoiceRule] = useState(false)

  const load = useCallback(async () => {
    const [l, bd, a, sup, cust, sl, od, deals, tr, act, comps, lim, bnk, invRule] = await Promise.all([
      window.api.lc.list(),
      window.api.billDiscounting.list(),
      window.api.treasury.alerts(),
      window.api.data.list('suppliers'),
      window.api.data.list('customers'),
      window.api.sales.list(undefined, 'treasury'),
      window.api.orders.list('treasury'),
      window.api.trading.list('treasury'),
      window.api.treasury.paymentTracker(),
      window.api.company.getActive(),
      window.api.company.list(),
      window.api.lc.getLimit(activeBank ? Number(activeBank) : undefined, lcKpiFrom || undefined, lcKpiTo || undefined),
      window.api.data.list('banks'),
      window.api.settings.get('lc_require_linked_invoice')
    ])
    setLcs(l.filter((x) => String(x.facility_type || 'lc') === 'lc'))
    setBills(bd)
    setAlerts(a)
    setSuppliers(sup.filter((x) => x.active))
    setCustomers(cust.filter((x) => x.active))
    setSales(sl)
    setOrders(od)
    setTradingDeals(deals)
    setTracker(tr)
    setActiveCompany(Number(act?.id) || 0)
    setCompanies(comps)
    setLcLimit(lim)
    setBanks(bnk.filter((x) => x.active))
    setRelaxedInvoiceRule(invRule === '0')
  }, [activeBank, lcKpiFrom, lcKpiTo])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  async function openLcDetail(id: number): Promise<void> {
    setLcDetailId(id)
    const [rows, reps, pins] = await Promise.all([window.api.lc.issuances(id), window.api.lc.repayments(id), window.api.lc.paymentIns(id)])
    setIssuances((p) => ({ ...p, [id]: rows }))
    setRepayments((p) => ({ ...p, [id]: reps }))
    setPaymentIns((p) => ({ ...p, [id]: pins }))
  }

  async function reloadLcDetail(id: number): Promise<void> {
    const [rows, reps, pins] = await Promise.all([window.api.lc.issuances(id), window.api.lc.repayments(id), window.api.lc.paymentIns(id)])
    setIssuances((p) => ({ ...p, [id]: rows }))
    setRepayments((p) => ({ ...p, [id]: reps }))
    setPaymentIns((p) => ({ ...p, [id]: pins }))
  }

  // ---------------- LC create ----------------
  const [lcForm, setLcForm] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)

  // Deleting an LC reverses everything it's posted to the ledgers (opening
  // voucher, every bill's settlement) — a plain confirm() is too easy to
  // click through by habit, so a random 4-digit code has to be typed back
  // before the delete actually fires.
  const [lcDeleteTarget, setLcDeleteTarget] = useState<Row | null>(null)
  const [lcDeleteCode, setLcDeleteCode] = useState('')
  const [lcDeleteInput, setLcDeleteInput] = useState('')
  const [lcDeleting, setLcDeleting] = useState(false)

  function requestDeleteLc(l: Row): void {
    setLcDeleteTarget(l)
    setLcDeleteCode(String(Math.floor(1000 + Math.random() * 9000)))
    setLcDeleteInput('')
  }

  async function confirmDeleteLc(): Promise<void> {
    if (!lcDeleteTarget || lcDeleteInput.trim() !== lcDeleteCode) return
    setLcDeleting(true)
    try {
      await window.api.lc.remove(Number(lcDeleteTarget.id))
      toast.success(`LC ${lcDeleteTarget.lc_no || ''} deleted`)
      setLcDeleteTarget(null)
      if (Number(lcDeleteTarget.id) === lcDetailId) setLcDetailId(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLcDeleting(false)
    }
  }

  // ---------------- LC stage advance (Application -> Open -> Payment received) ----------------
  // A guided step, separate from the full Alter form: advancing asks only for
  // that stage's own date(s), so the LC's status and its dates can never
  // drift out of sync with each other.
  const [stageRow, setStageRow] = useState<Row | null>(null)
  const [stageForm, setStageForm] = useState<Row>({})
  const [stageSaving, setStageSaving] = useState(false)
  const [stageError, setStageError] = useState<string | null>(null)

  function nextLcStage(stage: string): 'open' | 'payment_received' | null {
    if (stage === 'application') return 'open'
    if (stage === 'open') return 'payment_received'
    return null
  }

  function openStageAdvance(l: Row): void {
    const next = nextLcStage(String(l.stage || 'application'))
    if (!next) return
    setStageRow(l)
    setStageForm(
      next === 'open'
        ? { opened_date: todayISO(), lc_no: l.lc_no || '' }
        : {
            payment_received_date: todayISO(),
            expiry_date: l.expiry_date || '',
            margin_pct: l.margin_pct || '',
            interest_pct: l.interest_pct || '',
            charges: l.charges || '',
            interest_upfront: !!l.interest_upfront,
            interest_excl_charges: !!l.interest_excl_charges,
            interest_adj: l.interest_adj == null || n(l.interest_adj) === 0 ? '' : String(l.interest_adj)
          }
    )
    setStageError(null)
  }

  async function saveStageAdvance(): Promise<void> {
    if (!stageRow) return
    const next = nextLcStage(String(stageRow.stage || 'application'))
    if (!next) return
    if (next === 'open' && (!stageForm.opened_date || !String(stageForm.lc_no || '').trim())) {
      return setStageError('The LC number and the date it opened are both needed')
    }
    {
      const clash = lcNoClash(lcs, stageForm.lc_no, stageRow?.id)
      if (clash) {
        return setStageError(
          `LC ${String(stageForm.lc_no).trim()} already exists in this company — ${String(clash.bank || 'unknown bank')}` +
            `${clash.open_date ? `, opened ${formatDate(clash.open_date)}` : ''}. Use the number the bank gave this credit.`
        )
      }
    }
    if (needsLinkedInvoice({ ...stageRow, stage: next })) {
      return setStageError(
        'This LC has no purchase invoice linked. Close this, press Edit and tick the invoice(s) it covers before moving it past Application.'
      )
    }
    if (next === 'payment_received' && (!stageForm.payment_received_date || !stageForm.expiry_date)) {
      return setStageError('Both the payment received date and the maturity date are needed')
    }
    if (
      next === 'payment_received' &&
      stageRow.opened_date &&
      String(stageForm.payment_received_date) < String(stageRow.opened_date)
    ) {
      return setStageError('Payment received date cannot be before the date the LC was opened')
    }
    setStageSaving(true)
    setStageError(null)
    try {
      await window.api.lc.update(Number(stageRow.id), {
        ...stageRow,
        facility_type: 'lc',
        party_type: 'supplier',
        party_id: stageRow.party_id ? Number(stageRow.party_id) : null,
        facility_id: stageRow.facility_id ? Number(stageRow.facility_id) : null,
        status: stageRow.status || 'open',
        stage: next,
        ...stageForm,
        // Refresh usance_days from the two dates just entered here — without
        // this the record keeps whatever (often blank) value it had before
        // this step, so the interest actually saved would silently disagree
        // with the days shown in the preview below.
        ...(next === 'payment_received' ? { usance_days: stagePreview?.days ?? 0 } : {})
      })
      toast.success(next === 'open' ? 'LC marked Open' : 'Payment received — bill(s) settled through the books')
      setStageRow(null)
      load()
    } catch (e) {
      setStageError((e as Error).message)
    } finally {
      setStageSaving(false)
    }
  }

  // ---------------- LC facility limit (Fixed + Convertible) ----------------
  const [lcLimitOpen, setLcLimitOpen] = useState(false)
  const [lcLimitForm, setLcLimitForm] = useState<Row>({})
  const [lcLimitSaving, setLcLimitSaving] = useState(false)

  function openLcLimit(): void {
    // A limit belongs to one bank, so the dialog opens on the bank in view —
    // or the only bank on file when the page is showing all of them.
    const only = banks.length === 1 ? String(banks[0].id) : ''
    setLcLimitForm({
      bank_id: activeBank || only,
      fixed_limit: lcLimit ? String(lcLimit.fixed_limit ?? 0) : '0',
      convertible_limit: lcLimit ? String(lcLimit.convertible_limit ?? 0) : '0',
      convertible_enabled: !!lcLimit?.convertible_enabled
    })
    setLcLimitOpen(true)
  }

  async function saveLcLimitForm(): Promise<void> {
    setLcLimitSaving(true)
    try {
      await window.api.lc.saveLimit({
        bank_id: n(lcLimitForm.bank_id),
        fixed_limit: n(lcLimitForm.fixed_limit),
        convertible_limit: n(lcLimitForm.convertible_limit),
        convertible_enabled: !!lcLimitForm.convertible_enabled
      })
      toast.success('LC limit updated')
      setLcLimitOpen(false)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLcLimitSaving(false)
    }
  }

  // ---------------- LC pre-closure ----------------
  // Preclosing is the same event as logging a normal LC repayment — the bank
  // still wants its full open amount back — just happening before maturity
  // instead of at it. Interest is recalculated over the days actually
  // elapsed, and on top of that, interest for the pending days (preclose ->
  // original maturity, which will now never happen) gets folded into the
  // same repayment as its excess-over-open-amount charge.
  const [precloseRow, setPrecloseRow] = useState<Row | null>(null)
  const [precloseForm, setPrecloseForm] = useState<Row>({})
  const [precloseSaving, setPrecloseSaving] = useState(false)
  const [precloseError, setPrecloseError] = useState<string | null>(null)

  function openPreclose(l: Row): void {
    setPrecloseRow(l)
    const precloseDate = todayISO()
    const openAmount = n(l.amount)
    const expiryDate = String(l.expiry_date || '').slice(0, 10)
    const pendingDays = expiryDate
      ? Math.max(0, Math.round((new Date(`${expiryDate}T00:00:00`).getTime() - new Date(`${precloseDate}T00:00:00`).getTime()) / 86400000))
      : 0
    // On the same base the interest was charged on — an LC whose interest was
    // struck on an adjusted figure must be rebated on that figure too, or the
    // reversal does not undo what was posted.
    const prematureInterest = lcInterestOfDays(l, pendingDays)
    setPrecloseForm({
      preclose_date: precloseDate,
      premature_interest: String(prematureInterest),
      premature_interest_direction: 'credit_to_us',
      amount: String(openAmount),
      comm_charges: '',
      bank_charges: '',
      release_margin: false
    })
    setPrecloseError(null)
  }

  // Undo a preclosure booked by mistake. Everything the preclosure wrote is
  // reversed — its rebate and margin vouchers, the repayment row it logged, and
  // the interest period it shortened. Confirmed first: it re-posts vouchers.
  const [unpreRow, setUnpreRow] = useState<Row | null>(null)
  const [unpreBusy, setUnpreBusy] = useState(false)

  async function confirmUnpreclose(): Promise<void> {
    const l = unpreRow
    if (!l) return
    setUnpreBusy(true)
    try {
      const r = await window.api.lc.unpreclose(Number(l.id))
      toast.success(`${String(l.lc_no || 'LC')} restored — ${r.removed.join(', ')}`)
      setUnpreRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUnpreBusy(false)
    }
  }

  const preclosePreview = useMemo(() => {
    if (!precloseRow || !precloseForm.preclose_date) return null
    const openAmount = n(precloseRow.amount)
    // Same start point usance_days was originally struck from at Payment
    // Received (expiry_date − payment_received_date) — not the Application
    // date, which can predate that by days or weeks and would otherwise
    // inflate this recalculation.
    const interestStart = String(precloseRow.payment_received_date || precloseRow.opened_date || precloseRow.open_date || '').slice(0, 10)
    const precloseDate = String(precloseForm.preclose_date)
    const days = interestStart
      ? Math.max(0, Math.round((new Date(`${precloseDate}T00:00:00`).getTime() - new Date(`${interestStart}T00:00:00`).getTime()) / 86400000))
      : 0
    const interest = lcInterestOfDays(precloseRow, days)
    const charges = round2(n(precloseRow.charges))
    // Pending days: what's left of the ORIGINAL term (preclose date ->
    // maturity) that will never actually happen — an extra cost on top of
    // (not instead of) the interest above, which only covers days actually
    // elapsed.
    const expiryDate = String(precloseRow.expiry_date || '').slice(0, 10)
    const pendingDays = expiryDate
      ? Math.max(0, Math.round((new Date(`${expiryDate}T00:00:00`).getTime() - new Date(`${precloseDate}T00:00:00`).getTime()) / 86400000))
      : 0
    const prematureInterest = lcInterestOfDays(precloseRow, pendingDays)
    const margin = round2((openAmount * n(precloseRow.margin_pct)) / 100)
    return { openAmount, days, interest, charges, pendingDays, prematureInterest, margin }
  }, [precloseRow, precloseForm.preclose_date])

  async function savePreclose(): Promise<void> {
    if (!precloseRow) return
    if (!precloseForm.preclose_date) return setPrecloseError('Pick the pre-closure date')
    if (precloseRow.open_date && String(precloseForm.preclose_date) < String(precloseRow.open_date)) {
      return setPrecloseError('Pre-closure date cannot be before the application date')
    }
    const openAmount = n(precloseRow.amount)
    if (!(n(precloseForm.amount) >= openAmount - 0.005)) {
      return setPrecloseError(`The total debited (${formatINR(n(precloseForm.amount))}) cannot be less than the open amount (${formatINR(openAmount)})`)
    }
    const excess = round2(n(precloseForm.amount) - openAmount)
    const splitTotal = round2(n(precloseForm.comm_charges) + n(precloseForm.bank_charges))
    if (excess > 0.005 && Math.abs(splitTotal - excess) > 0.005) {
      return setPrecloseError(`Comm. charges + Bank charges must add up to the ${formatINR(excess)} over the open amount`)
    }
    setPrecloseSaving(true)
    setPrecloseError(null)
    try {
      await window.api.lc.preclose(Number(precloseRow.id), {
        preclose_date: String(precloseForm.preclose_date),
        amount: n(precloseForm.amount),
        comm_charges: n(precloseForm.comm_charges),
        bank_charges: n(precloseForm.bank_charges),
        premature_interest: n(precloseForm.premature_interest),
        premature_interest_direction: precloseForm.premature_interest_direction === 'pay_to_party' ? 'pay_to_party' : 'credit_to_us',
        release_margin: !!precloseForm.release_margin
      })
      toast.success(
        isLcPastMaturity(precloseRow) ? 'LC repaid — posted to the books' : 'LC preclosed — repayment logged and rebate posted to the books'
      )
      setPrecloseRow(null)
      load()
    } catch (e) {
      setPrecloseError((e as Error).message)
    } finally {
      setPrecloseSaving(false)
    }
  }

  // Live preview for the Payment Received step — same interest/charges/margin
  // math lc.ts uses server-side to derive lc_net_available, so what's shown
  // here matches what actually gets stored (saveStageAdvance sends this same
  // `days` figure as usance_days, rather than leaving the field's old value
  // in place unrefreshed).
  const stagePreview = useMemo(() => {
    if (!stageRow || nextLcStage(String(stageRow.stage || 'application')) !== 'payment_received') return null
    const amount = n(stageRow.amount)
    const from = daysTo(stageForm.payment_received_date)
    const to = daysTo(stageForm.expiry_date)
    const days = from != null && to != null ? to - from : null
    const interestPct = n(stageForm.interest_pct)
    const charges = n(stageForm.charges)
    // One rule, shared with the LC form and the main process.
    const base = lcInterestBaseOf({ ...stageForm, amount })
    const interest = days != null ? round2((base * interestPct * days) / (100 * 365)) : 0
    const upfront = !!stageForm.interest_upfront
    const netAvailable = upfront ? amount : round2(amount - interest - charges)
    // Margin is the security deposit the bank asks for on the LC's own open
    // amount — a straight percentage of the credit limit itself, not of
    // whichever invoices happen to be linked to it.
    const margin = round2((amount * n(stageForm.margin_pct)) / 100)
    return {
      amount,
      days,
      interest,
      charges,
      margin,
      netAvailable,
      upfront,
      base,
      working: lcInterestBaseWorking({ ...stageForm, amount })
    }
  }, [stageRow, stageForm.payment_received_date, stageForm.expiry_date, stageForm.margin_pct, stageForm.interest_pct, stageForm.charges, stageForm.interest_upfront, stageForm.interest_excl_charges, stageForm.interest_adj])

  // Mirrors the backend rule (assertHasLinkedInvoice in lc.ts): an LC past
  // Application must name the invoice(s) it covers — UNLESS the supplier has
  // no invoice on file dated on or before the LC's own application date, which
  // is the case for back-entered history from before the books began. Nothing
  // to link, nothing to insist on.
  function needsLinkedInvoice(row: Row): boolean {
    if (String(row.stage || 'application') === 'application') return false
    if (relaxedInvoiceRule) return false
    if ((Array.isArray(row.linked_order_ids) ? row.linked_order_ids : []).length) return false
    const wantTrading = String(row.purpose || '') === 'trading'
    const on = String(row.open_date || '').slice(0, 10)
    return orders.some(
      (o) =>
        Number(o.supplier_id) === Number(row.party_id) &&
        Number(o.company_id) === Number(row.company_id || activeCompany) &&
        !!o.is_trading === wantTrading &&
        String(o.order_date || '').slice(0, 10) <= on
    )
  }

  // The same conditions saveLc refuses on, as a list rather than a toast —
  // a long form should say what it is still waiting for while there is
  // something to do about it. Display only: nothing here gates the Save
  // button, which stays clickable so its toast can still explain.
  const lcMissing = useMemo(() => {
    if (!lcForm) return [] as string[]
    const past = String(lcForm.stage || 'application') !== 'application'
    return [
      !String(lcForm.open_date || '').trim() && 'Application date',
      !String(lcForm.fd_no || '').trim() && 'FD no',
      !String(lcForm.purpose || '').trim() && 'Purpose',
      !lcForm.party_id && 'Supplier',
      past && !String(lcForm.lc_no || '').trim() && 'LC no',
      needsLinkedInvoice(lcForm) && 'A linked invoice'
    ].filter((x): x is string => typeof x === 'string')
    // needsLinkedInvoice reads only the form, and orders is what the invoice
    // picker itself is built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcForm])

  async function saveLc(): Promise<void> {
    if (!lcForm) return
    if (!String(lcForm.open_date || '').trim()) return void toast.error('Application date is required')
    if (!String(lcForm.fd_no || '').trim()) return void toast.error('FD No is required')
    if (!String(lcForm.purpose || '').trim()) return void toast.error('Purpose is required')
    if (!lcForm.party_id) return void toast.error('Supplier is required')
    if (String(lcForm.stage || 'application') !== 'application' && !String(lcForm.lc_no || '').trim()) {
      return void toast.error('LC number is required once the LC is Open')
    }
    {
      // The main process refuses this too — it has to, since it is the only
      // side a script or a second window cannot go around. This is here so the
      // message reads like a sentence rather than a thrown error.
      const clash = lcNoClash(lcs, lcForm.lc_no, lcForm.id)
      if (clash) {
        return void toast.error(
          `LC ${String(lcForm.lc_no).trim()} already exists in this company — ${String(clash.bank || 'unknown bank')}` +
            `${clash.open_date ? `, opened ${formatDate(clash.open_date)}` : ''}. Give this one a number of its own.`
        )
      }
    }
    // Past Application the LC is financing real goods, so it has to name the
    // invoice(s) it covers — otherwise the bill it auto-issues has nothing
    // behind it but the LC's own number.
    if (needsLinkedInvoice(lcForm)) {
      return void toast.error('Link at least one purchase invoice — an LC past Application must name the invoice(s) it covers')
    }
    {
      const linkedIds: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
      const linkedTotal = orders
        .filter((o) => linkedIds.map(String).includes(String(o.id)))
        .reduce((s, o) => s + n(o.net_amount), 0)
      if (linkedIds.length && n(lcForm.amount) > linkedTotal + 0.005) {
        return void toast.error(`The open amount cannot exceed ${formatINR(linkedTotal)}, the total of the selected invoices`)
      }
    }
    setBusy(true)
    try {
      const payload = {
        ...lcForm,
        facility_type: 'lc',
        party_type: 'supplier',
        party_id: lcForm.party_id ? Number(lcForm.party_id) : null,
        facility_id: lcForm.facility_id ? Number(lcForm.facility_id) : null,
        status: lcForm.status || 'open'
      }
      const res = lcForm.id
        ? await window.api.lc.update(Number(lcForm.id), payload)
        : await window.api.lc.create(payload)
      // A voucher that couldn't be re-posted is said out loud rather than
      // logged and forgotten — the LC itself is saved either way, but the
      // books would be out of step with it.
      if (res?.warning) toast.warning(res.warning, { duration: 10000 })
      else toast.success(`LC ${lcForm.lc_no} saved — margin, interest & charges posted to the books`)
      setLcForm(null)
      // Awaited, so the register can't still be showing pre-save figures by
      // the time the dialog is gone (which reads as "it didn't save").
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Only the active company's own invoices — an LC can't cover a bill booked
  // into a different company's books. Trading and manufacturing purchases are
  // separate books (orders.is_trading), so once a purpose is picked, only that
  // purpose's own invoices are offered.
  const lcFormOrders = useMemo(() => {
    if (!lcForm) return []
    const wantTrading = String(lcForm.purpose || '') === 'trading'
    return orders.filter(
      (o) =>
        (!lcForm.party_id || Number(o.supplier_id) === Number(lcForm.party_id)) &&
        Number(o.company_id) === Number(activeCompany) &&
        (!lcForm.purpose || !!o.is_trading === wantTrading)
    )
  }, [lcForm, orders, activeCompany])

  // A Trading LC finances one round trip — buy from the supplier, resell to
  // the customer. A deal's own purchase side can span more than one invoice,
  // and different invoices on the SAME deal can now go to DIFFERENT LCs, so
  // deals aren't excluded here just because another LC already touched one of
  // their invoices — see lcInvoiceClaims below, which does the actual
  // per-invoice exclusivity check.
  const lcFormDeals = useMemo(() => {
    if (!lcForm || String(lcForm.purpose || '') !== 'trading') return []
    return tradingDeals.filter((d) => !lcForm.party_id || Number(d.supplier_id) === Number(lcForm.party_id))
  }, [lcForm, tradingDeals])

  // Which LC (if any, other than the one being edited) already holds each
  // purchase invoice — the real exclusivity boundary now that a deal's
  // invoices can be split across LCs; a whole deal is no longer the unit.
  const lcInvoiceClaims = useMemo(() => {
    const m = new Map<number, Row>()
    for (const l of lcs) {
      if (lcForm?.id && Number(l.id) === Number(lcForm.id)) continue
      const ids: number[] = Array.isArray(l.linked_order_ids) ? l.linked_order_ids : []
      for (const oid of ids) m.set(Number(oid), l)
    }
    return m
  }, [lcs, lcForm?.id])

  // One row per actual purchase invoice, flattened out of every open deal for
  // this supplier — each invoice is its own pick now, not bundled behind a
  // single per-deal checkbox.
  const lcFormTradingInvoices = useMemo(() => {
    const rows: Row[] = []
    for (const d of lcFormDeals) {
      const lines: Row[] =
        Array.isArray(d.purchase_lines) && d.purchase_lines.length
          ? d.purchase_lines
          : [{ order_id: d.order_id, invoice_no: d.purchase_invoice_no }]
      for (const pl of lines) {
        const orderId = Number(pl.order_id)
        if (!orderId) continue
        const o = orders.find((x) => Number(x.id) === orderId)
        rows.push({
          deal_id: Number(d.id),
          order_id: orderId,
          invoice_no: pl.invoice_no || o?.invoice_no || '',
          deal_date: d.deal_date,
          // A deal resold to ONE buyer names that buyer, and ticking the
          // invoice pre-fills it as who the repayment comes from. Split
          // between several there is no single payer to pre-fill, so the id
          // is withheld and the label says how many — guessing the first of
          // five would quietly point the repayment at the wrong party.
          customer_id: n(d.customer_count) > 1 ? null : d.customer_id,
          customer_name:
            n(d.customer_count) > 1
              ? `${d.customer_count} buyers`
              : d.customer_name,
          net_amount: n(o?.net_amount)
        })
      }
    }
    return rows
  }, [lcFormDeals, orders])

  // Suppliers who actually deal in the selected purpose — the Suppliers
  // master itself records this (Trading or Manufacturing), so a Trading LC
  // only offers the handful of parties actually set up as trading accounts.
  const purposeSuppliers = useMemo(() => {
    if (!lcForm?.purpose) return []
    const wantTrading = String(lcForm.purpose) === 'trading'
    return suppliers.filter((s) => (String(s.business_type || 'Manufacturing') === 'Trading') === wantTrading)
  }, [lcForm?.purpose, suppliers])

  // The banks master drives the pick-list, so a bank added on the Banks page
  // is offered here immediately rather than only after some LC has used it.
  // Names already sitting on older LCs are kept in the list too, so an LC
  // written before the master existed still shows its own bank.
  const bankOptions = useMemo(() => {
    const set = new Set<string>()
    for (const b of banks) if (b.name) set.add(String(b.name).trim())
    for (const l of lcs) if (l.bank) set.add(String(l.bank).trim())
    return Array.from(set).sort()
  }, [banks, lcs])
  const NEW_BANK = '__new_bank__'
  const [addingNewBank, setAddingNewBank] = useState(false)
  const lcFormOpen = !!lcForm
  useEffect(() => {
    if (lcFormOpen) setAddingNewBank(false)
  }, [lcFormOpen])

  // ---------------- LC repayment ----------------
  const [repayForm, setRepayForm] = useState<Row | null>(null)

  async function pickRepaymentDocument(): Promise<void> {
    if (!repayForm) return
    const r = await window.api.files.pickDocument()
    if (r.path) setRepayForm((p) => ({ ...p, document_path: r.path }))
  }

  async function saveRepayment(): Promise<void> {
    if (!repayForm) return
    const amount = n(repayForm.amount)
    const openAmount = n(repayForm.open_amount)
    if (amount < openAmount - 0.005) {
      return void toast.error(`The repayment cannot be less than the LC's open amount (${formatINR(openAmount)})`)
    }
    const commCharges = round2(n(repayForm.comm_charges))
    const bankCharges = round2(n(repayForm.bank_charges))
    const excess = round2(amount - openAmount)
    if (excess > 0.005 && Math.abs(commCharges + bankCharges - excess) > 0.005) {
      return void toast.error(`Comm. + Bank charges must add up to ${formatINR(excess)}, the amount over the open amount`)
    }
    setBusy(true)
    try {
      await window.api.lc.saveRepayment({
        ...repayForm,
        lc_id: Number(repayForm.lc_id),
        party_id: repayForm.party_id ? Number(repayForm.party_id) : null,
        amount,
        comm_charges: commCharges,
        bank_charges: bankCharges,
        posted: !!repayForm.posted
      })
      toast.success(repayForm.posted ? 'Repayment posted to the books' : 'Repayment logged')
      const lcId = Number(repayForm.lc_id)
      setRepayForm(null)
      await reloadLcDetail(lcId)
      setLcDetailId(lcId)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeRepayment(r: Row): Promise<void> {
    if (!window.confirm('Delete this repayment? Its journal entry (if posted) reverses too.')) return
    await window.api.lc.removeRepayment(Number(r.id))
    await reloadLcDetail(Number(r.lc_id))
    load()
  }

  // ---------------- LC Payment IN (customer pays for the resale) ----------------
  // Only a Trading LC's own round trip closes this way. The customer's payment
  // and the bank being repaid (Preclose/Repayment) are two independent legs —
  // Payment IN opens up as soon as the LC reaches Payment received, not only
  // after Preclose. A deal's sale side can come in across more than one
  // receipt, so "fully paid" (and so "closed") is computed live from the
  // linked deal(s) rather than a one-shot flag on the LC itself.
  //
  // A deal "belongs" to an LC when at least one of its own purchase invoices
  // is actually linked to it (lc.linked_order_ids, the real per-invoice
  // record) — not d.lc_id, which is only a soft, last-invoice-touched pointer
  // now that a deal's invoices can be split across more than one LC.
  function dealOrderIds(d: Row): number[] {
    const lines: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
    const ids = lines.map((l) => Number(l.order_id)).filter(Boolean)
    return ids.length ? ids : [Number(d.order_id)].filter(Boolean)
  }
  function tradingDealsFor(lcId: number): Row[] {
    const l = lcs.find((x) => Number(x.id) === Number(lcId))
    const linked = new Set((Array.isArray(l?.linked_order_ids) ? l!.linked_order_ids : []).map(Number))
    if (!linked.size) return []
    return tradingDeals.filter((d) => dealOrderIds(d).some((oid) => linked.has(oid)))
  }
  function isLcPaymentInDone(l: Row): boolean {
    const deals = tradingDealsFor(Number(l.id))
    return deals.length > 0 && deals.every((d) => d.sale_fully_paid)
  }
  // The customer paying for the resale and the bank being repaid are two
  // independent legs of the round trip — Payment IN no longer waits on
  // Preclose/Repayment, just on the LC having reached Payment received.
  function canMarkPaymentIn(l: Row): boolean {
    return String(l.purpose || '') === 'trading' && String(l.stage || 'application') === 'payment_received' && !isLcPaymentInDone(l)
  }

  // ONE badge — where the LC actually stands right now — instead of stacking
  // the stage beside it. Both payment-IN states already require the LC to have
  // reached Payment received (see canMarkPaymentIn), so showing the stage badge
  // alongside them only repeated it and crowded the row.
  function currentStageBadge(l: Row): React.JSX.Element {
    if (canMarkPaymentIn(l)) return <Badge variant="warning">Awaiting Payment IN</Badge>
    if (isLcPaymentInDone(l)) return <Badge variant="success">Payment IN</Badge>
    return <StageBadge stage={String(l.stage || 'application')} />
  }
  const [paymentInForm, setPaymentInForm] = useState<Row | null>(null)
  const [paymentInInvoices, setPaymentInInvoices] = useState<Row[]>([])
  async function openPaymentIn(l: Row): Promise<void> {
    const invoices = await window.api.lc.openTradingInvoices(Number(l.id))
    setPaymentInInvoices(invoices)
    const allKeys = invoices.map((x) => String(x.key))
    const total = round2(invoices.reduce((s, x) => s + n(x.due), 0))
    setPaymentInForm({ lc_id: l.id, lc_no: l.lc_no, date: todayISO(), amount: String(total), selected_keys: allKeys })
  }
  function togglePaymentInInvoice(key: string): void {
    if (!paymentInForm) return
    const keys: string[] = Array.isArray(paymentInForm.selected_keys) ? paymentInForm.selected_keys : []
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
    const total = round2(
      paymentInInvoices.filter((x) => next.includes(String(x.key))).reduce((s, x) => s + n(x.due), 0)
    )
    setPaymentInForm((p) => ({ ...p, selected_keys: next, amount: String(total) }))
  }
  async function savePaymentIn(): Promise<void> {
    if (!paymentInForm) return
    const amount = n(paymentInForm.amount)
    if (amount <= 0.005) return void toast.error('Enter the amount received')
    const keys: string[] = Array.isArray(paymentInForm.selected_keys) ? paymentInForm.selected_keys : []
    if (!keys.length) return void toast.error('Pick at least one invoice this payment is for')
    setBusy(true)
    try {
      await window.api.lc.paymentIn(Number(paymentInForm.lc_id), amount, String(paymentInForm.date || todayISO()), keys)
      toast.success('Payment IN posted')
      const lcId = Number(paymentInForm.lc_id)
      setPaymentInForm(null)
      await reloadLcDetail(lcId)
      setLcDetailId(lcId)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function removePaymentIn(p: Row): Promise<void> {
    if (!window.confirm('Delete this Payment IN? Its journal entry reverses too.')) return
    await window.api.lc.removePaymentIn(Number(p.id))
    await reloadLcDetail(Number(p.lc_id))
    load()
  }


  // Each LC's nearest due date (an outstanding bill, else the LC's own expiry)
  // and which due-period bucket that falls into, for the dashboard filter.
  const lcsWithDue: Row[] = useMemo(
    () =>
      lcs.map((l) => {
        const dueDate = l.next_due_date || l.expiry_date
        // A repaid/preclosed LC has been wound up — nothing is owed on it any
        // more, so it carries no due date. Leaving one on would keep it
        // counting under T+1/This week/Fortnight and reading as overdue for
        // ever, long after it was settled.
        const daysLeft = l.preclosed_date ? null : daysTo(dueDate)
        const row: Row = {
          ...l,
          due_date_effective: l.preclosed_date ? null : dueDate,
          days_left_effective: daysLeft
        }
        return row
      }),
    [lcs]
  )
  // Column filters, kept separate from the bar above the table so each can be
  // built from the rows the OTHER filters leave — a column's own options must
  // not shift under the cursor while it is being ticked.
  const [lcBankCol, setLcBankCol] = useState<string[]>([])
  const [lcPartyCol, setLcPartyCol] = useState<string[]>([])
  const [lcMatCol, setLcMatCol] = useState<string[]>([])

  const lcsBase = useMemo(() => {
    let rows = lcsWithDue
    if (lcStageFilter) rows = rows.filter((l) => String(l.stage || 'application') === lcStageFilter)
    if (lcPurposeFilter) rows = rows.filter((l) => String(l.purpose || 'manufacturing') === lcPurposeFilter)
    if (activeBank) rows = rows.filter((l) => String(l.our_bank_id || '') === String(activeBank))
    // The three states are mutually exclusive: Repaid (wound up), Matured
    // (past its own expiry, still owed), and everything still running. The
    // default deliberately shows only the last of those — a settled or
    // expired LC needs no attention, so it would only pad the register.
    if (lcStatusFilter === 'matured') rows = rows.filter((l) => isLcPastMaturity(l) && !l.preclosed_date)
    else if (lcStatusFilter === 'repaid') rows = rows.filter((l) => !!l.preclosed_date)
    else rows = rows.filter((l) => !l.preclosed_date && !isLcPastMaturity(l))
    // Same window the LC Facility Limit KPI above is scoped to — the register
    // and the KPI it summarises always show the same cohort of LCs.
    if (lcKpiFrom) rows = rows.filter((l) => String(l.open_date || '').slice(0, 10) >= lcKpiFrom)
    if (lcKpiTo) rows = rows.filter((l) => String(l.open_date || '').slice(0, 10) <= lcKpiTo)
    if (lcDuePeriod === 'all') return rows
    const maxDays = DUE_PERIODS.find((p) => p.key === lcDuePeriod)?.maxDays
    if (maxDays == null) return rows
    // Cumulative: overdue and everything due sooner counts too, not just the
    // slice of days that falls exactly in this bucket.
    return rows.filter((l) => l.days_left_effective != null && l.days_left_effective <= maxDays)
  }, [lcsWithDue, lcDuePeriod, lcStageFilter, lcPurposeFilter, lcStatusFilter, activeBank, lcKpiFrom, lcKpiTo])

  // How many LCs sit behind each chip in the bar. Counted with every OTHER
  // filter in the bar applied, so a chip's number is what clicking it would
  // actually show — a global tally would disagree with the register beneath it
  // the moment a bank or a due period is picked.
  const lcChipCounts = useMemo(() => {
    const scope = (rows: Row[], withDue: boolean): Row[] => {
      let r = rows
      if (lcStageFilter) r = r.filter((l) => String(l.stage || 'application') === lcStageFilter)
      if (activeBank) r = r.filter((l) => String(l.our_bank_id || '') === String(activeBank))
      if (lcKpiFrom) r = r.filter((l) => String(l.open_date || '').slice(0, 10) >= lcKpiFrom)
      if (lcKpiTo) r = r.filter((l) => String(l.open_date || '').slice(0, 10) <= lcKpiTo)
      if (!withDue || lcDuePeriod === 'all') return r
      const maxDays = DUE_PERIODS.find((x) => x.key === lcDuePeriod)?.maxDays
      if (maxDays == null) return r
      return r.filter((l) => l.days_left_effective != null && l.days_left_effective <= maxDays)
    }
    const running = (l: Row): boolean => !l.preclosed_date && !isLcPastMaturity(l)
    const matured = (l: Row): boolean => isLcPastMaturity(l) && !l.preclosed_date
    const purposeOf = (l: Row): string => String(l.purpose || 'manufacturing')
    // The purpose chips count within whichever state is on screen; the state
    // chips count within whichever purpose is on screen. Neither counts its
    // own dimension, or the number would just be the row count.
    const inState = scope(lcsWithDue, true).filter(
      lcStatusFilter === 'matured' ? matured : lcStatusFilter === 'repaid' ? (l) => !!l.preclosed_date : running
    )
    const inPurpose = (rows: Row[]): Row[] =>
      lcPurposeFilter ? rows.filter((l) => purposeOf(l) === lcPurposeFilter) : rows
    return {
      manufacturing: inState.filter((l) => purposeOf(l) === 'manufacturing').length,
      trading: inState.filter((l) => purposeOf(l) === 'trading').length,
      all: inPurpose(scope(lcsWithDue, true)).filter(running).length,
      matured: inPurpose(scope(lcsWithDue, true)).filter(matured).length,
      // Clicking Repaid clears the due period, so counting one in would show a
      // zero on a chip that is about to reveal rows.
      repaid: inPurpose(scope(lcsWithDue, false)).filter((l) => !!l.preclosed_date).length
    }
  }, [lcsWithDue, lcDuePeriod, lcStageFilter, lcPurposeFilter, lcStatusFilter, activeBank, lcKpiFrom, lcKpiTo])

  // The month an LC matures in — the one useful way to filter a date column,
  // since a checkbox list of individual days would be as long as the register.
  const matMonth = (l: Row): string => String(l.expiry_date || '').slice(0, 7)
  const monthLabel = (m: string): string => {
    if (!/^\d{4}-\d{2}$/.test(m)) return 'No maturity date'
    const d = new Date(`${m}-01T00:00:00`)
    return d.toLocaleString('en-IN', { month: 'short', year: 'numeric' })
  }

  // Options come from the rows the other two column filters leave, so ticking
  // one column never removes a value another column is still offering.
  const colOptions = useMemo(() => {
    // Counted as well as collected, so the filter panel can show how many LCs
    // sit behind each value — the same walk already visits every row.
    const uniq = (rows: Row[], get: (l: Row) => string, label?: (v: string) => string) => {
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = get(r)
        counts.set(v, (counts.get(v) || 0) + 1)
      }
      return [...counts.keys()]
        .filter((v) => v !== '')
        .sort()
        .map((v) => ({ value: v, label: label ? label(v) : v, count: counts.get(v) || 0 }))
    }
    const byParty = (rows: Row[]) =>
      lcPartyCol.length ? rows.filter((l) => lcPartyCol.includes(String(l.supplier_name || ''))) : rows
    const byBank = (rows: Row[]) =>
      lcBankCol.length ? rows.filter((l) => lcBankCol.includes(String(l.bank || ''))) : rows
    const byMat = (rows: Row[]) => (lcMatCol.length ? rows.filter((l) => lcMatCol.includes(matMonth(l))) : rows)
    return {
      bank: uniq(byMat(byParty(lcsBase)), (l) => String(l.bank || '')),
      party: uniq(byMat(byBank(lcsBase)), (l) => String(l.supplier_name || '')),
      mat: uniq(byParty(byBank(lcsBase)), matMonth, monthLabel)
    }
  }, [lcsBase, lcBankCol, lcPartyCol, lcMatCol])

  const lcsFiltered = useMemo(() => {
    let rows = lcsBase
    if (lcBankCol.length) rows = rows.filter((l) => lcBankCol.includes(String(l.bank || '')))
    if (lcPartyCol.length) rows = rows.filter((l) => lcPartyCol.includes(String(l.supplier_name || '')))
    if (lcMatCol.length) rows = rows.filter((l) => lcMatCol.includes(matMonth(l)))
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lcsBase, lcBankCol, lcPartyCol, lcMatCol])

  // Who did what to one LC — the same dialog every other register uses.
  const hist = useHistoryDialog()
  const openHistory = (l: Row): void =>
    hist.open({
      entity: 'Letter of credit',
      id: Number(l.id),
      title: String(l.lc_no || 'this LC'),
      subtitle: `${l.bank_name || l.bank || '—'} · ${l.supplier_name || '—'} · ${formatINR(l.amount)}`
    })

  const [lcExporting, setLcExporting] = useState(false)
  async function downloadLcRegister(): Promise<void> {
    setLcExporting(true)
    try {
      // One query for every repayment in the company rather than one per LC —
      // and only when a repayment actually exists to report.
      const reps = lcsFiltered.some((l) => Number(l.repaid_count ?? 1) !== 0)
        ? await window.api.lc.allRepayments().catch(() => [] as Row[])
        : []
      await exportLcRegister(
        lcsFiltered,
        `lc-register-${lcDuePeriod === 'all' ? todayISO() : `${lcDuePeriod}-${todayISO()}`}`,
        reps
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLcExporting(false)
    }
  }

  // Bills issued under an LC, and repayments logged against it — shared by
  // both the card and table views so expanding an LC looks the same either way.
  function lcExpanded(l: Row): React.JSX.Element {
    const kids = issuances[Number(l.id)] || []
    const reps = repayments[Number(l.id)] || []
    return (
      <div className="space-y-3 px-4 py-3 sm:px-8">
        {kids.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Bills under this LC</div>
            <table className="w-full rounded-lg border bg-card text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5">
              <thead className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th>Bill / invoice</th><th>Issued</th><th>Due</th><th className="text-right">Amount</th><th>Status</th><th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {kids.map((b) => (
                  <tr key={String(b.id)} className="border-b last:border-0">
                    <td className="font-medium">
                      {b.bill_no || b.invoice_no || '—'}
                      {/* An LC opened without a linked purchase invoice auto-issues
                          one bill for its whole net available, named after the LC
                          itself — say so, or the row just looks like the LC number
                          repeated back. */}
                      {!b.order_id && (
                        <div className="text-[10px] font-normal text-muted-foreground">Full limit — no purchase invoice linked</div>
                      )}
                    </td>
                    <td className="tabular-nums">{formatDate(b.issue_date)}</td>
                    <td><span className="mr-1.5 tabular-nums">{formatDate(b.due_date)}</span>{String(b.status) !== 'settled' && <DueBadge date={b.due_date} />}</td>
                    <td className="text-right font-medium tabular-nums">{formatINR(b.amount)}</td>
                    <td>
                      {String(b.status) === 'settled'
                        ? <Badge variant="success">Settled {formatDate(b.settled_date)}</Badge>
                        : <Badge variant="warning">Outstanding</Badge>}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {String(b.status) === 'settled' ? (
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={async () => { await window.api.treasury.reopenLcBill(Number(b.id)); await reloadLcDetail(Number(l.id)); load() }}>
                            <RotateCcw className="h-3 w-3" /> Reopen
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px] text-emerald-700" onClick={async () => { try { await window.api.treasury.settleLcBill(Number(b.id)); toast.success('Bill settled — supplier paid through the books'); await reloadLcDetail(Number(l.id)); load() } catch (e) { toast.error((e as Error).message) } }}>
                            <Check className="h-3 w-3" /> Settle
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={async () => { if (confirm('Delete this bill?')) { await window.api.lc.removeIssuance(Number(b.id)); await reloadLcDetail(Number(l.id)); load() } }}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Repayments
          </div>
          {reps.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {String(l.stage || 'application') === 'payment_received'
                ? 'No repayments logged against this LC yet.'
                : 'Available once payment is received.'}
            </p>
          ) : (
            <table className="w-full rounded-lg border bg-card text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5">
              <thead className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th>Date</th><th className="text-right">Repayment</th><th className="text-right">Comm. chgs</th><th className="text-right">Bank chgs</th><th className="text-right">Total debited</th><th>Posted</th><th>Document</th><th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reps.map((r) => (
                  <tr key={String(r.id)} className="border-b last:border-0">
                    <td className="tabular-nums">{formatDate(r.repay_date)}</td>
                    <td className="text-right font-medium tabular-nums">{formatINR(r.amount)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{n(r.comm_charges) > 0 ? formatINR(r.comm_charges) : '—'}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{n(r.bank_charges) > 0 ? formatINR(r.bank_charges) : '—'}</td>
                    <td className="text-right font-medium tabular-nums">{formatINR(n(r.amount))}</td>
                    <td>{n(r.posted) ? <Badge variant="success">Posted</Badge> : <Badge variant="muted">Draft</Badge>}</td>
                    <td>
                      {r.document_path ? (
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => window.api.files.openDocument(String(r.document_path))}>
                          <FileText className="h-3 w-3" /> Open
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit" onClick={() => setRepayForm({ ...r, open_amount: n(l.amount) })}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" title="Delete" onClick={() => void removeRepayment(r)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {String(l.purpose || '') === 'trading' && (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Payment IN — customer paying for the resale
            </div>
            {(paymentIns[Number(l.id)] || []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {l.preclosed_date ? 'No payment received yet.' : 'Available once the LC is preclosed/repaid.'}
              </p>
            ) : (
              <table className="w-full rounded-lg border bg-card text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5">
                <thead className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th>Date</th><th className="text-right">Amount</th><th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(paymentIns[Number(l.id)] || []).map((p) => (
                    <tr key={String(p.id)} className="border-b last:border-0">
                      <td className="tabular-nums">{formatDate(p.pay_date)}</td>
                      <td className="text-right font-medium tabular-nums">{formatINR(p.amount)}</td>
                      <td className="text-right">
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" title="Delete" onClick={() => void removePaymentIn(p)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    )
  }

  // Each alert carries its FULL row set — clicking the chip opens a modal that
  // lists every one. It used to render the first four inline with no "and N
  // more", so a chip reading 6 showed 4 lines and the rest vanished.
  interface AlertGroup {
    key: string
    // The tab this alert belongs to. An LC warning on the Bill Discounting tab
    // is just noise — it is only actionable where the thing it is about lives.
    tab: string
    tone: string
    icon: typeof AlertTriangle
    label: string
    // What this alert actually means, spelled out at the top of the modal.
    blurb: string
    headers: string[]
    aligns: ('left' | 'right')[]
    rows: { cells: string[]; danger: boolean }[]
  }
  const alertItems: AlertGroup[] = []
  if (alerts) {
    const exp = (alerts.lcExpiring as Row[]) || []
    const lcDue = (alerts.lcBillsDue as Row[]) || []
    const bdDue = (alerts.billsDue as Row[]) || []
    const dueText = (d: number): string => (d < 0 ? `${-d}d OVERDUE` : d === 0 ? 'due today' : `${d}d left`)
    if (exp.length)
      alertItems.push({
        key: 'lcExpiring',
        tab: 'lc',
        tone: 'border-amber-300 bg-amber-50 text-amber-900',
        icon: CalendarClock,
        label: `${exp.length} LC${exp.length > 1 ? 's' : ''} expiring`,
        blurb:
          'LCs whose own maturity date falls within the next 15 days. Unused is the sanctioned amount less the bills actually drawn under it \u2014 limit that lapses when the LC matures.',
        headers: ['LC no', 'Bank', 'Supplier', 'Matures', 'Days', 'Sanctioned', 'Drawn', 'Unused'],
        aligns: ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right'],
        rows: exp.map((l) => ({
          danger: n(l.days_left) < 0,
          cells: [
            String(l.lc_no || '\u2014'),
            String(l.bank || '\u2014'),
            String(l.supplier_name || '\u2014'),
            formatDate(l.expiry_date),
            n(l.days_left) < 0 ? 'expired' : dueText(n(l.days_left)),
            formatINR(l.amount),
            formatINR(l.utilized),
            formatINR(n(l.amount) - n(l.utilized))
          ]
        }))
      })
    if (lcDue.length)
      alertItems.push({
        key: 'lcBillsDue',
        tab: 'lc',
        tone: lcDue.some((b) => b.days_left < 0) ? 'border-red-300 bg-red-50 text-red-800' : 'border-sky-300 bg-sky-50 text-sky-900',
        icon: Landmark,
        label: `${lcDue.length} LC bill${lcDue.length > 1 ? 's' : ''} maturing`,
        blurb:
          'Bills drawn under an LC that are still outstanding and reach their maturity date soon \u2014 these are payments the bank will take.',
        headers: ['LC no', 'Bill / invoice', 'Supplier', 'Due', 'Days', 'Amount'],
        aligns: ['left', 'left', 'left', 'left', 'left', 'right'],
        rows: lcDue.map((b) => ({
          danger: n(b.days_left) < 0,
          cells: [
            String(b.lc_no || '\u2014'),
            String(b.bill_no || b.invoice_no || '\u2014'),
            String(b.supplier_name || '\u2014'),
            formatDate(b.due_date),
            dueText(n(b.days_left)),
            formatINR(b.amount)
          ]
        }))
      })
    if (bdDue.length)
      alertItems.push({
        key: 'billsDue',
        tab: 'bd',
        tone: bdDue.some((b) => b.days_left < 0) ? 'border-red-300 bg-red-50 text-red-800' : 'border-indigo-300 bg-indigo-50 text-indigo-900',
        icon: Banknote,
        label: `${bdDue.length} discounted bill${bdDue.length > 1 ? 's' : ''} maturing`,
        blurb: 'Discounted bills reaching maturity \u2014 the date the financier expects to be squared off.',
        headers: ['Bill no', 'Party', 'Due', 'Days', 'Amount'],
        aligns: ['left', 'left', 'left', 'left', 'right'],
        rows: bdDue.map((b) => ({
          danger: n(b.days_left) < 0,
          cells: [
            String(b.bill_nos || '\u2014'),
            String(b.party_name || '\u2014'),
            formatDate(b.maturity_date || b.due_date),
            dueText(n(b.days_left)),
            formatINR(b.amount)
          ]
        }))
      })
  
  }

  const tabAlerts = alertItems.filter((a) => a.tab === tab)

  return (
    <>
      <PageHeader
        title="Treasury"
        hint="LCs carry interest days: every bill issued under one gets a maturity date, and settling it pays the supplier through the books against the original invoice. Discounting a sale bill brings the bank money in now (interest and charges to expenses) and clears the customer when the bill is realized. Everything shows in the Day Book, ledgers and Trial Balance."
        actions={
          <>
          {/* The lender in view scopes the register below it. On the LC tab
              that is a BANK — it also drives the facility limit and which bank
              a new LC opens at. On Bill Discounting it is an NBFC. */}
          {tab === 'bd' ? (
            <>
              <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Active NBFC
              </span>
              <Select value={activeNbfc} onValueChange={setActiveNbfc}>
                <SelectTrigger className="h-8 w-52 text-xs font-semibold uppercase tracking-wide">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="All my NBFCs" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All my NBFCs</SelectItem>
                  {nbfcs
                    .filter((x) => x.active)
                    .map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{String(x.name)}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          ) : (
            <>
              <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Active bank
              </span>
              <Select value={activeBank} onValueChange={setActiveBank}>
                <SelectTrigger className="h-8 w-52 text-xs font-semibold uppercase tracking-wide">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="All my banks" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All my banks</SelectItem>
                  {banks.map((b) => <SelectItem key={String(b.id)} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          )}
          {!__WEB__ && (
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="h-8 w-56 text-xs font-semibold uppercase tracking-wide">
              <SelectValue placeholder="Select a view" />
            </SelectTrigger>
            <SelectContent>
              {TREASURY_TABS.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label} (
                  {t.key === 'lc'
                    ? lcs.length
                    : t.key === 'bd'
                      ? bills.length
                      : tracker.filter((x) => !x.settled).length}
                  )
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
          </>
        }
      />
      {/* The instrument bar. A dropdown hid which desks exist and how much sits
          on each; three tabs with their counts say both without being opened,
          and the count is the reason to look — two bills is a different day
          from twenty-one. */}
      {__WEB__ && TREASURY_TABS.length > 1 && (
        <div className="flex flex-none flex-wrap items-stretch border-b border-b-[#D6E2D6] bg-white px-5">
          {TREASURY_TABS.map((t) => {
            const on = tab === t.key
            const Icon = t.key === 'lc' ? Landmark : t.key === 'bd' ? FileText : CalendarClock
            const count =
              t.key === 'lc' ? lcs.length : t.key === 'bd' ? bills.length : tracker.filter((x) => !x.settled).length
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex h-[50px] items-center gap-[9px] border-b-[3px] px-[18px] text-[13.5px] font-extrabold transition-colors',
                  on ? 'border-b-[#0B3D2E] text-[#0A1F17]' : 'border-b-transparent text-[#5A6B62] hover:text-[#0A1F17]'
                )}
              >
                <Icon className={cn('h-[19px] w-[19px]', on ? 'text-[#0B3D2E]' : 'text-[#A8B8AE]')} />
                {t.label}
                <span
                  className={cn(
                    'rounded-[2px] px-[7px] py-[3px] font-mono text-[11px] font-bold tabular-nums',
                    on ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#5A6B62]'
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className={cn('space-y-4 px-4 py-4', __WEB__ && '!px-4 !pt-3')}>
        <Tabs value={tab} onValueChange={setTab}>
          {/* Alerts and the LC filters share ONE row. The alerts stay outside
              the tab panels so they show on every tab; the filters only render
              on the LC tab, where they mean something. */}
          {(tabAlerts.length > 0 || tab === 'lc') && (
            <div className="flex flex-wrap items-center gap-2">
              {tabAlerts.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  title={`Click to see all ${a.rows.length}`}
                  onClick={() => setExpandedAlert(a.key)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold uppercase tracking-wide transition-colors hover:brightness-95',
                    a.tone,
                    __WEB__ && '!h-[38px] !rounded-[3px] !px-3.5 !text-[12px] !font-extrabold !tracking-[.05em]'
                  )}
                >
                  <a.icon className="h-3.5 w-3.5" /> {a.label}
                  <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                </button>
              ))}
              {tabAlerts.length > 0 && tab === 'lc' && <div className={cn('h-4 w-px bg-[#e5dfc8]', __WEB__ && '!h-6 !bg-[#C3D2C6]')} />}
              {tab === 'lc' && (
                <>
                    {/* One dropdown rather than four chips — they were mutually
                        exclusive windows on the same thing (how soon it falls
                        due), so a single control says that and frees the row.
                        Disabled wholesale for Repaid: a repaid LC has no due
                        date, so every window but All would come back empty. */}
                    <span
                      className="flex items-center gap-1.5"
                      title={
                        lcStatusFilter === 'repaid'
                          ? 'A repaid LC has no due date — nothing is owed on it'
                          : undefined
                      }
                    >
                      <span className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]')}>
                        Due
                      </span>
                      <Select
                        value={lcDuePeriod}
                        onValueChange={setLcDuePeriod}
                        disabled={lcStatusFilter === 'repaid'}
                      >
                        <SelectTrigger
                          className={cn(
                            'h-8 w-[9.5rem] text-[11px] font-semibold uppercase tracking-wide',
                            lcDuePeriod !== 'all' && 'border-[#1a2c56] bg-[#1a2c56] text-white',
                            __WEB__ && '!h-[38px] !w-[10.5rem] !rounded-[4px] !border-[#C3D2C6] !text-[12px] !font-bold !normal-case !tracking-normal',
                            __WEB__ && lcDuePeriod !== 'all' && '!border-[#0B3D2E] !bg-[#0B3D2E] !text-white'
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DUE_PERIODS.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              {p.key === 'all' ? 'Any due date' : p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </span>
                    <div className={cn('h-4 w-px bg-[#e5dfc8]', __WEB__ && '!h-6 !bg-[#C3D2C6]')} />
                    {(['manufacturing', 'trading'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setLcPurposeFilter(lcPurposeFilter === p ? null : p)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide capitalize transition-colors',
                          lcPurposeFilter === p ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50',
                          __WEB__ && '!h-[38px] !rounded-[4px] !px-3.5 !text-[12px] !font-extrabold !tracking-[.04em]',
                          __WEB__ &&
                            (lcPurposeFilter === p
                              ? '!border-[#0B3D2E] !bg-[#0B3D2E] !text-white'
                              : '!border-[#C3D2C6] !bg-white !text-[#33473E] hover:!bg-[#F7FAF6]')
                        )}
                      >
                        {p}
                        {__WEB__ && <ChipCount n={lcChipCounts[p]} on={lcPurposeFilter === p} />}
                      </button>
                    ))}
                    <div className={cn('h-4 w-px bg-[#e5dfc8]', __WEB__ && '!h-6 !bg-[#C3D2C6]')} />
                    {(
                      [
                        // Named for what it now shows — a chip labelled "All" that
                        // hides the matured and repaid ones would misread.
                        { key: 'all', label: 'Running' },
                        { key: 'matured', label: 'Matured' },
                        { key: 'repaid', label: 'Repaid' }
                      ] as const
                    ).map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          setLcStatusFilter(p.key)
                          // Switching to Repaid would otherwise leave a due-period
                          // chip selected but dead, and the list empty for no
                          // visible reason.
                          if (p.key === 'repaid') setLcDuePeriod('all')
                        }}
                        className={cn(
                          'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                          lcStatusFilter === p.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50',
                          __WEB__ && '!h-[38px] !rounded-[4px] !px-3.5 !text-[12px] !font-extrabold !tracking-[.04em]',
                          __WEB__ &&
                            (lcStatusFilter === p.key
                              ? '!border-[#0B3D2E] !bg-[#0B3D2E] !text-white'
                              : '!border-[#C3D2C6] !bg-white !text-[#33473E] hover:!bg-[#F7FAF6]')
                        )}
                      >
                        {p.label}
                        {__WEB__ && <ChipCount n={lcChipCounts[p.key]} on={lcStatusFilter === p.key} />}
                      </button>
                    ))}
                    <div className={cn('ml-auto flex gap-1 rounded-md border border-[#d9d2b8] bg-white p-0.5', __WEB__ && '!gap-[3px] !rounded-[4px] !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]')}>
                      <Button
                        size="icon"
                        variant={lcView === 'cards' ? 'default' : 'ghost'}
                        className={cn('h-7 w-7', __WEB__ && '!h-8 !w-8 !rounded-[2px]', __WEB__ && (lcView === 'cards' ? '!bg-[#0B3D2E] !text-white' : '!bg-transparent !text-[#5A6B62] hover:!bg-white/70'))}
                        title="Card view"
                        onClick={() => setLcView('cards')}
                      >
                        <LayoutGrid className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} />
                      </Button>
                      <Button
                        size="icon"
                        variant={lcView === 'table' ? 'default' : 'ghost'}
                        className={cn('h-7 w-7', __WEB__ && '!h-8 !w-8 !rounded-[2px]', __WEB__ && (lcView === 'table' ? '!bg-[#0B3D2E] !text-white' : '!bg-transparent !text-[#5A6B62] hover:!bg-white/70'))}
                        title="Table view"
                        onClick={() => setLcView('table')}
                      >
                        <List className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} />
                      </Button>
                    </div>
                </>
              )}
            </div>
          )}

          <TabsContent value="tracker" className="mt-4">
            <div className={cn('rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-t-md bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2 text-white shadow-sm',
                  __WEB__ && '!gap-2.5 !rounded-none !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !bg-none !px-4 !py-3 !text-[#0A1F17] !shadow-none'
                )}
              >
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-white/15', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9]')}>
                  <CalendarClock className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} />
                </span>
                <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>Payment Tracker</span>
                <span className={cn('text-[11px] text-white/60', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>every LC bill and discounted bill, one due-date list</span>
                {/* How much is actually owed on this list. It is a due-date
                    list of money and the only way to know the size of it was
                    to add the rows up. Overdue is broken out because that is
                    the half somebody has to act on today. */}
                {__WEB__ && (() => {
                  const live = tracker.filter((x) => !x.settled)
                  if (live.length === 0) return null
                  const due = live.reduce((a, x) => a + n(x.amount), 0)
                  const late = live.filter((x) => x.overdue)
                  const lateSum = late.reduce((a, x) => a + n(x.amount), 0)
                  return (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="rounded-[3px] border border-[#C3D2C6] bg-white px-2.5 py-1.5 text-[12px] font-bold tabular-nums text-[#0A1F17]">
                        {live.length} outstanding · {formatINR(due)}
                      </span>
                      {late.length > 0 && (
                        <span className="rounded-[3px] border border-[#F0D6D4] bg-[#FDF3F2] px-2.5 py-1.5 text-[12px] font-bold tabular-nums text-[#B3261E]">
                          {late.length} overdue · {formatINR(lateSum)}
                        </span>
                      )}
                    </span>
                  )
                })()}
                <label className={cn('ml-auto flex cursor-pointer items-center gap-1.5 text-[11px]', __WEB__ && '!gap-2 !rounded-[3px] !border !border-[#C3D2C6] !bg-white !px-3 !py-2 !text-[12px] !font-bold !text-[#33473E]')}>
                  <input type="checkbox" className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !accent-[#0B3D2E]')} checked={trackerShowSettled} onChange={(e) => setTrackerShowSettled(e.target.checked)} />
                  Show settled
                </label>
              </div>
              <div className={cn(__WEB__ && 'overflow-x-auto')}>
              <Table className={cn('text-[13px]', __WEB__ && '!min-w-[900px]')}>
                <TableHeader>
                  <TableRow className={cn('bg-[#f1ecd9] hover:bg-[#f1ecd9]', TRACKER_HEAD)}>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Kind</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Reference · party</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Amount</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Due</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const rows = tracker.filter((x) => trackerShowSettled || !x.settled)
                    if (rows.length === 0) {
                      return (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                            Nothing outstanding under LC or bill discounting.
                          </TableCell>
                        </TableRow>
                      )
                    }
                    return rows.map((r) => (
                      <TableRow
                        key={`${r.kind}-${r.ref}-${r.due_date}-${r.amount}`}
                        className={cn(
                          'border-b border-dotted border-[#e5dfc8]',
                          // A due-date list wants its state on the left edge:
                          // overdue in red, settled in green, the rest neutral.
                          // Scanning a Status column at the far right of the
                          // row was the only way to find the late ones.
                          __WEB__ && '!border-b-[#EAF0E9] !border-solid !border-l-[3px] hover:!bg-[#F7FAF6] [&>td]:!py-2.5',
                          __WEB__ && (r.settled ? '!border-l-[#12855A]' : r.overdue ? '!border-l-[#B3261E] !bg-[#FDF3F2]' : '!border-l-[#C2700A]')
                        )}
                      >
                        <TableCell>
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                              r.kind === 'lc_bill' ? 'bg-sky-100 text-sky-800' : 'bg-indigo-100 text-indigo-800',
                              __WEB__ && '!whitespace-nowrap !rounded-[2px] !px-2 !py-1 !text-[10px] !font-extrabold !tracking-[.06em]',
                              __WEB__ && (r.kind === 'lc_bill' ? '!bg-[#EAF0E9] !text-[#33473E]' : '!bg-[#EAF6EC] !text-[#0B6B45]')
                            )}
                          >
                            {r.kind_label}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className={cn('font-semibold', __WEB__ && '!text-[13px] !font-bold !text-[#0A1F17]')}>{r.ref} {r.party ? `· ${r.party}` : ''}</div>
                          {r.detail && <div className={cn('text-[11px] text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#5A6B62]')}>{r.detail}</div>}
                        </TableCell>
                        <TableCell className={cn('text-right font-medium tabular-nums', __WEB__ && '!whitespace-nowrap !text-[13.5px] !font-bold')}>{formatINR(r.amount)}</TableCell>
                        <TableCell>
                          <div className={cn('tabular-nums', __WEB__ && '!whitespace-nowrap !text-[13px] !font-bold')}>{r.due_date ? formatDate(r.due_date) : '—'}</div>
                          {!r.settled && r.days_left != null && (
                            <div
                              className={cn(
                                'text-[10px]',
                                r.overdue ? 'font-semibold text-red-600' : 'text-muted-foreground',
                                __WEB__ && '!mt-0.5 !text-[11px] !font-bold',
                                __WEB__ && (r.overdue ? '!text-[#B3261E]' : '!text-[#5A6B62]')
                              )}
                            >
                              {r.overdue ? `${Math.abs(r.days_left)}D overdue` : `${r.days_left}D left`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={r.settled ? 'success' : r.overdue ? 'destructive' : 'warning'}
                            className={cn(
                              'uppercase',
                              __WEB__ && '!whitespace-nowrap !rounded-[2px] !border !px-2 !py-1 !text-[10px] !font-extrabold !tracking-[.06em]',
                              __WEB__ &&
                                (r.settled
                                  ? '!border-[#BFE3CB] !bg-[#EAF6EC] !text-[#0B6B45]'
                                  : r.overdue
                                    ? '!border-[#F0D6D4] !bg-white !text-[#B3261E]'
                                    : '!border-[#F0D9AE] !bg-[#FFFBF2] !text-[#8A5300]')
                            )}
                          >
                            {r.settled ? 'settled' : r.overdue ? 'overdue' : 'outstanding'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  })()}
                </TableBody>
              </Table>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="lc" className="mt-4 space-y-3">
            {lcLimit && (
              <div className={cn('rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-t-md bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2 text-white shadow-sm',
                    __WEB__ &&
                      '!flex-wrap !gap-2.5 !rounded-none !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !bg-none !px-4 !py-3 !text-[#0A1F17] !shadow-none'
                  )}
                >
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-white/15', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9]')}>
                    <Landmark className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} />
                  </span>
                  <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>LC Facility Limit</span>
                  {/* Counts only LCs still HOLDING limit — a preclosed one has
                      been wound up and no longer consumes the facility, so it
                      is out of Utilised/Available and out of this count too.
                      That's why this can read lower than the LC count in the
                      page header, which is every LC on record. */}
                  <span
                    className={cn(
                      'rounded-full bg-white/15 px-2.5 py-0.5 text-[13px] font-semibold tabular-nums',
                      __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-2 !py-1 !text-[11px] !font-bold !text-[#33473E]'
                    )}
                    title={
                      `${lcLimit.lc_count} LC${n(lcLimit.lc_count) === 1 ? '' : 's'} still holding limit` +
                      (n(lcs.length) > n(lcLimit.lc_count)
                        ? ` — ${n(lcs.length) - n(lcLimit.lc_count)} preclosed LC${n(lcs.length) - n(lcLimit.lc_count) === 1 ? '' : 's'} excluded, since a wound-up LC no longer uses the facility`
                        : '')
                    }
                  >
                    {lcKpiFrom || lcKpiTo
                      ? `${lcLimit.period_lc_count} of ${lcLimit.lc_count} holding limit`
                      : `${lcLimit.lc_count} holding limit`}
                  </span>
                  <PeriodPicker
                    from={lcKpiFrom}
                    to={lcKpiTo}
                    onChange={(f, t) => { setLcKpiFrom(f); setLcKpiTo(t) }}
                    className={cn(
                      'ml-auto h-7 border-white/30 bg-white/10 px-2 text-[11px] text-white hover:bg-white/20 hover:text-white',
                      __WEB__ && '!h-[34px] !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6] hover:!text-[#0A1F17]'
                    )}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      'h-7 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white',
                      __WEB__ && '!h-[34px] !gap-1.5 !rounded-[3px] !border-[#0B3D2E] !bg-white !px-3 !text-[12px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#EAF0E9] hover:!text-[#0B3D2E]'
                    )}
                    onClick={openLcLimit}
                  >
                    {__WEB__ && <SlidersHorizontal className="h-4 w-4" />}
                    Edit limit
                  </Button>
                </div>
                {/* The wide Utilised/Available strip is gone — the figure it
                    made large is a KPI in the row below now, beside the limit
                    it is measured against, which is where it is read.

                    What is NOT dropped with it: a facility drawn past its own
                    limit. The Available tile says so by going red and
                    negative, and this line says it in words, because "there is
                    no room to open another LC" is not something to leave to a
                    minus sign. Only when actually over — the 90%-drawn nudge
                    went with the strip. */}
                {__WEB__ && (() => {
                  const over = n(lcLimit.available) < 0
                  const ranged = !!(lcLimit.period_from || lcLimit.period_to)
                  if (!over && !ranged && !lcStageFilter) return null
                  return (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-t-[#E4ECE3] px-4 py-2.5">
                      {over && (
                        <span className="flex items-center gap-2">
                          <AlertTriangle className="h-[17px] w-[17px] shrink-0 text-[#B3261E]" />
                          <span className="text-[12px] font-bold text-[#8C2F26]">
                            Over the facility by {formatINR(Math.abs(n(lcLimit.available)))} — no headroom left.
                          </span>
                        </span>
                      )}
                      {ranged && (
                        <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                          LCs opened {formatDate(lcLimit.period_from)} to {formatDate(lcLimit.period_to)}
                        </span>
                      )}
                      {lcStageFilter && (
                        <button
                          type="button"
                          onClick={() => setLcStageFilter(null)}
                          className="ml-auto h-9 shrink-0 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-extrabold uppercase tracking-[.04em] text-[#33473E] transition-colors hover:bg-[#F7FAF6]"
                        >
                          Clear stage filter
                        </button>
                      )}
                    </div>
                  )
                })()}
                <div
                  className={cn(
                    'grid grid-cols-2 gap-px bg-[#e5dfc8] p-px sm:grid-cols-3 lg:grid-cols-7',
                    __WEB__ && '!gap-px !border-t !border-t-[#E4ECE3] !bg-[#E4ECE3] !p-0'
                  )}
                >
                  <div className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', LIMIT_CELL)}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', LIMIT_K)}>Fixed</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-[#1a2c56]', LIMIT_V)}>{formatINR(lcLimit.fixed_limit)}</div>
                  </div>
                  <div className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', LIMIT_CELL)}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', LIMIT_K)}>
                      Convertible {!lcLimit.convertible_enabled && <span className="text-muted-foreground/60">(off)</span>}
                    </div>
                    <div className={cn('text-[15px] font-bold tabular-nums', lcLimit.convertible_enabled ? 'text-[#1a2c56]' : 'text-muted-foreground/50 line-through', LIMIT_V, !lcLimit.convertible_enabled && __WEB__ && '!text-[#8FA79B]')}>
                      {formatINR(lcLimit.convertible_limit)}
                    </div>
                  </div>
                  <div className={cn('bg-[#1a2c56] px-3 py-2.5 text-center', LIMIT_CELL, __WEB__ && '!bg-[#0B3D2E]')}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-white/70', LIMIT_K, __WEB__ && '!text-[#8FBFA8]')}>Total LC Limit</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-white', LIMIT_V, __WEB__ && '!text-[#C7F03F]')}>{formatINR(lcLimit.total_limit)}</div>
                  </div>
                  {/* The one figure that decides whether another LC can be
                      opened at all, next to the limit it comes out of. Red and
                      negative when the facility is already over-drawn. */}
                  {(() => {
                    const avail = n(lcLimit.available)
                    const over = avail < 0
                    return (
                      <div
                        className={cn(
                          'bg-[#fffdf4] px-3 py-2.5 text-center',
                          LIMIT_CELL,
                          __WEB__ && (over ? '!bg-[#FDF3F2]' : '!bg-[#F4FBF6]')
                        )}
                      >
                        <div
                          className={cn(
                            'text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                            LIMIT_K,
                            __WEB__ && (over ? '!text-[#8C2F26]' : '!text-[#0B6B45]')
                          )}
                        >
                          Available
                        </div>
                        <div
                          className={cn(
                            'text-[15px] font-bold tabular-nums text-[#1a2c56]',
                            LIMIT_V,
                            __WEB__ && (over ? '!text-[#B3261E]' : '!text-[#0B6B45]')
                          )}
                        >
                          {formatINR(avail)}
                        </div>
                      </div>
                    )
                  })()}
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'application' ? null : 'application')}
                    title="Click to filter the list below to Application-stage LCs"
                    className={cn(
                      'bg-amber-50 px-3 py-2.5 text-center transition-colors hover:bg-amber-100',
                      lcStageFilter === 'application' && 'ring-2 ring-inset ring-amber-600',
                      LIMIT_CELL,
                      __WEB__ && '!bg-[#FFFBF2] hover:!bg-[#FFEDD0]',
                      __WEB__ && lcStageFilter === 'application' && '!ring-2 !ring-inset !ring-[#C2700A]'
                    )}
                  >
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-800', LIMIT_K, __WEB__ && '!text-[#8A5300]')}>Application</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-amber-900', LIMIT_V, __WEB__ && '!text-[#8A5300]')}>{formatINR(lcLimit.application)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'open' ? null : 'open')}
                    title="Click to filter the list below to Open-stage LCs"
                    className={cn(
                      'bg-sky-50 px-3 py-2.5 text-center transition-colors hover:bg-sky-100',
                      lcStageFilter === 'open' && 'ring-2 ring-inset ring-sky-600',
                      LIMIT_CELL,
                      __WEB__ && '!bg-[#F1F5EF] hover:!bg-[#EAF0E9]',
                      __WEB__ && lcStageFilter === 'open' && '!ring-2 !ring-inset !ring-[#0B3D2E]'
                    )}
                  >
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-sky-800', LIMIT_K, __WEB__ && '!text-[#33473E]')}>Open</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-sky-900', LIMIT_V, __WEB__ && '!text-[#0A1F17]')}>{formatINR(lcLimit.open)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'payment_received' ? null : 'payment_received')}
                    title="Click to filter the list below to Payment received-stage LCs"
                    className={cn(
                      'bg-emerald-50 px-3 py-2.5 text-center transition-colors hover:bg-emerald-100',
                      lcStageFilter === 'payment_received' && 'ring-2 ring-inset ring-emerald-600',
                      LIMIT_CELL,
                      __WEB__ && '!bg-[#F4FBF6] hover:!bg-[#EAF6EC]',
                      __WEB__ && lcStageFilter === 'payment_received' && '!ring-2 !ring-inset !ring-[#12855A]'
                    )}
                  >
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-emerald-800', LIMIT_K, __WEB__ && '!text-[#0B6B45]')}>Payment received</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-emerald-900', LIMIT_V, __WEB__ && '!text-[#0B6B45]')}>{formatINR(lcLimit.payment_received)}</div>
                  </button>
                </div>
                <div className={cn('flex items-center justify-between gap-3 border-t border-dashed border-[#e5dfc8] px-4 py-2.5', __WEB__ && '!hidden')}>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Utilised {formatINR(lcLimit.utilized)} of {formatINR(lcLimit.total_limit)}
                    {(lcLimit.period_from || lcLimit.period_to) && (
                      <span className="ml-1 font-normal text-muted-foreground/70">
                        — LCs opened {formatDate(lcLimit.period_from)} to {formatDate(lcLimit.period_to)}
                      </span>
                    )}
                  </span>
                  {lcStageFilter && (
                    <button
                      type="button"
                      onClick={() => setLcStageFilter(null)}
                      className="rounded-full border border-[#d9d2b8] bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#1a2c56] hover:bg-amber-50"
                    >
                      Clear stage filter
                    </button>
                  )}
                  <span className={cn('text-[15px] font-bold tabular-nums', n(lcLimit.available) < 0 ? 'text-rose-600' : 'text-emerald-700')}>
                    Available {formatINR(lcLimit.available)}
                  </span>
                </div>
              </div>
            )}

            {lcView === 'cards' ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Card className={cn('flex items-center justify-center border-dashed p-6', __WEB__ && '!rounded-[4px] !border-[#A9BFB2] !bg-white !shadow-none')}>
                  <Button
                    className={cn(
                      'bg-[#1a2c56] hover:bg-[#24407e]',
                      __WEB__ && '!h-12 !gap-2.5 !rounded-[4px] !bg-[#0B3D2E] !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] hover:!bg-[#0F4A38]'
                    )}
                    onClick={() => setLcForm({ open_date: todayISO(), usance_days: '', margin_pct: '', interest_pct: '', charges: '', purpose: 'manufacturing', workflow_status: 'in_progress', stage: 'application', our_bank_id: activeBank || '' })}
                  >
                    <Plus className="h-4 w-4" /> Open new LC
                  </Button>
                </Card>
                {lcsFiltered.length === 0 ? (
                  <Card className={cn('p-6 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-2', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white !text-[13px] !font-semibold !text-[#5A6B62] !shadow-none')}>Nothing in this due-period bucket.</Card>
                ) : (
                  lcsFiltered.map((l) => {
                    const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                    const barTone = __WEB__
                      ? pct >= 95
                        ? 'bg-[#B3261E]'
                        : pct >= 75
                          ? 'bg-[#C2700A]'
                          : 'bg-[#0B3D2E]'
                      : pct >= 95
                        ? 'bg-rose-500'
                        : pct >= 75
                          ? 'bg-amber-500'
                          : 'bg-sky-600'
                    const tone = STAGE_ROW_TONE[String(l.stage || 'application')] || STAGE_ROW_TONE.application
                    return (
                      <Card
                        key={String(l.id)}
                        className={cn(
                          'flex flex-col gap-3 overflow-hidden border-l-4 p-0 [border-left-style:solid]',
                          tone.row,
                          __WEB__ && '!gap-0 !rounded-[4px] !border-[#D6E2D6] !border-l-[4px] !bg-white !shadow-none',
                          __WEB__ && (STAGE_MARK_WEB[String(l.stage || 'application')] || STAGE_MARK_WEB.application)
                        )}
                      >
                        <div className={cn('flex flex-col gap-3 p-4 pb-0', __WEB__ && '!gap-3 !p-4')}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className={cn('doc-ref text-[15px] font-bold', !l.lc_no && 'italic text-muted-foreground')}>{l.lc_no || 'Pending LC no'}</span>
                                <DuplicateNoBadge lcs={lcs} l={l} />
                                {currentStageBadge(l)}
                                <ClosureBadge l={l} withDate />
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <Landmark className="h-3 w-3 shrink-0" /> {l.bank}
                                <span className="text-[#e5dfc8]">·</span>
                                <Users className="h-3 w-3 shrink-0" /> {l.supplier_name || '—'}
                              </div>
                              {l.fd_no && <div className="mt-0.5 text-[10px] text-muted-foreground">FD {l.fd_no}</div>}
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              {l.purpose && <Badge variant="muted" className="capitalize">{l.purpose}</Badge>}
                              {l.display_status === 'non_compliant' ? (
                                <Badge variant="destructive">Non-compliant</Badge>
                              ) : (
                                <Badge variant={l.display_status === 'on_hold' ? 'warning' : 'success'} className="capitalize">
                                  {String(l.display_status || 'in_progress').replace('_', ' ')}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <div className={cn('rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm', __WEB__ && '!rounded-[4px] !bg-[#0B3D2E] !bg-none !px-4 !py-3.5 !text-left !shadow-none')}>
                            <div className={cn('text-[10px] font-semibold uppercase tracking-widest text-white/60', __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.13em] !text-[#8FBFA8]')}>LC amount</div>
                            <div className={cn('text-2xl font-bold tabular-nums text-white', __WEB__ && '!mt-1 !text-[23px] !leading-none !tracking-[-0.035em]')}>{formatINR(l.amount)}</div>
                          </div>
                          {/* Four figures on the app's own colours, and every
                              label small caps over the money so the pairs read
                              alike. Available and Outstanding only take a tint
                              when there is something to say — a zero balance
                              tinted green claims a state it has not reached. */}
                          <div className={cn('grid grid-cols-2 gap-2 text-[11px]', __WEB__ && CARD_CELLS)}>
                            <div className={cn('rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5', __WEB__ && '!border-[#E4ECE3] !bg-[#F7FAF6]')}>
                              <div className="text-muted-foreground">Utilised</div>
                              <div className={cn('font-semibold tabular-nums text-[#1a2c56]', __WEB__ && '!text-[#0A1F17]')}>{formatINR(l.utilized)}</div>
                            </div>
                            <div
                              className={cn(
                                'rounded-md border px-2.5 py-1.5',
                                n(l.available) <= 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50',
                                __WEB__ && (n(l.available) <= 0 ? '!border-[#F0D6D4] !bg-[#FDF3F2]' : '!border-[#BFE3CB] !bg-[#F4FBF6]')
                              )}
                            >
                              <div className="text-muted-foreground">Available</div>
                              <div className={cn('font-semibold tabular-nums', n(l.available) <= 0 ? 'text-rose-600' : 'text-emerald-700', __WEB__ && (n(l.available) <= 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]'))}>{formatINR(l.available)}</div>
                            </div>
                            <div
                              className={cn(
                                'rounded-md border px-2.5 py-1.5',
                                n(l.repaid) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-[#e5dfc8] bg-white',
                                __WEB__ && (n(l.repaid) > 0 ? '!border-[#BFE3CB] !bg-[#F4FBF6]' : '!border-[#E4ECE3] !bg-[#F7FAF6]')
                              )}
                            >
                              <div className="text-muted-foreground">Repaid</div>
                              <div className={cn('font-semibold tabular-nums', n(l.repaid) > 0 ? 'text-emerald-700' : 'text-[#1a2c56]', __WEB__ && (n(l.repaid) > 0 ? '!text-[#0B6B45]' : '!text-[#8FA79B]'))}>{formatINR(l.repaid)}</div>
                            </div>
                            <div
                              className={cn(
                                'rounded-md border px-2.5 py-1.5',
                                n(l.outstanding) > 0 ? 'border-amber-200 bg-amber-50' : 'border-[#e5dfc8] bg-white',
                                __WEB__ && (n(l.outstanding) > 0 ? '!border-[#F0D9AE] !bg-[#FFFBF2]' : '!border-[#E4ECE3] !bg-[#F7FAF6]')
                              )}
                            >
                              <div className="text-muted-foreground">Outstanding</div>
                              <div className={cn('font-semibold tabular-nums', n(l.outstanding) > 0 ? 'text-amber-800' : 'text-[#1a2c56]', __WEB__ && (n(l.outstanding) > 0 ? '!text-[#8A5300]' : '!text-[#8FA79B]'))}>{formatINR(l.outstanding)}</div>
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              <span>Utilisation</span>
                              <span className="tabular-nums">{pct.toFixed(0)}%</span>
                            </div>
                            <div className={cn('h-2.5 overflow-hidden rounded-full bg-muted', __WEB__ && '!h-3 !rounded-[2px] !bg-[#EAF0E9]')}>
                              <div className={cn('h-2.5 rounded-full transition-all', barTone, __WEB__ && '!h-full !rounded-none')} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1.5"><CalendarRange className="h-3 w-3 shrink-0" /> {formatDate(l.open_date)} → {formatDate(l.expiry_date)}</span>
                            {/* Repaid means wound up — no live countdown. */}
                            {l.preclosed_date ? (
                              <Badge variant="muted" title={`Repaid ${formatDate(l.preclosed_date)}`}>Repaid</Badge>
                            ) : (
                              <DueBadge date={l.due_date_effective} l={l} />
                            )}
                          </div>
                        </div>
                        <div className={cn('flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] px-4 py-3', __WEB__ && '!mt-auto !gap-2 !border-t-[#EAF0E9] !border-solid !bg-[#F7FAF6] !px-4 !py-3')}>
                          {(() => {
                            const next = nextLcStage(String(l.stage || 'application'))
                            if (!next) return null
                            return (
                              <Button
                                size="sm"
                                className={cn('h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]', __WEB__ && '!h-9 !rounded-[3px] !bg-[#0B3D2E] !px-3 !text-[12px] !font-extrabold !text-[#C7F03F] hover:!bg-[#0F4A38]')}
                                onClick={() => openStageAdvance(l)}
                              >
                                Mark {STAGE_LABEL[next]}
                              </Button>
                            )
                          })()}
                          <Button
                            size="sm"
                            variant="outline"
                            className={cn('h-7 px-2 text-xs', __WEB__ && '!h-9 !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#33473E] hover:!bg-[#EAF0E9]')}
                            onClick={() => void openLcDetail(Number(l.id))}
                          >
                            <ChevronRight className="h-3.5 w-3.5" /> Details
                          </Button>
                          {canMarkPaymentIn(l) && (
                            <Button
                              size="sm"
                              className={cn('h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700', __WEB__ && '!h-9 !rounded-[3px] !bg-[#0B6B45] !px-3 !text-[12px] !font-extrabold hover:!bg-[#0A5D3C]')}
                              title="Record the customer's payment for the resale — independent of whether the bank side has been preclosed yet"
                              onClick={() => void openPaymentIn(l)}
                            >
                              Mark Payment IN
                            </Button>
                          )}
                          {canPreclose(l) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className={cn('h-7 px-2 text-xs', __WEB__ && '!h-9 !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#33473E] hover:!bg-[#EAF0E9]')}
                              title={isLcPastMaturity(l) ? 'Repay this LC now that it has matured' : 'Wind this LC up before its natural maturity'}
                              onClick={() => openPreclose(l)}
                            >
                              {isLcPastMaturity(l) ? 'Repay' : 'Preclose'}
                            </Button>
                          )}
                          <RowActions
                            actions={[
                              { label: 'Edit LC', icon: Pencil, onClick: () => setLcForm({ ...l }) },
                              { label: 'History — who did what', icon: History, onClick: () => void openHistory(l) },
                              {
                                label: 'Delete LC — reverses its vouchers',
                                icon: Trash2,
                                danger: true,
                                onClick: () => requestDeleteLc(l)
                              }
                            ]}
                          />
                        </div>
                      </Card>
                    )
                  })
                )}
              </div>
            ) : (
            <div className={cn('rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-t-md bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2 text-white shadow-sm',
                  __WEB__ && '!flex-wrap !gap-2.5 !rounded-none !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !bg-none !px-4 !py-3 !text-[#0A1F17] !shadow-none'
                )}
              >
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-white/15', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9]')}>
                  <Banknote className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} />
                </span>
                <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>Letters of Credit</span>
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(
                    'ml-auto gap-1.5 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white',
                    __WEB__ && '!h-[34px] !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6] hover:!text-[#0A1F17]'
                  )}
                  disabled={lcExporting || lcsFiltered.length === 0}
                  onClick={() => void downloadLcRegister()}
                >
                  <FileSpreadsheet className="h-4 w-4" /> {lcExporting ? 'Preparing…' : 'Download Excel'}
                </Button>
                {/* The one primary action on this bar — amber against the navy
                    so it reads as the thing to click, rather than blending
                    into a header that is now the same colour it used to be. */}
                <Button
                  size="sm"
                  className={cn(
                    'bg-amber-400 font-semibold text-[#1a2c56] shadow-sm hover:bg-amber-300',
                    __WEB__ && '!h-[34px] !gap-1.5 !rounded-[3px] !bg-[#0B3D2E] !px-3.5 !text-[12px] !font-extrabold !text-[#C7F03F] !shadow-none hover:!bg-[#0F4A38]'
                  )}
                  onClick={() => setLcForm({ open_date: todayISO(), usance_days: '', margin_pct: '', interest_pct: '', charges: '', purpose: 'manufacturing', workflow_status: 'in_progress', stage: 'application', our_bank_id: activeBank || '' })}
                >
                  <Plus className="h-4 w-4" /> Open new LC
                </Button>
              </div>
              <div className="overflow-x-auto">
              <Table className={cn('ruled-cols text-[13px]', __WEB__ && '!min-w-[1340px]')}>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className={cn('border-b-2 border-[#1a2c56]/20 bg-[#dce6f5] hover:bg-[#dce6f5]', LC_HEAD)}>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                      <ColumnFilter label="LC no · bank" options={colOptions.bank} value={lcBankCol} onApply={setLcBankCol} />
                    </TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                      <ColumnFilter label="Supplier" options={colOptions.party} value={lcPartyCol} onApply={setLcPartyCol} />
                    </TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                      {/* By maturity MONTH — a tick list of individual days
                          would be as long as the register itself. */}
                      <ColumnFilter label="Validity" options={colOptions.mat} value={lcMatCol} onApply={setLcMatCol} />
                    </TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Days left</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Int. days</TableHead>
                    <TableHead
                      className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]"
                      title="Interest for the days between preclosure and the LC's original maturity — the stretch that never happened"
                    >
                      Premature int.
                    </TableHead>
                    <TableHead className="h-9 w-[150px] min-w-[150px] whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                      Open amount
                    </TableHead>
                    <TableHead
                      className="h-9 w-[165px] min-w-[165px] whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]"
                      title="What reaches the beneficiary — the open amount less the interest and commission the bank keeps"
                    >
                      {/* Lime, like the balance column on every other register:
                          this is the figure the register exists to report. */}
                      <span className={cn(__WEB__ && '!text-[#C7F03F]')}>Payment rec</span>
                    </TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                      <span className={cn(__WEB__ && '!text-white')}>Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Totals for exactly the rows the filters left, directly under
                      the header so the figure is read before scrolling. Sums the
                      sanctioned Limit and what is still Available across them. */}
                  {lcsFiltered.length > 0 && (
                    <TableRow className={cn('border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50', LC_TOTAL)}>
                      <TableCell className={cn('whitespace-nowrap font-semibold text-amber-900', __WEB__ && '!text-[13px] !font-extrabold !uppercase !tracking-[.06em] !text-[#0A1F17]')}>
                        Total
                        <span className={cn('ml-1.5 font-normal text-amber-800/70', __WEB__ && '!font-semibold !normal-case !tracking-normal !text-[#5A6B62]')}>
                          · {lcsFiltered.length} LC{lcsFiltered.length === 1 ? '' : 's'}
                        </span>
                      </TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell className={cn('whitespace-nowrap text-right font-semibold tabular-nums text-amber-900', __WEB__ && '!text-[15px] !font-bold !text-[#0A1F17]')}>
                        {(() => {
                          const t = lcsFiltered.reduce((a2, l) => a2 + n(l.preclose_premature_interest), 0)
                          return t > 0.004 ? formatINR(t) : ''
                        })()}
                      </TableCell>
                      <TableCell className={cn('whitespace-nowrap text-right font-semibold tabular-nums text-amber-900', __WEB__ && '!text-[15px] !font-bold !text-[#0A1F17]')}>
                        {formatINR(lcsFiltered.reduce((t, l) => t + n(l.amount), 0))}
                      </TableCell>
                      <TableCell className={cn('whitespace-nowrap text-right font-semibold tabular-nums text-amber-900', __WEB__ && '!text-[15px] !font-bold !text-[#0A1F17]')}>
                        {formatINR(lcsFiltered.reduce((t, l) => t + n(l.paid_to_party ?? l.paid_expected), 0))}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                  {lcsFiltered.length === 0 ? (
                    <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No letters of credit in this bucket.</TableCell></TableRow>
                  ) : (
                    lcsFiltered.map((l) => {
                      const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                      const tone = STAGE_ROW_TONE[String(l.stage || 'application')] || STAGE_ROW_TONE.application
                      return (
                        <Fragment key={String(l.id)}>
                          <TableRow
                            className={cn(
                              'cursor-pointer border-b border-dotted border-[#e5dfc8] transition-colors',
                              tone.row,
                              tone.hover,
                              // White row background — the stage-colored left
                              // border alone carries the coding, so text stays
                              // at full contrast instead of sitting on a tint.
                              'bg-white',
                              __WEB__ && '!border-b-[#EAF0E9] !border-solid !border-l-[3px] !bg-white hover:!bg-[#F7FAF6] [&>td]:!py-2.5',
                              __WEB__ && (STAGE_MARK_WEB[String(l.stage || 'application')] || STAGE_MARK_WEB.application)
                            )}
                            onClick={() => void openLcDetail(Number(l.id))}
                          >
                            <TableCell className="whitespace-nowrap">
                              <div className={cn('flex items-center gap-1.5', __WEB__ && '!items-start')}>
                                <ChevronRight
                                  className={cn(
                                    'h-3.5 w-3.5 shrink-0 text-muted-foreground',
                                    __WEB__ && '!mt-[3px] !text-[#A8B8AE]'
                                  )}
                                />
                                {/* Three lines on the website: the number, then
                                    the state, then the bank. Side by side, the
                                    badge pushed the bank down to a second line
                                    anyway and left the state ragged from row to
                                    row — stacked, all three read straight down
                                    their own column. */}
                                <div className={cn(__WEB__ && 'flex flex-col items-start gap-[3px]')}>
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={cn(
                                        'doc-ref font-semibold',
                                        !l.lc_no && 'italic text-muted-foreground',
                                        __WEB__ && '!text-[14px] !font-bold !text-[#0A1F17]'
                                      )}
                                    >
                                      {l.lc_no || 'Pending LC no'}
                                      <DuplicateNoBadge lcs={lcs} l={l} />
                                    </span>
                                    {!__WEB__ && currentStageBadge(l)}
                                    {!__WEB__ && <ClosureBadge l={l} />}
                                  </div>
                                  {__WEB__ && (
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      {currentStageBadge(l)}
                                      <ClosureBadge l={l} />
                                    </div>
                                  )}
                                  <div className={cn('mt-0.5 text-[11px] text-muted-foreground', __WEB__ && '!mt-0 !text-[12.5px] !font-semibold !text-[#5A6B62]')}>
                                    {l.bank}
                                    {/* The margin lives in the expanded panel and
                                        in the Preclose preview. On the website it
                                        came second in a two-line cell that is read
                                        for the LC no and the bank, so it is off
                                        there and untouched in the app. */}
                                    {!__WEB__ && n(l.margin_pct) ? <span className="tabular-nums"> · margin {l.margin_pct}%</span> : ''}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                'whitespace-nowrap',
                                // No truncation: max-width is ignored on cells
                                // in an auto-layout table, and this one is
                                // 1340px wide with its own scroller.
                                __WEB__ && '!text-[14px] !font-bold !text-[#0A1F17]'
                              )}
                              title={String(l.supplier_name || '')}
                            >
                              {l.supplier_name || '—'}
                            </TableCell>
                            <TableCell className={cn('doc-ref whitespace-nowrap py-2', __WEB__ && '!py-2')}>
                              {__WEB__ ? (
                                <ValidityInline l={l} />
                              ) : (
                              <>
                              {/* open_date is the date the LC was APPLIED for;
                                  opened_date is the day the bank actually opened
                                  it. Until that day exists this is an
                                  application and says so — an LC still with the
                                  bank has not been opened, and a row claiming
                                  otherwise reads as a live credit. */}
                              {l.opened_date ? (
                                <DateLine tag="Op" date={l.opened_date} title="Opened by the bank" />
                              ) : (
                                <DateLine
                                  tag="App"
                                  date={l.open_date}
                                  title="Applied for — the bank has not opened it yet"
                                  tone="text-slate-600"
                                />
                              )}
                              {/* Only a PRECLOSED LC never reached its maturity, so
                                  only that case strikes the planned date out. An
                                  LC closed on or after maturity did reach it. */}
                              <DateLine
                                tag="Mat"
                                date={l.expiry_date}
                                title="Maturity"
                                struck={closureKind(l) === 'early'}
                              />
                              {!!l.preclosed_date && (
                                <div
                                  className="mt-0.5 inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-px text-[11px] font-semibold text-violet-800"
                                  title={
                                    closureKind(l) === 'early'
                                      ? `Wound up early on ${formatDate(l.preclosed_date)} — ${formatDateShort(l.expiry_date)} never came`
                                      : closureKind(l) === 'late'
                                        ? `Closed on ${formatDate(l.preclosed_date)}, after its ${formatDateShort(l.expiry_date)} maturity`
                                        : `Closed on maturity, ${formatDate(l.preclosed_date)}`
                                  }
                                >
                                  <span className="text-[9px] uppercase tracking-wide text-violet-700/70">Closed</span>
                                  {formatDateShort(l.preclosed_date)}
                                </div>
                              )}
                              </>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {/* Repaid means wound up — no live countdown. */}
                              {l.preclosed_date ? (
                                <Badge variant="muted" title={`Repaid ${formatDate(l.preclosed_date)}`}>Repaid</Badge>
                              ) : l.expiry_date ? (
                                <DueBadge date={l.expiry_date} l={l} />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'whitespace-nowrap text-right tabular-nums text-muted-foreground',
                                __WEB__ && '!text-[13.5px] !font-semibold !text-[#33473E]'
                              )}
                            >
                              {n(l.usance_days) > 0 ? n(l.usance_days) : '—'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap border-l border-[#1a2c56]/10 text-right tabular-nums">
                              {n(l.preclose_premature_interest) > 0.004 ? (
                                <>
                                  <div className={cn('font-semibold text-violet-800', __WEB__ && '!text-[13.5px] !font-bold')}>{formatINR(l.preclose_premature_interest)}</div>
                                  <div className={cn('text-[10px] uppercase tracking-wide text-muted-foreground', __WEB__ && '!text-[11px]')}>
                                    {String(l.preclose_interest_route || '') === 'pay_to_party' ? 'paid to party' : 'credited to us'}
                                  </div>
                                </>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'whitespace-nowrap text-right font-medium tabular-nums',
                                __WEB__ && '!text-[15px] !font-bold !text-[#0A1F17]'
                              )}
                            >
                              {formatINR(l.amount)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              {/* lc_net_available is the open amount less this
                                  LC's interest and charges — the sum the bank
                                  releases to the beneficiary. Headroom used to
                                  sit here, which says nothing once an LC is
                                  fully drawn, and every one of them is.
                                  The working is one hover away. */}
                              <PayableBreakdown l={l}>
                                {/* The bill the bank honoured, which is what the
                                    supplier's ledger carries. Falls back to the
                                    expectation only while no bill exists. */}
                                <div
                                  className={cn(
                                    'font-semibold tabular-nums underline decoration-dotted underline-offset-4',
                                    __WEB__ && '!text-[15px] !font-bold',
                                    l.paid_to_party == null
                                      ? 'text-muted-foreground decoration-muted-foreground/30'
                                      : 'text-emerald-700 decoration-emerald-700/25'
                                  )}
                                >
                                  {formatINR(l.paid_to_party ?? l.paid_expected)}
                                </div>
                                <div className={cn('text-[10px] tabular-nums text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold')}>
                                  {l.paid_to_party == null
                                    ? 'not drawn yet'
                                    : `after ${formatINR(n(l.amount) - n(l.paid_to_party))} int + chg`}
                                </div>
                              </PayableBreakdown>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex justify-end gap-1">
                                {(() => {
                                  const next = nextLcStage(String(l.stage || 'application'))
                                  if (!next) return null
                                  return (
                                    <Button
                                      size="sm"
                                      className={cn(
                                        'h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]',
                                        __WEB__ && LC_ACT_GO
                                      )}
                                      onClick={() => openStageAdvance(l)}
                                    >
                                      Mark {STAGE_LABEL[next]}
                                    </Button>
                                  )
                                })()}
                                {canMarkPaymentIn(l) && (
                                  <Button
                                    size="sm"
                                    className={cn(
                                      'h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700',
                                      __WEB__ && cn(LC_ACT_GO, '!bg-[#12855A] hover:!bg-[#0F7350]')
                                    )}
                                    title="Record the customer's payment for the resale — independent of whether the bank side has been preclosed yet"
                                    onClick={() => void openPaymentIn(l)}
                                  >
                                    Mark Payment IN
                                  </Button>
                                )}
                                {canPreclose(l) && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className={cn('h-7 px-2 text-xs', __WEB__ && LC_ACT_2ND)}
                                    title={isLcPastMaturity(l) ? 'Repay this LC now that it has matured' : 'Wind this LC up before its natural maturity'}
                                    onClick={() => openPreclose(l)}
                                  >
                                    {isLcPastMaturity(l) ? 'Repay' : 'Preclose'}
                                  </Button>
                                )}
                                <RowActions
                                  actions={[
                                    ...(l.preclosed_date
                                      ? [
                                          {
                                            label: 'Undo preclosure — put this LC back',
                                            icon: RotateCcw,
                                            onClick: () => setUnpreRow(l)
                                          }
                                        ]
                                      : []),
                                    { label: 'Edit LC', icon: Pencil, onClick: () => setLcForm({ ...l }) },
                                    { label: 'History — who did what', icon: History, onClick: () => void openHistory(l) },
                                    {
                                      label: 'Delete LC — reverses its vouchers',
                                      icon: Trash2,
                                      danger: true,
                                      onClick: () => requestDeleteLc(l)
                                    }
                                  ]}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        </Fragment>
                      )
                    })
                  )}
                </TableBody>
              </Table>
              </div>
            </div>
            )}
          </TabsContent>

          <TabsContent value="bd" className="mt-4">
            <BillDiscounting
              companies={companies}
              activeCompany={activeCompany}
              onCompanyChange={onCompanyChange}
              nbfcFilter={activeNbfc}
              onNbfcsLoaded={setNbfcs}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Delete an LC — typing back a random 4-digit code guards against an
          accidental click, since this reverses every voucher the LC posted */}
      <Dialog open={!!lcDeleteTarget} onOpenChange={(o) => !o && setLcDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Delete LC {lcDeleteTarget?.lc_no || '(pending no.)'}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2.5 text-[12px] text-rose-900">
              This reverses everything this LC has posted to the ledgers — its opening voucher and every bill's settlement — and cannot be undone.
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>To confirm, type the code shown below</Label>
              <div className="flex items-center justify-center rounded-md border border-dashed border-muted-foreground/40 bg-muted/40 py-3 text-2xl font-bold tracking-[0.5em] tabular-nums">
                {lcDeleteCode}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Code</Label>
              <Input
                value={lcDeleteInput}
                onChange={(e) => setLcDeleteInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                maxLength={4}
                inputMode="numeric"
                className="text-center text-lg tracking-[0.5em]"
                placeholder="0000"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLcDeleteTarget(null)} disabled={lcDeleting}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteLc()}
              disabled={lcDeleting || lcDeleteInput.trim() !== lcDeleteCode}
            >
              {lcDeleting ? 'Deleting…' : 'Delete LC'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit the overall LC facility limit — Fixed + optional Convertible */}
      {/* Alert detail — every row behind the chip that was clicked. The chips
          used to expand inline and show only the first four, so a chip reading
          "6" listed 4 and silently dropped the rest. */}
      {(() => {
        const grp = alertItems.find((a) => a.key === expandedAlert)
        return (
          <Dialog open={!!grp} onOpenChange={(o) => !o && setExpandedAlert(null)}>
            <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-4xl min-w-0 overflow-y-auto">
              {grp && (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                      <grp.icon className="h-4 w-4 shrink-0" />
                      <span className="uppercase tracking-wide">{grp.label}</span>
                      <Badge variant="muted" className="tabular-nums">{grp.rows.length}</Badge>
                    </DialogTitle>
                  </DialogHeader>
                  <p className={cn('rounded-lg border px-3 py-2 text-[12px]', grp.tone)}>{grp.blurb}</p>
                  <div className="min-w-0 overflow-x-auto rounded-lg border">
                    <table className="w-full whitespace-nowrap text-[13px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
                      <thead>
                        <tr className="border-b bg-[#1a2c56] text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                          {grp.headers.map((h, i) => (
                            <th key={h} className={cn(grp.aligns[i] === 'right' && 'text-right')}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {grp.rows.map((r, ri) => (
                          <tr
                            key={ri}
                            className={cn(
                              'border-b last:border-0',
                              r.danger ? 'bg-red-50/70' : ri % 2 === 1 ? 'bg-muted/25' : ''
                            )}
                          >
                            {r.cells.map((c, ci) => (
                              <td
                                key={ci}
                                className={cn(
                                  grp.aligns[ci] === 'right' && 'text-right tabular-nums',
                                  ci === 0 && 'font-semibold',
                                  // The days column is the one to react to.
                                  grp.headers[ci] === 'Days' && r.danger && 'font-semibold text-red-600'
                                )}
                              >
                                {c}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setExpandedAlert(null)}>Close</Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        )
      })()}

      <Dialog open={lcLimitOpen} onOpenChange={(o) => !o && setLcLimitOpen(false)}>
        <DialogContent
          className={cn(
            'max-w-md',
            __WEB__ &&
              '!max-w-lg !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-90'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Treasury</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>LC facility limit</DialogTitle>
            {__WEB__ && (
              <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
                What the bank has sanctioned. Every LC opened draws against it.
              </p>
            )}
          </DialogHeader>
          <div
            className={cn(
              'grid gap-3',
              // One copy of the field sizing, in LC_FIELDS. These two screens
              // each had their own and so missed every change made to it.
              __WEB__ && cn(LC_BODY, LC_FIELDS, '[&_input]:!tabular-nums')
            )}
          >
            {/* The limit is sanctioned against one of OUR accounts, so it is
                always saved against a bank rather than the company as a whole. */}
            <div className="grid gap-1.5">
              <Label>My bank <span className="text-red-600">*</span></Label>
              <Select
                value={String(lcLimitForm.bank_id ?? '')}
                onValueChange={(v) => setLcLimitForm((p) => ({ ...p, bank_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Which bank sanctioned this limit" /></SelectTrigger>
                <SelectContent>
                  {banks.map((b) => <SelectItem key={String(b.id)} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Fixed limit (₹) *</Label>
              <Input type="number" value={lcLimitForm.fixed_limit ?? ''} onChange={(e) => setLcLimitForm({ ...lcLimitForm, fixed_limit: e.target.value })} />
            </div>
            {/* The switch and the field it governs, in one box. They were two
                separate rows, so a disabled amount box sat under a switch that
                had nothing visibly to do with it — and the box turns green
                when the limit is live, which is the state the total depends on. */}
            <div
              className={cn(
                'flex items-center justify-between rounded-md border px-3 py-2',
                __WEB__ && '!flex-col !items-stretch !gap-3 !rounded-[4px] !p-4',
                __WEB__ && (lcLimitForm.convertible_enabled ? '!border-[#BFE3CB] !bg-[#F4FBF6]' : '!border-[#D6E2D6] !bg-white')
              )}
            >
              <div className={cn(__WEB__ && '!flex !items-start !justify-between !gap-3')}>
                <div className="min-w-0">
                  <Label className={cn(__WEB__ && '!text-[11px] !font-extrabold !normal-case !tracking-normal !text-[#0A1F17]')}>Convertible limit</Label>
                  <p className={cn('text-[10px] text-muted-foreground', __WEB__ && '!mt-1 !text-[11.5px] !font-semibold !leading-relaxed !text-[#5A6B62]')}>When on, this adds to the Fixed limit to make the total.</p>
                </div>
                <Switch
                  checked={!!lcLimitForm.convertible_enabled}
                  onCheckedChange={(v) => setLcLimitForm({ ...lcLimitForm, convertible_enabled: v })}
                />
              </div>
              <div className={cn('grid gap-1.5', !__WEB__ && 'hidden')}>
                <Label>Convertible limit (₹)</Label>
                <Input
                  type="number"
                  disabled={!lcLimitForm.convertible_enabled}
                  value={lcLimitForm.convertible_limit ?? ''}
                  onChange={(e) => setLcLimitForm({ ...lcLimitForm, convertible_limit: e.target.value })}
                  className={cn(__WEB__ && !lcLimitForm.convertible_enabled && '!bg-[#F1F5EF] !text-[#8FA79B]')}
                />
              </div>
            </div>
            <div className={cn('grid gap-1.5', __WEB__ && '!hidden')}>
              <Label>Convertible limit (₹)</Label>
              <Input
                type="number"
                disabled={!lcLimitForm.convertible_enabled}
                value={lcLimitForm.convertible_limit ?? ''}
                onChange={(e) => setLcLimitForm({ ...lcLimitForm, convertible_limit: e.target.value })}
              />
            </div>
            {/* The sum the two fields above make, said in the forest the
                facility card uses for the same figure — this is what the
                register will measure every LC against. */}
            <div className={cn('flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2', __WEB__ && '!flex-wrap !gap-2.5 !rounded-[4px] !border-0 !bg-[#0B3D2E] !px-4 !py-3.5')}>
              <span className={cn('text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.13em] !text-[#8FBFA8]')}>Total LC limit</span>
              <span className={cn('text-[15px] font-bold tabular-nums', __WEB__ && '!ml-auto !whitespace-nowrap !text-[21px] !tracking-[-0.035em] !text-[#C7F03F]')}>
                {formatINR(n(lcLimitForm.fixed_limit) + (lcLimitForm.convertible_enabled ? n(lcLimitForm.convertible_limit) : 0))}
              </span>
            </div>
          </div>
          <DialogFooter className={cn(__WEB__ && '!border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5')}>
            <Button
              variant="outline"
              onClick={() => setLcLimitOpen(false)}
              disabled={lcLimitSaving}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveLcLimitForm()}
              disabled={lcLimitSaving}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !bg-[#0B3D2E] !px-7 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]')}
            >
              {lcLimitSaving ? 'Saving…' : 'Save limit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preclose an LC — wind it up before its natural maturity */}
      <Dialog open={!!precloseRow} onOpenChange={(o) => !o && setPrecloseRow(null)}>
        <DialogContent
          className={cn(
            'max-w-3xl max-h-[88vh] overflow-y-auto p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100',
            LC_DRAWER
          )}
        >
          <div
            className={cn(
              'flex items-center gap-3 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white',
              __WEB__ && '!bg-[#0B3D2E] !bg-none !px-5 !py-4'
            )}
          >
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15', __WEB__ && '!rounded-[4px]')}>
              <Landmark className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              {/* Winding an LC up early and repaying a matured one are two
                  different acts on one screen, so the eyebrow says which. */}
              {__WEB__ && (
                <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                  {precloseRow && isLcPastMaturity(precloseRow) ? 'Repayment' : 'Premature closure'}
                </div>
              )}
              <DialogTitle className={cn('text-[16px] font-bold text-white', __WEB__ && '!mt-1 !text-[19px] !tracking-[-0.02em]')}>
                {precloseRow && isLcPastMaturity(precloseRow) ? 'Repay' : 'Preclose'} LC {precloseRow?.lc_no || '(pending no.)'}
              </DialogTitle>
              <p className={cn('text-[12px] text-white/70', __WEB__ && '!mt-1 !text-[12px] !font-semibold !text-[#8FBFA8]')}>
                {precloseRow && isLcPastMaturity(precloseRow)
                  ? 'Repay this LC now that it has matured.'
                  : "Wind this LC up before its natural maturity."}
              </p>
            </div>
          </div>
          <div className={cn('grid gap-4 p-6', __WEB__ && '!min-h-0 !content-start !gap-3.5 !overflow-y-auto !p-4')}>
            <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
              <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><CalendarClock className="h-3 w-3 text-[#1a2c56]" /></span>
                Pre-closure date
              </h3>
              <div className={cn('grid gap-1.5 sm:max-w-xs', __WEB__ && '!p-4')}>
                <Label>Date <span className="text-red-600">*</span></Label>
                <DatePicker
                  value={String(precloseForm.preclose_date || '')}
                  onChange={(v) => setPrecloseForm((p) => ({ ...p, preclose_date: v }))}
                  min={precloseRow?.open_date || undefined}
                />
              </div>
            </section>

            {preclosePreview && (
              <div className={cn('rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white !bg-none !p-0 !shadow-none')}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900', __WEB__ && '!mb-0 !gap-2 !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-4 !py-3 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0A1F17]')}>
                  <Banknote className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} /> Recalculated over the actual period
                  <InfoTip text="This corrects the margin/interest/charges voucher already posted for this LC to the shorter period actually used — a separate entry from the repayment below." />
                  <span className={cn('ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white', __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-2 !py-1 !text-[#33473E]')}>
                    <CalendarClock className="h-3 w-3" /> {preclosePreview.days} interest days
                  </span>
                </h3>
                <div className={cn('grid grid-cols-2 gap-3 text-center sm:grid-cols-4', __WEB__ && PREVIEW_CELLS)}>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">LC Open Amount</div>
                    <div className={cn('text-[15px] font-semibold tabular-nums text-sky-950', __WEB__ && '!text-[#0A1F17]')}>{formatINR(preclosePreview.openAmount)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Interest</div>
                    <div className={cn('text-[15px] font-semibold tabular-nums text-rose-700', __WEB__ && '!text-[#B3261E]')}>{formatINR(preclosePreview.interest)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Charges</div>
                    <div className={cn('text-[15px] font-semibold tabular-nums text-rose-700', __WEB__ && '!text-[#B3261E]')}>{formatINR(preclosePreview.charges)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Margin</div>
                    <div className={cn('text-[15px] font-semibold tabular-nums text-sky-950', __WEB__ && '!text-[#0A1F17]')}>{formatINR(preclosePreview.margin)}</div>
                  </div>
                </div>
              </div>
            )}

            {preclosePreview && preclosePreview.pendingDays > 0 && (
              <div className={cn('rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm', LC_FIELDS, __WEB__ && '!rounded-[4px] !border-[#BFE3CB] !bg-white !p-0 !shadow-none')}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-emerald-900', __WEB__ && '!mb-0 !gap-2 !border-b !border-b-[#BFE3CB] !bg-[#F4FBF6] !px-4 !py-3 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0B6B45]')}>
                  <AlertTriangle className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4')} /> Premature closure — interest rebate
                  <InfoTip text="Interest for the pending days was already deducted from what the supplier was paid, over the full planned term. Since those days won't actually happen, this comes back as a rebate — either to your own account, or passed on to the supplier." />
                  <span className={cn('ml-auto flex items-center gap-1 rounded-full bg-emerald-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white', __WEB__ && '!rounded-[2px] !bg-[#EAF6EC] !px-2 !py-1 !text-[#0B6B45]')}>
                    <CalendarClock className="h-3 w-3" /> {preclosePreview.pendingDays} pending days
                  </span>
                </h3>
                <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex flex-wrap items-center gap-1.5">
                      Premature interest (₹)
                      <button
                        type="button"
                        className={cn('text-[10px] font-medium text-teal-700 underline-offset-2 hover:underline', __WEB__ && '!rounded-[2px] !border !border-[#BFE3CB] !bg-[#F4FBF6] !px-1.5 !py-0.5 !text-[10px] !font-extrabold !normal-case !tracking-normal !text-[#0B6B45] hover:!bg-[#EAF6EC] hover:!no-underline')}
                        onClick={() => setPrecloseForm((p) => ({ ...p, premature_interest: String(preclosePreview.prematureInterest) }))}
                      >
                        Use calculated ({formatINR(preclosePreview.prematureInterest)})
                      </button>
                    </Label>
                    <Input
                      type="number"
                      value={precloseForm.premature_interest ?? ''}
                      onChange={(e) => setPrecloseForm((p) => ({ ...p, premature_interest: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Rebate goes to</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPrecloseForm((p) => ({ ...p, premature_interest_direction: 'credit_to_us' }))}
                        className={cn(
                          'rounded-md border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                          precloseForm.premature_interest_direction !== 'pay_to_party'
                            ? 'border-emerald-500 bg-emerald-100 text-emerald-900'
                            : 'border-[#e5dfc8] text-muted-foreground hover:bg-muted/40',
                          __WEB__ && '!h-11 !rounded-[4px] !text-[12px] !font-extrabold !tracking-[.04em]',
                          __WEB__ &&
                            (precloseForm.premature_interest_direction !== 'pay_to_party'
                              ? '!border-[#12855A] !bg-[#0B6B45] !text-white'
                              : '!border-[#C3D2C6] !bg-white !text-[#33473E] hover:!bg-[#F7FAF6]')
                        )}
                      >
                        Credit to us
                      </button>
                      <button
                        type="button"
                        onClick={() => setPrecloseForm((p) => ({ ...p, premature_interest_direction: 'pay_to_party' }))}
                        className={cn(
                          'rounded-md border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                          precloseForm.premature_interest_direction === 'pay_to_party'
                            ? 'border-amber-500 bg-amber-50 text-amber-800'
                            : 'border-[#e5dfc8] text-muted-foreground hover:bg-muted/40',
                          __WEB__ && '!h-11 !rounded-[4px] !text-[12px] !font-extrabold !tracking-[.04em]',
                          __WEB__ &&
                            (precloseForm.premature_interest_direction === 'pay_to_party'
                              ? '!border-[#C2700A] !bg-[#C2700A] !text-white'
                              : '!border-[#C3D2C6] !bg-white !text-[#33473E] hover:!bg-[#F7FAF6]')
                        )}
                      >
                        Pay to party
                      </button>
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-emerald-900/70">
                  {precloseForm.premature_interest_direction === 'pay_to_party'
                    ? 'Paid to the supplier — they were underpaid by this much when their bill was settled over the full term.'
                    : 'Credited straight into your own current account — a separate entry from the repayment below.'}
                </p>
              </div>
            )}

            <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
              <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                Repayment to bank
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Preclosing is a repayment, just like Log Repayment — the bank still wants its full open amount back.
              </p>
              <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                <div className="flex flex-col gap-1.5">
                  <Label>Open amount (LC)</Label>
                  <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
                    {formatINR(n(preclosePreview?.openAmount))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>
                    Total debited from bank (₹) <span className="text-red-600">*</span>
                  </Label>
                  <Input type="number" value={precloseForm.amount ?? ''} onChange={(e) => setPrecloseForm((p) => ({ ...p, amount: e.target.value }))} />
                  {preclosePreview && n(precloseForm.amount) > 0 && n(precloseForm.amount) < n(preclosePreview.openAmount) - 0.005 && (
                    <span className="text-[10px] font-medium text-rose-600">Cannot be less than the open amount</span>
                  )}
                </div>
                {preclosePreview &&
                  (() => {
                    const excess = round2(n(precloseForm.amount) - preclosePreview.openAmount)
                    if (excess <= 0.005) return null
                    const splitTotal = round2(n(precloseForm.comm_charges) + n(precloseForm.bank_charges))
                    const splitOff = Math.abs(splitTotal - excess) > 0.005
                    return (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 sm:col-span-2">
                        <p className="mb-2 text-[11px] font-medium text-amber-900">
                          This is {formatINR(excess)} over the open amount — split that between commission and bank charges below.
                        </p>
                        <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                          <div className="flex flex-col gap-1.5">
                            <Label>Comm. charges (₹)</Label>
                            <Input
                              type="number"
                              value={precloseForm.comm_charges ?? ''}
                              onChange={(e) => setPrecloseForm((p) => ({ ...p, comm_charges: e.target.value }))}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>Bank charges (₹)</Label>
                            <Input
                              type="number"
                              value={precloseForm.bank_charges ?? ''}
                              onChange={(e) => setPrecloseForm((p) => ({ ...p, bank_charges: e.target.value }))}
                            />
                          </div>
                        </div>
                        {splitOff && (
                          <span className="mt-1.5 block text-[10px] font-medium text-rose-600">
                            Comm. + Bank charges must add up to {formatINR(excess)} (currently {formatINR(splitTotal)})
                          </span>
                        )}
                      </div>
                    )
                  })()}
              </div>
              {preclosePreview && n(preclosePreview.margin) > 0 && (
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={!!precloseForm.release_margin}
                    onChange={(e) => setPrecloseForm((p) => ({ ...p, release_margin: e.target.checked }))}
                  />
                  Also release the margin FD ({formatINR(preclosePreview.margin)}) — a separate Dr Bank / Cr LC Margin entry
                </label>
              )}
              <p className="mt-3 text-[10px] text-muted-foreground">
                Posts Dr LC Repayment (+ Comm./Bank charges) / Cr Bank the moment you confirm below.
              </p>
            </section>

            {precloseError && <p className="text-sm text-destructive">{precloseError}</p>}
          </div>
          <DialogFooter className={cn('px-6 pb-6', __WEB__ && '!border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5 !pb-3.5')}>
            <Button
              variant="outline"
              onClick={() => setPrecloseRow(null)}
              disabled={precloseSaving}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void savePreclose()}
              disabled={precloseSaving}
              className={cn(__WEB__ && cn(LC_SAVE, '!ml-auto'))}
            >
              {__WEB__ && !precloseSaving && <Check className="h-[18px] w-[18px]" />}
              {precloseSaving ? 'Saving…' : precloseRow && isLcPastMaturity(precloseRow) ? 'Repay LC' : 'Preclose LC'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Guided stage advance — asks only for that stage's own date(s) */}
      <Dialog open={!!stageRow} onOpenChange={(o) => !o && setStageRow(null)}>
        <DialogContent
          className={cn(
            'max-h-[85vh] overflow-y-auto p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100',
            nextLcStage(String(stageRow?.stage || 'application')) === 'payment_received' ? 'max-w-5xl' : 'max-w-lg',
            LC_DRAWER
          )}
        >
          <div
            className={cn(
              'flex items-center gap-3 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white',
              LC_BAND
            )}
          >
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15', __WEB__ && '!rounded-[4px]')}>
              <Landmark className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              {/* Which step of the three this is. An LC moves
                  Application to Open to Payment received, and the eyebrow
                  names the destination so the drawer cannot be mistaken for
                  the one before it. */}
              {__WEB__ && (
                <div className={LC_EYEBROW}>
                  {STAGE_LABEL[nextLcStage(String(stageRow?.stage || 'application')) || ''] || 'Stage'}
                </div>
              )}
              <DialogTitle className={cn('text-[16px] font-bold text-white', LC_TITLE)}>
                Mark {stageRow?.lc_no || 'this application'} {STAGE_LABEL[nextLcStage(String(stageRow?.stage || 'application')) || '']}
              </DialogTitle>
              <p className={cn('text-[12px] text-white/70', LC_SUB)}>
                {nextLcStage(String(stageRow?.stage || 'application')) === 'payment_received'
                  ? "Confirm receipt and settle this LC's bill(s) through the books."
                  : 'Record the LC number and the date the bank actually opened it.'}
              </p>
            </div>
          </div>
          {stageRow && (() => {
            const next = nextLcStage(String(stageRow.stage || 'application'))
            return (
              <div className={cn('grid gap-4 p-6', LC_BODY)}>
                {next === 'open' && (
                  <section
                    className={cn(
                      'grid gap-3 rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm sm:grid-cols-2',
                      __WEB__ && cn(LC_DIALOG, LC_FIELDS, '!gap-3.5 !p-4')
                    )}
                  >
                    <div className="flex flex-col gap-1.5">
                      <Label>LC no <span className="text-red-600">*</span></Label>
                      {(() => {
                        const clash = lcNoClash(lcs, stageForm.lc_no, stageRow?.id)
                        return (
                          <>
                            <Input
                              className={cn('doc-ref', clash && 'border-rose-400 focus-visible:ring-rose-300')}
                              value={stageForm.lc_no ?? ''}
                              onChange={(e) => setStageForm((p) => ({ ...p, lc_no: e.target.value }))}
                            />
                            {clash && (
                              <span className="text-[11px] font-medium leading-snug text-rose-600">
                                Already used in this company — {String(clash.bank || 'unknown bank')}
                                {clash.open_date ? `, opened ${formatDate(clash.open_date)}` : ''}. The bank gave this
                                credit its own number; use that one.
                              </span>
                            )}
                          </>
                        )
                      })()}
                      <span className="text-[10px] text-muted-foreground">Issued by the bank now that the LC is actually open.</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Open date <span className="text-red-600">*</span></Label>
                      <DatePicker
                        value={String(stageForm.opened_date || '')}
                        onChange={(v) => setStageForm((p) => ({ ...p, opened_date: v }))}
                        min={String(stageRow?.open_date || '') || undefined}
                      />
                    </div>
                  </section>
                )}
                {next === 'payment_received' && (
                  <>
                    <div className={cn('grid gap-4 sm:grid-cols-2', __WEB__ && '!gap-3.5 sm:!grid-cols-1')}>
                      <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', __WEB__ && cn(LC_DIALOG, LC_FIELDS))}>
                        <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                          <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><CalendarClock className="h-3 w-3 text-[#1a2c56]" /></span>
                          Dates
                        </h3>
                        <div className={cn('grid gap-3 grid-cols-2', __WEB__ && '!gap-3.5 !p-4')}>
                          <div className="flex flex-col gap-1.5">
                            <Label>Payment received date <span className="text-red-600">*</span></Label>
                            <DatePicker
                              value={String(stageForm.payment_received_date || '')}
                              onChange={(v) => setStageForm((p) => ({ ...p, payment_received_date: v }))}
                              min={String(stageRow?.opened_date || '') || undefined}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>Maturity date <span className="text-red-600">*</span></Label>
                            <DatePicker
                              value={String(stageForm.expiry_date || '')}
                              onChange={(v) => setStageForm((p) => ({ ...p, expiry_date: v }))}
                              min={String(stageForm.payment_received_date || '') || undefined}
                            />
                          </div>
                        </div>
                      </section>
                      <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', __WEB__ && cn(LC_DIALOG, LC_FIELDS))}>
                        <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                          <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                          Margin, interest & charges
                        </h3>
                        {/* The switches and the adjustment sat outside the
                            padded body, so on the website they get a wrapper
                            that carries the same 16px as the grid above. */}
                        <div className={cn('grid grid-cols-3 gap-3', __WEB__ && '!gap-3.5 !px-4 !pt-4')}>
                          <div className="flex flex-col gap-1.5">
                            <Label>Margin %</Label>
                            <Input type="number" value={stageForm.margin_pct ?? ''} onChange={(e) => setStageForm((p) => ({ ...p, margin_pct: e.target.value }))} />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>Interest % p.a. (ROI)</Label>
                            <Input type="number" value={stageForm.interest_pct ?? ''} onChange={(e) => setStageForm((p) => ({ ...p, interest_pct: e.target.value }))} />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>LC charges (₹)</Label>
                            <Input type="number" value={stageForm.charges ?? ''} onChange={(e) => setStageForm((p) => ({ ...p, charges: e.target.value }))} />
                          </div>
                        </div>
                        {/* The bank's advice does not always charge interest on
                            the amount the credit was opened at. Signed, and it
                            moves the interest base only. */}
                        <div className={cn('mt-3 flex flex-col gap-1.5', __WEB__ && '!px-4')}>
                          <Label className="flex items-center gap-1.5">
                            Adj. amount (₹)
                            <InfoTip text="Where the bank charges interest on something other than the open amount, put the difference here — signed, so −2 on an open amount of 100 charges interest on 98. It moves the interest base ONLY: the open amount, the margin and the facility limit are untouched. What does follow is the interest and the vouchers carrying it — less interest means the bank released more, so an auto-raised bill is resized to match. A bill you entered yourself, or one linked to an invoice, is left exactly as recorded." />
                          </Label>
                          <Input
                            type="number"
                            placeholder="0.00"
                            value={stageForm.interest_adj ?? ''}
                            onChange={(e) => setStageForm((p) => ({ ...p, interest_adj: e.target.value }))}
                          />
                        </div>
                        <div className={cn('mt-3 flex items-center gap-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5', __WEB__ && '!mx-4 !rounded-[4px] !border-[#D6E2D6] !bg-[#F7FAF6] !px-3.5 !py-3')}>
                          <Switch checked={!!stageForm.interest_upfront} onCheckedChange={(v) => setStageForm((p) => ({ ...p, interest_upfront: v }))} />
                          <div className={cn('text-[12px] font-semibold', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>Interest &amp; charges paid upfront</div>
                        </div>
                        <div className={cn('mt-2 flex items-center gap-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5', __WEB__ && '!mx-4 !mb-4 !rounded-[4px] !border-[#D6E2D6] !bg-[#F7FAF6] !px-3.5 !py-3')}>
                          <Switch
                            checked={!!stageForm.interest_excl_charges}
                            onCheckedChange={(v) => setStageForm((p) => ({ ...p, interest_excl_charges: v }))}
                          />
                          <div className="min-w-0">
                            <div className={cn('text-[12px] font-semibold', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>Exclude bank charges from the interest</div>
                            <div className={cn('text-[11px] leading-snug text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>
                              {stageForm.interest_excl_charges
                                ? 'Interest runs on the open amount less the charges.'
                                : 'Interest runs on the whole open amount.'}
                            </div>
                          </div>
                        </div>
                      </section>
                    </div>
                    {stagePreview && (
                      <div className={cn('rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm', __WEB__ && '!rounded-[4px] !border-[#BFE3CB] !bg-white !bg-none !p-0 !shadow-none')}>
                        <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900', __WEB__ && '!mb-0 !gap-2 !border-b !border-b-[#BFE3CB] !bg-[#F4FBF6] !px-4 !py-3 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0B6B45]')}>
                          {__WEB__ ? <ArrowUpRight className="h-4 w-4" /> : <Banknote className="h-3.5 w-3.5" />}
                          {__WEB__ ? 'What will reach the supplier' : 'Back-calculated from the open amount'}
                          <span className={cn('ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white', __WEB__ && '!rounded-[2px] !bg-[#EAF6EC] !px-2 !py-1 !text-[11px] !text-[#0B6B45]')}>
                            <CalendarClock className="h-3 w-3" /> {stagePreview.days ?? 0} interest days
                          </span>
                        </h3>
                        <div className={cn('grid grid-cols-4 gap-3 text-center', __WEB__ && '!gap-px !bg-[#E4ECE3] !text-left [&>div]:!bg-white [&>div]:!px-3.5 [&>div]:!py-3 [&>div>div:first-child]:!text-[9px] [&>div>div:first-child]:!font-extrabold [&>div>div:first-child]:!tracking-[.12em] [&>div>div:first-child]:!text-[#5A6B62] [&>div>div:nth-child(2)]:!mt-1 [&>div>div:nth-child(2)]:!whitespace-nowrap [&>div>div:nth-child(2)]:!text-[14.5px] [&>div>div:nth-child(2)]:!font-bold')}>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-sky-700">Open amount</div>
                            <div className="text-[16px] font-semibold tabular-nums text-sky-950">{formatINR(stagePreview.amount)}</div>
                            {/* Only when interest is struck on something else,
                                so the reader can tell the two apart. */}
                            {!!stagePreview.working && (
                              <div className="text-[10px] leading-snug text-sky-700/80">
                                interest on {formatINR(stagePreview.base)}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-sky-700">{stagePreview.upfront ? 'Interest (upfront)' : '− Interest'}</div>
                            <div className={cn('text-[16px] font-semibold tabular-nums', stagePreview.upfront ? 'text-sky-950' : 'text-rose-700')}>{formatINR(stagePreview.interest)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-sky-700">{stagePreview.upfront ? 'Charges (upfront)' : '− Charges'}</div>
                            <div className={cn('text-[16px] font-semibold tabular-nums', stagePreview.upfront ? 'text-sky-950' : 'text-rose-700')}>{formatINR(stagePreview.charges)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-sky-700">Margin</div>
                            <div className="text-[16px] font-semibold tabular-nums text-sky-950">{formatINR(stagePreview.margin)}</div>
                          </div>
                        </div>
                        <div className={cn('mt-3 flex items-center justify-between rounded-lg bg-white/70 px-4 py-2.5', __WEB__ && '!mt-0 !flex-wrap !gap-2.5 !rounded-none !border-t !border-t-[#BFE3CB] !bg-[#EAF6EC] !px-4 !py-3.5')}>
                          <span className={cn('text-[11px] font-medium uppercase tracking-wide text-sky-800', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.1em] !text-[#0B6B45]')}>
                            {stagePreview.upfront ? 'Net available = open amount (interest & charges paid upfront)' : 'Net available = open amount − interest − charges'}
                          </span>
                          <span className={cn('text-xl font-bold tabular-nums text-[#1a2c56]', __WEB__ && '!ml-auto !whitespace-nowrap !text-[21px] !tracking-[-0.035em] !text-[#0B6B45]')}>{formatINR(stagePreview.netAvailable)}</span>
                        </div>
                      </div>
                    )}
                    <div className={cn('flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900', __WEB__ && '!rounded-[4px] !border-[#F0D9AE] !border-l-4 !border-l-[#C2700A] !bg-[#FFFBF2] !px-3.5 !py-3 !text-[12px] !font-semibold !leading-relaxed !text-[#8A5300]')}>
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Marking this Payment Received also issues (if not already) and settles this LC's bill(s) through the books.
                    </div>
                  </>
                )}
                {stageError && (
                  <p className={cn('text-sm text-destructive', __WEB__ && '!rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-3.5 !py-3 !text-[12.5px] !font-bold !text-[#8C2F26]')}>
                    {stageError}
                  </p>
                )}
              </div>
            )
          })()}
          <DialogFooter className={cn('px-6 pb-6', LC_FOOT)}>
            <Button variant="outline" onClick={() => setStageRow(null)} disabled={stageSaving} className={cn(LC_CANCEL)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveStageAdvance()}
              disabled={stageSaving}
              className={cn(__WEB__ && cn(LC_SAVE, '!ml-auto'))}
            >
              {__WEB__ && !stageSaving && <Check className="h-[18px] w-[18px]" />}
              {stageSaving ? 'Saving…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New / edit LC */}
      <Dialog open={!!lcForm} onOpenChange={(o) => !o && setLcForm(null)}>
        <DialogContent
          className={cn(
            'max-w-5xl max-h-[88vh] overflow-y-auto p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100',
            LC_DRAWER,
            __WEB__ &&
              '[&>button]:!flex [&>button]:!h-9 [&>button]:!w-9 [&>button]:!items-center [&>button]:!justify-center [&>button]:!rounded-[3px] [&>button]:!bg-white/10 [&>button]:!opacity-100 hover:[&>button]:!bg-white/20'
          )}
        >
          <div
            className={cn(
              'flex items-center gap-3 rounded-t-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white',
              __WEB__ && '!rounded-none !bg-[#0B3D2E] !bg-none !px-5 !py-4'
            )}
          >
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15', __WEB__ && '!hidden')}>
              <Landmark className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              {/* The kind above the name, as the detail drawers do: "Letter of
                  credit / Open new LC" reads as a heading, where one line
                  running them together read as a sentence. */}
              {__WEB__ && (
                <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Letter of credit</div>
              )}
              <DialogTitle className={cn('text-[16px] font-bold text-white', __WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em]')}>
                {lcForm?.id ? `Alter LC ${lcForm.lc_no || '(pending no.)'}` : __WEB__ ? 'Open new LC' : 'Open a letter of credit'}
              </DialogTitle>
              {!__WEB__ && (
                <p className="text-[12px] text-white/70">
                  Track the LC from application through to payment received.
                </p>
              )}
            </div>
            {!!activeCompany && (
              <Select value={String(activeCompany)} onValueChange={onCompanyChange}>
                <SelectTrigger
                  title="Switch company"
                  className={cn(
                    'ml-auto mr-8 h-auto w-auto shrink-0 gap-1.5 rounded-full border-0 bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/90 shadow-none hover:bg-white/25 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-80',
                    __WEB__ && '!mr-10 !rounded-[3px] !border !border-white/20 !px-3 !py-2 !text-[11.5px] !font-bold !text-white'
                  )}
                >
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent className="min-w-[14rem]">
                  {companies
                    .filter((c) => c.active)
                    .map((c) => (
                      <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {/* One column in the drawer. lg:grid-cols-2 is a VIEWPORT breakpoint,
              not a container one, so on a wide screen it would still fire
              inside a 720px panel and hand each section card about 340px — two
              cramped columns where the handoff has one readable stack.
              ------------------------------------------------------------
              col-span-1 on every child is NOT redundant. Two of them carry
              lg:col-span-2, and a span of 2 inside a ONE-column grid does
              not clamp — it manufactures an implicit second column, sized
              auto. That auto track took the whole width and starved the 1fr
              track to 0px, so every other section card came out 2px wide
              showing nothing but a collapsed control. */}
          {lcForm && (
            <div className={cn('grid gap-4 p-6 lg:grid-cols-2', __WEB__ && cn(LC_BODY, 'lg:!grid-cols-1 [&>*]:!col-span-1'))}>
              <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><Landmark className="h-3 w-3 text-[#1a2c56]" /></span>
                  LC & stage
                </h3>
                <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                  <div className="flex flex-col gap-1.5">
                    <Label>LC no {String(lcForm.stage || 'application') !== 'application' && <span className="text-red-600">*</span>}</Label>
                    {(() => {
                      const clash = lcNoClash(lcs, lcForm.lc_no, lcForm.id)
                      // Said here rather than only on save. A number typed at the
                      // top of a long form is worth challenging while the cursor
                      // is still in it — not after every other field has been
                      // filled in and the save is refused.
                      return (
                        <>
                          <Input
                            className={cn('doc-ref', clash && 'border-rose-400 focus-visible:ring-rose-300')}
                            value={lcForm.lc_no ?? ''}
                            onChange={(e) => setLcForm((p) => ({ ...p, lc_no: e.target.value }))}
                            placeholder={String(lcForm.stage || 'application') === 'application' ? 'Obtained once the LC is Open' : ''}
                          />
                          {clash && (
                            <span className="text-[11px] font-medium leading-snug text-rose-600">
                              Already used in this company — {String(clash.bank || 'unknown bank')}
                              {clash.open_date ? `, opened ${formatDate(clash.open_date)}` : ''}
                              {Number(clash.amount) ? `, ${formatINR(clash.amount)}` : ''}. Two LCs on one number cannot be
                              told apart in the ledger.
                            </span>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Bank / discounting bank <span className="text-red-600">*</span></Label>
                    {(() => {
                      const bank = String(lcForm.bank || '')
                      // A bank typed once (not in the list yet) still counts as
                      // "adding new" on reopen, so editing an existing LC with a
                      // one-off bank name doesn't silently blank the field.
                      const showTextInput = addingNewBank || (bank !== '' && !bankOptions.includes(bank))
                      return showTextInput ? (
                        <div className="flex min-w-0 gap-1.5">
                          <Input
                            autoFocus={addingNewBank}
                            className="min-w-0 flex-1"
                            value={bank}
                            onChange={(e) => setLcForm((p) => ({ ...p, bank: e.target.value }))}
                            placeholder="Type the new bank's name"
                          />
                          {bankOptions.length > 0 && (
                            <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Pick from the list instead" onClick={() => { setAddingNewBank(false); setLcForm((p) => ({ ...p, bank: '' })) }}>
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ) : (
                        <Select
                          value={bank}
                          onValueChange={(v) => {
                            if (v === NEW_BANK) {
                              // Deferred past this click's own render pass — the
                              // custom Select portals its panel manually and is
                              // still closing itself when onValueChange fires.
                              // Swapping it out for the text input synchronously
                              // here unmounts it mid-click and crashes the
                              // portal (the dialog "gets stuck" with an error).
                              setTimeout(() => {
                                setAddingNewBank(true)
                                setLcForm((p) => (p ? { ...p, bank: '' } : p))
                              }, 0)
                            } else {
                              setLcForm((p) => ({ ...p, bank: v }))
                            }
                          }}
                        >
                          <SelectTrigger><SelectValue placeholder="Select a bank" /></SelectTrigger>
                          <SelectContent className="max-h-64">
                            {bankOptions.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                            <SelectItem value={NEW_BANK}>+ Add new bank</SelectItem>
                          </SelectContent>
                        </Select>
                      )
                    })()}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>FD No <span className="text-red-600">*</span></Label>
                    <Input value={lcForm.fd_no ?? ''} onChange={(e) => setLcForm((p) => ({ ...p, fd_no: e.target.value }))} placeholder="e.g. FD/2026/045" />
                    <span className="text-[10px] text-muted-foreground">Fixed deposit lodged as security</span>
                  </div>
                  {/* Our own account, distinct from the discounting bank above:
                      the bank above FINANCES the LC, this is the account the
                      money actually leaves from when it is repaid. */}
                  <div className="flex flex-col gap-1.5">
                    <Label>My bank <span className="text-[10px] font-normal text-muted-foreground">(repayments go out of this)</span></Label>
                    <Select
                      value={lcForm.our_bank_id ? String(lcForm.our_bank_id) : ''}
                      onValueChange={(v) => setLcForm((p) => ({ ...p, our_bank_id: v }))}
                    >
                      <SelectTrigger><SelectValue placeholder={banks.length ? 'Which of my accounts' : 'Add one under Manage Banks first'} /></SelectTrigger>
                      <SelectContent>
                        {banks.map((b) => <SelectItem key={String(b.id)} value={String(b.id)}>{b.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label>Stage</Label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['application', 'open', 'payment_received'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setLcForm((p) => ({ ...p, stage: s }))}
                          className={cn(
                            'rounded-md border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                            String(lcForm.stage || 'application') === s
                              ? s === 'payment_received' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : s === 'open' ? 'border-sky-500 bg-sky-50 text-sky-800' : 'border-amber-500 bg-amber-50 text-amber-800'
                              : 'border-[#e5dfc8] text-muted-foreground hover:bg-muted/40'
                          )}
                        >
                          {STAGE_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><Users className="h-3 w-3 text-[#1a2c56]" /></span>
                  Party & purpose
                </h3>
                <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>Purpose <span className="text-red-600">*</span></Label>
                    {__WEB__ ? (
                      <div className="inline-flex gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
                        {(['manufacturing', 'trading'] as const).map((o) => {
                          const on = String(lcForm.purpose || '') === o
                          return (
                            <button
                              key={o}
                              type="button"
                              // The same setter the Select used, unchanged:
                              // switching purpose clears the party and every
                              // invoice picked under the old one.
                              onClick={() =>
                                setLcForm((prev) => ({
                                  ...prev,
                                  purpose: o,
                                  party_id: '',
                                  linked_order_ids: [],
                                  linked_deal_ids: [],
                                  amount_manual: false
                                }))
                              }
                              className={cn(
                                'flex h-[38px] flex-1 items-center justify-center rounded-[2px] px-4 text-[12.5px] font-extrabold capitalize transition-colors',
                                on ? 'bg-[#0B3D2E] text-white' : 'bg-transparent text-[#5A6B62] hover:bg-white/70'
                              )}
                            >
                              {o}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <Select
                        value={String(lcForm.purpose || '')}
                        onValueChange={(v) =>
                          setLcForm((p) => ({ ...p, purpose: v, party_id: '', linked_order_ids: [], linked_deal_ids: [], amount_manual: false }))
                        }
                      >
                        <SelectTrigger><SelectValue placeholder="Select purpose" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="trading">Trading</SelectItem>
                          <SelectItem value="manufacturing">Manufacturing</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>Supplier (beneficiary) <span className="text-red-600">*</span></Label>
                    <Select
                      disabled={!lcForm.purpose}
                      value={lcForm.party_id ? String(lcForm.party_id) : ''}
                      onValueChange={(v) => setLcForm((p) => ({ ...p, party_id: v }))}
                    >
                      <SelectTrigger><SelectValue placeholder={lcForm.purpose ? 'Select supplier' : 'Select a purpose first'} /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {purposeSuppliers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {!!lcForm.party_id && String(lcForm.purpose || '') === 'trading' && (
                  <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
                    <Label>Trading invoices for this supplier <span className="text-[10px] font-normal text-muted-foreground">(each invoice is its own pick — select whichever this LC finances)</span></Label>
                    {lcFormTradingInvoices.length === 0 ? (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">No open Trading invoices with this supplier yet.</p>
                    ) : (
                      <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5">
                        {lcFormTradingInvoices.map((r) => {
                          const ids: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                          const checked = ids.map(String).includes(String(r.order_id))
                          const claim = lcInvoiceClaims.get(r.order_id)
                          return (
                            <label
                              key={r.order_id}
                              className={cn(
                                'flex items-center gap-2 rounded px-2 py-1.5 text-[12px]',
                                claim ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                                checked ? 'bg-teal-100' : !claim && 'hover:bg-muted/40'
                              )}
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5"
                                checked={checked}
                                disabled={!!claim}
                                onChange={(e) => {
                                  const nextIds = e.target.checked
                                    ? [...ids, r.order_id]
                                    : ids.filter((x) => Number(x) !== r.order_id)
                                  const total = round2(
                                    orders.filter((o) => nextIds.map(Number).includes(Number(o.id))).reduce((s, o) => s + n(o.net_amount), 0)
                                  )
                                  // A deal counts as linked once at least one of its own
                                  // invoices is picked — used for the receivable-party
                                  // default and the LC register's deal listing, not as
                                  // an exclusivity boundary (that's per-invoice now).
                                  const dealIdsNow = Array.from(
                                    new Set(lcFormTradingInvoices.filter((x) => nextIds.includes(x.order_id)).map((x) => x.deal_id))
                                  )
                                  setLcForm({
                                    ...lcForm,
                                    linked_order_ids: nextIds,
                                    linked_deal_ids: dealIdsNow,
                                    amount: lcForm.amount_manual ? lcForm.amount : String(total),
                                    // The customer this deal will resell to is who the
                                    // repayment is expected from — pre-filled, not forced.
                                    receivable_party_id: lcForm.receivable_party_id || (e.target.checked ? r.customer_id : lcForm.receivable_party_id)
                                  })
                                }}
                              />
                              <span className="flex-1">
                                {r.invoice_no || `Order #${r.order_id}`} · {formatDate(r.deal_date)}
                                <span className="ml-1.5 text-muted-foreground">→ {r.customer_name || 'no customer yet'}</span>
                                {claim && <span className="ml-1.5 text-rose-700">· linked to LC {claim.lc_no || 'pending'}</span>}
                              </span>
                              <span className="font-medium tabular-nums">{formatINR(r.net_amount)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                    {(() => {
                      const ids: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                      if (!ids.length) return null
                      const total = round2(
                        orders.filter((o) => ids.map(Number).includes(Number(o.id))).reduce((s, o) => s + n(o.net_amount), 0)
                      )
                      const over = n(lcForm.amount) - total
                      return (
                        <div className={cn('mt-1.5 flex items-center justify-between text-[11px]', over > 0.005 ? 'font-medium text-rose-700' : 'text-teal-800')}>
                          <span>Selected invoices' total</span>
                          <span className="tabular-nums">
                            {formatINR(total)}
                            {over > 0.005 ? ` — open amount is ${formatINR(over)} over this` : ''}
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                )}
                {!!lcForm.party_id && String(lcForm.purpose || '') !== 'trading' && (
                  <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
                    <Label>Open invoices for this party <span className="text-[10px] font-normal text-muted-foreground">(select one or more this LC covers)</span></Label>
                    {lcFormOrders.length === 0 ? (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">No invoices booked against this supplier yet.</p>
                    ) : (
                      <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5">
                        {lcFormOrders.map((o) => {
                          const ids: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                          const checked = ids.map(String).includes(String(o.id))
                          return (
                            <label key={String(o.id)} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px]', checked ? 'bg-teal-100' : 'hover:bg-muted/40')}>
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5"
                                checked={checked}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...ids, Number(o.id)]
                                    : ids.filter((x) => String(x) !== String(o.id))
                                  // Summing several invoices' net_amount in floating point
                                  // can land a paisa or two off a clean rupee figure
                                  // (18205027.759999998 rather than .76) — round before it
                                  // ever reaches the input, the same as every other money
                                  // total in this app.
                                  const total = round2(
                                    orders
                                      .filter((x) => next.map(String).includes(String(x.id)))
                                      .reduce((s, x) => s + n(x.net_amount), 0)
                                  )
                                  // Keep the amount tracking the selection — ticking a
                                  // second invoice should sum with the first, not just
                                  // shrink toward it. Only stop once the user has typed
                                  // their own figure into the field below.
                                  setLcForm((p) => ({ ...p, linked_order_ids: next, amount: p?.amount_manual ? p.amount : String(total) }))
                                }}
                              />
                              <span className="flex-1">{o.invoice_no} · {formatDate(o.order_date)}</span>
                              <span className="font-medium tabular-nums">{formatINR(o.net_amount)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                    {(() => {
                      const ids: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                      if (!ids.length) return null
                      const total = round2(
                        orders
                          .filter((o) => ids.map(String).includes(String(o.id)))
                          .reduce((s, o) => s + n(o.net_amount), 0)
                      )
                      const over = n(lcForm.amount) - total
                      return (
                        <div className={cn('mt-1.5 flex items-center justify-between text-[11px]', over > 0.005 ? 'font-medium text-rose-700' : 'text-teal-800')}>
                          <span>Selected invoices total</span>
                          <span className="tabular-nums">
                            {formatINR(total)}
                            {over > 0.005 ? ` — open amount is ${formatINR(over)} over this` : ''}
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                )}
                {!!lcForm.party_id && String(lcForm.purpose) === 'trading' && (
                  <div className="mt-3 grid gap-3 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Party payment will be received from</Label>
                      <Select
                        value={lcForm.receivable_party_id ? String(lcForm.receivable_party_id) : ''}
                        onValueChange={(v) => setLcForm((p) => ({ ...p, receivable_party_id: v }))}
                      >
                        <SelectTrigger className="bg-white"><SelectValue placeholder="Select customer" /></SelectTrigger>
                        <SelectContent className="max-h-64">
                          {customers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    {(!Array.isArray(lcForm.linked_order_ids) || !lcForm.linked_order_ids.length || !lcForm.receivable_party_id) && (
                      <div className="flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-800">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Non-compliant — a Trading LC needs at least one open invoice and the party repayment will come from.
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><CalendarRange className="h-3 w-3 text-[#1a2c56]" /></span>
                  Amount & validity
                </h3>
                <div className={cn('grid gap-3 sm:grid-cols-2', __WEB__ && LC_GRID)}>
                  {(() => {
                    const linkedIds: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                    const hasInvoices = linkedIds.length > 0
                    const total = round2(
                      orders
                        .filter((o) => linkedIds.map(String).includes(String(o.id)))
                        .reduce((s, o) => s + n(o.net_amount), 0)
                    )
                    const blocked = n(lcForm.blocked_amount)
                    // With invoices attached, the open amount is already driven
                    // by their total — that IS the bill submitted. Without
                    // them, it follows the blocked amount until someone types
                    // over it, which is what amount_manual has always meant.
                    const openFollowsBlocked = !lcForm.amount_manual && !hasInvoices
                    return (
                      <>
                      <div className={cn('flex min-w-0 flex-col gap-1.5', __WEB__ && '!col-span-full')}>
                        <Label className="flex items-center gap-1.5">
                          Blocked amount (₹)
                          <InfoTip text="What the bank blocks against the facility when it opens the credit — the amount requested. The open amount cannot exceed the bill submitted, so where the bill comes in for less, the two part company: the bank still holds the blocked figure. The FACILITY LIMIT and the exposure outstanding are measured on this. Interest and margin are not — they stay on the open amount. Left blank, it is taken to be the same as the open amount." />
                        </Label>
                        <Input
                          type="number"
                          placeholder="Same as the open amount"
                          className={cn(__WEB__ && '!h-12 !text-[16px] !font-bold')}
                          value={lcForm.blocked_amount ?? ''}
                          onChange={(e) =>
                            setLcForm((prev) => {
                              const val = e.target.value
                              const linked: number[] = Array.isArray(prev?.linked_order_ids) ? prev!.linked_order_ids : []
                              const follows = !prev?.amount_manual && linked.length === 0
                              return { ...prev, blocked_amount: val, ...(follows ? { amount: val } : {}) }
                            })
                          }
                        />
                        <span className="text-[10px] text-muted-foreground">
                          Counts against the limit. Leave blank if the bank blocked exactly what was opened.
                        </span>
                      </div>
                      <div className={cn('flex min-w-0 flex-col gap-1.5', __WEB__ && '!col-span-full')}>
                        <Label className="flex items-center gap-1.5">
                          Open amount (₹) <span className="text-red-600">*</span>
                          {!hasInvoices && blocked > 0 && (
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {openFollowsBlocked ? '(auto — same as blocked)' : '(manual)'}
                            </span>
                          )}
                          {!hasInvoices && blocked > 0 && !openFollowsBlocked && (
                            <button
                              type="button"
                              className="text-[10px] font-medium text-teal-700 underline-offset-2 hover:underline"
                              onClick={() =>
                                setLcForm((prev) => ({ ...prev, amount: String(blocked), amount_manual: false }))
                              }
                            >
                              Reset to blocked
                            </button>
                          )}
                          {hasInvoices && (
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {lcForm.amount_manual ? '(manual)' : '(auto — sum of selected invoices)'}
                            </span>
                          )}
                          {hasInvoices && lcForm.amount_manual && (
                            <button
                              type="button"
                              className="text-[10px] font-medium text-teal-700 underline-offset-2 hover:underline"
                              onClick={() => setLcForm((p) => ({ ...p, amount: String(total), amount_manual: false }))}
                            >
                              Reset to sum
                            </button>
                          )}
                        </Label>
                        <Input
                          type="number"
                          className={cn(__WEB__ && '!h-12 !text-[17px] !font-bold')}
                          value={lcForm.amount ?? ''}
                          onChange={(e) => setLcForm((p) => ({ ...p, amount: e.target.value, amount_manual: e.target.value !== '' }))}
                        />
                        {hasInvoices && (
                          <span className="text-[10px] text-muted-foreground">Suggested from the selected invoices — edit freely, but it can't exceed their total.</span>
                        )}
                        {/* Stated, not refused. An open amount above the
                            blocked figure means the limit is being measured on
                            less than the LC actually opened for, which is
                            almost always a typo in one of the two — but it is
                            the bank's advice that settles which, not us. */}
                        {blocked > 0 && n(lcForm.amount) > blocked + 0.005 && (
                          <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                              The open amount is <b>{formatINR(round2(n(lcForm.amount) - blocked))}</b> above the
                              blocked amount. The limit counts the blocked figure, so it would understate this LC by
                              that much.
                            </span>
                          </div>
                        )}
                        {/* Interest and charges come out of the open amount
                            before any bill draws on it, so raising either
                            leaves part of an already-issued bill unfunded.
                            That difference is credited back to the party
                            automatically on save — stated here so the effect
                            is visible before it happens, not refused. */}
                        {(() => {
                          const issued = n(lcForm.utilized)
                          if (issued <= 0) return null
                          const amt = n(lcForm.amount)
                          const interest = lcForm.interest_upfront ? 0 : lcInterestOf(lcForm)
                          const charges = lcForm.interest_upfront ? 0 : round2(n(lcForm.charges))
                          const over = round2(issued - round2(amt - interest - charges))
                          if (over < 0.005) return null
                          return (
                            <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span>
                                <b>{formatINR(over)}</b> of the {formatINR(issued)} bill is taken by interest{' '}
                                {formatINR(interest)} + charges {formatINR(charges)}, so it never reaches the party — on
                                save, their account is credited back that much (On Account).
                              </span>
                            </div>
                          )
                        })()}
                      </div>
                      </>
                    )
                  })()}
                  {/* The adjustment the bank's own advice implies.
                      -------------------------------------------------------
                      An LC opened at 100 is not always charged interest on
                      100: the bank part-cancels, rounds, or corrects on its
                      statement. Rather than editing the open amount — which
                      would move the margin, the facility limit and the
                      exposure with it — the difference is stated here and
                      applies to the interest base alone.

                      Saving re-posts the vouchers the interest sits on: the
                      settlement journal, the upfront-interest journal and the
                      party's fee adjustment (see syncLcVouchers in lc.ts). */}
                  {/* Beside the open amount, because it is read against it —
                      and the five lines that used to explain it sit behind the
                      (i). The rule is worth reading once; after that it is
                      five lines between the reader and the field. What stays
                      on screen is the arithmetic, which changes as they type
                      and is the part actually worth checking. */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1.5">
                      Adj. amount (₹)
                      <InfoTip text="Where the bank charges interest on something other than the open amount, put the difference here — signed, so −2 on an open amount of 100 charges interest on 98. It moves the interest base ONLY: the open amount, the margin and the facility limit are untouched. What does follow is the interest and the vouchers carrying it — less interest means the bank released more, so an auto-raised bill is resized to match. A bill you entered yourself, or one linked to an invoice, is left exactly as recorded." />
                    </Label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={lcForm.interest_adj ?? ''}
                      onChange={(e) => setLcForm((p) => ({ ...p, interest_adj: e.target.value }))}
                    />
                  </div>
                  {/* Full width, under BOTH the fields it is derived from — it
                      is read against the open amount as much as against the
                      adjustment. Boxed into one column, the working wrapped
                      onto three lines to say what fits comfortably on one, and
                      the label sat above a figure it belongs beside. */}
                  {n(lcForm.amount) > 0 && (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 sm:col-span-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                        Interest charged on
                      </span>
                      <span className="text-[15px] font-bold tabular-nums text-sky-950">
                        {formatINR(lcInterestBaseOf(lcForm))}
                      </span>
                      {!!lcInterestBaseWorking(lcForm) && (
                        <span className="doc-ref ml-auto text-[11px] tabular-nums text-sky-700/80">
                          {lcInterestBaseWorking(lcForm)}
                        </span>
                      )}
                    </div>
                  )}
                  {(() => {
                    const stage = String(lcForm.stage || 'application')
                    // daysTo(x) = x − today, so this difference cancels "today"
                    // and leaves exactly maturity date − payment received date.
                    const days = lcForm.expiry_date && lcForm.payment_received_date
                      ? daysTo(lcForm.expiry_date)! - daysTo(lcForm.payment_received_date)!
                      : null
                    return (
                      <>
                        <div className="flex flex-col gap-1.5">
                          <Label>Application date <span className="text-red-600">*</span></Label>
                          <DatePicker value={String(lcForm.open_date || '')} onChange={(v) => setLcForm((p) => ({ ...p, open_date: v }))} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Open date</Label>
                          <DatePicker
                            value={String(lcForm.opened_date || '')}
                            onChange={(v) => setLcForm((p) => ({ ...p, opened_date: v }))}
                            disabled={stage === 'application'}
                            min={String(lcForm.open_date || '') || undefined}
                          />
                          {stage === 'application' && <span className="text-[10px] text-muted-foreground">Set once the stage moves to Open</span>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Payment received date</Label>
                          <DatePicker
                            value={String(lcForm.payment_received_date || '')}
                            onChange={(v) => {
                              const usanceDays = v && lcForm.expiry_date ? daysTo(lcForm.expiry_date)! - daysTo(v)! : lcForm.usance_days
                              setLcForm((p) => ({ ...p, payment_received_date: v, usance_days: usanceDays }))
                            }}
                            disabled={stage !== 'payment_received'}
                            min={String(lcForm.opened_date || '') || undefined}
                          />
                          {stage !== 'payment_received' && <span className="text-[10px] text-muted-foreground">Set once payment is received</span>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Maturity date</Label>
                          <DatePicker
                            value={String(lcForm.expiry_date || '')}
                            onChange={(v) => {
                              const usanceDays = v && lcForm.payment_received_date ? daysTo(v)! - daysTo(lcForm.payment_received_date)! : lcForm.usance_days
                              setLcForm((p) => ({ ...p, expiry_date: v, usance_days: usanceDays }))
                            }}
                            disabled={stage !== 'payment_received'}
                            min={String(lcForm.payment_received_date || '') || undefined}
                          />
                          {stage !== 'payment_received' && <span className="text-[10px] text-muted-foreground">Set together with payment received</span>}
                        </div>
                        <div className="flex flex-col gap-1.5 sm:col-span-2">
                          <Label>Interest days</Label>
                          {days != null ? (
                            <div className={cn('flex h-11 items-center justify-between rounded-md border border-sky-300 bg-sky-50 px-3', __WEB__ && '!h-12 !rounded-[4px] !border-[#C6DAF0] !bg-[#F4F8FD] !px-3.5')}>
                              <span className={cn('text-lg font-bold tabular-nums text-sky-950', __WEB__ && '!text-[17px] !text-[#1B4E82]')}>{days} days</span>
                              <span className={cn('rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white', __WEB__ && '!rounded-[2px] !bg-[#EAF0FA] !px-2 !py-1 !text-[10px] !font-extrabold !tracking-[.1em] !text-[#1B4E82]')}>Auto</span>
                            </div>
                          ) : (
                            <div className={cn('flex h-11 items-center rounded-md border border-dashed bg-muted/20 px-3 text-[12px] italic text-muted-foreground', __WEB__ && '!h-12 !rounded-[4px] !border-[#C3D2C6] !bg-[#F7FAF6] !text-[12px] !font-semibold !not-italic !text-[#5A6B62]')}>
                              Calculated once maturity date &amp; payment received date are set
                            </div>
                          )}
                        </div>
                      </>
                    )
                  })()}
                </div>
              </section>

              <section className={cn('rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm', LC_DIALOG, LC_FIELDS)}>
                <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', LC_SECTION_HEAD)}>
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10', __WEB__ && '!h-6 !w-6 !rounded-[3px] !bg-[#EAF0E9]')}><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                  Margin, interest & charges
                </h3>
                <div className={cn('grid gap-3 sm:grid-cols-3', __WEB__ && cn(LC_GRID, '!grid-cols-[repeat(auto-fit,minmax(min(100%,140px),1fr))]'))}>
                  <div className="flex min-w-0 flex-col gap-1.5"><Label>Margin %</Label><Input type="number" value={lcForm.margin_pct ?? ''} onChange={(e) => setLcForm((p) => ({ ...p, margin_pct: e.target.value }))} /></div>
                  {/* "(set with payment received)" doubled the label's height on
                      two of the three fields and left the inputs on different
                      lines. On the website it moves under the field, where every
                      other hint in this form already lives; the desktop app
                      keeps it in the label. */}
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>Interest % p.a. (ROI) {!__WEB__ && String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.interest_pct ?? ''} onChange={(e) => setLcForm((p) => ({ ...p, interest_pct: e.target.value }))} disabled={String(lcForm.stage) !== 'payment_received'} />
                    {__WEB__ && String(lcForm.stage) !== 'payment_received' && (
                      <span className="text-[10px] text-muted-foreground">Set with payment received</span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>LC charges (₹) {!__WEB__ && String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.charges ?? ''} onChange={(e) => setLcForm((p) => ({ ...p, charges: e.target.value }))} disabled={String(lcForm.stage) !== 'payment_received'} />
                    {__WEB__ && String(lcForm.stage) !== 'payment_received' && (
                      <span className="text-[10px] text-muted-foreground">Set with payment received</span>
                    )}
                  </div>
                </div>
                <span className={cn('mt-1 block text-[10px] text-muted-foreground', __WEB__ && '!mt-0 !px-4 !pb-1 !text-[11px] !font-semibold !leading-relaxed')}>ROI and LC charges are obtained once payment is received; interest is charged over the interest days (maturity date − payment received date).</span>
                <div className={cn('mt-3 flex items-center gap-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5', __WEB__ && '!mx-4 !mt-1 !rounded-[4px] !border-[#D6E2D6] !bg-[#F7FAF6] !px-3.5 !py-3')}>
                  <Switch checked={!!lcForm.interest_upfront} onCheckedChange={(v) => setLcForm((p) => ({ ...p, interest_upfront: v }))} />
                  <div className={cn('text-[12px] font-semibold', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>Interest &amp; charges paid upfront</div>
                </div>
                {/* What the interest is charged ON. Normally the whole open
                    amount: the bank funds the credit in full and takes its
                    commission on top. Under some arrangements the commission is
                    deducted before the credit is funded, and interest then runs
                    only on what was actually advanced.

                    Editing this and saving re-posts the LC's vouchers from the
                    new figure — the settlement journal, the upfront-interest
                    journal and the party's fee adjustment all follow. */}
                <div className={cn('mt-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5', __WEB__ && '!mx-4 !mb-4 !rounded-[4px] !border-[#D6E2D6] !bg-[#F7FAF6] !px-3.5 !py-3')}>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={!!lcForm.interest_excl_charges}
                      onCheckedChange={(v) => setLcForm((p) => ({ ...p, interest_excl_charges: v }))}
                    />
                    <div className={cn('text-[12px] font-semibold', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>Exclude bank charges from the interest</div>
                  </div>
                  <div className={cn('mt-1.5 pl-11 text-[11px] leading-snug text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !leading-relaxed !text-[#5A6B62]')}>
                    {(() => {
                      const amt = n(lcForm.amount)
                      const excl = !!lcForm.interest_excl_charges
                      if (!(amt > 0)) {
                        return excl
                          ? 'Interest will be worked out on the open amount less the bank charges.'
                          : 'Interest will be worked out on the whole open amount.'
                      }
                      const full = lcInterestOf({ ...lcForm, interest_excl_charges: false })
                      const less = lcInterestOf({ ...lcForm, interest_excl_charges: true })
                      const saved = round2(full - less)
                      const working = lcInterestBaseWorking(lcForm)
                      return (
                        <>
                          Interest is worked out on{' '}
                          <b className="text-foreground">
                            {working || formatINR(amt)}
                          </b>
                          {saved > 0.005 && (
                            <>
                              {' '}&mdash; {excl ? 'that is' : 'turning this on would save'}{' '}
                              <b className="text-foreground">{formatINR(saved)}</b>{' '}
                              {excl ? 'less than on the whole open amount' : 'of interest'}.
                            </>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>
              </section>

              {n(lcForm.amount) > 0 && (n(lcForm.margin_pct) > 0 || n(lcForm.interest_pct) > 0 || n(lcForm.charges) > 0) && (() => {
                const openAmount = n(lcForm.amount)
                // Margin is the security deposit the bank asks for on the LC's
                // own open amount — a straight percentage of the credit limit
                // itself, not of whichever invoices happen to be linked to it.
                const margin = round2((openAmount * n(lcForm.margin_pct)) / 100)
                const interest = lcInterestOf(lcForm)
                const charges = round2(n(lcForm.charges))
                const upfront = !!lcForm.interest_upfront
                // Back-calculation: the open amount is the limit as struck with
                // the bank — interest and charges come OUT of it, not on top —
                // unless both are being paid upfront from the bank instead.
                const netAvailable = upfront ? openAmount : round2(openAmount - interest - charges)
                // What the facility is actually carrying, which is a different
                // figure from the one every cell in this panel is built on.
                const blockedAmt = n(lcForm.blocked_amount) || openAmount
                return (
                  <div className={cn('rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm lg:col-span-2', __WEB__ && '!rounded-[4px] !border-[#BFE3CB] !bg-white !bg-none !p-0 !shadow-none')}>
                    <h3 className={cn('mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900', __WEB__ && '!mb-0 !gap-2 !border-b !border-b-[#BFE3CB] !bg-[#F4FBF6] !px-4 !py-3 !text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#0B6B45]')}>
                      {__WEB__ ? <ArrowUpRight className="h-4 w-4" /> : <Banknote className="h-3.5 w-3.5" />}
                      {__WEB__ ? 'What will reach the supplier' : 'Back-calculated from the open amount'}
                      <span className={cn('ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white', __WEB__ && '!rounded-[2px] !bg-[#EAF6EC] !px-2 !py-1 !text-[11px] !text-[#0B6B45]')}>
                        <CalendarClock className="h-3 w-3" /> {n(lcForm.usance_days) || 0} interest days
                      </span>
                    </h3>
                    {__WEB__ ? (
                      <div className="px-[15px] pb-[14px] pt-[6px]">
                        <LcPreviewRow label="Open amount" value={formatINR(openAmount)} />
                        <LcPreviewRow
                          label={`Margin ${n(lcForm.margin_pct) || 0}%`}
                          value={formatINR(margin)}
                          sub="held by the bank against the credit"
                        />
                        <LcPreviewRow
                          label="Interest"
                          value={formatINR(interest)}
                          tone={upfront ? undefined : '!text-[#B3261E]'}
                          sub={
                            upfront
                              ? 'paid upfront by its own voucher — not deducted'
                              : lcInterestBaseWorking(lcForm) ||
                                (n(lcForm.interest_pct) > 0
                                  ? `${formatINR(lcInterestBaseOf(lcForm))} × ${lcForm.interest_pct}% × ${n(lcForm.usance_days) || 0} ÷ 365`
                                  : 'rate × interest days ÷ 365')
                          }
                        />
                        <LcPreviewRow
                          label="Charges"
                          value={formatINR(charges)}
                          tone={upfront ? undefined : '!text-[#B3261E]'}
                          sub={upfront ? 'paid upfront — not deducted' : undefined}
                        />
                        <LcPreviewRow
                          label="Released to beneficiary"
                          value={formatINR(netAvailable)}
                          tone="!text-[#0B6B45]"
                          strong
                          sub={
                            n(lcForm.interest_adj)
                              ? `includes an interest adjustment of ${formatINR(n(lcForm.interest_adj))}`
                              : upfront
                                ? 'the full open amount — interest and charges are settled separately'
                                : 'open amount − interest − charges'
                          }
                          last
                        />
                      </div>
                    ) : (
                    <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                      <div><div className="text-[10px] uppercase tracking-wide text-sky-700">Open amount</div><div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(openAmount)}</div></div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-sky-700">{upfront ? 'Interest (upfront)' : '− Interest'}</div>
                        <div className={cn('text-[15px] font-semibold tabular-nums', upfront ? 'text-sky-950' : 'text-rose-700')}>{formatINR(interest)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-sky-700">{upfront ? 'Charges (upfront)' : '− Charges'}</div>
                        <div className={cn('text-[15px] font-semibold tabular-nums', upfront ? 'text-sky-950' : 'text-rose-700')}>{formatINR(charges)}</div>
                      </div>
                      <div><div className="text-[10px] uppercase tracking-wide text-sky-700">Margin</div><div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(margin)}</div></div>
                    </div>
                    )}
                    {/* The website's last preview row IS this figure, so the
                        strip would say it twice. */}
                    {!__WEB__ && (
                      <div className="mt-3 flex items-center justify-between rounded-lg bg-white/70 px-4 py-2.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-sky-800">
                          {upfront ? 'Net available = open amount (interest & charges paid upfront)' : 'Net available = open amount − interest − charges'}
                        </span>
                        <span className="text-xl font-bold tabular-nums text-[#1a2c56]">{formatINR(netAvailable)}</span>
                      </div>
                    )}
                    {/* Only when the two differ. Every figure in the panel above
                        is struck on the open amount, so the one that is not
                        says so plainly rather than being left to be inferred. */}
                    {Math.abs(blockedAmt - openAmount) > 0.005 && (
                      <div className={cn('mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-sky-200 bg-white/70 px-4 py-2.5', __WEB__ && '!mt-0 !rounded-none !border-0 !border-t !border-t-[#C6DAF0] !bg-[#F4F8FD] !px-[15px] !py-3')}>
                        <span className={cn('text-[10px] font-semibold uppercase tracking-wide text-sky-700', __WEB__ && '!text-[9px] !font-extrabold !tracking-[.12em] !text-[#1B4E82]')}>
                          Blocked against the limit
                        </span>
                        <span className={cn('text-[15px] font-bold tabular-nums text-sky-950', __WEB__ && '!text-[14.5px] !text-[#1B4E82]')}>
                          {formatINR(blockedAmt)}
                        </span>
                        <span className={cn('ml-auto text-[11px] text-sky-700/80', __WEB__ && '!text-[11px] !font-semibold !text-[#5A6B62]')}>
                          Interest and margin stay on the open amount.
                        </span>
                      </div>
                    )}
                  </div>
                )
              })()}

              {__WEB__ ? (
                <section className={cn(LC_DIALOG, LC_FIELDS)}>
                  {/* flex items-center comes from the base h3 class on every
                      other section; LC_SECTION_HEAD only carries the website's
                      overrides, so without it the icon stacked above the word. */}
                  <h3 className={cn('flex items-center gap-1.5 uppercase', LC_SECTION_HEAD)}>
                    <span className="flex !h-6 !w-6 items-center justify-center !rounded-[3px] !bg-[#EAF0E9]">
                      <FileText className="h-3 w-3 text-[#0B3D2E]" />
                    </span>
                    Note
                  </h3>
                  <div className="!p-4">
                    <Input
                      value={lcForm.note ?? ''}
                      placeholder="Anything worth recording against this LC"
                      onChange={(e) => setLcForm((p) => ({ ...p, note: e.target.value }))}
                    />
                  </div>
                </section>
              ) : (
                <div className="flex flex-col gap-1.5 lg:col-span-2"><Label>Note</Label><Input value={lcForm.note ?? ''} onChange={(e) => setLcForm((p) => ({ ...p, note: e.target.value }))} /></div>
              )}
            </div>
          )}
          <DialogFooter className={cn('border-t border-[#e5dfc8] bg-muted/20 px-6 py-4', LC_FOOT)}>
            {/* Left of the buttons, where the handoff puts it: what is still
                needed, or a tick. Only on the website — the desktop app's
                footer is two buttons and has no room for a third thing. */}
            {__WEB__ && (
              <div
                className={cn(
                  'flex min-w-0 items-center gap-2 text-[12px] font-bold',
                  lcMissing.length ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                )}
              >
                {lcMissing.length ? (
                  <>
                    <AlertTriangle className="h-[17px] w-[17px] shrink-0" />
                    <span className="min-w-0">Still needed: {lcMissing.join(', ')}</span>
                  </>
                ) : (
                  <>
                    <Check className="h-[17px] w-[17px] shrink-0" />
                    <span>Ready to save</span>
                  </>
                )}
              </div>
            )}
            <Button
              variant="outline"
              onClick={() => setLcForm(null)}
              className={cn(__WEB__ && cn(LC_CANCEL, '!ml-auto'))}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              className={cn('bg-[#1a2c56] hover:bg-[#24407e]', __WEB__ && LC_SAVE)}
              onClick={() => void saveLc()}
            >
              {__WEB__ && !busy && <Check className="h-[18px] w-[18px]" />}
              {busy ? 'Saving…' : lcForm?.id ? 'Save changes' : 'Open LC'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LC detail — a proper modal instead of expanding the row in place */}
      <Dialog open={!!unpreRow} onOpenChange={(o) => !o && !unpreBusy && setUnpreRow(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Undo the preclosure of {String(unpreRow?.lc_no || 'this LC')}?</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            The LC goes back to open, as though it had never been wound up. Everything the preclosure wrote is
            reversed:
          </p>
          <ul className="ml-4 list-disc space-y-0.5 text-[12px] text-muted-foreground">
            <li>the premature-interest rebate voucher</li>
            <li>the margin-release voucher and the settlement it recorded</li>
            <li>the repayment it logged on {formatDate(unpreRow?.preclosed_date)}</li>
            <li>
              the interest period, which preclosing shortened to the days actually elapsed — restored to the full
              planned span up to {formatDate(unpreRow?.expiry_date)}
            </li>
          </ul>
          <p className="text-[12px] text-muted-foreground">
            Bills issued under this LC and any Payment IN are left untouched — they are not part of the preclosure.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnpreRow(null)} disabled={unpreBusy}>Leave it preclosed</Button>
            <Button onClick={() => void confirmUnpreclose()} disabled={unpreBusy}>
              {unpreBusy ? 'Restoring…' : 'Undo preclosure'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={lcDetailId != null} onOpenChange={(o) => !o && setLcDetailId(null)}>
        <DialogContent
          className={cn(
            'max-h-[85vh] max-w-3xl overflow-y-auto',
            // A drawer against the edge on the website, like the Purchases and
            // Trading detail views: this is a tall stack of blocks about one
            // LC, which reads better in a column than as a wide box floating
            // over the register it came from.
            __WEB__ &&
              '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[760px] !max-w-[95vw] !min-w-0 !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
          )}
        >
          {(() => {
            const dRow = lcDetailId != null ? lcs.find((x) => Number(x.id) === lcDetailId) : null
            if (!dRow) return null
            const pct = n(dRow.amount) > 0 ? Math.min(100, (n(dRow.utilized) / n(dRow.amount)) * 100) : 0
            const barTone = __WEB__
              ? pct >= 95
                ? 'bg-[#B3261E]'
                : pct >= 75
                  ? 'bg-[#C2700A]'
                  : 'bg-[#0B3D2E]'
              : pct >= 95
                ? 'bg-rose-500'
                : pct >= 75
                  ? 'bg-amber-500'
                  : 'bg-sky-600'
            return (
              <>
                <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left')}>
                  {__WEB__ && (
                    <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Letter of credit</div>
                  )}
                  <DialogTitle className={cn('flex flex-wrap items-center gap-1.5 pr-6', __WEB__ && '!mt-2 !gap-2 !pr-10')}>
                    <span className={cn('doc-ref', !dRow.lc_no && 'italic text-muted-foreground', __WEB__ && '!text-[19px] !font-bold !tracking-[-0.02em] !text-white', __WEB__ && !dRow.lc_no && '!text-[#8FBFA8]')}>{dRow.lc_no || 'Pending LC no'}</span>
                    <DuplicateNoBadge lcs={lcs} l={dRow} />
                    <StageBadge stage={String(dRow.stage || 'application')} />
                    <ClosureBadge l={dRow} withDate />
                    {isLcPaymentInDone(dRow) && <Badge variant="success">Payment IN</Badge>}
                    {canMarkPaymentIn(dRow) && <Badge variant="warning">Awaiting Payment IN</Badge>}
                    {dRow.purpose && <Badge variant="muted" className="capitalize">{dRow.purpose}</Badge>}
                    {dRow.display_status === 'non_compliant' ? (
                      <Badge variant="destructive">Non-compliant</Badge>
                    ) : (
                      <Badge variant={dRow.display_status === 'on_hold' ? 'warning' : 'success'} className="capitalize">
                        {String(dRow.display_status || 'in_progress').replace('_', ' ')}
                      </Badge>
                    )}
                  </DialogTitle>
                </DialogHeader>
                <div className={cn('space-y-4', __WEB__ && '!min-h-0 !space-y-3.5 !overflow-y-auto !px-5 !py-4 [&>*]:!shrink-0')}>
                  <div className={cn('flex flex-wrap items-center gap-3 text-[12px] font-medium text-foreground', __WEB__ && '!gap-2.5 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-4 !py-3 !text-[13px] !font-bold !text-[#0A1F17]')}>
                    <span className="flex items-center gap-1.5"><Landmark className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', __WEB__ && '!h-4 !w-4 !text-[#5A6B62]')} /> {dRow.bank}</span>
                    {__WEB__ && <span className="h-4 w-px bg-[#DCE7DB]" />}
                    <span className="flex items-center gap-1.5"><Users className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', __WEB__ && '!h-4 !w-4 !text-[#5A6B62]')} /> {dRow.supplier_name || '—'}</span>
                    {dRow.fd_no && <span className={cn(__WEB__ && '!text-[#5A6B62]')}>FD {dRow.fd_no}</span>}
                  </div>
                  <div className={cn('rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm', __WEB__ && '!rounded-[4px] !bg-[#0B3D2E] !bg-none !px-4 !py-3.5 !text-left !shadow-none')}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-widest text-white/60', __WEB__ && '!text-[9.5px] !font-extrabold !tracking-[.13em] !text-[#8FBFA8]')}>LC amount</div>
                    <div className={cn('text-2xl font-bold tabular-nums text-white', __WEB__ && '!mt-1 !text-[26px] !leading-none !tracking-[-0.035em]')}>{formatINR(dRow.amount)}</div>
                  </div>
                  <div className={cn('grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4', __WEB__ && CARD_CELLS)}>
                    <div className={cn('rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5', __WEB__ && '!border-[#E4ECE3] !bg-[#F7FAF6]')}>
                      <div className="text-muted-foreground">Utilised</div>
                      <div className={cn('font-semibold tabular-nums text-[#1a2c56]', __WEB__ && '!text-[#0A1F17]')}>{formatINR(dRow.utilized)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.available) <= 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50', __WEB__ && (n(dRow.available) <= 0 ? '!border-[#F0D6D4] !bg-[#FDF3F2]' : '!border-[#BFE3CB] !bg-[#F4FBF6]'))}>
                      <div className="text-muted-foreground">Available</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.available) <= 0 ? 'text-rose-600' : 'text-emerald-700', __WEB__ && (n(dRow.available) <= 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]'))}>{formatINR(dRow.available)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.repaid) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-[#e5dfc8] bg-white', __WEB__ && (n(dRow.repaid) > 0 ? '!border-[#BFE3CB] !bg-[#F4FBF6]' : '!border-[#E4ECE3] !bg-[#F7FAF6]'))}>
                      <div className="text-muted-foreground">Repaid</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.repaid) > 0 ? 'text-emerald-700' : 'text-[#1a2c56]', __WEB__ && (n(dRow.repaid) > 0 ? '!text-[#0B6B45]' : '!text-[#8FA79B]'))}>{formatINR(dRow.repaid)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.outstanding) > 0 ? 'border-amber-200 bg-amber-50' : 'border-[#e5dfc8] bg-white', __WEB__ && (n(dRow.outstanding) > 0 ? '!border-[#F0D9AE] !bg-[#FFFBF2]' : '!border-[#E4ECE3] !bg-[#F7FAF6]'))}>
                      <div className="text-muted-foreground">Outstanding</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.outstanding) > 0 ? 'text-amber-800' : 'text-[#1a2c56]', __WEB__ && (n(dRow.outstanding) > 0 ? '!text-[#8A5300]' : '!text-[#8FA79B]'))}>{formatINR(dRow.outstanding)}</div>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span>Utilisation</span>
                      <span className="tabular-nums">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-2.5 rounded-full transition-all', barTone)} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div className={cn('grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-[#e5dfc8] bg-white p-3 text-[11px] sm:grid-cols-4', __WEB__ && '!gap-px !overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-[#E4ECE3] !p-0 [&>div]:!bg-white [&>div]:!px-3.5 [&>div]:!py-3')}>
                    <div><div className="text-muted-foreground">Application</div><div className="font-medium tabular-nums">{formatDate(dRow.open_date)}</div></div>
                    <div><div className="text-muted-foreground">Open</div><div className="font-medium tabular-nums">{formatDate(dRow.opened_date)}</div></div>
                    <div><div className="text-muted-foreground">Payment received</div><div className="font-medium tabular-nums">{formatDate(dRow.payment_received_date)}</div></div>
                    <div><div className="text-muted-foreground">Maturity</div><div className="font-medium tabular-nums">{formatDate(dRow.expiry_date)}</div></div>
                    {/* Only when it differs from the open amount above, which
                        is the headline figure on this panel. Repeating the same
                        number under a second name teaches the reader that the
                        two are interchangeable, and they are not. */}
                    {Math.abs(n(dRow.blocked_effective) - n(dRow.amount)) > 0.005 && (
                      <div>
                        <div className="text-muted-foreground">Blocked</div>
                        <div className="font-medium tabular-nums">{formatINR(dRow.blocked_effective)}</div>
                        <div className="text-[10.5px] text-muted-foreground">counts against the limit</div>
                      </div>
                    )}
                    <div><div className="text-muted-foreground">Margin</div><div className="font-medium tabular-nums">{n(dRow.margin_pct)}%</div></div>
                    <div>
                      <div className="text-muted-foreground">Interest</div>
                      <div className="font-medium tabular-nums">
                        {n(dRow.interest_pct)}%{dRow.interest_upfront ? ' upfront' : ''}
                      </div>
                      {/* Which base produced the figure. Without it the reader
                          has to open the LC to know why two LCs at the same
                          rate carry different interest. */}
                      <div className="text-[10.5px] text-muted-foreground">
                        on {String(dRow.interest_basis || (dRow.interest_excl_charges ? 'amount − charges' : 'open amount'))}
                      </div>
                    </div>
                    <div><div className="text-muted-foreground">Charges</div><div className="font-medium tabular-nums">{formatINR(dRow.charges)}</div></div>
                    <div><div className="text-muted-foreground">Int. days</div><div className="font-medium tabular-nums">{n(dRow.usance_days) > 0 ? n(dRow.usance_days) : '—'}</div></div>
                  </div>
                  <div className="border-t border-[#e5dfc8] pt-1 [&>div]:px-0 [&>div]:sm:px-0">{lcExpanded(dRow)}</div>
                  <div className={cn('flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] pt-3', __WEB__ && '!gap-2 !rounded-[4px] !border !border-[#D6E2D6] !border-solid !bg-white !p-3.5')}>
                    {(() => {
                      const next = nextLcStage(String(dRow.stage || 'application'))
                      if (!next) return null
                      return (
                        <Button size="sm" className={cn('h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]', __WEB__ && '!h-10 !rounded-[4px] !bg-[#0B3D2E] !px-3.5 !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] hover:!bg-[#0F4A38]')} onClick={() => { setLcDetailId(null); openStageAdvance(dRow) }}>
                          Mark {STAGE_LABEL[next]}
                        </Button>
                      )
                    })()}
                    {canMarkPaymentIn(dRow) && (
                      <Button
                        size="sm"
                        className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700"
                        title="Record the customer's payment for the resale — independent of whether the bank side has been preclosed yet"
                        onClick={() => { setLcDetailId(null); void openPaymentIn(dRow) }}
                      >
                        Mark Payment IN
                      </Button>
                    )}
                    {canPreclose(dRow) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        title={isLcPastMaturity(dRow) ? 'Repay this LC now that it has matured' : 'Wind this LC up before its natural maturity'}
                        onClick={() => { setLcDetailId(null); openPreclose(dRow) }}
                      >
                        {isLcPastMaturity(dRow) ? 'Repay' : 'Preclose'}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className={cn('h-7 px-2 text-xs', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3.5 !text-[12px] !font-bold !text-[#33473E] hover:!bg-[#EAF0E9]')} onClick={() => { setLcDetailId(null); setLcForm({ ...dRow }) }}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button size="sm" variant="outline" className={cn('h-7 px-2 text-xs text-destructive', __WEB__ && '!h-10 !rounded-[4px] !border-[#F0D6D4] !bg-[#FDF3F2] !px-3.5 !text-[12px] !font-bold !text-[#B3261E] hover:!bg-[#FBE9E7]')} onClick={() => { setLcDetailId(null); requestDeleteLc(dRow) }}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <HistoryDialog target={hist.target} onClose={hist.close} />

      {/* Log / post an LC repayment */}
      <Dialog open={!!repayForm} onOpenChange={(o) => !o && setRepayForm(null)}>
        <DialogContent
          className={cn(
            'max-w-lg',
            // The same drawer as the other LC screens — a repayment is one more
            // act on the row behind it, not a different kind of thing.
            LC_DRAWER,
            __WEB__ && '!p-0 [&>button]:!text-white [&>button]:!opacity-90'
          )}
        >
          {/* The other Treasury dialogs carry a forest header naming what is
              being altered; this one opened straight onto a bare title, so it
              read as a different product. */}
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Letter of credit</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>
              Alter repayment
            </DialogTitle>
            {__WEB__ && (
              <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
                What was paid back to the bank, and whether it is posted to the books.
              </p>
            )}
          </DialogHeader>
          {repayForm && (
            <div
              className={cn(
                'grid gap-3 sm:grid-cols-2',
                __WEB__ && cn(LC_BODY, LC_FIELDS)
              )}
            >
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Related party <span className="text-[10px] font-normal text-muted-foreground">(optional — for reference only, not posted)</span></Label>
                <Select value={repayForm.party_id ? String(repayForm.party_id) : ''} onValueChange={(v) => setRepayForm((p) => ({ ...p, party_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {customers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Open amount (LC)</Label>
                <div className={cn('flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground', __WEB__ && '!h-11 !rounded-[4px] !border-[#DCE7DB] !bg-[#F1F5EF] !text-[13.5px] !font-bold !tabular-nums !text-[#5A6B62]')}>
                  {formatINR(n(repayForm.open_amount))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Repayment amount (₹) *</Label>
                <Input type="number" value={repayForm.amount ?? ''} onChange={(e) => setRepayForm((p) => ({ ...p, amount: e.target.value }))} />
                {n(repayForm.amount) > 0 && n(repayForm.amount) < n(repayForm.open_amount) - 0.005 && (
                  <span className={cn('text-[10px] font-medium text-rose-600', __WEB__ && '!text-[11px] !font-bold !text-[#B3261E]')}>Cannot be less than the open amount</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5"><Label>Date</Label><DatePicker value={String(repayForm.repay_date || '')} onChange={(v) => setRepayForm((p) => ({ ...p, repay_date: v }))} /></div>
              {(() => {
                const excess = round2(n(repayForm.amount) - n(repayForm.open_amount))
                if (excess <= 0.005) return null
                const splitTotal = round2(n(repayForm.comm_charges) + n(repayForm.bank_charges))
                const splitOff = Math.abs(splitTotal - excess) > 0.005
                return (
                  <div className={cn('rounded-md border border-amber-300 bg-amber-50 p-3 sm:col-span-2', __WEB__ && '!rounded-[4px] !border-[#F0D9AE] !border-l-[3px] !border-l-[#C2700A] !bg-[#FFFBF2] !p-4')}>
                    <p className={cn('mb-2 text-[11px] font-medium text-amber-900', __WEB__ && '!mb-3 !text-[12px] !font-bold !leading-relaxed !text-[#8A5300]')}>
                      This repayment is {formatINR(excess)} over the open amount — split that excess between commission and bank charges below.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Comm. charges (₹)</Label>
                        <Input type="number" value={repayForm.comm_charges ?? ''} onChange={(e) => setRepayForm((p) => ({ ...p, comm_charges: e.target.value }))} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Bank charges (₹)</Label>
                        <Input type="number" value={repayForm.bank_charges ?? ''} onChange={(e) => setRepayForm((p) => ({ ...p, bank_charges: e.target.value }))} />
                      </div>
                    </div>
                    {splitOff && (
                      <span className={cn('mt-1.5 block text-[10px] font-medium text-rose-600', __WEB__ && '!text-[11px] !font-bold !text-[#B3261E]')}>
                        Comm. + Bank charges must add up to {formatINR(excess)} (currently {formatINR(splitTotal)})
                      </span>
                    )}
                  </div>
                )
              })()}
              {n(repayForm.amount) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label>Total debited from bank</Label>
                  <div className={cn('flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium', __WEB__ && '!h-11 !rounded-[4px] !border-[#DCE7DB] !bg-[#F1F5EF] !text-[13.5px] !font-bold !tabular-nums !text-[#0A1F17]')}>
                    {formatINR(n(repayForm.amount))}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Bank document / payment letter <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(__WEB__ && '!h-11 !shrink-0 !rounded-[4px] !border-[#C3D2C6] !px-3.5 !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !text-[#33473E]')}
                    onClick={() => void pickRepaymentDocument()}
                  >
                    <Paperclip className="h-3.5 w-3.5" /> Attach file
                  </Button>
                  {repayForm.document_path ? (
                    <span className="truncate text-[11px] text-muted-foreground" title={String(repayForm.document_path)}>
                      {String(repayForm.document_path).split(/[\\/]/).pop()}
                    </span>
                  ) : (
                    <span className={cn('text-[11px] text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>No file attached — you can save without one</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={repayForm.note ?? ''} onChange={(e) => setRepayForm((p) => ({ ...p, note: e.target.value }))} /></div>
              {/* The one control here that moves money. As a bare checkbox
                  on a line of 13px text it read like a preference; boxed, and
                  turning green when it is on, it reads as the decision it is
                  — the footer's own label changes with it. */}
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2',
                  __WEB__ && '!items-start !gap-3 !rounded-[4px] !border !p-4 !text-[12.5px] !font-semibold !leading-relaxed',
                  __WEB__ && (repayForm.posted ? '!border-[#BFE3CB] !bg-[#F4FBF6] !text-[#0B6B45]' : '!border-[#D6E2D6] !bg-white !text-[#33473E]')
                )}
              >
                <input
                  type="checkbox"
                  className={cn('h-4 w-4', __WEB__ && '!mt-0.5 !h-[18px] !w-[18px] !shrink-0 !accent-[#0B6B45]')}
                  checked={!!repayForm.posted}
                  onChange={(e) => setRepayForm((p) => ({ ...p, posted: e.target.checked }))}
                />
                <span>
                  {__WEB__ ? <span className="font-extrabold">Post to the books now</span> : 'Post to the books now'}
                  {__WEB__ ? (
                    <span className="mt-0.5 block text-[11.5px] font-semibold text-[#5A6B62]">
                      Dr LC Repayment (+ Maturity charges) / Cr Bank
                    </span>
                  ) : (
                    ' — Dr LC Repayment (+ Maturity charges) / Cr Bank'
                  )}
                </span>
              </label>
            </div>
          )}
          <DialogFooter className={cn(__WEB__ && '!border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5')}>
            <Button
              variant="outline"
              onClick={() => setRepayForm(null)}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => void saveRepayment()}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !bg-[#0B3D2E] !px-7 !text-[13.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]')}
            >
              {busy ? 'Saving…' : repayForm?.posted ? 'Save & post' : 'Save as draft'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LC Payment IN — the customer's payment for the resale, closing a Trading LC's round trip */}
      <Dialog open={!!paymentInForm} onOpenChange={(o) => !o && setPaymentInForm(null)}>
        <DialogContent
          className={cn('max-w-md', LC_DRAWER, __WEB__ && '!p-0 [&>button]:!text-white [&>button]:!opacity-90')}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left')}>
            {/* The receipt side of a trading LC. It is not a stage of the LC
                itself — the bank side can be preclosed independently — so the
                eyebrow says Receipt rather than naming a stage. */}
            {__WEB__ && <div className={LC_EYEBROW}>Receipt</div>}
            <DialogTitle className={cn(__WEB__ && cn(LC_TITLE, '!text-white'))}>
              Mark {paymentInForm?.lc_no || 'this LC'} Payment IN
            </DialogTitle>
          </DialogHeader>
          {paymentInForm && (
            <div className={cn('grid gap-3', __WEB__ && cn(LC_BODY, LC_FIELDS, '!content-start'))}>
              <p className={cn('text-[12px] text-muted-foreground', __WEB__ && '!rounded-[4px] !border !border-[#C6DAF0] !bg-[#F4F8FD] !px-3.5 !py-3 !text-[12px] !font-semibold !leading-relaxed !text-[#1B4E82]')}>
                Posts Dr Bank / Cr the receivable party, allocated bill-wise against whichever open sale invoice(s) you pick
                below — the same as a Receipt logged in Accounts. The amount doesn&apos;t need to match the LC&apos;s own
                open amount — it&apos;s squared against what the sale side still owes, and can come in across more than one
                payment.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>Open trading sale invoices for this party <span className="text-[10px] font-normal text-muted-foreground">(pick which this payment is for)</span></Label>
                {paymentInInvoices.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Nothing outstanding on this LC&apos;s linked deal(s).</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5">
                    {paymentInInvoices.map((inv) => {
                      const keys: string[] = Array.isArray(paymentInForm.selected_keys) ? paymentInForm.selected_keys : []
                      const checked = keys.includes(String(inv.key))
                      return (
                        <label key={String(inv.key)} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px]', checked ? 'bg-emerald-100' : 'hover:bg-muted/40')}>
                          <input type="checkbox" className="h-3.5 w-3.5" checked={checked} onChange={() => togglePaymentInInvoice(String(inv.key))} />
                          <span className="min-w-0 flex-1 truncate">
                            {inv.invoice_no || inv.key} · {formatDate(inv.sale_date)}
                            {!!inv.customer_name && (
                              <span className="ml-1.5 text-muted-foreground">← {inv.customer_name}</span>
                            )}
                          </span>
                          <span className="shrink-0 font-medium tabular-nums">{formatINR(inv.due)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Date</Label>
                <DatePicker value={String(paymentInForm.date || '')} onChange={(v) => setPaymentInForm((p) => ({ ...p, date: v }))} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Amount received (₹) *</Label>
                <Input
                  type="number"
                  value={paymentInForm.amount ?? ''}
                  onChange={(e) => setPaymentInForm((p) => ({ ...p, amount: e.target.value }))}
                />
              </div>
            </div>
          )}
          <DialogFooter className={cn(LC_FOOT)}>
            <Button variant="outline" onClick={() => setPaymentInForm(null)} className={cn(LC_CANCEL)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              // Green, not forest: money coming IN reads against the outgoing
              // acts on the other screens.
              className={cn('bg-emerald-600 hover:bg-emerald-700', __WEB__ && cn(LC_SAVE, '!ml-auto !bg-[#12855A] !text-white hover:!bg-[#0F7350]'))}
              onClick={() => void savePaymentIn()}
            >
              {__WEB__ && !busy && <Check className="h-[18px] w-[18px]" />}
              {busy ? 'Posting…' : 'Post Payment IN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  )
}
