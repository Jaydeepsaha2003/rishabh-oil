import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { escToClose } from '@/lib/escape'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ArrowUpToLine,
  ChevronsUpDown,
  Banknote,
  BookOpen,
  Check,
  Building2,
  CalendarRange,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LayoutGrid,
  Landmark,
  List,
  Pencil,
  Percent,
  Plus,
  RotateCcw,
  FileSpreadsheet,
  History,
  Info,
  Settings2,
  Trash2,
  Users,
  Search,
  Tag,
  Clock,
  X,
  Undo2
} from 'lucide-react'
import { RefundReceived } from '@/components/RefundReceived'
import { ChargeRows } from '@/components/ChargeRows'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ColumnFilter } from '@/components/ui/column-filter'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { HelpTip, InfoTip } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { RowActions } from '@/components/ui/row-actions'
import { LedgerPostings, type PostingTarget } from '@/components/LedgerPostings'
import { canAccess } from '@/lib/modules'
import { BdDetail, chargesOf } from '@/components/BdDetail'
import { BdRepaymentEdit } from '@/components/BdRepaymentEdit'
import { AdjChargePicker, adjKindsLabel, adjParts, adjPostsTo, adjSplitOk, type AdjPart, type ChargeType } from '@/components/AdjChargePicker'
import { LimitHistory, type LimitTarget } from '@/components/LimitHistory'
import { formatDate, formatDateShort, formatINR, formatNum, todayISO } from '@/lib/format'
import { orderVoucherLines, TAX_NAME } from '@/lib/voucherOrder'
import { isTradingParty } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { TagPicker, useTagMap } from '@/components/Tags'
import { PayInDue, payInDueDate } from '@/components/PayInDue'
import { loadUser } from '@/lib/session'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { exportBdRegister } from '@/lib/bdExcel'
import { RecordHistory, useRecordHistory } from '@/components/RecordHistory'
import { BdReceiptParts } from '@/components/BdReceiptParts'
import { useTableSort } from '@/lib/tableSort'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

function daysTo(date: unknown): number | null {
  const s = String(date || '').slice(0, 10)
  if (!s) return null
  return Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

// Cumulative "due within" windows — same convention the LC register uses:
// "This week" means everything due within 7 days, including what's overdue.
const DUE_PERIODS: { key: string; label: string; maxDays?: number }[] = [
  { key: 'all', label: 'All' },
  { key: 't1', label: 'T+1 due', maxDays: 1 },
  { key: 'week', label: 'This week', maxDays: 7 },
  { key: 'fortnight', label: 'Fortnight', maxDays: 14 }
]

// THE COUNTDOWN, AS A SIGNAL.
//
// A week is the week that matters: inside it the money has to be found, and
// the chip is a filled red that cannot be skimmed past. Beyond it the bill is
// simply on its way, which is amber — a tint, not a fill, so twenty bills due
// next month do not shout as loudly as the one due on Friday. Overdue is the
// same red gone darker: it has already passed the point the red was warning
// about.
//
// Filled rather than tinted for the urgent band because a tint is what the
// rest of the register is made of. The desktop app keeps the three tinted
// variants it has always had.
const DUE_RED = 7
function DueBadge({ date }: { date: unknown }): React.JSX.Element | null {
  const d = daysTo(date)
  if (d == null) return null
  const label = d < 0 ? `${-d}D overdue` : d === 0 ? 'due today' : `${d}D left`
  if (!__WEB__) {
    return (
      <Badge variant={d < 0 ? 'destructive' : d <= DUE_RED ? 'warning' : 'muted'} className="tabular-nums">
        {label}
      </Badge>
    )
  }
  const tone =
    d < 0
      ? { bg: '#8C1D18', fg: '#FFFFFF' }
      : d <= DUE_RED
        ? { bg: '#B3261E', fg: '#FFFFFF' }
        : { bg: '#FFEDD0', fg: '#8A5300' }
  return (
    <span
      // Square, not rounded: a countdown is a marker, and a sharp block reads
      // as one where a rounded chip reads as a label.
      className="doc-ref inline-flex items-center whitespace-nowrap rounded-none px-2 py-[4px] text-[11px] font-extrabold tabular-nums"
      style={{ background: tone.bg, color: tone.fg }}
      title={
        d < 0
          ? 'Past maturity'
          : d <= DUE_RED
            ? `Due inside the week — ${d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`}`
            : 'More than a week out'
      }
    >
      {label}
    </span>
  )
}

// Awaiting = opened, the NBFC's money not in yet (amber), Live = funded and
// still owed (sky), Repaid = wound up (emerald) — the same left-border-plus-tint
// coding the LC register uses for its stages.
const STATUS_TONE: Record<string, { row: string; hover: string }> = {
  awaiting: { row: 'border-l-4 border-l-amber-400 [border-left-style:solid]', hover: 'hover:bg-amber-100/60' },
  live: { row: 'border-l-4 border-l-sky-400 [border-left-style:solid]', hover: 'hover:bg-sky-100/60' },
  open: { row: 'border-l-4 border-l-sky-400 [border-left-style:solid]', hover: 'hover:bg-sky-100/60' },
  repaid: { row: 'border-l-4 border-l-emerald-400 [border-left-style:solid]', hover: 'hover:bg-emerald-100/60' }
}

// The NBFC master, managed inline here the same way Banks.tsx wraps it as its
// own page — an NBFC carries its own default TDS/interest terms, each still
// overridable on any individual bill.
const NBFC_FIELDS: FieldDef[] = [
  { key: 'name', label: 'NBFC name', type: 'text', required: true },
  {
    key: 'finance_type',
    label: 'Provides',
    type: 'select',
    default: 'BOTH',
    options: [
      { value: 'PID', label: 'PID only (purchase invoices)' },
      { value: 'SID', label: 'SID only (sales invoices)' },
      { value: 'BOTH', label: 'Both PID and SID' }
    ]
  },
  { key: 'interest_pct', label: 'Interest % p.a.', type: 'number', default: 0 },
  { key: 'interest_days', label: 'Interest days (default tenor)', type: 'number', default: 0 },
  { key: 'tds_pct', label: 'TDS % on interest', type: 'number', default: 0 },
  { key: 'days_year', label: 'Days in year (360 / 365)', type: 'number', default: 360 },
  // Which end of the tenor earns interest. Stated as what is true when it is
  // ON, so the switch reads as a sentence rather than as a setting name.
  {
    key: 'days_incl_start',
    label: 'Interest counts the payment received date',
    type: 'switch',
    default: false
  },
  // What this NBFC has sanctioned. The limit lives here because this is who
  // sanctions it; the combined ceiling across every NBFC is set on the page.
  { key: 'sanctioned_limit', label: 'Sanctioned limit (₹)', type: 'number', default: 0 },
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

// AN NBFC IN ONE LINE, the way its terms are actually quoted.
//
// A lender is chosen BY its terms — "the 13.6 at 90 days" — so a picker that
// lists only names asks you to remember which is which, and a bill then gets
// the rate typed from memory over a prefill that was already correct. Written
// once here so the picker and the masters cards cannot describe the same NBFC
// differently.
function nbfcTerms(nb: Row): string {
  const bits: string[] = []
  if (n(nb.interest_pct) > 0) bits.push(`${formatNum(n(nb.interest_pct))}%`)
  if (n(nb.interest_days) > 0) bits.push(`${n(nb.interest_days)}d`)
  if (n(nb.tds_pct) > 0) bits.push(`TDS ${formatNum(n(nb.tds_pct))}%`)
  bits.push(`${n(nb.days_year) || 360}-day year`)
  return bits.join(' · ')
}

const NBFC_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'NBFC' },
  { key: 'finance_type', label: 'Provides' },
  { key: 'interest_pct', label: 'Int %', align: 'right' },
  { key: 'interest_days', label: 'Int days', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'days_year', label: 'Yr basis', align: 'right' },
  {
    key: 'days_incl_start',
    label: 'Receipt day',
    value: (r) => (r.days_incl_start ? 'counted' : 'from next day')
  },
  { key: 'active', label: 'Active', type: 'switch' }
]

// The same arithmetic the backend posts with, so the preview and the books
// never disagree. Mirrors the mill's working sheet:
//   open amount = total bills - margin
//   interest    = open amount x ROI x int days / (days-in-year x 100)
//   TDS         = interest x TDS%
//   net payout  = open amount - interest      (gross: the TDS is withheld out
//                                              of the interest, not refunded)
// With interest upfront the interest is settled separately instead, so the
// whole open amount lands and the payout is not reduced.
/**
 * WHERE A TRADING BILL STANDS ON THE MONEY COMING BACK.
 *
 * A bill discounted against a trading deal is a round trip: money goes out to
 * the NBFC and comes back from the customer who bought the goods. The register
 * reported the first leg in four columns and the second in nothing at all —
 * "has this one been paid back yet, and how?" meant opening the bill.
 *
 * Three states, and only for a bill that HAS a second leg:
 *   nothing received   — Awaiting Payment IN
 *   something received — Payment IN, with the route it came by
 *   not trading, or no receivable party named — no chip, because there is no
 *                        question to answer.
 */
function payInState(r: Row): { tone: 'awaiting' | 'in'; label: string; title: string } | null {
  if (String(r?.purpose || '') !== 'trading') return null
  if (!r?.receivable_party_id) return null
  const who = String(r.receivable_party_name || 'the customer')
  const got = n(r.payment_in_total)
  if (got <= 0) {
    return {
      tone: 'awaiting',
      label: 'Awaiting Payment IN',
      title: `Nothing received back from ${who} yet. Use Payment IN on this bill to record it.`
    }
  }
  // The routes it came by, so the chip answers "how" and not only "whether".
  // Several receipts by one route are one route; several routes are named.
  const ways = String(r.payment_in_methods || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const how = ways.length === 1 ? ways[0] : ways.length > 1 ? `${ways.length} ways` : ''
  const count = n(r.payment_in_count)
  return {
    tone: 'in',
    label: how ? `Payment IN · ${how}` : 'Payment IN',
    title:
      `${formatINR(got)} received back from ${who}` +
      (count > 1 ? ` across ${count} receipts` : '') +
      (ways.length ? ` — ${ways.join(', ')}` : '') +
      (r.payment_in_last_date ? `. Last on ${formatDate(r.payment_in_last_date)}.` : '.')
  }
}

/** Interest paid across during the tenor rather than withheld up front. */
function isServiced(r: Row): boolean {
  return String(r?.interest_mode || '') === 'serviced'
}

function bdCalc(f: Row): {
  serviced: boolean
  intDays: number
  marginAmount: number
  sanctionedAmount: number
  undrawnAmount: number
  openAmount: number
  interestBase: number
  interestAmount: number
  tdsAmount: number
  netInterest: number
  receiptAmount: number
  adjCharge: number
} {
  // INTEREST SERVICED OVER THE TENOR IS NOT WITHHELD FROM THE DISBURSEMENT.
  //
  // It is paid periodically while the bill runs, so the NBFC keeps nothing
  // out of what it sends — the whole open amount lands, exactly as it does
  // when the interest is settled upfront. The register was deducting it here
  // and reporting a receipt smaller than the one that reached the bank.
  const serviced = String(f.interest_mode || '') === 'serviced'
  // What is drawn: the Open ₹ figure itself. The Adj. ₹ beside it does not
  // move it — interest runs on the whole Open amount — it only changes what
  // reaches the bank (a minus is the NBFC's own charge). Mirrors bdCalc's
  // open_adj_charge basis in billDiscounting.ts.
  const amount = round2(n(f.amount))
  const adjCharge = round2(n(f.open_adj))
  // The invoice as adjusted (Adj. ₹ beside it) — see bdCalc in billDiscounting.ts.
  const invoice = n(f.invoice_amount) > 0 ? Math.max(0, round2(n(f.invoice_amount) + n(f.invoice_adj))) : 0
  const from = String(f.payment_received_date || '').slice(0, 10)
  const to = String(f.maturity_date || '').slice(0, 10)
  // Mirrors bdCalc: with days_incl_start the receipt date earns interest too,
  // so 1 to 30 September is 30 days rather than 29.
  const intDays =
    from && to ? Math.max(0, (daysTo(to) ?? 0) - (daysTo(from) ?? 0) + (f.days_incl_start ? 1 : 0)) : 0
  // Mirrors bdCalc: the margin is struck on the INVOICE being discounted and
  // what is left is sanctioned. A bill with no invoice value on record falls
  // back to the amount, which is the old behaviour exactly.
  const marginBase = invoice > 0 ? invoice : amount
  const marginAmount = round2((marginBase * n(f.margin_pct)) / 100)
  const sanctionedAmount = round2(marginBase - marginAmount)
  const drawn = invoice > 0 ? amount : sanctionedAmount
  const undrawnAmount = round2(sanctionedAmount - drawn)
  const openAmount = drawn
  const daysYear = n(f.days_year) || 360
  // What the interest runs on: the Open amount, or — when the bill says the
  // NBFC charges interest after its own Adj. — the Open amount after it.
  // Mirrors bdCalc's interestBase in billDiscounting.ts.
  const interestBase = f.interest_after_adj ? Math.max(0, round2(openAmount + adjCharge)) : openAmount
  const interestAmount = round2((interestBase * n(f.interest_pct) * intDays) / (100 * daysYear))
  const tdsAmount = round2((interestAmount * n(f.tds_pct)) / 100)
  const netInterest = round2(interestAmount - tdsAmount)
  const receiptAmount = round2((f.interest_upfront || serviced ? openAmount : openAmount - interestAmount) + adjCharge)
  return {
    serviced,
    intDays,
    marginAmount,
    sanctionedAmount,
    undrawnAmount,
    openAmount,
    interestBase,
    interestAmount,
    tdsAmount,
    netInterest,
    receiptAmount,
    adjCharge
  }
}

// The company controls come from Treasury, which already holds them for the LC
// form. A discounted bill is booked into ONE company's books and draws on that
// company's invoices, so the company has to be settable without leaving the
// form — the same way opening an LC does it.
// One figure in the derived strip: what it is, what it comes to, and a word on
// why. Read-only by construction — there is no input here to mistake for one.
function Derived({
  label,
  value,
  hint,
  strong,
  tone
}: {
  label: string
  value: string
  hint?: string
  strong?: boolean
  tone?: 'bad'
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground',
          __WEB__ && '!font-extrabold !tracking-[.1em] !text-[#5A6B62]'
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          'whitespace-nowrap tabular-nums',
          strong ? 'text-[15px] font-bold' : 'text-[13px] font-semibold',
          tone === 'bad' ? 'text-amber-700' : 'text-[#1a2c56]',
          // The strip was the last thing in the drawer still set in the
          // desktop app's navy, beside figures the rest of the website sets
          // in doc-ref. Same ink, same digits, same tracking as the receipt
          // below it — it is the same arithmetic, read twice.
          __WEB__ &&
            cn('doc-ref !mt-[3px] !tracking-[-0.02em]', tone === 'bad' ? '!text-[#8A5300]' : '!text-[#0A1F17]')
        )}
      >
        {value}
      </div>
      {hint && (
        <div
          className={cn(
            'text-[9.5px] leading-tight text-muted-foreground',
            __WEB__ && '!mt-[3px] !text-[10.5px] !font-semibold !text-[#5A6B62]'
          )}
        >
          {hint}
        </div>
      )}
    </div>
  )
}

// A SECTION OF THE BILL, NUMBERED, WITH A TICK ONCE IT IS ANSWERED.
// The drawer is long; the numbers say where you are in it, and the tick says
// which parts are done without reading every field again.
// The line under the name says what the section decides, in plain words, so
// the four headings read as the bill's outline before a field is touched.
function StepTitle({
  n: no,
  done,
  sub,
  children
}: {
  n: number
  done?: boolean
  sub?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        className="doc-ref flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold tracking-normal"
        style={done ? { background: '#12855A', color: '#fff' } : { background: '#EEF3EC', color: '#33473E' }}
      >
        {done ? <Check className="h-[15px] w-[15px]" /> : no}
      </span>
      <span className="min-w-0">
        <span className="block">{children}</span>
        {sub && (
          <span className="mt-0.5 block text-[11px] font-semibold normal-case tracking-normal text-[#5A6B62]">{sub}</span>
        )}
      </span>
    </span>
  )
}

// THE BILL FORM'S CARDS, from the canvas: a white card on a 10px radius with a
// soft lift, and a gradient strip carrying the step. The card is NOT clipped —
// a list dropping out of a field inside it would be cut at the card's edge — so
// the strip rounds its own top corners instead.
const BD_CARD =
  '!overflow-visible !rounded-[10px] !border-[#DCE7DB] !bg-white !p-0 !shadow-[0_1px_2px_rgba(10,31,23,.04),0_10px_26px_-18px_rgba(10,31,23,.2)]'
const BD_CARD_HEAD =
  '!mb-0 !rounded-t-[10px] !border-b !border-solid !border-b-[#EAF0E9] !bg-[linear-gradient(180deg,#FBFDFA,#F4F7F2)] !px-4 !py-3 !text-[11px] !font-extrabold !tracking-[.13em] !text-[#0A1F17]'

// A YES-OR-NO THAT SAYS WHAT IT DOES. The whole card is the switch, so it is a
// target the width of the column rather than a 38px track; the line under the
// name changes with the answer, and the info mark keeps the long explanation
// out of the way. `lime` is the canvas's tone for a setting that moves the sum.
function SwitchCard({
  on,
  onChange,
  title,
  sub,
  subTone,
  note,
  tone = 'forest'
}: {
  on: boolean
  onChange: (v: boolean) => void
  title: string
  sub?: string
  subTone?: 'good'
  note?: string
  tone?: 'forest' | 'lime'
}): React.JSX.Element {
  const lime = tone === 'lime'
  return (
    <div
      role="switch"
      aria-checked={on}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onChange(!on)
        }
      }}
      className="flex min-h-[48px] cursor-pointer select-none items-center gap-[11px] rounded-[8px] border px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0B3D2E]/30"
      style={
        on
          ? { background: lime ? '#F3FBE2' : '#EFF5EC', borderColor: lime ? '#CDE89A' : '#C7D9C3' }
          : { background: lime ? '#fff' : '#F7FAF6', borderColor: lime ? '#DCE7DB' : '#E4ECE3' }
      }
    >
      <span
        className="flex h-[22px] w-[38px] flex-none rounded-full p-[3px] transition-colors"
        style={{ background: on ? (lime ? '#12855A' : '#0B3D2E') : '#C3D2C6', justifyContent: on ? 'flex-end' : 'flex-start' }}
      >
        <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px] leading-[1.35] text-[#0A1F17] [text-wrap:pretty]', sub ? 'font-extrabold' : 'font-bold')}>
          {title}
        </span>
        {sub && (
          <span
            className="mt-0.5 block text-[10.5px] font-semibold leading-[1.4] [text-wrap:pretty]"
            style={{ color: subTone === 'good' ? '#0B6B45' : '#5A6B62' }}
          >
            {sub}
          </span>
        )}
      </span>
      {note && (
        // Its own click: opening the explanation must not flip the switch.
        <span className="ml-auto shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <HelpTip className={TIP_MARK} text={note} />
        </span>
      )}
    </div>
  )
}

// The minus and the equals between them, so it reads as a sum.
function Op({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className={cn(
        'self-center pt-1 text-[15px] font-semibold text-muted-foreground',
        __WEB__ && 'doc-ref !pt-0 !font-bold !text-[#8A8471]'
      )}
    >
      {children}
    </div>
  )
}

// The four breakdown cells under the headline. Left-aligned for the same
// reason the LC facility cells are: centred, a row of figures starts at a
// different x in every cell and cannot be read down the row.
const BD_CELL = __WEB__ ? '!bg-white !px-4 !py-[13px] !text-left' : ''
// The label was 9px — smaller than anything else on the page and set in caps,
// which is the combination that reads as fine print rather than as a heading.
const BD_K = __WEB__ ? '!text-[10px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]' : ''
// The figure is what the cell is for, so it gets the room: 18px, tabular, and
// tightened, the same treatment the Stock KPI cards give theirs. At 14.5px it
// was competing with its own caption.
const BD_V = __WEB__
  ? 'doc-ref !mt-[5px] !whitespace-nowrap !text-[18px] !font-bold !tracking-[-0.02em] !text-[#0A1F17]'
  : ''
const BD_SUB = __WEB__ ? '!mt-[3px] !text-[11.5px] !font-semibold !leading-[1.45] !text-[#5A6B62]' : ''

// The register's chrome. A sticky header composites each of its own cells, so
// the forest has to be set on every one of them, not on the row alone.
const BD_HEAD = __WEB__
  ? '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&>th]:!h-auto [&>th]:!bg-[#0B3D2E] [&>th]:!py-2.5 [&>th]:!py-3 [&>th]:!text-[12.5px] [&>th]:!font-bold [&>th]:!tracking-[.02em] [&>th]:!normal-case [&>th]:!text-white [&>th]:!border-r-[#C7F03F]/15'
  : ''
// The body's column washes, from the handoff. The dated middle of the row —
// validity, days left, the interest arithmetic — sits on a near-white so it
// reads as working, and Receipt takes the pale green because it is the one
// figure the register exists to report: what actually reached the account.
// The filter tray, from the handoff. A pale sage tray with the live chip
// lifted out of it in forest — the same object the Stock page uses, so a
// reader moving between registers is not learning a second control. It
// replaces round navy pills that matched nothing else on the site.
const BD_TRAY = __WEB__
  ? '!gap-[3px] !rounded-[4px] !border !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]'
  : ''
const BD_CHIP = __WEB__ ? '!h-[34px] !rounded-[2px] !border-0 !px-3 !py-0 !text-[12px] !leading-none' : ''
const BD_CHIP_ON = __WEB__ ? '!bg-[#0B3D2E] !font-extrabold !text-white' : ''
const BD_CHIP_OFF = __WEB__
  ? '!bg-transparent !font-bold !text-[#5A6B62] hover:!bg-white/70 hover:!text-[#0A1F17]'
  : ''

const BD_W = __WEB__ ? '!bg-[#FCFDFB]' : ''
// EVERY TREASURY FORM ARRIVES FROM THE RIGHT.
// ---------------------------------------------------------------------------
// A centred modal covers the register it was opened from and floats with no
// fixed edge, so a long form reads as a slab dropped over the page. A panel
// hinged on the right edge keeps the list it belongs to in view down the left,
// always opens in the same place, and gives the form a full column of height —
// header pinned at the top, actions pinned at the bottom, only the middle
// scrolling. It is the shape the bargain drawer and the history panel already
// use, so Treasury now matches them rather than being the one screen that
// behaves differently.
//
// Width is per-form: `w` is whatever that form's densest row needs.
// TWO CHOICES ARE A SEGMENT, NOT A DROPDOWN.
// ---------------------------------------------------------------------------
// The canvas states both of this form's binary choices as a pair of buttons,
// and it is right to: a dropdown hides half the answer behind a click, and at
// this width it could not even show the half it had — "PID — PURCH…",
// "MANUFACTUR…". Both options fit side by side and the choice is readable
// without opening anything.
// A FIGURE THE FIELD WORKS OUT ABOUT ITSELF.
//
// Some inputs carry a fact that is derived from what is typed in them — what
// share of the invoice is being drawn, here. Written underneath, it becomes a
// third line in a field that already has two, and the row it sits in grows a
// step taller than its neighbours for one product of arithmetic.
//
// So it goes INSIDE the field, at the trailing edge: the value it describes is
// an arm's length away, and the row keeps one height.
//
// In flow, never positioned over the input. A chip absolutely placed on top
// needs the input padded by exactly its width, and the width changes with the
// text — "53.22% of bill" and "over invoice" are not the same size — so the
// digits slide under it on the longer one. A flex row cannot overlap.
function FieldChip({
  children,
  tone = 'plain'
}: {
  children: React.ReactNode
  tone?: 'plain' | 'warn'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        // The canvas's chip: 2px radius, 10px, 700, 2px/6px of padding.
        'doc-ref ml-2 shrink-0 whitespace-nowrap rounded-[2px] px-[6px] py-[2px] text-[10px] font-bold tabular-nums',
        tone === 'warn' ? 'bg-[#FFEDD0] text-[#8A5300]' : 'bg-[#EAF0FA] text-[#1B4E82]'
      )}
    >
      {children}
    </span>
  )
}

// The frame a field wears when it holds a chip as well as a value. The border
// moves off the <input> and onto this, so the two read as one control.
const FIELD_WRAP =
  'flex h-11 w-full items-center rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] focus-within:border-[#0B3D2E]'
// The same frame at the bill form's size — 40px on a 7px radius, with the
// canvas's faint inset — so a framed field matches the plain ones beside it.
const FIELD_WRAP_BD =
  'flex h-10 w-full items-center rounded-[7px] border border-[#C3D2C6] bg-white pl-[11px] pr-1 shadow-[inset_0_1px_2px_rgba(10,31,23,.04)] focus-within:border-[#0B3D2E]'
//
// Worn with data-raw, which takes the input out of the drawer's own field rule
// — so this has to carry the type as well as the undressing, since there is no
// longer anything else setting it.
const FIELD_BARE = [
  '!h-auto !min-w-0 !flex-1 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none',
  '!text-[13px] !font-bold !text-[#0A1F17] placeholder:!font-semibold placeholder:!text-[#9FB3A6]',
  'focus-visible:!outline-none focus-visible:!ring-0'
].join(' ')
// Tabular figures, so the four money boxes line up with each other across the
// row rather than wandering by digit width.
const FIELD_FIG = 'doc-ref'

function Seg({
  value,
  options,
  onChange,
  className,
  fill,
  soft
}: {
  value: string
  options: { v: string; label: string }[]
  onChange: (v: string) => void
  className?: string
  /** Stretch to the column rather than hugging the labels. */
  fill?: boolean
  /** The bill form's rounder tray (8px, 2px inset), from its canvas. */
  soft?: boolean
}): React.JSX.Element {
  return (
    <div
      data-fill={fill ? 'true' : undefined}
      data-soft={soft ? 'true' : undefined}
      className={cn(
        // Hugs its labels, as the canvas draws it — a two-word choice
        // stretched across 650px reads as a toolbar, not as one field. The
        // fixed height is what keeps it level with the inputs beside it.
        'inline-flex h-[38px] w-auto max-w-full items-stretch gap-[3px] self-start rounded-[5px] border border-[#CFDCD2] bg-[#EDF2EA] p-[3px]',
        // Given a column of its own size, it takes it — see the note on the
        // first card's grid. `fill` is opt-in so the switches elsewhere in the
        // drawer keep hugging their labels.
        'data-[fill=true]:!flex data-[fill=true]:!w-full data-[fill=true]:[&>button]:!flex-1',
        'data-[soft=true]:!h-[38px] data-[soft=true]:!gap-[2px] data-[soft=true]:!rounded-[8px] data-[soft=true]:!border-[#DCE7DB] data-[soft=true]:!bg-[#EEF3EC] data-[soft=true]:!p-[2px]',
        'data-[soft=true]:[&>button]:!rounded-[6px] data-[soft=true]:[&>button]:!px-4 data-[soft=true]:[&>button]:!text-[12px] data-[soft=true]:[&>button]:!font-extrabold data-[soft=true]:[&>button]:whitespace-nowrap',
        className
      )}
    >
      {options.map((o) => {
        const on = String(value) === o.v
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={cn(
              // 38px inside a 3px tray is a 44px control — the same height as
            // every input beside it, so a row of them shares one baseline.
            'flex min-w-0 items-center justify-center rounded-[3px] px-[18px] text-[11.5px] font-bold tracking-[.01em] transition-colors',
              on
              ? 'bg-[#0B3D2E] text-white shadow-[0_1px_2px_rgba(10,31,23,.18)]'
              : 'text-[#6B7C73] hover:text-[#0A1F17]'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// THE MARK THAT OPENS AN EXPLANATION.
// A bare 14px glyph at 40% grey reads as a smudge next to a caption, and a
// thing nobody can see is not a thing anybody clicks. Given the outline and
// the ground of a control — an 18px round chip — it reads as something to
// press, and it darkens to the forest on hover like every other control here.
const TIP_MARK =
  '!inline-flex !h-[18px] !w-[18px] !shrink-0 !items-center !justify-center !rounded-full !border !border-[#C3D2C6] !bg-white !text-[#5A6B62] hover:!border-[#0B3D2E] hover:!bg-[#EAF0E9] hover:!text-[#0B3D2E] [&>svg]:!h-[11px] [&>svg]:!w-[11px]'

// A BUTTON THE SIZE OF A CHIP.
// Square, 30px, and worn INSIDE a field or a figure's own cell — an action
// that belongs to one number rather than to the form. Full balance and Draw
// it all are the same gesture against different figures, so they are the same
// object.
const CHIP_BTN =
  'flex h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[2px] border px-[9px] text-[11px] font-extrabold transition-colors'
const CHIP_BTN_PLAIN = 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#EAF0E9] hover:text-[#0A1F17]'
const CHIP_BTN_DONE = 'border-[#C6DAF0] bg-[#EAF0FA] text-[#1B4E82]'

// The small print under a field, in the site's own muted type.
const HINT = __WEB__ ? '!rounded-[4px] !border !border-dashed !border-[#C3D2C6] !bg-white !px-3 !py-2.5 !text-[12px] !font-semibold !text-[#5A6B62]' : ''

const bdDrawer = (w: string): string =>
  __WEB__
    ? [
        '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !max-w-[96vw]',
        w,
        '!translate-x-0 !translate-y-0 !grid !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0',
        '!overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none',
        // The canvas's own drawer shadow, so the panel sits ON the page
        // rather than being cut out of it.
        '!shadow-[-16px_0_40px_rgba(10,31,23,.24)]',
        '[&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
      ].join(' ')
    : ''

// THE DRAWER'S FIELD DRESS, written once.
// ---------------------------------------------------------------------------
// SCOPED, because a descendant selector is not a component. `[&_label]` — 16px
// tall, uppercase, overflow-hidden, nowrap — is exactly right for a field's
// CAPTION and ruinous for anything else that happens to be a <label>. It was
// flattening the term switches into a 16px line of grey caps with their border
// and their ground gone, clipping "Interest serviced over the tenor" to
// "INTEREST SERVICED OVER TH…", and squeezing every row of the trading invoice
// picker into the same 16px. `[&_input]` did the matching damage on the other
// side: a tick box stretched to the 44px of a text field is a sliver.
//
// So both rules now step over anything marked data-raw, and over the tick
// boxes, and those two dress themselves.
//
// data-raw on an INPUT matters for a second reason: a field that lives inside
// a frame of its own — the drawn amount, which carries a chip beside it —
// cannot take this rule's 44px height and 11px padding a second time. It did,
// and the result was a 44px white box sitting inside a 44px bordered one,
// covering the frame's top and bottom edge: the field looked as though its
// outline had been rubbed out across the digits. Specificity, not order:
// `[&_input…]` is (0,2,1) and `!p-0` is (0,1,0), so !important never came into
// it. See FIELD_BARE.
const BD_FIELDS = __WEB__
  ? [
      '!flex !min-h-0 !flex-col !gap-3.5 !overflow-y-auto [&>*]:!shrink-0',
      '[&_label:not([data-raw])]:!flex [&_label:not([data-raw])]:!h-[15px] [&_label:not([data-raw])]:!items-center [&_label:not([data-raw])]:!gap-1 [&_label:not([data-raw])]:!overflow-hidden [&_label:not([data-raw])]:!whitespace-nowrap [&_label:not([data-raw])]:!text-[10px] [&_label:not([data-raw])]:!font-extrabold [&_label:not([data-raw])]:!uppercase [&_label:not([data-raw])]:!tracking-[.12em] [&_label:not([data-raw])]:!text-[#5A6B62]',
      '[&_input:not([type=checkbox]):not([data-raw])]:!h-11 [&_input:not([type=checkbox]):not([data-raw])]:!rounded-[4px] [&_input:not([type=checkbox]):not([data-raw])]:!border-[#C3D2C6] [&_input:not([type=checkbox]):not([data-raw])]:!bg-white [&_input:not([type=checkbox]):not([data-raw])]:!px-[11px] [&_input:not([type=checkbox]):not([data-raw])]:!text-[13px] [&_input:not([type=checkbox]):not([data-raw])]:!font-bold [&_input:not([type=checkbox]):not([data-raw])]:!text-[#0A1F17] [&_input:not([type=checkbox]):not([data-raw])]:!shadow-none [&_input:not([type=checkbox]):not([data-raw])]:focus-visible:!border-[#0B3D2E] [&_input:not([type=checkbox]):not([data-raw])]:focus-visible:!ring-0 [&_input:not([type=checkbox]):not([data-raw])]:placeholder:!font-semibold [&_input:not([type=checkbox]):not([data-raw])]:placeholder:!text-[#9FB3A6]',
      '[&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!px-[11px] [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=select-trigger]]:!normal-case',
      // A PICKED OPTION IS NOT THE WHOLE OPTION.
      // Radix shows the selected item's own markup in the trigger, so the
      // NBFC's two-line entry — name, what it provides, its terms — arrived in
      // a 44px box and overflowed it, with the terms line cut mid-figure at
      // "· 3". The list keeps its detail; the trigger keeps the name.
      '[&_[data-slot=select-trigger]_[data-detail]]:!hidden',
      // The list reads at the same weight the trigger does. A value that
      // changes weight the moment it is chosen reads as a different value.
      '[&_[data-slot=select-option]]:!text-[12.5px] [&_[data-slot=select-option]]:!font-semibold [&_[data-slot=select-option]]:!text-[#0A1F17]',
      // The two greys that were still the app's cool slate beside the canvas's
      // warm one: the ℹ beside every caption, and a trigger with nothing picked
      // yet — which should sit at the same weight as an empty input's
      // placeholder, since that is what it is.
      // :hover inside the bracket, not after it — outside, Tailwind hangs it on
      // the CONTAINER and every ℹ in the drawer darkens whenever the pointer is
      // anywhere in the form.
      '[&_button:has(.lucide-info)]:!text-[#8FA79B] [&_button:has(.lucide-info):hover]:!text-[#0B3D2E]',
      '[&_[data-slot=select-trigger]_.text-muted-foreground]:!font-medium [&_[data-slot=select-trigger]_.text-muted-foreground]:!text-[#8FA79B]',
      '[&_[data-slot=date-picker]]:!h-11 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!px-[11px] [&_[data-slot=date-picker]]:!text-[13.5px] [&_[data-slot=date-picker]]:!font-medium',
      // A caption sits 6px clear of what it names — the canvas's own gap, and
      // tighter than the 14px the drawer's column gap was giving it.
      '[&_label:not([data-raw])+*]:!mt-1.5'
    ].join(' ')
  : ''

// THE BILL FORM'S FIELD DRESS — BD_FIELDS at its canvas's size: 40px fields on
// a 7px radius with a faint inset, and 9.5px captions. Written out in full,
// because Tailwind only builds a class whose whole name is in the source; the
// other drawers keep BD_FIELDS as it was.
const BD_FORM_FIELDS = __WEB__
  ? [
      '!flex !min-h-0 !flex-col !gap-3 !overflow-y-auto [&>*]:!shrink-0',
      '[&_label:not([data-raw])]:!flex [&_label:not([data-raw])]:!h-[15px] [&_label:not([data-raw])]:!items-center [&_label:not([data-raw])]:!gap-1 [&_label:not([data-raw])]:!overflow-hidden [&_label:not([data-raw])]:!whitespace-nowrap [&_label:not([data-raw])]:!text-[9.5px] [&_label:not([data-raw])]:!font-extrabold [&_label:not([data-raw])]:!uppercase [&_label:not([data-raw])]:!tracking-[.12em] [&_label:not([data-raw])]:!text-[#5A6B62]',
      '[&_input:not([type=checkbox]):not([data-raw])]:!h-10 [&_input:not([type=checkbox]):not([data-raw])]:!rounded-[7px] [&_input:not([type=checkbox]):not([data-raw])]:!border-[#C3D2C6] [&_input:not([type=checkbox]):not([data-raw])]:!bg-white [&_input:not([type=checkbox]):not([data-raw])]:!px-[11px] [&_input:not([type=checkbox]):not([data-raw])]:!text-[13px] [&_input:not([type=checkbox]):not([data-raw])]:!font-bold [&_input:not([type=checkbox]):not([data-raw])]:!text-[#0A1F17] [&_input:not([type=checkbox]):not([data-raw])]:!shadow-[inset_0_1px_2px_rgba(10,31,23,.04)] [&_input:not([type=checkbox]):not([data-raw])]:focus-visible:!border-[#0B3D2E] [&_input:not([type=checkbox]):not([data-raw])]:focus-visible:!ring-0 [&_input:not([type=checkbox]):not([data-raw])]:placeholder:!font-semibold [&_input:not([type=checkbox]):not([data-raw])]:placeholder:!text-[#9FB3A6]',
      '[&_[data-slot=select-trigger]]:!h-10 [&_[data-slot=select-trigger]]:!rounded-[7px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!px-[11px] [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-extrabold [&_[data-slot=select-trigger]]:!normal-case [&_[data-slot=select-trigger]]:!text-left',
      '[&_[data-slot=select-trigger]_[data-detail]]:!hidden',
      '[&_[data-slot=select-option]]:!text-[12.5px] [&_[data-slot=select-option]]:!font-semibold [&_[data-slot=select-option]]:!text-[#0A1F17]',
      '[&_button:has(.lucide-info)]:!text-[#8FA79B] [&_button:has(.lucide-info):hover]:!text-[#0B3D2E]',
      '[&_[data-slot=select-trigger]_.text-muted-foreground]:!font-medium [&_[data-slot=select-trigger]_.text-muted-foreground]:!text-[#8FA79B]',
      '[&_[data-slot=date-picker]]:!h-10 [&_[data-slot=date-picker]]:!rounded-[7px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!px-[11px] [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-semibold',
      '[&_label:not([data-raw])+*]:!mt-1.5'
    ].join(' ')
  : ''

const BD_WR = __WEB__ ? '!bg-[#F7FBF4]' : ''
// THE GRID, WEIGHTED.
//
// Rows and columns were ruled in the same #EAF0E9, so the register read as a
// flat mesh and the eye had nothing to follow across a row of eleven figures.
// A table is read ALONG the row — one bill at a time — so the row rule is a
// step darker and carries the reading, while the column rule drops back to
// barely-there: enough to group the washed money columns, not enough to
// compete. Two weights, one grid.
// Written out rather than built from a constant: Tailwind generates a class
// only if the whole name appears in the source, so `border-l-[${x}]` compiles
// to nothing at all.
//   row rule 2px #E8EFE7 · column rule 1px #F0F5EF
const BD_RULE = __WEB__ ? '!border-l !border-l-[#F0F5EF]' : ''

// WHICH SIDE OF THE BOOK A BILL SITS ON.
//
// PID is a purchase invoice discounted — money going out against something
// bought. SID is a sales invoice — money coming in against something sold.
// They were both the same grey pill, so the one thing that decides how to read
// the whole row had to be spelled out and read. Two colours, square like the
// countdown: blue for the buying side, green for the selling side, the same
// two hues this app uses for money out and money in everywhere else.
const FIN_TONE: Record<string, { bg: string; fg: string; what: string }> = {
  PID: { bg: '#EAF0FA', fg: '#1B4E82', what: 'Purchase Invoice Discounting — drawn against a bill we owe' },
  SID: { bg: '#E9F5EE', fg: '#0B6B45', what: 'Sales Invoice Discounting — drawn against a bill owed to us' }
}
function FinChip({ type }: { type: unknown }): React.JSX.Element {
  const k = String(type || '').toUpperCase()
  const t = FIN_TONE[k]
  if (!__WEB__ || !t) return <Badge variant="muted">{String(type || '')}</Badge>
  return (
    <span
      className="doc-ref inline-flex flex-none items-center rounded-none px-1.5 py-[3px] text-[10px] font-extrabold uppercase tracking-[.07em]"
      style={{ background: t.bg, color: t.fg }}
      title={t.what}
    >
      {k}
    </span>
  )
}
const BD_NUM = __WEB__ ? 'doc-ref !text-[12.5px] !font-bold' : ''

const BD_TOTAL = __WEB__
  ? '!border-b-2 !border-b-[#C7F03F] !bg-[#EFF5EC] hover:!bg-[#EFF5EC] [&>td]:!py-3 [&>td]:!text-[13px] [&>td]:!font-bold [&>td]:!text-[#0A1F17]'
  : ''

// What the Payment tracker can ask this tab to open on a bill.
export type BdFocusAction = 'open' | 'repay' | 'interest' | 'payin'

function RefundDueChip({ tot }: { tot?: { booked: number; refunded: number; due: number } }): React.JSX.Element | null {
  // EXCESS PAID TO THE BANK — marked for good, not only while it is owed:
  // red with "refund due" until the refund is in, then "refunded".
  if (!tot || tot.booked <= 0.004) return null
  const owed = tot.due > 0.004
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-[1px] text-[10.5px] font-extrabold uppercase tracking-[.04em]',
        owed ? 'border-[#F0C4C0] bg-[#FDECEA] text-[#B3261E]' : 'border-[#F0C4C0] bg-white text-[#B3261E]'
      )}
      title={
        owed
          ? `Paid ${formatINR(tot.booked)} over the balance — ${formatINR(tot.due)} still due back from the bank. ⋮ → Refund received when it comes in.`
          : `Paid ${formatINR(tot.booked)} over the balance — refunded in full.`
      }
    >
      Excess paid {formatINR(tot.booked)}
      <span className={cn('font-bold normal-case', owed ? '' : 'text-[#0B6B45]')}>
        · {owed ? (tot.due < tot.booked - 0.004 ? `${formatINR(tot.due)} due` : 'refund due') : 'refunded'}
      </span>
    </span>
  )
}

export function BillDiscounting({
  companies = [],
  activeCompany = 0,
  onCompanyChange,
  // The lender in view, chosen in the page header. A discounted bill is against
  // an NBFC, not a bank, which is what that picker names on this tab.
  nbfcFilter = [],
  onNbfcsLoaded,
  // The maturity warnings for this tab. They used to float above the register
  // in a strip of their own, which put a line between the page header and the
  // thing it heads — and left the register's own header row half empty. They
  // belong on that row, beside the actions they would send you to.
  alerts = [],
  onOpenAlert,
  // Arrived from a voucher on a ledger: open that bill's drawer. From the
  // Payment tracker, focusAction names the screen to open on it instead.
  focusId = null,
  focusAction = 'open',
  onFocusHandled
}: {
  companies?: Row[]
  activeCompany?: number
  onCompanyChange?: (id: string) => void
  nbfcFilter?: string[]
  onNbfcsLoaded?: (rows: Row[]) => void
  alerts?: { key: string; label: string; tone: string; icon: React.ComponentType<{ className?: string }>; count: number }[]
  onOpenAlert?: (key: string) => void
  focusId?: number | null
  focusAction?: BdFocusAction
  onFocusHandled?: () => void
} = {}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  // WHO GETS TO SEE HOW FAR THE MONEY HAS COME BACK.
  //
  // The chip is a standing tally of which trading bills are still owed — the
  // view an administrator keeps to check the desk's work, which is not the
  // same as the view the desk needs to do it. Recording a receipt is
  // untouched either way; only the tally can be kept back.
  const [payInChipEveryone, setPayInChipEveryone] = useState(true)
  const iAmAdmin = loadUser()?.role === 'admin'
  const [nbfcs, setNbfcs] = useState<Row[]>([])
  // The kinds of charge an Adj. can be — the usual ones plus any added.
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([])
  useEffect(() => {
    void window.api.billDiscounting
      .chargeTypes()
      .then(setChargeTypes)
      .catch(() => setChargeTypes([]))
  }, [])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])

  const [view, setView] = useState<'cards' | 'table'>('table')
  const [duePeriod, setDuePeriod] = useState('all')
  // Open bills are what the desk works on day to day, so the register lands on
  // them rather than on All (which drags in everything already repaid).
  const [statusFilter, setStatusFilter] = useState<'all' | 'awaiting' | 'live' | 'repaid'>('live')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  // The parties ticked in the Party column's own funnel. Empty means every
  // party, the same convention every other filter here uses. A bill can name
  // several, so it stays in view when any one of them is ticked.
  const [partyFilter, setPartyFilter] = useState<string[]>([])
  // The bill numbers ticked in the BD no column's own funnel. Empty means all.
  const [bdNoFilter, setBdNoFilter] = useState<string[]>([])

  const [form, setForm] = useState<Row | null>(null)
  // The form as it opened, so Esc can tell a changed form from an untouched one.
  const formWas = useRef('')
  useEffect(() => {
    if (!form) formWas.current = ''
    else if (!formWas.current) formWas.current = JSON.stringify(form)
  }, [form])
  const [saving, setSaving] = useState(false)
  const [nbfcOpen, setNbfcOpen] = useState(false)
  // Which bill is opened out. One at a time: the panel is tall, and two open
  // at once turns a register into a list of essays.
  // WHICH BILL IS OPEN, and its interest schedule.
  //
  // An id rather than a copy of the row: the register reloads on a timer and
  // after every save, and a panel holding its own snapshot would go on showing
  // figures the register had already moved past.
  const [openBd, setOpenBd] = useState(0)
  const [openBdInterest, setOpenBdInterest] = useState<Row[]>([])
  // Open the bill a ledger line pointed at, once, and hand the request back so
  // returning to this tab later does not reopen it.
  // A screen asked for by the Payment tracker waits for the register to hold
  // the bill — the dialogs work off the register's own row, figures and all.
  const [focusAct, setFocusAct] = useState<{ id: number; action: BdFocusAction } | null>(null)
  useEffect(() => {
    const want = Number(focusId) || 0
    if (!want) return
    if (focusAction && focusAction !== 'open') setFocusAct({ id: want, action: focusAction })
    else setOpenBd(want)
    onFocusHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])
  // And what has actually been paid back on it, payment by payment. Same rule
  // as the schedule below: fetched with the bill, dropped when it closes.
  const [openBdParts, setOpenBdParts] = useState<Row[]>([])
  // Bumped when a repayment is saved or removed, so the panel behind the dialog
  // re-reads. The register's own live refresh cannot stand in for this: it
  // returns the same bills every few seconds, and keying the fetch on it would
  // re-read the list on a timer for no reason.
  const [bdRev, setBdRev] = useState(0)
  // The schedule belongs to the bill, so it is fetched when one is opened and
  // dropped when it closes — a register of two hundred bills must not carry
  // two hundred schedules it will never show.
  useEffect(() => {
    if (!openBd) {
      setOpenBdInterest([])
      setOpenBdParts([])
      return
    }
    let alive = true
    void window.api.billDiscounting
      .interestSchedule(openBd)
      .then((x: Row[]) => alive && setOpenBdInterest(Array.isArray(x) ? x : []))
      .catch(() => alive && setOpenBdInterest([]))
    void window.api.billDiscounting
      .repayments(openBd)
      .then((x: Row[]) => alive && setOpenBdParts(Array.isArray(x) ? x : []))
      .catch(() => alive && setOpenBdParts([]))
    return () => {
      alive = false
    }
    // `bdRev` ticks after a repayment is saved, so the panel behind the dialog
    // shows the payment that was just made rather than the list as it was when
    // the bill was opened.
  }, [openBd, bdRev])
  // Type-to-find over the register. Website only — the desktop has its own
  // filtering habits and no room on that row for a field.
  const [bdQuery, setBdQuery] = useState('')
  const [repayRow, setRepayRow] = useState<Row | null>(null)
  // "Disbursement paid to" on its own — the one thing a repaid bill may still
  // change (setBdDisbursementRoute).
  const [routeRow, setRouteRow] = useState<Row | null>(null)
  // Paid the NBFC over a bill's balance: what it still owes back, per bill.
  const [bdRefundDue, setBdRefundDue] = useState<Record<string, number>>({})
  const [refundBd, setRefundBd] = useState<number | null>(null)
  const [bdRefundTot, setBdRefundTot] = useState<Record<string, { booked: number; refunded: number; due: number }>>({})
  useEffect(() => {
    void Promise.all([window.api.billDiscounting.refundDues().then(setBdRefundDue), window.api.billDiscounting.refundTotals().then(setBdRefundTot)]).catch(() => undefined)
  }, [rows])
  const [routeVal, setRouteVal] = useState('')
  const [routeAcct, setRouteAcct] = useState('')
  const [routeSaving, setRouteSaving] = useState(false)
  // Supplier direct: who the NBFC paid, and how much each — one row per supplier.
  const [routeShares, setRouteShares] = useState<{ party_id: string; amount: string }[]>([])
  // A repayment opened for editing from the Repay window's history.
  const [editRepPart, setEditRepPart] = useState<Row | null>(null)
  // WHICH KIND OF PAYMENT THIS IS.
  //
  // Repaying a discounted bill is two different acts that happen to be reached
  // the same way: giving the principal back, and paying the cost of having had
  // it. They post different journals against different accounts, so the panel
  // asks which before it asks anything else rather than inferring it from what
  // gets filled in.
  const [repayKind, setRepayKind] = useState<'full' | 'interest'>('full')
  // What the chosen date comes to — recomputed on the server, so the figure on
  // the screen is the one that will be posted.
  const [intWin, setIntWin] = useState<Row | null>(null)
  const [intDate, setIntDate] = useState('')
  const [intBusyUpto, setIntBusyUpto] = useState(false)
  const [repayForm, setRepayForm] = useState<Row>({})
  const [repaySaving, setRepaySaving] = useState(false)
  // The parts already paid on the bill in the dialog, so it opens showing what
  // has gone back rather than only what is left.
  const [repayParts, setRepayParts] = useState<Row[]>([])
  /**
   * THE OTHER BILLS ONE DEBIT ALSO CLEARED.
   *
   * A transfer to the NBFC rarely lines up with one bill: 47,00,000 leaves the
   * bank and part of it is this bill, part another. Entered as two repayments
   * it posts two vouchers, so the bank book shows two lines against a
   * statement that shows one and nothing ever reconciles. Entered here it is
   * one voucher with a row against each bill.
   */
  const [repayAlso, setRepayAlso] = useState<{ bd_id: string; amount: string }[]>([])
  // Charges in the same debit, each on a ledger the user picks — as many as the
  // bank or NBFC took.
  const [repayCharges, setRepayCharges] = useState<{ account: string; amount: string }[]>([])
  // The trading side, loaded ONLY while a trading bill's form is open. It is
  // not part of the register, so the page's normal refresh never pays for it.
  const [tradingDeals, setTradingDeals] = useState<Row[]>([])
  const [tradingOrders, setTradingOrders] = useState<Row[]>([])
  const [tradingLoaded, setTradingLoaded] = useState(false)
  // The bill whose receipt is being stamped, and the date being stamped on it.
  const [receiveRow, setReceiveRow] = useState<Row | null>(null)
  // Where the NBFC's money went, asked with the date it landed.
  const [receiveRoute, setReceiveRoute] = useState<'bank' | 'supplier'>('bank')
  // The bank a repayment or an interest payment leaves from. '__bill' is the
  // bill's own bank — the one its disbursement came into — which the server
  // works out, so an old bill keeps posting where it always has.
  const [repayBank, setRepayBank] = useState('__bill')
  const [receiveAccount, setReceiveAccount] = useState('')
  const [receiveDate, setReceiveDate] = useState('')
  const [receiveSaving, setReceiveSaving] = useState(false)
  // Paid to the supplier in parts: the first part, at Payment received.
  const [receiveParts, setReceiveParts] = useState(false)
  const [receiveFirst, setReceiveFirst] = useState('')
  // SID: the NBFC released only some of the draw on this date; the rest comes
  // leg by leg from Receive part.
  const [receiveLegs, setReceiveLegs] = useState(false)
  // EVERY PART AT ONCE, each with its own maturity, interest % and margin %
  // (blank = the bill's). Part 1 lands on the payment received date.
  const [legPlan, setLegPlan] = useState<{ amount: string; date: string; maturity: string; interest_pct: string; margin_pct: string }[]>([])
  const [legsRow, setLegsRow] = useState<Row | null>(null)
  // The bill whose parts paid to the supplier are open.
  const [partyRow, setPartyRow] = useState<Row | null>(null)

  // Every write anywhere in the app bumps the revision, which re-runs this
  // page's reload -- so what it asks for on each of those ticks is what the
  // hosting bill is actually made of. Two things were wasted on every tick:
  //
  //   - the KPI query re-read the same bills the list had just returned, to
  //     total columns that are plain arithmetic over rows already in hand;
  //   - the three master lists (NBFCs, suppliers, customers) were refetched
  //     although a bill being repaid cannot change any of them.
  //
  // The masters are now fetched once on mount, and the KPIs are computed from
  // the list. Five queries per refresh became one.
  // The facility limits live behind a button on Manage NBFCs — the limit is a
  // property of the NBFC, so it belongs with the NBFCs rather than taking up
  // the register, and it is only read when someone asks for it.
  const [limits, setLimits] = useState<Row | null>(null)
  // WHERE THIS LINE HAS BEEN. Opened from the NBFC's own row on the limits
  // screen, next to the figure it explains.
  const [limitHistory, setLimitHistory] = useState<LimitTarget | null>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitEdit, setLimitEdit] = useState<string | null>(null)
  const [limitSaving, setLimitSaving] = useState(false)

  const loadLimits = useCallback(async () => {
    try {
      setLimits(await window.api.billDiscounting.limits())
    } catch {
      setLimits(null)
    }
  }, [])

  const loadBills = useCallback(async () => {
    const list = await window.api.billDiscounting.list()
    setRows(list)
    // Handed back so a caller that has just posted something can pick its own
    // row out of the fresh list instead of reading the stale one it held.
    return list
  }, [])

  const loadMasters = useCallback(async () => {
    const [nb, sup, cust, cfg] = await Promise.all([
      window.api.data.list('nbfcs'),
      window.api.data.list('suppliers'),
      window.api.data.list('customers'),
      window.api.settings.all().catch(() => ({}) as Record<string, string>)
    ])
    // Whether the Payment IN chip is shown to everybody or kept for admins.
    // Missing means ON, so the register reads exactly as it did before the
    // setting existed.
    setPayInChipEveryone(String(cfg.bd_payment_in_chip_everyone ?? '1') !== '0')
    onNbfcsLoaded?.(nb)
    setNbfcs(nb)
    setSuppliers(sup.filter((x) => x.active))
    setCustomers(cust.filter((x) => x.active))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Kept as `load` so every caller in the page is unchanged: after posting
  // something they want the bills back, never the masters.
  const load = loadBills

  useEffect(() => {
    void loadBills()
    void loadMasters()
    // The sanctioned figures change when someone edits a limit, not when a bill
    // is raised — so they are read once here, and again only after a limit is
    // actually touched. What is DRAWN against them is the outstanding the
    // header already computes from the rows in hand, so the available figure
    // stays live without re-reading anything.
    void loadLimits()
  }, [loadBills, loadMasters, loadLimits])
  // A wrapper rather than loadBills itself, which hands back the list it read.
  const refresh = useCallback(async () => {
    await loadBills()
  }, [loadBills])
  useLiveRefresh(refresh)

  // Everything EXCEPT the stage. The stage tabs carry a count each, and a
  // count taken after the stage filter would read the bucket you are standing
  // in and zero for every other one — so the tabs count this list, and only
  // `filtered` below narrows to the stage actually picked.
  // The parties named on a bill, as a plain list — one entry, or the several a
  // multi-party bill carries, joined by the register's own ", ".
  const partiesOf = useCallback((r: Row): string[] => {
    const raw = String(r.party_names || r.party_name || '')
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }, [])

  // Everything except the column funnels (BD no, Party) and the stage tabs.
  // Each funnel builds its own choices on top of THIS, so ticking one column
  // never makes that column's other values disappear mid-choice.
  const preColumn = useMemo(() => {
    let list = rows
    // Nothing picked means every lender, which is what an empty filter has
    // always meant here — the picker just has more than one way to say it now.
    if (nbfcFilter.length) list = list.filter((r) => nbfcFilter.includes(String(r.nbfc_id ?? '')))
    if (typeFilter) list = list.filter((r) => String(r.finance_type) === typeFilter)
    if (duePeriod !== 'all') {
      const maxDays = DUE_PERIODS.find((p) => p.key === duePeriod)?.maxDays
      if (maxDays != null) {
        list = list.filter((r) => {
          const d = daysTo(r.maturity_date)
          return d != null && d <= maxDays
        })
      }
    }
    // The three things anyone remembers about a bill: its number, who financed
    // it, and whose invoice it was raised against. Matched together so one box
    // answers all three rather than making the reader pick a field first.
    const q = bdQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((r) =>
        [r.bd_no, r.nbfc_name, r.party_name, r.party_names, r.finance_type]
          .map((v) => String(v ?? '').toLowerCase())
          .some((v) => v.includes(q))
      )
    }
    return list
  }, [rows, nbfcFilter, typeFilter, duePeriod, bdQuery])

  // The two column funnels, each as a row-predicate that reads as "no filter"
  // when nothing is ticked. A bill can name several parties, so it passes the
  // party funnel when ANY one of them is ticked.
  const matchesParty = useCallback(
    (r: Row): boolean => {
      if (!partyFilter.length) return true
      const sel = new Set(partyFilter)
      return partiesOf(r).some((p) => sel.has(p))
    },
    [partyFilter, partiesOf]
  )
  const matchesBdNo = useCallback(
    (r: Row): boolean => !bdNoFilter.length || bdNoFilter.includes(String(r.bd_no ?? '')),
    [bdNoFilter]
  )

  // The Party column's checkbox list — built from the bills that pass every
  // OTHER filter (including the BD-no funnel), so its own ticks don't thin it.
  const partyOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of preColumn) {
      if (!matchesBdNo(r)) continue
      for (const p of partiesOf(r)) counts.set(p, (counts.get(p) || 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count }))
  }, [preColumn, matchesBdNo, partiesOf])

  // The BD-no column's checkbox list — every bill number that passes every
  // OTHER filter (including the Party funnel), newest-looking first is not a
  // thing here, so plain A→Z on the number as written.
  const bdNoOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    for (const r of preColumn) {
      if (!matchesParty(r)) continue
      const v = String(r.bd_no ?? '').trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: v })
    }
    return out.sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }))
  }, [preColumn, matchesParty])

  const beforeStage = useMemo(
    () => preColumn.filter((r) => matchesParty(r) && matchesBdNo(r)),
    [preColumn, matchesParty, matchesBdNo]
  )

  /**
   * A BILL IS "AWAITING" ON EITHER LEG — money still owed BY the NBFC, or
   * money still owed BACK to the party or customer.
   *
   * These used to be two separate buckets, because they are genuinely two
   * different questions: has the NBFC funded this bill, and has whatever it
   * financed sent its own money back. But a desk scanning the tabs for
   * "what still needs chasing" does not care which direction the chasing
   * runs in, and two thin buckets side by side cost more row space than
   * either was worth. One bucket, either reason.
   */
  function bdAwaitsPayIn(r: Row): boolean {
    return !!Number(r.payment_in_expected) && n(r.payment_in_total) <= 0.004
  }
  function bdIsAwaiting(r: Row): boolean {
    return String(r.stage) === 'awaiting' || bdAwaitsPayIn(r)
  }

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return beforeStage
    if (statusFilter === 'awaiting') return beforeStage.filter(bdIsAwaiting)
    return beforeStage.filter((r) => String(r.stage) === statusFilter)
  }, [beforeStage, statusFilter])
  // EVERY COLUMN SORTS — the arrow beside each heading: smallest first, then
  // largest first, then back to the register's own order. Each column sorts on
  // the figure it shows (days left on a repaid bill is blank, so it goes last).
  const bdSortRead = useCallback((r: Row, k: string): unknown => {
    switch (k) {
      case 'bd':
        return r.bd_no
      case 'party':
        return r.party_names || r.party_name
      case 'validity':
        return String(r.maturity_date || '').slice(0, 10)
      case 'days':
        return String(r.status) === 'repaid' ? '' : daysTo(r.maturity_date)
      case 'intdays':
        return r.intDays
      case 'open':
        return r.amount
      case 'margin':
        return r.marginAmount
      case 'interest':
        return r.interestAmount
      case 'tds':
        return r.tdsAmount
      case 'receipt':
        return r.receiptAmount
      default:
        return ''
    }
  }, [])
  const bdSort = useTableSort(filtered, bdSortRead)
  const sortBtn = (key: string, label: string): React.JSX.Element => (
    <button
      type="button"
      aria-label={`Sort by ${label}`}
      title={
        bdSort.key !== key
          ? `Sort by ${label}`
          : bdSort.dir === 'asc'
            ? `${label} — smallest first. Click to turn it round`
            : `${label} — largest first. Click to clear the sort`
      }
      onClick={(e) => {
        e.stopPropagation()
        bdSort.toggle(key)
      }}
      className={cn(
        'ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px] align-middle',
        bdSort.key === key ? (__WEB__ ? 'text-[#C7F03F]' : 'text-[#1a2c56]') : 'opacity-45 hover:opacity-100'
      )}
    >
      {bdSort.key === key ? (
        bdSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
      ) : (
        <ChevronsUpDown className="h-3 w-3" />
      )}
    </button>
  )

  // The stage buckets, in one place: the desktop pills and the website's
  // underline tabs are the same buckets and must never drift apart.
  const STAGES = [
    { key: 'all', label: 'All bills', title: undefined },
    {
      key: 'awaiting',
      label: 'Awaiting',
      title: 'Not yet funded by the NBFC, or funded but still owed a Payment IN'
    },
    { key: 'live', label: 'Open', title: undefined },
    { key: 'repaid', label: 'Repaid', title: undefined }
  ] as const
  const stageCount = (k: string): number =>
    k === 'all'
      ? beforeStage.length
      : k === 'awaiting'
        ? beforeStage.filter(bdIsAwaiting).length
        : beforeStage.filter((r) => String(r.stage) === k).length

  // The same figures bdKpis returned, off the rows already loaded -- exposure
  // counts only funded bills, since nothing is disbursed on one still awaiting
  // its payment, and those are reported separately.
  const kpisOf = useCallback((list: Row[]) => {
    const open = list.filter((r) => String(r.status) !== 'repaid')
    const live = open.filter((r) => String(r.stage) === 'live')
    const awaiting = open.filter((r) => String(r.stage) === 'awaiting')
    const sum = (l: Row[], key: string): number => round2(l.reduce((t, r) => t + n(r[key]), 0))
    // WHAT THE NBFC KEPT, WHICH ON A SERVICED BILL IS NOTHING.
    //
    // Interest and TDS sit in this band beside Received, so both read as
    // deductions from the disbursement. A serviced bill has none: its interest
    // is paid across during the tenor. The Total row under the register
    // already leaves those bills out of the same two columns, and a band that
    // did not was quietly contradicting the rows beneath it.
    const kept = (l: Row[], key: string): number =>
      round2(l.reduce((t, r) => t + (isServiced(r) ? 0 : n(r[key])), 0))
    return {
      count: live.length,
      outstanding_total: sum(live, 'outstanding_amount'),
      margin_total: sum(live, 'marginAmount'),
      interest_total: kept(live, 'interestAmount'),
      tds_total: kept(live, 'tdsAmount'),
      receipt_total: sum(live, 'receiptAmount'),
      awaiting_count: awaiting.length,
      awaiting_total: sum(awaiting, 'amount')
    }
  }, [])
  // The desk's own labels on these bills — one fetch for the list.
  const bdTags = useTagMap('bd', filtered.map((r) => Number(r.id)))

  // The band describes WHAT IS ON SCREEN. It totalled every bill in the company
  // regardless of the chips right beneath it, so picking PID, or This week, or
  // Awaiting payment changed the list and left the figures standing — a filter
  // that visibly does nothing reads as a page that has stopped working.
  const kpis = useMemo(() => kpisOf(filtered), [kpisOf, filtered])
  // The unfiltered set, for the "of ..." line and for the facility headroom.
  const kpisAll = useMemo(() => kpisOf(rows), [kpisOf, rows])
  const narrowed = filtered.length !== rows.length

  // Sanctioned less what is drawn on it. The drawn half comes from the rows in
  // hand, so it stays current as bills are raised and repaid without asking the
  // database again — only the sanctioned half is fetched.
  //
  // WHICH sanction depends on what is being looked at. With one NBFC picked the
  // question is "how much is left with THEM", and answering it with the group
  // ceiling would be plainly wrong — a lender with 5 crore sanctioned and 5
  // crore drawn has nothing left, whatever the other lines still allow. Only
  // with no NBFC chosen is the whole book the right answer.
  const availableLimit = useMemo(() => {
    // Several picked is the same question asked of several lines at once: what
    // those lenders between them allow, less what those same lenders are
    // holding. The group ceiling is not the answer for a subset — it covers
    // lenders the picker has just filtered out.
    if (nbfcFilter.length) {
      const lines = ((limits?.per_nbfc || []) as Row[]).filter((x) => nbfcFilter.includes(String(x.id)))
      const sanctioned = round2(lines.reduce((t, x) => t + n(x.sanctioned), 0))
      if (sanctioned <= 0) return null
      const drawn = kpisOf(rows.filter((r) => nbfcFilter.includes(String(r.nbfc_id ?? '')))).outstanding_total
      return round2(sanctioned - drawn)
    }
    const ceiling = limits?.effective_limit
    if (ceiling == null) return null
    return round2(n(ceiling) - n(kpisAll.outstanding_total))
  }, [limits, kpisAll.outstanding_total, nbfcFilter, rows, kpisOf])

  // The ceiling the figure above was struck against, and where it came from.
  const limitBasis = useMemo(() => {
    if (nbfcFilter.length) {
      const lines = ((limits?.per_nbfc || []) as Row[]).filter((x) => nbfcFilter.includes(String(x.id)))
      if (!lines.length) return null
      const ceiling = round2(lines.reduce((t, x) => t + n(x.sanctioned), 0))
      // Named when it is one lender's line, counted when it is several — a
      // figure struck against three sanctions should not read as one.
      return {
        ceiling,
        label: lines.length === 1 ? String(lines[0].name || 'this NBFC') : `${lines.length} NBFC lines`
      }
    }
    return limits?.effective_limit == null
      ? null
      : {
          ceiling: n(limits.effective_limit),
          label: limits.effective_basis === 'lines' ? 'NBFC lines' : 'combined'
        }
  }, [limits, nbfcFilter])

  // Only the NBFCs that actually provide the finance type being booked.
  const formNbfcs = useMemo(() => {
    const want = String(form?.finance_type || '')
    return nbfcs.filter(
      (nb) => nb.active && (String(nb.finance_type) === 'BOTH' || !want || String(nb.finance_type) === want)
    )
  }, [nbfcs, form?.finance_type])

  // PID draws against a supplier, SID against a customer — then narrowed to
  // the parties actually set up for the chosen purpose, the same
  // Trading/Manufacturing split the LC form applies to its supplier picker.
  const formParties = useMemo(() => {
    if (!form) return []
    const wantTrading = String(form.purpose) === 'trading'
    const pool = String(form.finance_type) === 'SID' ? customers : suppliers
    return pool.filter((p) => isTradingParty(p) === wantTrading)
  }, [form, suppliers, customers])

  function openNew(): void {
    setForm({
      finance_type: 'PID',
      party_type: 'supplier',
      purpose: 'manufacturing',
      maturity_date: '',
      invoice_amount: '',
      invoice_adj: '',
      open_adj: '',
      open_adj_ledger: '',
      open_adj_split: null,
      interest_after_adj: false,
      amount: '',
      margin_pct: '',
      interest_pct: '',
      tds_pct: '',
      days_year: 360,
      days_incl_start: false,
      interest_upfront: false,
      interest_mode: 'discounted',
      interest_freq: 'monthly',
      receivable_party_id: '',
      linked_order_ids: [],
      // Who the NBFC pays: on a PID (the default type) the supplier.
      disbursement_route: 'supplier',
      disbursement_account: ''
    })
  }

  function openRoute(r: Row): void {
    setRouteRow(r)
    setRouteVal(String(r.disbursement_route || '') === 'supplier' ? 'supplier' : 'bank')
    setRouteAcct(String(r.disbursement_account || ''))
    setRouteShares(r.party_id ? [{ party_id: String(r.party_id), amount: String(round2(n(r.amount))) }] : [])
    void window.api.billDiscounting
      .parties(Number(r.id))
      .then((ps: Row[]) => {
        const sup = (ps || []).filter((x) => String(x.party_type) === 'supplier')
        if (!sup.length) return
        setRouteShares(
          sup.map((x) => ({
            party_id: String(x.party_id),
            amount: n(x.amount) > 0 ? String(round2(n(x.amount))) : sup.length === 1 ? String(round2(n(r.amount))) : ''
          }))
        )
      })
      .catch(() => undefined)
  }
  async function saveRoute(): Promise<void> {
    if (!routeRow) return
    if (routeVal === 'bank' && !routeAcct) return void toast.error('Pick the bank the money landed in')
    const shares = routeShares.filter((x) => x.party_id || n(x.amount) > 0)
    if (routeVal === 'supplier') {
      if (!shares.length) return void toast.error('Pick the supplier the NBFC paid')
      if (shares.some((x) => !x.party_id)) return void toast.error('Pick the supplier for each share')
      if (shares.length > 1 && shares.some((x) => !(n(x.amount) > 0))) return void toast.error('Enter how much went to each supplier')
    }
    setRouteSaving(true)
    try {
      await window.api.billDiscounting.setRoute(
        Number(routeRow.id),
        routeVal,
        routeVal === 'bank' ? routeAcct : undefined,
        routeVal === 'supplier' ? shares.map((x) => ({ party_id: Number(x.party_id), amount: round2(n(x.amount)) })) : undefined
      )
      toast.success(
        `${String(routeRow.bd_no || 'Bill')} — disbursement now ${routeVal === 'supplier' ? `paid to ${String(routeRow.party_name || routeRow.supplier_name || 'the supplier')} direct` : `into ${routeAcct}`}; its opening voucher was re-posted`
      )
      setRouteRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRouteSaving(false)
    }
  }

  function openEdit(r: Row): void {
    setForm({
      id: r.id,
      bd_no: r.bd_no || '',
      payment_in_expected: !!Number(r.payment_in_expected),
      payment_in_days: r.payment_in_days == null ? '' : String(r.payment_in_days),
      nbfc_id: r.nbfc_id ? String(r.nbfc_id) : '',
      finance_type: r.finance_type,
      party_type: r.party_type,
      party_id: r.party_id ? String(r.party_id) : '',
      // The first is the primary — the one written on the bill itself.
      party_ids: String(r.party_ids_csv || '')
        .split(',')
        .filter(Boolean)
        .map(Number),
      party_amounts: Object.fromEntries(
        String(r.party_split_csv || '')
          .split(',')
          .filter(Boolean)
          .map((pair) => {
            const [pid, amt] = pair.split(':')
            // A zero share was never allocated, so the box shows empty and
            // prompts for it rather than displaying "0.0" as an answer.
            return [String(pid), Number(amt) === 0 ? '' : amt]
          })
      ),
      purpose: r.purpose,
      invoice_amount: r.invoice_amount ?? '',
      invoice_adj: n(r.invoice_adj) ? r.invoice_adj : '',
      // The Open amount the form shows. A bill on the charge basis stores it as
      // is; an older one stored Open ± Adj, so its open figure is taken back
      // out — and saving it moves it onto the charge basis.
      open_adj: n(r.open_adj) ? r.open_adj : '',
      open_adj_ledger: String(r.open_adj_ledger || ''),
      open_adj_split: adjParts(r.open_adj_split).length > 1 ? adjParts(r.open_adj_split) : null,
      interest_after_adj: !!n(r.interest_after_adj),
      amount: r.amount == null ? '' : String(n(r.open_adj_charge) ? n(r.amount) : round2(n(r.amount) - n(r.open_adj))),
      // Whatever was drawn on this bill was decided when it was raised. Marked
      // as the user's own figure so the auto-fill below leaves it alone.
      amount_touched: true,
      // Not editable on this form any more — it is stamped by Mark payment
      // received — but carried through so saving other terms cannot clear it.
      payment_received_date: r.payment_received_date || '',
      maturity_date: r.maturity_date || '',
      margin_pct: r.margin_pct ?? '',
      interest_pct: r.interest_pct ?? '',
      tds_pct: r.tds_pct ?? '',
      days_year: r.days_year ?? 360,
      days_incl_start: !!r.days_incl_start,
      interest_upfront: !!r.interest_upfront,
      interest_mode: String(r.interest_mode || (r.interest_upfront ? 'upfront' : 'discounted')),
      interest_freq: String(r.interest_freq || 'monthly'),
      receivable_party_id: r.receivable_party_id ? String(r.receivable_party_id) : '',
      linked_order_ids: String(r.linked_order_ids_csv || '').split(',').filter(Boolean).map(Number),
      note: r.note || '',
      disbursement_route: String(r.disbursement_route || 'unconfirmed'),
      disbursement_account: r.disbursement_account || ''
    })
  }

  // Switching PID <-> SID swaps which master the party comes from, so a party
  // picked from the old list is dropped rather than left pointing at the
  // wrong master.
  function chooseFinanceType(v: string): void {
    setForm((p) => ({
      ...p,
      finance_type: v,
      party_type: v === 'SID' ? 'customer' : 'supplier',
      party_id: '',
      party_ids: [],
      party_amounts: {},
      nbfc_id: '',
      // The usual answer for each: a PID's money goes to the supplier, a
      // SID's lands in our bank. Either can be changed.
      disbursement_route: v === 'SID' ? 'bank' : 'supplier'
    }))
  }

  // Picking an NBFC applies its terms — always, and every time it is changed.
  //
  // Changing the financier is an explicit act, so its rates take effect: the
  // whole point of holding terms on the NBFC master is that choosing the NBFC
  // chooses the terms. Anything typed afterwards still wins, because typing
  // comes after.
  //
  // An earlier version tried to be clever and preserve a figure it judged to be
  // a manual override, by comparing it against the previous NBFC's default.
  // That failed on exactly the case it mattered: a bill carrying 14% while its
  // NBFC's master says 14.5% — a rate typed by hand, or a master edited after
  // the bill was raised — was read as an override on EVERY switch and so never
  // moved. Guessing which figures the user meant to keep cannot be done
  // reliably, and guessing wrong is what made the picker look broken.
  //
  // Only fields the NBFC actually carries are applied: one with no rate on file
  // must not blank out a rate that is already there.
  function chooseNbfc(v: string): void {
    const nb = nbfcs.find((x) => String(x.id) === v)
    setForm((p) => {
      const next: Row = { ...p, nbfc_id: v }
      if (!nb) return next
      const applied: string[] = []
      if (n(nb.interest_pct) > 0 && n(nb.interest_pct) !== n(p?.interest_pct)) {
        next.interest_pct = nb.interest_pct
        applied.push(`interest ${n(nb.interest_pct)}%`)
      }
      if (n(nb.tds_pct) > 0 && n(nb.tds_pct) !== n(p?.tds_pct)) {
        next.tds_pct = nb.tds_pct
        applied.push(`TDS ${n(nb.tds_pct)}%`)
      }
      if (n(nb.days_year) > 0 && n(nb.days_year) !== n(p?.days_year)) {
        next.days_year = nb.days_year
        applied.push(`${n(nb.days_year)}-day year`)
      }
      // A switch has no "unset" the way a rate of 0 has, so this always
      // applies — and it is copied ONTO the bill, never read live from the
      // NBFC, so editing the NBFC later cannot move a bill already recorded.
      if (!!nb.days_incl_start !== !!p?.days_incl_start) {
        next.days_incl_start = !!nb.days_incl_start
        applied.push(nb.days_incl_start ? 'receipt date counted' : 'interest from the day after receipt')
      }
      // The tenor is one of the NBFC's terms too, so it applies on a switch like
      // the rates do — not only into a blank field. This is what moves Int.
      // days: that figure is not an NBFC term at all, it is the gap between the
      // receipt date and the maturity date, so nothing about it can change
      // until one of those two dates does. Leaving an existing maturity alone
      // was why a 90-day bill stayed at 90 days on an NBFC whose tenor is 60.
      //
      // Counted from the payment received date once there is one, else from
      // today — the day the bill is being opened. A maturity you type after
      // this still stands; only changing the NBFC again recomputes it.
      if (n(nb.interest_days) > 0) {
        const base = String(p?.payment_received_date || todayISO()).slice(0, 10)
        const d = new Date(`${base}T00:00:00`)
        d.setDate(d.getDate() + n(nb.interest_days))
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (iso !== String(p?.maturity_date || '').slice(0, 10)) {
          next.maturity_date = iso
          applied.push(`${n(nb.interest_days)}-day tenor → ${formatDate(iso)}`)
        }
      }
      // Said out loud, because most of these NBFCs carry the same TDS and the
      // same day-count — so a correct switch can change almost nothing on
      // screen, which is indistinguishable from a switch that did not work.
      if (applied.length) toast.success(`${nb.name}: ${applied.join(' · ')}`)
      return next
    })
  }

  // WHAT THE BILL IS STILL WAITING FOR.
  //
  // One list, read by the footer and by the save, so the button and the line
  // beside it can never disagree about whether the form is finished.
  const bdMissing = (f: Row | null): string[] =>
    !f
      ? []
      : ([
          !String(f.bd_no ?? '').trim() && 'BD no',
          !f.nbfc_id && 'NBFC',
          !(Array.isArray(f.party_ids) ? f.party_ids : []).length &&
            (String(f.finance_type) === 'SID' ? 'Customer' : 'Supplier'),
          !(n(f.invoice_amount) > 0) && 'Invoice amount',
          !f.maturity_date && 'Maturity date',
          !adjSplitOk(n(f.open_adj), f.open_adj_split) && 'Adj. split to add up'
        ].filter((x): x is string => typeof x === 'string'))

  const preview = useMemo(() => (form ? bdCalc(form) : null), [form])

  // ── THE STEPS' TICKS (website drawer) ──────────────────────────────────
  const billStepDone =
    !!form && !!String(form.bd_no ?? '').trim() && !!form.nbfc_id &&
    (Array.isArray(form.party_ids) ? form.party_ids : []).length > 0 && !!form.maturity_date
  const amountStepDone = !!form && n(form.invoice_amount) > 0 && !!preview && preview.openAmount > 0
  // THE HEADER'S CHIPS — who, against whom, when, and what kind, read off the
  // form as it is filled, so the bill is named at the top before it is saved.
  const bdHead = ((): { nbfc: string; party: string; dates: string; kind: string } | null => {
    if (!form) return null
    const sid = String(form.finance_type) === 'SID'
    const nbfc = nbfcs.find((x) => String(x.id) === String(form.nbfc_id))
    const pool = sid ? customers : suppliers
    const names = (Array.isArray(form.party_ids) ? form.party_ids : [])
      .map((id: unknown) => String(pool.find((p) => String(p.id) === String(id))?.name || ''))
      .filter(Boolean)
    const from = String(form.payment_received_date || '').slice(0, 10)
    const to = String(form.maturity_date || '').slice(0, 10)
    const tenor = from && to ? (daysTo(to) ?? 0) - (daysTo(from) ?? 0) : null
    return {
      nbfc: nbfc ? String(nbfc.name) : '',
      party: names.length > 2 ? `${names[0]} + ${names.length - 1} more` : names.join(', '),
      dates:
        `${from ? formatDate(from) : 'Not received yet'} → ${to ? formatDate(to) : 'maturity?'}` +
        (tenor != null && tenor > 0 ? ` · ${tenor} days` : ''),
      kind: `${sid ? 'SID' : 'PID'} · ${String(form.purpose) === 'trading' ? 'Trading' : 'Manufacturing'}`
    }
  })()

  // ── WHAT YOU WILL RECEIVE (website drawer) ─────────────────────────────
  // The bill's arithmetic as a statement on the canvas's dark rail: the
  // operator in a column of its own so the sum reads down the page, landing on
  // what is credited. Beside the form on a wide screen; under it on a narrow one.
  const bdRail = ((): React.JSX.Element | null => {
    if (!form || !preview) return null
    const miss = bdMissing(form)
    const invEff = n(form.invoice_amount) > 0 ? Math.max(0, round2(n(form.invoice_amount) + n(form.invoice_adj))) : 0
    const adj = n(form.open_adj)
    const funded = !!String(form.payment_received_date || '').slice(0, 10)
    const mode = preview.serviced ? 'serviced' : form.interest_upfront ? 'upfront' : 'discounted'
    const afterAdj = !!form.interest_after_adj && !!adj
    type RailRow = { k: string; v: string; op?: string; sub?: string; fg?: string; strong?: boolean }
    const rows: RailRow[] = [
      { k: n(form.invoice_adj) ? 'Invoice amount (adj.)' : 'Invoice amount', v: invEff > 0 ? formatINR(invEff) : '—' },
      ...(invEff > 0
        ? [
            {
              k: `Margin ${formatNum(n(form.margin_pct))}%`,
              v: formatINR(preview.marginAmount),
              op: '−',
              fg: '#F0AFAA',
              sub: 'refunded by the NBFC on repayment'
            }
          ]
        : []),
      {
        k: 'Open amount',
        v: preview.openAmount ? formatINR(preview.openAmount) : '—',
        op: invEff > 0 ? '=' : '',
        fg: preview.undrawnAmount < -0.004 ? '#F0C98A' : undefined,
        sub:
          preview.undrawnAmount < -0.004
            ? `${formatINR(Math.abs(preview.undrawnAmount))} over the sanction`
            : preview.undrawnAmount > 0.004
              ? `what you repay at maturity · ${formatINR(preview.undrawnAmount)} of the sanction undrawn`
              : 'what you repay at maturity'
      }
    ]
    if (funded) {
      const basis =
        `${formatINR(preview.interestBase)} × ${formatNum(n(form.interest_pct))}% × ${preview.intDays}` +
        `${form.days_incl_start ? ' (incl.)' : ''} ÷ ${n(form.days_year) || 360}` +
        (afterAdj ? ' · after the Adj.' : '')
      rows.push(
        mode === 'serviced'
          ? {
              k: 'Interest, serviced over the tenor',
              v: formatINR(preview.interestAmount),
              fg: '#A9CDBB',
              sub: `not netted — paid as it runs, ${String(form.interest_freq || 'monthly').replace('_', '-')} rests · ${basis}`
            }
          : mode === 'upfront'
            ? { k: 'Interest, settled upfront', v: formatINR(preview.interestAmount), fg: '#A9CDBB', sub: `not netted from the disbursement · ${basis}` }
            : { k: 'Interest', v: formatINR(preview.interestAmount), op: '−', fg: '#F0AFAA', sub: basis }
      )
    }
    if (adj) {
      rows.push({
        k: adj < 0 ? `Adj. — ${adjKindsLabel(form.open_adj_ledger, form.open_adj_split, chargeTypes)}` : 'Adj. — added',
        v: formatINR(Math.abs(adj)),
        op: adj < 0 ? '−' : '+',
        fg: adj < 0 ? '#F0AFAA' : '#C7F03F',
        sub: adj < 0 ? `the NBFC’s deduction · ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}` : `added to the payout · ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}`
      })
    }
    if (funded) {
      rows.push({ k: 'Credited to you', v: formatINR(preview.receiptAmount), op: '=', fg: '#C7F03F', strong: true })
      if (n(form.tds_pct) > 0) {
        rows.push({ k: 'TDS withheld on interest', v: formatINR(preview.tdsAmount), fg: '#F0C98A', sub: 'you deduct and deposit it' })
      }
    }
    return (
      <>
        <div
          className="overflow-hidden rounded-[12px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.1),0_16px_34px_-18px_rgba(7,43,32,.75)]"
          style={{ background: 'linear-gradient(165deg,#145A43 0%,#0B3D2E 50%,#072B20 100%)' }}
        >
          <div className="flex items-center gap-2 border-b border-b-white/[.08] px-4 pb-[11px] pt-[13px]">
            <ArrowUpRight className="h-[17px] w-[17px] text-[#C7F03F]" />
            <span className="text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">What you will receive</span>
          </div>
          {/* Interest runs from the day the money lands, and that date is
              stamped later by Mark payment received — so before it, interest,
              TDS and the payout are not knowable and are not shown as zeroes. */}
          {!funded && preview.openAmount > 0 && (
            <div className="mx-3.5 mt-3 flex items-start gap-2 rounded-[7px] border border-[#F0C98A]/30 bg-[#F0C98A]/[.12] px-[11px] py-[9px]">
              <Clock className="mt-px h-4 w-4 flex-none text-[#F0C98A]" />
              <span className="text-[11px] font-semibold leading-[1.5] text-[#F5E2B8] [text-wrap:pretty]">
                Interest, TDS and payout are worked out on <b className="font-extrabold">Mark payment received</b> — interest runs from the
                day the money lands.
              </span>
            </div>
          )}
          <div className="px-4 pb-3 pt-1">
            {rows.map((r) => (
              <div key={r.k} className="flex items-start gap-[9px] border-b border-b-white/[.08] py-[9px] last:border-b-0">
                <span className="doc-ref w-3 flex-none pt-px text-[13px] font-bold text-[#6E9484]">{r.op || ''}</span>
                <div className="min-w-0 flex-1">
                  <div className={cn('text-[12px] text-[#DCEFE4] [text-wrap:pretty]', r.strong ? 'font-extrabold' : 'font-semibold')}>{r.k}</div>
                  {r.sub && <div className="mt-0.5 text-[10.5px] font-semibold leading-[1.4] text-[#8FBFA8] [text-wrap:pretty]">{r.sub}</div>}
                </div>
                <span
                  className="doc-ref flex-none whitespace-nowrap font-bold tracking-[-0.01em]"
                  style={{ fontSize: r.strong ? 16 : 13, color: r.fg || '#fff' }}
                >
                  {r.v}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[10px] border bg-white px-[14px] py-3" style={{ borderColor: miss.length ? '#F1D9A6' : '#BFE3CB' }}>
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
            {miss.length ? 'Still needed' : 'Everything required is in'}
          </div>
          <div
            className="mt-[7px] flex items-start gap-[7px] text-[12px] font-bold leading-[1.45]"
            style={{ color: miss.length ? '#8A5300' : '#0B6B45' }}
          >
            {miss.length ? <CircleAlert className="h-[17px] w-[17px] flex-none" /> : <CheckCircle2 className="h-[17px] w-[17px] flex-none" />}
            <span className="[text-wrap:pretty]">
              {miss.length
                ? `${miss.length} required: ${miss.join(', ')}`
                : form.id
                  ? 'Saving re-posts this bill’s vouchers.'
                  : 'Ready to discount'}
            </span>
          </div>
        </div>
      </>
    )
  })()
  const bdSummary = bdRail && (
    <aside className="hidden min-h-0 flex-col gap-3 overflow-y-auto bg-[#EEF3EC] pb-5 pl-0.5 pr-[18px] pt-4 min-[1280px]:flex">
      {bdRail}
    </aside>
  )

  // Invoice less margin is the whole of what the NBFC will lend, and it is what
  // is drawn in all but the exceptional case — so the form fills it in rather
  // than asking for a number the two fields above already determine. Typing in
  // the open amount stops this for good on that bill (amount_touched), because
  // a deliberately smaller draw must not be overwritten by the next keystroke
  // in the margin box.
  useEffect(() => {
    if (!form || form.amount_touched) return
    // BOTH figures have to be answered first. A blank margin is not 0% — it is
    // a question nobody has reached yet, and treating it as zero filled the
    // open amount with the whole invoice the moment the invoice was typed,
    // which is a number the user never agreed to. A typed 0 IS an answer, so
    // the test is that the box is not empty, not that it is above zero.
    const marginAnswered = form.margin_pct != null && String(form.margin_pct).trim() !== ''
    if (!marginAnswered || !(n(form.invoice_amount) > 0)) return
    const target = round2(bdCalc({ ...form, amount: 0 }).sanctionedAmount)
    if (target <= 0 || round2(n(form.amount)) === target) return
    setForm((prev) => (prev && !prev.amount_touched ? { ...prev, amount: String(target) } : prev))
  }, [form?.invoice_amount, form?.invoice_adj, form?.margin_pct, form?.amount_touched])

  async function save(): Promise<void> {
    if (!form) return
    if (!String(form.bd_no ?? '').trim()) {
      toast.error('Enter the BD no — every voucher this bill posts is numbered with it')
      return
    }
    setSaving(true)
    try {
      const payload: Row = {
        bd_no: String(form.bd_no).trim(),
        nbfc_id: form.nbfc_id ? Number(form.nbfc_id) : null,
        finance_type: form.finance_type,
        party_type: form.party_type,
        party_id: form.party_id ? Number(form.party_id) : null,
        party_ids: Array.isArray(form.party_ids) ? form.party_ids : form.party_id ? [Number(form.party_id)] : [],
        // Only meaningful on a multi-party bill; the backend ignores it otherwise.
        party_amounts: form.party_amounts || {},
        purpose: form.purpose,
        // The Open amount is what is drawn and what the interest runs on; the
        // Adj. is a charge on the payout (open_adj_charge), not on the draw.
        amount: round2(Number(form.amount) || 0),
        invoice_amount: String(form.invoice_amount ?? '').trim() === '' ? null : Number(form.invoice_amount),
        invoice_adj: Number(form.invoice_adj) || 0,
        open_adj: round2(Number(form.open_adj) || 0),
        open_adj_charge: 1,
        // The kind of charge picked beside the Adj. — blank is BD charges.
        open_adj_ledger: String(form.open_adj_ledger || '').trim() || null,
        // Several kinds of charge: each part posts to its own ledger.
        open_adj_split: n(form.open_adj) && adjParts(form.open_adj_split).length > 1 ? adjParts(form.open_adj_split) : null,
        // Whether the NBFC charges its interest on the Open amount after the Adj.
        interest_after_adj: form.interest_after_adj ? 1 : 0,
        payment_received_date: form.payment_received_date || null,
        maturity_date: form.maturity_date || null,
        // Blank means no term was agreed, which is not nought days.
        payment_in_expected: form.payment_in_expected ? 1 : 0,
        payment_in_days: String(form.payment_in_days ?? '').trim() === '' ? null : Number(form.payment_in_days),
        margin_pct: Number(form.margin_pct) || 0,
        interest_pct: Number(form.interest_pct) || 0,
        tds_pct: Number(form.tds_pct) || 0,
        days_year: Number(form.days_year) || 360,
        days_incl_start: !!form.days_incl_start,
        interest_upfront: !!form.interest_upfront,
        interest_mode: String(form.interest_mode || (form.interest_upfront ? 'upfront' : 'discounted')),
        interest_freq: String(form.interest_freq || 'monthly'),
        // Only sent on a trading bill; a manufacturing bill has no round trip.
        receivable_party_id:
          String(form.purpose) === 'trading' && form.receivable_party_id ? Number(form.receivable_party_id) : null,
        linked_order_ids: String(form.purpose) === 'trading' ? form.linked_order_ids || [] : [],
        note: form.note || null,
        disbursement_route: String(form.disbursement_route || (form.id ? 'unconfirmed' : 'bank')),
        disbursement_account: String(form.disbursement_route) === 'bank' ? String(form.disbursement_account || '') || null : null
      }
      if (form.id) await window.api.billDiscounting.update(Number(form.id), payload)
      else await window.api.billDiscounting.create(payload)
      toast.success(form.id ? 'Bill Discounting updated' : 'Bill discounted')
      setForm(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // What is still owed on a bill: the face amount less everything already
  // repaid. A bill with no parts is simply its own amount.
  const dueOn = (r: Row | null): number => (r ? round2(n(r.amount) - n(r.repaid_total)) : 0)

  // WHAT THE TYPED FIGURE IS OVER THIS BILL, AND WHETHER IT IS EXPLAINED.
  //
  // Over the bill's own outstanding the figure stops being this bill's
  // principal and becomes the whole bank debit, so the rest has to be named:
  // the charges, or another of the NBFC's bills. Nothing saves until the two
  // agree to the rupee.
  const spill = repayRow ? round2(Math.max(0, round2(n(repayForm.amount)) - dueOn(repayRow))) : 0
  const alsoTotal = round2(repayAlso.reduce((t, a) => t + (a.bd_id ? n(a.amount) : 0), 0))
  const chargesTotal = round2(repayCharges.reduce((t, ch) => t + n(ch.amount), 0))
  const unallocated = round2(spill - round2(n(repayForm.interest) + chargesTotal + alsoTotal))
  // The other bills one debit could have settled: same NBFC, funded, still
  // open, and not the one being looked at.
  const otherOpenBds = useMemo(
    () =>
      rows.filter(
        (r) =>
          String(r.status) !== 'repaid' &&
          !!r.payment_received_date &&
          Number(r.id) !== Number(repayRow?.id || 0) &&
          Number(r.nbfc_id) === Number(repayRow?.nbfc_id || 0) &&
          dueOn(r) > 0.004
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, repayRow]
  )
  // Every open bill not already claimed on SOME row — what a brand new row
  // would actually have to offer. Used only to decide whether the "add
  // another" button still has anything left to add.
  const pickableAtEnd = otherOpenBds.filter(
    (b) => !repayAlso.some((a) => String(a.bd_id) === String(b.id))
  )

  // The parties on the bill being repaid — a repayment settled on a ledger has
  // to say WHOSE, and a bill can carry several.
  const [repayParties, setRepayParties] = useState<Row[]>([])

  // The interest rests on a serviced bill, and what has been paid against
  // them. Loaded with the repayment parts, because both are read in the same
  // panel and a bill that services its interest has two clocks running.
  const [intSched, setIntSched] = useState<Row[]>([])
  const [intBusy, setIntBusy] = useState(false)
  const [intPosting, setIntPosting] = useState<number | null>(null)
  /**
   * POST IT NOW, OR JUST RECORD THAT IT WAS PAID.
   *
   * Every other save on this page goes straight to the ledger because there
   * is nothing else it could sensibly mean — a repayment IS the bank moving.
   * Interest is different: it is serviced on a clock the NBFC keeps, and the
   * desk sometimes knows the days ran before it is ready to hand the voucher
   * to the books — waiting on a bank confirmation, a reconciliation, the
   * right date to fall in the right month. So saving asks, once, right before
   * it would otherwise post: put this on the ledger now, or just mark the
   * days serviced and post it later. Nothing about the interest itself
   * changes either way — only whether a voucher goes in with it.
   */
  const [intAsk, setIntAsk] = useState<
    | { kind: 'slice'; toDate: string; gross: number; tds: number; net: number; days: number }
    | { kind: 'upto'; gross: number; tds: number; net: number; days: number }
    | null
  >(null)

  async function loadIntSched(bdId: number): Promise<void> {
    setIntSched(await window.api.billDiscounting.interestSchedule(bdId).catch(() => [] as Row[]))
  }

  async function payInterest(toDate: string, post: boolean): Promise<void> {
    if (!repayRow) return
    setIntBusy(true)
    try {
      const res = await window.api.billDiscounting.payInterest(Number(repayRow.id), {
        to_date: toDate,
        post,
        bank_account: repayBank === '__bill' ? null : repayBank
      })
      toast.success(
        post
          ? `Interest ${formatINR(res.gross)} posted — ${formatINR(res.net)} out of the bank`
          : `Interest ${formatINR(res.gross)} recorded — not yet on the ledger`
      )
      setIntAsk(null)
      await loadIntSched(Number(repayRow.id))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setIntBusy(false)
    }
  }

  /** Post the voucher for a slice recorded earlier without one. */
  async function postInterestNow(payId: number): Promise<void> {
    if (!repayRow) return
    setIntPosting(payId)
    try {
      await window.api.billDiscounting.postInterest(payId)
      toast.success('Interest payment posted to the ledger')
      await loadIntSched(Number(repayRow.id))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setIntPosting(null)
    }
  }

  async function undoInterest(payId: number): Promise<void> {
    if (!repayRow) return
    try {
      await window.api.billDiscounting.deleteInterest(payId)
      toast.success('Interest payment removed — its voucher is reversed')
      await loadIntSched(Number(repayRow.id))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function loadRepayParts(bdId: number): Promise<void> {
    try {
      const [parts, parties] = await Promise.all([
        window.api.billDiscounting.repayments(bdId),
        window.api.billDiscounting.parties(bdId).catch(() => [] as Row[])
      ])
      setRepayParts(parts)
      setRepayParties(parties)
    } catch {
      setRepayParts([])
      setRepayParties([])
    }
  }

  function openRepay(r: Row): void {
    setRepayRow(r)
    // Defaults to clearing the balance — the ordinary case — and is editable
    // down to whatever instalment is actually going back.
    setRepayForm({
      repay_date: todayISO(),
      // SID never settles on a party's ledger, so it is not even offered.
      settle_via: 'bank',
      ref: '',
      amount: String(dueOn(r)),
      release_margin: n(r.marginAmount) > 0,
      // The primary by default; only asked about when the bill has more.
      party_id: r.party_id ? String(r.party_id) : ''
    })
    setRepayParts([])
    setRepayAlso([])
    setRepayCharges([])
    setRepayBank('__bill')
    // Every panel opens on the full repayment, which is what the button in the
    // register says it is for; interest is the deliberate second choice.
    setRepayKind('full')
    setIntWin(null)
    setIntDate('')
    void loadRepayParts(Number(r.id))
    void loadIntSched(Number(r.id))
    void loadIntWindow(Number(r.id))
  }

  // THE PAYABLE STRETCH, from the server.
  //
  // The floor and the ceiling are rules about money, so they are decided where
  // the money is — the form only greys out what the server would refuse
  // anyway. Re-read on every date change so the figure shown is the figure
  // that posts.
  const loadIntWindow = useCallback(async (id: number, to?: string): Promise<void> => {
    try {
      const w = await window.api.billDiscounting.interestWindow(id, to)
      setIntWin(w)
      if (!to) setIntDate(String(w.max_date || todayISO()))
    } catch {
      setIntWin(null)
    }
  }, [])

  async function payInterestUpto(post: boolean): Promise<void> {
    if (!repayRow || !intDate) return
    setIntBusyUpto(true)
    try {
      const res = await window.api.billDiscounting.payInterestUpto(Number(repayRow.id), {
        to_date: intDate,
        post,
        bank_account: repayBank === '__bill' ? null : repayBank
      })
      toast.success(
        `${formatINR(res.gross)} interest ${post ? 'posted' : 'recorded'} for ${res.days} day${res.days === 1 ? '' : 's'}` +
          (res.tds > 0.004 ? ` · ${formatINR(res.tds)} TDS withheld` : '') +
          (post ? '' : ' · not yet on the ledger')
      )
      setIntAsk(null)
      await loadIntWindow(Number(repayRow.id))
      await loadIntSched(Number(repayRow.id))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setIntBusyUpto(false)
    }
  }

  async function saveRepay(): Promise<void> {
    if (!repayRow) return
    const due = dueOn(repayRow)
    const amount = round2(n(repayForm.amount))
    if (amount <= 0) {
      toast.error('Enter the amount being repaid')
      return
    }
    // Over this bill's balance is fine when the rest is put against the
    // charges or another bill this one debit cleared — the server checks every
    // rupee of it. Only an unexplained excess is stopped here.
    const explained = round2(n(repayForm.interest) + chargesTotal + alsoTotal)
    if (amount - due - explained > 0.004) {
      toast.error(
        explained > 0
          ? `${formatINR(round2(amount - due - explained))} of the ${formatINR(amount)} is not accounted for — add it to the interest, the charges or another bill`
          : `Only ${formatINR(due)} is still outstanding on this bill`
      )
      return
    }
    const badCharge = repayCharges.find((ch) => (ch.account.trim() || n(ch.amount)) && !(ch.account.trim() && n(ch.amount) > 0))
    if (badCharge) {
      toast.error(badCharge.account.trim() ? `Enter the amount charged to ${badCharge.account}` : 'Pick the ledger for each charge')
      return
    }
    setRepaySaving(true)
    try {
      const res = await window.api.billDiscounting.repay(Number(repayRow.id), {
        repay_date: repayForm.repay_date || undefined,
        settle_via: repayForm.settle_via === 'party' ? 'party' : 'bank',
        ref: repayForm.settle_via === 'party' && repayForm.ref ? String(repayForm.ref) : null,
        release_margin: !!repayForm.release_margin,
        amount,
        // What the bank took on top of the principal, in the same debit.
        also: repayAlso
          .filter((a) => a.bd_id && round2(n(a.amount)) > 0)
          .map((a) => ({ bd_id: Number(a.bd_id), amount: round2(n(a.amount)) })),
        charges: repayCharges
          .filter((ch) => ch.account.trim() && round2(n(ch.amount)) > 0)
          .map((ch) => ({ account: ch.account.trim(), amount: round2(n(ch.amount)) })),
        // Interest paid in the same debit — gross, to the interest ledger.
        interest: String(repayForm.interest ?? '').trim() === '' ? null : Number(repayForm.interest),
        party_id:
          repayForm.settle_via === 'party' && repayForm.party_id ? Number(repayForm.party_id) : null,
        bank_account: repayForm.settle_via === 'party' || repayBank === '__bill' ? null : repayBank
      })
      toast.success(
        res.closed
          ? 'Bill repaid in full — posted to the books'
          : `${formatINR(res.amount)} repaid — ${formatINR(res.outstanding)} still outstanding`
      )
      // Part payments keep the dialog open on the same bill so the next
      // instalment can go straight in; a full repayment closes it.
      const fresh = await load()
      setBdRev((v) => v + 1)
      if (res.closed) {
        setRepayRow(null)
      } else {
        const again = fresh.find((x) => Number(x.id) === Number(repayRow.id))
        if (again) {
          setRepayRow(again)
          setRepayForm((prev) => ({ ...prev, amount: String(dueOn(again)), ref: '' }))
          await loadRepayParts(Number(again.id))
        }
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRepaySaving(false)
    }
  }

  // Undo one instalment — a wrong figure keyed, or a payment that never
  // cleared — leaving the rest of the schedule alone.
  async function removeRepayPart(part: Row): Promise<void> {
    if (!repayRow) return
    if (!window.confirm(`Remove the ${formatINR(part.amount)} repaid on ${formatDate(part.repay_date)}? Its voucher reverses too.`)) return
    try {
      await window.api.billDiscounting.deleteRepayment(Number(part.id))
      toast.success('Repayment removed — its voucher is reversed')
      const fresh = await load()
      setBdRev((v) => v + 1)
      const again = fresh.find((x) => Number(x.id) === Number(repayRow.id))
      if (again) {
        setRepayRow(again)
        setRepayForm((prev) => ({ ...prev, amount: String(dueOn(again)) }))
      }
      await loadRepayParts(Number(repayRow.id))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Fetched the first time a trading bill's form needs it, then kept.
  useEffect(() => {
    if (!form || String(form.purpose || '') !== 'trading' || tradingLoaded) return
    let live = true
    void Promise.all([window.api.trading.list('treasury'), window.api.orders.list('treasury')])
      .then(([deals, ords]) => {
        if (!live) return
        setTradingDeals(deals)
        setTradingOrders(ords)
        setTradingLoaded(true)
      })
      .catch(() => { if (live) setTradingLoaded(true) })
    return () => { live = false }
  }, [form?.purpose, tradingLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // One row per purchase invoice on this party's open trading deals — each
  // invoice is its own pick, the way the LC side works, because a deal's
  // invoices can each be financed differently.
  const formTradingInvoices = useMemo(() => {
    if (!form || String(form.purpose || '') !== 'trading') return [] as Row[]
    const rows: Row[] = []
    for (const d of tradingDeals) {
      if (form.party_id && Number(d.supplier_id) !== Number(form.party_id)) continue
      const lines: Row[] =
        Array.isArray(d.purchase_lines) && d.purchase_lines.length
          ? d.purchase_lines
          : [{ order_id: d.order_id, invoice_no: d.purchase_invoice_no }]
      for (const pl of lines) {
        const orderId = Number(pl.order_id)
        if (!orderId) continue
        const o = tradingOrders.find((x) => Number(x.id) === orderId)
        rows.push({
          deal_id: Number(d.id),
          order_id: orderId,
          invoice_no: pl.invoice_no || o?.invoice_no || '',
          deal_date: d.deal_date,
          // See the same block on the LC side: one buyer is pre-filled as who
          // pays the bill back, several are only counted — there is no single
          // party to name, and naming the first would be a wrong guess.
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
  }, [form?.purpose, form?.party_id, tradingDeals, tradingOrders]) // eslint-disable-line react-hooks/exhaustive-deps

  // Which OTHER bill already holds each purchase invoice — one invoice funds
  // one bill, so a taken one is shown and disabled rather than quietly moved.
  const invoiceClaims = useMemo(() => {
    const m = new Map<number, Row>()
    for (const b of rows) {
      if (form?.id && Number(b.id) === Number(form.id)) continue
      for (const oid of String(b.linked_order_ids_csv || '').split(',').filter(Boolean)) m.set(Number(oid), b)
    }
    return m
  }, [rows, form?.id])

  // Same register the LC page downloads, in the same layout — whatever the
  // filter chips have narrowed the list to is exactly what goes into the file.
  const [exporting, setExporting] = useState(false)
  async function downloadRegister(): Promise<void> {
    setExporting(true)
    try {
      // The bills come straight off the screen, so the download reads nothing
      // for them. The instalments are not on screen, so they need one query --
      // but only if any bill in this list actually has instalments, which the
      // rows already say. A register of bills each settled in one payment
      // therefore downloads without touching the database at all.
      const parts = filtered.some((r) => n(r.repay_parts) > 0)
        ? await window.api.billDiscounting.allRepayments()
        : []
      // Only fetched when a bill in this list actually has more than one party,
      // so a register of single-party bills still downloads without a query.
      const parties = filtered.some((r) => n(r.party_count) > 1)
        ? await window.api.billDiscounting.allParties().catch(() => [] as Row[])
        : []
      await exportBdRegister(filtered, `bd-register-${todayISO()}`, parts, parties)
      toast.success(`Downloaded ${filtered.length} bill${filtered.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  // The customer's money coming back on a trading bill — the other half of the
  // round trip, the first being the repayment to the NBFC.
  const [payInRow, setPayInRow] = useState<Row | null>(null)
  const [payInDate, setPayInDate] = useState(todayISO())
  const [payInAmount, setPayInAmount] = useState('')
  const [payInOpen, setPayInOpen] = useState<Row[]>([])
  const [payInKeys, setPayInKeys] = useState<string[]>([])
  const [payInDone, setPayInDone] = useState<Row[]>([])
  const [payInSaving, setPayInSaving] = useState(false)
  // HOW the money came back. The same list the main process accepts — see
  // PAYMENT_IN_METHODS there — kept as a fixed set because the point of
  // recording it is to be able to ask "what came by cheque", and forty
  // spellings of RTGS answer nothing.
  const PAY_IN_METHODS = ['RTGS', 'NEFT', 'IMPS', 'UPI', 'Cheque', 'Cash', 'Adjustment', 'Other']
  const [payInMethod, setPayInMethod] = useState('RTGS')
  /**
   * WHERE THE MONEY LANDED, AND WHAT THE BANK CALLED IT.
   *
   * The receipt said how much and by what route but not into WHICH account,
   * so every one of them was debited to the single generic BANK A/C — no use
   * at all to a desk running three banks. The account named here is the one
   * the voucher debits, and the reference is what the line on the statement
   * is found by. Both optional: a receipt whose bank nobody wrote down is
   * still a receipt, and it books exactly as it always did.
   */
  const [payInAccount, setPayInAccount] = useState('')
  const [payInRef, setPayInRef] = useState('')
  const [bankAccounts, setBankAccounts] = useState<Row[]>([])
  // The banks a disbursement can land in, for the bill form. Read once the
  // form opens.
  const [formBanks, setFormBanks] = useState<Row[]>([])
  const formOpen = !!form || !!receiveRow || !!repayRow || !!legsRow || !!routeRow
  useEffect(() => {
    if (!formOpen) return
    let gone = false
    void window.api.journal
      .accounts()
      .then((accts) => {
        if (gone) return
        setFormBanks(accts.filter((a) => ['Bank Accounts', 'Bank OD A/c'].includes(String(a.acc_group || ''))))
      })
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [formOpen])

  const payInDue = useMemo(
    () => round2(payInOpen.filter((o) => payInKeys.includes(String(o.key))).reduce((t, o) => t + n(o.due), 0)),
    [payInOpen, payInKeys]
  )
  /**
   * A BILL WITH NOTHING TO ALLOCATE AGAINST STILL RECEIVES MONEY.
   *
   * A trading bill settles against its resale invoices, so the receipt is
   * spread across the ticked ones. Every other bill — which is most of the
   * money in these books — has no resale invoices at all: the customer pays,
   * and it is booked against the party the bill names. The main process has
   * done this for a while; the form did not, because every field was behind
   * the invoice list, so the one screen that knew the money was expected
   * could still not record that it had come.
   */
  const payInPlain = !!payInRow && payInOpen.length === 0

  // The Payment tracker's hand-over, once the bill is in the register: the
  // same screens the bill's own buttons open. Interest repayment is the
  // second choice on the Repay screen, so it opens that and turns to it.
  useEffect(() => {
    if (!focusAct) return
    const r = rows.find((x) => Number(x.id) === focusAct.id)
    if (!r) return
    setFocusAct(null)
    if (focusAct.action === 'repay') openRepay(r)
    else if (focusAct.action === 'interest') {
      openRepay(r)
      setRepayKind('interest')
    } else if (focusAct.action === 'payin') void openPayIn(r)
    else setOpenBd(focusAct.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAct, rows])

  async function openPayIn(r: Row): Promise<void> {
    setPayInRow(r)
    setPayInDate(todayISO())
    setPayInMethod('RTGS')
    setPayInRef('')
    setPayInAmount('')
    setPayInOpen([])
    setPayInKeys([])
    setPayInDone([])
    try {
      const [open, done, accts] = await Promise.all([
        window.api.billDiscounting.openTradingInvoices(Number(r.id)),
        window.api.billDiscounting.paymentIns(Number(r.id)),
        window.api.journal.accounts(Number(r.company_id) || undefined).catch(() => [] as Row[])
      ])
      // Only the accounts money can actually land in. Cash is on the list
      // because a receipt in cash is still a receipt, and it has to go
      // somewhere other than a bank.
      const banks = accts.filter((a) =>
        ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand'].includes(String(a.acc_group || ''))
      )
      setBankAccounts(banks)
      // The bank the last receipt on this bill went into, since the next one
      // almost always follows it. Nothing assumed when there was no last one.
      const lastAcct = String(done.find((x) => String(x.account || '').trim())?.account || '').trim()
      setPayInAccount(lastAcct && banks.some((b) => String(b.name) === lastAcct) ? lastAcct : '')
      setPayInOpen(open)
      // Everything still owing is ticked to begin with: a lump receipt clearing
      // the lot is the common case, and unticking is the exception.
      setPayInKeys(open.map((o) => String(o.key)))
      setPayInAmount(String(round2(open.reduce((t, o) => t + n(o.due), 0)) || ''))
      setPayInDone(done)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function savePayIn(): Promise<void> {
    if (!payInRow) return
    const amount = round2(n(payInAmount))
    if (amount <= 0) return void toast.error('Enter the amount received')
    // Only a receipt being SPREAD has to say across what, and only that one
    // can be more than what it is being spread over.
    if (!payInPlain) {
      if (!payInKeys.length) return void toast.error('Tick the invoice(s) this receipt is for')
      if (amount - payInDue > 0.004) {
        return void toast.error(`Only ${formatINR(payInDue)} is receivable on the ticked invoice(s)`)
      }
    }
    setPayInSaving(true)
    try {
      await window.api.billDiscounting.paymentIn(
        Number(payInRow.id),
        amount,
        payInDate,
        payInKeys,
        payInMethod,
        payInAccount || undefined,
        payInRef || undefined
      )
      toast.success(
        `${formatINR(amount)} from ${payInRow.receivable_party_name || 'the customer'} by ${payInMethod} recorded on the bill — no voucher; the bank's receipt comes from Tally`
      )
      // Stay on the bill: a part receipt is usually followed by the next one.
      const fresh = await load()
      const again = fresh.find((x) => Number(x.id) === Number(payInRow.id))
      if (again) await openPayIn(again)
      else setPayInRow(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPayInSaving(false)
    }
  }

  async function removePayIn(rec: Row): Promise<void> {
    if (!payInRow) return
    if (!window.confirm(`Remove the ${formatINR(rec.amount)} received on ${formatDate(rec.pay_date)}? Its voucher reverses too.`)) return
    try {
      await window.api.billDiscounting.deletePaymentIn(Number(rec.id))
      toast.success('Receipt removed — its voucher is reversed')
      const fresh = await load()
      const again = fresh.find((x) => Number(x.id) === Number(payInRow.id))
      if (again) await openPayIn(again)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Bill Discounting's channels were logged under the raw namespace 'bd' before
  // it was given a proper label, so both spellings are asked for and the older
  // history stays visible.
  // THE BILL'S OWN STORY, in the panel the rest of the app uses for one.
  //
  // It was a centred table of When / Who / Did what / Details — a grid to be
  // decoded rather than a sequence to be read, and it covered the register it
  // was asked about. This is the same trail as a timeline, from the right,
  // beside the row that raised the question.
  const hist = useRecordHistory()
  const openHistory = async (r: Row): Promise<void> => {
    // WHAT THE LOG DOES NOT KEEP.
    //
    // The trail records that a repayment happened and not what it was for, so
    // every one of them read "Repaid" with no figure beside it. The bill's own
    // repayment rows carry the amount and the moment they were saved, which is
    // exactly what the timeline buckets on — so each lands on its own entry.
    const parts = await window.api.billDiscounting.repayments(Number(r.id)).catch(() => [] as Row[])
    hist.open({
      activity: { entity: ['Bill discount', 'bd'], id: Number(r.id) },
      notes: (Array.isArray(parts) ? parts : []).map((p) => ({
        at: String(p.created_at || ''),
        text: `${formatINR(p.amount)} repaid${
          n(p.comm_charges) + n(p.bank_charges) + chargesOf(p) > 0.004
            ? ` + ${formatINR(round2(n(p.comm_charges) + n(p.bank_charges) + chargesOf(p)))} charges`
            : ''
        }${p.repay_date ? ` · ${formatDate(p.repay_date)}` : ''}${
          p.settle_via ? ` · ${String(p.settle_via)}` : ''
        }`
      })),
      kicker: 'Bill discounting',
      title: String(r.bd_no || 'this bill'),
      subtitle: `${r.nbfc_name || '—'} · ${r.party_name || '—'} · ${formatINR(r.amount)}`
    })
  }

  // WHAT THIS BILL PUT IN THE LEDGERS.
  // Opened from the bill rather than from the Day Book, because the question
  // is always asked with the bill in front of you — and a discounted bill
  // writes a voucher on the day it is funded, one on every repayment, one on
  // every interest payment and one on the margin coming back, which is a lot
  // to go looking for a date at a time.
  // ONLY FOR SOMEBODY WHO IS ALLOWED IN THE BOOKS.
  // The panel is a window on the ledgers, so it answers to the Accounting
  // grant and not to this page's — otherwise a purchase clerk with no reason
  // to see a bank ledger would reach one through a menu on an invoice. Same
  // convention as the Treasury tabs: no session at all (the desktop app) is
  // not a restriction.
  const canSeeLedgers = useMemo(() => {
    const u = loadUser()
    // The ledgers themselves: the Accounting · Ledgers section (which follows
    // Accounting for anyone not set otherwise).
    return !u || canAccess(u, 'accountsLedgers')
  }, [])
  const [postings, setPostings] = useState<PostingTarget | null>(null)
  const openPostings = (r: Row): void =>
    setPostings({
      entity: 'bd',
      id: Number(r.id),
      kicker: 'Bill discounting',
      title: String(r.bd_no || 'this bill'),
      subtitle: `${r.nbfc_name || '—'} · ${r.party_name || '—'} · ${formatINR(r.amount)}`
    })

  async function saveCombinedLimit(): Promise<void> {
    setLimitSaving(true)
    try {
      const res = await window.api.billDiscounting.setCombinedLimit(limitEdit ?? '')
      toast.success(res.value == null ? 'Combined limit cleared' : `Combined limit set to ${formatINR(res.value)}`)
      setLimitEdit(null)
      await loadLimits()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLimitSaving(false)
    }
  }

  function openReceive(r: Row): void {
    setReceiveRow(r)
    setReceiveParts(!!r.party_in_parts)
    setReceiveFirst(r.party_in_parts ? String(r.first_party_part || '') : '')
    setReceiveLegs(!!r.receipt_in_parts)
    setLegPlan(
      r.receipt_in_parts
        ? [
            {
              amount: String(r.first_receipt_part || ''),
              date: '',
              maturity: String(r.first_receipt_maturity || r.maturity_date || '').slice(0, 10),
              interest_pct: r.first_receipt_interest_pct == null ? '' : String(r.first_receipt_interest_pct),
              margin_pct: r.first_receipt_margin_pct == null ? '' : String(r.first_receipt_margin_pct)
            }
          ]
        : []
    )
    setReceiveDate(String(r.payment_received_date || '').slice(0, 10) || todayISO())
    // The bill's own answer where it has one; otherwise the usual one for its
    // type — a PID's money goes to the supplier, a SID's lands in our bank.
    const recorded = String(r.disbursement_route || '')
    const pid = String(r.finance_type) === 'PID'
    if (recorded === 'bank' || recorded === 'supplier') {
      setReceiveRoute(recorded)
      setReceiveAccount(String(r.disbursement_account || ''))
    } else if (r.payment_received_date) {
      // Already received but never confirmed: it is posted today as a receipt
      // into BANK A/C, and changing only the date must not quietly re-post it
      // somewhere else. That is what is offered; switching is a choice.
      setReceiveRoute('bank')
      setReceiveAccount('BANK A/C')
    } else {
      setReceiveRoute(pid ? 'supplier' : 'bank')
      setReceiveAccount('')
    }
  }

  async function saveReceive(): Promise<void> {
    if (!receiveRow) return
    if (!receiveDate) {
      toast.error('Pick the date the payment landed')
      return
    }
    if (receiveRoute === 'bank' && !receiveAccount) {
      toast.error('Pick the bank the money landed in')
      return
    }
    const net = Number(receiveRow.receiptAmount) || 0
    const firstPart = receiveRoute === 'supplier' && receiveParts && receiveRow.party_in_parts ? Math.round((Number(receiveFirst) || 0) * 100) / 100 : 0
    const sid = String(receiveRow.finance_type) === 'SID'
    // Parts with their own terms: our bank on any bill, or the supplier
    // direct on a PID that is not already on the older paid-in-parts.
    const legsOn = receiveLegs && (receiveRoute === 'bank' || !receiveRow.party_in_parts)
    const plan = legsOn
      ? legPlan.map((l, i) => ({
          amount: Math.round((Number(l.amount) || 0) * 100) / 100,
          date: i === 0 ? receiveDate : String(l.date || '').slice(0, 10),
          maturity: String(l.maturity || '').slice(0, 10),
          interest_pct: String(l.interest_pct ?? '').trim(),
          margin_pct: String(l.margin_pct ?? '').trim()
        }))
      : []
    const firstLeg = plan.length ? plan[0].amount : 0
    if (legsOn) {
      if (!plan.length) return void toast.error('Add the first part')
      let prev = receiveDate
      for (let i = 0; i < plan.length; i++) {
        const l = plan[i]
        const no = i + 1
        if (l.amount <= 0) return void toast.error(`Enter part ${no}'s amount`)
        if (!l.date) return void toast.error(`Pick the day part ${no} landed`)
        if (l.date > todayISO()) return void toast.error(`Part ${no} cannot be dated in the future`)
        if (l.date < prev) return void toast.error(`Part ${no} cannot be dated before part ${no - 1}`)
        prev = l.date
        if (!l.maturity) return void toast.error(`Pick when part ${no} matures`)
        if (l.maturity < l.date) return void toast.error(`Part ${no} cannot mature before it landed`)
      }
      const total = Math.round(plan.reduce((s, l) => s + l.amount, 0) * 100) / 100
      if (total > (Number(receiveRow.amount) || 0) + 0.005) {
        toast.error(`The parts come to ${formatINR(total)}, more than the ${formatINR(Number(receiveRow.amount) || 0)} drawn on this bill`)
        return
      }
    }
    if (receiveRoute === 'supplier' && receiveParts && receiveRow.party_in_parts) {
      if (firstPart <= 0) {
        toast.error('Enter the first part the NBFC paid the supplier')
        return
      }
      if (firstPart > net + 0.005) {
        toast.error(`The first part cannot be more than the ${formatINR(net)} the NBFC releases`)
        return
      }
    }
    setReceiveSaving(true)
    try {
      await window.api.billDiscounting.markReceived(
        Number(receiveRow.id),
        receiveDate,
        receiveRoute,
        receiveRoute === 'bank' ? receiveAccount : null,
        firstPart > 0 ? firstPart : null,
        // Legs only where they can be; a bill that never had them is left alone.
        firstLeg > 0 ? firstLeg : sid || receiveRow.receipt_in_parts ? null : undefined,
        legsOn ? plan : null
      )
      toast.success(
        receiveRow.payment_received_date
          ? 'Receipt date changed — its voucher is re-posted'
          : 'Payment received — the bill is live and its disbursement is posted'
      )
      setReceiveRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReceiveSaving(false)
    }
  }

  // The credit never landed, or it was marked against the wrong bill.
  async function undoReceive(r: Row): Promise<void> {
    if (!window.confirm(`Undo the payment received on ${r.bd_no || 'this bill'}? Its disbursement voucher reverses too.`)) return
    try {
      await window.api.billDiscounting.unmarkReceived(Number(r.id))
      toast.success('Receipt undone — the bill is back to awaiting payment')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove(r: Row): Promise<void> {
    if (!window.confirm(`Delete ${r.bd_no || 'this discounted bill'}? Its vouchers reverse too.`)) return
    try {
      await window.api.billDiscounting.remove(Number(r.id))
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function reopen(r: Row): Promise<void> {
    try {
      await window.api.billDiscounting.reopen(Number(r.id))
      toast.success('Reopened — its repayment voucher is reversed')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-3">
      {/* KPI band — the same shape the LC Facility Limit card uses. */}
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
          <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>Bill Discounting</span>
          <span className={cn('rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums', __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-2 !py-1 !text-[11px] !font-bold !text-[#33473E]')}>
            {narrowed ? `${n(kpis.count)} of ${n(kpisAll.count)} open` : `${n(kpisAll.count)} open`}
          </span>
          {/* Awaiting bills are deliberately NOT in the money figures below —
              nothing has been disbursed on them — so they are counted here
              rather than being left invisible. */}
          {n(kpisAll.awaiting_count) > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilter(statusFilter === 'awaiting' ? 'all' : 'awaiting')}
              className={cn('rounded-full bg-amber-400/90 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#1a2c56] transition-colors hover:bg-amber-300', __WEB__ && '!rounded-[2px] !border !border-[#F0D9AE] !bg-[#FFFBF2] !px-2 !py-1 !text-[11px] !font-bold !text-[#8A5300] hover:!bg-[#FFEDD0]')}
              title="Opened, waiting on the NBFC's payment — click to show only these"
            >
              {n(kpisAll.awaiting_count)} awaiting {formatINR(kpisAll.awaiting_total)}
            </button>
          )}
          {/* WHERE THE RIGHT-HAND GROUP STARTS.
              The gap was being made by whichever element happened to carry
              ml-auto, and that was the ALERT — which only renders when there
              is something maturing. So a company with an alert got its
              buttons on the right and a company without got them jammed up
              against the title, and the same page looked like two different
              pages depending on its data.
              The spacer is always here instead, so the split is a property of
              the toolbar rather than of what is in it. */}
          {__WEB__ && <span aria-hidden className="ml-auto" />}
          {__WEB__ &&
            alerts.map((a) => (
              <button
                key={a.key}
                type="button"
                title={`Click to see all ${a.count}`}
                onClick={() => onOpenAlert?.(a.key)}
                className={cn(
                  'flex h-[34px] items-center gap-1.5 rounded-[3px] border px-3 text-[12px] font-extrabold uppercase tracking-[.05em] transition-colors hover:brightness-95',
                  a.tone
                )}
              >
                <a.icon className="h-3.5 w-3.5" /> {a.label}
                <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              </button>
            ))}
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'ml-auto h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white',
              __WEB__ && '!ml-0 !h-[34px] !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6] hover:!text-[#0A1F17]'
            )}
            disabled={exporting || filtered.length === 0}
            title={filtered.length === 0 ? 'Nothing in this filter to download' : 'Download this register as Excel'}
            onClick={() => void downloadRegister()}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> {exporting ? 'Preparing…' : 'Download Excel'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white',
              __WEB__ && '!h-[34px] !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6] hover:!text-[#0A1F17]'
            )}
            onClick={() => setNbfcOpen(true)}
          >
            <Settings2 className="h-3.5 w-3.5" /> Manage NBFCs
          </Button>
          {/* WHAT EACH LINE IS SANCTIONED AT, ON A SCREEN OF ITS OWN.
              It was a toggle inside the NBFC master, which is where a party's
              rate and tenor are kept — a limit is neither of those. It is a
              facility: a figure that moves on a date for a reason, with a
              history and now a place to record principal repaid against it. */}
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white',
              __WEB__ && '!h-[34px] !rounded-[3px] !border-[#C3D2C6] !bg-white !px-3 !text-[12px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6] hover:!text-[#0A1F17]'
            )}
            onClick={() => {
              setLimitHistory(null)
              setLimitsOpen(true)
              void loadLimits()
            }}
          >
            <Landmark className="h-3.5 w-3.5" /> Manage Limits
          </Button>
          {/* Primary action, amber against the navy so it stands out from the
              header it sits on. */}
          <Button
            size="sm"
            className={cn(
              'h-7 bg-amber-400 px-2 text-xs font-semibold text-[#1a2c56] shadow-sm hover:bg-amber-300',
              __WEB__ && '!h-[34px] !gap-1.5 !rounded-[3px] !bg-[#0B3D2E] !px-3.5 !text-[12px] !font-extrabold !text-[#C7F03F] !shadow-none hover:!bg-[#0F4A38]'
            )}
            onClick={openNew}
          >
            <Plus className="h-4 w-4" /> Discount a bill
          </Button>
        </div>
        {/* ONE ROW OF CELLS, AND NOTHING ABOVE IT.
            There was a summary band over this strip restating Outstanding and
            the available limit in larger type — a band of height spent saying
            twice what the cells below already said once. Outstanding leads the
            row instead, because it is what the section is about, and the
            available limit closes it, after what was received. Both are cells
            like the rest now rather than a headline. */}
        <div
          className={cn(
            'grid grid-cols-2 gap-px bg-[#e5dfc8] p-px sm:grid-cols-3 lg:grid-cols-6',
            __WEB__ && '!grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] !gap-px !border-t !border-t-[#E4ECE3] !bg-[#E4ECE3] !p-0'
          )}
        >
          {/* Outstanding, first. It was hidden here while the band above
              carried it; with the band gone it is a cell like the others. */}
          {/* EVERY CELL IS A WAY IN: Outstanding shows the open bills; each
              figure lists the bills largest first on it; the available limit
              opens the limits. */}
          <div
            role="button"
            tabIndex={0}
            title="Show the open bills"
            onClick={() => setStatusFilter('live')}
            className={cn('bg-[#1a2c56] px-3 py-2.5 text-center', BD_CELL, 'cursor-pointer transition-[filter] hover:brightness-[.97]')}
          >
            <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-white/70', BD_K)}>Outstanding</div>
            <div className={cn('text-[15px] font-bold tabular-nums text-white', __WEB__ && cn(BD_V, 'doc-ref'))}>
              {formatINR(kpis.outstanding_total)}
            </div>
            {__WEB__ && (
              <div className={BD_SUB}>
                on {n(kpis.count)} bill{n(kpis.count) === 1 ? '' : 's'}
                {narrowed ? ` of ${formatINR(kpisAll.outstanding_total)}` : ''}
              </div>
            )}
            {narrowed && (
              <div className="text-[10px] tabular-nums text-white/50">of {formatINR(kpisAll.outstanding_total)}</div>
            )}
          </div>
          <div
            role="button"
            tabIndex={0}
            title="List the bills by margin held, largest first"
            onClick={() => bdSort.sortBy('margin', 'desc')}
            className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', BD_CELL, 'cursor-pointer transition-[filter] hover:brightness-[.97]')}
          >
            <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', BD_K)}>Margin held</div>
            <div className={cn('text-[15px] font-bold tabular-nums text-[#1a2c56]', BD_V)}>{formatINR(kpis.margin_total)}</div>
            {narrowed && (
              <div className={cn('text-[10px] tabular-nums text-muted-foreground', BD_SUB)}>of {formatINR(kpisAll.margin_total)}</div>
            )}
          </div>
          <div
            role="button"
            tabIndex={0}
            title="List the bills by interest, largest first"
            onClick={() => bdSort.sortBy('interest', 'desc')}
            className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', BD_CELL, 'cursor-pointer transition-[filter] hover:brightness-[.97]')}
          >
            <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', BD_K)}>Interest</div>
            <div className={cn('text-[15px] font-bold tabular-nums text-rose-700', BD_V, __WEB__ && '!text-[#8C2F26]')}>{formatINR(kpis.interest_total)}</div>
            {narrowed && (
              <div className={cn('text-[10px] tabular-nums text-muted-foreground', BD_SUB)}>of {formatINR(kpisAll.interest_total)}</div>
            )}
          </div>
          <div
            role="button"
            tabIndex={0}
            title="List the bills by TDS withheld, largest first"
            onClick={() => bdSort.sortBy('tds', 'desc')}
            className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', BD_CELL, 'cursor-pointer transition-[filter] hover:brightness-[.97]')}
          >
            <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', BD_K)}>TDS withheld</div>
            <div className={cn('text-[15px] font-bold tabular-nums text-[#1a2c56]', BD_V, __WEB__ && '!text-[#8A5300]')}>{formatINR(kpis.tds_total)}</div>
            {narrowed && (
              <div className={cn('text-[10px] tabular-nums text-muted-foreground', BD_SUB)}>of {formatINR(kpisAll.tds_total)}</div>
            )}
          </div>
          <div
            role="button"
            tabIndex={0}
            title="List the bills by what reached the bank, largest first"
            onClick={() => bdSort.sortBy('receipt', 'desc')}
            className={cn('bg-emerald-50 px-3 py-2.5 text-center', BD_CELL, __WEB__ && '!bg-[#F4FBF6]', 'cursor-pointer transition-[filter] hover:brightness-[.97]')}
          >
            <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-emerald-800', BD_K, __WEB__ && '!text-[#0B6B45]')}>Received</div>
            <div className={cn('text-[15px] font-bold tabular-nums text-emerald-900', BD_V, __WEB__ && '!text-[#0B6B45]')}>{formatINR(kpis.receipt_total)}</div>
            {narrowed && (
              <div className={cn('text-[10px] tabular-nums text-emerald-800/60', BD_SUB, __WEB__ && '!text-[#0B6B45]')}>of {formatINR(kpisAll.receipt_total)}</div>
            )}
          </div>
          {/* Sanctioned less what is drawn. The drawn half is the outstanding
              already on this strip, so this stays current as bills are raised
              and repaid without asking the database again — only the sanctioned
              half is fetched, and only when a limit is edited.
              Nothing sanctioned means there is no headroom to state: it says so
              and points at where to set it, rather than showing a figure. */}
          <div
            role="button"
            tabIndex={0}
            title="Open the facility limits"
            onClick={() => {
              setLimitHistory(null)
              setLimitsOpen(true)
              void loadLimits()
            }}
            className={cn(
              'cursor-pointer transition-[filter] hover:brightness-[.97]',
              'px-3 py-2.5 text-center',
              availableLimit == null ? 'bg-[#fffdf4]' : availableLimit < 0 ? 'bg-red-50' : 'bg-sky-50',
              BD_CELL,
              __WEB__ &&
                (availableLimit == null ? '!bg-[#FFFBF2]' : availableLimit < 0 ? '!bg-[#FDF3F2]' : '!bg-[#F4FBF6]')
            )}
          >
            <div
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wide',
                availableLimit == null ? 'text-muted-foreground' : availableLimit < 0 ? 'text-red-800' : 'text-sky-800',
                BD_K,
                __WEB__ && (availableLimit == null ? '!text-[#8A5300]' : availableLimit < 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]')
              )}
            >
              {nbfcFilter.length === 0
                ? 'Available limit'
                : nbfcFilter.length === 1
                  ? 'Available · this NBFC'
                  : `Available · ${nbfcFilter.length} NBFCs`}
            </div>
            {availableLimit == null ? (
              <button
                type="button"
                className={cn('text-[12px] font-medium text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground', __WEB__ && '!mt-1 !text-[13px] !font-extrabold !text-[#8A5300]')}
                title="Set a limit on each NBFC, or a combined ceiling, under Manage NBFCs → Facility limits"
                onClick={(e) => {
                  e.stopPropagation()
                  setNbfcOpen(true)
                }}
              >
                not set
              </button>
            ) : (
              <>
                <div className={cn('text-[15px] font-bold tabular-nums', availableLimit < 0 ? 'text-red-700' : 'text-sky-900', BD_V, __WEB__ && cn('doc-ref', availableLimit < 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]'))}>
                  {formatINR(availableLimit)}
                </div>
                <div className={cn('truncate text-[10px]', availableLimit < 0 ? 'text-red-700' : 'text-sky-800', BD_SUB, __WEB__ && (availableLimit < 0 ? '!text-[#8C2F26]' : '!text-[#5A6B62]'))}
                  title={
                    nbfcFilter.length
                      ? `${limitBasis?.label} — sanctioned ${formatINR(limitBasis?.ceiling)}, less what is drawn on ${nbfcFilter.length === 1 ? 'it' : 'them'}`
                      : `The whole book — ${limits?.effective_basis === 'lines' ? 'the sum of the NBFC lines' : 'the combined ceiling'}`
                  }
                >
                  of {formatINR(limitBasis?.ceiling)}
                  {nbfcFilter.length
                    ? ` · ${limitBasis?.label}`
                    : limits?.effective_basis === 'lines'
                      ? ' (NBFC lines)'
                      : ' (combined)'}
                  {availableLimit < 0 ? ' · over the limit' : ''}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filter chips — mirroring the LC register's own row. */}
      <div className={cn('flex flex-wrap items-center gap-2', __WEB__ && '!gap-2.5')}>
        <span className={cn(__WEB__ && cn('inline-flex flex-wrap', BD_TRAY))}>
        {DUE_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setDuePeriod(p.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              duePeriod === p.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50',
              __WEB__ && cn(BD_CHIP, duePeriod === p.key ? BD_CHIP_ON : BD_CHIP_OFF)
            )}
          >
            {p.label}
          </button>
        ))}
        </span>
        {!__WEB__ && <div className="h-4 w-px bg-[#e5dfc8]" />}
        <span className={cn(__WEB__ && cn('inline-flex', BD_TRAY))}>
        {(['PID', 'SID'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTypeFilter(typeFilter === t ? null : t)}
            title={t === 'PID' ? 'Purchase Invoice Discounting' : 'Sales Invoice Discounting'}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              typeFilter === t ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50',
              __WEB__ && cn(BD_CHIP, typeFilter === t ? BD_CHIP_ON : BD_CHIP_OFF)
            )}
          >
            {t}
          </button>
        ))}
        </span>
        {!__WEB__ && <div className="h-4 w-px bg-[#e5dfc8]" />}
        {/* Desktop keeps the stage as a fourth pill tray. The website moves it
            out of this row entirely — see the tab strip below: the due window
            and the stage are two different questions, and a single row of
            identical pills made them look like one list where picking two
            things from the same tray was the obvious (wrong) reading. */}
        {!__WEB__ && (
          <span>
          {STAGES.map((st) => (
            <button
              key={st.key}
              type="button"
              title={st.title}
              onClick={() => setStatusFilter(st.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                statusFilter === st.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50'
              )}
            >
              {st.label}
            </button>
          ))}
          </span>
        )}
        {/* The stage, as the third tray on this row. It was a tab strip on a
            line of its own below; one line is easier to scan than two, and a
            tray of its own keeps it from reading as more of the due-window
            list beside it. The counts come with it — "Repaid 0" is an answer,
            where an empty table is not. */}
        {__WEB__ && (
          <span className={cn('inline-flex flex-wrap', BD_TRAY)}>
            {STAGES.map((st) => {
              const on = statusFilter === st.key
              return (
                <button
                  key={st.key}
                  type="button"
                  title={st.title}
                  onClick={() => setStatusFilter(st.key)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                    BD_CHIP,
                    on ? BD_CHIP_ON : BD_CHIP_OFF
                  )}
                >
                  {st.label}
                  <span
                    className={cn(
                      'doc-ref rounded-[2px] px-1.5 py-0.5 text-[10px] font-bold leading-none',
                      on ? 'bg-white/15 text-[#C7F03F]' : 'bg-white/80 text-[#5A6B62]'
                    )}
                  >
                    {stageCount(st.key)}
                  </span>
                </button>
              )
            })}
          </span>
        )}
        {/* Type-to-find across the register, searching the three things anyone
            actually remembers about a bill.
            It takes whatever the filters leave and no more. Fixed at 260 it
            stopped short of the view toggle and left a band of dead space
            between them; given the whole row it was wider than every filter
            put together, which read as the point of the row. Now the filters
            are sized first and this fills what is left — which is also why it
            needs no breakpoints: at any width it is exactly the gap. */}
        {__WEB__ && (
          <span className="flex h-[42px] min-w-[170px] flex-1 items-center gap-2.5 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
            <Search className="h-[18px] w-[18px] shrink-0 text-[#5A6B62]" />
            <input
              value={bdQuery}
              onChange={(e) => setBdQuery(e.target.value)}
              placeholder="Search bill no, NBFC, party…"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-[#0A1F17] outline-none placeholder:text-[#8FA79B]"
            />
            {!!bdQuery && (
              <button
                type="button"
                onClick={() => setBdQuery('')}
                className="shrink-0 text-[#8FA79B] hover:text-[#0A1F17]"
                title="Clear the search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </span>
        )}
        <div className={cn('ml-auto flex gap-1 rounded-md border border-[#d9d2b8] bg-white p-0.5', __WEB__ && '!rounded-[4px] !border-[#DCE7DB] !bg-[#EAF0E9] !p-[3px]')}>
          <Button size="icon" variant={view === 'cards' ? 'default' : 'ghost'} className="h-7 w-7" title="Card view" onClick={() => setView('cards')}>
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant={view === 'table' ? 'default' : 'ghost'} className="h-7 w-7" title="Table view" onClick={() => setView('table')}>
            <List className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {view === 'cards' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Card className="flex items-center justify-center border-dashed p-6">
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={openNew}>
              <Plus className="h-4 w-4" /> Discount a bill
            </Button>
          </Card>
          {filtered.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground md:col-span-1 xl:col-span-2">
              Nothing in this bucket.
            </Card>
          ) : (
            bdSort.sorted.map((r) => {
              const repaid = String(r.status) === 'repaid'
              const awaiting = String(r.stage) === 'awaiting'
              const tone = STATUS_TONE[String(r.stage)] || STATUS_TONE.open
              return (
                <Card key={String(r.id)} className={cn('flex flex-col gap-3 overflow-hidden border-l-4 p-0 [border-left-style:solid]', tone.row)}>
                  <div className="flex flex-col gap-3 p-4 pb-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={cn('text-[15px] font-bold', !r.bd_no && 'italic text-muted-foreground')}>
                            {r.bd_no || 'No BD no'}
                          </span>
                          <Badge variant="muted">{r.finance_type}</Badge>
                          {repaid ? (
                            <Badge variant="success">Repaid {formatDate(r.repaid_date)}</Badge>
                          ) : awaiting ? (
                            <Badge variant="warning">Awaiting payment</Badge>
                          ) : n(r.repaid_total) > 0 ? (
                            <Badge variant="warning">Part repaid</Badge>
                          ) : (
                            <Badge variant="default">Open</Badge>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Landmark className="h-3 w-3 shrink-0" /> {r.nbfc_name || '—'}
                          <span className="text-[#e5dfc8]">·</span>
                          <Users className="h-3 w-3 shrink-0" />{' '}
                          {n(r.party_count) > 1 ? `${r.party_names} (${r.party_count})` : r.party_name || '—'}
                        </div>
                      </div>
                      <Badge variant={String(r.purpose) === 'trading' ? 'success' : 'muted'} className="capitalize">
                        {r.purpose}
                      </Badge>
                    </div>
                    {/* A part-repaid bill's face value is no longer what it
                        owes, so the outstanding balance leads and the face
                        amount goes underneath it. */}
                    <div className="rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
                        {n(r.repaid_total) > 0 && !repaid ? 'Outstanding' : 'Open amount'}
                      </div>
                      <div className="text-2xl font-bold tabular-nums text-white">
                        {formatINR(n(r.repaid_total) > 0 && !repaid ? r.outstanding_amount : r.amount)}
                      </div>
                      {n(r.repaid_total) > 0 && !repaid && (
                        <div className="mt-0.5 text-[11px] tabular-nums text-white/70">
                          {formatINR(r.repaid_total)} of {formatINR(r.amount)} repaid
                          {n(r.repay_parts) > 0 && ` · ${n(r.repay_parts)} ${n(r.repay_parts) === 1 ? 'part' : 'parts'}`}
                        </div>
                      )}
                      {n(r.invoice_amount) > 0 && (
                        <div className="mt-0.5 text-[11px] tabular-nums text-white/70">
                          against a {formatINR(r.invoice_amount)} invoice
                        </div>
                      )}
                      {/* Same rule as the chip: the tally of what has come
                          back is the checking view, so it goes with it. */}
                      {(payInChipEveryone || iAmAdmin) && String(r.purpose) === 'trading' && n(r.payment_in_total) > 0 && (
                        <div className="mt-0.5 text-[11px] tabular-nums text-emerald-200">
                          {formatINR(r.payment_in_total)} back from {r.receivable_party_name || 'the customer'}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div className="rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5">
                        <div className="text-muted-foreground">Margin {n(r.margin_pct)}%</div>
                        <div className="font-semibold tabular-nums text-[#1a2c56]">{formatINR(r.marginAmount)}</div>
                      </div>
                      <div className="rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5">
                        <div className="text-muted-foreground">Interest · {n(r.intDays)}d</div>
                        <div className="font-semibold tabular-nums text-rose-700">{formatINR(r.interestAmount)}</div>
                      </div>
                      <div className="rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5">
                        <div className="text-muted-foreground">TDS {n(r.tds_pct)}%</div>
                        <div className="font-semibold tabular-nums text-[#1a2c56]">{formatINR(r.tdsAmount)}</div>
                      </div>
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5">
                        <div className="text-muted-foreground">Receipt</div>
                        <div className="font-semibold tabular-nums text-emerald-700">{formatINR(r.receiptAmount)}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <CalendarRange className="h-3 w-3 shrink-0" />{' '}
                        {awaiting ? 'payment awaited' : formatDate(r.payment_received_date)} → {formatDate(r.maturity_date)}
                      </span>
                      {!repaid && !awaiting && <DueBadge date={r.maturity_date} />}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] px-4 py-3">
                    {/* One button, whichever stage the bill is at: the money
                        has to come in before it can go back out. */}
                    {repaid ? (
                      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void reopen(r)}>
                        <RotateCcw className="h-3.5 w-3.5" /> Reopen
                      </Button>
                    ) : awaiting ? (
                      <Button size="sm" className="h-7 gap-1 bg-amber-600 px-2 text-xs hover:bg-amber-700" onClick={() => openReceive(r)}>
                        <Banknote className="h-3.5 w-3.5" /> Mark payment received
                      </Button>
                    ) : (
                      <>
                        {r.party_in_parts && Number(r.party_left) > 0.5 && (
                          <Button size="sm" className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700" onClick={() => setPartyRow(r)}>
                            Pay party
                          </Button>
                        )}
                        {r.receipt_in_parts && Number(r.toReceive) > 0.5 && (
                          <Button size="sm" className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700" onClick={() => setLegsRow(r)}>
                            {String(r.disbursement_route || '') === 'supplier' ? 'Pay party' : 'Receive part'}
                          </Button>
                        )}
                        <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openRepay(r)}>
                          Repay
                        </Button>
                      </>
                    )}
                    <RowActions
                      actions={[
                        {
                          label: 'Edit bill',
                          icon: Pencil,
                          disabled: repaid,
                          disabledReason: 'Already repaid — reopen it first',
                          onClick: () => openEdit(r)
                        },
                        ...(bdRefundDue[String(r.id)] ? [{ label: `Refund received — ${formatINR(bdRefundDue[String(r.id)])} due back`, icon: Undo2, onClick: () => setRefundBd(Number(r.id)) }] : []),
                        {
                          label: 'Disbursement paid to…',
                          icon: Landmark,
                          onClick: () => openRoute(r)
                        },
                        {
                          label: 'Payment IN — money back from the customer',
                          icon: Banknote,
                          // A TRADING BILL SETTLES AGAINST ITS RESALE
                          // INVOICES; EVERY OTHER BILL JUST RECEIVES.
                          //
                          // This was trading-only, so a manufacturing bill —
                          // most of the money in these books — could not record
                          // that the customer had paid at all. It needs a party
                          // for the money to come from, and nothing else.
                          disabled:
                            String(r.purpose) === 'trading'
                              ? !r.receivable_party_id
                              : !Number(r.payment_in_expected) || !r.party_id,
                          disabledReason:
                            String(r.purpose) === 'trading'
                              ? 'Set who pays back, and link the purchase invoices, on the bill first'
                              : !Number(r.payment_in_expected)
                                ? 'Turn on “Payment will come back IN” at the foot of the bill first'
                                : 'This bill names no party for the money to come back from',
                          onClick: () => void openPayIn(r)
                        },
                        { label: 'History — who did what', icon: History, onClick: () => void openHistory(r) },
                        ...(__WEB__ && canSeeLedgers
                          ? [
                              {
                                label: 'Ledger posting — what it put in the books',
                                icon: BookOpen,
                                onClick: () => openPostings(r)
                              }
                            ]
                          : []),
                        {
                          label: 'Change payment received date',
                          icon: CalendarRange,
                          disabled: repaid || awaiting,
                          disabledReason: repaid ? 'Already repaid — reopen it first' : 'No payment marked on this bill yet',
                          onClick: () => openReceive(r)
                        },
                        {
                          label: 'Undo payment received',
                          icon: RotateCcw,
                          disabled: repaid || awaiting,
                          disabledReason: repaid ? 'Already repaid — reopen it first' : 'No payment marked on this bill yet',
                          onClick: () => void undoReceive(r)
                        },
                        ...(r.party_in_parts
                          ? [{ label: 'Payments to the supplier — part by part', icon: Banknote, onClick: () => setPartyRow(r) }]
                          : []),
                        ...(r.receipt_in_parts
                          ? [{ label: 'Received from the NBFC — part by part', icon: Banknote, onClick: () => setLegsRow(r) }]
                          : []),
                        {
                          label: 'Delete — reverses its vouchers',
                          icon: Trash2,
                          danger: true,
                          onClick: () => void remove(r)
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
        <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
          <div className="overflow-x-auto">
            {/* Faint column rules. Fifteen numeric columns with nothing between
                them made it easy to read a figure off the wrong one — the eye
                has only the gaps to go on, and on a wide row the gaps are
                large. Kept very light (the ink at 8%) so they guide the eye
                without turning the register into a grid; the heavier rule
                before Sanctioned still marks the money section. */}
            {/* A pane one screen tall (less the page header above it), so the
                column header's sticky top-0 has something to stick to — inside
                the sideways scroll it was pinned to a box as tall as the table,
                which never scrolls, and so it went off the top with the rows.
                The page scrolls the figures and filters away; the bills then
                scroll under the header. Bargains does the same. */}
            <Table
              wrapperClassName="max-h-[calc(100vh-96px)]"
              className={cn('text-[13px] [&_td]:border-r [&_td]:border-[#1a2c56]/[0.08] [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-[#1a2c56]/[0.12] [&_th:last-child]:border-r-0', __WEB__ && '!min-w-[1380px] [&_td]:!border-r-[#EAF0E9]')}
            >
              <TableHeader className="sticky top-0 z-10">
                {/* What the row is actually made of: who and when, what the
                    bill was worth, what the NBFC kept, and what landed. Named
                    once above the columns so nine figures read as four ideas. */}
                {__WEB__ && (
                  <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[28px] [&>th]:!bg-[#072B20] [&>th]:!p-0 [&>th]:!text-[9.5px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.18em] [&>th]:!text-[#8FBFA8]">
                    <TableHead colSpan={2} />
                    <TableHead colSpan={3} className="!border-l !border-l-[#C7F03F]/20 !bg-white/[0.04] !text-center">
                      The term
                    </TableHead>
                    <TableHead className="!border-l !border-l-[#C7F03F]/20 !text-center">Bill</TableHead>
                    <TableHead colSpan={3} className="!border-l !border-l-[#C7F03F]/20 !bg-[#B3261E]/[.12] !text-center !text-[#F0AFAA]">
                      What the NBFC kept
                    </TableHead>
                    <TableHead className="!border-l !border-l-[#C7F03F]/20 !bg-[#C7F03F]/[.14] !text-center !text-[#C7F03F]">
                      Reached you
                    </TableHead>
                    <TableHead />
                  </TableRow>
                )}
                <TableRow className={cn('border-b-2 border-[#1a2c56]/20 bg-[#dce6f5] hover:bg-[#dce6f5]', BD_HEAD)}>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    <span className="inline-flex items-center">
                      <ColumnFilter
                        label="BD no · NBFC"
                        options={bdNoOptions}
                        value={bdNoFilter}
                        onApply={setBdNoFilter}
                      />
                      {sortBtn('bd', 'BD no')}
                    </span>
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    <span className="inline-flex items-center">
                      <ColumnFilter
                        label="Party"
                        options={partyOptions}
                        value={partyFilter}
                        onApply={setPartyFilter}
                      />
                      {sortBtn('party', 'Party')}
                    </span>
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Validity{sortBtn('validity', 'Validity')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Days left{sortBtn('days', 'Days left')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Int. days{sortBtn('intdays', 'Int. days')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap border-l border-[#1a2c56]/15 text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Open amount{sortBtn('open', 'Open amount')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Margin{sortBtn('margin', 'Margin')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Interest{sortBtn('interest', 'Interest')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    TDS{sortBtn('tds', 'TDS')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    {/* Lime: what actually reached the bank account is the
                        figure this register exists to report. */}
                    <span className={cn(__WEB__ && '!text-[#C7F03F]')}>Receipt</span>
                    {sortBtn('receipt', 'Receipt')}
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* What the filters actually left, summed — the same idea the LC
                    register uses, so a bucket answers "how much" without
                    adding it up by eye. */}
                {filtered.length > 0 && (
                  <TableRow className={cn('border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50', BD_TOTAL)}>
                    <TableCell className={cn('whitespace-nowrap font-semibold text-amber-900', __WEB__ && '!text-[12px] !font-extrabold !uppercase !tracking-[.06em] !text-[#0A1F17]')}>
                      Total
                      <span className={cn('ml-1.5 font-normal text-amber-800/70', __WEB__ && '!font-semibold !normal-case !tracking-normal !text-[#5A6B62]')}>
                        · {filtered.length} bill{filtered.length === 1 ? '' : 's'}
                      </span>
                    </TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    {(
                      [
                        ['amount', ''],
                        ['marginAmount', ''],
                        ['interestAmount', 'text-rose-700'],
                        ['tdsAmount', ''],
                        ['receiptAmount', 'text-emerald-700']
                      ] as [string, string][]
                    ).map(([k, tone], i) => (
                      <TableCell
                        key={k}
                        className={cn(
                          'whitespace-nowrap text-right font-semibold tabular-nums text-amber-900',
                          i === 0 && 'border-l border-[#1a2c56]/15',
                          tone
                        )}
                      >
                        {/* A serviced bill contributes nothing to what the
                            NBFC kept — its interest is paid across during the
                            tenor — so it must not be added in here either, or
                            the total contradicts the rows above it. */}
                        {formatINR(
                          filtered.reduce(
                            (t, x) =>
                              t +
                              (isServiced(x) && (k === 'interestAmount' || k === 'tdsAmount') ? 0 : n(x[k])),
                            0
                          )
                        )}
                      </TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                )}
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
                      No discounted bills in this bucket.
                    </TableCell>
                  </TableRow>
                ) : (
                  bdSort.sorted.map((r) => {
                    const repaid = String(r.status) === 'repaid'
                    const awaiting = String(r.stage) === 'awaiting'
                    const tone = STATUS_TONE[String(r.stage)] || STATUS_TONE.open
                    return (
                      <Fragment key={String(r.id)}>
                      <TableRow
                        onClick={__WEB__ ? () => setOpenBd(Number(r.id)) : undefined}
                        className={cn('border-b border-dotted border-[#e5dfc8] bg-white transition-colors', tone.row, tone.hover, __WEB__ && cn('!border-b-2 !border-b-[#E8EFE7] !border-solid !border-l-[3px] !bg-white hover:!bg-[#F7FAF6] [&>td]:!py-2.5 cursor-pointer', openBd === Number(r.id) && '!bg-[#F7FAF6]'))}
                      >
                        <TableCell className={cn('whitespace-nowrap', __WEB__ && '!whitespace-normal')}>
                          <div className="flex items-center gap-1.5">
                            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', __WEB__ && openBd === Number(r.id) && 'rotate-90 !text-[#0B6B45]')} />
                            <div>
                              <div className={cn('flex items-center gap-1.5', __WEB__ && 'whitespace-nowrap')}>
                                <span className={cn('font-semibold', !r.bd_no && 'italic text-muted-foreground', __WEB__ && 'doc-ref !text-[12.5px] !font-bold !text-[#0A1F17]')}>{r.bd_no || 'No BD no'}</span>
                                <RefundDueChip tot={bdRefundTot[String(r.id)]} />
                                <FinChip type={r.finance_type} />
                                {/* Payment-IN at a glance, beside the side of
                                    the book it belongs to. Keyed on the SAME
                                    flag as the "Payment IN expected / received"
                                    badge below (r.payment_in_expected), so the
                                    dot appears for exactly the payment-IN bills
                                    and nothing else: green once money has come
                                    back, red while it is still expected. */}
                                {!!r.payment_in_expected && (
                                  <span
                                    title={
                                      n(r.payment_in_total) > 0.004
                                        ? `Payment received — ${formatINR(r.payment_in_total)} back from ${r.receivable_party_name || 'the customer'}`
                                        : 'Payment IN still expected'
                                    }
                                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                                    style={{ background: n(r.payment_in_total) > 0.004 ? '#12855A' : '#E11D48' }}
                                  />
                                )}
                                {/* Square, like the PID chip it sits beside.
                                    A pill next to a rectangle in the same
                                    breath reads as two different kinds of
                                    label when they are both just the bill's
                                    state. */}
                                {repaid && <Badge variant="success" className="!rounded-none">Repaid</Badge>}
                              </div>
                              {/* THE LONGEST LABEL ON ITS OWN LINE.
                                  "Payment IN expected" is three words in a
                                  column already carrying the bill number, the
                                  finance type and the status — inline it was
                                  the widest thing on the row and pushed the
                                  figures off the side of a 1380px register.
                                  Under them it costs height, which this cell
                                  has to spare, instead of width, which it
                                  does not. */}
                              {!!r.payment_in_expected && (
                                <div className="mt-1">
                                  <PayInDue row={r} />
                                </div>
                              )}
                              {/* Stops the row's own click, which opens the
                                  bill — tagging it is not opening it. */}
                              <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                                <TagPicker
                                  entity="bd"
                                  refId={Number(r.id)}
                                  tags={bdTags.tagsOf(Number(r.id))}
                                  onChanged={(next) => bdTags.setFor(Number(r.id), next)}
                                  compact
                                />
                              </div>
                              {/* The NBFC is who the money is FROM, which is
                                  half of what this column says — grey and
                                  light it read as a caption rather than as the
                                  lender's name. Semibold, a shade darker, and
                                  the margin left muted behind it so the name
                                  still comes first. */}
                              <div
                                className={cn(
                                  'text-[11px] text-muted-foreground',
                                  // The register is 1380px wide and scrolls
                                  // below that, so on a narrow screen every
                                  // pixel this column keeps is a pixel of the
                                  // figures pushed off the side. Held to a
                                  // measure there, the lender's name takes two
                                  // lines and gives the width back; from xl up
                                  // the whole table fits and it stays on one.
                                  __WEB__ &&
                                    '!text-[11.5px] !font-semibold !leading-[1.35] !text-[#33473E] max-w-[165px] [text-wrap:pretty] xl:max-w-none'
                                )}
                              >
                                {r.nbfc_name || '\u2014'}
                                {n(r.margin_pct) ? (
                                  <span className={cn(__WEB__ && '!font-medium !text-[#8CA396]')}>
                                    {` \u00b7 margin ${r.margin_pct}%`}
                                  </span>
                                ) : (
                                  ''
                                )}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        {/* THE NAME WRAPS.
                            Held on one line it either ran off the column or
                            forced it wider than the figures beside it — and a
                            company name is the one thing on this row a reader
                            scans for, so it is set semibold at a size that can
                            be picked out, on a measure narrow enough that a
                            long name breaks onto a second line instead of
                            pushing the register sideways. */}
                        <TableCell className={cn('whitespace-nowrap', __WEB__ && cn(BD_RULE, BD_W, '!whitespace-normal'))}>
                          {/* Several parties on one bill: named in full, with
                              the count, rather than showing only the first. */}
                          <div
                            className={cn(
                              __WEB__ &&
                                'max-w-[260px] text-[13px] font-semibold leading-[1.32] text-[#0A1F17] [text-wrap:pretty]'
                            )}
                          >
                            {n(r.party_count) > 1 ? (
                              <span title={String(r.party_names)}>
                                {r.party_name}{' '}
                                <span
                                  className={cn(
                                    'text-[11px] text-muted-foreground',
                                    __WEB__ && '!font-bold !text-[#5A6B62]'
                                  )}
                                >
                                  +{n(r.party_count) - 1} more
                                </span>
                              </span>
                            ) : (
                              r.party_name || '—'
                            )}
                          </div>
                          {/* On its own line UNDER the party, the way the NBFC
                              sits under the BD no in the column before it. Set
                              beside the name it ran into it on the long ones,
                              which is most of them.
                              A pill rather than coloured text, so it registers
                              as a label on the row instead of as emphasis on a
                              word — trading being the bill with a round trip
                              behind it, money going out to the NBFC and coming
                              back from a customer. */}
                          <div className="mt-0.5">
                            {String(r.purpose) === 'trading' ? (
                              <span
                                className="inline-flex items-center rounded-full bg-[#1a2c56] py-0.5 pl-1.5 pr-2 text-[10px] font-bold uppercase tracking-wide text-white"
                                title="Trading — bought and sold on, with the money coming back from a customer"
                              >
                                <span className="mr-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                Trading
                              </span>
                            ) : (
                              /* Manufacturing is the mill's own goods, and it
                                 is what most of this register is — so it reads
                                 as a quiet green label rather than as grey
                                 filler under the name. Its own colour, not the
                                 name's ink and not Trading's navy: the two
                                 purposes must never be told apart by reading. */
                              <span
                                className={cn(
                                  'text-[11px] capitalize text-muted-foreground',
                                  __WEB__ && '!font-semibold !tracking-[.01em] !text-[#0B6B45]'
                                )}
                              >
                                {r.purpose}
                              </span>
                            )}
                            {/* THE SECOND LEG, said on the row.
                                Beside the purpose because that is what makes
                                the second leg exist at all — a Trading bill
                                has money coming back, and this is where it has
                                got to. */}
                            {(() => {
                              if (!payInChipEveryone && !iAmAdmin) return null
                              const st = payInState(r)
                              if (!st) return null
                              return (
                                <span
                                  title={st.title}
                                  className={cn(
                                    'ml-1.5 inline-flex cursor-help items-center rounded-[2px] px-1.5 py-[2px] text-[10px] font-bold uppercase tracking-wide',
                                    st.tone === 'awaiting'
                                      ? 'bg-[#FFEDD0] text-[#8A5300]'
                                      : 'bg-[#EAF6EC] text-[#0B6B45]'
                                  )}
                                >
                                  {st.label}
                                </span>
                              )
                            })()}
                          </div>
                        </TableCell>
                        {/* TWO DATES, ONE OF WHICH MATTERS MORE.
                            Set as a two-column grid so the labels sit in a
                            lane of their own and the dates start on one edge —
                            loose text with a margin between label and figure
                            only lines up while both labels happen to be three
                            letters, and "awaited" broke even that.
                            Maturity carries the weight: it is the date the
                            money falls due and the one the countdown beside it
                            is counting to. Receipt is when the money landed —
                            context, so it sits back. */}
                        <TableCell className={cn('whitespace-nowrap tabular-nums', __WEB__ && cn(BD_RULE, BD_W))}>
                          {__WEB__ ? (
                            <div className="grid grid-cols-[26px_auto] items-baseline gap-x-2 gap-y-[3px]">
                              <span
                                className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]"
                                title="The day the NBFC's money landed"
                              >
                                Rec
                              </span>
                              {awaiting ? (
                                <span className="text-[11.5px] font-bold uppercase tracking-[.04em] text-[#8A5300]">
                                  awaited
                                </span>
                              ) : (
                                <span className="doc-ref text-[12.5px] font-semibold text-[#5A6B62]">
                                  {formatDateShort(r.payment_received_date)}
                                </span>
                              )}
                              <span
                                className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]"
                                title="The day the bill falls due"
                              >
                                Mat
                              </span>
                              <span className="doc-ref text-[12.5px] font-bold text-[#0A1F17]">
                                {formatDateShort(r.maturity_date)}
                              </span>
                            </div>
                          ) : (
                            <>
                              <div>
                                <span className="mr-1 text-[10px] font-semibold uppercase text-muted-foreground" title="Payment received">
                                  Rec
                                </span>
                                {awaiting ? <span className="text-amber-700">awaited</span> : formatDateShort(r.payment_received_date)}
                              </div>
                              <div>
                                <span className="mr-1 text-[10px] font-semibold uppercase text-muted-foreground" title="Maturity">
                                  Mat
                                </span>
                                {formatDateShort(r.maturity_date)}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell className={cn('whitespace-nowrap', __WEB__ && cn(BD_RULE, BD_W))}>
                          {repaid ? (
                            <span className="text-muted-foreground">—</span>
                          ) : awaiting ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Awaiting payment</span>
                          ) : (
                            <div className="flex flex-col items-start gap-0.5">
                              <DueBadge date={r.maturity_date} />
                              {n(r.repaid_total) > 0 && (
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Part repaid</span>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className={cn('whitespace-nowrap text-right tabular-nums text-muted-foreground', __WEB__ && cn(BD_RULE, BD_W, BD_NUM, '!font-semibold !text-[#5A6B62]'))}>{n(r.intDays)}</TableCell>
                        {/* ONE FIGURE: what the bill was opened for.
                            The invoice it is drawn against and, on a part
                            repayment, the running balance used to sit under it
                            in small type — three money figures stacked in one
                            cell, where the column asks one question. Both are
                            still on the row: the balance leads the card view
                            and the drawer, and the whole lot is on this cell's
                            own tooltip, so nothing has to be looked up
                            elsewhere. */}
                        <TableCell
                          className={cn('whitespace-nowrap border-l border-[#1a2c56]/10 text-right font-medium tabular-nums', __WEB__ && cn(BD_RULE, BD_NUM, '!text-[13px] !text-[#0A1F17]'))}
                          title={[
                            `Open amount ${formatINR(r.amount)}`,
                            n(r.repaid_total) > 0 && !repaid
                              ? `less ${formatINR(r.repaid_total)} repaid — balance ${formatINR(r.outstanding_amount)}`
                              : '',
                            n(r.invoice_amount) > 0 ? `against a ${formatINR(r.invoice_amount)} invoice` : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        >
                          {formatINR(r.amount)}
                          {/* WHAT IS STILL OWED, UNDER WHAT WAS BORROWED.
                              The open amount is the bill as drawn and does not
                              move; the balance does, and it is the figure a
                              reader is actually chasing down this column. It
                              was taken off the cell once for stacking three
                              money figures in it — as a chip it reads as a
                              state rather than as a third number, and a bill
                              that is square says so in green. */}
                          <span
                            className={cn(
                              'mt-[3px] block w-fit rounded-[3px] border px-1.5 py-[1px] text-[11px] font-bold tabular-nums',
                              dueOn(r) <= 0.004
                                ? 'ml-auto border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                : 'ml-auto border-[#CFE8D6] bg-[#EFF8F1] text-[#0B6B45]'
                            )}
                            title={
                              [
                                n(r.repaid_total) > 0
                                  ? `${formatINR(r.repaid_total)} repaid — ${formatINR(dueOn(r))} still owed`
                                  : 'Nothing repaid yet, so the balance is the whole bill',
                                // A SERVICED BILL OWES TWO DIFFERENT THINGS.
                                // Its interest is paid across while the bill
                                // runs, on its own schedule, and settling it
                                // does not make this figure move. Folding the
                                // accrued interest in here would put a number
                                // on the row that no single payment ever
                                // clears — so the balance is the principal,
                                // and the chip says which it is.
                                isServiced(r)
                                  ? 'Principal only — interest on this bill is serviced over the tenor and paid separately, so it is not in this balance'
                                  : ''
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            }
                          >
                            {dueOn(r) <= 0.004 ? 'settled' : formatINR(dueOn(r))}
                          </span>
                        </TableCell>
                        {/* The three the NBFC kept, washed together so they
                            read as one deduction rather than three unrelated
                            figures between the bill and the receipt. */}
                        <TableCell className={cn('whitespace-nowrap text-right tabular-nums', __WEB__ && cn(BD_RULE, BD_NUM, '!bg-[#FDF8F7] !font-semibold !text-[#33473E]'))}>{formatINR(r.marginAmount)}</TableCell>
                        {/* THE NBFC KEPT NOTHING, SO THE COLUMN SAYS NOTHING.
                            Under a heading that reads "what the NBFC kept",
                            an interest figure on a bill whose interest is
                            serviced over the tenor is not a small figure — it
                            is the wrong claim. That money is paid across
                            periodically while the bill runs and is recorded
                            against the repayments, not withheld here. */}
                        <TableCell className={cn('whitespace-nowrap text-right tabular-nums text-rose-700', __WEB__ && cn(BD_NUM, '!bg-[#FDF8F7] !text-[#8C2F26]'))}>
                          {isServiced(r) ? (
                            (() => {
                              /**
                               * SETTLED WITH THE NBFC IS NOT THE SAME AS SQUARE.
                               *
                               * A serviced bill runs two clocks: the principal,
                               * which the Repay button closes, and the interest,
                               * which is paid across the tenor on its own
                               * schedule. Repaying the one does not pay the
                               * other, and the column said the same quiet word
                               * either way — so a bill sitting in the Repaid
                               * bucket still owing its last stretch of interest
                               * looked finished.
                               *
                               * Only on a repaid bill. While the bill runs the
                               * interest accrues daily and is ALWAYS partly
                               * unpaid, so a chip there would be red on every
                               * live row and mean nothing.
                               */
                              const upto = String(r.interest_paid_to || '').slice(0, 10)
                              // What it should have been serviced to: the day it
                              // was actually repaid, or maturity if that is all
                              // the bill records.
                              const upTill = String(r.last_repay_date || r.maturity_date || '').slice(0, 10)
                              const owing = repaid && (!upto || (!!upTill && upto < upTill))
                              if (!owing) {
                                return (
                                  <span
                                    className="text-[11.5px] font-semibold text-[#8FA79B]"
                                    title={
                                      upto
                                        ? `Interest is serviced over the tenor — paid up to ${formatDate(upto)}`
                                        : 'Interest is serviced over the tenor — paid across while the bill runs, not withheld from the disbursement. See its interest payments.'
                                    }
                                  >
                                    serviced
                                  </span>
                                )
                              }
                              return (
                                <span
                                  className="inline-flex items-center rounded-[3px] border border-[#F0C9C4] bg-[#FDECEA] px-1.5 py-[1px] text-[11px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]"
                                  title={
                                    upto
                                      ? `The bill is settled but its interest is only serviced to ${formatDate(upto)} — the stretch to ${formatDate(upTill)} is still owed`
                                      : 'The bill is settled but no interest has been serviced on it at all'
                                  }
                                >
                                  Due
                                </span>
                              )
                            })()
                          ) : (
                            formatINR(r.interestAmount)
                          )}
                        </TableCell>
                        <TableCell className={cn('whitespace-nowrap text-right tabular-nums', __WEB__ && cn(BD_NUM, '!bg-[#FDF8F7] !font-semibold !text-[#8C2F26]'))}>
                          {isServiced(r) ? (
                            <span className="text-[11.5px] font-semibold text-[#8FA79B]" title="Withheld with each interest payment, not here">
                              —
                            </span>
                          ) : (
                            formatINR(r.tdsAmount)
                          )}
                        </TableCell>
                        <TableCell className={cn('whitespace-nowrap text-right font-semibold tabular-nums text-emerald-700', __WEB__ && cn(BD_RULE, BD_WR, 'doc-ref !text-[13.5px] !font-bold !text-[#0B6B45]'))}>
                          {formatINR(r.receiptAmount)}
                        </TableCell>
                        {/* THE ROW OPENS THE BILL; THIS CELL DOES NOT.
                            Every control in here has its own job — repay, mark
                            received, reopen, and the ⋮ menu — and each was
                            also opening the detail panel behind itself,
                            because the click carried on up to the row. The
                            cell stops it at the edge of the actions rather
                            than every button having to remember to. */}
                        <TableCell
                          className="whitespace-nowrap text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex justify-end gap-1">
                            {repaid ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className={cn(
                                  'h-7 gap-1 px-2 text-xs',
                                  __WEB__ && '!h-[26px] !rounded-none !border-[#C3D2C6] !px-2.5 !text-[11px] !font-extrabold !uppercase !tracking-[.06em] !text-[#33473E] hover:!bg-[#F7FAF6]'
                                )}
                                onClick={() => void reopen(r)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" /> Reopen
                              </Button>
                            ) : awaiting ? (
                              <Button
                                size="sm"
                                className={cn(
                                  'h-7 gap-1 whitespace-nowrap bg-amber-600 px-2 text-xs hover:bg-amber-700',
                                  __WEB__ && '!h-[26px] !rounded-none !bg-[#C2700A] !px-2.5 !text-[11px] !font-extrabold !uppercase !tracking-[.06em] !text-white hover:!bg-[#A85F08]'
                                )}
                                onClick={() => openReceive(r)}
                              >
                                <Banknote className="h-3.5 w-3.5" /> Mark received
                              </Button>
                            ) : (
                              <>
                                {r.party_in_parts && Number(r.party_left) > 0.5 && (
                                  <Button
                                    size="sm"
                                    title={`The NBFC still has ${formatINR(Number(r.party_left) || 0)} to pay ${String(r.party_name || 'the supplier')}`}
                                    className={cn(
                                      'h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700',
                                      __WEB__ && '!h-[26px] !rounded-none !bg-[#12855A] !px-2.5 !text-[11px] !font-extrabold !uppercase !tracking-[.06em] !text-white hover:!bg-[#0F7350]'
                                    )}
                                    onClick={() => setPartyRow(r)}
                                  >
                                    Pay party
                                  </Button>
                                )}
                                {r.receipt_in_parts && Number(r.toReceive) > 0.5 && (
                                  <Button
                                    size="sm"
                                    title={`The NBFC still has ${formatINR(Number(r.toReceive) || 0)} to release on this bill`}
                                    className={cn(
                                      'h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700',
                                      __WEB__ && '!h-[26px] !rounded-none !bg-[#12855A] !px-2.5 !text-[11px] !font-extrabold !uppercase !tracking-[.06em] !text-white hover:!bg-[#0F7350]'
                                    )}
                                    onClick={() => setLegsRow(r)}
                                  >
                                    Receive part
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  className={cn(
                                    'h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]',
                                    __WEB__ && '!h-[26px] !rounded-none !bg-[#0B3D2E] !px-3 !text-[11px] !font-extrabold !uppercase !tracking-[.06em] !text-[#C7F03F] hover:!bg-[#0F4A38]'
                                  )}
                                  onClick={() => openRepay(r)}
                                >
                                  Repay
                                </Button>
                              </>
                            )}
                            <RowActions
                              actions={[
                                {
                                  label: 'Edit bill',
                                  icon: Pencil,
                                  disabled: repaid,
                                  disabledReason: 'Already repaid — reopen it first',
                                  onClick: () => openEdit(r)
                                },
                                ...(bdRefundDue[String(r.id)] ? [{ label: `Refund received — ${formatINR(bdRefundDue[String(r.id)])} due back`, icon: Undo2, onClick: () => setRefundBd(Number(r.id)) }] : []),
                                {
                                  label: 'Disbursement paid to…',
                                  icon: Landmark,
                                  onClick: () => openRoute(r)
                                },
                                {
                                  label: 'Payment IN — money back from the customer',
                                  icon: Banknote,
                                  // THE SAME RULE THE CARD VIEW USES.
                                  //
                                  // This menu is written twice, once per view,
                                  // and only the card copy was opened up to
                                  // manufacturing bills. So the register could
                                  // show "Payment IN in 61d" on a row whose own
                                  // menu said only a trading bill has money
                                  // coming back — the screen contradicting
                                  // itself about the leg it was chasing. A
                                  // trading bill settles against its resale
                                  // invoices; every other bill just receives,
                                  // and needs a party for the money to come
                                  // from and nothing else.
                                  disabled:
                                    String(r.purpose) === 'trading'
                                      ? !r.receivable_party_id
                                      : !Number(r.payment_in_expected) || !r.party_id,
                                  disabledReason:
                                    String(r.purpose) === 'trading'
                                      ? 'Set who pays back, and link the purchase invoices, on the bill first'
                                      : !Number(r.payment_in_expected)
                                        ? 'Turn on “Payment will come back IN” at the foot of the bill first'
                                        : 'This bill names no party for the money to come back from',
                                  onClick: () => void openPayIn(r)
                                },
                                { label: 'History — who did what', icon: History, onClick: () => void openHistory(r) },
                                ...(__WEB__ && canSeeLedgers
                                  ? [
                                      {
                                        label: 'Ledger posting — what it put in the books',
                                        icon: BookOpen,
                                        onClick: () => openPostings(r)
                                      }
                                    ]
                                  : []),
                                {
                                  label: 'Change payment received date',
                                  icon: CalendarRange,
                                  disabled: repaid || awaiting,
                                  disabledReason: repaid ? 'Already repaid — reopen it first' : 'No payment marked on this bill yet',
                                  onClick: () => openReceive(r)
                                },
                                {
                                  label: 'Undo payment received',
                                  icon: RotateCcw,
                                  disabled: repaid || awaiting,
                                  disabledReason: repaid ? 'Already repaid — reopen it first' : 'No payment marked on this bill yet',
                                  onClick: () => void undoReceive(r)
                                },
                                ...(r.party_in_parts
                                  ? [{ label: 'Payments to the supplier — part by part', icon: Banknote, onClick: () => setPartyRow(r) }]
                                  : []),
                                ...(r.receipt_in_parts
                                  ? [{ label: 'Received from the NBFC — part by part', icon: Banknote, onClick: () => setLegsRow(r) }]
                                  : []),
                                {
                                  label: 'Delete — reverses its vouchers',
                                  icon: Trash2,
                                  danger: true,
                                  onClick: () => void remove(r)
                                }
                              ]}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                      {/* The opened-out bill used to unfold here as a strip
                          of four cards. It is a panel from the right now —
                          see BdDetail — because four figures are the smallest
                          part of what a bill is, and there was nowhere under a
                          row to put the rest of it. */}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent
          // Esc closes it as Cancel does — at once if nothing was changed;
          // with changes, the first Esc says so and a second discards. Then
          // Esc goes on back to wherever the bill was opened from.
          onEscapeKeyDown={escToClose(!!form && JSON.stringify(form) !== formWas.current)}
          className={cn(
            'max-h-[92vh] w-[calc(100vw-2rem)] max-w-6xl overflow-y-auto border-[#d9d2b8] bg-[#fffdf4]',
            // Wide for a drawer, because the terms row is seven fields that
            // belong side by side — split over two lines they stop reading as
            // one calculation.
            bdDrawer('!w-[920px] min-[1280px]:!w-[1240px]')
          )}
        >
          {/* THE CANVAS'S HEADER: what the drawer is, the bill's own name, the
              company it is booked into — and under them, the bill so far as
              four chips, so who, against whom and when are in view at the top
              however far down the form has been scrolled. */}
          <DialogHeader
            className={cn(
              '-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5',
              __WEB__ &&
                '!m-0 !block !space-y-0 !rounded-none !bg-[linear-gradient(180deg,#11503C_0%,#0B3D2E_60%,#093324_100%)] !py-[15px] !pl-[22px] !pr-16 !text-left !shadow-[inset_0_1px_0_rgba(255,255,255,.08)]'
            )}
          >
            {__WEB__ && (
              <div className="text-[10.5px] font-extrabold uppercase tracking-[.15em] text-[#8FBFA8]">
                {form?.id ? 'Bill discounting · edit' : 'Bill discounting'}
              </div>
            )}
            <div className={cn('flex flex-wrap items-center gap-3', __WEB__ && '!mt-[5px] !gap-2.5')}>
              <DialogTitle className={cn('text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && '!text-[19px] !font-extrabold !normal-case !tracking-[-0.02em] !text-white')}>
                {__WEB__
                  ? form?.id
                    ? `Edit bill${String(form?.bd_no || '').trim() ? ` BD ${String(form?.bd_no).trim()}` : ''}`
                    : 'Discount a bill'
                  : form?.id
                    ? 'Alter discounted bill'
                    : 'Discount a bill'}
              </DialogTitle>
              {/* One company: said, not offered. */}
              {__WEB__ && !(!!activeCompany && !!onCompanyChange && companies.length > 1) && (() => {
                const co = companies.find((c) => Number(c.id) === Number(activeCompany))
                return co ? (
                  <span className="inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-white/[.14] bg-white/[.08] px-2.5 text-[11px] font-extrabold uppercase text-white">
                    <Building2 className="h-3.5 w-3.5 text-[#C7F03F]" />
                    {String(co.name)}
                  </span>
                ) : null
              })()}
              {!!activeCompany && !!onCompanyChange && companies.length > 1 && (
                <Select value={String(activeCompany)} onValueChange={onCompanyChange}>
                  <SelectTrigger
                    title="Switch company — the bill is booked into this company's books and draws on its invoices"
                    className={cn(
                      'ml-auto mr-8 h-auto w-auto shrink-0 gap-1.5 rounded-full border border-[#1a2c56]/20 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#1a2c56] shadow-none hover:bg-[#eef3fb] [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-70',
                      __WEB__ && '!ml-0 !mr-0 !h-[26px] !rounded-[6px] !border-white/[.14] !bg-white/[.08] !px-2.5 !py-0 !text-[11px] !font-extrabold !text-white hover:!bg-white/[.16] [&>svg]:!opacity-90'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Building2 className={cn('h-3.5 w-3.5 shrink-0 opacity-70', __WEB__ && '!text-[#C7F03F] !opacity-100')} />
                      <SelectValue placeholder="Select company" />
                    </span>
                  </SelectTrigger>
                  <SelectContent className="min-w-[14rem]">
                    {companies
                      .filter((c) => c.active)
                      .map((c) => (
                        <SelectItem key={String(c.id)} value={String(c.id)}>{String(c.name)}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {__WEB__ && bdHead && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {[
                  { icon: Landmark, label: bdHead.nbfc || 'No NBFC yet', lit: !!bdHead.nbfc },
                  { icon: Users, label: bdHead.party || 'No party yet' },
                  { icon: CalendarRange, label: bdHead.dates },
                  { icon: Tag, label: bdHead.kind }
                ].map((c) => (
                  <span
                    key={c.label}
                    className="inline-flex h-[26px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] font-bold"
                    style={
                      c.lit
                        ? { background: 'rgba(199,240,63,.14)', color: '#C7F03F' }
                        : { background: 'rgba(255,255,255,.07)', color: c.label.startsWith('No ') ? '#8FBFA8' : '#DCEFE4' }
                    }
                  >
                    <c.icon className="h-3.5 w-3.5 flex-none" />
                    <span className="min-w-0 truncate">{c.label}</span>
                  </span>
                ))}
              </div>
            )}
          </DialogHeader>
          {form && (
          // THE FORM AND ITS LIVE SUMMARY, SIDE BY SIDE (website, wide screens).
          // The summary is the bill as it stands — who, when, and the
          // arithmetic from the invoice down to what reaches the bank —
          // updating with every keystroke, so the figures being decided are
          // never scrolled away from the boxes deciding them.
          <div className={cn(__WEB__ && 'grid min-h-0 bg-[#EEF3EC] min-[1280px]:grid-cols-[minmax(0,1fr)_330px]')}>
            {/* A SCROLLING COLUMN WHOSE CHILDREN MAY NOT SHRINK.
            //
            // This was `grid`, and a grid with a definite height does not
            // overflow — it SQUASHES its tracks to fit. scrollHeight came back
            // equal to clientHeight, so the panel reported nothing to scroll
            // while the last two sections were quietly compressed and clipped.
            // Flex has the same trap by default (flex-shrink: 1), which is why
            // every child is pinned with shrink-0: the canvas marks each of its
            // sections `flex:none` for exactly this reason. */}
            <div
              className={cn(
                'grid gap-3',
                __WEB__ && cn(BD_FORM_FIELDS, '!gap-3 !px-[18px] !pb-5 !pt-4')
              )}
            >
              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4', __WEB__ && BD_CARD)}>
                <h3 className={cn('mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && BD_CARD_HEAD)}>
                  {__WEB__ ? (
                    <StepTitle n={1} done={billStepDone} sub="Who discounts it, against whom, and for how long">
                      The bill
                    </StepTitle>
                  ) : (
                    'The bill'
                  )}
                </h3>
                {/* THE CANVAS'S OWN RULE, at the canvas's own width.
                    190px is the narrowest one of these fields may be; in a
                    720px drawer that fits three to a row, which is the layout
                    the design shows. Forcing the count instead was papering
                    over a panel 160px too wide. */}
                <div
                  className={cn(
                    'grid gap-4 md:grid-cols-3 xl:grid-cols-5',
                    __WEB__ && '!grid-cols-1 sm:!grid-cols-12 !gap-x-[14px] !gap-y-3 !px-4 !pb-4 !pt-3.5'
                  )}
                >
                  {/* ROW 1 — what kind of bill, and what it is for: the two
                      choices that decide which NBFCs and which parties the rest
                      of the form may offer, so they are asked first, side by
                      side, with what the first one means said beside them. On
                      the desktop app the wrapper is `contents` and the two stay
                      ordinary cells of its grid. */}
                  <div className={cn('contents', __WEB__ && '!flex !flex-wrap !items-end !gap-x-[14px] !gap-y-3 sm:!col-span-12')}>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      {__WEB__ ? 'Provides' : 'Finance type *'}
                      <InfoTip text="PID — Purchase Invoice Discounting, drawn against a supplier. SID — Sales Invoice Discounting, drawn against a customer." />
                    </Label>
                    {__WEB__ ? (
                      // A TWO-LETTER CHOICE DOES NOT NEED THE WHOLE DRAWER.
                      // This one sits on a row of its own, and a segment that
                      // fills it made PID and SID 320px wide each — two banners
                      // where the canvas has a pill. w-fit sizes the tray to the
                      // buttons; the buttons keep their own width from the
                      // padding, so the pair stays even.
                      <Seg
                        soft
                        value={String(form.finance_type || '')}
                        onChange={chooseFinanceType}
                        options={[
                          { v: 'PID', label: 'PID' },
                          { v: 'SID', label: 'SID' }
                        ]}
                      />
                    ) : (
                      <Select value={String(form.finance_type || '')} onValueChange={chooseFinanceType}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="PID">PID — Purchase Invoice Discounting</SelectItem>
                          <SelectItem value="SID">SID — Sales Invoice Discounting</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>{__WEB__ ? 'Purpose' : 'Purpose *'}</Label>
                    {__WEB__ ? (
                      <Seg
                        soft
                        value={String(form.purpose || '')}
                        onChange={(v) => setForm((p) => ({ ...p, purpose: v, party_id: '', party_ids: [] }))}
                        options={[
                          { v: 'manufacturing', label: 'Manufacturing' },
                          { v: 'trading', label: 'Trading' }
                        ]}
                      />
                    ) : (
                      <Select
                        value={String(form.purpose || '')}
                        onValueChange={(v) => setForm((p) => ({ ...p, purpose: v, party_id: '', party_ids: [] }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manufacturing">Manufacturing</SelectItem>
                          <SelectItem value="trading">Trading</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {__WEB__ && (
                    <p className="min-w-0 flex-[1_1_200px] pb-1 text-[11px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                      PID discounts a supplier bill; SID discounts one you have raised on a customer.
                    </p>
                  )}
                  </div>
                  <div className={cn('flex flex-col gap-1.5', __WEB__ && 'sm:col-span-4')}>
                    <Label className="flex items-center gap-1">
                      BD no *
                      <InfoTip text="Your own reference for this bill. Every voucher it posts is numbered with it — the disbursement, each repayment, the margin release — so it is how the bill is found in the ledger." />
                    </Label>
                    <Input value={form.bd_no ?? ''} placeholder="Your own reference" onChange={(e) => setForm((p) => ({ ...p, bd_no: e.target.value }))} />
                  </div>
                  <div className={cn('flex flex-col gap-1.5', __WEB__ && 'sm:col-span-8')}>
                    <Label>NBFC *</Label>
                    {/* The gear that used to sit beside this is gone on the
                        website: it made the NBFC cell a different width from
                        every other cell in the grid, and Manage NBFCs is a
                        button on the register's own toolbar two clicks away. */}
                    <div className={cn('flex min-w-0 gap-1.5', __WEB__ && '!block')}>
                      <div className="min-w-0 flex-1">
                        <Select value={String(form.nbfc_id || '')} onValueChange={chooseNbfc}>
                          <SelectTrigger>
                            <SelectValue placeholder={formNbfcs.length ? 'Select the NBFC' : 'No NBFC set up yet'} />
                          </SelectTrigger>
                          {/* A LIST WIDER THAN THE BOX IT DROPS FROM.
                              The cell is 210px in a 720px drawer; a lender's
                              name and its terms are not, and sizing the panel
                              to the trigger truncated every option to the one
                              word they share. It opens to the width it needs
                              and is capped so it cannot run off the panel. */}
                          <SelectContent className={cn(__WEB__ && '!min-w-[340px] !max-w-[min(92vw,420px)]')}>
                            {formNbfcs.map((nb) => (
                              <SelectItem key={String(nb.id)} value={String(nb.id)}>
                                {__WEB__ ? (
                                  <span className="flex min-w-0 flex-col gap-[3px] py-0.5">
                                    <span className="flex min-w-0 items-center gap-2">
                                      <span className="min-w-0 truncate text-[12.5px] font-extrabold text-[#0A1F17]">
                                        {String(nb.name)}
                                      </span>
                                      <span
                                        data-detail
                                        className="shrink-0 rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-px text-[9.5px] font-extrabold tracking-[.06em] text-[#1B4E82]"
                                      >
                                        {String(nb.finance_type || 'BOTH')}
                                      </span>
                                    </span>
                                    {/* Both marked data-detail: they belong in the
                                        list, where there is room to compare lenders
                                        on them, and not in the 205px trigger — which
                                        is 44px tall and was being handed two lines.
                                        See BD_FIELDS. */}
                                    <span data-detail className="doc-ref text-[11px] font-semibold text-[#5A6B62]">
                                      {nbfcTerms(nb)}
                                    </span>
                                  </span>
                                ) : (
                                  nb.name
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button type="button" size="icon" variant="outline" className={cn('shrink-0', __WEB__ && '!hidden')} title="Manage NBFCs" onClick={() => setNbfcOpen(true)}>
                        <Settings2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'flex flex-col gap-1.5',
                      // One party is an ordinary field; several need the width to
                      // list them with their amounts, so the cell takes the row.
                      __WEB__ && 'sm:!col-span-12',
                      !__WEB__ &&
                        ((Array.isArray(form.party_ids) ? form.party_ids : []).length > 1
                          ? 'md:col-span-3 xl:col-span-4'
                          : 'md:col-span-2 xl:col-span-1')
                    )}
                  >
                    <Label className="flex items-center gap-1">
                      {__WEB__
                        ? (Array.isArray(form.party_ids) ? form.party_ids : []).length > 1
                          ? 'Parties *'
                          : 'Party *'
                        : `${String(form.finance_type) === 'SID' ? 'Customer' : 'Supplier'}${
                            (Array.isArray(form.party_ids) ? form.party_ids : []).length > 1 ? 's *' : ' *'
                          }`}
                      <InfoTip text="One bill can be raised against several parties — a facility drawn on a batch of invoices from more than one of them. Picking adds; picking again removes. The FIRST one is the primary, which is the party the bill is filed under and the default for a repayment settled on a party's ledger. With more than one, each party's invoice amount is asked for below, and they must add up to the bill's invoice amount." />
                    </Label>
                    {/* Picking adds rather than replaces, so a bill covering
                        several parties no longer means losing the first. */}
                    <Select
                      searchable
                      value=""
                      selected={(Array.isArray(form.party_ids) ? form.party_ids : []).map(String)}
                      onValueChange={(v) =>
                        setForm((prev) => {
                          const ids: number[] = Array.isArray(prev?.party_ids) ? prev!.party_ids : []
                          const id = Number(v)
                          const next = ids.map(Number).includes(id) ? ids.filter((x) => Number(x) !== id) : [...ids, id]
                          const amounts = { ...(prev?.party_amounts || {}) }
                          if (!next.map(Number).includes(id)) delete amounts[String(id)]
                          return {
                            ...prev,
                            party_ids: next,
                            party_id: next.length ? String(next[0]) : '',
                            party_amounts: amounts
                          }
                        })
                      }
                    >
                      <SelectTrigger>
                        <span
                          className={cn(
                            'truncate',
                            !(Array.isArray(form.party_ids) ? form.party_ids : []).length && 'text-muted-foreground'
                          )}
                        >
                          {(() => {
                            const ids: number[] = Array.isArray(form.party_ids) ? form.party_ids : []
                            if (!ids.length) return formParties.length ? 'Select the party' : `No ${form.purpose} party set up`
                            if (ids.length === 1) {
                              return formParties.find((x) => Number(x.id) === Number(ids[0]))?.name || '1 party'
                            }
                            // The names are listed below, so the trigger says
                            // how many and invites another rather than repeating
                            // a string of names it would only truncate.
                            return `${ids.length} parties — pick to add or remove`
                          })()}
                        </span>
                      </SelectTrigger>
                      <SelectContent className={cn(__WEB__ && '!min-w-[340px] !max-w-[min(92vw,460px)]')}>
                        {formParties.map((p) => (
                          <SelectItem key={String(p.id)} value={String(p.id)}>
                            <span className={cn(__WEB__ && 'block min-w-0 truncate text-[12.5px] font-semibold')}>
                              {String(p.name)}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Everything about the chosen parties in ONE place: who
                        is on the bill, what each one's sanctioned amount is,
                        and whether they add up. Picking, listing and
                        dividing used to be three separate things on the form —
                        the names appeared twice and the split was asked for in a
                        different section from the amount it divides. */}
                    {(Array.isArray(form.party_ids) ? form.party_ids : []).length > 0 && (() => {
                      const ids: number[] = Array.isArray(form.party_ids) ? form.party_ids : []
                      const many = ids.length > 1
                      const nameOf = (pid: number): string =>
                        formParties.find((x) => Number(x.id) === Number(pid))?.name || `#${pid}`
                      const drop = (pid: number): void =>
                        setForm((prev) => {
                          const next = (Array.isArray(prev?.party_ids) ? prev!.party_ids : []).filter(
                            (x: number) => Number(x) !== Number(pid)
                          )
                          const amounts = { ...(prev?.party_amounts || {}) }
                          delete amounts[String(pid)]
                          return {
                            ...prev,
                            party_ids: next,
                            party_id: next.length ? String(next[0]) : '',
                            party_amounts: amounts
                          }
                        })
                      const sum = round2(ids.reduce((t, pid) => t + n((form.party_amounts || {})[String(pid)]), 0))
                      // Divided by SANCTIONED amount, not by what is drawn: a
                      // party's share of the bill is its portion of the facility
                      // granted against its invoices, and that does not move
                      // when less is drawn against it today.
                      // Each party's INVOICE, adding up to the bill's invoice amount.
                      const invTotal = n(form.invoice_amount) > 0 ? round2(n(form.invoice_amount)) : round2(n(preview?.sanctionedAmount))
                      // Paid straight to the suppliers: what each was PAID is
                      // the split too, adding up to the open amount.
                      const paidSplit = String(form.disbursement_route) === 'supplier' && sum > 0 && Math.abs(sum - round2(n(form.amount))) < 0.05
                      const total = paidSplit ? round2(n(form.amount)) : invTotal
                      const gap = round2(total - sum)
                      return (
                        <div
                          className={cn(
                            'overflow-hidden rounded-lg border border-[#e5dfc8] bg-white',
                            __WEB__ && '!rounded-[4px] !border-[#D6E2D6]'
                          )}
                        >
                          {ids.map((pid, i) => (
                            <div
                              key={String(pid)}
                              className={cn(
                                'flex items-center gap-2 border-b border-dashed border-[#e5dfc8] px-2.5 py-1.5 last:border-b-0',
                                __WEB__ && '!gap-2.5 !border-b-[#EFF3EE] !border-solid !px-3 !py-2'
                              )}
                            >
                              {/* PRIMARY OF ONE IS NOT A RANK.
                                  The badge answers "which of these is the bill
                                  filed under", and with a single party there is
                                  nothing for it to answer. In the website's
                                  210px cell it was also spending 60px of the
                                  row to say it, which is what truncated
                                  "DIL EXIM COMMODITIES PVT LTD" to
                                  "DIL EXIM …". Shown from two parties up. */}
                              {(many || !__WEB__) && (
                              <span
                                className={cn(
                                  'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                                  i === 0 ? 'bg-[#1a2c56] text-white' : 'bg-slate-200 text-slate-600',
                                  __WEB__ &&
                                    cn(
                                      '!rounded-[2px] !px-[7px] !py-[3px] !text-[9.5px] !font-extrabold !tracking-[.08em]',
                                      i === 0 ? '!bg-[#0B3D2E] !text-[#C7F03F]' : '!bg-[#EAF0E9] !text-[#5A6B62]'
                                    )
                                )}
                                title={i === 0 ? 'Primary — the party this bill is filed under' : undefined}
                              >
                                {i === 0 ? 'Primary' : i + 1}
                              </span>
                              )}
                              <span className={cn('min-w-0 flex-1 truncate text-[13px]', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>
                                {nameOf(pid)}
                              </span>
                              {many && (
                                <Input
                                  type="number"
                                  placeholder="Invoice Amt"
                                  className={cn('h-7 w-40 text-[12px] tabular-nums', __WEB__ && '!h-9 !w-36 !rounded-[4px] !border-[#C3D2C6] !text-[12.5px] !font-bold')}
                                  value={String((form.party_amounts || {})[String(pid)] ?? '')}
                                  onChange={(e) =>
                                    setForm((prev) => ({
                                      ...prev,
                                      party_amounts: {
                                        ...(prev?.party_amounts || {}),
                                        [String(pid)]: e.target.value
                                      }
                                    }))
                                  }
                                />
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className={cn(
                                  'h-6 w-6 shrink-0 p-0 text-muted-foreground hover:bg-rose-50 hover:text-rose-700',
                                  __WEB__ && '!text-[16px] !leading-none !text-[#8FA79B] hover:!bg-[#FBEDEC] hover:!text-[#8C2F26]'
                                )}
                                title={`Remove ${nameOf(pid)} from this bill`}
                                onClick={() => drop(pid)}
                              >
                                ×
                              </Button>
                            </div>
                          ))}
                          {many && (
                            <div
                              className={cn(
                                'flex flex-wrap items-center gap-2 border-t px-2.5 py-1.5 text-[11px]',
                                total > 0 && Math.abs(gap) < 0.05
                                  ? 'bg-emerald-50 text-emerald-800'
                                  : 'bg-amber-50 text-amber-900',
                                __WEB__ &&
                                  cn(
                                    '!gap-2.5 !px-3 !py-2.5 !text-[11.5px] !font-bold',
                                    total > 0 && Math.abs(gap) < 0.05
                                      ? '!border-t-[#BFE3CB] !bg-[#F4FBF6] !text-[#0B6B45]'
                                      : '!border-t-[#F0E4CB] !bg-[#FFFBF2] !text-[#8A5300]'
                                  )
                              )}
                            >
                              <span className="font-medium">
                                {total <= 0
                                  ? 'Nothing to divide yet'
                                  : sum <= 0
                                    ? `${formatINR(total)} to divide between ${ids.length} parties`
                                    : `${paidSplit ? 'Paid' : 'Invoice'} ${formatINR(sum)} of ${formatINR(total)}`}
                              </span>
                              <span>
                                {total <= 0
                                  ? '· enter the invoice amount first'
                                  : sum <= 0
                                    ? '· none allocated'
                                    : Math.abs(gap) < 0.05
                                      ? '· adds up'
                                      : gap > 0
                                        ? `· ${formatINR(gap)} still to allocate`
                                        : `· ${formatINR(-gap)} over`}
                              </span>
                              {total > 0 && Math.abs(gap) >= 0.05 && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="ml-auto h-6 bg-white px-2 text-[11px]"
                                  title="Divide the invoice amount equally between the parties"
                                  onClick={() => {
                                    const each = Math.floor((total / ids.length) * 100) / 100
                                    const amounts: Record<string, string> = {}
                                    ids.forEach((pid, i) => {
                                      // The last one absorbs the rounding, so
                                      // the parts always add to the whole.
                                      amounts[String(pid)] =
                                        i === ids.length - 1
                                          ? String(round2(total - each * (ids.length - 1)))
                                          : String(each)
                                    })
                                    setForm((prev) => ({ ...prev, party_amounts: amounts }))
                                  }}
                                >
                                  Split equally
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  {/* THE TWO DATES THE BILL RUNS BETWEEN, beside each other.
                      The receipt date is stated, not asked: it is stamped by
                      Mark payment received, because that is the day interest
                      starts and it cannot be guessed in advance. */}
                  {__WEB__ && (
                    <div className="flex flex-col gap-1.5 sm:col-span-4">
                      <Label className="flex items-center gap-1">
                        Receipt date
                        <InfoTip text="The day the NBFC's money landed. Set by Mark payment received on the register — interest runs from it, so it is recorded when it actually happens rather than promised here." />
                      </Label>
                      <div
                        className={cn(
                          'doc-ref flex h-10 items-center gap-2 rounded-[7px] border px-[11px] text-[12.5px] font-semibold',
                          form.payment_received_date
                            ? 'border-[#DCE7DB] bg-[#F7FAF6] text-[#0A1F17]'
                            : 'border-dashed border-[#C3D2C6] bg-white text-[#8FA79B]'
                        )}
                      >
                        <CalendarRange className="h-4 w-4 shrink-0 text-[#5A6B62]" />
                        {form.payment_received_date ? formatDate(form.payment_received_date) : 'Not received yet'}
                      </div>
                    </div>
                  )}
                  <div className={cn('flex flex-col gap-1.5', __WEB__ && 'sm:col-span-4')}>
                    <Label>Maturity date *</Label>
                    <DatePicker
                      value={String(form.maturity_date || '')}
                      min={form.payment_received_date || undefined}
                      onChange={(v) => setForm((p) => ({ ...p, maturity_date: v }))}
                    />
                  </div>
                  {/* THE TENOR, WORKED OUT RATHER THAN TYPED.
                      The two dates beside it are what a bill is entered with;
                      the number of days between them is what it is judged on —
                      a rate is quoted for a tenor, and reading it off two dates
                      in your head is the step that gets skipped. Square, like
                      every other chip on this page, and quiet until both dates
                      are there to make it true. */}
                  {__WEB__ && (
                    <div className="flex flex-col gap-1.5 sm:col-span-4">
                      <Label className="flex items-center gap-1">
                        Tenor
                        <InfoTip text="Receipt date to maturity — the stretch the bill runs for. Worked out from the two dates beside it rather than entered, so the three can never disagree. The interest days the bill is actually charged on are set separately, under Amount and terms: they follow the same two dates but may count the receipt day itself, depending on the NBFC's terms." />
                      </Label>
                      {(() => {
                        const a = String(form.payment_received_date || '').slice(0, 10)
                        const b = String(form.maturity_date || '').slice(0, 10)
                        const days =
                          a && b
                            ? Math.round(
                                (new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000
                              )
                            : null
                        return (
                          <div
                            className={cn(
                              'doc-ref flex h-10 items-center gap-2 rounded-[7px] border px-[11px] text-[12.5px] font-bold',
                              days == null
                                ? 'border-dashed border-[#C3D2C6] bg-white text-[#8FA79B]'
                                : days < 0
                                  ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]'
                                  : 'border-[#C6DAF0] bg-[#EEF4FB] text-[#1B4E82]'
                            )}
                          >
                            <CalendarRange className="h-4 w-4 shrink-0 opacity-70" />
                            <span className="min-w-0 truncate">
                              {days == null
                                ? 'both dates needed'
                                : days < 0
                                  ? 'maturity is before the receipt'
                                  : `${formatNum(days)} day${days === 1 ? '' : 's'}`}
                            </span>
                            {days != null && days >= 0 && (
                              <span className="ml-auto rounded-[3px] bg-white px-1.5 py-0.5 font-sans text-[9px] font-extrabold tracking-[.1em] text-[#1B4E82]">
                                AUTO
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                  {/* WHO THE NBFC PAID. Into our own bank it is a Receipt
                      there; straight to the supplier (PID only) it is a
                      Journal that settles the supplier, with no bank line —
                      so which bank book the money shows in depends on this,
                      and the disbursement voucher is posted accordingly. */}
                  {/* !important: the desktop app's md:/xl: spans are later in the
                      stylesheet than sm:, and squeezed this to a quarter row. */}
                  <div className={cn('flex flex-col gap-1.5 md:col-span-3 xl:col-span-5', __WEB__ && 'sm:!col-span-12')}>
                    <Label className="flex items-center gap-1">
                      Disbursement paid to *
                      <InfoTip text="Where the NBFC's money went. Our bank: the disbursement posts as a receipt into the account you pick. Supplier direct (PID only): the NBFC paid the supplier for you, so it posts as a journal that settles the supplier and never touches your bank." />
                    </Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <div className="w-full sm:w-auto">
                        <Seg
                          soft
                          value={String(form.disbursement_route || '')}
                          onChange={(v) =>
                            setForm((p) => ({ ...p, disbursement_route: v, disbursement_account: v === 'bank' ? p?.disbursement_account || '' : '' }))
                          }
                          options={[
                            { v: 'bank', label: 'Our bank' },
                            ...(String(form.finance_type) === 'PID' ? [{ v: 'supplier', label: 'Supplier direct' }] : [])
                          ]}
                        />
                      </div>
                      {String(form.disbursement_route) === 'bank' && (
                        <div className="min-w-0 flex-1">
                          <Select
                            value={String(form.disbursement_account || '')}
                            onValueChange={(v) => setForm((p) => ({ ...p, disbursement_account: v }))}
                          >
                            <SelectTrigger className="h-11">
                              <SelectValue placeholder="Pick the bank the money landed in" />
                            </SelectTrigger>
                            <SelectContent>
                              {formBanks.map((a) => (
                                <SelectItem key={String(a.id)} value={String(a.name)}>
                                  {String(a.name)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                    {String(form.disbursement_route || 'unconfirmed') === 'unconfirmed' && (
                      <p className="text-[11.5px] font-semibold text-[#8A5A00]">
                        Not confirmed yet — this bill was entered before the question was asked, and keeps posting into the bank on its voucher until you pick one.
                      </p>
                    )}
                    {String(form.disbursement_route) === 'supplier' && (
                      <p className="text-[11.5px] font-semibold text-[#5A6B62]">
                        Posts as a journal: the supplier is debited with what the NBFC paid, against the NBFC's payable. No bank entry.
                      </p>
                    )}
                  </div>
                </div>
              </section>

              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4', __WEB__ && BD_CARD)}>
                <h3 className={cn('mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && BD_CARD_HEAD)}>
                  {__WEB__ ? (
                    <StepTitle n={2} done={amountStepDone} sub="What the NBFC opens, and what it charges for it">
                      Amount and terms
                    </StepTitle>
                  ) : (
                    'Amount and terms'
                  )}
                </h3>
                {/* 140px, the canvas's floor for a figure — four to a row in a
                    720px drawer, which leaves the seven terms as four then
                    three exactly as the design shows. The groups below are
                    `contents`, so they order the fields without taking a row
                    of their own. */}
                <div
                  className={cn(
                    'grid gap-4 md:grid-cols-3 xl:grid-cols-4',
                    __WEB__ && '!flex !flex-col !gap-[14px] !px-4 !pb-4 !pt-3.5'
                  )}
                >
                  {/* WHAT THE BILL IS WORTH — four figures that are read
                      together, so they hold a row of their own.

                      Sized by the CARD, not by the viewport. `sm:`/`lg:` answer
                      to the window, which is the wrong ruler for a panel of
                      fixed width: a 920px drawer in a 1000px window got two
                      across while the same drawer in a 1300px window got four,
                      though nothing about the drawer had changed. auto-fit packs as
                      many as the card can hold and collapses the tracks it
                      cannot.

                      190px is the floor, measured rather than guessed. It is
                      the widest floor that still fits four in the 848px this
                      card gives them, and wide enough that the step down is
                      four to TWO: at a narrower floor three fit, which strands
                      the fourth field alone on a second row. Measured ladder,
                      920px drawer down to a phone — 4 · 4 · 2 · 2 · 2 · 1. */}
                  <div
                    className={cn(
                      'contents',
                      __WEB__ &&
                        // Four across in the 920px drawer, two by two below it.
                        // The drawer is a fixed 920px from a 960px window up and
                        // 96vw under it, so the window is a true ruler here — and
                        // auto-fit cannot do it: at tablet width it packed four
                        // 150px boxes and the Open and Adj. figures disappeared
                        // behind their own chips.
                        '!grid !grid-cols-1 min-[560px]:!grid-cols-2 min-[960px]:!grid-cols-4 !items-start !gap-x-[14px] !gap-y-3'
                    )}
                  >
                  {/* The invoice behind the bill, and the part of it actually
                      being discounted. They are often not the same figure, and
                      only the second one is priced — the invoice value is kept
                      alongside it so the file records what was financed
                      against what. */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Invoice ₹ *
                      <InfoTip text="The full value of the invoice this bill is drawn against. Optional, and nothing is priced off it — it is recorded so you can see how much of the invoice was financed." />
                    </Label>
                    <Input
                      type="number"
                      value={form.invoice_amount ?? ''}
                      className={cn(__WEB__ && FIELD_FIG)}
                      onChange={(e) => setForm((p) => ({ ...p, invoice_amount: e.target.value }))}
                    />
                    {/* A bill saved while the adjustment was struck on the
                        invoice keeps it (it is what its margin was worked
                        on); said here, as it has no box of its own now. */}
                    {!!n(form.invoice_adj) && (
                      <div className="text-[10.5px] font-semibold text-[#8A5300]">
                        Includes an older invoice adjustment of {n(form.invoice_adj) > 0 ? '+' : '−'}
                        {formatINR(Math.abs(n(form.invoice_adj)))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Margin %
                      <InfoTip text="What the NBFC holds back — on a ₹100 bill, 20% means ₹20 stays with them and ₹80 is released. It's a recoverable deposit, refunded when the bill is repaid." />
                    </Label>
                    <Input
                      type="number"
                      value={form.margin_pct ?? ''}
                      className={cn(__WEB__ && FIELD_FIG)}
                      onChange={(e) => setForm((p) => ({ ...p, margin_pct: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Open ₹
                      <InfoTip text="What is actually drawn. It defaults to the sanctioned amount — invoice less the margin — and can be lowered if less was taken; the shortfall then shows as the balance still available on this bill." />
                    </Label>
                    {/* The balance available and the sanctioned figure are
                        spelled out in the strip below, so repeating them here
                        stacked three deep only crowded the field. What is left
                        is the one thing the strip does not say: how much of the
                        INVOICE is being drawn, and whether it exceeds it — and
                        that belongs beside the figure it is about, not on a
                        line under it. */}
                    {(() => {
                      const invEff = n(form.invoice_amount) > 0 ? Math.max(0, round2(n(form.invoice_amount) + n(form.invoice_adj))) : 0
                      const over = n(form.amount) - invEff > 0.004
                      const show = invEff > 0 && n(form.amount) > 0
                      // The frame stays on whether or not the chip shows:
                      // swapping a bare input for a framed one as the first
                      // figure is typed remounted it and dropped focus.
                      const input = (
                        <Input
                          type="number"
                          value={form.amount ?? ''}
                          data-raw={__WEB__ ? '' : undefined}
                          className={cn(__WEB__ && FIELD_FIG, __WEB__ && FIELD_BARE)}
                          onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value, amount_touched: true }))}
                        />
                      )
                      if (!__WEB__) {
                        return (
                          <>
                            {input}
                            {show && (
                              <div className={cn('text-[11px]', over ? 'font-medium text-amber-700' : 'text-muted-foreground')}>
                                {over
                                  ? `More than the ${formatINR(invEff)} invoice — check the two figures`
                                  : `${round2((n(form.amount) / invEff) * 100)}% of the invoice`}
                              </div>
                            )}
                          </>
                        )
                      }
                      return (
                        <div className={cn(FIELD_WRAP_BD, '!pr-[11px]', show && over && '!border-[#E3C58C]')}>
                          {input}
                          {show && (
                            <FieldChip tone={over ? 'warn' : 'plain'}>
                              {over ? 'over invoice' : `${round2((n(form.amount) / invEff) * 100)}% of bill`}
                            </FieldChip>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  {/* ADJ. — plus or minus on the PAYOUT. The NBFC lends the
                      whole Open amount and charges interest on all of it; a
                      deduction it makes (a minus) or an addition only moves
                      what reaches the bank, and posts to the ledger of the
                      kind of charge picked beside the figure. */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Adj. ₹ (+/−)
                      <InfoTip text="What the NBFC takes off (−) or adds to (+) its payout. Interest and the drawn amount stay on the whole Open amount; only what reaches your bank moves. Pick the kind of charge beside the figure — it decides the ledger the Adj. posts to (BD charges unless you change it), and you can add your own kinds. E.g. −700000 for a deduction the NBFC makes. Leave blank for none." />
                    </Label>
                    {(() => {
                      const adj = n(form.open_adj)
                      const input = (
                        <Input
                          type="number"
                          step="any"
                          value={form.open_adj ?? ''}
                          placeholder="0"
                          data-raw={__WEB__ ? '' : undefined}
                          className={cn(__WEB__ && FIELD_FIG, __WEB__ && FIELD_BARE, __WEB__ && adj < 0 && '!text-[#8C2F26]')}
                          onChange={(e) => setForm((p) => ({ ...p, open_adj: e.target.value }))}
                        />
                      )
                      // The KIND of charge sits beside the figure: it decides the
                      // ledger the Adj. posts to. A charge on the payout either
                      // way, never a change to what is drawn.
                      const picker = (
                        <AdjChargePicker
                          value={String(form.open_adj_ledger || '')}
                          onChange={(ledger) => setForm((p) => ({ ...p, open_adj_ledger: ledger }))}
                          adj={n(form.open_adj)}
                          split={Array.isArray(form.open_adj_split) ? (form.open_adj_split as AdjPart[]) : null}
                          onSplitChange={(split) => setForm((p) => ({ ...p, open_adj_split: split }))}
                          types={chargeTypes}
                          onTypesChange={setChargeTypes}
                          className={cn(__WEB__ && '!h-[30px] !gap-[3px] !rounded-[5px] !border !border-[#C6DAF0] !py-0 !pl-2 !pr-1.5 !font-extrabold')}
                        />
                      )
                      if (!__WEB__) {
                        return (
                          <>
                            <div className="flex items-center">
                              {input}
                              {picker}
                            </div>
                            {!!adj && (
                              <div className="text-[11px] text-muted-foreground">
                                {adj < 0 ? `Charged to ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}` : `Added to the payout · ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}`} — drawn and
                                interest stay on the Open amount
                              </div>
                            )}
                          </>
                        )
                      }
                      // Under it, where the figure goes and what it does to the
                      // interest — which the switch below decides.
                      return (
                        <>
                          <div className={cn(FIELD_WRAP_BD, !!adj && '!border-[#C6DAF0]')}>
                            {input}
                            {picker}
                          </div>
                          <div
                            className="text-[10.5px] font-semibold leading-[1.4] [text-wrap:pretty]"
                            style={{ color: adj ? '#1B4E82' : '#8CA396' }}
                          >
                            {adj
                              ? `${adj < 0 ? `Charged to ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}` : `Added to the payout · ${adjPostsTo(form.open_adj_ledger, form.open_adj_split)}`}${
                                  form.interest_after_adj
                                    ? ' — interest is charged on what is left after it'
                                    : ' — drawn and interest stay on the Open amount'
                                }`
                              : 'Leave blank for none.'}
                          </div>
                        </>
                      )
                    })()}
                  </div>
                  </div>
                  {/* INTEREST BEFORE OR AFTER THE ADJ. Most NBFCs charge
                      their interest on the whole Open amount and take their
                      Adj. off the payout; some charge it on what is left once
                      the Adj. is applied. One switch says which, right under
                      the two figures it is about, and the line under its name
                      works the answer out. */}
                  {__WEB__ && (() => {
                    const adj = n(form.open_adj)
                    const open = preview ? preview.openAmount : round2(n(form.amount))
                    return (
                      <SwitchCard
                        tone="lime"
                        on={!!form.interest_after_adj}
                        onChange={(v) => setForm((p) => ({ ...p, interest_after_adj: v }))}
                        title="Interest charged after adjusted amount"
                        sub={
                          !adj
                            ? 'No Adj. entered — makes no difference until there is one.'
                            : form.interest_after_adj
                              ? `Interest on ${formatINR(Math.max(0, round2(open + adj)))} — the Open amount after the Adj.`
                              : `Off — interest stays on the full ${formatINR(open)} Open amount.`
                        }
                        subTone={form.interest_after_adj && adj ? 'good' : undefined}
                        note="Off: interest runs on the whole Open amount and the Adj. only changes what reaches your bank. On: the NBFC charges interest on the Open amount after the Adj. has been applied — an Open amount of 70,00,000 with an Adj. of −7,08,000 is charged interest on 62,92,000. Either way the Adj. itself still posts to its own ledger, and the bill is repaid on the whole Open amount."
                      />
                    )
                  })()}
                  {/* The margin and the sanctioned amount are not questions —
                      the invoice and the margin % already answer them. So they
                      are worked out and shown, as a line of arithmetic rather
                      than as two more boxes that look like they want typing
                      into. It also puts the sanctioned figure in front of the
                      user at the moment it is decided, instead of only in the
                      summary further down the form. */}
                  {/* WHAT IS SANCTIONED, AND WHAT IS BEING TAKEN.
                      Two different kinds of fact, so two cells rather than one
                      long cream strip with the answer buried in the middle of
                      it: on the left the arithmetic that produces the ceiling,
                      on the right the figure actually being drawn against it —
                      in the blue this page gives to money outstanding, and
                      carrying the one action that changes it. */}
                  {__WEB__ && n(form.invoice_amount) > 0 && preview && (
                    <div className="flex flex-wrap items-center gap-x-[14px] gap-y-2.5 rounded-[9px] border border-[#E5DFC8] bg-[linear-gradient(180deg,#FBF9F1,#F7F4E8)] px-[14px] py-3">
                      <Derived
                        label={n(form.invoice_adj) ? 'Invoice (adj.)' : 'Invoice'}
                        value={formatINR(Math.max(0, round2(n(form.invoice_amount) + n(form.invoice_adj))))}
                      />
                      <Op>−</Op>
                      <Derived
                        label={`Margin ${formatNum(n(form.margin_pct))}%`}
                        value={formatINR(preview.marginAmount)}
                        hint="held back by the NBFC"
                      />
                      <Op>=</Op>
                      <Derived
                        label="Sanctioned amt"
                        value={formatINR(preview.sanctionedAmount)}
                        hint="the most this bill can draw"
                        strong
                      />
                      <div className="hidden h-10 w-px self-center bg-[#E0D8C0] sm:block" />
                      <Derived
                        label="Drawn now"
                        value={formatINR(preview.openAmount)}
                        hint={
                          preview.undrawnAmount > 0.004
                            ? `${formatINR(preview.undrawnAmount)} still available`
                            : preview.undrawnAmount < -0.004
                              ? `${formatINR(Math.abs(preview.undrawnAmount))} over the sanction`
                              : 'fully drawn'
                        }
                        tone={preview.undrawnAmount < -0.004 ? 'bad' : undefined}
                      />
                      {/* The action belongs beside the figure it changes. */}
                      {preview.sanctionedAmount > 0 && round2(preview.openAmount) !== round2(preview.sanctionedAmount) && (
                        <button
                          type="button"
                          className="ml-auto flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[#C3D2C6] bg-white px-3 text-[11.5px] font-extrabold text-[#0B3D2E] hover:bg-[#F4F9EF]"
                          title={`Draw the whole ${formatINR(preview.sanctionedAmount)} sanctioned`}
                          onClick={() =>
                            setForm((p) => ({
                              ...p,
                              // Drawn = Open, so drawing it all is the
                              // sanction itself — the Adj. is a charge on
                              // the payout, not on the draw.
                              amount: String(round2(preview.sanctionedAmount)),
                              amount_touched: true
                            }))
                          }
                        >
                          <ArrowUpToLine className="h-[15px] w-[15px]" />
                          Draw it all
                        </button>
                      )}
                    </div>
                  )}

                  {!__WEB__ && n(form.invoice_amount) > 0 && preview && (
                    <div className="md:col-span-3 xl:col-span-4">
                      <div className="flex flex-wrap items-stretch gap-x-3 gap-y-2 rounded-lg border border-[#e5dfc8] bg-[#f7f4e8] px-3 py-2">
                        <Derived
                          label={n(form.invoice_adj) ? 'Invoice (adj.)' : 'Invoice'}
                          value={formatINR(Math.max(0, round2(n(form.invoice_amount) + n(form.invoice_adj))))}
                        />
                        <Op>−</Op>
                        <Derived
                          label={`Margin ${formatNum(n(form.margin_pct))}%`}
                          value={formatINR(preview.marginAmount)}
                          hint="held back by the NBFC"
                        />
                        <Op>=</Op>
                        <Derived
                          label="Sanctioned amt"
                          value={formatINR(preview.sanctionedAmount)}
                          hint="the most this bill can draw"
                          strong
                        />
                        <div className={cn('hidden w-px self-stretch bg-[#d9d2b8] sm:block', __WEB__ && '!bg-[#E0D8C0]')} />
                        <Derived
                          label="Drawn now"
                          value={formatINR(preview.openAmount)}
                          hint={
                            preview.undrawnAmount > 0.004
                              ? `${formatINR(preview.undrawnAmount)} still available`
                              : preview.undrawnAmount < -0.004
                                ? `${formatINR(Math.abs(preview.undrawnAmount))} over the sanction`
                                : 'fully drawn'
                          }
                          tone={preview.undrawnAmount < -0.004 ? 'bad' : undefined}
                        />
                        {preview.sanctionedAmount > 0 &&
                          round2(preview.openAmount) !== round2(preview.sanctionedAmount) && (
                            <Button
                              type="button"
                              variant="outline"
                              className="ml-auto h-7 self-center bg-white px-2 text-[11px]"
                              title={`Draw the whole ${formatINR(preview.sanctionedAmount)} sanctioned`}
                              onClick={() =>
                                setForm((p) => ({
                                  ...p,
                                  // Drawn = Open, so drawing it all is the
                                  // sanction itself — the Adj. is a charge on
                                  // the payout, not on the draw.
                                  amount: String(round2(preview.sanctionedAmount)),
                                  amount_touched: true
                                }))
                              }
                            >
                              Draw it all
                            </Button>
                          )}
                      </div>
                    </div>
                  )}

                  {/* WHAT IT COSTS — three figures of the same kind, so they
                      take equal thirds of the card rather than whatever width
                      the auto-fit happened to leave them. */}
                  <div
                    className={cn(
                      'contents',
                      __WEB__ &&
                        '!grid !grid-cols-[repeat(auto-fit,minmax(min(100%,130px),1fr))] !items-start !gap-x-[14px] !gap-y-3'
                    )}
                  >
                  <div className="flex flex-col gap-1.5">
                    <Label>{__WEB__ ? 'Interest % p.a.' : 'Interest %'}</Label>
                    <Input
                      type="number"
                      value={form.interest_pct ?? ''}
                      className={cn(__WEB__ && FIELD_FIG)}
                      onChange={(e) => setForm((p) => ({ ...p, interest_pct: e.target.value }))}
                    />
                  </div>
                  {/* Worked out, not typed: receipt date to maturity, counted
                      by whichever end-convention the NBFC uses. Typing it
                      would let the days disagree with the dates they come
                      from. */}
                  {__WEB__ && (
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1">
                        Interest days
                        <InfoTip text="Receipt date to maturity. Counted from the dates rather than entered, so the two can never disagree — the toggle below decides whether the receipt day itself counts." />
                      </Label>
                      <div
                        className={cn(
                          'flex h-10 items-center justify-between gap-2 rounded-[7px] border px-[11px]',
                          preview && preview.intDays > 0
                            ? 'border-[#C6DAF0] bg-[#EEF4FB]'
                            : 'border-dashed border-[#C3D2C6] bg-white'
                        )}
                      >
                        <span
                          className={cn(
                            'doc-ref text-[12.5px] font-bold',
                            preview && preview.intDays > 0 ? 'text-[#1B4E82]' : 'text-[#8FA79B]'
                          )}
                        >
                          {preview && preview.intDays > 0 ? `${preview.intDays} days` : 'once dated'}
                        </span>
                        {!!preview && preview.intDays > 0 && (
                          <span className="rounded-[3px] bg-white px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-[.1em] text-[#1B4E82]">
                            auto
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      {__WEB__ ? 'TDS % on interest' : 'TDS %'}
                      <InfoTip text="TDS deducted on the interest. It's withheld from what the NBFC is paid, so the company nets that much more now and owes it to the tax department separately." />
                    </Label>
                    <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Days in year
                      <InfoTip text="The day-count basis interest is worked out on. Bill discounting conventionally uses 360, not the calendar 365 — it comes from the NBFC's terms and is negotiated like the rate is." />
                    </Label>
                    <Input type="number" value={form.days_year ?? 360} onChange={(e) => setForm((p) => ({ ...p, days_year: e.target.value }))} />
                  </div>
                  </div>
                  {__WEB__ && (
                    <p className="-mt-1.5 text-[11px] font-semibold text-[#5A6B62]">
                      Bill discounting conventionally uses 360, not the calendar 365.
                    </p>
                  )}
                  {__WEB__ ? (
                    // WHEN THE INTEREST IS PAID — ONE QUESTION, THREE ANSWERS,
                    // drawn as the canvas draws it: two switches that turn each
                    // other off. With neither on — the usual case — the NBFC
                    // discounts the interest out of the disbursement, and the
                    // line under them NAMES that, so it is never a state reached
                    // by turning things off that nothing on screen calls by name.
                    // Counting the receipt date is a separate yes or no, first.
                    (() => {
                      const mode = String(form.interest_mode || (form.interest_upfront ? 'upfront' : 'discounted'))
                      const setMode = (m: string): void =>
                        setForm((p) => ({
                          ...p,
                          interest_mode: m,
                          interest_upfront: m === 'upfront',
                          interest_freq: m === 'serviced' ? p?.interest_freq || 'monthly' : p?.interest_freq
                        }))
                      const freq = String(form.interest_freq || 'monthly')
                      return (
                        <div className="flex flex-col gap-2.5">
                          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-2.5">
                            <SwitchCard
                              on={!!form.days_incl_start}
                              onChange={(v) => setForm((p) => ({ ...p, days_incl_start: v }))}
                              title="Count the receipt date"
                              note="Whether the day the money lands earns interest too. Off, interest runs from the day after to maturity — 1 to 30 September is 29 days. On, both ends count and the same dates are 30. It comes from the NBFC’s terms and is copied onto the bill when the NBFC is picked, so changing an NBFC never moves a bill already recorded."
                            />
                            <SwitchCard
                              on={mode === 'upfront'}
                              onChange={(v) => setMode(v ? 'upfront' : 'discounted')}
                              title="Interest settled upfront"
                              note="The whole tenor’s interest is paid separately from the bank rather than deducted from the bill. The opening voucher leaves it out, and it posts once the matching bank line is reconciled."
                            />
                            <SwitchCard
                              on={mode === 'serviced'}
                              onChange={(v) => setMode(v ? 'serviced' : 'discounted')}
                              title="Interest serviced over the tenor"
                              note="The full amount lands and the interest is paid as it runs — monthly, fortnightly, or whatever rest was agreed — with only the principal falling due at maturity. Each rest posts its own voucher with its own TDS."
                            />
                          </div>
                          <p className="text-[11px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                            {mode === 'serviced'
                              ? 'Serviced — the full amount lands, the interest falls due at each rest, and only the principal is due at maturity.'
                              : mode === 'upfront'
                                ? 'Settled upfront — the full amount lands, and the interest is paid from your bank on a voucher of its own.'
                                : 'Neither on — the NBFC discounts the interest: it keeps the whole tenor’s interest out of what it sends.'}
                          </p>
                          {mode === 'serviced' && (
                            <div className="flex flex-col gap-1.5">
                              <Label className="flex items-center gap-1">
                                Interest rest
                                <InfoTip text="How often the interest falls due. Monthly means the calendar month — a bill drawn on the 1st rests on the 1st — and the last rest always lands on maturity, however short that final stretch is." />
                              </Label>
                              <Seg
                                soft
                                fill
                                value={freq}
                                onChange={(v) => setForm((p) => ({ ...p, interest_freq: v }))}
                                options={[
                                  { v: 'fortnightly', label: 'Fortnightly' },
                                  { v: 'monthly', label: 'Monthly' },
                                  { v: 'quarterly', label: 'Quarterly' },
                                  { v: 'half_yearly', label: 'Half-yearly' },
                                  { v: 'maturity', label: 'At maturity' }
                                ]}
                              />
                              <p className="text-[11px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                                {freq === 'maturity'
                                  ? 'One rest, at maturity — the interest and the principal fall due together.'
                                  : 'How often the interest falls due. Monthly means the calendar month — a bill drawn on the 1st rests on the 1st — and the last rest always lands on maturity, however short that final stretch is.'}
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })()
                  ) : (
                    <>
                      <div className="flex flex-col justify-end gap-1.5">
                        <label className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md border px-3">
                          <Switch
                            checked={!!form.days_incl_start}
                            onCheckedChange={(v) => setForm((p) => ({ ...p, days_incl_start: v }))}
                          />
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium">Count the receipt date</span>
                            <InfoTip text="Whether the payment received date itself earns interest. Off, interest runs from the day after the money lands to maturity — 1 to 30 September is 29 days. On, both ends count and the same dates are 30 days." />
                          </span>
                        </label>
                      </div>
                      <div className="flex flex-col justify-end gap-1.5">
                        <label className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md border px-3">
                          <Switch checked={!!form.interest_upfront} onCheckedChange={(v) => setForm((p) => ({ ...p, interest_upfront: v }))} />
                          <span className="flex items-center gap-1.5">
                            <span className="text-sm font-medium">Interest upfront</span>
                            <InfoTip text="The interest is paid separately from the bank rather than deducted from the bill — the opening voucher then leaves it out, and it posts once the matching bank line is reconciled." />
                          </span>
                        </label>
                      </div>
                      <div className="flex flex-col justify-end gap-1.5">
                        <label className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md border px-3">
                          <Switch
                            checked={!!form.interest_after_adj}
                            onCheckedChange={(v) => setForm((p) => ({ ...p, interest_after_adj: v }))}
                          />
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium">Interest after the Adj.</span>
                            <InfoTip text="Off: interest runs on the whole Open amount and the Adj. only changes what reaches your bank. On: the NBFC charges interest on the Open amount after the Adj. has been applied." />
                          </span>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              </section>

              {/* The trading round trip. A trading bill discounts a purchase
                  and the goods are resold, so the customer's money comes back
                  — but nothing can say WHICH resale invoices it is expected
                  through unless the bill is tied to the purchase invoices it
                  funded. These two are that tie, and they are what Payment IN
                  needs. Only shown for a trading bill; a manufacturing one has
                  no second leg. */}
              {/* Teal is not a colour this page uses. Green, like every other
                  block about money coming back in. */}
              {String(form.purpose) === 'trading' && (
                <section className={cn('rounded border border-teal-200 bg-teal-50/50 p-4', __WEB__ && BD_CARD)}>
                  <h3 className={cn('mb-3 border-b border-dotted border-teal-300 pb-1.5 text-[11px] font-bold uppercase tracking-widest text-teal-900', __WEB__ && BD_CARD_HEAD)}>
                    {__WEB__ ? (
                      <StepTitle n={3} done={!!form.receivable_party_id} sub="Who pays back, and which purchases it funds">
                        Trading round trip
                      </StepTitle>
                    ) : (
                      'Trading round trip'
                    )}
                  </h3>
                  <div className={cn('grid gap-4 md:grid-cols-2', __WEB__ && '!grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] !gap-3.5 !px-4 !pb-4 !pt-3.5')}>
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1">
                        Payment received back from
                        <InfoTip text="The customer the goods are resold to — who pays us back. Payment IN posts against this party's ledger and settles their resale invoices." />
                      </Label>
                      <Select
                        searchable
                        value={String(form.receivable_party_id || '')}
                        onValueChange={(v) => setForm((p) => ({ ...p, receivable_party_id: v }))}
                      >
                        <SelectTrigger><SelectValue placeholder="Select the customer" /></SelectTrigger>
                        <SelectContent>
                          {customers.map((cu) => (
                            <SelectItem key={String(cu.id)} value={String(cu.id)}>{cu.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="flex items-center gap-1">
                        Purchase invoices this bill funds
                        <InfoTip text="Each invoice is its own pick. One invoice funds one bill, so an invoice already on another bill is shown but cannot be taken. Picking one also fills in who pays back, from that deal's customer." />
                      </Label>
                      {!form.party_id ? (
                        <p className={cn('text-[11px] text-muted-foreground', __WEB__ && HINT)}>Choose the party above first.</p>
                      ) : !tradingLoaded ? (
                        <p className={cn('text-[11px] text-muted-foreground', __WEB__ && HINT)}>Loading trading deals…</p>
                      ) : formTradingInvoices.length === 0 ? (
                        <p className={cn('text-[11px] text-muted-foreground', __WEB__ && HINT)}>No open trading invoices for this party.</p>
                      ) : (
                        <div
                          className={cn(
                            'max-h-40 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5',
                            __WEB__ && '!max-h-[196px] !rounded-[4px] !border-[#DCE7DB]'
                          )}
                        >
                          {formTradingInvoices.map((r) => {
                            const ids: number[] = Array.isArray(form.linked_order_ids) ? form.linked_order_ids : []
                            const checked = ids.map(Number).includes(Number(r.order_id))
                            const claim = invoiceClaims.get(Number(r.order_id))
                            return (
                              <label
                                key={String(r.order_id)}
                                // An invoice row is not a field caption. See BD_FIELDS.
                                data-raw
                                className={cn(
                                  'flex items-center gap-2 rounded px-2 py-1.5 text-[12px]',
                                  claim ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                                  checked ? 'bg-teal-100' : !claim && 'hover:bg-muted/40',
                                  __WEB__ &&
                                    cn(
                                      '!gap-2.5 !rounded-[3px] !px-2.5 !py-2 !text-[12.5px] !font-semibold',
                                      checked ? '!bg-[#E9F5EE] !text-[#0B6B45]' : !claim && 'hover:!bg-[#F7FAF6]'
                                    )
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className={cn('h-3.5 w-3.5 shrink-0', __WEB__ && '!h-4 !w-4 !accent-[#0B3D2E]')}
                                  checked={checked}
                                  disabled={!!claim}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...ids, Number(r.order_id)]
                                      : ids.filter((x) => Number(x) !== Number(r.order_id))
                                    setForm((prev) => ({
                                      ...prev,
                                      linked_order_ids: next,
                                      // Who the goods are resold to is who pays us
                                      // back — pre-filled, never forced.
                                      receivable_party_id:
                                        prev?.receivable_party_id ||
                                        (e.target.checked && r.customer_id ? String(r.customer_id) : prev?.receivable_party_id)
                                    }))
                                  }}
                                />
                                <span className="flex-1 truncate">
                                  {r.invoice_no || `Order #${r.order_id}`} · {formatDate(r.deal_date)}
                                  <span className={cn('ml-1.5 text-muted-foreground', __WEB__ && '!text-[#5A6B62]')}>
                                    → {r.customer_name || 'no customer yet'}
                                  </span>
                                  {claim && (
                                    <span className={cn('ml-1.5 text-rose-700', __WEB__ && '!text-[#8C2F26]')}>
                                      · on bill {claim.bd_no || 'pending'}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 font-medium tabular-nums">{formatINR(r.net_amount)}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                      {(() => {
                        const ids: number[] = Array.isArray(form.linked_order_ids) ? form.linked_order_ids : []
                        if (!ids.length) return null
                        const total = round2(
                          tradingOrders
                            .filter((o) => ids.map(Number).includes(Number(o.id)))
                            .reduce((t, o) => t + n(o.net_amount), 0)
                        )
                        return (
                          <div className={cn('text-[11px] text-muted-foreground', __WEB__ && '!font-bold !text-[#0B6B45]')}>
                            {ids.length} invoice{ids.length === 1 ? '' : 's'} · {formatINR(total)} funded
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                </section>
              )}

              {/* Interest runs from the day the payment is received, and that
                  date is stamped later — so on a bill that has not been funded
                  yet the interest, TDS and payout are not knowable and are not
                  shown as zeroes. Margin is, since it is a straight percentage
                  of the open amount. */}
              {/* Interest runs from the day the payment is received, and that
                  date is stamped later — so on a bill that has not been funded
                  yet the interest, TDS and payout are not knowable and are not
                  shown as zeroes. On the website the rail says this. */}
              {!__WEB__ && preview && n(form.amount) > 0 && !form.payment_received_date && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-[11px] font-medium text-amber-800">
                  Interest, TDS and payout are worked out on <b className="font-extrabold">Mark payment received</b> — interest
                  runs from the day the money lands, and that date is not known yet.
                </div>
              )}
              {/* The desktop app keeps its flat strip. */}
              {preview && n(form.amount) > 0 && !!form.payment_received_date && !__WEB__ && (
                <div
                  className={cn(
                    'grid grid-cols-2 gap-px rounded-lg border border-[#e5dfc8] bg-[#e5dfc8] p-px sm:grid-cols-4 md:grid-cols-8',
                    // EIGHT MONEY CELLS DO NOT FIT A DRAWER.
                    // md:grid-cols-8 is keyed to the VIEWPORT, not to this
                    // panel, so on any ordinary screen it laid eight cells
                    // across 840px — 105px each, and every figure over a lakh
                    // wrapped or clipped.
                    //
                    // 190px is deliberate rather than the smallest that fits:
                    // at the drawer's width it gives FOUR columns, and eight
                    // cells is then two full rows with no half-empty tail
                    // showing the grid's own background through it.
                    __WEB__ &&
                      '!grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] !rounded-[4px] !border-[#DCE7DB] !bg-[#DCE7DB]'
                  )}
                >
                  {([
                    {
                      label: form.days_incl_start ? 'Int. days (incl.)' : 'Int. days',
                      value: String(preview.intDays),
                      tone: 'text-[#1a2c56]'
                    },
                    { label: 'Margin', value: formatINR(preview.marginAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Sanctioned', value: formatINR(preview.sanctionedAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Drawn', value: formatINR(preview.openAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Interest', value: formatINR(preview.interestAmount), tone: 'text-rose-700' },
                    { label: 'TDS', value: formatINR(preview.tdsAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Net int.', value: formatINR(preview.netInterest), tone: 'text-[#1a2c56]' }
                  ] as const).map((c) => (
                    <div key={c.label} className={cn('bg-white px-3 py-2 text-center', __WEB__ && '!px-3 !py-2.5 !text-left')}>
                      <div
                        className={cn(
                          'text-[10px] uppercase tracking-wide text-muted-foreground',
                          __WEB__ && '!whitespace-nowrap !text-[9.5px] !font-extrabold !tracking-[.11em] !text-[#5A6B62]'
                        )}
                      >
                        {c.label}
                      </div>
                      <div
                        className={cn(
                          'text-[13px] font-semibold tabular-nums',
                          c.tone,
                          __WEB__ &&
                            cn(
                              'doc-ref !mt-1 !whitespace-nowrap !text-[13px] !font-bold !tracking-[-0.02em]',
                              c.tone === 'text-rose-700' ? '!text-[#8C2F26]' : '!text-[#0A1F17]'
                            )
                        )}
                      >
                        {c.value}
                      </div>
                    </div>
                  ))}
                  <div className={cn('bg-emerald-50 px-3 py-2 text-center', __WEB__ && '!bg-[#F4FBF6] !px-3 !py-2.5 !text-left')}>
                    <div
                      className={cn(
                        'text-[10px] uppercase tracking-wide text-muted-foreground',
                        __WEB__ && '!whitespace-nowrap !text-[9.5px] !font-extrabold !tracking-[.11em] !text-[#0B6B45]'
                      )}
                    >
                      Net payout
                    </div>
                    <div
                      className={cn(
                        'text-[13px] font-bold tabular-nums text-emerald-700',
                        __WEB__ && 'doc-ref !mt-1 !whitespace-nowrap !text-[13px] !font-bold !tracking-[-0.02em] !text-[#0B6B45]'
                      )}
                    >
                      {formatINR(preview.receiptAmount)}
                    </div>
                  </div>
                </div>
              )}

              {/* A CARD LIKE EVERYTHING ELSE.
                  The note was a bare label and box sitting on the panel's own
                  ground while every other field lived inside a white section,
                  so it read as something that had fallen out of the form
                  rather than the last thing in it. And a note is prose: one
                  line of input invited one line of answer. */}
              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4', __WEB__ && BD_CARD)}>
                <h3 className={cn('mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]', __WEB__ && BD_CARD_HEAD)}>
                  {__WEB__ ? (
                    <StepTitle
                      n={String(form.purpose) === 'trading' ? 4 : 3}
                      done={!!String(form.note || '').trim()}
                      sub="Anything worth recording, and whether money comes back"
                    >
                      Note &amp; payment in
                    </StepTitle>
                  ) : (
                    'Note'
                  )}
                </h3>
                <div className={cn('flex flex-col gap-1.5', __WEB__ && '!p-4')}>
                  {!__WEB__ && <Label>Note</Label>}
                  {__WEB__ ? (
                    <textarea
                      rows={2}
                      placeholder="Anything worth recording against this bill — optional"
                      className="w-full resize-none rounded-[7px] border border-[#C3D2C6] bg-white px-[11px] py-2.5 text-[13px] font-semibold text-[#0A1F17] shadow-[inset_0_1px_2px_rgba(10,31,23,.04)] outline-none placeholder:font-medium placeholder:text-[#8FA79B] focus:border-[#0B3D2E]"
                      value={form.note ?? ''}
                      onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
                    />
                  ) : (
                    <Input value={form.note ?? ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
                  )}
                  {/* WILL THE MONEY COME BACK? — at the very foot of the
                      form, because it is the last thing decided about a bill
                      and the only thing here about what happens AFTER it.

                      A switch rather than a number, because that is the
                      question. Turn it on and the bill is tracked for money
                      coming back: the register carries a chip until it comes,
                      and Payment IN opens on the row. The term is optional on
                      top of it — "yes, it comes back, we have not agreed when"
                      is a real answer, and a blank number could not say it. */}
                  <div
                    className={cn(
                      'mt-3 flex flex-col gap-2 rounded-[8px] border px-3.5 py-3',
                      form.payment_in_expected
                        ? 'border-[#BFE3CB] bg-[#F1F9F4]'
                        : 'border-[#E4ECE3] bg-[#F8FBF7]'
                    )}
                  >
                    {/* data-raw: a switch row is not a field caption. Without
                        it the drawer's caption rule takes this label at
                        15px tall with overflow hidden, which crushes a 20px
                        switch to a sliver of its own track and puts the
                        wording in grey caps. See BD_FIELDS. */}
                    <label data-raw className="flex cursor-pointer items-center gap-2.5">
                      <Switch
                        checked={!!form.payment_in_expected}
                        onCheckedChange={(v) => setForm((p) => ({ ...p, payment_in_expected: v }))}
                      />
                      <span className="text-[13px] font-semibold text-[#0A1F17]">Payment will come back IN</span>
                    </label>
                    {!!form.payment_in_expected && (
                      <div className="flex flex-wrap items-center gap-2 pl-[52px]">
                        <span className="text-[11.5px] text-muted-foreground">Expected after</span>
                        <Input
                          type="number"
                          min={0}
                          className="h-8 w-[92px]"
                          placeholder="days"
                          value={form.payment_in_days ?? ''}
                          onChange={(e) => setForm((p) => ({ ...p, payment_in_days: e.target.value }))}
                        />
                        <span className="text-[11.5px] text-muted-foreground">
                          days from the receipt date
                          {Number(form.payment_in_days) > 0 && form.payment_received_date
                            ? ` · due ${formatDate(payInDueDate({ ...form }))}`
                            : ' · leave blank if no term was agreed'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </section>
              {/* Below 1280 there is no room beside the form, so the rail
                  follows it — the canvas's single column. */}
              {__WEB__ && bdRail && <div className="flex flex-col gap-3 min-[1280px]:hidden">{bdRail}</div>}
            </div>
            {__WEB__ && bdSummary}
          </div>
          )}
          <DialogFooter
            className={cn(
              __WEB__ &&
                '!flex !flex-wrap !items-center !gap-3 !border-t !border-t-[#DCE7DB] !bg-white !px-5 !py-3 !shadow-[0_-8px_20px_-14px_rgba(7,43,32,.25)] sm:!justify-start'
            )}
          >
            {/* WHAT REACHES THE BANK, by the button that makes it happen — the
                one figure anybody is waiting for, kept in view at the foot of
                the form however far it has been scrolled. What is still
                missing is said by the rail; below 1280, where the rail sits
                under the form, the footer counts it too. */}
            {__WEB__ && !!form && (() => {
              const miss = bdMissing(form)
              const funded = !!form.payment_received_date
              const drawn = !!preview && preview.openAmount > 0
              return (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Into your bank</span>
                    <span className="doc-ref whitespace-nowrap text-[16px] font-bold text-[#0B6B45]">
                      {funded && drawn && preview ? formatINR(preview.receiptAmount) : '—'}
                    </span>
                  </span>
                  {!funded && drawn && (
                    <span className="text-[11px] font-semibold text-[#8CA396]">worked out on Mark payment received</span>
                  )}
                  {miss.length > 0 && (
                    <span title={miss.join(', ')} className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#8A5300] min-[1280px]:hidden">
                      <CircleAlert className="h-4 w-4 shrink-0 text-[#C2700A]" />
                      {miss.length} required
                    </span>
                  )}
                </div>
              )
            })()}
            <div className={cn(__WEB__ && 'ml-auto flex shrink-0 gap-2.5')}>
            <Button
              variant="outline"
              onClick={() => setForm(null)}
              disabled={saving}
              className={cn(__WEB__ && '!h-[42px] !rounded-[8px] !border !border-[#C3D2C6] !bg-white !px-[18px] !text-[12.5px] !font-extrabold !text-[#33473E] hover:!bg-[#F7FAF6]')}
            >
              Cancel
            </Button>
            {/* Greyed while something is missing — the line to the left says
                what. It stays CLICKABLE on the desktop app, whose footer has
                no such line to explain a dead button. */}
            <Button
              className={cn(
                'bg-[#1a2c56] hover:bg-[#24407e]',
                __WEB__ && '!h-[42px] !gap-[7px] !rounded-[8px] !px-[22px] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em]',
                __WEB__ &&
                  (bdMissing(form).length
                    ? '!bg-[#C3D2C6] !text-[#F1F5EF] !opacity-100 hover:!bg-[#C3D2C6]'
                    : '!bg-[#0B3D2E] !text-[#C7F03F] !shadow-[0_8px_18px_-10px_rgba(7,43,32,.8)] hover:!bg-[#0F4A38]')
              )}
              onClick={() => void save()}
              disabled={saving || (__WEB__ && bdMissing(form).length > 0)}
            >
              {__WEB__ && !saving && <Check className="h-[18px] w-[18px]" />}
              {saving ? 'Saving…' : form?.id ? 'Save changes' : 'Discount bill'}
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment IN — the customer's money coming back on a trading bill.
          Mirrors the LC dialog: the receipt is settled against the resale
          invoices it is actually for, biggest first, rather than landing on the
          party's account and leaving the bills open. */}
      <Dialog open={!!payInRow} onOpenChange={(o) => !o && setPayInRow(null)}>
        <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto border-[#d9d2b8] bg-[#fffdf4]">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
            <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
              Payment IN — {payInRow?.bd_no || 'bill'}
            </DialogTitle>
          </DialogHeader>
          {payInRow && (
            <div className="grid gap-4">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                {payInRow.nbfc_name} · funded against {payInRow.party_name}
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <div className="text-muted-foreground">Open amount</div>
                    <div className="font-semibold tabular-nums">{formatINR(payInRow.amount)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Back from customer</div>
                    <div className="font-semibold tabular-nums text-emerald-700">{formatINR(payInRow.payment_in_total)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Receivable from</div>
                    <div className="truncate font-semibold">{payInRow.receivable_party_name || '—'}</div>
                  </div>
                </div>
              </div>

              {payInPlain ? (
                <div className="rounded-md border border-dashed border-[#d9d2b8] px-3.5 py-3 text-[12.5px] text-muted-foreground">
                  {String(payInRow.purpose) === 'trading'
                    ? 'No resale invoice is left to allocate against — either every one is settled, or no purchase invoice is linked to this bill yet. What is recorded below goes against the party instead.'
                    : `Nothing to allocate against on this bill, so the receipt is booked straight against ${payInRow.party_name || 'the party it names'}.`}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1">
                    Which invoices this receipt is for
                    <InfoTip text="The resale invoices behind this bill's trading deal, with what is still owing on each. A receipt is spread across the ticked ones, biggest first." />
                  </Label>
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5">
                    {payInOpen.map((o) => {
                      const key = String(o.key)
                      const on = payInKeys.includes(key)
                      return (
                        <label
                          key={key}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px]',
                            on ? 'bg-emerald-50' : 'hover:bg-muted/40'
                          )}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={on}
                            onChange={(e) => {
                              const next = e.target.checked ? [...payInKeys, key] : payInKeys.filter((x) => x !== key)
                              setPayInKeys(next)
                              // The amount follows the ticks unless it has been
                              // typed over, which is the usual case for a part
                              // receipt against one bill.
                              setPayInAmount(
                                String(round2(payInOpen.filter((x) => next.includes(String(x.key))).reduce((t, x) => t + n(x.due), 0)) || '')
                              )
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {o.invoice_no || key}
                            <span className="ml-1.5 text-muted-foreground">{formatDate(o.sale_date)}</span>
                            {/* Which buyer owes it — a deal resold to several
                                parties has a different debtor behind each
                                number, and the receipt credits that one. */}
                            {!!o.customer_name && (
                              <span className="ml-1.5 text-muted-foreground">&larr; {o.customer_name}</span>
                            )}
                          </span>
                          <span className="shrink-0 font-medium tabular-nums">{formatINR(o.due)}</span>
                        </label>
                      )
                    })}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {payInKeys.length} of {payInOpen.length} ticked · {formatINR(payInDue)} receivable
                  </div>
                </div>
              )}

              {(payInOpen.length > 0 || payInPlain) && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label>Amount received</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        className="tabular-nums"
                        value={payInAmount}
                        onChange={(e) => setPayInAmount(e.target.value)}
                      />
                      {!payInPlain && (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 shrink-0 px-2 text-xs"
                          onClick={() => setPayInAmount(String(payInDue))}
                        >
                          Full
                        </Button>
                      )}
                    </div>
                    {!payInPlain && round2(n(payInAmount)) > 0 && round2(n(payInAmount)) < payInDue && (
                      <div className="text-[11px] text-muted-foreground">
                        Part receipt — {formatINR(round2(payInDue - round2(n(payInAmount))))} would still be receivable.
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Received on</Label>
                    {/* Money already received — today at the latest. */}
                    <DatePicker max={todayISO()} value={payInDate} onChange={(v) => setPayInDate(v || todayISO())} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      How it came in
                      <InfoTip text="The route the money took. It is kept on the receipt and written into the voucher narration, so a line on the bank statement can be matched back to this bill without opening it." />
                    </Label>
                    <Select value={payInMethod} onValueChange={setPayInMethod}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAY_IN_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Received into
                      <InfoTip text="The account the money actually landed in, kept on the bill for reference. A payment in posts no voucher — the bank's own receipt is booked from Tally, and posting another here would count the money twice." />
                    </Label>
                    <Select
                      value={payInAccount || '__none__'}
                      onValueChange={(v) => setPayInAccount(v === '__none__' ? '' : v)}
                    >
                      <SelectTrigger><SelectValue placeholder="Pick the account" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Not stated — book it to BANK A/C</SelectItem>
                        {bankAccounts.map((a) => (
                          <SelectItem key={String(a.id)} value={String(a.name)}>
                            {String(a.name)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Reference no.
                      <InfoTip text="The bank's own number for it — a UTR, a cheque number, a transaction id. This is what the line on the statement is found by, so it goes on the receipt and into the voucher narration." />
                    </Label>
                    <Input
                      value={payInRef}
                      onChange={(e) => setPayInRef(e.target.value)}
                      placeholder="UTR, cheque no., transaction id"
                    />
                  </div>
                </>
              )}

              {payInDone.length > 0 && (
                <div className="rounded-lg border border-[#e5dfc8]">
                  <div className="border-b border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#1a2c56]">
                    Already received · {payInDone.length}
                  </div>
                  <div className="max-h-36 overflow-y-auto">
                    {payInDone.map((rec) => (
                      <div
                        key={String(rec.id)}
                        className="flex items-center gap-2 border-b border-dashed border-[#e5dfc8] px-3 py-1.5 text-xs last:border-b-0"
                      >
                        <span className="tabular-nums text-muted-foreground">{formatDate(rec.pay_date)}</span>
                        <span className="font-semibold tabular-nums">{formatINR(rec.amount)}</span>
                        {/* How this one came. A receipt recorded before the
                            method existed says so rather than borrowing the
                            route of the one beside it. */}
                        <span
                          className={cn(
                            'rounded-[2px] px-1.5 py-[1px] text-[10px] font-bold uppercase tracking-wide',
                            rec.method ? 'bg-[#EAF0E9] text-[#33473E]' : 'bg-[#F1F5EF] text-[#8FA79B]'
                          )}
                        >
                          {String(rec.method || 'not stated')}
                        </span>
                        {/* Which bank took it, and the bank's own number for
                            it. Absent on the receipts recorded before either
                            was asked for, which simply show nothing. */}
                        {!!String(rec.account || '').trim() && (
                          <span
                            className="max-w-[160px] truncate rounded-[2px] bg-[#E9F5EE] px-1.5 py-[1px] text-[10px] font-bold text-[#0B6B45]"
                            title={`Received into ${String(rec.account)}`}
                          >
                            {String(rec.account)}
                          </span>
                        )}
                        {!!String(rec.ref_no || '').trim() && (
                          <span
                            className="max-w-[130px] truncate text-[10px] font-semibold tabular-nums text-[#5A6B62]"
                            title={`Reference ${String(rec.ref_no)}`}
                          >
                            {String(rec.ref_no)}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 w-6 shrink-0 p-0 text-rose-700 hover:bg-rose-50"
                          title="Remove this receipt — its voucher reverses too"
                          onClick={() => void removePayIn(rec)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayInRow(null)} disabled={payInSaving}>
              Close
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={payInSaving || (!payInOpen.length && !payInPlain)}
              onClick={() => void savePayIn()}
            >
              {payInSaving ? 'Saving…' : 'Record receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* POST IT NOW, OR JUST RECORD THAT THE DAYS WERE SERVICED.
          One question, asked once, right where saving would otherwise post
          without asking at all. Either answer records the same interest
          payment and moves the same schedule along — the only thing this
          decides is whether a voucher goes into the books with it today. */}
      <Dialog open={!!intAsk} onOpenChange={(o) => !o && !intBusy && !intBusyUpto && setIntAsk(null)}>
        <DialogContent className="border-[#d6e2d6] bg-white sm:max-w-md">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#0B3D2E] px-6 py-3">
            <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-white">
              Record this interest payment
            </DialogTitle>
          </DialogHeader>
          {intAsk && (
            <div className="grid gap-4">
              <div className="rounded-[4px] border border-[#D6E2D6] bg-[#F7FAF6] px-3.5 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-[.08em] text-[#5A6B62]">
                    {intAsk.days} day{intAsk.days === 1 ? '' : 's'} of interest
                  </span>
                  <span className="text-[16px] font-extrabold tabular-nums text-[#0A1F17]">
                    {formatINR(intAsk.gross)}
                  </span>
                </div>
                {intAsk.tds > 0.004 && (
                  <div className="mt-1.5 flex items-center justify-between text-[11.5px] font-semibold text-[#5A6B62]">
                    <span>TDS withheld</span>
                    <span className="tabular-nums text-[#8C2F26]">{formatINR(intAsk.tds)}</span>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between text-[11.5px] font-semibold text-[#5A6B62]">
                  <span>Out of the bank</span>
                  <span className="tabular-nums text-[#0B6B45]">{formatINR(intAsk.net)}</span>
                </div>
              </div>
              <p className="text-[12.5px] leading-[1.5] text-[#33473E] [text-wrap:pretty]">
                The days are serviced either way, and the schedule moves on. The only choice here is whether the
                voucher above goes onto the ledger right now, or waits until you post it yourself.
              </p>
              <div className="grid gap-2">
                <Button
                  disabled={intBusy || intBusyUpto}
                  onClick={() =>
                    void (intAsk.kind === 'slice' ? payInterest(intAsk.toDate, true) : payInterestUpto(true))
                  }
                  className="!h-[46px] !justify-start !gap-2.5 !rounded-[4px] !bg-[#1A2C56] !px-4 !text-[13px] !font-extrabold !text-white hover:!bg-[#24407e]"
                >
                  <BookOpen className="h-[18px] w-[18px]" />
                  <span className="flex flex-col items-start leading-tight">
                    <span>{intBusy || intBusyUpto ? 'Posting…' : 'Post to the ledger'}</span>
                    <span className="text-[10.5px] font-semibold normal-case text-white/70">
                      The voucher goes in with this payment, today
                    </span>
                  </span>
                </Button>
                <Button
                  variant="outline"
                  disabled={intBusy || intBusyUpto}
                  onClick={() =>
                    void (intAsk.kind === 'slice' ? payInterest(intAsk.toDate, false) : payInterestUpto(false))
                  }
                  className="!h-[46px] !justify-start !gap-2.5 !rounded-[4px] !border-[#C3D2C6] !bg-white !px-4 !text-[13px] !font-extrabold !text-[#33473E] hover:!bg-[#F7FAF6]"
                >
                  <Clock className="h-[18px] w-[18px] text-[#8A5300]" />
                  <span className="flex flex-col items-start leading-tight">
                    <span>{intBusy || intBusyUpto ? 'Recording…' : 'Record without posting'}</span>
                    <span className="text-[10.5px] font-semibold normal-case text-[#5A6B62]">
                      Marks the days serviced; post the voucher later from the schedule
                    </span>
                  </span>
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={intBusy || intBusyUpto} onClick={() => setIntAsk(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RecordHistory target={hist.target} onClose={hist.close} />

      {/* MARK PAYMENT RECEIVED — a side window, like Repay. The middle stage:
          the day the NBFC's money landed (it starts the interest clock and
          posts the disbursement), where it went, and — on a SID into our bank,
          or a PID straight to the supplier — whether it came in one go or in
          parts. Forest, not navy: this is money coming IN. */}
      <Dialog open={!!receiveRow} onOpenChange={(o) => !o && setReceiveRow(null)}>
        <DialogContent
          className={cn(
            'grid max-h-[92vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-[#D6E2D6] bg-[#F1F5EF] p-0 sm:max-w-[560px]',
            '[&>button]:right-5 [&>button]:top-5 [&>button]:text-white [&>button]:opacity-70 [&>button]:hover:opacity-100',
            bdDrawer('!w-[560px]')
          )}
        >
          <DialogHeader className="!m-0 block space-y-0 bg-[#0B3D2E] px-[22px] py-[18px] text-left">
            <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              Bill discounting · {receiveRow?.payment_received_date ? 'payment received' : 'mark received'}
            </div>
            <DialogTitle className="doc-ref mt-1.5 break-all text-[19px] font-bold tracking-[-0.02em] text-white">
              BD {String(receiveRow?.bd_no || '')}
            </DialogTitle>
            {!!receiveRow && (
              <div className="mt-1.5 text-[12.5px] font-semibold text-[#8FBFA8]">
                {String(receiveRow.nbfc_name || 'The NBFC')} · {String(receiveRow.party_name || '—')}
              </div>
            )}
          </DialogHeader>
          {receiveRow &&
            (() => {
              const sid = String(receiveRow.finance_type) === 'SID'
              const pid = String(receiveRow.finance_type) === 'PID'
              const maturity = String(receiveRow.maturity_date || '').slice(0, 10)
              const drawn = n(receiveRow.amount)
              const runDays =
                receiveDate && maturity
                  ? Math.max(0, (daysTo(maturity) ?? 0) - (daysTo(receiveDate) ?? 0) + (receiveRow.days_incl_start ? 1 : 0))
                  : 0
              const rate = n(receiveRow.interest_pct)
              const later = Math.max(0, n(receiveRow.receipt_part_count) - 1)
              const serviced = String(receiveRow.interest_mode || '') === 'serviced'
              const noInvoice = !(n(receiveRow.invoice_amount) > 0)
              const payout = n(receiveRow.receiptAmount)
              const first = n(receiveFirst)
              const lbl = 'text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]'
              const legsHere = receiveLegs && (receiveRoute === 'bank' || !receiveRow.party_in_parts)
              const toSupplier = receiveRoute === 'supplier'
              const daysYear = n(receiveRow.days_year) || 360
              const deducted = !receiveRow.interest_upfront && !serviced
              const billMargin = n(receiveRow.marginAmount)
              const seedLeg = (amount: string): { amount: string; date: string; maturity: string; interest_pct: string; margin_pct: string } => ({
                amount,
                date: receiveDate,
                maturity,
                interest_pct: receiveRow.interest_pct == null ? '' : String(receiveRow.interest_pct),
                margin_pct: receiveRow.margin_pct == null ? '' : String(receiveRow.margin_pct)
              })
              const setLeg = (i: number, patch: Partial<{ amount: string; date: string; maturity: string; interest_pct: string; margin_pct: string }>): void =>
                setLegPlan((p) => p.map((x, k) => (k === i ? { ...x, ...patch } : x)))
              const legsEditor = (): React.JSX.Element => {
                const rows = legPlan.map((l, i) => {
                  const amt = n(l.amount)
                  const on = i === 0 ? receiveDate : String(l.date || '').slice(0, 10)
                  const due = String(l.maturity || '').slice(0, 10)
                  const d = on && due ? Math.max(0, (daysTo(due) ?? 0) - (daysTo(on) ?? 0) + (receiveRow.days_incl_start ? 1 : 0)) : 0
                  const r = String(l.interest_pct).trim() === '' ? rate : n(l.interest_pct)
                  const interest = round2((amt * r * d) / (100 * daysYear))
                  const margin = round2(String(l.margin_pct).trim() === '' ? (drawn > 0 ? (billMargin * amt) / drawn : 0) : (amt * n(l.margin_pct)) / 100)
                  return { l, i, amt, on, d, interest, net: round2(deducted ? amt - interest : amt), margin }
                })
                const got = round2(rows.reduce((s, x) => s + x.amt, 0))
                const left = round2(drawn - got)
                const sum = (k: 'interest' | 'net' | 'margin'): number => round2(rows.reduce((s, x) => s + x[k], 0))
                return (
                  <div className="grid gap-2.5">
                    {rows.map(({ l, i, amt, on, d, interest, net, margin }) => (
                      <div key={i} className="overflow-hidden rounded-[4px] border border-[#D6E2D6]">
                        <div className="flex items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-3 py-1.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0B3D2E] text-[10.5px] font-extrabold text-white">{i + 1}</span>
                          <span className="text-[10.5px] font-extrabold uppercase tracking-[.1em] text-[#0A1F17]">{`${String(receiveRow.bd_no || 'BD')}/R${i + 1}`}</span>
                          {i > 0 && i === legPlan.length - 1 && (
                            <button type="button" onClick={() => setLegPlan((p) => p.slice(0, -1))} className="ml-auto text-[11px] font-bold text-[#B3261E] hover:underline">
                              Remove
                            </button>
                          )}
                        </div>
                        <div className="grid gap-2.5 p-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr))]">
                          <div className="grid content-start gap-1">
                            <span className={lbl}>{toSupplier ? 'Paid on' : 'Landed on'} *</span>
                            {i === 0 ? (
                              <div className="flex h-10 items-center rounded-[4px] border border-[#E4ECE3] bg-[#F7FAF6] px-2.5 text-[12.5px] font-semibold text-[#33473E]" title="Part 1 is the payment received date">
                                {on ? formatDate(on) : '—'}
                              </div>
                            ) : (
                              <DatePicker value={on} min={rows[i - 1]?.on || receiveDate || undefined} max={todayISO()} onChange={(v) => setLeg(i, { date: v })} />
                            )}
                          </div>
                          <div className="grid content-start gap-1">
                            <span className={lbl}>Amount (₹) *</span>
                            <Input type="number" value={l.amount} disabled={i === 0 && later > 0} placeholder="0.00" onChange={(e) => setLeg(i, { amount: e.target.value })} className="h-10 font-bold" />
                          </div>
                          <div className="grid content-start gap-1">
                            <span className={lbl}>Matures on *</span>
                            <DatePicker value={String(l.maturity || '')} min={on || undefined} onChange={(v) => setLeg(i, { maturity: v })} />
                          </div>
                          <div className="grid content-start gap-1">
                            <span className={lbl}>Interest %</span>
                            <Input type="number" value={l.interest_pct} placeholder={String(rate || '')} onChange={(e) => setLeg(i, { interest_pct: e.target.value })} className="h-10" />
                          </div>
                          <div className="grid content-start gap-1">
                            <span className={lbl}>Margin %</span>
                            <Input type="number" value={l.margin_pct} placeholder={String(receiveRow.margin_pct ?? '')} onChange={(e) => setLeg(i, { margin_pct: e.target.value })} className="h-10" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-3 py-1.5 sm:grid-cols-4">
                          {[
                            { k: `Interest · ${d}d`, v: amt > 0 ? interest : 0, tone: 'text-[#B3261E]' },
                            { k: toSupplier ? 'To the supplier' : 'To the bank', v: amt > 0 ? net : 0, tone: 'text-[#0B6B45]' },
                            { k: 'Margin', v: margin, tone: 'text-[#0A1F17]' },
                            { k: 'Days', v: null, tone: '', txt: `${d}` }
                          ].map((c) => (
                            <div key={c.k} className="min-w-0">
                              <div className="truncate text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{c.k}</div>
                              <div className={cn('mt-0.5 truncate text-[12.5px] font-bold tabular-nums', c.tone || 'text-[#0A1F17]')}>{c.v == null ? c.txt : formatINR(c.v)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {left > 0.005 && later === 0 && (
                      <button
                        type="button"
                        onClick={() => setLegPlan((p) => [...p, { ...seedLeg(String(left)), date: p.length > 1 ? String(p[p.length - 1].date || '') : receiveDate, maturity: '' }])}
                        className="flex h-9 items-center justify-center gap-1.5 rounded-[4px] border border-dashed border-[#9DBBA6] bg-white text-[11.5px] font-extrabold uppercase tracking-[.04em] text-[#0B6B45] hover:bg-[#F4FBF6]"
                      >
                        <Plus className="h-4 w-4" /> Add part {legPlan.length + 1}
                      </button>
                    )}
                    {left < -0.005 ? (
                      <div className="text-[12px] font-bold text-[#B3261E]">The parts come to more than the {formatINR(drawn)} drawn</div>
                    ) : (
                      strip([
                        { k: `${legPlan.length} part${legPlan.length === 1 ? '' : 's'}`, v: formatINR(got) },
                        { k: '− Interest', v: formatINR(sum('interest')), tone: 'text-[#B3261E]' },
                        { k: left > 0.005 ? 'Still to come' : 'Margin', v: formatINR(left > 0.005 ? left : sum('margin')), tone: left > 0.005 ? 'text-[#8A5300]' : undefined }
                      ])
                    )}
                    {later > 0 && (
                      <div className="text-[12px] font-semibold text-[#8A5300]">
                        {later} later {later === 1 ? 'part has' : 'parts have'} been recorded — add or take back parts from {toSupplier ? 'Pay party' : 'Receive part'}.
                      </div>
                    )}
                  </div>
                )
              }
              // Two big choices, side by side, that stack on a narrow screen.
              const choice = (
                value: string,
                set: (v: string) => void,
                opts: { k: string; t: string; s: string; off?: boolean }[]
              ): React.JSX.Element => (
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
                  {opts.map((o) => {
                    const on = value === o.k
                    return (
                      <button
                        key={o.k}
                        type="button"
                        disabled={o.off}
                        onClick={() => set(o.k)}
                        className={cn(
                          'min-w-0 rounded-[4px] border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-[13px] font-extrabold">
                          {on && <Check className="h-3.5 w-3.5 text-[#C7F03F]" />}
                          {o.t}
                        </div>
                        <div className={cn('mt-[3px] text-[11px] font-semibold leading-[1.45] [text-wrap:pretty]', on ? 'text-[#8FBFA8]' : 'text-[#5A6B62]')}>
                          {o.s}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
              const section = (icon: React.JSX.Element, title: string, tip: string, body: React.ReactNode, aside?: React.ReactNode): React.JSX.Element => (
                <section className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                    {icon}
                    <span className="text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0B3D2E]">{title}</span>
                    <InfoTip text={tip} />
                    {aside && <span className="ml-auto">{aside}</span>}
                  </div>
                  <div className="grid gap-3 p-4">{body}</div>
                </section>
              )
              const strip = (cells: { k: string; v: string; tone?: string }[]): React.JSX.Element => (
                <div className="grid grid-cols-3 divide-x divide-[#E4ECE3] overflow-hidden rounded-[4px] border border-[#E4ECE3] bg-[#FBFCFA]">
                  {cells.map((c) => (
                    <div key={c.k} className="min-w-0 px-3 py-2">
                      <div className="truncate text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{c.k}</div>
                      <div className={cn('mt-0.5 truncate text-[13px] font-bold tabular-nums', c.tone || 'text-[#0A1F17]')}>{c.v}</div>
                    </div>
                  ))}
                </div>
              )
              return (
                <div className="grid min-h-0 content-start gap-3.5 overflow-y-auto p-[22px]">
                  {/* THE BILL, at a glance. */}
                  <section className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                    <div className={cn('grid grid-cols-2 divide-x divide-y divide-[#E4ECE3] sm:divide-y-0', legsHere ? 'sm:grid-cols-[1.5fr_1fr_.6fr]' : 'sm:grid-cols-[1.5fr_1.1fr_1fr_.6fr]')}>
                      {[
                        { k: 'Open amount', v: formatINR(drawn) },
                        // In parts, each part carries its own maturity below.
                        ...(legsHere ? [] : [{ k: 'Maturity', v: formatDate(maturity) }]),
                        { k: 'Rate', v: rate > 0 ? `${formatNum(rate)}% p.a.` : '—' },
                        { k: 'Type', v: String(receiveRow.finance_type || '—') }
                      ].map((c) => (
                        <div key={c.k} className="min-w-0 px-3.5 py-2.5">
                          <div className={lbl}>{c.k}</div>
                          <div className="mt-1 truncate text-[14px] font-bold tabular-nums text-[#0A1F17]">{c.v}</div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* WHEN IT LANDED. Capped at whichever comes first — the
                      maturity, or today: the money cannot have landed after
                      maturity, and it cannot have landed tomorrow. */}
                  {section(
                    <CalendarRange className="h-4 w-4 text-[#0B6B45]" />,
                    'Payment received on',
                    "The day the NBFC's money actually landed. Interest runs from this date to maturity, and the disbursement — bank debited, margin held, interest taken — posts on it.",
                    <>
                      <DatePicker value={receiveDate} max={!legsHere && maturity && maturity < todayISO() ? maturity : todayISO()} onChange={(v) => setReceiveDate(v)} />
                      {receiveDate && maturity && !legsHere && (
                        <div className="text-[12px] font-semibold text-[#5A6B62]">
                          Interest runs <b className="text-[#0A1F17]">{runDays} days</b> to {formatDate(maturity)}.
                        </div>
                      )}
                    </>
                  )}

                  {/* WHERE THE MONEY WENT. Decides the voucher: into our bank it
                      is a Receipt there; straight to the supplier (PID) it is a
                      Journal that settles the supplier, with no bank line. */}
                  {section(
                    <Landmark className="h-4 w-4 text-[#0B6B45]" />,
                    'Disbursement paid to',
                    "Where the NBFC's money went. Our bank: the disbursement posts as a receipt into the account you pick. Supplier direct (PID only): the NBFC paid the supplier for you, so it posts as a journal that settles the supplier and never touches your bank.",
                    <>
                      {pid &&
                        choice(receiveRoute, (v) => setReceiveRoute(v as 'bank' | 'supplier'), [
                          { k: 'bank', t: 'Our bank', s: 'It landed in one of our accounts' },
                          { k: 'supplier', t: 'Supplier direct', s: `The NBFC paid ${String(receiveRow.party_name || 'the supplier')} for us` }
                        ])}
                      {receiveRoute === 'bank' ? (
                        <div className="grid gap-1.5">
                          <span className={lbl}>Into the bank *</span>
                          <Select value={receiveAccount} onValueChange={setReceiveAccount}>
                            <SelectTrigger className="h-11 rounded-[4px] border-[#C3D2C6] bg-white px-[11px] text-[13px] font-bold !normal-case text-[#0A1F17] [&>span]:flex-1 [&>span]:!text-left">
                              <SelectValue placeholder="Pick the bank the money landed in" />
                            </SelectTrigger>
                            <SelectContent>
                              {formBanks.map((a) => (
                                <SelectItem key={String(a.id)} value={String(a.name)}>
                                  {String(a.name)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <div className="rounded-[4px] border border-dashed border-[#C3D2C6] bg-[#FBFCFA] px-3 py-2.5 text-[12px] font-semibold text-[#5A6B62]">
                          Posts as a journal: {String(receiveRow.party_name || 'the supplier')} is debited with what the NBFC paid, against the NBFC&rsquo;s payable. No bank entry.
                        </div>
                      )}
                    </>
                  )}

                  {/* RECEIVED IN PARTS (SID): the NBFC released only some of the
                      draw on this date. Interest is worked leg by leg — each
                      part from the day it landed to maturity. */}
                  {receiveRoute === 'bank' &&
                    section(
                      <Banknote className="h-4 w-4 text-[#0B6B45]" />,
                      'Received from the NBFC',
                      'In full: the whole draw landed on this date. In parts: list every part — the day it landed, its amount, its own maturity, interest % and margin % (blank = the bill\'s). Each part gets its own reference (GB10/R1, R2…) and its own voucher on its own day; more can be added later from Receive part.',
                      serviced || noInvoice ? (
                        <div className="text-[12px] font-semibold text-[#5A6B62]">
                          {serviced
                            ? 'Interest on this bill is serviced month by month, so it is received in one go.'
                            : 'Enter the invoice amount on the bill first — receiving in parts needs it.'}
                        </div>
                      ) : (
                        <>
                          {choice(receiveLegs ? 'parts' : 'full', (v) => {
                            if (later > 0) return
                            setReceiveLegs(v === 'parts')
                            if (v === 'parts' && !legPlan.length) setLegPlan([seedLeg('')])
                          }, [
                            { k: 'full', t: 'In full', s: `The whole ${formatINR(drawn)} landed on this date`, off: later > 0 },
                            { k: 'parts', t: 'In parts', s: 'Each part with its own day, maturity, interest % and margin %' }
                          ])}
                          {receiveLegs && legsEditor()}
                        </>
                      ),
                      receiveRow.receipt_in_parts ? (
                        <span className="rounded-[2px] border border-[#BFE3CB] bg-[#F4FBF6] px-[7px] py-0.5 text-[10.5px] font-bold text-[#0B6B45]">
                          {n(receiveRow.receipt_part_count)} {n(receiveRow.receipt_part_count) === 1 ? 'part' : 'parts'} so far
                        </span>
                      ) : undefined
                    )}

                  {/* PAID IN PARTS (PID): the NBFC released only some of it to
                      the supplier on this date; the rest follows from Pay party. */}
                  {receiveRoute === 'supplier' &&
                    section(
                      <Users className="h-4 w-4 text-[#0B6B45]" />,
                      'Paid to the supplier',
                      'Paid in full: the whole payout reaches the supplier on this date. In parts: only the first part does — record each later part from Pay party, on the day the NBFC pays it. Interest, margin and charges are taken once, with the first part.',
                      !receiveRow.party_in_parts ? (
                        serviced || noInvoice ? (
                          <div className="text-[12px] font-semibold text-[#5A6B62]">
                            {serviced
                              ? 'Interest on this bill is serviced month by month, so it is paid in one go.'
                              : 'Enter the invoice amount on the bill first — paying in parts needs it.'}
                          </div>
                        ) : (
                          <>
                            {choice(receiveLegs ? 'parts' : 'full', (v) => {
                              if (later > 0) return
                              setReceiveLegs(v === 'parts')
                              if (v === 'parts' && !legPlan.length) setLegPlan([seedLeg('')])
                            }, [
                              { k: 'full', t: 'Paid in full', s: `The whole ${formatINR(payout)} reaches the supplier now`, off: later > 0 },
                              { k: 'parts', t: 'In parts', s: 'Each part with its own day, maturity, interest % and margin %' }
                            ])}
                            {receiveLegs && legsEditor()}
                          </>
                        )
                      ) : (
                      <>
                        {choice(receiveParts ? 'parts' : 'full', (v) => setReceiveParts(v === 'parts'), [
                          { k: 'full', t: 'Paid in full', s: `The whole ${formatINR(payout)} reaches the supplier now` },
                          { k: 'parts', t: 'In parts', s: 'Only the first part now — the rest from Pay party' }
                        ])}
                        {receiveParts && (
                          <>
                            <div className="grid gap-1.5">
                              <span className={lbl}>First part paid on this date (₹) *</span>
                              <Input type="number" value={receiveFirst} placeholder="0.00" onChange={(e) => setReceiveFirst(e.target.value)} className="h-11 text-[14px] font-bold" />
                            </div>
                            {first > payout + 0.005 ? (
                              <div className="text-[12px] font-bold text-[#B3261E]">More than the {formatINR(payout)} payout</div>
                            ) : (
                              strip([
                                { k: 'Payout', v: formatINR(payout) },
                                { k: 'First part', v: formatINR(first), tone: 'text-[#0B6B45]' },
                                { k: 'Left for later', v: formatINR(Math.max(0, payout - first)), tone: 'text-[#8A5300]' }
                              ])
                            )}
                          </>
                        )}
                      </>
                      )
                    )}
                </div>
              )
            })()}
          {/* Pinned at the foot, where a drawer's actions belong. */}
          <DialogFooter className="!m-0 flex flex-wrap items-center gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5 sm:justify-start">
            {!!receiveRow && (
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[12px] font-semibold text-[#5A6B62]">
                <Banknote className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                <span className="min-w-0 [text-wrap:pretty]">
                  {receiveRoute === 'supplier'
                    ? `A journal to ${String(receiveRow.party_name || 'the supplier')} on ${formatDate(receiveDate)}`
                    : `A receipt into ${receiveAccount || 'the bank'} on ${formatDate(receiveDate)}`}
                </span>
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setReceiveRow(null)} disabled={receiveSaving}>
                Cancel
              </Button>
              <Button className="bg-[#0B3D2E] font-bold text-[#C7F03F] hover:bg-[#0F4A38]" onClick={() => void saveReceive()} disabled={receiveSaving}>
                {receiveSaving ? 'Saving…' : receiveRow?.payment_received_date ? 'Save' : 'Mark received'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BdPartyPayments row={partyRow} onClose={() => setPartyRow(null)} onChanged={async () => { await load() }} />
      <BdReceiptParts row={legsRow} banks={formBanks} onClose={() => setLegsRow(null)} onChanged={async () => { await load() }} />

      {/* Repay dialog */}
      <Dialog open={!!repayRow} onOpenChange={(o) => !o && setRepayRow(null)}>
        <DialogContent className={cn('border-[#d9d2b8] bg-[#fffdf4]', bdDrawer('!w-[920px]'))}>
          <DialogHeader
            className={cn(
              '-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5',
              // NAVY, NOT FOREST. Repaying is money going back out, and the
              // canvas marks that side of the ledger in the blue the register
              // already uses for what is owed — so opening this panel reads as
              // a different act from raising the bill, not a variation of it.
              __WEB__ && '!m-0 !block !space-y-0 !rounded-none !bg-[#1A2C56] !px-[22px] !py-[18px] !text-left'
            )}
          >
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#A9C8EA]">
                Bill discounting · repay
              </div>
            )}
            <DialogTitle
              className={cn(
                'text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]',
                __WEB__ && '!doc-ref !mt-1.5 !break-all !text-[19px] !font-bold !normal-case !tracking-[-0.02em] !text-white'
              )}
            >
              {__WEB__ ? `BD ${repayRow?.bd_no || ''}`.trim() : `Repay ${repayRow?.bd_no || 'bill'}`}
            </DialogTitle>
            {__WEB__ && !!repayRow && (
              <div className="mt-1.5 text-[12.5px] font-semibold text-[#A9C8EA]">
                {formatINR(dueOn(repayRow))} outstanding to {repayRow.nbfc_name || 'the NBFC'}
              </div>
            )}
          </DialogHeader>
          {repayRow && (
            <div
              className={cn(
                'grid gap-4',
                __WEB__ && cn(BD_FIELDS, '!p-[22px]')
              )}
            >
              {/* WHICH PAYMENT THIS IS.
                  The principal and the interest are two different journals
                  against two different accounts, so the panel asks outright
                  rather than working it out from which boxes get filled in.
                  Auto-fit rather than two fixed columns: on a narrow drawer
                  the two cards stack instead of squeezing their own captions
                  to three words a line. */}
              {__WEB__ && (
                <section className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                  <div className="grid gap-2 p-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
                    {([
                      { k: 'full', t: 'Full repayment', s: 'The money itself, back to the NBFC' },
                      { k: 'interest', t: 'Interest repayment', s: 'The cost of having had it' }
                    ] as const).map((o) => {
                      const on = repayKind === o.k
                      return (
                        <button
                          key={o.k}
                          type="button"
                          onClick={() => setRepayKind(o.k)}
                          className={cn(
                            'min-w-0 rounded-[4px] border px-3.5 py-3 text-left transition-colors',
                            on
                              ? 'border-[#1A2C56] bg-[#1A2C56] text-white'
                              : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                          )}
                        >
                          <div className="text-[13px] font-extrabold">{o.t}</div>
                          <div
                            className={cn(
                              'mt-[3px] text-[11px] font-semibold leading-[1.45] [text-wrap:pretty]',
                              on ? 'text-[#A9C8EA]' : 'text-[#5A6B62]'
                            )}
                          >
                            {o.s}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}
              {/* FROM WHICH BANK. A repayment settled against the party moves
                  no money of ours, so it is only asked when a bank is paying. */}
              {!(repayKind === 'full' && repayForm.settle_via === 'party') && (
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1">
                    From bank
                    <InfoTip text="The account the money leaves from. Left on the bill's own bank, it goes through the account the disbursement came into. It can be changed later from the bill's detail — Bank." />
                  </Label>
                  <Select value={repayBank} onValueChange={setRepayBank}>
                    <SelectTrigger className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__bill">
                        The bill&rsquo;s bank{repayRow.disbursement_account ? ` — ${String(repayRow.disbursement_account)}` : ''}
                      </SelectItem>
                      {formBanks.map((a) => (
                        <SelectItem key={String(a.id)} value={String(a.name)}>
                          {String(a.name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* INTEREST, UP TO A DATE — built to the Treasury canvas.
                  Interest runs day by day, so paying it is always "settle
                  everything up to here" and never "pay for a day". One floor,
                  one ceiling, both stated on the form and both refused by the
                  server: it cannot start before the money landed (or the day
                  after the last payment ran to), and it cannot reach into days
                  that have not happened. */}
              {__WEB__ && repayKind === 'interest' && (
                <section className="overflow-hidden rounded-[4px] border border-[#C6DAF0] bg-white">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-b-[#C6DAF0] bg-[#EAF0FA] px-4 py-3">
                    <Percent className="h-[17px] w-[17px] text-[#1A2C56]" />
                    <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#1A2C56]">
                      Interest paid up to
                    </span>
                    {!!intWin && n(intWin.paid_count) > 0 && (
                      <span className="doc-ref ml-auto whitespace-nowrap rounded-[2px] border border-[#C6DAF0] bg-white px-[7px] py-0.5 text-[10.5px] font-bold text-[#1B4E82]">
                        {formatINR(intWin.paid_total)} paid · to {formatDate(String(intWin.paid_to))}
                      </span>
                    )}
                  </div>

                  {intWin?.blocked ? (
                    // The fact first, in the ink of a warning; the reason and
                    // the way round it underneath, in ordinary type. Read in
                    // that order it takes a second — which is all somebody
                    // wants from a panel that has nothing for them to do.
                    <div className="flex items-start gap-2.5 p-4">
                      <CircleAlert className="mt-[1px] h-[17px] w-[17px] shrink-0 text-[#C2700A]" />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-extrabold text-[#8A5300] [text-wrap:pretty]">
                          {String(intWin.blocked)}
                        </div>
                        {!!intWin.blocked_note && (
                          <div className="mt-[3px] text-[12px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                            {String(intWin.blocked_note)}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="p-4">
                      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,195px),1fr))]">
                        <div className="min-w-0">
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Paid up to <span className="text-[#B3261E]">*</span>
                          </div>
                          <input
                            type="date"
                            value={intDate}
                            min={String(intWin?.min_date || '')}
                            max={String(intWin?.max_date || '')}
                            onChange={(e) => {
                              setIntDate(e.target.value)
                              if (repayRow && e.target.value) void loadIntWindow(Number(repayRow.id), e.target.value)
                            }}
                            className="doc-ref h-[42px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] text-[13px] font-bold text-[#0A1F17] outline-none focus:border-[#1A2C56]"
                          />
                          {/* The window in words as well as in the picker's own
                              limits: a greyed-out day says it cannot be chosen
                              and never says why. */}
                          <div className="mt-1.5 text-[11px] font-semibold leading-[1.45] text-[#5A6B62] [text-wrap:pretty]">
                            {intWin?.first
                              ? `Anything from ${formatDate(String(intWin?.min_date))}, the day this bill was funded, up to today.`
                              : `Settled to ${formatDate(String(intWin?.paid_to))}, so this one runs from ${formatDate(String(intWin?.min_date))} up to today.`}
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Days
                          </div>
                          <div className="doc-ref flex h-[42px] items-center rounded-[4px] border border-[#DCE7DB] bg-[#F7FAF6] px-[11px] text-[13px] font-bold text-[#33473E]">
                            {formatNum(n(intWin?.days))} day{n(intWin?.days) === 1 ? '' : 's'}
                          </div>
                          <div className="doc-ref mt-1.5 text-[11px] font-semibold text-[#5A6B62]">
                            {formatDate(String(intWin?.from_date))} → {formatDate(intDate)}
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Interest
                          </div>
                          <div className="doc-ref flex h-[42px] items-center rounded-[4px] border border-[#F0D6D4] bg-[#FDF8F7] px-[11px] text-[13px] font-bold text-[#8C2F26]">
                            {formatINR(n(intWin?.gross))}
                          </div>
                          <div className="mt-1.5 text-[11px] font-semibold leading-[1.45] text-[#5A6B62] [text-wrap:pretty]">
                            {formatNum(n(intWin?.interest_pct))}% on {formatINR(n(intWin?.open_amount))} ·{' '}
                            {formatNum(n(intWin?.days_year))}-day year
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Out of the bank
                          </div>
                          <div className="doc-ref flex h-[42px] items-center rounded-[4px] border border-[#BFE3CB] bg-[#F4FBF6] px-[11px] text-[13px] font-bold text-[#0B6B45]">
                            {formatINR(n(intWin?.net))}
                          </div>
                          <div className="mt-1.5 text-[11px] font-semibold leading-[1.45] text-[#5A6B62] [text-wrap:pretty]">
                            {n(intWin?.tds) > 0.004
                              ? `${formatINR(n(intWin?.tds))} TDS withheld at ${formatNum(n(intWin?.tds_pct))}%`
                              : 'no TDS on this bill'}
                          </div>
                        </div>
                      </div>

                      {/* THE VOUCHER, BEFORE IT IS POSTED.
                          Ruled as a journal is ruled — account, debit, credit —
                          rather than as a list with Dr and Cr written into the
                          words. Three lines is the whole of it, and seeing them
                          in the shape they will take in the ledger is what
                          makes the button safe to press. */}
                      <div className="mt-[15px] overflow-hidden rounded-[4px] border border-[#E4ECE3]">
                        <div className="grid grid-cols-[minmax(0,1fr)_120px_120px] gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3 py-2">
                          <span className="text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            What posts
                          </span>
                          <span className="text-right text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Debit
                          </span>
                          <span className="text-right text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                            Credit
                          </span>
                        </div>
                        {orderVoucherLines([
                          { k: 'Interest on bill discounting', d: n(intWin?.gross), c: 0 },
                          ...(n(intWin?.tds) > 0.004
                            ? [{ k: 'TDS on interest payable', d: 0, c: n(intWin?.tds) }]
                            : []),
                          { k: 'Bank', d: 0, c: n(intWin?.net) }
                        ] as { k: string; d: number; c: number }[], (l) => ({ account: l.k, dr: l.d > 0, tax: TAX_NAME.test(l.k), amount: l.d || l.c })).map((l) => (
                          <div
                            key={l.k}
                            className="grid grid-cols-[minmax(0,1fr)_120px_120px] gap-2.5 border-b border-b-[#EFF3EE] px-3 py-[9px] last:border-b-0"
                          >
                            <span className="min-w-0 text-[12px] font-bold text-[#0A1F17] [text-wrap:pretty]">{l.k}</span>
                            <span className="doc-ref text-right text-[12.5px] font-bold text-[#8C2F26]">
                              {l.d ? formatINR(l.d) : ''}
                            </span>
                            <span className="doc-ref text-right text-[12.5px] font-bold text-[#0B6B45]">
                              {l.c ? formatINR(l.c) : ''}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="mt-3.5 flex flex-wrap items-center gap-3">
                        <span className="min-w-0 flex-1 text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                          The principal is untouched — this is the cost of the money, not the money.
                        </span>
                        <Button
                          disabled={intBusyUpto || !intDate || !(n(intWin?.gross) > 0.004)}
                          onClick={() =>
                            setIntAsk({
                              kind: 'upto',
                              gross: n(intWin?.gross),
                              tds: n(intWin?.tds),
                              net: n(intWin?.net),
                              days: n(intWin?.days)
                            })
                          }
                          className="!h-[46px] !flex-none !gap-2 !rounded-[4px] !bg-[#1A2C56] !px-5 !text-[13px] !font-extrabold !text-white hover:!bg-[#24407e]"
                        >
                          <Percent className="h-[18px] w-[18px]" />
                          {intBusyUpto ? 'Paying…' : `Pay ${formatINR(n(intWin?.gross))}`}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}
              {/* WHERE THE BILL STANDS, as three rows rather than three
                  columns of small print. Each figure gets a line of its own
                  and its own tint — what was borrowed, what has gone back,
                  what is left — and the bar underneath says the same thing
                  again in one glance, with this payment shown against what
                  was already repaid. */}
              {__WEB__ ? (() => {
                const bill = n(repayRow.amount)
                const paid = n(repayRow.repaid_total)
                const due = dueOn(repayRow)
                const now = Math.max(0, Math.min(due, round2(n(repayForm.amount))))
                const pct = (x: number): string => `${bill > 0 ? Math.max(0, Math.min(100, (x / bill) * 100)) : 0}%`
                return (
                  <section className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                    <div className="flex flex-col gap-2.5 px-4 py-3.5">
                      <div className="text-[12.5px] font-extrabold text-[#33473E] [text-wrap:pretty]">
                        {repayRow.nbfc_name} · {repayRow.party_name}
                      </div>
                      {([
                        { k: 'Bill', v: bill, bg: 'bg-[#F7FAF6]', bd: 'border-[#E4ECE3]', fg: 'text-[#0A1F17]', kf: 'text-[#5A6B62]' },
                        { k: 'Repaid', v: paid, bg: 'bg-[#F4FBF6]', bd: 'border-[#BFE3CB]', fg: 'text-[#0B6B45]', kf: 'text-[#0B6B45]' },
                        { k: 'Outstanding', v: due, bg: 'bg-[#EAF0FA]', bd: 'border-[#C6DAF0]', fg: 'text-[#1B4E82]', kf: 'text-[#1B4E82]' }
                      ] as Row[]).map((r) => (
                        <div
                          key={String(r.k)}
                          className={cn('flex items-baseline justify-between gap-3 rounded-[4px] border px-3 py-2.5', String(r.bg), String(r.bd))}
                        >
                          <span className={cn('text-[9.5px] font-extrabold uppercase tracking-[.11em]', String(r.kf))}>
                            {String(r.k)}
                          </span>
                          <span className={cn('doc-ref shrink-0 whitespace-nowrap text-[15px] font-bold tracking-[-0.02em]', String(r.fg))}>
                            {formatINR(Number(r.v))}
                          </span>
                        </div>
                      ))}
                      <div className="flex h-2 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                        <span className="h-full bg-[#12855A]" style={{ width: pct(paid) }} />
                        <span className="h-full bg-[#A9C8EA]" style={{ width: pct(now) }} />
                      </div>
                      <span className="text-[11.5px] font-bold text-[#5A6B62] [text-wrap:pretty]">
                        {now <= 0
                          ? 'Enter what is going back.'
                          : now >= due - 0.004
                            ? 'This payment clears the bill.'
                            : `${formatINR(round2(due - now))} would still be outstanding after this.`}
                      </span>
                    </div>
                  </section>
                )
              })() : (
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                {repayRow.nbfc_name} · {repayRow.party_name}
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <div className="text-muted-foreground">Bill</div>
                    <div className="font-semibold tabular-nums">{formatINR(repayRow.amount)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Repaid</div>
                    <div className="font-semibold tabular-nums text-emerald-700">{formatINR(repayRow.repaid_total)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Outstanding</div>
                    <div className="font-semibold tabular-nums text-[#1a2c56]">{formatINR(dueOn(repayRow))}</div>
                  </div>
                </div>
              </div>
              )}
              {/* THE PRINCIPAL'S OWN FIELDS.
                  Shown only when that is what is being paid: an amount, a
                  settlement route and a margin release have no meaning on an
                  interest payment, and leaving them on screen would invite
                  somebody to fill them in and wonder why nothing happened. */}
              {(!__WEB__ || repayKind === 'full') && (
              <>
              {/* A discounted bill is often taken back in instalments, so the
                  amount is asked for rather than assumed. It opens on the whole
                  balance — the ordinary case — and Full balance puts it back. */}
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Amount being repaid
                  <InfoTip text="Pay the bill off in one go, or a part of it. Anything less than the outstanding balance leaves the bill open for the rest, and each part posts its own dated voucher." />
                </Label>
                {/* FULL BALANCE, INSIDE THE FIELD IT FILLS.
                    It was a rounded 36px button standing beside a 44px box —
                    two different objects on one line, neither the size of the
                    other. It belongs IN the field: it is not a second thing to
                    do, it is a shortcut for typing the figure, and putting it
                    where that figure goes says so. Square, like every other
                    chip on this page.

                    It also answers as well as acts: once the field holds the
                    whole balance the chip says so in the affirmative rather
                    than sitting there inviting a click that changes nothing. */}
                {(() => {
                  const due = dueOn(repayRow)
                  const isFull = due > 0 && Math.abs(round2(n(repayForm.amount)) - round2(due)) < 0.005
                  const input = (
                    <Input
                      type="number"
                      step="0.01"
                      data-raw={__WEB__ ? '' : undefined}
                      className={cn('tabular-nums', __WEB__ && cn(FIELD_FIG, FIELD_BARE))}
                      value={repayForm.amount ?? ''}
                      onChange={(e) => setRepayForm((p) => ({ ...p, amount: e.target.value }))}
                    />
                  )
                  if (!__WEB__)
                    return (
                      <div className="flex items-center gap-2">
                        {input}
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 shrink-0 px-2 text-xs"
                          onClick={() => setRepayForm((p) => ({ ...p, amount: String(due) }))}
                        >
                          Full balance
                        </Button>
                      </div>
                    )
                  return (
                    <div className={FIELD_WRAP}>
                      {input}
                      <button
                        type="button"
                        title={isFull ? 'The whole outstanding balance' : `Fill in the whole ${formatINR(due)} outstanding`}
                        onClick={() => setRepayForm((p) => ({ ...p, amount: String(due) }))}
                        className={cn('ml-2', CHIP_BTN, isFull ? CHIP_BTN_DONE : CHIP_BTN_PLAIN)}
                      >
                        {isFull ? <Check className="h-3.5 w-3.5" /> : null}
                        Full balance
                      </button>
                    </div>
                  )
                })()}
                {round2(n(repayForm.amount)) > 0 && round2(n(repayForm.amount)) < dueOn(repayRow) && (
                  <div className="text-[11px] text-muted-foreground">
                    Part payment — {formatINR(round2(dueOn(repayRow) - round2(n(repayForm.amount))))} would still be outstanding,
                    and the bill stays open for it.
                  </div>
                )}
                {/* WHAT THE BANK TOOK ON TOP.
                    The NBFC's commission and the bank's charges come out of
                    the SAME debit as the principal — one line on the
                    statement, larger than the bill. They had nowhere to go, so
                    the real figure was refused as "more than the bill is for"
                    and the charges never reached the books. They are this
                    event's cost, not part of what was borrowed, so the
                    principal above stays the principal and these ride beside
                    it. */}
                <div className="mt-1 flex flex-col gap-2">
                  <div className="flex flex-col gap-1">

                    <Label className="flex items-center gap-1 text-[11px]">

                      Interest

                      <InfoTip text="Interest the NBFC took in this same debit — gross. It posts to Interest on Bill Discounting on the repayment voucher, so the bank shows one line for the whole debit, as on the statement. TDS on it is entered separately, as before." />

                    </Label>

                    <Input

                      type="number"

                      step="0.01"

                      className="h-8 tabular-nums"

                      placeholder="0.00"

                      value={repayForm.interest ?? ''}

                      onChange={(e) => setRepayForm((p) => ({ ...p, interest: e.target.value }))}

                    />

                  </div>
                  {/* ANY OTHER CHARGE IN THE SAME DEBIT, ON ITS OWN LEDGER.
                      Commission, bank charges, processing fee, stamp duty —
                      one row each, so every rupee lands on the ledger it
                      belongs to rather than being lumped together. */}
                  <Label className="text-[11px]">Charges in this debit</Label>
                  <ChargeRows value={repayCharges} onChange={setRepayCharges} companyId={Number(repayRow?.company_id) || undefined} excess={round2(spill - n(repayForm.interest) - alsoTotal)} />
                </div>
                {/* MORE THAN THIS BILL OWES, AND WHERE THE REST WENT.
                    One transfer settles several bills more often than it
                    settles exactly one. Typed over this bill's outstanding,
                    the figure becomes the whole debit and the excess has to be
                    accounted for before it can be saved — to the charges, or
                    to another of this NBFC's bills. */}
                {spill > 0.004 && (
                  <div className="overflow-hidden rounded-[4px] border border-[#F0D9AE] bg-[#FFFBF2]">
                    <div className="flex flex-wrap items-center gap-2 border-b border-b-[#F0D9AE] px-3.5 py-2.5">
                      <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#8A5300]">
                        {formatINR(spill)} over this bill
                      </span>
                      <span
                        className={cn(
                          'ml-auto rounded-[3px] px-2 py-[2px] text-[11px] font-extrabold',
                          Math.abs(unallocated) < 0.005
                            ? 'bg-[#E9F5EE] text-[#0B6B45]'
                            : 'bg-[#FDECEA] text-[#B3261E]'
                        )}
                      >
                        {Math.abs(unallocated) < 0.005
                          ? 'all accounted for'
                          : unallocated > 0
                            ? `${formatINR(unallocated)} still to account for`
                            : `${formatINR(-unallocated)} over-allocated`}
                      </span>
                    </div>
                    <div className="px-3.5 py-3">
                      <div className="mb-2 text-[11.5px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                        {formatINR(round2(n(repayForm.amount)))} is leaving the bank.{' '}
                        {formatINR(round2(Math.min(n(repayForm.amount), dueOn(repayRow))))} clears this bill; put the
                        rest against the interest or a ledger above, or against another bill with {repayRow.nbfc_name || 'this NBFC'}.
                      </div>
                      {repayAlso.map((a, i) => {
                        const chosen = otherOpenBds.find((b) => String(b.id) === String(a.bd_id))
                        // A BILL ALREADY PICKED ON ANOTHER ROW IS NOT AN
                        // OPTION HERE.
                        //
                        // Two rows both claiming the same bill would let one
                        // debit “clear” it twice — the same bill outstanding
                        // once but named as settled twice over. So each row
                        // offers every other open bill EXCEPT the ones the
                        // other rows have already claimed; its own current
                        // pick stays in its own list so re-opening it still
                        // shows what is chosen.
                        const takenElsewhere = new Set(
                          repayAlso.filter((_, j) => j !== i).map((x) => String(x.bd_id)).filter(Boolean)
                        )
                        const pickable = otherOpenBds.filter((b) => !takenElsewhere.has(String(b.id)))
                        return (
                          <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
                            <Select
                              value={a.bd_id}
                              onValueChange={(v2) =>
                                setRepayAlso((p) =>
                                  p.map((x, j) =>
                                    j === i
                                      ? {
                                          bd_id: v2,
                                          amount:
                                            x.amount ||
                                            String(dueOn(otherOpenBds.find((b) => String(b.id) === v2) || {}))
                                        }
                                      : x
                                  )
                                )
                              }
                            >
                              <SelectTrigger className="h-9 min-w-[260px] flex-1 text-[12.5px]">
                                <SelectValue placeholder="Pick another bill this debit cleared" />
                              </SelectTrigger>
                              <SelectContent>
                                {pickable.length === 0 && (
                                  <div className="px-3 py-2 text-[12px] text-muted-foreground">
                                    {otherOpenBds.length === 0
                                      ? 'No other open bill with this NBFC'
                                      : 'Every other open bill is already picked on another row'}
                                  </div>
                                )}
                                {pickable.map((b) => (
                                  <SelectItem key={String(b.id)} value={String(b.id)}>
                                    <span className="flex w-full items-center gap-2">
                                      <span className="font-bold">{String(b.bd_no || b.id)}</span>
                                      <span className="text-[11px] text-muted-foreground">
                                        opened {formatDate(String(b.payment_received_date || b.bd_date || ''))}
                                      </span>
                                      <span className="ml-auto font-bold tabular-nums">{formatINR(dueOn(b))}</span>
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              step="0.01"
                              className="h-9 w-[150px] text-right tabular-nums"
                              placeholder="0.00"
                              value={a.amount}
                              onChange={(e) =>
                                setRepayAlso((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                              }
                            />
                            {!!chosen && round2(n(a.amount)) - dueOn(chosen) > 0.004 && (
                              <span className="text-[11px] font-bold text-[#B3261E]">
                                only {formatINR(dueOn(chosen))} outstanding
                              </span>
                            )}
                            <button
                              type="button"
                              title="Remove this bill"
                              onClick={() => setRepayAlso((p) => p.filter((_, j) => j !== i))}
                              className="flex h-9 w-9 items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        )
                      })}
                      <div className="flex flex-wrap gap-2">
                        {/* ONCE THE OVER-PAYMENT IS FULLY ACCOUNTED FOR, THERE IS
                            NOTHING LEFT TO PUT AGAINST ANOTHER BILL.
                            A row with no rupees to carry names a bill for no
                            reason — the button stops offering one the moment
                            the figure above reads “all accounted for”, and
                            says why rather than just going quiet. */}
                        <Button
                          type="button"
                          variant="outline"
                          disabled={unallocated <= 0.004 || (otherOpenBds.length > 0 && pickableAtEnd.length === 0)}
                          title={
                            unallocated <= 0.004
                              ? 'The whole over-payment is already accounted for'
                              : otherOpenBds.length > 0 && pickableAtEnd.length === 0
                                ? 'Every open bill with this NBFC is already picked'
                                : undefined
                          }
                          className="!h-9 !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold disabled:!cursor-not-allowed disabled:!opacity-50"
                          onClick={() => setRepayAlso((p) => [...p, { bd_id: '', amount: '' }])}
                        >
                          <Plus className="h-4 w-4" /> Another bill this debit cleared
                        </Button>
                        {unallocated > 0.004 && (otherOpenBds.length === 0 || pickableAtEnd.length === 0) && (
                          <span className="basis-full text-[11px] font-semibold text-[#8A5300]">
                            {otherOpenBds.length === 0
                              ? `${repayRow.nbfc_name || 'This NBFC'} has no other open bill`
                              : `Every open bill with ${repayRow.nbfc_name || 'this NBFC'} is already on a row`}{' '}
                            — split the {formatINR(unallocated)} across the interest and as many ledgers as you need, or
                            lower the amount being repaid.
                          </span>
                        )}
                        {unallocated > 0.004 && (
                          <Button
                            type="button"
                            variant="outline"
                            className="!h-9 !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
                            onClick={() =>
                              setRepayForm((p) => ({
                                ...p,
                                interest: String(round2(n(p.interest) + unallocated))
                              }))
                            }
                          >
                            Put the {formatINR(unallocated)} on interest
                          </Button>
                        )}
                        {unallocated > 0.004 && (
                          <Button
                            type="button"
                            variant="outline"
                            className="!h-9 !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
                            onClick={() =>
                              setRepayCharges((p) => [...p, { account: '', amount: String(unallocated) }])
                            }
                          >
                            Put the {formatINR(unallocated)} on a ledger
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {spill <= 0.004 && (chargesTotal > 0 || n(repayForm.interest) > 0) && (
                  <div className="rounded-[4px] border border-[#C6DAF0] bg-[#F4F8FD] px-3 py-2 text-[11.5px] text-[#1B4E82]">
                    <b>
                      {formatINR(round2(n(repayForm.amount) + chargesTotal + n(repayForm.interest)))}
                    </b>{' '}
                    leaves the account — {formatINR(round2(n(repayForm.amount)))} off the bill
                    {n(repayForm.interest) > 0 ? `, ${formatINR(round2(n(repayForm.interest)))} as interest` : ''}
                    {chargesTotal > 0 ? `, ${formatINR(chargesTotal)} as charges` : ''}
                    . Match this against the debit on the statement.
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Repay date</Label>
                {/* Money already gone back — today at the latest. */}
                <DatePicker
                  max={todayISO()}
                  value={String(repayForm.repay_date || '')}
                  onChange={(v) => setRepayForm((p) => ({ ...p, repay_date: v }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Settle through
                  <InfoTip text="Through the bank posts the payment straight out of your own account. Against the party settles it on their ledger instead — bill-wise if you name a bill reference, or On Account if you leave it blank." />
                </Label>
                {__WEB__ ? (() => {
                  const sid = String(repayRow.finance_type) === 'SID'
                  const via = String(repayForm.settle_via || 'bank')
                  const opts = [
                    { v: 'bank', label: 'Our bank', icon: Landmark, off: false },
                    {
                      v: 'party',
                      label: `Against ${n(repayRow.party_count) > 1 ? `one of ${n(repayRow.party_count)} parties` : repayRow.party_name || 'the party'}`,
                      icon: Users,
                      // A SID bill is assigned to the financier: they pay us
                      // and we repay them, so the customer's ledger is never
                      // part of it. Shown and disabled, so its absence is
                      // explained rather than mysterious.
                      off: sid
                    }
                  ]
                  return (
                    <>
                      <div className="flex gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
                        {opts.map((o) => {
                          const on = via === o.v
                          return (
                            <button
                              key={o.v}
                              type="button"
                              disabled={o.off}
                              title={o.off ? 'A SID bill is repaid to the financier — the customer’s ledger is not involved' : undefined}
                              onClick={() => setRepayForm((p) => ({ ...p, settle_via: o.v }))}
                              className={cn(
                                'flex h-11 min-w-0 flex-1 items-center justify-center gap-2 truncate rounded-[2px] px-3 text-[12.5px] font-extrabold transition-colors',
                                o.off
                                  ? 'cursor-not-allowed text-[#A8BBB0]'
                                  : on
                                    ? 'bg-[#1A2C56] text-white'
                                    : 'text-[#5A6B62] hover:text-[#0A1F17]'
                              )}
                            >
                              <o.icon className="h-[17px] w-[17px] shrink-0" />
                              <span className="truncate">{o.label}</span>
                            </button>
                          )
                        })}
                      </div>
                      <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                        {via === 'bank'
                          ? 'Posts the payment straight out of your own bank account.'
                          : 'Settles it on the party’s ledger instead — bill-wise if you name a reference below, On Account if you leave it blank.'}
                      </span>
                    </>
                  )
                })() : (
                <Select value={String(repayForm.settle_via || 'bank')} onValueChange={(v) => setRepayForm((p) => ({ ...p, settle_via: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">Our bank</SelectItem>
                    {/* A SID bill is assigned to the financier: they pay us and
                        we repay them, so the customer's ledger is never part of
                        it. The option is shown but disabled rather than removed,
                        so its absence is explained rather than mysterious. */}
                    <SelectItem
                      value="party"
                      disabled={String(repayRow.finance_type) === 'SID'}
                      title={
                        String(repayRow.finance_type) === 'SID'
                          ? 'A SID bill is repaid to the financier — the customer’s ledger is not involved'
                          : undefined
                      }
                    >
                      Against{' '}
                      {n(repayRow.party_count) > 1
                        ? `one of the ${n(repayRow.party_count)} parties`
                        : repayRow.party_name || 'the party'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                )}
              </div>
              {/* Which party's ledger this lands on. Only asked when the bill
                  carries more than one — crediting the primary for a payment
                  that cleared another party's invoices would put the money on
                  the wrong ledger. */}
              {repayForm.settle_via === 'party' && repayParties.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1">
                    Whose ledger
                    <InfoTip text="This bill is raised against several parties. Pick the one whose account this repayment settles." />
                  </Label>
                  <Select
                    value={String(repayForm.party_id || '')}
                    onValueChange={(v) => setRepayForm((p) => ({ ...p, party_id: v }))}
                  >
                    <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                    <SelectContent>
                      {repayParties.map((pp, i) => (
                        <SelectItem key={String(pp.party_id)} value={String(pp.party_id)}>
                          {pp.name}
                          {i === 0 ? ' (primary)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {repayForm.settle_via === 'party' && (
                <div className="flex flex-col gap-1.5">
                  <Label>
                    Bill reference <span className="text-[10px] font-normal text-muted-foreground">(blank = On Account)</span>
                  </Label>
                  <Input
                    value={repayForm.ref ?? ''}
                    placeholder="Invoice / bill no to settle against"
                    onChange={(e) => setRepayForm((p) => ({ ...p, ref: e.target.value }))}
                  />
                </div>
              )}
              {n(repayRow.marginAmount) > 0 && (
                // A switch row, not a field caption — same as the term
                // switches. See BD_FIELDS.
                <label data-raw className="flex w-fit cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2">
                  <Switch checked={!!repayForm.release_margin} onCheckedChange={(v) => setRepayForm((p) => ({ ...p, release_margin: v }))} />
                  <span className="text-sm font-medium">
                    Release the {formatINR(repayRow.marginAmount)} margin back
                    {round2(n(repayForm.amount)) < dueOn(repayRow) && (
                      <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                        — on the payment that clears the bill; the NBFC holds it until then
                      </span>
                    )}
                  </span>
                </label>
              )}
              </>
              )}
              {/* What has already gone back, so the schedule is visible where
                  the next instalment is being entered — and correctable there
                  too, since a wrong figure is only found later. */}
              {/* INTEREST SERVICED DURING THE TENOR.
                  Only on a bill whose terms say so. Each rest is a row: the
                  days it covers, what it costs, and a button that pays it and
                  posts the voucher. Paid ones keep their date and can be
                  undone, because a wrong date on an interest voucher is found
                  a week later, not while it is being entered. */}
              {__WEB__ && intSched.length > 0 && (
                <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                  <div className="flex items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-3">
                    <Percent className="h-[17px] w-[17px] text-[#1A2C56]" />
                    <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#1A2C56]">
                      Interest serviced
                    </span>
                    <span className="doc-ref ml-auto rounded-[2px] border border-[#DCE7DB] bg-[#F7FAF6] px-[7px] py-0.5 text-[10.5px] font-bold text-[#5A6B62]">
                      {intSched.filter((r) => r.paid_id).length} of {intSched.length} paid
                    </span>
                  </div>
                  {intSched.map((r) => {
                    const done = !!r.paid_id
                    // The next one due is the first unpaid: interest is
                    // serviced in order, so nothing further down can be taken
                    // while an earlier rest is still open.
                    const next = !done && intSched.find((x) => !x.paid_id)?.seq === r.seq
                    return (
                      <div
                        key={String(r.seq)}
                        className={cn(
                          'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-b-[#EFF3EE] px-4 py-2.5 last:border-b-0',
                          done ? 'bg-[#F4FBF6]' : next ? 'bg-white' : 'bg-white opacity-60'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-[10.5px] font-extrabold',
                            done ? 'bg-[#12855A] text-white' : 'bg-[#EAF0E9] text-[#5A6B62]'
                          )}
                        >
                          {done ? <Check className="h-3.5 w-3.5" /> : r.seq}
                        </span>
                        <span className="doc-ref min-w-0 text-[12px] font-bold text-[#0A1F17]">
                          {formatDate(String(r.from_date))} <span className="font-bold text-[#8CA396]">&rarr;</span>{' '}
                          {formatDate(String(r.to_date))}
                        </span>
                        <span className="doc-ref shrink-0 text-[11px] font-semibold text-[#5A6B62]">
                          {n(r.days)}d{r.last ? ' · maturity' : ''}
                        </span>
                        <span className="doc-ref ml-auto shrink-0 text-[13px] font-bold tabular-nums text-[#0A1F17]">
                          {formatINR(n(r.gross))}
                        </span>
                        {done ? (
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-[11px] font-bold text-[#0B6B45]">
                              paid {formatDate(String(r.paid_date))}
                            </span>
                            {/* RECORDED IS NOT THE SAME AS ON THE LEDGER.
                                A slice paid without posting sits here exactly
                                as a posted one does — the schedule has moved
                                on and the days are serviced — except the
                                books do not yet agree, and that has to be
                                visible rather than found out later at the
                                trial balance. */}
                            {!r.posted && (
                              <>
                                <span
                                  className="inline-flex items-center gap-1 rounded-[3px] border border-[#F0E4CB] bg-[#FFF8E8] px-1.5 py-[1px] text-[10px] font-extrabold uppercase tracking-[.06em] text-[#8A5300]"
                                  title="Serviced, but no voucher has been posted for it yet"
                                >
                                  <Clock className="h-2.5 w-2.5" />
                                  Not posted
                                </span>
                                <Button
                                  size="sm"
                                  disabled={intPosting === Number(r.paid_id)}
                                  className="!h-6 !rounded-[3px] !bg-[#1A2C56] !px-2 !text-[10.5px] !font-bold !text-white hover:!bg-[#24407e]"
                                  onClick={() => void postInterestNow(Number(r.paid_id))}
                                >
                                  {intPosting === Number(r.paid_id) ? 'Posting…' : 'Post now'}
                                </Button>
                              </>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Undo this interest payment — its voucher reverses too"
                              className="!h-7 !w-7 !p-0 !text-[#B3261E] hover:!bg-[#FDF3F2]"
                              onClick={() => void undoInterest(Number(r.paid_id))}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            disabled={!next || intBusy}
                            title={
                              next
                                ? `Pay ${formatINR(n(r.gross))} — TDS ${formatINR(n(r.tds))} withheld, ${formatINR(n(r.net))} out of the bank`
                                : 'Interest is serviced in order — pay the earlier rest first'
                            }
                            className={cn(
                              '!h-8 !shrink-0 !rounded-[3px] !px-3 !text-[11.5px] !font-extrabold',
                              next
                                ? '!bg-[#1A2C56] !text-white hover:!bg-[#24407e]'
                                : '!bg-[#EAF0E9] !text-[#8FA79B]'
                            )}
                            onClick={() =>
                              setIntAsk({
                                kind: 'slice',
                                toDate: String(r.to_date),
                                gross: n(r.gross),
                                tds: n(r.tds),
                                net: n(r.net),
                                days: n(r.days)
                              })
                            }
                          >
                            {intBusy && next ? 'Paying…' : 'Pay'}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-t-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                    <span className="text-[11.5px] font-bold text-[#5A6B62]">
                      {formatINR(intSched.filter((r) => r.paid_id).reduce((t, r) => t + n(r.paid_gross), 0))} serviced
                      of {formatINR(intSched.reduce((t, r) => t + n(r.gross), 0))}
                    </span>
                    <span className="ml-auto text-[11px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                      Only the principal falls due at maturity
                    </span>
                  </div>
                </div>
              )}

              {/* Always present on the website, empty state and all: "has
                  anything gone back on this bill?" is a question worth an
                  answer, and a missing card answers it only by accident. */}
              {(__WEB__ || repayParts.length > 0) && (
                <div className={cn('rounded-lg border border-[#e5dfc8]', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                  <div
                    className={cn(
                      'border-b border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#1a2c56]',
                      __WEB__ && '!flex !items-center !gap-2.5 !border-b-[#E5DFC8] !px-4 !py-3 !text-[11px] !font-extrabold !tracking-[.13em]'
                    )}
                  >
                    {__WEB__ && <History className="h-[17px] w-[17px] text-[#1A2C56]" />}
                    {__WEB__ ? 'Already repaid' : `Already repaid · ${repayParts.length} ${repayParts.length === 1 ? 'part' : 'parts'}`}
                    {__WEB__ && (
                      <span className="doc-ref ml-auto rounded-[2px] border border-[#E5DFC8] bg-white px-[7px] py-0.5 text-[10.5px] font-bold text-[#5A6B62]">
                        {repayParts.length} {repayParts.length === 1 ? 'part' : 'parts'}
                      </span>
                    )}
                  </div>
                  {__WEB__ && repayParts.length === 0 && (
                    <div className="px-4 py-5 text-center text-[12px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                      Nothing has gone back on this bill yet. The whole {formatINR(dueOn(repayRow))} is outstanding.
                    </div>
                  )}
                  <div className="max-h-40 overflow-y-auto">
                    {repayParts.map((part) => (
                      <div key={String(part.id)} className="flex items-center justify-between gap-2 border-b border-dashed border-[#e5dfc8] px-3 py-1.5 text-xs last:border-b-0">
                        <span className="tabular-nums text-muted-foreground">{formatDate(part.repay_date)}</span>
                        <span className="font-semibold tabular-nums">{formatINR(part.amount)}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {String(part.settle_via) === 'party' ? `vs ${part.ref || 'On Account'}` : 'Bank'}
                        </span>
                        <span className="ml-auto tabular-nums text-muted-foreground">bal {formatINR(part.balance_after)}</span>
                        {String(part.settle_via) !== 'party' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 shrink-0 p-0 text-[#0B3D2E] hover:bg-[#F3FBE2]"
                            title="Edit this repayment — the voucher keeps its number"
                            onClick={() => setEditRepPart({ ...part, bd_no: repayRow?.bd_no })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 shrink-0 p-0 text-rose-700 hover:bg-rose-50"
                          title="Remove this repayment — its voucher reverses too"
                          onClick={() => void removeRepayPart(part)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Pinned at the foot of the column, where a drawer's actions
              belong — reachable however far the repayment history runs. */}
          <DialogFooter
            className={cn(
              __WEB__ &&
                '!m-0 !flex !flex-wrap !items-center !gap-2.5 !border-t !border-t-[#D6E2D6] !bg-white !px-[22px] !py-3.5 sm:!justify-start'
            )}
          >
            {__WEB__ && !!repayRow && repayKind === 'interest' && (
              <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-bold text-[#5A6B62]">
                <Percent className="h-[17px] w-[17px] shrink-0 text-[#1A2C56]" />
                <span className="min-w-0 [text-wrap:pretty]">
                  Paying interest only — the button is beside the figures above.
                </span>
              </span>
            )}
            {__WEB__ && !!repayRow && repayKind === 'full' && (() => {
              const due = dueOn(repayRow)
              const amt = round2(n(repayForm.amount))
              // Over the bill it is no longer wrong, it is unfinished: the
              // excess has to be named before it can be saved.
              const ok = amt > 0 && (amt <= due + 0.004 || Math.abs(unallocated) < 0.005)
              return (
                <span
                  className={cn(
                    'flex min-w-0 items-center gap-2 text-[12.5px] font-bold',
                    ok ? 'text-[#0B6B45]' : 'text-[#8A5300]'
                  )}
                >
                  {ok ? (
                    <CheckCircle2 className="h-[17px] w-[17px] shrink-0 text-[#12855A]" />
                  ) : (
                    <CircleAlert className="h-[17px] w-[17px] shrink-0 text-[#C2700A]" />
                  )}
                  <span className="min-w-0 [text-wrap:pretty]">
                    {amt <= 0
                      ? 'Enter the amount going back.'
                      : spill > 0.004
                        ? Math.abs(unallocated) < 0.005
                          ? `${formatINR(amt)} out of the bank — ${formatINR(due)} clears this bill, ${formatINR(spill)} accounted for.`
                          : unallocated > 0
                            ? `${formatINR(unallocated)} of the ${formatINR(amt)} is not accounted for yet.`
                            : `${formatINR(-unallocated)} more is allocated than is being repaid.`
                        : amt >= due - 0.004
                          ? `Clears ${formatINR(amt)} and closes the bill.`
                          : `${formatINR(amt)} back · ${formatINR(round2(due - amt))} still open.`}
                  </span>
                </span>
              )
            })()}
            <Button
              variant="outline"
              onClick={() => setRepayRow(null)}
              disabled={repaySaving}
              className={cn(__WEB__ && '!ml-auto !h-11 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-5 !font-extrabold !text-[#33473E]')}
            >
              Cancel
            </Button>
            <Button
              className={cn(
                'bg-[#1a2c56] hover:bg-[#24407e]',
                __WEB__ && '!h-11 !gap-2 !rounded-[4px] !bg-[#1A2C56] !px-6 !font-extrabold !text-white hover:!bg-[#24407e]',
                // Hidden rather than disabled on the interest side: a greyed
                // Save invites the question "why can't I", and the answer is
                // that this is not the button for what you are doing.
                __WEB__ && repayKind === 'interest' && '!hidden'
              )}
              onClick={() => void saveRepay()}
              disabled={
                repaySaving ||
                // A debit that does not add up is not a save worth offering:
                // the server refuses it, and a button that looks ready and
                // then errors is the worse way to say so.
                (repayKind === 'full' && spill > 0.004 && Math.abs(unallocated) >= 0.005)
              }
            >
              {__WEB__ && !repaySaving && <Banknote className="h-[18px] w-[18px]" />}
              {repaySaving
                ? 'Saving…'
                : spill > 0.004
                  ? `Pay ${formatINR(round2(n(repayForm.amount)))}`
                  : repayRow && round2(n(repayForm.amount)) > 0 && round2(n(repayForm.amount)) < dueOn(repayRow)
                    ? `Repay ${formatINR(round2(n(repayForm.amount)))}`
                    : 'Repay in full'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* FACILITY LIMITS — its own screen now, reached from Manage Limits. */}
      <Dialog
        open={limitsOpen}
        onOpenChange={(o) => {
          setLimitsOpen(o)
          if (!o) setLimitHistory(null)
        }}
      >
        <DialogContent
          className={cn('max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto', bdDrawer('!w-[920px]'))}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Facilities</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1.5 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>
              Manage Limits
            </DialogTitle>
          </DialogHeader>
          <div className={cn('grid gap-4', __WEB__ && '!gap-3.5 !px-[22px] !py-[18px]')}>
          {/* ONE LAYER, NOT TWO. The history used to open as a drawer over
              this dialog, which put the table it belongs to behind a scrim
              and half behind the panel — so the row being explained was the
              one thing you could no longer see. It takes this block's place
              instead, and the Back arrow gives it back. */}
          {limitHistory && (
            <div className="mb-1">
              <LimitHistory
                inline
                target={limitHistory}
                onClose={() => setLimitHistory(null)}
                onChanged={() => {
                  void loadLimits()
                  void load()
                }}
              />
            </div>
          )}
          {limits && !limitHistory && (
            <div className="mb-1">
              <div className={cn('overflow-hidden rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-sm', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none')}>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-2 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2 text-white',
                    __WEB__ && '!gap-2.5 !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !bg-none !px-4 !py-3 !text-[#0A1F17]'
                  )}
                >
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full bg-white/15', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9]')}>
                    <Landmark className={cn('h-3.5 w-3.5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} />
                  </span>
                  <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11.5px] !font-extrabold !tracking-[.14em]')}>BD Facility Limit</span>
                  <span className={cn('rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums', __WEB__ && '!rounded-[2px] !bg-[#EAF0E9] !px-2 !py-1 !text-[11px] !font-bold !text-[#33473E]')}>
                    {(limits.per_nbfc as Row[]).filter((r) => n(r.sanctioned) > 0).length} of{' '}
                    {(limits.per_nbfc as Row[]).length} NBFCs with a limit set
                  </span>
                  {limitEdit === null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(
                        'ml-auto h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white',
                        __WEB__ && '!h-[34px] !rounded-[3px] !border-[#0B3D2E] !bg-white !px-3 !text-[12px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#EAF0E9] hover:!text-[#0B3D2E]'
                      )}
                      onClick={() => setLimitEdit(limits.combined_limit == null ? '' : String(limits.combined_limit))}
                    >
                      <Settings2 className="h-3.5 w-3.5" /> {limits.combined_limit == null ? 'Set combined limit' : 'Edit combined limit'}
                    </Button>
                  ) : (
                    <div className="ml-auto flex items-center gap-1.5">
                      <Input
                        type="number"
                        autoFocus
                        placeholder="Blank to clear"
                        className={cn('h-7 w-40 bg-white text-[12px] tabular-nums text-foreground', __WEB__ && '!h-[34px] !w-44 !rounded-[3px] !border-[#C3D2C6] !text-[13px] !font-bold')}
                        value={limitEdit}
                        onChange={(e) => setLimitEdit(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void saveCombinedLimit()}
                      />
                      <Button size="sm" className={cn('h-7 bg-amber-400 px-2 text-xs font-semibold text-[#1a2c56] hover:bg-amber-300', __WEB__ && '!h-[34px] !rounded-[3px] !bg-[#0B3D2E] !px-3.5 !text-[12px] !font-extrabold !text-[#C7F03F] hover:!bg-[#0F4A38]')} disabled={limitSaving} onClick={() => void saveCombinedLimit()}>
                        {limitSaving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button size="sm" variant="ghost" className={cn('h-7 px-2 text-xs text-white hover:bg-white/20 hover:text-white', __WEB__ && '!h-[34px] !rounded-[3px] !px-3 !text-[12px] !font-bold !text-[#33473E] hover:!bg-[#EAF0E9] hover:!text-[#0A1F17]')} onClick={() => setLimitEdit(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>

                <div className={cn('grid grid-cols-2 gap-px bg-[#e5dfc8] p-px sm:grid-cols-4', __WEB__ && '!gap-px !border-t !border-t-[#E4ECE3] !bg-[#E4ECE3] !p-0')}>
                  <div className={cn('bg-[#1a2c56] px-3 py-2.5 text-center', BD_CELL, __WEB__ && '!bg-[#0B3D2E]')}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-white/70', BD_K, __WEB__ && '!text-[#8FBFA8]')}>Combined limit</div>
                    <div className={cn('text-[15px] font-bold tabular-nums text-white', BD_V, __WEB__ && '!text-[#C7F03F]')}>
                      {limits.combined_limit == null ? '— not set —' : formatINR(limits.combined_limit)}
                    </div>
                  </div>
                  <div className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', BD_CELL)}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', BD_K)}>Sum of NBFC lines</div>
                    <div className="text-[15px] font-bold tabular-nums text-[#1a2c56]">{formatINR(limits.sanctioned_sum)}</div>
                  </div>
                  <div className={cn('bg-[#fffdf4] px-3 py-2.5 text-center', BD_CELL)}>
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', BD_K)}>Utilised</div>
                    <div className="text-[15px] font-bold tabular-nums text-rose-700">{formatINR(limits.utilised_total)}</div>
                    {n(limits.committed_total) > 0 && (
                      <div className="text-[10px] text-amber-700">+ {formatINR(limits.committed_total)} committed</div>
                    )}
                  </div>
                  <div className="bg-emerald-50 px-3 py-2.5 text-center">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800">Available</div>
                    <div className={cn('text-[15px] font-bold tabular-nums', n(limits.combined_available) < 0 ? 'text-red-600' : 'text-emerald-900')}>
                      {limits.combined_available == null ? '—' : formatINR(limits.combined_available)}
                    </div>
                    {limits.combined_used_pct != null && (
                      <div className="text-[10px] text-emerald-800">{limits.combined_used_pct}% used</div>
                    )}
                  </div>
                </div>

                {/* A group ceiling below the sum of the lines means the lines cannot
                    all be drawn at once — worth saying rather than leaving to be
                    discovered when a draw is refused. */}
                {limits.lines_exceed_combined === true && (
                  <div className="border-t border-[#e5dfc8] bg-amber-50 px-4 py-1.5 text-[11px] font-medium text-amber-800">
                    The NBFC lines add up to {formatINR(limits.sanctioned_sum)}, more than the {formatINR(limits.combined_limit)}{' '}
                    combined ceiling — they cannot all be drawn at once.
                  </div>
                )}

                <div className="overflow-x-auto border-t border-[#e5dfc8]">
                  <Table className="text-[12px]">
                    <TableHeader>
                      <TableRow className={cn('bg-[#f7f4e8] hover:bg-[#f7f4e8]', BD_HEAD)}>
                        <TableHead className="h-8 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">NBFC</TableHead>
                        <TableHead className="h-8 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Sanctioned</TableHead>
                        <TableHead className="h-8 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Utilised</TableHead>
                        <TableHead className="h-8 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Available</TableHead>
                        <TableHead className="h-8 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Open bills</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(limits.per_nbfc as Row[])
                        .filter((r) => n(r.sanctioned) > 0 || n(r.utilised) > 0 || n(r.committed) > 0)
                        .map((r) => (
                          <TableRow key={String(r.id)} className="hover:bg-amber-50/60">
                            <TableCell className="font-medium">
                              <span className="flex items-center gap-2">
                                <span className="min-w-0 flex-1">
                                  {r.name}
                                  {!n(r.active) && (
                                    <span className="ml-1.5 text-[10px] text-muted-foreground">inactive</span>
                                  )}
                                </span>
                                <button
                                  type="button"
                                  title="When this line moved, and by how much"
                                  onClick={() =>
                                    setLimitHistory({
                                      kind: 'nbfc',
                                      id: Number(r.id),
                                      name: String(r.name || ''),
                                      // The figure a revision actually rewrites is
                                      // the sanctioned one; principal repaid is
                                      // shown separately in the timeline.
                                      current: n(r.sanctioned_original) || n(r.sanctioned)
                                    })
                                  }
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#0B6B45]"
                                >
                                  <History className="h-[15px] w-[15px]" />
                                </button>
                              </span>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right tabular-nums">
                              {n(r.sanctioned) > 0 || n(r.principal_repaid) > 0 ? (
                                <>
                                  {formatINR(r.sanctioned)}
                                  {/* The line has been cut. Showing 31 alone
                                      would leave nobody able to say it was
                                      ever 35, or what took it down. */}
                                  {n(r.principal_repaid) > 0 && (
                                    <div
                                      className="text-[10px] font-normal text-amber-700"
                                      title="Principal repaid against this facility — the limit steps down by it and does not come back"
                                    >
                                      {formatINR(r.sanctioned_original)} less {formatINR(r.principal_repaid)} principal
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="text-[11px] text-muted-foreground" title="Set it on the NBFC under Manage NBFCs">
                                  not set
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right tabular-nums text-rose-700">
                              {formatINR(r.utilised)}
                              {n(r.committed) > 0 && (
                                <div className="text-[10px] font-normal text-amber-700">+{formatINR(r.committed)} committed</div>
                              )}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'whitespace-nowrap text-right font-semibold tabular-nums',
                                r.available == null ? 'text-muted-foreground' : n(r.available) < 0 ? 'text-red-600' : 'text-emerald-700'
                              )}
                            >
                              {r.available == null ? '—' : formatINR(r.available)}
                              {r.used_pct != null && <div className="text-[10px] font-normal text-muted-foreground">{r.used_pct}% used</div>}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{n(r.open_bills)}</TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
          </div>
        </DialogContent>
      </Dialog>

      {/* NBFC master — the same EntityManager the Banks page uses. */}
      <Dialog
        open={nbfcOpen}
        onOpenChange={(o) => {
          setNbfcOpen(o)
          if (!o) {
            setLimitHistory(null)
            void load()
            // A sanctioned limit may have been edited in there.
            void loadLimits()
          }
        }}
      >
        <DialogContent
          className={cn(
            'max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto',
            bdDrawer('!w-[920px]')
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Masters</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1.5 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>Manage NBFCs</DialogTitle>
          </DialogHeader>
          <div
            className={cn(
              __WEB__ &&
                '!flex !min-h-0 !flex-col !gap-3.5 !overflow-y-auto !p-[22px] [&>*]:!shrink-0'
            )}
          >
          {/* WHAT THESE TERMS ARE FOR, said once at the top rather than
              guessed at on every card: they are a PREFILL, and a bill already
              discounted keeps what it was given. */}
          <p
            className={cn(
              'text-xs text-muted-foreground',
              __WEB__ &&
                '!flex !items-start !gap-2.5 !rounded-[4px] !border !border-[#C6DAF0] !bg-[#F4F8FD] !px-4 !py-3 !text-[12px] !font-semibold !leading-[1.55] !text-[#1B4E82] [text-wrap:pretty]'
            )}
          >
            {__WEB__ && <Info className="mt-[1px] h-[17px] w-[17px] shrink-0 text-[#1B4E82]" />}
            <span>
              These defaults prefill a new bill when you pick the NBFC — rate, tenor, TDS and year basis. They are
              copied onto the bill, so changing them here does not touch bills already discounted.
            </span>
          </p>
          <EntityManager
            table="nbfcs"
            title="NBFC"
            fields={NBFC_FIELDS}
            columns={NBFC_COLUMNS}
            renderCard={(nb, api) => {
              // What this NBFC has out on the books right now, from the bills
              // already loaded — so the card says what it is carrying without
              // asking the database a second time.
              const mine = rows.filter((r) => Number(r.nbfc_id) === Number(nb.id) && String(r.status) !== 'repaid')
              const out = mine.reduce((t, r) => t + dueOn(r), 0)
              const on = !!nb.active
              const terms = [
                { k: 'Int % p.a.', v: n(nb.interest_pct) > 0 ? `${formatNum(n(nb.interest_pct))}%` : '—' },
                { k: 'Int days', v: n(nb.interest_days) > 0 ? String(n(nb.interest_days)) : '—' },
                { k: 'TDS %', v: n(nb.tds_pct) > 0 ? `${formatNum(n(nb.tds_pct))}%` : '—' },
                { k: 'Yr basis', v: String(n(nb.days_year) || 360) },
                {
                  k: 'Sanctioned limit',
                  v: n(nb.sanctioned_limit) > 0 ? formatINR(n(nb.sanctioned_limit)) : 'not set',
                  muted: !(n(nb.sanctioned_limit) > 0)
                }
              ]
              return (
                <div
                  className={cn(
                    'overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white',
                    on ? 'border-l-[#12855A]' : 'border-l-[#C3D2C6] opacity-70'
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] px-4 py-3">
                    <span className="min-w-0 truncate text-[13.5px] font-extrabold text-[#0A1F17]">
                      {String(nb.name)}
                    </span>
                    <span
                      title={
                        String(nb.finance_type) === 'PID'
                          ? 'Offered on purchase-invoice bills only'
                          : String(nb.finance_type) === 'SID'
                            ? 'Offered on sales-invoice bills only'
                            : 'Offered on both PID and SID bills'
                      }
                      className="shrink-0 rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-[7px] py-[3px] text-[9.5px] font-extrabold tracking-[.06em] text-[#1B4E82]"
                    >
                      {String(nb.finance_type || 'BOTH')}
                    </span>
                    {api.duplicate && (
                      <span className="shrink-0 rounded-[2px] border border-[#F0D6D4] bg-[#FDF3F2] px-[7px] py-[3px] text-[9.5px] font-extrabold tracking-[.06em] text-[#8C2F26]">
                        DUPLICATE NAME
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={cn(
                          'rounded-[2px] px-[7px] py-[3px] text-[10.5px] font-extrabold',
                          on ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#EAF0E9] text-[#5A6B62]'
                        )}
                      >
                        {on ? 'Active' : 'Inactive'}
                      </span>
                    </span>
                    <div className="ml-auto flex shrink-0 gap-1.5">
                      <Button
                        variant="outline"
                        size="icon"
                        title={`Edit ${String(nb.name)}`}
                        className="!h-[34px] !w-[34px] !rounded-[3px] !border-[#D6E2D6] !text-[#33473E]"
                        onClick={api.edit}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        // The count is a CAUTION, not a block — whether the
                        // delete is allowed is the database's answer, not this
                        // card's, and claiming otherwise here would be a rule
                        // that only looks enforced.
                        title={
                          mine.length
                            ? `Remove ${String(nb.name)} — careful, ${mine.length} bill${mine.length === 1 ? ' is' : 's are'} still open on it`
                            : `Remove ${String(nb.name)}`
                        }
                        className="!h-[34px] !w-[34px] !rounded-[3px] !border-[#F0D6D4] !bg-[#FDF3F2] !text-[#B3261E] hover:!bg-[#FBE9E7]"
                        onClick={api.remove}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {/* THE TERMS, which is what an NBFC actually is. */}
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,96px),1fr))] gap-3.5 px-4 py-3.5">
                    {terms.map((t) => (
                      <div key={t.k} className="min-w-0">
                        <div className="whitespace-nowrap text-[9px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">
                          {t.k}
                        </div>
                        <div
                          className={cn(
                            'doc-ref mt-1 whitespace-nowrap text-[14px] font-bold',
                            t.muted ? 'text-[#8FA79B]' : 'text-[#0A1F17]'
                          )}
                        >
                          {t.v}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-t-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                    <span className="text-[11.5px] font-bold text-[#5A6B62]">
                      {mine.length
                        ? `${mine.length} open · ${formatINR(out)}`
                        : 'Nothing open on this NBFC'}
                    </span>
                    <span className="ml-auto text-[11px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                      {nb.days_incl_start ? 'Interest counts the receipt date' : 'Interest runs from the day after receipt'}
                    </span>
                  </div>
                </div>
              )
            }}
          />
          </div>
          {__WEB__ && (
            <DialogFooter className="!m-0 !flex !flex-wrap !items-center !gap-2.5 !border-t !border-t-[#D6E2D6] !bg-white !px-[22px] !py-3.5 sm:!justify-start">
              <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-bold text-[#0B6B45]">
                <CheckCircle2 className="h-[17px] w-[17px] shrink-0 text-[#12855A]" />
                <span className="min-w-0 [text-wrap:pretty]">
                  {nbfcs.filter((x) => !!x.active).length} active of {nbfcs.length} · these terms prefill a new bill when
                  the NBFC is picked.
                </span>
              </span>
              <Button
                className="!ml-auto !h-11 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-6 !font-extrabold !text-[#C7F03F] hover:!bg-[#0F4A38]"
                onClick={() => setNbfcOpen(false)}
              >
                <Check className="h-[18px] w-[18px]" /> Done
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* THE BILL, OPENED OUT. Built to the Treasury canvas — see BdDetail.
          The row it belongs to is looked up live rather than copied in, so a
          repayment saved behind the panel is reflected in it. */}
      <RefundReceived
        kind="bd"
        id={refundBd}
        open={!!refundBd}
        onClose={() => setRefundBd(null)}
        onChanged={() => void Promise.all([window.api.billDiscounting.refundDues().then(setBdRefundDue), window.api.billDiscounting.refundTotals().then(setBdRefundTot)]).catch(() => undefined)}
      />
      <Dialog open={!!routeRow} onOpenChange={(o) => !o && !routeSaving && setRouteRow(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Disbursement paid to — {String(routeRow?.bd_no || '')}</DialogTitle>
          </DialogHeader>
          {routeRow && (
            <div className="grid gap-3">
              <p className="text-[12.5px] leading-relaxed text-[#5A6B62]">
                Where the NBFC&rsquo;s money went. Only this changes{String(routeRow.status) === 'repaid' ? ' — the bill stays repaid and locked' : ''}: the opening voucher is
                re-posted in place (same number). Repayments, interest and everything after it stay exactly as they are.
              </p>
              <Seg
                soft
                value={routeVal}
                onChange={(v) => setRouteVal(v)}
                options={[
                  { v: 'bank', label: 'Our bank' },
                  ...(String(routeRow.finance_type) === 'PID' ? [{ v: 'supplier', label: 'Supplier direct' }] : [])
                ]}
              />
              {routeVal === 'bank' ? (
                <Select value={routeAcct} onValueChange={setRouteAcct}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Pick the bank the money landed in" />
                  </SelectTrigger>
                  <SelectContent>
                    {formBanks.map((a) => (
                      <SelectItem key={String(a.id)} value={String(a.name)}>
                        {String(a.name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="grid gap-2">
                  <p className="text-[12px] font-semibold text-[#33473E]">
                    Posts as a journal: each supplier below is debited with what the NBFC paid them, against the NBFC&rsquo;s payable. No bank entry.
                  </p>
                  {routeShares.map((sh, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Select
                          searchable
                          value={sh.party_id}
                          onValueChange={(v) => setRouteShares((p) => p.map((x, j) => (j === i ? { ...x, party_id: v } : x)))}
                        >
                          <SelectTrigger className="h-10">
                            <SelectValue placeholder="Pick the supplier" />
                          </SelectTrigger>
                          <SelectContent>
                            {suppliers.map((sp) => (
                              <SelectItem key={String(sp.id)} value={String(sp.id)}>
                                {String(sp.name)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        inputMode="decimal"
                        className="h-10 w-[150px] text-right tabular-nums"
                        placeholder="0.00"
                        value={sh.amount}
                        onChange={(e) => setRouteShares((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, '') } : x)))}
                      />
                      {routeShares.length > 1 && (
                        <button
                          type="button"
                          title="Remove this supplier"
                          onClick={() => setRouteShares((p) => p.filter((_, j) => j !== i))}
                          className="flex h-10 w-9 flex-none items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="!h-8 !px-3 !text-[12px] !font-bold"
                      onClick={() => setRouteShares((p) => [...p, { party_id: '', amount: '' }])}
                    >
                      <Plus className="h-4 w-4" /> Add supplier
                    </Button>
                    {routeShares.length > 1 && (() => {
                      const sum = round2(routeShares.reduce((t, x) => t + n(x.amount), 0))
                      const ok = Math.abs(sum - n(routeRow.amount)) < 0.01
                      return (
                        <span className={cn('ml-auto text-[11.5px] font-bold', ok ? 'text-[#0B6B45]' : 'text-[#B3261E]')}>
                          {ok ? `Shares add up to ${formatINR(sum)}` : `Shares ${formatINR(sum)} of ${formatINR(n(routeRow.amount))}`}
                        </span>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={routeSaving} onClick={() => setRouteRow(null)}>
              Cancel
            </Button>
            <Button disabled={routeSaving} onClick={() => void saveRoute()}>
              {routeSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BdRepaymentEdit
        repayment={editRepPart}
        onClose={() => setEditRepPart(null)}
        onSaved={() => {
          void (async () => {
            const fresh = await load()
            setBdRev((v) => v + 1)
            if (repayRow) {
              const again = fresh.find((x) => Number(x.id) === Number(repayRow.id))
              if (again) setRepayRow(again)
              await loadRepayParts(Number(repayRow.id))
            }
          })()
        }}
      />
      {__WEB__ &&
        (() => {
          // Looked up live rather than copied in, so a repayment saved behind
          // the panel is reflected in it rather than leaving a stale figure.
          const b = openBd ? rows.find((x) => Number(x.id) === openBd) || null : null
          if (!b) return null
          const done = String(b.status) === 'repaid'
          return (
            <BdDetail
              bill={b}
              interest={openBdInterest}
              repayments={openBdParts}
              onChanged={() => {
                void load()
                // The repayment list is read again too — an edit rewrites it.
                setBdRev((v) => v + 1)
              }}
              onClose={() => setOpenBd(0)}
              onEdit={(x) => {
                setOpenBd(0)
                openEdit(x)
              }}
              onDelete={(x) => {
                setOpenBd(0)
                void remove(x)
              }}
              primaryLabel={done ? '' : String(b.stage) === 'awaiting' ? 'Mark received' : 'Repay'}
              onPrimary={
                done
                  ? undefined
                  : (x) => {
                      setOpenBd(0)
                      if (String(x.stage) === 'awaiting') openReceive(x)
                      else openRepay(x)
                    }
              }
            />
          )
        })()}

      {/* WHAT THIS BILL PUT IN THE LEDGERS — see LedgerPostings. */}
      <LedgerPostings target={postings} onClose={() => setPostings(null)} />
    </div>
  )
}

// THE NBFC PAYING THE SUPPLIER IN PARTS — every part paid so far on a PID
// bill paid supplier-direct, and the next one: its date (not before the last
// part, not after today), amount and a note. Only the latest part can be
// taken back; the first is the Payment received itself.
function BdPartyPayments({ row, onClose, onChanged }: { row: Row | null; onClose: () => void; onChanged: () => void | Promise<void> }): React.JSX.Element {
  const [parts, setParts] = useState<Row[]>([])
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [undoAsk, setUndoAsk] = useState(false)
  const net = Math.round((Number(row?.receiptAmount) || 0) * 100) / 100
  const paid = Math.round(parts.reduce((t, p) => t + (Number(p.amount) || 0), 0) * 100) / 100
  const left = Math.round(Math.max(0, net - paid) * 100) / 100
  const last = parts.length ? String(parts[parts.length - 1].pay_date || '').slice(0, 10) : String(row?.payment_received_date || '').slice(0, 10)
  const closed = String(row?.status || '') === 'repaid'

  const reload = useCallback(async () => {
    if (!row) return
    const ps = (await window.api.billDiscounting.partyPayments(Number(row.id)).catch(() => [] as Row[])) as Row[]
    setParts(ps)
    const got = ps.reduce((t, p) => t + (Number(p.amount) || 0), 0)
    const rest = Math.round(Math.max(0, (Number(row.receiptAmount) || 0) - got) * 100) / 100
    setAmount(rest > 0 ? String(rest) : '')
  }, [row])
  useEffect(() => {
    setErr(null)
    setUndoAsk(false)
    setDate(todayISO())
    setNote('')
    void reload()
  }, [reload])

  async function save(): Promise<void> {
    if (!row) return
    const amt = Math.round((Number(amount) || 0) * 100) / 100
    if (amt <= 0) return setErr('Enter the amount the NBFC paid the supplier')
    if (amt > left + 0.005) return setErr(`Only ${formatINR(left)} is still to be paid on this bill`)
    if (!date) return setErr('Pick the date the NBFC paid it')
    if (date > todayISO()) return setErr('The payment date cannot be in the future')
    if (last && date < last) return setErr(`The last part was paid on ${formatDate(last)} — this one cannot be dated before it`)
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.billDiscounting.payParty(Number(row.id), { date, amount: amt, note })
      toast.success(`Part ${r.part_no} of ${formatINR(amt)} posted to ${String(row.party_name || 'the supplier')}`)
      setNote('')
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function undoLast(): Promise<void> {
    if (!row) return
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.billDiscounting.removePartyPayment(Number(row.id))
      toast.success(`Part ${r.part_no} taken back — its voucher is removed`)
      setUndoAsk(false)
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pct = net > 0 ? Math.min(100, Math.round((paid / net) * 100)) : 0
  const lbl = 'text-[10.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  const lastPart = parts[parts.length - 1]
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#D6E2D6] bg-[#F2F6F1] p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Payment to the supplier</div>
          <DialogTitle className="mt-1 text-[18px] font-bold text-white">Parts — BD {String(row?.bd_no || '')}</DialogTitle>
          <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
            What {String(row?.nbfc_name || 'the NBFC')} has paid {String(row?.party_name || 'the supplier')} on this bill, part by part.
          </p>
        </DialogHeader>
        <div className="grid gap-3.5 p-4">
          <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
            <div className="grid grid-cols-3 divide-x divide-[#E4ECE3]">
              {[
                { k: 'Due to the supplier', v: net, tone: 'text-[#0A1F17]' },
                { k: `Paid · ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`, v: paid, tone: 'text-[#0B6B45]' },
                { k: 'Still to pay', v: left, tone: left > 0.005 ? 'text-[#8A5300]' : 'text-[#8CA396]' }
              ].map((c) => (
                <div key={c.k} className="px-4 py-3">
                  <div className={lbl}>{c.k}</div>
                  <div className={cn('mt-1 text-[16px] font-bold tabular-nums', c.tone)}>{formatINR(c.v)}</div>
                </div>
              ))}
            </div>
            <div className="border-t border-[#E4ECE3] px-4 py-2.5">
              <div className="h-2 overflow-hidden rounded-full bg-[#EAF0E9]">
                <div className="h-full rounded-full bg-[#12855A]" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">{left > 0.005 ? `${pct}% paid` : 'Paid in full'}</div>
            </div>
          </section>

          <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
            <div className="border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]">
              Paid so far
            </div>
            <div className="divide-y divide-[#EEF3ED]">
              {parts.map((p) => (
                <div key={String(p.part_no)} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E9F5EE] text-[12px] font-extrabold text-[#0B6B45]">
                    {String(p.part_no)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-extrabold text-[#0A1F17]">{formatDate(String(p.pay_date || ''))}</div>
                    <div className="truncate text-[11.5px] font-semibold text-[#5A6B62]">{String(p.note || '')}</div>
                  </div>
                  <span className="text-[13.5px] font-bold tabular-nums">{formatINR(Number(p.amount) || 0)}</span>
                  {!closed && p === lastPart && Number(p.part_no) > 1 && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setUndoAsk(true)} className="h-8 gap-1 px-2 text-[11px] font-bold text-[#B3261E]">
                      <RotateCcw className="h-3.5 w-3.5" /> Undo
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {undoAsk && lastPart && (
              <div className="flex flex-wrap items-center gap-2 border-t border-[#F0D6D4] bg-[#FDF3F2] px-4 py-2.5">
                <span className="min-w-0 flex-1 text-[12px] font-bold text-[#8C2F26]">
                  Take back part {String(lastPart.part_no)} ({formatINR(Number(lastPart.amount) || 0)})? Its voucher is deleted.
                </span>
                <Button size="sm" variant="outline" onClick={() => setUndoAsk(false)} className="h-8 px-3 text-[11px] font-bold">
                  Keep it
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void undoLast()} className="h-8 bg-[#B3261E] px-3 text-[11px] font-bold text-white hover:bg-[#9A1F18]">
                  Take back
                </Button>
              </div>
            )}
          </section>

          {left > 0.005 && !closed && (
            <section className="overflow-hidden rounded-[6px] border border-[#BFE3CB] bg-white">
              <div className="flex items-center border-b border-[#BFE3CB] bg-[#F4FBF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0B6B45]">
                Record the next part
                <span className="ml-auto rounded-[3px] bg-[#EAF6EC] px-2 py-0.5 text-[11px] font-bold normal-case tracking-normal">Part {parts.length + 1}</span>
              </div>
              <div className="grid gap-3.5 p-4 sm:grid-cols-2">
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Date paid *</span>
                  <DatePicker value={date} onChange={setDate} min={last || undefined} max={todayISO()} />
                  <span className="text-[11.5px] font-semibold text-[#5A6B62]">{last ? `On or after ${formatDate(last)}, up to today.` : 'Up to today.'}</span>
                </div>
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Amount (₹) *</span>
                  <div className="relative">
                    <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-11 pr-[110px] text-[14px] font-bold" />
                    {Math.abs((Number(amount) || 0) - left) > 0.005 && (
                      <button
                        type="button"
                        onClick={() => setAmount(String(left))}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[3px] border border-[#BFE3CB] bg-[#F4FBF6] px-2 py-1 text-[10.5px] font-extrabold text-[#0B6B45]"
                      >
                        Pay the rest
                      </button>
                    )}
                  </div>
                  <span className={cn('text-[11.5px] font-semibold', (Number(amount) || 0) > left + 0.005 ? 'text-[#B3261E]' : 'text-[#5A6B62]')}>
                    {(Number(amount) || 0) > left + 0.005
                      ? `More than the ${formatINR(left)} still to pay`
                      : (Number(amount) || 0) > 0 && (Number(amount) || 0) < left - 0.005
                        ? `${formatINR(left - (Number(amount) || 0))} will still be left after this`
                        : 'Clears what is left on this bill'}
                  </span>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <span className={lbl}>Note</span>
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="NBFC advice no., remarks" className="h-10" />
                </div>
              </div>
              <div className="border-t border-[#E4ECE3] bg-[#FBFCFA] px-4 py-2 text-[11.5px] font-semibold text-[#5A6B62]">
                Posts a journal on that date: Dr {String(row?.party_name || 'supplier')} · Cr Bills discounted — {String(row?.nbfc_name || 'NBFC')}. Interest, margin and charges were taken with the first part.
              </div>
            </section>
          )}
          {err && <div className="rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-bold text-[#B3261E]">{err}</div>}
        </div>
        <DialogFooter className="border-t border-[#D6E2D6] bg-white px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {left > 0.005 && !closed && (
            <Button className="bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0F4A38]" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Post part'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
