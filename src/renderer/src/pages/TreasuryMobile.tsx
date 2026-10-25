// Treasury on a phone — website only (see the fork point in Treasury.tsx).
//
// Built to the mobile screen in "Treasury - mobile.dc.html" (390x844): a
// forest header carrying the company, a bell and three figures; LC / BD tabs
// with counts; one search box over a row of quick-filter chips; the facility
// limit as a card that opens; then a card per instrument, each with the action
// its stage calls for, and one primary action pinned to the foot.
//
// It is the WHOLE treasury, not a read-only view of it. Opening an LC (the
// four-step wizard), moving it through its stages, logging the customer's
// payment in, preclosing it, discounting a bill and repaying one all run from
// here. None of them re-implements a rule: every figure and every refusal comes
// back from the same channels the desktop uses — lc.create / lc.update /
// lc.preclose / lc.paymentIn and billDiscounting.create / update / repay — and
// the main process is the only side that can actually say no. The forms collect
// the fields, show the arithmetic the desktop shows, and put the server's own
// message on screen when it refuses.
//
// Colours, sizes and spacing are the handoff's. Its Material Symbols are
// substituted with the lucide icons this codebase already uses, as the handoff
// itself says to do.
import { LcCommissionLink } from '@/components/LcCommissionLink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  ArrowUpRight,
  Banknote,
  Bell,
  Calculator,
  CalendarCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  History,
  Hourglass,
  Info,
  Landmark,
  Maximize2,
  Pencil,
  Percent,
  Plus,
  Search,
  SearchX,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import { formatDate, formatNum } from '@/lib/format'
import { ChargeRows, chargeRowsFrom, chargeRowsPayload, chargeRowsProblem, chargeRowsTotal, type ChargeRow } from '@/components/ChargeRows'
import { MobileBar } from '@/components/MobileBar'
import { SerialNo } from '@/components/SerialNo'
import { cn } from '@/lib/utils'
import { PayInDue } from '@/components/PayInDue'
import { RefundReceived } from '@/components/RefundReceived'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { PaymentTrackerMobile, trackerHeadline } from '@/components/PaymentTracker'
import { canAccess } from '@/lib/modules'
import { loadUser } from '@/lib/session'
import { adjKindsLabel, adjPostsTo } from '@/components/AdjChargePicker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ===================================================================== helpers

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const round2 = (v: number): number => Math.round(v * 100) / 100

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Rupees, short. A phone header cannot hold ₹24,24,83,660 — and at a glance
// "24.25 Cr" is the figure being read anyway. Lakhs and crores because that is
// how the mill's own books are quoted.
function inrShort(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}

function inrFull(v: number): string {
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Days from today, negative meaning it has already passed.
function daysTo(iso: unknown): number | null {
  const d = s(iso).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const then = new Date(`${d}T00:00:00`)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((then.getTime() - now.getTime()) / 86400000)
}

function daysBetween(a: unknown, b: unknown): number | null {
  const x = s(a).slice(0, 10)
  const y = s(b).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || !/^\d{4}-\d{2}-\d{2}$/.test(y)) return null
  return Math.round((new Date(`${y}T00:00:00`).getTime() - new Date(`${x}T00:00:00`).getTime()) / 86400000)
}

const fmtD = (v: unknown): string => (s(v) ? formatDate(s(v)) : '—')

// ============================================= the desktop's rules, mirrored
//
// These answer "which button does this LC get" and "what does the preview
// show". They are copied from Treasury.tsx rather than imported, because
// Treasury.tsx imports THIS file and the two would chase each other round.
// They never decide money: the server re-derives every figure on save, and a
// preview that drifted from it would be corrected the moment the row reloads.

const STAGE_LABEL: Record<string, string> = {
  application: 'Application',
  open: 'Open',
  payment_received: 'Payment received'
}

function nextLcStage(stage: string): 'open' | 'payment_received' | null {
  if (stage === 'application') return 'open'
  if (stage === 'open') return 'payment_received'
  return null
}

// An LC is past maturity once today has reached its expiry.
const isLcPastMaturity = (l: Row): boolean => {
  const expiry = s(l.expiry_date).slice(0, 10)
  return !!expiry && todayISO() >= expiry
}

// Only a credit the bank has already paid on can be wound up.
const canPreclose = (l: Row): boolean => !l.preclosed_date && s(l.stage || 'application') === 'payment_received'
// Paid to the supplier in installments, with some still to go.
// Paid in parts: what of the LC is still undrawn; otherwise what the supplier
// is still owed out of the net — as on the desktop.
const partyLeft = (l: Row): number =>
  n(l.parts_count) > 0 ? round2(n(l.parts_left)) : round2(Math.max(0, n(l.paid_expected) - n(l.utilized)))
// One part's interest and what reaches the supplier — the server's own sum.
function lcPartPreview(lc: Row, amount: number, payDate: string, maturity: string, first: boolean): { days: number; interest: number; charges: number; net: number } {
  const a = Date.parse(`${s(payDate).slice(0, 10)}T00:00:00`)
  const b = Date.parse(`${s(maturity).slice(0, 10)}T00:00:00`)
  const days = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400000)) : 0
  const charges = first ? round2(n(lc.charges)) : 0
  const base = Math.max(0, round2(amount - (lc.interest_excl_charges ? charges : 0)))
  const interest = round2((base * n(lc.interest_pct) * days) / 36500)
  return { days, interest, charges, net: round2(amount - interest - charges) }
}
const canPayParty = (l: Row): boolean =>
  !l.preclosed_date && s(l.stage) === 'payment_received' && n(l.installment_count) > 0 && partyLeft(l) > 0.5

// A trading LC waiting on the customer's money for the resale.
const canMarkPaymentIn = (l: Row): boolean =>
  !!Number(l.payment_in_expected) && !(Number(l.payment_in_total) > 0.004)

// The interest base: the open amount, less the charges when the terms exclude
// them, plus any hand adjustment — the same rule lc.ts applies.
function lcInterestBaseOf(v: Row): number {
  const gross = v?.interest_excl_charges ? round2(n(v.amount) - n(v.charges)) : n(v.amount)
  return Math.max(0, round2(gross + n(v.interest_adj)))
}
function lcInterestOfDays(v: Row, days: number): number {
  return round2((lcInterestBaseOf(v) * n(v.interest_pct) * n(days)) / (100 * 365))
}

function lcNoClash(lcs: Row[], lcNo: unknown, selfId?: unknown): Row | null {
  const want = s(lcNo).trim().toUpperCase()
  if (!want) return null
  return lcs.find((x) => s(x.lc_no).trim().toUpperCase() === want && Number(x.id) !== Number(selfId || 0)) || null
}

// What is still owed to the NBFC on a bill: the open amount less every part
// repaid — the same repaid_total the desktop's balance chip is struck from.
// repaid_amount is only the closing repayment, so a bill repaid in parts read
// as owing more than the browser said it did.
const bdDue = (b: Row): number =>
  Math.max(0, round2(n(b.amount) - n(b.repaid_total ?? b.repaid_amount)))
// Interest paid across the tenor rather than withheld: the NBFC kept none of it.
const bdServiced = (b: Row): boolean => s(b.interest_mode) === 'serviced'
// The desktop's Awaiting bucket — not yet funded by the NBFC, OR funded but
// still owed its Payment IN. The phone counted only the first, and read 0
// where the browser showed three.
const bdAwaiting = (b: Row): boolean =>
  s(b.stage) === 'awaiting' || (!!Number(b.payment_in_expected) && n(b.payment_in_total) <= 0.004)
// The desktop band's figures (kpisOf), off the same rows: exposure counts only
// funded, unrepaid bills, and what the NBFC kept is nothing on a serviced one.
function bdKpis(list: Row[]): { count: number; outstanding: number; margin: number; interest: number; tds: number; receipt: number } {
  const live = list.filter((b) => s(b.status) !== 'repaid' && s(b.stage) === 'live')
  const sum = (f: (b: Row) => number): number => round2(live.reduce((t, b) => t + f(b), 0))
  return {
    count: live.length,
    outstanding: sum((b) => n(b.outstanding_amount ?? bdDue(b))),
    margin: sum((b) => n(b.marginAmount)),
    interest: sum((b) => (bdServiced(b) ? 0 : n(b.interestAmount))),
    tds: sum((b) => (bdServiced(b) ? 0 : n(b.tdsAmount))),
    receipt: sum((b) => n(b.receiptAmount))
  }
}
const isTradingParty = (p: Row): boolean => s(p.business_type).trim().toLowerCase() === 'trading'

// =============================================================== the palette

const T = {
  forest: '#0B3D2E',
  navy: '#1A2C56',
  lime: '#C7F03F',
  limeInk: '#0B3D2E',
  muted: '#8FBFA8',
  sky: '#A9C8EA',
  ground: '#F1F5EF',
  card: '#FFFFFF',
  border: '#D6E2D6',
  field: '#C3D2C6',
  rule: '#EAF0E9',
  rule2: '#EFF3EE',
  head: '#F7FAF6',
  headRule: '#E4ECE3',
  ink: '#0A1F17',
  inkMid: '#33473E',
  inkSoft: '#5A6B62',
  inkFaint: '#A8B8AE',
  green: '#0B6B45',
  greenBright: '#12855A',
  greenBg: '#F4FBF6',
  greenRule: '#BFE3CB',
  okBg: '#E9F5EE',
  warnBg: '#FFF4E0',
  warnInk: '#8A5300',
  warnRule: '#F0E4CB',
  warnMark: '#C2700A',
  alert: '#B3261E',
  alertInk: '#8C2F26',
  alertBg: '#FDF3F2',
  alertRule: '#F0D6D4',
  blue: '#1B4E82',
  blueBg: '#EAF0FA',
  blueRule: '#C6DAF0',
  sand: '#F7F4E8',
  sandRule: '#E5DFC8',
  chip: '#EFF5EC'
} as const

const MONO = "'IBM Plex Mono', ui-monospace, monospace"

// ================================================================== atoms

function Cap({ children, fg }: { children: React.ReactNode; fg?: string }): React.JSX.Element {
  return (
    <div className="text-[9.5px] font-extrabold uppercase tracking-[.11em]" style={{ color: fg || T.inkSoft }}>
      {children}
    </div>
  )
}

function Money({
  children,
  size = 14,
  fg,
  className
}: {
  children: React.ReactNode
  size?: number
  fg?: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={`whitespace-nowrap font-bold tracking-[-0.02em] ${className || ''}`}
      style={{ fontFamily: MONO, fontSize: size, color: fg || T.ink }}
    >
      {children}
    </div>
  )
}

function Tag({
  children,
  bg,
  fg,
  bd,
  size = 10
}: {
  children: React.ReactNode
  bg: string
  fg: string
  bd?: string
  size?: number
}): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[2px] px-1.5 py-[3px] font-extrabold tracking-[.05em]"
      style={{ background: bg, color: fg, border: bd ? `1px solid ${bd}` : undefined, fontSize: size }}
    >
      {children}
    </span>
  )
}

// A section card with a grey heading strip — the unit every screen is built of.
function Panel({
  title,
  right,
  tone,
  children,
  bodyClass
}: {
  title?: React.ReactNode
  right?: React.ReactNode
  tone?: 'green' | 'sand' | 'alert' | 'blue'
  children: React.ReactNode
  bodyClass?: string
}): React.JSX.Element {
  const head =
    tone === 'green'
      ? { bg: T.greenBg, bd: T.greenRule, fg: T.green }
      : tone === 'sand'
        ? { bg: T.sand, bd: T.sandRule, fg: T.navy }
        : tone === 'alert'
          ? { bg: T.alertBg, bd: T.alertRule, fg: T.alertInk }
          : tone === 'blue'
            ? { bg: T.blueBg, bd: T.blueRule, fg: T.navy }
            : { bg: T.head, bd: T.headRule, fg: T.ink }
  const frame = tone === 'green' ? T.greenRule : tone === 'alert' ? T.alertRule : tone === 'blue' ? T.blueRule : T.border
  return (
    <div className="flex-none overflow-hidden rounded-[4px] border bg-white" style={{ borderColor: frame }}>
      {title != null && (
        <div
          className="flex items-center justify-between gap-2.5 border-b px-[15px] py-[11px]"
          style={{ background: head.bg, borderColor: head.bd }}
        >
          <span className="text-[10.5px] font-extrabold uppercase tracking-[.13em]" style={{ color: head.fg }}>
            {title}
          </span>
          {right}
        </div>
      )}
      <div className={bodyClass ?? 'p-[15px]'}>{children}</div>
    </div>
  )
}

// A labelled field. Label above, control below — every form on every screen.
function Field({
  label,
  req,
  children,
  hint,
  hintFg,
  full
}: {
  label: React.ReactNode
  req?: boolean
  children: React.ReactNode
  hint?: React.ReactNode
  hintFg?: string
  full?: boolean
}): React.JSX.Element {
  return (
    <div className={full ? 'col-span-full' : 'min-w-0'}>
      <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.12em]" style={{ color: T.inkSoft }}>
        {label} {req && <span style={{ color: T.alert }}>*</span>}
      </div>
      {children}
      {hint != null && (
        <div className="mt-1.5 text-[11.5px] font-bold leading-[1.5]" style={{ color: hintFg || T.inkSoft }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function TextIn({
  value,
  onChange,
  placeholder,
  mono,
  big,
  bad,
  readOnly,
  inputMode
}: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  mono?: boolean
  big?: boolean
  bad?: boolean
  readOnly?: boolean
  inputMode?: 'decimal' | 'numeric' | 'text'
}): React.JSX.Element {
  return (
    <input
      value={value}
      readOnly={readOnly}
      inputMode={inputMode}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-[4px] border px-[11px] font-bold outline-none"
      style={{
        height: big ? 48 : 44,
        borderColor: bad ? T.alert : readOnly ? T.headRule : T.field,
        background: readOnly ? T.head : '#fff',
        color: readOnly ? T.inkMid : T.ink,
        fontFamily: mono ? MONO : undefined,
        fontSize: big ? 17 : mono ? 14 : 13
      }}
    />
  )
}

const num = (v: string): string => v.replace(/[^0-9.-]/g, '')

function DateIn({ value, onChange, max, min }: { value: string; onChange: (v: string) => void; max?: string; min?: string }): React.JSX.Element {
  return (
    <div
      className="relative flex h-[44px] items-center gap-[9px] rounded-[4px] border bg-white px-[11px]"
      style={{ borderColor: T.field }}
    >
      <CalendarDays className="h-[18px] w-[18px] shrink-0" style={{ color: T.inkSoft }} />
      {/* A native date field — on a phone it opens the system's own picker,
          which is the one control here nobody has to learn. */}
      <input
        type="date"
        value={s(value).slice(0, 10)}
        max={max}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium outline-none"
        style={{ fontFamily: MONO, color: T.ink }}
      />
    </div>
  )
}

// A pill group: choose one of a few. The design draws these for every
// either/or on every form.
function Seg<K extends string>({
  value,
  options,
  onChange,
  wide
}: {
  value: K
  options: readonly { k: K; label: string }[]
  onChange: (k: K) => void
  wide?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`${wide ? 'flex' : 'inline-flex'} flex-wrap gap-[3px] rounded-[4px] border p-[3px]`}
      style={{ background: T.rule, borderColor: '#DCE7DB' }}
    >
      {options.map((o) => {
        const on = o.k === value
        return (
          <button
            key={o.k}
            type="button"
            onClick={() => onChange(o.k)}
            className={`${wide ? 'flex-1' : ''} flex h-9 items-center justify-center rounded-[2px] px-4 text-[12.5px] font-extrabold`}
            style={{ background: on ? T.forest : 'transparent', color: on ? '#fff' : T.inkMid }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Toggle({
  on,
  onClick,
  label,
  note
}: {
  on: boolean
  onClick: () => void
  label: React.ReactNode
  note?: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-[11px] py-[11px] text-left">
      <span
        className="mt-[1px] flex h-[25px] w-[44px] shrink-0 rounded-[3px] p-[3px]"
        style={{ background: on ? T.greenBright : '#C3D2C6', justifyContent: on ? 'flex-end' : 'flex-start' }}
      >
        <span className="h-[19px] w-[19px] rounded-[2px] bg-white" />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-extrabold" style={{ color: T.ink }}>
          {label}
        </span>
        {note != null && (
          <span className="mt-[3px] block text-[11.5px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
            {note}
          </span>
        )}
      </span>
    </button>
  )
}

// A searchable picker over one of the masters. The app's own dropdown, so it
// behaves as every other list in the app does — and the screens it sits on are
// marked role="dialog", which is what lets its list open in front of them.
function Pick({
  value,
  onChange,
  options,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; sub?: string }[]
  placeholder: string
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange} searchable={options.length > 6}>
      <SelectTrigger
        className="h-[44px] rounded-[4px] bg-white px-[11px] text-[13px] font-bold normal-case shadow-none"
        style={{ borderColor: T.field, color: value ? T.ink : T.inkSoft }}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
            {o.sub ? <span className="ml-1.5 text-[11px] opacity-60">{o.sub}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// The lender picker: a sheet up from the bottom with a tick per bank or NBFC.
// Ticks are held here until Apply, so tapping through three lenders does not
// redraw the list under the thumb three times.
function LenderSheet({
  title,
  allLabel,
  unit,
  options,
  value,
  onApply,
  onClose
}: {
  title: string
  allLabel: string
  unit: string
  options: { value: string; label: string; count: number }[]
  value: string[]
  onApply: (v: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [sel, setSel] = useState<string[]>(value)
  const [q, setQ] = useState('')
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
  const flip = (v: string): void => setSel((s0) => (s0.includes(v) ? s0.filter((x) => x !== v) : [...s0, v]))
  const Tick = ({ on }: { on: boolean }): React.JSX.Element => (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[3px] border-2"
      style={{ borderColor: on ? T.forest : T.field, background: on ? T.forest : '#fff' }}
    >
      {on && <Check className="h-3.5 w-3.5" style={{ color: T.lime }} />}
    </span>
  )
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative flex max-h-[80dvh] flex-col rounded-t-[10px] bg-white" style={{ color: T.ink }}>
        <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: T.rule }}>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-extrabold">{title}</div>
            <div className="text-[11px] font-semibold" style={{ color: T.inkSoft }}>
              Tick one or several — none ticked shows them all.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-[4px]" style={{ background: T.rule }}>
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
        {options.length > 6 && (
          <div className="px-4 pt-3">
            <div className="flex h-10 items-center gap-2 rounded-[4px] border px-3" style={{ borderColor: T.field }}>
              <Search className="h-4 w-4 shrink-0" style={{ color: T.inkSoft }} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none" />
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <button type="button" onClick={() => setSel([])} className="flex min-h-[48px] w-full items-center gap-3 rounded-[4px] px-2 text-left">
            <Tick on={sel.length === 0} />
            <span className="flex-1 text-[13.5px] font-extrabold">{allLabel}</span>
          </button>
          {shown.map((o) => {
            const on = sel.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => flip(o.value)}
                className="flex min-h-[48px] w-full items-center gap-3 rounded-[4px] px-2 text-left"
                style={{ background: on ? T.head : undefined }}
              >
                <Tick on={on} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{o.label}</span>
                <span className="shrink-0 text-[11px] font-bold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                  {o.count} {unit}{o.count === 1 ? '' : 's'}
                </span>
              </button>
            )
          })}
          {options.length === 0 && (
            <div className="px-2 py-6 text-center text-[12.5px] font-semibold" style={{ color: T.inkSoft }}>
              None on file yet — add them in the masters.
            </div>
          )}
        </div>
        <div className="flex gap-2.5 border-t px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3" style={{ borderColor: T.rule }}>
          <Btn onClick={() => setSel([])}>CLEAR</Btn>
          <div className="ml-auto">
            <Btn kind="lime" onClick={() => onApply(sel)} icon={<Check className="h-[19px] w-[19px]" />}>
              {sel.length === 0 ? 'SHOW ALL' : `SHOW ${sel.length}`}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

// One line of a money breakdown: label left, figure right.
type Line = { k: React.ReactNode; v: string; strong?: boolean; fg?: string; sub?: string; big?: boolean }
function Lines({ rows }: { rows: Line[] }): React.JSX.Element {
  return (
    <div>
      {rows.map((r, i) => (
        <div
          key={i}
          className="py-[9px]"
          style={{ borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${r.strong ? T.headRule : T.rule2}` }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span
              className="min-w-0 text-[12.5px] leading-[1.4]"
              style={{ color: r.strong ? T.ink : T.inkMid, fontWeight: r.strong ? 800 : 600 }}
            >
              {r.k}
            </span>
            <span
              className="shrink-0 whitespace-nowrap font-bold"
              style={{ fontFamily: MONO, fontSize: r.big ? 15 : 13, color: r.fg || T.ink }}
            >
              {r.v}
            </span>
          </div>
          {r.sub && (
            <div className="mt-[3px] text-[11px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
              {r.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// A progress strip: how much of the whole is taken.
function Bar({ pct, fg, rest }: { pct: number; fg: string; rest?: string }): React.JSX.Element {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex h-[7px] overflow-hidden rounded-[2px]" style={{ background: T.rule }}>
      <div className="h-full" style={{ width: `${p}%`, background: fg }} />
      {rest && <div className="h-full flex-1" style={{ background: rest }} />}
    </div>
  )
}

// ================================================================ screens

// Every full-screen step on this page — a detail, a form, a repayment — is one
// of these: a coloured header, a body that scrolls, a footer that does not.
// role="dialog" lets the pickers inside portal into it (see Pick).
function Screen({
  kicker,
  title,
  sub,
  head,
  headBg,
  onClose,
  children,
  footer
}: {
  kicker: string
  title: React.ReactNode
  sub?: React.ReactNode
  head?: React.ReactNode
  headBg?: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}): React.JSX.Element {
  const bg = headBg || T.forest
  const kickFg = bg === T.navy ? T.sky : T.muted
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[60] flex flex-col" style={{ background: T.ground }}>
      <div className="flex-none px-4 pb-[14px] pt-3.5 text-white" style={{ background: bg }}>
        <div className="flex items-start justify-between gap-3.5">
          <div className="min-w-0">
            <div className="text-[11px] font-extrabold uppercase tracking-[.14em]" style={{ color: kickFg }}>
              {kicker}
            </div>
            <div className="mt-[5px] text-[19px] font-extrabold leading-tight tracking-[-0.02em]">{title}</div>
            {sub != null && (
              <div className="mt-[5px] text-[12px] font-semibold leading-[1.45]" style={{ color: kickFg }}>
                {sub}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px]"
            style={{ background: 'rgba(255,255,255,.12)' }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {head}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
        <div className="flex flex-col gap-3">{children}</div>
      </div>
      <div
        className="flex flex-none flex-wrap items-center gap-2.5 border-t bg-white px-4 pb-[max(14px,env(safe-area-inset-bottom))] pt-3.5"
        style={{ borderColor: T.border }}
      >
        {footer}
      </div>
    </div>
  )
}

function Btn({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  grow,
  icon
}: {
  children: React.ReactNode
  onClick?: () => void
  kind?: 'go' | 'lime' | 'ghost' | 'danger' | 'navy'
  disabled?: boolean
  grow?: boolean
  icon?: React.ReactNode
}): React.JSX.Element {
  const st =
    kind === 'lime'
      ? { background: T.lime, color: T.limeInk, border: `1px solid ${T.lime}` }
      : kind === 'go'
        ? { background: T.forest, color: '#fff', border: `1px solid ${T.forest}` }
        : kind === 'navy'
          ? { background: T.navy, color: '#fff', border: `1px solid ${T.navy}` }
          : kind === 'danger'
            ? { background: T.alertBg, color: T.alert, border: `1.5px solid ${T.alertRule}` }
            : { background: '#fff', color: T.inkMid, border: `1.5px solid ${T.field}` }
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`${grow ? 'flex-1' : ''} flex h-12 items-center justify-center gap-[7px] whitespace-nowrap rounded-[4px] px-5 text-[13px] font-extrabold`}
      style={{ ...st, opacity: disabled ? 0.55 : 1 }}
    >
      {icon}
      {children}
    </button>
  )
}

// The line at the left of every form's footer: what the form is still waiting
// for, or that it is ready.
function Req({ missing }: { missing: string[] }): React.JSX.Element {
  const ok = missing.length === 0
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-[7px] text-[12px] font-bold leading-[1.4]"
      style={{ color: ok ? T.green : T.warnInk }}
    >
      {ok ? <CheckCircle2 className="h-[17px] w-[17px] shrink-0" /> : <Info className="h-[17px] w-[17px] shrink-0" />}
      <span className="min-w-0">{ok ? 'Ready to save' : `Still needed: ${missing.join(', ')}`}</span>
    </div>
  )
}

// ===================================================================== page

type LcChip = 'all' | 'running' | 'due' | 'matured' | 'repaid' | 'preclosed' | 'rejected'
// An application the bank turned down: listed, counted nowhere — as on the desktop.
const lcPreclosedEarly = (l: Row): boolean => {
  const closed = s(l.preclosed_date).slice(0, 10)
  const mat = s(l.expiry_date).slice(0, 10)
  return !!closed && !!mat && closed < mat
}
const LC_CHIP_TONE: Record<string, { fill: string; badge: string; badgeInk: string }> = {
  matured: { fill: '#8A5300', badge: '#F5C66B', badgeInk: '#4A2C00' },
  repaid: { fill: '#3F4E5A', badge: '#B8C6D1', badgeInk: '#1E2A33' },
  preclosed: { fill: '#0E5A78', badge: '#8FD3EA', badgeInk: '#06324A' },
  rejected: { fill: '#9B2C24', badge: '#F2B8B2', badgeInk: '#5C140F' }
}
const isLcRejected = (l: Row): boolean => s(l.workflow_status) === 'rejected' || s(l.display_status) === 'rejected'
type BdChip = 'all' | 'awaiting' | 'live' | 'repaid'
// The desktop register's due windows — cumulative, so "This week" is
// everything maturing within 7 days, overdue included.
const BD_PERIODS: { k: string; label: string; maxDays?: number }[] = [
  { k: 'all', label: 'All' },
  { k: 't1', label: 'T+1 due', maxDays: 1 },
  { k: 'week', label: 'This week', maxDays: 7 },
  { k: 'fortnight', label: 'Fortnight', maxDays: 14 }
]

export function TreasuryMobile({
  focusLcId = null,
  focusBdId = null,
  onFocusHandled
}: { focusLcId?: number | null; focusBdId?: number | null; onFocusHandled?: () => void } = {}): React.JSX.Element {
  // Opened on one LC or bill (the dashboard, a ledger): its tab, and the bill.
  const [tab, setTab] = useState<'lc' | 'bd' | 'tracker'>(() => (Number(focusBdId) ? 'bd' : 'lc'))
  // The Payment tracker, as on the desktop: every dated payment in and out.
  const [tracker, setTracker] = useState<Row[]>([])
  const [trackerLoading, setTrackerLoading] = useState(false)
  const sessionUser = useMemo(() => loadUser(), [])
  const mayTrack = !sessionUser || canAccess(sessionUser, 'treasuryTracker')
  // Which screen the bill's Repay sheet opens on — the tracker's "Pay
  // interest" opens it on the interest side.
  const [repayKind, setRepayKind] = useState<'full' | 'interest'>('full')
  const [query, setQuery] = useState('')
  // Running first, as the desktop register opens — "All" also counted every
  // repaid LC, so the phone opened on a different list from the browser.
  const [lcChip, setLcChip] = useState<LcChip>('running')
  // Open, as the desktop register lands — "All bills" dragged in every
  // repaid one and the two screens opened on different lists.
  const [bdChip, setBdChip] = useState<BdChip>('live')
  // The desktop's two other trays: when it falls due, and PID or SID.
  const [bdPeriod, setBdPeriod] = useState('all')
  const [bdType, setBdType] = useState<'PID' | 'SID' | null>(null)
  const [limitOpen, setLimitOpen] = useState(false)
  // Which lenders are in view, as on the desktop header: BANKS on the LC tab,
  // NBFCs on Bill Discounting. Several may be ticked; none ticked is all.
  const [lcBanks, setLcBanks] = useState<string[]>([])
  const [bdNbfcs, setBdNbfcs] = useState<string[]>([])
  const [lenderOpen, setLenderOpen] = useState(false)
  // A facility limit belongs to one bank, so it narrows only when exactly one
  // is picked — several fall back to the all-banks figure, as on the desktop.
  const soleBank = lcBanks.length === 1 ? lcBanks[0] : ''
  const soleBankRef = useRef(soleBank)
  soleBankRef.current = soleBank

  const [lcs, setLcs] = useState<Row[]>([])
  const [bills, setBills] = useState<Row[]>([])
  const [limit, setLimit] = useState<Row>({})
  // The NBFC sanctions, for the band's Available limit.
  const [bdLimits, setBdLimits] = useState<Row | null>(null)
  const [company, setCompany] = useState('')
  const [banks, setBanks] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [facilities, setFacilities] = useState<Row[]>([])
  const [nbfcs, setNbfcs] = useState<Row[]>([])
  const [orders, setOrders] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  // What is open over the list. One at a time — each is a full screen.
  const [detail, setDetail] = useState<{ kind: 'lc' | 'bd'; id: number } | null>(() =>
    Number(focusBdId) ? { kind: 'bd', id: Number(focusBdId) } : Number(focusLcId) ? { kind: 'lc', id: Number(focusLcId) } : null
  )
  useEffect(() => {
    const bd = Number(focusBdId) || 0
    const lc = Number(focusLcId) || 0
    if (!bd && !lc) return
    setTab(bd ? 'bd' : 'lc')
    setDetail(bd ? { kind: 'bd', id: bd } : { kind: 'lc', id: lc })
    onFocusHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBdId, focusLcId])
  const [lcForm, setLcForm] = useState<Row | null>(null)
  const [bdForm, setBdForm] = useState<Row | null>(null)
  const [stageRow, setStageRow] = useState<Row | null>(null)
  const [payInRow, setPayInRow] = useState<Row | null>(null)
  const [precloseRow, setPrecloseRow] = useState<Row | null>(null)
  // A closure being corrected rather than made, and the LC whose
  // installments to the supplier are open.
  const [editCloseRow, setEditCloseRow] = useState<Row | null>(null)
  const [payPartyRow, setPayPartyRow] = useState<Row | null>(null)
  const [bdPartyRow, setBdPartyRow] = useState<Row | null>(null)
  const [repayRow, setRepayRow] = useState<Row | null>(null)
  const [delTarget, setDelTarget] = useState<{ kind: 'lc' | 'bd'; row: Row } | null>(null)

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. See useLiveRefresh.
    if (!background) setLoading(true)
    try {
      const [l, bd, lim, act, comps, bnk, sup, cust, fac, nb, od, bdl] = await Promise.all([
        window.api.lc.list(),
        // Bill Discounting has thrown on a database missing bd_parties before
        // now, and this screen must not go blank because of it.
        window.api.billDiscounting.list().catch(() => [] as Row[]),
        window.api.lc.getLimit(soleBankRef.current ? Number(soleBankRef.current) : undefined).catch(() => ({}) as Row),
        window.api.company.getActive().catch(() => ({ id: 0 })),
        window.api.company.list().catch(() => [] as Row[]),
        window.api.data.list('banks').catch(() => [] as Row[]),
        window.api.data.list('suppliers').catch(() => [] as Row[]),
        window.api.data.list('customers').catch(() => [] as Row[]),
        window.api.facility.list().catch(() => [] as Row[]),
        window.api.data.list('nbfcs').catch(() => [] as Row[]),
        window.api.orders.list('treasury').catch(() => [] as Row[]),
        window.api.billDiscounting.limits().catch(() => null)
      ])
      setLcs(l.filter((x) => s(x.facility_type || 'lc') === 'lc'))
      setBills(bd)
      setLimit(lim || {})
      setCompany(s(comps.find((c) => Number(c.id) === Number(act?.id))?.name))
      setBanks(bnk.filter((x) => x.active !== 0 && x.active !== false))
      setSuppliers(sup.filter((x) => x.active !== 0 && x.active !== false))
      setCustomers(cust.filter((x) => x.active !== 0 && x.active !== false))
      setFacilities(fac)
      setNbfcs(nb.filter((x) => x.active !== 0 && x.active !== false))
      setOrders(od)
      setBdLimits((bdl as Row | null) || null)
      void window.api.treasury
        .paymentTracker()
        .then(setTracker)
        .catch(() => undefined)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (tab !== 'tracker') return
    setTrackerLoading(true)
    void window.api.treasury
      .paymentTracker()
      .then(setTracker)
      .catch(() => undefined)
      .finally(() => setTrackerLoading(false))
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  // The facility card follows the bank picked. Skipped on the first render —
  // load() has just read the all-banks figure.
  const firstLimit = useRef(true)
  useEffect(() => {
    if (firstLimit.current) {
      firstLimit.current = false
      return
    }
    let gone = false
    void window.api.lc
      .getLimit(soleBank ? Number(soleBank) : undefined)
      .then((lim) => !gone && setLimit(lim || {}))
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [soleBank])

  // One box, both lists. Someone looking for "SBI" or a party does not want to
  // pick the instrument first.
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])
  const match = useCallback(
    (hay: string) => {
      if (!terms.length) return true
      const h = hay.toLowerCase()
      return terms.every((t) => h.includes(t))
    },
    [terms]
  )

  const searchedLcs = useMemo(
    () =>
      lcs.filter((l) =>
        (!lcBanks.length || lcBanks.includes(s(l.our_bank_id))) &&
        match(
          [l.lc_no, l.supplier_name, l.receivable_party_name, l.bank, l.bank_name, l.our_bank_name, l.display_status, l.stage]
            .map(s)
            .join(' ')
        )
      ),
    [lcs, match, lcBanks]
  )
  // The lender and the search — what the instrument tab counts, as the LC
  // tab counts its bank and search.
  const lenderBills = useMemo(
    () =>
      bills.filter(
        (b) =>
          (!bdNbfcs.length || bdNbfcs.includes(s(b.nbfc_id))) &&
          match([b.bd_no, b.party_names, b.supplier_name, b.customer_name, b.nbfc_name, b.finance_type, b.status].map(s).join(' '))
      ),
    [bills, match, bdNbfcs]
  )
  // Then the due window and PID/SID — everything but the stage, as the desktop
  // builds it, so the stage chips count within them as its tabs do.
  const searchedBills = useMemo(() => {
    const maxDays = BD_PERIODS.find((p) => p.k === bdPeriod)?.maxDays
    return lenderBills.filter((b) => {
      if (bdType && s(b.finance_type) !== bdType) return false
      if (maxDays == null) return true
      const d = daysTo(b.maturity_date)
      return d != null && d <= maxDays
    })
  }, [lenderBills, bdType, bdPeriod])

  // The picker's options and what its button reads.
  const lenderOpts = tab === 'lc'
    ? banks.map((b) => ({ value: String(b.id), label: s(b.name) || `Bank ${b.id}`, count: lcs.filter((l) => s(l.our_bank_id) === String(b.id)).length }))
    : nbfcs.map((x) => ({ value: String(x.id), label: s(x.name) || `NBFC ${x.id}`, count: bills.filter((b) => s(b.nbfc_id) === String(x.id)).length }))
  const lenderSel = tab === 'lc' ? lcBanks : bdNbfcs
  const lenderText =
    lenderSel.length === 0
      ? tab === 'lc' ? 'All my banks' : 'All my NBFCs'
      : lenderSel.length === 1
        ? lenderOpts.find((o) => o.value === lenderSel[0])?.label || '1 selected'
        : `${lenderSel.length} ${tab === 'lc' ? 'banks' : 'NBFCs'}`

  // The quick filters, each with its count — the same buckets the desktop
  // register uses, drawn as chips because on a phone a chip is one tap.
  const lcIn: Record<LcChip, (l: Row) => boolean> = {
    all: () => true,
    running: (l) => !l.preclosed_date && !isLcPastMaturity(l) && !isLcRejected(l),
    // Due inside a week, overdue included — the way anybody chasing money means it.
    due: (l) => {
      if (l.preclosed_date || isLcRejected(l)) return false
      const d = daysTo(l.next_due_date || l.expiry_date)
      return d != null && d <= 7
    },
    matured: (l) => isLcPastMaturity(l) && !l.preclosed_date && !isLcRejected(l),
    // Repaid = wound up on or after maturity; Preclosed = before it (as the desktop).
    repaid: (l) => !!l.preclosed_date && !lcPreclosedEarly(l) && !isLcRejected(l),
    preclosed: (l) => lcPreclosedEarly(l) && !isLcRejected(l),
    rejected: isLcRejected
  }
  const bdIn: Record<BdChip, (b: Row) => boolean> = {
    all: () => true,
    awaiting: bdAwaiting,
    live: (b) => s(b.stage) === 'live',
    repaid: (b) => s(b.stage) === 'repaid'
  }
  // A stage card tapped: only the LCs at that stage, still open and not
  // rejected — what the card's own total counts.
  const [lcStage, setLcStage] = useState<string | null>(null)
  const [trackerPreset, setTrackerPreset] = useState<{ win: string; dir: string; n: number } | null>(null)
  const shownLcs = useMemo(
    () =>
      searchedLcs.filter(
        (l) =>
          (lcStage
            ? !l.preclosed_date && !isLcRejected(l) && s(l.stage || 'application') === lcStage
            : lcIn[lcChip](l))
      ),
    [searchedLcs, lcChip, lcStage] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const shownBills = useMemo(() => searchedBills.filter(bdIn[bdChip]), [searchedBills, bdChip]) // eslint-disable-line react-hooks/exhaustive-deps
  // The band describes what is on screen, and says "of" the whole book when a
  // chip, the search or the NBFC picker has narrowed it — as the desktop does.
  const bdK = useMemo(() => bdKpis(shownBills), [shownBills])
  const bdKAll = useMemo(() => bdKpis(bills), [bills])
  const bdNarrowed = shownBills.length !== bills.length
  // "of" the whole book — said only when it is a different figure. On the
  // Open chip most of the book IS open, and "₹0 of ₹0" is not information.
  const bdOf = (part: number, whole: number): string | undefined =>
    bdNarrowed && Math.abs(whole - part) > 0.004 ? `of ${inrShort(whole)}` : undefined
  // Sanctioned less what is drawn — the desktop's rule exactly: the picked
  // NBFCs' own lines against what those NBFCs hold, or with none picked the
  // effective ceiling against the whole book.
  const bdAvail = useMemo((): { v: number; of: number; basis: string } | null => {
    if (!bdLimits) return null
    if (bdNbfcs.length) {
      const lines = ((bdLimits.per_nbfc || []) as Row[]).filter((x) => bdNbfcs.includes(String(x.id)))
      const sanctioned = round2(lines.reduce((t, x) => t + n(x.sanctioned), 0))
      if (sanctioned <= 0) return null
      const drawn = bdKpis(bills.filter((b) => bdNbfcs.includes(s(b.nbfc_id)))).outstanding
      return {
        v: round2(sanctioned - drawn),
        of: sanctioned,
        basis: lines.length === 1 ? s(lines[0].name) || 'this NBFC' : `${lines.length} NBFC lines`
      }
    }
    if (bdLimits.effective_limit == null) return null
    return {
      v: round2(n(bdLimits.effective_limit) - bdKAll.outstanding),
      of: n(bdLimits.effective_limit),
      basis: bdLimits.effective_basis === 'lines' ? 'NBFC lines' : 'combined'
    }
  }, [bdLimits, bdNbfcs, bills, bdKAll.outstanding])

  // The desktop's three states first, in its order; then the phone's own
  // quick filters.
  const lcChips: { k: LcChip; label: string }[] = [
    { k: 'running', label: 'Running' },
    { k: 'matured', label: 'Matured' },
    { k: 'repaid', label: 'Repaid' },
    { k: 'preclosed', label: 'Preclosed' },
    // Only once there is one — most books will never have a rejection.
    ...(lcs.some(isLcRejected) ? [{ k: 'rejected' as LcChip, label: 'Rejected' }] : []),
    { k: 'due', label: 'Due this week' },
    { k: 'all', label: 'All' }
  ]
  const bdChips: { k: BdChip; label: string }[] = [
    { k: 'all', label: 'All bills' },
    { k: 'awaiting', label: 'Awaiting' },
    { k: 'live', label: 'Open' },
    { k: 'repaid', label: 'Repaid' }
  ]

  // The three figures the header carries, per instrument — off the same
  // arrays the cards below are drawn from, so the header cannot contradict them.
  const kpis = useMemo(() => {
    // Late, and what moves in the next three days — the canvas's three.
    if (tab === 'tracker') return trackerHeadline(tracker)
    if (tab === 'bd') {
      // The desktop band's lead figures, for the bills on screen. "Received"
      // was the money back from customers (Payment IN), which the desktop
      // band does not report — its Received is what the NBFC sent.
      return [
        { k: 'Open bills', v: String(bdK.count), go: 'bd:live' },
        { k: 'Outstanding', v: inrShort(bdK.outstanding), go: 'bd:live' },
        { k: 'Received', v: inrShort(bdK.receipt), go: 'bd:all' }
      ]
    }
    // The desktop band's three stage figures, read off the same facility
    // summary (lc.getLimit) — so the phone and the browser cannot disagree.
    // "Received" here used to be money IN from customers, which the desktop
    // does not show at all, and read ₹0 beside a band showing crores paid.
    return [
      { k: 'Application', v: inrShort(n(limit.application)), go: 'lc:application' },
      { k: 'Open', v: inrShort(n(limit.open)), go: 'lc:open' },
      { k: 'Payment received', v: inrShort(n(limit.payment_received)), go: 'lc:payment_received' }
    ]
  }, [tab, bdK, limit, tracker])

  // The facility's whole limit — fixed plus convertible when it is on — as the
  // desktop shows it. `limit_amount` is not a field getLcLimit returns.
  const sanctioned = n(limit.total_limit ?? limit.fixed_limit)
  const utilised = n(limit.utilized)
  const available = n(limit.available ?? limit.lc_net_available)
  const drawnPct = sanctioned > 0 ? (utilised / sanctioned) * 100 : 0

  // --- the actions a card can offer, by the LC's own stage -----------------
  type Act = { label: string; kind: 'go' | 'lime' | 'ghost' | 'navy'; go: () => void }
  function lcActions(l: Row): { primary: Act; second?: Act } {
    const next = nextLcStage(s(l.stage || 'application'))
    const view: Act = { label: 'View', kind: 'ghost', go: () => setDetail({ kind: 'lc', id: Number(l.id) }) }
    const pre: Act = {
      label: n(l.parts_count) > 0 ? 'Parts' : isLcPastMaturity(l) ? 'Repay' : 'Preclose',
      kind: 'ghost',
      // Paid in parts: each part is repaid on its own — the parts screen.
      go: () => (n(l.parts_count) > 0 ? setPayPartyRow(l) : setPrecloseRow(l))
    }
    // Rejected: nothing to advance; a rejection made in error can be undone.
    if (isLcRejected(l)) {
      return {
        primary: view,
        second: {
          label: 'Reinstate',
          kind: 'ghost',
          go: () => {
            if (!window.confirm(`Reinstate ${s(l.lc_no) || 'this application'}? It goes back to Application and counts against the limit again.`)) return
            void window.api.lc
              .reinstate(Number(l.id))
              .then(() => {
                toast.success('Application reinstated')
                void load(true)
              })
              .catch((e) => toast.error((e as Error).message))
          }
        }
      }
    }
    if (next) {
      return {
        primary: { label: next === 'open' ? 'Mark open' : 'Payment received', kind: 'navy', go: () => setStageRow(l) },
        second: canPreclose(l) ? pre : undefined
      }
    }
    // The bank still owes the supplier part of this LC: paying it comes first.
    if (canPayParty(l)) {
      return {
        primary: { label: 'Pay party', kind: 'go', go: () => setPayPartyRow(l) },
        second: canPreclose(l) ? pre : undefined
      }
    }
    if (canMarkPaymentIn(l)) {
      return {
        primary: { label: 'Payment in', kind: 'go', go: () => setPayInRow(l) },
        second: canPreclose(l) ? pre : undefined
      }
    }
    if (canPreclose(l)) return { primary: { ...pre, kind: 'go' } }
    // Repaid in parts: its parts — where the last repayment can be taken back.
    if (l.preclosed_date && n(l.parts_count) > 0) return { primary: view, second: { label: 'Parts', kind: 'ghost', go: () => setPayPartyRow(l) } }
    // Repaid: the closure's own figures can still be corrected.
    if (l.preclosed_date) return { primary: view, second: { label: 'Edit closure', kind: 'ghost', go: () => setEditCloseRow(l) } }
    return { primary: view }
  }

  function openNewLc(): void {
    // The bank in view opens the LC; failing that, the only bank there is.
    const openAt = soleBank || (banks.length === 1 ? String(banks[0].id) : '')
    setLcForm({
      open_date: todayISO(),
      usance_days: '',
      margin_pct: '',
      interest_pct: '',
      charges: '',
      purpose: 'manufacturing',
      workflow_status: 'in_progress',
      stage: 'application',
      our_bank_id: openAt,
      linked_order_ids: []
    })
  }
  function openNewBill(): void {
    // With one NBFC in view the bill starts on it, with its own terms filled
    // in — the same blanks picking it in the form would have filled. Only if
    // it discounts supplier bills, which is what a new bill starts as.
    const x = bdNbfcs.length === 1 ? nbfcs.find((y) => String(y.id) === bdNbfcs[0]) : undefined
    const prov = x ? s(x.provides || x.finance_types || x.finance_type).toUpperCase() : ''
    const pre = x && (!prov || prov.includes('PID') || prov.includes('BOTH')) ? x : undefined
    setBdForm({
      nbfc_id: pre ? String(pre.id) : '',
      finance_type: 'PID',
      party_type: 'supplier',
      purpose: 'manufacturing',
      maturity_date: '',
      invoice_amount: '',
      invoice_adj: '',
      open_adj: '',
      interest_after_adj: false,
      amount: '',
      margin_pct: pre && n(pre.margin_pct) ? String(pre.margin_pct) : '',
      interest_pct: pre && n(pre.interest_pct) ? String(pre.interest_pct) : '',
      tds_pct: pre && n(pre.tds_pct) ? String(pre.tds_pct) : '',
      days_year: 360,
      days_incl_start: false,
      interest_upfront: false,
      interest_mode: 'discounted',
      interest_freq: 'monthly',
      receivable_party_id: '',
      linked_order_ids: [],
      // A PID's money goes to the supplier; a SID's lands in our bank.
      disbursement_route: 'supplier',
      disbursement_account: ''
    })
  }
  function openEditBill(b: Row): void {
    setBdForm({
      ...b,
      id: b.id,
      bd_no: s(b.bd_no),
      nbfc_id: b.nbfc_id ? String(b.nbfc_id) : '',
      party_id: b.party_id ? String(b.party_id) : '',
      receivable_party_id: b.receivable_party_id ? String(b.receivable_party_id) : '',
      invoice_amount: b.invoice_amount ?? '',
      invoice_adj: n(b.invoice_adj) ? b.invoice_adj : '',
      // The Open amount: stored as is on the charge basis; an older bill
      // stored Open ± Adj, so the open figure is taken back out (and saving
      // moves it onto the charge basis), as the desktop does.
      open_adj: n(b.open_adj) ? b.open_adj : '',
      amount: b.amount == null ? '' : String(n(b.open_adj_charge) ? n(b.amount) : round2(n(b.amount) - n(b.open_adj))),
      amount_touched: true,
      payment_in_expected: !!Number(b.payment_in_expected),
      interest_upfront: !!Number(b.interest_upfront),
      days_incl_start: !!Number(b.days_incl_start),
      interest_after_adj: !!Number(b.interest_after_adj),
      // Everything the bill already carries that this form does not edit —
      // every party (the first is the primary), their split, and the purchase
      // invoices a trading bill is linked to. Sent back as they are, so a
      // phone edit no longer replaces them with one party and no links.
      _orig_party_type: s(b.party_type),
      party_ids: s(b.party_ids_csv).split(',').filter(Boolean).map(Number),
      party_amounts: Object.fromEntries(
        s(b.party_split_csv)
          .split(',')
          .filter(Boolean)
          .map((pair) => {
            const [pid, amt] = pair.split(':')
            return [String(pid), Number(amt) === 0 ? '' : amt]
          })
      ),
      linked_order_ids: s(b.linked_order_ids_csv).split(',').filter(Boolean).map(Number),
      disbursement_route: s(b.disbursement_route) || 'unconfirmed',
      disbursement_account: s(b.disbursement_account)
    })
  }

  // After any save: re-read everything, so the card, the header and the
  // facility all show what the server now holds rather than what was typed.
  const afterSave = async (): Promise<void> => {
    await load(true)
  }

  // A TRACKER CARD'S BUTTON opens the sheet that settles it — Preclose or
  // Payment in on an LC, Repay or Pay interest on a bill — never a tick of
  // its own. The phone has no Payment in sheet for a bill, so that card
  // carries no button here (it does on the desktop).
  const trackerCanAct = (r: Row): boolean => {
    if (r.src === 'bd' && !r.settled && r.action === 'payin') return false
    return !sessionUser || canAccess(sessionUser, r.src === 'lc' ? 'treasuryLc' : 'treasuryBd')
  }
  const trackerAction = (r: Row): void => {
    const id = Number(r.src_id)
    if (r.src === 'lc') {
      const l = lcs.find((x) => Number(x.id) === id)
      if (!l) return void toast.error('That LC is no longer in this company\u2019s register')
      if (!r.settled && (r.action === 'repay' || r.action === 'preclose') && !l.preclosed_date && s(l.stage) === 'payment_received') return setPrecloseRow(l)
      if (!r.settled && r.action === 'payin') return setPayInRow(l)
      return setDetail({ kind: 'lc', id })
    }
    const b = bills.find((x) => Number(x.id) === id)
    if (!b) return void toast.error('That bill is no longer in this company\u2019s register')
    if (!r.settled && (r.action === 'repay' || r.action === 'interest')) {
      setRepayKind(r.action === 'interest' ? 'interest' : 'full')
      return setRepayRow(b)
    }
    return setDetail({ kind: 'bd', id })
  }

  const detailRow =
    detail?.kind === 'lc'
      ? lcs.find((x) => Number(x.id) === detail.id)
      : detail?.kind === 'bd'
        ? bills.find((x) => Number(x.id) === detail.id)
        : undefined

  return (
    <div className="flex min-h-[100dvh] flex-col" style={{ background: T.ground, color: T.ink }}>
      {/* Header. Pinned, because the three figures are the reason the page is
          opened and scrolling a list should not cost them. */}
      <div className="sticky top-0 z-20 flex-none px-4 pb-[13px] pt-2.5 text-white" style={{ background: T.forest }}>
        <MobileBar onRefresh={() => load()} />
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-[9px]">
            <Landmark className="h-[22px] w-[22px] shrink-0" style={{ color: T.lime }} />
            <div className="min-w-0">
              <div className="text-[19px] font-extrabold tracking-[-0.02em]">Treasury</div>
              <div className="truncate text-[10.5px] font-bold" style={{ color: T.muted }}>
                {company || '—'}
              </div>
            </div>
          </div>
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px]"
            style={{ background: 'rgba(255,255,255,.1)' }}
            aria-hidden
          >
            <Bell className="h-[21px] w-[21px]" />
          </div>
        </div>
        <div className="mt-[11px] flex gap-[9px]">
          {kpis.map((k, i) => {
            // Tapping a card opens what it counts: an LC stage, or the bills.
            const go = (k as { go?: string }).go
            const on = !!go && go === `lc:${lcStage}`
            return (
            <button
              type="button"
              key={k.k}
              disabled={!go}
              onClick={() => {
                if (!go) return
                const [where, what, dirKey] = go.split(':')
                if (where === 'tr') {
                  setTab('tracker')
                  setTrackerPreset({ win: what, dir: dirKey || 'all', n: Date.now() })
                } else if (where === 'lc') {
                  setTab('lc')
                  setLcStage((cur) => (cur === what ? null : what))
                } else {
                  setTab('bd')
                  setBdChip(what as BdChip)
                }
              }}
              className="min-w-0 flex-1 rounded-[4px] px-2.5 py-[9px] text-left disabled:cursor-default"
              style={{
                background: on ? 'rgba(199,240,63,.28)' : i === 1 ? 'rgba(199,240,63,.14)' : 'rgba(255,255,255,.08)',
                boxShadow: on ? 'inset 0 0 0 1.5px #C7F03F' : undefined
              }}
            >
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.1em]" style={{ color: T.muted }}>
                {k.k}
              </div>
              <div
                className="mt-0.5 whitespace-nowrap text-[13.5px] font-bold tracking-[-0.03em]"
                style={{ fontFamily: MONO, color: i === 1 ? T.lime : '#fff' }}
              >
                {k.v}
              </div>
            </button>
            )
          })}
        </div>
      </div>

      {/* Instrument tabs. Two, so each takes half the width. */}
      <div className="flex flex-none border-b bg-white" style={{ borderColor: T.border }}>
        {([
          { key: 'lc' as const, label: mayTrack ? 'LCs' : 'Letters of credit', count: searchedLcs.length },
          { key: 'bd' as const, label: mayTrack ? 'Bills' : 'Bill discounting', count: lenderBills.length },
          ...(mayTrack ? [{ key: 'tracker' as const, label: 'Due', count: tracker.filter((x) => !x.settled).length }] : [])
        ]).map((t) => {
          const on = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-selected={on}
              className="flex h-12 min-w-0 flex-1 items-center justify-center gap-[7px] text-[12.5px] font-extrabold"
              style={{
                borderBottom: `3px solid ${on ? T.forest : 'transparent'}`,
                background: on ? T.head : '#fff',
                color: on ? T.ink : T.inkSoft
              }}
            >
              {t.label}
              <span
                className="rounded-[2px] px-1.5 py-[2px] text-[10px] font-bold"
                style={{ fontFamily: MONO, background: on ? T.forest : T.rule, color: on ? T.lime : T.inkSoft }}
              >
                {t.count}
              </span>
            </button>
          )
        })}
      </div>

      {tab === 'tracker' && (
        <PaymentTrackerMobile rows={tracker} loading={trackerLoading} onAction={trackerAction} canAct={trackerCanAct} preset={trackerPreset} />
      )}
      {tab !== 'tracker' && (
      <>
      {/* Search, then the quick filters as a row that scrolls sideways. */}
      <div className="flex flex-none flex-col gap-[9px] border-b bg-white px-4 py-2.5" style={{ borderColor: T.border }}>
        {/* The lender in view — a bank for LCs, an NBFC for discounted bills.
            It scopes everything below it and the header figures above. */}
        <button
          type="button"
          onClick={() => setLenderOpen(true)}
          className="flex h-11 items-center gap-[9px] rounded-[4px] border px-3 text-left"
          style={{
            borderColor: lenderSel.length ? T.forest : T.field,
            background: lenderSel.length ? T.head : '#fff'
          }}
        >
          <Landmark className="h-[18px] w-[18px] shrink-0" style={{ color: T.forest }} />
          <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-[.1em]" style={{ color: T.inkSoft }}>
            {tab === 'lc' ? 'Bank' : 'NBFC'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold" style={{ color: T.ink }}>
            {lenderText}
          </span>
          {lenderSel.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Show all"
              onClick={(e) => {
                e.stopPropagation()
                if (tab === 'lc') setLcBanks([])
                else setBdNbfcs([])
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] bg-white"
            >
              <X className="h-4 w-4" style={{ color: T.inkSoft }} />
            </span>
          )}
          <ChevronDown className="h-5 w-5 shrink-0" style={{ color: T.inkSoft }} />
        </button>
        <div className="flex h-11 items-center gap-[9px] rounded-[4px] border px-3" style={{ borderColor: T.field }}>
          <Search className="h-[19px] w-[19px] shrink-0" style={{ color: T.inkSoft }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'lc' ? 'Search LC no, bank, supplier…' : 'Search BD no, NBFC, party…'}
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none placeholder:text-[#8FA79B]"
          />
          {!!query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
              <X className="h-4 w-4" style={{ color: T.inkSoft }} />
            </button>
          )}
        </div>
        <div className="flex gap-[7px] overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tab === 'lc' && lcStage && (
            <button
              type="button"
              onClick={() => setLcStage(null)}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-[4px] px-3 text-[13px] font-extrabold"
              style={{ background: '#0B3D2E', color: '#C7F03F' }}
            >
              Stage: {STAGE_LABEL[lcStage] || lcStage} · {shownLcs.length}
              <X className="h-4 w-4" />
            </button>
          )}
          {(tab === 'lc' ? lcChips : bdChips).map((c) => {
            const on = tab === 'lc' ? !lcStage && lcChip === c.k : bdChip === c.k
            const tone = (tab === 'lc' && LC_CHIP_TONE[c.k]) || { fill: T.forest, badge: T.lime, badgeInk: T.limeInk }
            const count =
              tab === 'lc'
                ? searchedLcs.filter(lcIn[c.k as LcChip]).length
                : searchedBills.filter(bdIn[c.k as BdChip]).length
            return (
              <button
                key={c.k}
                type="button"
                onClick={() => {
                  if (tab === 'lc') {
                    setLcChip(c.k as LcChip)
                    setLcStage(null)
                  } else setBdChip(c.k as BdChip)
                }}
                className="flex h-10 shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[4px] border px-[13px] text-[12px] font-extrabold"
                style={{
                  borderColor: on ? tone.fill : T.field,
                  background: on ? tone.fill : '#fff',
                  color: on ? '#fff' : T.inkMid
                }}
              >
                {c.label}
                <span
                  className="rounded-[9px] px-[7px] py-[2px] text-[10.5px] font-bold"
                  style={{ fontFamily: MONO, background: on ? tone.badge : T.rule, color: on ? tone.badgeInk : T.inkSoft }}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
        {/* The desktop's due-window and PID/SID trays, one row under the
            stage. Two joined bars rather than six loose chips, so the whole
            row fits a phone and a pick on the right is never scrolled out of
            sight. PID/SID toggles off on a second tap, as it does there. */}
        {tab === 'bd' && (
          <div className="flex items-stretch gap-2">
            {[
              { opts: BD_PERIODS.map((p) => ({ k: p.k, label: p.label })), on: (k: string) => bdPeriod === k, pick: (k: string) => setBdPeriod(k), grow: true },
              {
                opts: [
                  { k: 'PID', label: 'PID', title: 'Purchase Invoice Discounting' },
                  { k: 'SID', label: 'SID', title: 'Sales Invoice Discounting' }
                ],
                on: (k: string) => bdType === k,
                pick: (k: string) => setBdType(bdType === k ? null : (k as 'PID' | 'SID')),
                grow: false
              }
            ].map((g, gi) => (
              <div
                key={gi}
                className={cn('flex h-8 overflow-hidden rounded-[4px] border', g.grow ? 'min-w-0 flex-1' : 'shrink-0')}
                style={{ borderColor: T.field }}
              >
                {g.opts.map((o, i) => {
                  const on = g.on(o.k)
                  return (
                    <button
                      key={o.k}
                      type="button"
                      onClick={() => g.pick(o.k)}
                      title={'title' in o ? String(o.title) : undefined}
                      aria-pressed={on}
                      className={cn('whitespace-nowrap text-[11px] font-extrabold', g.grow ? 'min-w-0 flex-auto px-1.5' : 'px-[11px]')}
                      style={{
                        background: on ? T.navy : '#fff',
                        color: on ? '#fff' : T.inkMid,
                        borderLeft: i ? `1px solid ${on || g.on(g.opts[i - 1].k) ? T.navy : T.field}` : 'none'
                      }}
                    >
                      {o.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pb-6 pt-3">
        {loading ? (
          <div className="py-16 text-center text-[13px] font-semibold" style={{ color: T.inkSoft }}>
            Reading the treasury…
          </div>
        ) : tab === 'lc' ? (
          <>
            {/* The facility, before the LCs drawn on it — "is there room"
                comes before "what is out". Collapsed to the one figure that
                answers that; the full breakdown opens under it. */}
            <div className="flex-none overflow-hidden rounded-[4px] border bg-white" style={{ borderColor: T.border }}>
              <button
                type="button"
                onClick={() => setLimitOpen((o) => !o)}
                className="flex w-full flex-col gap-[9px] px-[13px] py-3 text-left"
              >
                <div className="flex items-center gap-[9px]">
                  <Landmark className="h-[18px] w-[18px] shrink-0" style={{ color: T.forest }} />
                  <span className="min-w-0 flex-1 truncate text-[10.5px] font-extrabold uppercase tracking-[.12em]">
                    LC facility limit
                    {soleBank ? ` · ${lenderOpts.find((o) => o.value === soleBank)?.label || ''}` : lcBanks.length > 1 ? ' · all banks' : ''}
                  </span>
                  {limitOpen ? (
                    <ChevronUp className="h-5 w-5 shrink-0" style={{ color: T.inkSoft }} />
                  ) : (
                    <ChevronDown className="h-5 w-5 shrink-0" style={{ color: T.inkSoft }} />
                  )}
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2.5">
                  <span className="text-[11.5px] font-bold" style={{ color: T.inkSoft }}>
                    Available of {inrShort(sanctioned)}
                  </span>
                  <Money size={15} fg={T.green}>
                    {inrFull(available)}
                  </Money>
                </div>
                <Bar pct={drawnPct} fg={T.forest} rest={T.lime} />
                {sanctioned > 0 && (
                  <div
                    className="text-[11px] font-semibold leading-[1.45]"
                    style={{ color: drawnPct >= 90 ? T.warnInk : T.inkSoft }}
                  >
                    {drawnPct >= 90
                      ? `${drawnPct.toFixed(1)}% drawn — a new LC above ${inrFull(available)} needs a limit enhancement first.`
                      : `${drawnPct.toFixed(1)}% of the facility is drawn.`}
                  </div>
                )}
              </button>
              {limitOpen && (
                <div className="grid grid-cols-2 border-t" style={{ borderColor: T.rule }}>
                  {[
                    { k: 'Sanctioned', v: inrShort(sanctioned) },
                    { k: 'Utilised', v: inrShort(utilised), fg: T.warnInk },
                    { k: 'Available', v: inrShort(available), bg: T.greenBg, kFg: T.green, fg: T.green },
                    // getLcLimit carries no margin figure, so this read ₹0 always.
                    // Summed off the LCs shown (bar any wound up), like the Open
                    // amount beside it.
                    { k: 'Margin held', v: inrShort(shownLcs.filter((l) => !l.preclosed_date && !isLcRejected(l)).reduce((t, l) => t + n(l.margin_amount), 0)) },
                    // What the desktop register's TOTAL row says for the same chip.
                    { k: `${lcChips.find((c) => c.k === lcChip)?.label || 'Shown'} LCs`, v: String(shownLcs.length) },
                    { k: 'Open amount', v: inrShort(shownLcs.reduce((t, l) => t + n(l.amount), 0)) }
                  ].map((c, i) => (
                    <div
                      key={c.k}
                      className="min-w-0 border-b px-3 py-[9px]"
                      style={{
                        borderColor: T.rule,
                        borderRight: i % 2 === 0 ? `1px solid ${T.rule}` : 'none',
                        background: c.bg || '#fff'
                      }}
                    >
                      <Cap fg={c.kFg}>{c.k}</Cap>
                      <div
                        className="mt-[3px] truncate text-[12.5px] font-bold"
                        style={{ fontFamily: MONO, color: c.fg || T.ink }}
                      >
                        {c.v}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {shownLcs.length === 0 ? (
              <EmptyState what={lcs.length ? 'No LC matches this filter.' : 'No letters of credit yet.'} />
            ) : (
              shownLcs.map((l, i) => (
                <LcCard
                  key={String(l.id)}
                  sno={i + 1}
                  l={l}
                  acts={lcActions(l)}
                  onOpen={() => setDetail({ kind: 'lc', id: Number(l.id) })}
                />
              ))
            )}
          </>
        ) : (
          <>
            <div className="flex-none overflow-hidden rounded-[4px] border bg-white" style={{ borderColor: T.border }}>
              <div
                className="border-b px-3 py-[9px] text-[10px] font-extrabold uppercase tracking-[.13em]"
                style={{ background: T.head, borderColor: T.headRule }}
              >
                Bill discounting · {bdChips.find((c) => c.k === bdChip)?.label || 'Shown'}
              </div>
              {/* The desktop band, cell for cell: what is out, what the NBFC
                  kept (margin, interest, TDS), what reached the bank, and the
                  headroom left — struck the same way, off the same rows. */}
              <div className="grid grid-cols-2">
                {(
                  [
                    {
                      k: 'Outstanding',
                      v: inrShort(bdK.outstanding),
                      sub: `on ${bdK.count} bill${bdK.count === 1 ? '' : 's'}${bdOf(bdK.outstanding, bdKAll.outstanding) ? ` ${bdOf(bdK.outstanding, bdKAll.outstanding)}` : ''}`,
                      fg: T.warnInk
                    },
                    { k: 'Margin held', v: inrShort(bdK.margin), sub: bdOf(bdK.margin, bdKAll.margin) },
                    { k: 'Interest', v: inrShort(bdK.interest), sub: bdOf(bdK.interest, bdKAll.interest), fg: T.alertInk },
                    { k: 'TDS withheld', v: inrShort(bdK.tds), sub: bdOf(bdK.tds, bdKAll.tds), fg: T.warnInk },
                    {
                      k: 'Received',
                      v: inrShort(bdK.receipt),
                      sub: bdOf(bdK.receipt, bdKAll.receipt),
                      bg: T.greenBg,
                      kFg: T.green,
                      fg: T.green
                    },
                    bdAvail == null
                      ? { k: bdNbfcs.length === 1 ? 'Available · this NBFC' : bdNbfcs.length > 1 ? `Available · ${bdNbfcs.length} NBFCs` : 'Available limit', v: 'not set', fg: T.inkSoft }
                      : {
                          k: bdNbfcs.length === 1 ? 'Available · this NBFC' : bdNbfcs.length > 1 ? `Available · ${bdNbfcs.length} NBFCs` : 'Available limit',
                          v: inrShort(bdAvail.v),
                          sub: `of ${inrShort(bdAvail.of)} (${bdAvail.basis})${bdAvail.v < 0 ? ' · over the limit' : ''}`,
                          bg: bdAvail.v < 0 ? T.alertBg : T.greenBg,
                          kFg: bdAvail.v < 0 ? T.alert : T.green,
                          fg: bdAvail.v < 0 ? T.alert : T.green
                        }
                  ] as { k: string; v: string; sub?: string; fg?: string; bg?: string; kFg?: string }[]
                ).map((c, i) => (
                  <div
                    key={c.k}
                    className="min-w-0 border-b px-[11px] py-2"
                    style={{
                      borderColor: T.rule,
                      borderRight: i % 2 === 0 ? `1px solid ${T.rule}` : 'none',
                      background: c.bg || '#fff'
                    }}
                  >
                    <Cap fg={c.kFg}>{c.k}</Cap>
                    <div className="mt-0.5 whitespace-nowrap text-[12.5px] font-bold" style={{ fontFamily: MONO, color: c.fg || T.ink }}>
                      {c.v}
                    </div>
                    {c.sub && (
                      <div className="mt-px truncate text-[10px] font-semibold" style={{ color: T.inkSoft }}>
                        {c.sub}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {shownBills.length === 0 ? (
              <EmptyState what={bills.length ? 'No bill matches this filter.' : 'No bills discounted yet.'} />
            ) : (
              shownBills.map((b, i) => (
                <BdCard
                  key={String(b.id)}
                  sno={i + 1}
                  b={b}
                  onOpen={() => setDetail({ kind: 'bd', id: Number(b.id) })}
                  onRepay={() => setRepayRow(b)}
                  onEdit={() => openEditBill(b)}
                  onPayParty={() => setBdPartyRow(b)}
                />
              ))
            )}
          </>
        )}
      </div>
      </>
      )}

      {/* The one thing this page is most often opened to do, pinned where the
          thumb already is. Not on the tracker, which opens nothing new. */}
      {tab !== 'tracker' && (
      <div
        className="sticky bottom-0 z-10 flex flex-none gap-[9px] border-t bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[11px]"
        style={{ borderColor: T.border }}
      >
        <button
          type="button"
          onClick={() => (tab === 'bd' ? openNewBill() : openNewLc())}
          className="flex h-[50px] flex-1 items-center justify-center gap-[7px] rounded-[3px] text-[13px] font-extrabold"
          style={{ background: T.lime, color: T.limeInk }}
        >
          <Plus className="h-[19px] w-[19px]" />
          {tab === 'bd' ? 'Discount a bill' : 'Open new LC'}
        </button>
      </div>
      )}

      {/* ------------------------------------------------------ over the list */}
      {detail && detailRow && detail.kind === 'lc' && (
        <LcDetail
          l={detailRow}
          acts={lcActions(detailRow)}
          onClose={() => setDetail(null)}
          onEdit={() => {
            // Repaid/preclosed: the books were closed on these figures.
            if (detailRow.preclosed_date)
              return void toast.error(
                n(detailRow.parts_count) > 0
                  ? 'This LC is repaid and closed. To reopen it, take back the last repayment under Parts.'
                  : 'This LC is repaid and closed. Use Edit closure to change how it closed; the LC itself needs Undo preclosure on the desktop.'
              )
            setLcForm({ ...detailRow, linked_order_ids: detailRow.linked_order_ids || [] })
            setDetail(null)
          }}
          onDelete={() => setDelTarget({ kind: 'lc', row: detailRow })}
        />
      )}
      {detail && detailRow && detail.kind === 'bd' && (
        <BdDetail
          b={detailRow}
          onClose={() => setDetail(null)}
          onRepay={() => {
            setRepayRow(detailRow)
            setDetail(null)
          }}
          onEdit={() => {
            openEditBill(detailRow)
            setDetail(null)
          }}
          onPayParty={() => {
            setBdPartyRow(detailRow)
            setDetail(null)
          }}
          onDelete={() => setDelTarget({ kind: 'bd', row: detailRow })}
        />
      )}
      {lcForm && (
        <LcWizard
          form={lcForm}
          setForm={setLcForm}
          lcs={lcs}
          banks={banks}
          suppliers={suppliers}
          customers={customers}
          facilities={facilities}
          orders={orders}
          onClose={() => setLcForm(null)}
          onSaved={async () => {
            setLcForm(null)
            await afterSave()
          }}
        />
      )}
      {bdForm && (
        <BillForm
          form={bdForm}
          setForm={setBdForm}
          suppliers={suppliers}
          customers={customers}
          nbfcs={nbfcs}
          onClose={() => setBdForm(null)}
          onSaved={async () => {
            setBdForm(null)
            await afterSave()
          }}
        />
      )}
      {stageRow && (
        <StageScreen
          l={stageRow}
          lcs={lcs}
          onClose={() => setStageRow(null)}
          onSaved={async () => {
            setStageRow(null)
            await afterSave()
          }}
        />
      )}
      {payInRow && (
        <PaymentInScreen
          l={payInRow}
          onClose={() => setPayInRow(null)}
          onSaved={async () => {
            setPayInRow(null)
            await afterSave()
          }}
        />
      )}
      {precloseRow && (
        <PrecloseScreen
          l={precloseRow}
          onClose={() => setPrecloseRow(null)}
          onSaved={async () => {
            setPrecloseRow(null)
            await afterSave()
          }}
        />
      )}
      {editCloseRow && (
        <PrecloseScreen
          l={editCloseRow}
          editing
          onClose={() => setEditCloseRow(null)}
          onSaved={async () => {
            setEditCloseRow(null)
            setDetail(null)
            await afterSave()
          }}
        />
      )}
      {bdPartyRow && (
        <BdPayPartyScreen
          l={bdPartyRow}
          onClose={() => setBdPartyRow(null)}
          onChanged={async () => {
            await afterSave()
          }}
        />
      )}
      {payPartyRow && (
        <PayPartyScreen
          l={payPartyRow}
          onClose={() => setPayPartyRow(null)}
          onChanged={async () => {
            await afterSave()
          }}
        />
      )}
      {repayRow && (
        <RepayScreen
          b={repayRow}
          initialKind={repayKind}
          onClose={() => {
            setRepayRow(null)
            setRepayKind('full')
          }}
          onChanged={async () => {
            await afterSave()
          }}
          onDone={async () => {
            setRepayRow(null)
            await afterSave()
          }}
        />
      )}
      {lenderOpen && (
        <LenderSheet
          title={tab === 'lc' ? 'Banks in view' : 'NBFCs in view'}
          allLabel={tab === 'lc' ? 'All my banks' : 'All my NBFCs'}
          unit={tab === 'lc' ? 'LC' : 'bill'}
          options={lenderOpts}
          value={lenderSel}
          onApply={(v) => {
            if (tab === 'lc') setLcBanks(v)
            else setBdNbfcs(v)
            setLenderOpen(false)
          }}
          onClose={() => setLenderOpen(false)}
        />
      )}
      {delTarget && (
        <ConfirmDelete
          target={delTarget}
          onCancel={() => setDelTarget(null)}
          onDone={async () => {
            setDelTarget(null)
            setDetail(null)
            await afterSave()
          }}
        />
      )}
    </div>
  )
}

function EmptyState({ what }: { what: string }): React.JSX.Element {
  return (
    <div
      className="flex flex-none flex-col items-center gap-2 rounded-[4px] border bg-white px-3.5 py-6"
      style={{ borderColor: T.headRule }}
    >
      <SearchX className="h-7 w-7" style={{ color: T.field }} />
      <span className="text-center text-[12px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
        {what}
      </span>
    </div>
  )
}

// ==================================================================== cards

function lcMark(l: Row): string {
  if (l.preclosed_date || s(l.status) === 'closed' || isLcRejected(l)) return '#C3D2C6'
  const due = daysTo(l.next_due_date || l.expiry_date)
  if (due != null && due < 0) return T.alert
  if (due != null && due <= 7) return T.warnMark
  return T.greenBright
}

function daysChip(due: number | null, closed: boolean): { text: string; bg: string; fg: string } | null {
  if (closed || due == null) return null
  if (due < 0) return { text: `${Math.abs(due)}d overdue`, bg: T.alertBg, fg: T.alert }
  if (due === 0) return { text: 'due today', bg: T.warnBg, fg: T.warnInk }
  return { text: `${due}d left`, bg: due <= 7 ? T.warnBg : T.chip, fg: due <= 7 ? T.warnInk : T.inkSoft }
}

// WHERE THE LC STANDS — the desktop register's badge, word for word: its stage
// (Application → Open → Payment received), or how it closed. This said RUNNING
// for an LC the bank had paid on, which is not a stage and not what the desktop
// says about the same LC; running or matured is what the day count beside it
// and the filter chips are for.
function lcStatus(l: Row): { text: string; bg: string; fg: string; bd: string } {
  if (isLcRejected(l)) return { text: 'REJECTED', bg: T.alertBg, fg: T.alert, bd: T.alertRule }
  const closed = s(l.preclosed_date).slice(0, 10)
  if (closed) {
    const mat = s(l.expiry_date).slice(0, 10)
    const text = mat && closed < mat ? 'PRECLOSED' : mat && closed > mat ? 'CLOSED LATE' : 'CLOSED'
    if (text === 'PRECLOSED') return { text, bg: '#E8F6FB', fg: '#0E5A78', bd: '#BFE3F0' }
    return { text, bg: T.rule, fg: T.inkSoft, bd: T.border }
  }
  const stage = s(l.stage || 'application')
  if (stage === 'payment_received') {
    // An LC that names money coming back, and whether it has.
    if (s(l.purpose) !== 'trading' && Number(l.payment_in_expected)) {
      return Number(l.payment_in_total) > 0.004
        ? { text: 'PAYMENT IN', bg: T.okBg, fg: T.green, bd: T.greenRule }
        : { text: 'AWAITING PAYMENT IN', bg: T.warnBg, fg: T.warnInk, bd: T.warnRule }
    }
    return { text: 'PAYMENT RECEIVED', bg: T.okBg, fg: T.green, bd: T.greenRule }
  }
  if (stage === 'open') return { text: 'OPEN', bg: T.blueBg, fg: T.blue, bd: T.blueRule }
  return { text: 'APPLICATION', bg: T.chip, fg: T.inkMid, bd: T.border }
}

function ActBtn({ a, grow, narrow }: { a: { label: string; kind: string; go: () => void }; grow?: boolean; narrow?: boolean }): React.JSX.Element {
  const st =
    a.kind === 'go'
      ? { background: T.forest, color: '#fff', border: `1px solid ${T.forest}` }
      : a.kind === 'navy'
        ? { background: T.navy, color: '#fff', border: `1px solid ${T.navy}` }
        : a.kind === 'lime'
          ? { background: T.lime, color: T.limeInk, border: `1px solid ${T.lime}` }
          : { background: '#fff', color: T.inkMid, border: `1px solid ${T.field}` }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        a.go()
      }}
      className={`${grow ? 'flex-1' : 'shrink-0'} flex h-11 items-center justify-center whitespace-nowrap rounded-[3px] px-3 text-[12.5px] font-extrabold`}
      style={{ ...st, width: narrow ? 96 : undefined }}
    >
      {a.label}
    </button>
  )
}

function LcCard({
  sno,
  l,
  acts,
  onOpen
}: {
  sno: number
  l: Row
  acts: { primary: { label: string; kind: string; go: () => void }; second?: { label: string; kind: string; go: () => void } }
  onOpen: () => void
}): React.JSX.Element {
  const closed = !!l.preclosed_date || s(l.status) === 'closed' || isLcRejected(l)
  const due = daysTo(l.next_due_date || l.expiry_date)
  const st = lcStatus(l)
  const chip = daysChip(due, closed)
  const stage = s(l.stage || 'application')
  const opened = s(l.opened_date)
  // Payment rec, the desktop's way: what the bank paid the supplier once it has
  // (paid_to_party), and until then what it is expected to — marked "not drawn
  // yet". This took the expectation for a payment and read "paid to supplier"
  // on LCs still at Application or Open.
  const paidToParty = l.paid_to_party
  const paid = paidToParty ?? l.paid_expected
  const drawn = paidToParty != null
  const noInvoice = !closed && stage !== 'application' && Number(l.linked_invoice_count) === 0
  const hasNo = !!s(l.lc_no).trim()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="flex-none cursor-pointer rounded-[4px] border bg-white p-3"
      style={{ borderColor: T.border, borderLeft: `4px solid ${lcMark(l)}` }}
    >
      <div className="flex items-start justify-between gap-[9px]">
        <SerialNo n={sno} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[14px] font-bold tracking-[-0.01em]"
            style={{ fontFamily: hasNo ? MONO : undefined, color: hasNo ? T.ink : T.inkSoft, fontStyle: hasNo ? 'normal' : 'italic' }}
          >
            {hasNo ? s(l.lc_no) : 'No LC number yet'}
          </div>
          <div className="mt-[3px] truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
            {s(l.supplier_name || l.receivable_party_name) || '—'}
          </div>
        </div>
        <Tag bg={st.bg} fg={st.fg} bd={st.bd}>
          {st.text}
        </Tag>
      </div>

      {noInvoice && (
        <div className="mt-2">
          <Tag bg={T.warnBg} fg={T.warnInk} bd={T.warnRule} size={9.5}>
            <AlertTriangle className="h-3 w-3" /> No invoice linked
          </Tag>
        </div>
      )}

      <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
        <span className="text-[10.5px] font-bold" style={{ color: T.inkSoft }}>
          {s(l.bank || l.bank_name || l.our_bank_name) || 'Bank not set'}
        </span>
        {n(l.margin_pct) > 0 && (
          <span className="rounded-[2px] px-[5px] py-[2px] text-[9.5px] font-extrabold" style={{ background: T.chip, color: T.inkSoft }}>
            M {formatNum(l.margin_pct)}%
          </span>
        )}
        {chip && (
          <span className="rounded-[2px] px-[7px] py-[3px] text-[10px] font-extrabold" style={{ background: chip.bg, color: chip.fg }}>
            {chip.text}
          </span>
        )}
      </div>

      <div className="mt-[9px] flex items-center gap-[7px] border-t pt-[9px]" style={{ borderColor: T.rule }}>
        <span className="text-[10px] font-extrabold tracking-[.09em]" style={{ color: opened ? T.inkSoft : T.warnInk }}>
          {opened ? 'OP' : 'APP'}
        </span>
        <span className="text-[11.5px] font-bold" style={{ fontFamily: MONO }}>
          {fmtD(opened || l.open_date)}
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0" style={{ color: T.field }} />
        <span className="text-[11.5px] font-semibold" style={{ fontFamily: MONO, color: s(l.expiry_date) ? T.inkMid : T.inkFaint }}>
          {fmtD(l.expiry_date)}
        </span>
        {n(l.usance_days) > 0 && (
          <span className="ml-auto text-[11px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
            {formatNum(l.usance_days)}d int
          </span>
        )}
      </div>

      <div className="mt-[9px] flex items-end justify-between gap-2.5">
        <div className="min-w-0">
          <Cap>{closed ? 'LC amount' : 'Open amount'}</Cap>
          {/* The LC's own amount, as the desktop register prints it. This read
              `outstanding` — the blocked amount less principal repaid — which
              is a different figure and disagreed with the desktop. */}
          <Money size={14}>{inrFull(n(l.amount))}</Money>
        </div>
        <div className="min-w-0 text-right">
          <Cap>Payment rec</Cap>
          <Money size={14} fg={drawn ? T.green : paid != null ? T.inkSoft : T.inkFaint}>
            {paid != null ? inrFull(n(paid)) : '—'}
          </Money>
          <div className="mt-0.5 text-[10px] font-semibold" style={{ color: T.inkSoft }}>
            {!drawn
              ? 'not drawn yet'
              : canPayParty(l)
                ? `${inrFull(partyLeft(l))} still to pay`
                : n(l.installment_count) > 0
                  ? `after ${inrFull(round2(n(l.amount) - n(l.paid_expected)))} int + chg`
                  : `after ${inrFull(round2(n(l.amount) - n(paidToParty)))} int + chg`}
          </div>
        </div>
      </div>

      <div className="mt-[11px] flex gap-2">
        <ActBtn a={acts.primary} grow />
        {acts.second && <ActBtn a={acts.second} narrow />}
      </div>
    </div>
  )
}

function BdCard({
  sno,
  b,
  onOpen,
  onRepay,
  onEdit,
  onPayParty
}: {
  sno: number
  b: Row
  onOpen: () => void
  onRepay: () => void
  onEdit: () => void
  onPayParty?: () => void
}): React.JSX.Element {
  const repaid = s(b.status) === 'repaid' || s(b.stage) === 'repaid'
  const awaiting = s(b.stage) === 'awaiting'
  const due = daysTo(b.maturity_date)
  const mark = repaid ? '#C3D2C6' : due != null && due < 0 ? T.alert : due != null && due <= 7 ? T.warnMark : T.blue
  const chip = daysChip(due, repaid)
  const owed = bdDue(b)
  const partPaid = !repaid && n(b.repaid_total ?? b.repaid_amount) > 0.004
  const serviced = bdServiced(b)
  // Settled with the NBFC is not the same as square: a repaid serviced bill
  // whose interest was not serviced up to the day it was repaid still owes
  // that stretch — the desktop row says DUE, and so does this.
  const intUpto = s(b.interest_paid_to).slice(0, 10)
  const intUpTill = s(b.last_repay_date || b.maturity_date).slice(0, 10)
  const intOwing = serviced && repaid && (!intUpto || (!!intUpTill && intUpto < intUpTill))
  const kind = s(b.finance_type) || 'PID'

  // The one button: repay what is owed, wait for the money to land, or — once
  // it is all back — simply look at the bill.
  const btn = repaid
    ? { label: 'View bill', icon: <Eye className="h-[19px] w-[19px]" />, go: onOpen, bg: '#fff', fg: T.inkMid, bd: T.field }
    : awaiting
      ? { label: 'Awaiting', icon: <Hourglass className="h-[19px] w-[19px]" />, go: onEdit, bg: T.warnBg, fg: T.warnInk, bd: T.warnRule }
      : b.party_in_parts && n(b.party_left) > 0.5 && onPayParty
        ? // The NBFC still owes the supplier part of this bill: that comes first.
          { label: 'Pay party', icon: <Banknote className="h-[19px] w-[19px]" />, go: onPayParty, bg: T.green, fg: '#fff', bd: T.green }
        : { label: 'Repay', icon: <Banknote className="h-[19px] w-[19px]" />, go: onRepay, bg: T.navy, fg: '#fff', bd: T.navy }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="flex-none cursor-pointer rounded-[4px] border bg-white p-3"
      style={{ borderColor: T.border, borderLeft: `4px solid ${mark}` }}
    >
      <div className="flex items-start justify-between gap-[9px]">
        <SerialNo n={sno} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold" style={{ fontFamily: MONO }}>
            {s(b.bd_no) || 'No number'}
          </div>
          <div className="mt-[3px] truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
            {s(b.party_names || b.supplier_name || b.customer_name) || '—'}
          </div>
        </div>
        <Tag
          bg={repaid ? T.okBg : T.blueBg}
          fg={repaid ? T.green : T.blue}
          bd={repaid ? T.greenRule : T.blueRule}
        >
          {kind}
        </Tag>
      </div>
      <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
        <span className="text-[10.5px] font-bold" style={{ color: T.inkSoft }}>
          {s(b.nbfc_name) || 'NBFC not set'}
        </span>
        {n(b.margin_pct) > 0 && (
          <span className="rounded-[2px] px-[5px] py-[2px] text-[9.5px] font-extrabold" style={{ background: T.chip, color: T.inkSoft }}>
            M {formatNum(b.margin_pct)}%
          </span>
        )}
        {n(b.interest_pct) > 0 && (
          <span className="rounded-[2px] px-[5px] py-[2px] text-[9.5px] font-extrabold" style={{ background: T.chip, color: T.inkSoft }}>
            {formatNum(b.interest_pct)}%
          </span>
        )}
        {/* The desktop's Days-left column: awaiting the NBFC's money, or the
            days to maturity and — once some has gone back — Part repaid. */}
        {awaiting ? (
          <span className="rounded-[2px] px-[7px] py-[3px] text-[10px] font-extrabold uppercase" style={{ background: T.warnBg, color: T.warnInk }}>
            Awaiting payment
          </span>
        ) : (
          chip && (
            <span className="rounded-[2px] px-[7px] py-[3px] text-[10px] font-extrabold" style={{ background: chip.bg, color: chip.fg }}>
              {chip.text}
            </span>
          )
        )}
        {partPaid && !awaiting && (
          <span className="rounded-[2px] px-[7px] py-[3px] text-[10px] font-extrabold uppercase" style={{ background: T.warnBg, color: T.warnInk }}>
            Part repaid
          </span>
        )}
        {repaid && (
          <span className="flex items-center gap-1 text-[10px] font-extrabold" style={{ color: T.green }}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Repaid {fmtD(b.repaid_date)}
          </span>
        )}
        {/* The second leg, as the desktop row carries it under the bill no:
            Payment IN expected / due / overdue, or Payment Received. */}
        {!!Number(b.payment_in_expected) && (
          <span onClick={(e) => e.stopPropagation()}>
            <PayInDue row={b} />
          </span>
        )}
      </div>
      {/* The register's own columns: the open amount with its balance under
          it, and what reached the bank — not the Payment IN from a customer,
          which the desktop reports as a chip above rather than as a figure. */}
      <div className="mt-[9px] flex items-end justify-between gap-2.5 border-t pt-[9px]" style={{ borderColor: T.rule }}>
        <div className="min-w-0">
          <Cap>Open amount</Cap>
          <Money size={14}>{inrFull(n(b.amount))}</Money>
          <div
            className="mt-[5px] inline-block whitespace-nowrap rounded-[2px] border px-1.5 py-[3px] text-[10px] font-bold"
            style={{ fontFamily: MONO, background: T.greenBg, color: T.green, borderColor: T.greenRule }}
            title={partPaid ? `${inrFull(n(b.repaid_total))} repaid — ${inrFull(owed)} still owed` : 'Nothing repaid yet, so the balance is the whole bill'}
          >
            {owed <= 0.004 ? 'settled' : `${inrFull(owed)} owed`}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <Cap fg={T.green}>Receipt</Cap>
          <Money size={14} fg={T.green}>
            {inrFull(n(b.receiptAmount))}
          </Money>
          <div className="mt-[3px] text-[10px] font-semibold" style={{ color: T.inkSoft }}>
            reached you
          </div>
        </div>
      </div>
      {/* What the NBFC kept, as the desktop groups it. A serviced bill had
          nothing withheld — its interest is paid across the tenor. */}
      <div className="mt-[9px] grid grid-cols-3 overflow-hidden rounded-[3px] border" style={{ borderColor: T.rule, background: '#FDF8F7' }}>
        {[
          { k: `Margin ${formatNum(b.margin_pct)}%`, v: inrShort(n(b.marginAmount)) },
          {
            k: `Interest · ${n(b.intDays)}d`,
            v: intOwing ? 'DUE' : serviced ? 'serviced' : inrShort(n(b.interestAmount)),
            fg: intOwing ? T.alert : serviced ? T.inkFaint : T.alertInk
          },
          { k: `TDS ${formatNum(b.tds_pct)}%`, v: serviced ? '—' : inrShort(n(b.tdsAmount)), fg: serviced ? T.inkFaint : T.warnInk }
        ].map((c, i) => (
          <div key={i} className="min-w-0 px-2 py-[7px]" style={{ borderLeft: i ? `1px solid ${T.rule}` : 'none' }}>
            <div className="truncate text-[9px] font-extrabold uppercase tracking-[.08em]" style={{ color: T.inkSoft }}>
              {c.k}
            </div>
            <div className="mt-px truncate text-[12px] font-bold" style={{ fontFamily: MONO, color: c.fg || T.ink }}>
              {c.v}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-[11px] flex gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            btn.go()
          }}
          className="flex h-[46px] flex-1 items-center justify-center gap-[7px] rounded-[3px] border text-[12.5px] font-extrabold"
          style={{ background: btn.bg, color: btn.fg, borderColor: btn.bd }}
        >
          {btn.icon}
          {btn.label}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          title="Full bill detail"
          className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[3px] border bg-white"
          style={{ borderColor: T.border }}
        >
          <Maximize2 className="h-5 w-5" style={{ color: T.inkMid }} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          title="Edit this bill"
          className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[3px] border bg-white"
          style={{ borderColor: T.border }}
        >
          <Pencil className="h-5 w-5" style={{ color: T.inkMid }} />
        </button>
      </div>
    </div>
  )
}

// =================================================================== detail

// A timeline step: a dot, a line down to the next, and what happened.
type Step = { k: string; v: string; done: boolean; sub?: string; icon?: React.ReactNode }
function Timeline({ steps }: { steps: Step[] }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {steps.map((t, i) => (
        <div key={i} className="flex gap-[11px]">
          <div className="flex w-6 shrink-0 flex-col items-center">
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{
                background: t.done ? T.greenBright : '#fff',
                border: `2px solid ${t.done ? T.greenBright : T.field}`
              }}
            >
              {t.done ? <Check className="h-3.5 w-3.5 text-white" /> : <Clock className="h-3 w-3" style={{ color: T.inkFaint }} />}
            </div>
            {i < steps.length - 1 && (
              <div className="min-h-[16px] w-[2px] flex-1" style={{ background: t.done ? T.greenRule : T.rule }} />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-[14px]">
            <div className="flex flex-wrap items-baseline justify-between gap-2.5">
              <span className="text-[12.5px] font-extrabold" style={{ color: t.done ? T.ink : T.inkSoft }}>
                {t.k}
              </span>
              <span className="whitespace-nowrap text-[12.5px] font-bold" style={{ fontFamily: MONO, color: t.done ? T.ink : T.inkFaint }}>
                {t.v}
              </span>
            </div>
            {t.sub && (
              <div className="mt-[3px] text-[11.5px] font-semibold" style={{ color: T.inkSoft }}>
                {t.sub}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function CellGrid({ cells }: { cells: { k: string; v: string; fg?: string; bg?: string; bd?: string; kFg?: string }[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      {cells.map((c) => (
        <div
          key={c.k}
          className="min-w-0 rounded-[4px] border px-[11px] py-2.5"
          style={{ background: c.bg || '#fff', borderColor: c.bd || T.border }}
        >
          <div className="text-[10px] font-extrabold uppercase tracking-[.11em]" style={{ color: c.kFg || T.inkSoft }}>
            {c.k}
          </div>
          <div
            className="mt-[5px] whitespace-nowrap text-[13.5px] font-bold tracking-[-0.02em]"
            style={{ fontFamily: MONO, color: c.fg || T.ink }}
          >
            {c.v}
          </div>
        </div>
      ))}
    </div>
  )
}

// PAID THE BANK OVER THE BALANCE — what it still owes back, and the same
// Refund received box as the desktop (link a receipt, or record it).
function PhoneRefundStrip({ kind, id }: { kind: 'bd' | 'lc'; id: number }): React.JSX.Element | null {
  const [due, setDue] = useState(0)
  const [done, setDone] = useState(0)
  const [open, setOpen] = useState(false)
  const load = useCallback(() => {
    const api = kind === 'bd' ? window.api.billDiscounting : window.api.lc
    void api
      .refundInfo(id)
      .then((r: Row) => {
        setDue(n(r.due))
        setDone(((r.refunds as Row[]) || []).length)
      })
      .catch(() => undefined)
  }, [kind, id])
  useEffect(load, [load])
  if (due <= 0.004 && !done) return null
  return (
    <>
      <div
        className="mx-4 mt-3 flex items-center gap-3 rounded-[4px] border px-3 py-2.5"
        style={{ background: due > 0.004 ? '#FDECEA' : '#F4FBF6', borderColor: due > 0.004 ? '#F0C4C0' : '#BFE3CB' }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-extrabold uppercase tracking-[.1em]" style={{ color: due > 0.004 ? '#B3261E' : '#0B5638' }}>
            {due > 0.004 ? 'Refund due from the bank' : 'Refund received'}
          </div>
          <div className="text-[15px] font-bold" style={{ fontFamily: MONO, color: due > 0.004 ? '#B3261E' : undefined }}>
            {due > 0.004 ? inrFull(due) : 'Nothing more due'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-9 flex-none rounded-[4px] px-3 text-[12.5px] font-extrabold text-white"
          style={{ background: T.navy }}
        >
          {due > 0.004 ? 'Refund received' : 'View'}
        </button>
      </div>
      <RefundReceived phone kind={kind} id={open ? id : null} open={open} onClose={() => setOpen(false)} onChanged={load} />
    </>
  )
}

// THE STRETCHES OF ONE INTEREST PERIOD at the principal out then — a part
// repaid early makes the later days cheaper (billDiscounting.ts bdInterestParts).
function PartsTable({ parts }: { parts: Row[] }): React.JSX.Element {
  return (
    <div className="mt-3 overflow-hidden rounded-[4px] border" style={{ borderColor: T.border }}>
      {parts.map((p, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b px-3 py-2 last:border-b-0" style={{ borderColor: T.rule }}>
          <span className="text-[12px] font-bold" style={{ color: T.ink }}>
            {formatDate(s(p.from_date))} → {formatDate(s(p.to_date))}
            <span className="block text-[11px] font-semibold" style={{ color: T.inkSoft }}>
              {inrFull(n(p.principal))} × {n(p.days)} d
            </span>
          </span>
          <Money size={13}>{inrFull(n(p.interest))}</Money>
        </div>
      ))}
    </div>
  )
}

// A SERVICED BILL'S INTEREST, PERIOD BY PERIOD — tap a period for how it is
// worked out. The desktop BD panel's list, on a phone.
function ServicedSchedule({ id }: { id: number }): React.JSX.Element | null {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    void window.api.billDiscounting
      .interestSchedule(id)
      .then((r: Row[]) => live && setRows(Array.isArray(r) ? r : []))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [id])
  if (!rows || !rows.length) return null
  return (
    <Panel title="Interest serviced" right={<Tag bg={T.blueBg} fg={T.navy} bd={T.blueRule}>{rows.filter((x) => x.paid_id).length} of {rows.length} paid</Tag>} bodyClass="p-0">
      {rows.map((x, i) => {
        const parts = (Array.isArray(x.parts) ? x.parts : []) as Row[]
        return (
          <div key={i} className="border-b last:border-b-0" style={{ borderColor: T.rule }}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2 px-[15px] py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-extrabold" style={{ color: T.ink }}>
                  {formatDate(s(x.from_date))} → {formatDate(s(x.to_date))}
                </span>
                <span className="mt-[3px] flex flex-wrap items-center gap-1.5">
                  <Tag bg={x.paid_id ? T.okBg : T.alertBg} fg={x.paid_id ? T.green : T.alert} bd={x.paid_id ? T.greenRule : T.alertRule}>
                    {x.paid_id ? 'PAID' : 'DUE'}
                  </Tag>
                  <span className="text-[11px] font-semibold" style={{ color: T.inkSoft }}>{n(x.days)} d</span>
                  {parts.length > 1 && <Tag bg={T.blueBg} fg={T.navy} bd={T.blueRule}>{parts.length} BALANCES</Tag>}
                </span>
              </span>
              <Money size={14}>{inrFull(n(x.gross))}</Money>
              <ChevronDown className="h-4 w-4 flex-none" style={{ color: T.inkFaint, transform: open === i ? 'rotate(180deg)' : undefined }} />
            </button>
            {open === i && (
              <div className="px-[15px] pb-3">
                <PartsTable parts={parts} />
                <div className="mt-2 text-[11px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
                  {x.reducing
                    ? 'A part of the principal repaid stops costing interest from the day after it went back.'
                    : 'Charged on the full principal — nothing was repaid early.'}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </Panel>
  )
}

function LcDetail({
  l,
  acts,
  onClose,
  onEdit,
  onDelete
}: {
  l: Row
  acts: { primary: { label: string; kind: string; go: () => void }; second?: { label: string; kind: string; go: () => void } }
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [reps, setReps] = useState<Row[]>([])
  const [pins, setPins] = useState<Row[]>([])
  useEffect(() => {
    let live = true
    void Promise.all([
      window.api.lc.repayments(Number(l.id)).catch(() => [] as Row[]),
      window.api.lc.paymentIns(Number(l.id)).catch(() => [] as Row[])
    ]).then(([r, p]) => {
      if (!live) return
      setReps(r)
      setPins(p)
    })
    return () => {
      live = false
    }
  }, [l.id])

  const st = lcStatus(l)
  const amount = n(l.amount)
  // Repaid is the principal actually repaid, and what is owed is the LC's
  // amount less that — the desktop's open amount, not the blocked figure the
  // server's `outstanding` starts from.
  const repaid = Math.min(amount, Math.max(0, round2(n(l.repaid_principal))))
  const outstanding = l.preclosed_date || isLcRejected(l) ? 0 : Math.max(0, round2(amount - repaid))
  const repaidPct = amount > 0 ? (repaid / amount) * 100 : 0
  const margin = round2((amount * n(l.margin_pct)) / 100)
  const interest = lcInterestOfDays(l, n(l.usance_days))
  const charges = round2(n(l.charges))
  const paidToParty = l.paid_to_party ?? l.paid_expected
  const stage = s(l.stage || 'application')
  // Paid upfront, the interest and charges do not come out of what reaches the
  // supplier — the desktop's rule (Treasury.tsx netAvailable).
  const upfrontLc = !!l.interest_upfront
  const reached = paidToParty != null ? n(paidToParty) : upfrontLc ? amount : round2(amount - interest - charges)

  const steps: Step[] = [
    { k: 'Applied', v: fmtD(l.open_date), done: !!s(l.open_date) },
    { k: 'Opened by the bank', v: fmtD(l.opened_date), done: !!s(l.opened_date) },
    { k: 'Bank paid the supplier', v: fmtD(l.payment_received_date), done: !!s(l.payment_received_date) },
    {
      k: l.preclosed_date ? 'Wound up' : 'Maturity',
      v: fmtD(l.preclosed_date || l.expiry_date),
      done: !!l.preclosed_date || isLcPastMaturity(l),
      sub: l.preclosed_date ? 'preclosed before its natural date' : undefined
    }
  ]

  return (
    <Screen
      kicker="Letter of credit"
      title={
        <span style={{ fontFamily: s(l.lc_no) ? MONO : undefined, fontStyle: s(l.lc_no) ? 'normal' : 'italic' }}>
          {s(l.lc_no) || 'No LC number yet'}
        </span>
      }
      onClose={onClose}
      head={
        <>
          <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
            <span className="rounded-[2px] px-2 py-1 text-[10px] font-extrabold tracking-[.06em]" style={{ background: 'rgba(255,255,255,.14)' }}>
              {st.text}
            </span>
            <span
              className="rounded-[2px] px-2 py-1 text-[10px] font-extrabold tracking-[.06em]"
              style={{ background: 'rgba(199,240,63,.18)', color: T.lime }}
            >
              {s(l.purpose) === 'trading' ? 'TRADING' : 'MANUFACTURING'}
            </span>
          </div>
          <div className="mt-[11px] flex items-baseline justify-between gap-2.5">
            <span className="text-[10px] font-extrabold uppercase tracking-[.1em]" style={{ color: T.muted }}>
              {l.preclosed_date ? 'LC amount' : 'Open amount'}
            </span>
            <span className="whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]" style={{ fontFamily: MONO }}>
              {inrFull(amount)}
            </span>
          </div>
          <div className="mt-1 text-[11.5px] font-bold" style={{ color: T.muted }}>
            {s(l.bank || l.bank_name) || 'Bank not set'} · {s(l.supplier_name || l.receivable_party_name) || '—'}
          </div>
        </>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onDelete}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[4px]"
            style={{ background: T.alertBg, border: `1.5px solid ${T.alertRule}` }}
            title="Delete this LC"
          >
            <Trash2 className="h-5 w-5" style={{ color: T.alert }} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-[4px] px-4 text-[13px] font-extrabold"
            style={{ border: `1.5px solid ${T.field}`, color: T.inkMid }}
          >
            <Pencil className="h-[18px] w-[18px]" /> Edit
          </button>
          <button
            type="button"
            onClick={acts.primary.go}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[4px] text-[13.5px] font-extrabold"
            style={{
              background: acts.primary.kind === 'ghost' ? '#fff' : acts.primary.kind === 'navy' ? T.navy : T.forest,
              color: acts.primary.kind === 'ghost' ? T.inkMid : '#fff',
              border: acts.primary.kind === 'ghost' ? `1.5px solid ${T.field}` : 'none'
            }}
          >
            {acts.primary.label.toUpperCase()}
          </button>
        </>
      }
    >
      <PhoneRefundStrip kind="lc" id={Number(l.id)} />
      <CellGrid
        cells={[
          { k: 'Margin held', v: inrShort(margin) },
          { k: 'Interest', v: inrShort(interest), fg: T.alertInk, bg: '#FDF8F7', bd: T.alertRule },
          { k: 'Charges', v: inrShort(charges) },
          {
            k: stage === 'payment_received' ? 'Paid to supplier' : 'Net available',
            v: inrShort(reached),
            fg: T.green,
            bg: T.greenBg,
            bd: T.greenRule,
            kFg: T.green
          }
        ]}
      />

      <div className="flex-none rounded-[4px] border bg-white px-[13px] py-3" style={{ borderColor: T.border }}>
        <div className="flex items-baseline justify-between gap-2.5">
          <Cap>Repaid of the LC</Cap>
          <span className="text-[15px] font-bold" style={{ fontFamily: MONO, color: repaidPct >= 99.5 ? T.green : T.ink }}>
            {repaidPct.toFixed(0)}%
          </span>
        </div>
        <div className="mt-[9px]">
          <Bar pct={repaidPct} fg={T.greenBright} />
        </div>
      </div>

      <Panel title={`What reached ${s(l.supplier_name) || 'the supplier'}`} tone="green">
        <Lines
          rows={[
            { k: 'Open amount', v: inrFull(amount) },
            {
              k: `Interest · ${formatNum(l.interest_pct)}% for ${formatNum(l.usance_days)}d${upfrontLc ? ' · paid upfront' : ''}`,
              v: upfrontLc ? inrFull(interest) : `− ${inrFull(interest)}`,
              fg: upfrontLc ? T.inkSoft : T.alertInk
            },
            { k: `Charges${upfrontLc ? ' · paid upfront' : ''}`, v: upfrontLc ? inrFull(charges) : `− ${inrFull(charges)}`, fg: upfrontLc ? T.inkSoft : T.alertInk },
            { k: 'To the supplier', v: inrFull(reached), strong: true, big: true, fg: T.green }
          ]}
        />
      </Panel>

      {/* THE INTEREST THE BANK GAVE BACK on a preclosure — the receipt it came
          in by, linked, against what it should be (same panel as the desktop). */}
      {!!l.preclosed_date && !!l.expiry_date && s(l.preclosed_date).slice(0, 10) < s(l.expiry_date).slice(0, 10) && (
        <Panel title="Interest refund" bodyClass="p-[10px]">
          <LcCommissionLink kind="refund" lcId={Number(l.id)} />
        </Panel>
      )}
      <Panel title="Timeline">
        <Timeline steps={steps} />
      </Panel>

      <Panel title="The term">
        <div className="grid grid-cols-2 gap-3">
          {[
            { k: 'Usance', v: n(l.usance_days) ? `${formatNum(l.usance_days)} days` : '—' },
            { k: 'Interest', v: n(l.interest_pct) ? `${formatNum(l.interest_pct)}% p.a.` : '—' },
            { k: 'Margin', v: n(l.margin_pct) ? `${formatNum(l.margin_pct)}%` : '—' },
            { k: 'FD no', v: s(l.fd_no) || '—' }
          ].map((t) => (
            <div key={t.k} className="min-w-0">
              <Cap>{t.k}</Cap>
              <div className="mt-1 truncate text-[13.5px] font-bold" style={{ fontFamily: MONO }}>
                {t.v}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Every movement"
        right={
          <span
            className="whitespace-nowrap rounded-[2px] border px-1.5 py-[2px] text-[10.5px] font-bold"
            style={{ fontFamily: MONO, background: T.blueBg, color: T.blue, borderColor: T.blueRule }}
          >
            {inrShort(outstanding)} owed
          </span>
        }
        bodyClass="p-0"
      >
        {reps.length === 0 && pins.length === 0 ? (
          <div className="px-[13px] py-5 text-center text-[12px] font-semibold" style={{ color: T.inkSoft }}>
            Nothing has moved on this LC yet.
          </div>
        ) : (
          [
            ...reps.map((r) => ({ k: 'Repaid to the bank', v: `− ${inrFull(n(r.amount))}`, on: r.repay_date || r.date, fg: T.alertInk, dir: 'out' })),
            ...pins.map((p) => ({ k: 'Payment in from the customer', v: `+ ${inrFull(n(p.amount))}`, on: p.pay_date || p.date, fg: T.green, dir: 'in' }))
          ]
            .sort((a, b) => s(a.on).localeCompare(s(b.on)))
            .map((g, i) => (
              <div key={i} className="flex items-start gap-2.5 border-b px-[13px] py-[11px]" style={{ borderColor: T.rule2 }}>
                {g.dir === 'in' ? (
                  <ArrowUpRight className="mt-0.5 h-[17px] w-[17px] shrink-0" style={{ color: T.green }} />
                ) : (
                  <ArrowUpDown className="mt-0.5 h-[17px] w-[17px] shrink-0" style={{ color: T.navy }} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-extrabold">{g.k}</div>
                  <div className="mt-0.5 text-[10.5px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                    {fmtD(g.on)}
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-[13px] font-bold" style={{ fontFamily: MONO, color: g.fg }}>
                  {g.v}
                </span>
              </div>
            ))
        )}
      </Panel>

      {acts.second && (
        <button
          type="button"
          onClick={acts.second.go}
          className="flex h-12 flex-none items-center justify-center rounded-[4px] border bg-white text-[13px] font-extrabold"
          style={{ borderColor: T.field, color: T.inkMid }}
        >
          {acts.second.label}
        </button>
      )}
    </Screen>
  )
}

function BdDetail({
  b,
  onClose,
  onRepay,
  onEdit,
  onPayParty,
  onDelete
}: {
  b: Row
  onClose: () => void
  onRepay: () => void
  onEdit: () => void
  onPayParty?: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [reps, setReps] = useState<Row[]>([])
  const [ints, setInts] = useState<Row[]>([])
  useEffect(() => {
    let live = true
    void Promise.all([
      window.api.billDiscounting.repayments(Number(b.id)).catch(() => [] as Row[]),
      window.api.billDiscounting.interestPayments(Number(b.id)).catch(() => [] as Row[])
    ]).then(([r, i]) => {
      if (!live) return
      setReps(r)
      setInts(i)
    })
    return () => {
      live = false
    }
  }, [b.id])

  const repaid = s(b.status) === 'repaid' || s(b.stage) === 'repaid'
  const awaiting = s(b.stage) === 'awaiting'
  const amount = n(b.amount)
  // The desktop's figures for this bill (bdCalc on the server). The margin
  // was "invoice less drawn", which is only right when the whole sanction is
  // drawn — and "Received" was the customer's Payment IN, not what the NBFC
  // sent.
  const invoice = n(b.invoice_amount)
  const margin = n(b.marginAmount)
  const serviced = bdServiced(b)
  const receipt = n(b.receiptAmount)
  const owed = bdDue(b)
  const repaidPct = amount > 0 ? ((amount - owed) / amount) * 100 : 0
  const payIn = !!Number(b.payment_in_expected)
  const received = n(b.payment_in_total)
  const intPaid = ints.reduce((t, x) => t + n(x.gross), 0)
  const tdsPaid = ints.reduce((t, x) => t + n(x.tds), 0)

  const steps: Step[] = [
    { k: 'Discounted', v: fmtD(b.created_at), done: true },
    { k: 'Money landed', v: fmtD(b.payment_received_date), done: !!s(b.payment_received_date), sub: awaiting ? 'interest starts the day it lands' : undefined },
    { k: repaid ? 'Repaid' : 'Maturity', v: fmtD(repaid ? b.repaid_date : b.maturity_date), done: repaid }
  ]

  return (
    <Screen
      kicker={`Bill discounting · ${s(b.finance_type) || 'PID'}`}
      title={<span style={{ fontFamily: MONO }}>{s(b.bd_no) || 'No number'}</span>}
      onClose={onClose}
      head={
        <>
          <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
            <span className="rounded-[2px] px-2 py-1 text-[10px] font-extrabold tracking-[.06em]" style={{ background: 'rgba(255,255,255,.14)' }}>
              {repaid ? 'REPAID' : awaiting ? 'AWAITING PAYMENT' : 'OPEN'}
            </span>
            <span
              className="rounded-[2px] px-2 py-1 text-[10px] font-extrabold tracking-[.06em]"
              style={{ background: 'rgba(199,240,63,.18)', color: T.lime }}
            >
              {s(b.purpose) === 'trading' ? 'TRADING' : 'MANUFACTURING'}
            </span>
          </div>
          <div className="mt-[11px] flex items-baseline justify-between gap-2.5">
            <span className="text-[10px] font-extrabold uppercase tracking-[.1em]" style={{ color: T.muted }}>
              Open amount
            </span>
            <span className="whitespace-nowrap text-[18px] font-bold tracking-[-0.02em]" style={{ fontFamily: MONO }}>
              {inrFull(amount)}
            </span>
          </div>
          <div className="mt-1 text-[11.5px] font-bold" style={{ color: T.muted }}>
            {s(b.nbfc_name) || 'NBFC not set'} · {s(b.party_names || b.supplier_name || b.customer_name) || '—'}
          </div>
        </>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onDelete}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[4px]"
            style={{ background: T.alertBg, border: `1.5px solid ${T.alertRule}` }}
            title="Delete this bill"
          >
            <Trash2 className="h-5 w-5" style={{ color: T.alert }} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-[4px] px-4 text-[13px] font-extrabold"
            style={{ border: `1.5px solid ${T.field}`, color: T.inkMid }}
          >
            <Pencil className="h-[18px] w-[18px]" /> Edit
          </button>
          <button
            type="button"
            onClick={repaid ? onClose : awaiting ? onEdit : onRepay}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[4px] text-[13.5px] font-extrabold"
            style={{
              background: repaid ? '#fff' : awaiting ? T.warnBg : T.navy,
              color: repaid ? T.inkMid : awaiting ? T.warnInk : '#fff',
              border: repaid ? `1.5px solid ${T.field}` : awaiting ? `1px solid ${T.warnRule}` : 'none'
            }}
          >
            {repaid ? 'REPAID' : awaiting ? 'MARK PAYMENT RECEIVED' : 'REPAY'}
          </button>
        </>
      }
    >
      <PhoneRefundStrip kind="bd" id={Number(b.id)} />
      {/* The NBFC still owes the supplier part of this bill. */}
      {!repaid && !awaiting && b.party_in_parts && n(b.party_left) > 0.5 && onPayParty && (
        <button
          type="button"
          onClick={onPayParty}
          className="flex h-12 flex-none items-center justify-center gap-2 rounded-[4px] text-[13px] font-extrabold text-white"
          style={{ background: T.green }}
        >
          <Banknote className="h-[18px] w-[18px]" /> PAY PARTY · {inrFull(n(b.party_left))} TO GO
        </button>
      )}
      <CellGrid
        cells={[
          { k: 'Margin held', v: inrShort(margin) },
          serviced
            ? { k: 'Interest paid', v: inrShort(intPaid), fg: T.alertInk, bg: '#FDF8F7', bd: T.alertRule }
            : { k: `Interest · ${n(b.intDays)}d`, v: inrShort(n(b.interestAmount)), fg: T.alertInk, bg: '#FDF8F7', bd: T.alertRule },
          { k: 'Received', v: inrShort(receipt), fg: T.green, bg: T.greenBg, bd: T.greenRule, kFg: T.green },
          { k: 'Still owed', v: owed <= 0.004 ? 'settled' : inrShort(owed), fg: owed > 0 ? T.warnInk : T.green }
        ]}
      />

      <div className="flex-none rounded-[4px] border bg-white px-[13px] py-3" style={{ borderColor: T.border }}>
        <div className="flex items-baseline justify-between gap-2.5">
          <Cap>Repaid to the NBFC</Cap>
          <span className="text-[15px] font-bold" style={{ fontFamily: MONO, color: repaidPct >= 99.5 ? T.green : T.ink }}>
            {repaidPct.toFixed(0)}%
          </span>
        </div>
        <div className="mt-[9px]">
          <Bar pct={repaidPct} fg={T.greenBright} />
        </div>
      </div>

      <Panel title="From the bill to your bank">
        <Lines
          rows={[
            // The desktop form's derived strip, top to bottom: the invoice, the
            // margin struck on it, what that leaves sanctioned, what was
            // drawn, what the NBFC kept, and what landed.
            ...(invoice > 0
              ? [
                  n(b.invoice_adj)
                    ? {
                        k: 'Invoice (adj.)',
                        v: inrFull(Math.max(0, round2(invoice + n(b.invoice_adj)))),
                        sub: `${inrFull(invoice)} ${n(b.invoice_adj) > 0 ? '+' : '−'} ${inrFull(Math.abs(n(b.invoice_adj)))}`
                      }
                    : { k: 'Invoice', v: inrFull(invoice) },
                  { k: `Margin · ${formatNum(b.margin_pct)}%`, v: `− ${inrFull(margin)}`, fg: T.alertInk },
                  { k: 'Sanctioned', v: inrFull(n(b.sanctionedAmount)) }
                ]
              : [{ k: `Margin · ${formatNum(b.margin_pct)}%`, v: inrFull(margin), sub: 'held against the bill' }]),
            // An older bill moved the draw by its Adj.; one on the charge basis
            // draws the whole Open amount and the Adj. comes off the payout.
            ...(n(b.open_adj) && !n(b.open_adj_charge)
              ? [
                  { k: 'Open amount', v: inrFull(round2(amount - n(b.open_adj))) },
                  { k: 'Adj. on the open amount', v: `${n(b.open_adj) > 0 ? '+' : '−'} ${inrFull(Math.abs(n(b.open_adj)))}`, fg: T.inkSoft }
                ]
              : []),
            { k: n(b.open_adj) && !n(b.open_adj_charge) ? 'Drawn' : 'Open amount (drawn)', v: inrFull(amount), strong: true },
            serviced
              ? { k: 'Interest', v: 'serviced', fg: T.inkSoft, sub: 'paid across the tenor, not withheld' }
              : b.interest_upfront
                ? { k: `Interest · ${n(b.intDays)}d`, v: inrFull(n(b.interestAmount)), fg: T.alertInk, sub: `upfront — settled on its own voucher · ${inrFull(n(b.tdsAmount))} TDS` }
                : { k: `Interest · ${n(b.intDays)}d`, v: `− ${inrFull(n(b.interestAmount))}`, fg: T.alertInk, sub: `${inrFull(n(b.tdsAmount))} TDS withheld` },
            ...(n(b.open_adj) && n(b.open_adj_charge)
              ? [
                  {
                    k: n(b.open_adj) < 0 ? `Adj. — ${adjKindsLabel(b.open_adj_ledger, b.open_adj_split)}` : 'Adj. — added to the payout',
                    v: `${n(b.open_adj) > 0 ? '+' : '−'} ${inrFull(Math.abs(n(b.open_adj)))}`,
                    fg: n(b.open_adj) < 0 ? T.alertInk : T.inkSoft
                  }
                ]
              : []),
            { k: 'Receipt · reached you', v: inrFull(receipt), fg: T.green, strong: true, big: true },
            ...(intPaid > 0 ? [{ k: 'Interest paid so far', v: `− ${inrFull(intPaid)}`, fg: T.alertInk, sub: tdsPaid > 0 ? `${inrFull(tdsPaid)} TDS withheld` : undefined }] : []),
            ...(payIn
              ? [
                  {
                    k: `Payment IN · ${s(b.receivable_party_name) || 'the customer'}`,
                    v: received > 0.004 ? inrFull(received) : 'awaited',
                    fg: received > 0.004 ? T.green : T.warnInk,
                    sub: received > 0.004 && b.payment_in_last_date ? `last on ${fmtD(b.payment_in_last_date)}` : undefined
                  }
                ]
              : [])
          ]}
        />
      </Panel>

      <Panel title="The term">
        <div className="grid grid-cols-2 gap-3">
          {[
            { k: 'Interest', v: n(b.interest_pct) ? `${formatNum(b.interest_pct)}% p.a.` : '—' },
            { k: 'TDS', v: n(b.tds_pct) ? `${formatNum(b.tds_pct)}%` : '—' },
            { k: 'Days in year', v: s(b.days_year) || '360' },
            { k: 'Maturity', v: fmtD(b.maturity_date) }
          ].map((t) => (
            <div key={t.k} className="min-w-0">
              <Cap>{t.k}</Cap>
              <div className="mt-1 truncate text-[13.5px] font-bold" style={{ fontFamily: MONO }}>
                {t.v}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {serviced && <ServicedSchedule id={Number(b.id)} />}
      <Panel title="Timeline">
        <Timeline steps={steps} />
      </Panel>

      <Panel
        title="Every movement"
        right={
          <span
            className="whitespace-nowrap rounded-[2px] border px-1.5 py-[2px] text-[10.5px] font-bold"
            style={{ fontFamily: MONO, background: T.blueBg, color: T.blue, borderColor: T.blueRule }}
          >
            {inrShort(owed)} owed
          </span>
        }
        bodyClass="p-0"
      >
        {reps.length === 0 && ints.length === 0 ? (
          <div className="px-[13px] py-5 text-center text-[12px] font-semibold" style={{ color: T.inkSoft }}>
            Nothing has gone back on this bill yet.
          </div>
        ) : (
          [
            ...reps.map((r) => ({ k: 'Repaid to the NBFC', v: `− ${inrFull(n(r.amount))}`, on: r.repay_date, fg: T.alertInk, st: s(r.settle_via) === 'party' ? 'VIA PARTY' : 'FROM BANK' })),
            ...ints.map((x) => ({ k: `Interest to ${fmtD(x.to_date)}`, v: `− ${inrFull(n(x.gross))}`, on: x.paid_date || x.to_date, fg: T.alertInk, st: x.journal_entry_id ? 'POSTED' : 'RECORDED' }))
          ]
            .sort((a, c) => s(a.on).localeCompare(s(c.on)))
            .map((g, i) => (
              <div key={i} className="flex flex-col gap-[5px] border-b px-[13px] py-[11px]" style={{ borderColor: T.rule2 }}>
                <div className="flex items-start gap-[9px]">
                  <ArrowUpDown className="mt-px h-[17px] w-[17px] shrink-0" style={{ color: T.navy }} />
                  <span className="min-w-0 flex-1 text-[12.5px] font-extrabold leading-[1.35]">{g.k}</span>
                  <span className="shrink-0 whitespace-nowrap text-[13px] font-bold" style={{ fontFamily: MONO, color: g.fg }}>
                    {g.v}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-[26px]">
                  <Tag bg={T.chip} fg={T.inkSoft} bd={T.border} size={9.5}>
                    {g.st}
                  </Tag>
                  <span className="text-[10.5px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                    {fmtD(g.on)}
                  </span>
                </div>
              </div>
            ))
        )}
      </Panel>
    </Screen>
  )
}

// ============================================================ stage advance

// Application → Open, or Open → Payment received. The two steps an LC takes
// before it is running, each asking for the facts that move it on.
function StageScreen({
  l,
  lcs,
  onClose,
  onSaved
}: {
  l: Row
  lcs: Row[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const next = nextLcStage(s(l.stage || 'application'))
  const [f, setF] = useState<Row>(() =>
    next === 'open'
      ? { lc_no: s(l.lc_no), opened_date: s(l.opened_date) || todayISO() }
      : {
          payment_received_date: s(l.payment_received_date) || todayISO(),
          expiry_date: s(l.expiry_date),
          interest_pct: s(l.interest_pct),
          charges: s(l.charges),
          interest_upfront: !!l.interest_upfront,
          interest_excl_charges: !!l.interest_excl_charges,
          interest_adj: l.interest_adj == null || n(l.interest_adj) === 0 ? '' : String(l.interest_adj),
          pay_in_parts: false,
          first_installment: '',
          first_installment_maturity: ''
        }
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const days = next === 'payment_received' ? daysBetween(f.payment_received_date, f.expiry_date) : null
  const preview = { ...l, ...f, amount: n(l.amount), usance_days: days ?? 0 }
  const interest = next === 'payment_received' ? lcInterestOfDays(preview, days ?? 0) : 0
  const charges = round2(n(f.charges))
  // Upfront, interest and charges are paid to the bank separately — the whole
  // open amount reaches the supplier (the desktop's netAvailable).
  const reached = f.interest_upfront ? round2(n(l.amount)) : round2(n(l.amount) - interest - charges)

  const missing =
    next === 'open'
      ? [!s(f.lc_no).trim() && 'LC no', !s(f.opened_date) && 'Opened date'].filter(Boolean)
      : [!s(f.payment_received_date) && 'Payment received date', !s(f.expiry_date) && 'Maturity date'].filter(Boolean)

  async function save(): Promise<void> {
    if (!next) return
    if (missing.length) return setErr(`Still needed: ${missing.join(', ')}`)
    if (next === 'open') {
      const clash = lcNoClash(lcs, f.lc_no, l.id)
      if (clash) return setErr(`LC ${s(f.lc_no).trim()} already exists in this company — ${s(clash.bank) || 'another bank'}. Use the number the bank gave this credit.`)
    }
    if (next === 'payment_received') {
      if (l.opened_date && s(f.payment_received_date) < s(l.opened_date)) {
        return setErr('Payment received date cannot be before the date the LC was opened')
      }
      if (days != null && days < 0) return setErr('The maturity date has to fall after the payment was received')
      if (f.pay_in_parts) {
        if (f.interest_upfront) return setErr("This LC's interest is paid upfront, so it cannot be split into parts with their own maturities")
        if (!(n(f.first_installment) > 0)) return setErr("Enter part 1's LC amount")
        if (n(f.first_installment) > n(l.amount) + 0.005) return setErr(`Part 1 cannot be more than the LC's ${inrFull(n(l.amount))}`)
        const mat = s(f.first_installment_maturity || f.expiry_date)
        if (!mat) return setErr('Pick when part 1 matures')
        if (mat < s(f.payment_received_date)) return setErr('Part 1 cannot mature before it was paid')
      }
    }
    const firstPart = next === 'payment_received' && f.pay_in_parts ? round2(n(f.first_installment)) : 0
    setBusy(true)
    setErr(null)
    try {
      await window.api.lc.update(Number(l.id), {
        ...l,
        facility_type: 'lc',
        party_type: 'supplier',
        party_id: l.party_id ? Number(l.party_id) : null,
        facility_id: l.facility_id ? Number(l.facility_id) : null,
        status: l.status || 'open',
        stage: next,
        ...f,
        // The interest is worked out on the days between the two dates just
        // entered — without this the LC would keep whatever usance it had and
        // the interest saved would disagree with the one shown here.
        ...(next === 'payment_received' ? { usance_days: days ?? 0 } : {}),
        first_installment: firstPart > 0 ? firstPart : null,
        first_installment_maturity: firstPart > 0 ? s(f.first_installment_maturity || f.expiry_date) : null
      })
      toast.success(
        next === 'open'
          ? 'LC marked Open'
          : firstPart > 0
            ? `Payment received — part 1 of ${inrFull(firstPart)} posted`
            : 'Payment received — bill(s) settled through the books'
      )
      await onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      kicker={`${STAGE_LABEL[s(l.stage || 'application')]} → ${next ? STAGE_LABEL[next] : ''}`}
      title={next === 'open' ? 'Mark this LC open' : 'Mark payment received'}
      sub={`${s(l.bank) || 'Bank'} · ${s(l.supplier_name) || '—'} · ${inrFull(n(l.amount))}`}
      headBg={T.navy}
      onClose={onClose}
      footer={
        <>
          <Req missing={missing as string[]} />
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CANCEL</Btn>
            <Btn kind="navy" onClick={() => void save()} disabled={busy} icon={<Check className="h-[19px] w-[19px]" />}>
              {busy ? 'SAVING…' : 'SAVE'}
            </Btn>
          </div>
        </>
      }
    >
      {next === 'open' ? (
        <Panel title="The bank opened the credit">
          <div className="grid gap-[13px]">
            <Field label="LC no" req hint="The number the bank gave this credit.">
              <TextIn value={s(f.lc_no)} onChange={(v) => setF((p) => ({ ...p, lc_no: v }))} placeholder="027LC03261500005" mono bad={!!err && !s(f.lc_no).trim()} />
            </Field>
            <Field label="Opened date" req hint="The day the bank actually opened it.">
              <DateIn value={s(f.opened_date)} onChange={(v) => setF((p) => ({ ...p, opened_date: v }))} max={todayISO()} />
            </Field>
          </div>
        </Panel>
      ) : (
        <>
          <Panel title="The bank paid the supplier">
            <div className="grid grid-cols-2 gap-[13px]">
              <Field label="Payment received" req>
                <DateIn value={s(f.payment_received_date)} onChange={(v) => setF((p) => ({ ...p, payment_received_date: v }))} max={todayISO()} />
              </Field>
              <Field label="Maturity date" req>
                <DateIn value={s(f.expiry_date)} onChange={(v) => setF((p) => ({ ...p, expiry_date: v }))} />
              </Field>
              <Field label="Interest % p.a.">
                <TextIn value={s(f.interest_pct)} onChange={(v) => setF((p) => ({ ...p, interest_pct: num(v) }))} placeholder="6.8" mono inputMode="decimal" />
              </Field>
              <Field label="Charges (₹)">
                <TextIn value={s(f.charges)} onChange={(v) => setF((p) => ({ ...p, charges: num(v) }))} placeholder="0" mono inputMode="decimal" />
              </Field>
              <Field label="Interest days (computed)" full>
                <div
                  className="flex h-[44px] items-center gap-[9px] rounded-[4px] border px-[11px] text-[13.5px] font-bold"
                  style={{ fontFamily: MONO, borderColor: T.headRule, background: T.head }}
                >
                  <Timer className="h-[18px] w-[18px]" style={{ color: T.inkFaint }} />
                  {days == null ? '—' : `${days} days`}
                </div>
              </Field>
            </div>
            <div className="mt-2">
              <Toggle
                on={!!f.interest_excl_charges}
                onClick={() => setF((p) => ({ ...p, interest_excl_charges: !p.interest_excl_charges }))}
                label="Interest leaves the charges out"
                note="The bank charges interest on the open amount less its own charges."
              />
              <Toggle
                on={!!f.interest_upfront}
                onClick={() => setF((p) => ({ ...p, interest_upfront: !p.interest_upfront }))}
                label="Interest taken upfront"
                note="The bank deducts the whole interest the day it pays."
              />
            </div>
          </Panel>
          <Panel title="What will reach the supplier" tone="green">
            <Lines
              rows={[
                { k: 'Open amount', v: inrFull(n(l.amount)) },
                { k: `Interest · ${formatNum(f.interest_pct)}% for ${days ?? 0}d`, v: `− ${inrFull(interest)}`, fg: T.alertInk },
                { k: 'Charges', v: `− ${inrFull(charges)}`, fg: T.alertInk },
                { k: 'To the supplier', v: inrFull(reached), strong: true, big: true, fg: T.green }
              ]}
            />
          </Panel>
          {n(l.utilized) < 0.005 && (
            <Panel title="Payment to the supplier">
              <div className="grid gap-[13px]">
                <Seg
                  wide
                  value={f.pay_in_parts ? 'parts' : 'full'}
                  onChange={(k) => setF((p) => ({ ...p, pay_in_parts: k === 'parts' }))}
                  options={[
                    { k: 'full', label: 'Paid in full' },
                    { k: 'parts', label: 'In parts' }
                  ]}
                />
                {f.pay_in_parts ? (
                  (() => {
                    const amt = round2(n(f.first_installment))
                    const mat = s(f.first_installment_maturity || f.expiry_date)
                    const pv = lcPartPreview({ ...l, ...f }, amt, s(f.payment_received_date), mat, true)
                    const over = amt > n(l.amount) + 0.005
                    return (
                      <>
                        <Field
                          label="Part 1 — LC amount (₹)"
                          req
                          hint={
                            over
                              ? `More than the LC's ${inrFull(n(l.amount))}.`
                              : `Interest ${inrFull(pv.interest)} (${pv.days}d) · supplier receives ${inrFull(amt > 0 ? pv.net : 0)} · ${inrFull(Math.max(0, round2(n(l.amount) - amt)))} left for later parts.`
                          }
                          hintFg={over ? T.alert : T.inkSoft}
                        >
                          <TextIn
                            value={s(f.first_installment)}
                            onChange={(v) => setF((p) => ({ ...p, first_installment: num(v) }))}
                            placeholder="As on the bank's bill"
                            mono
                            big
                            inputMode="decimal"
                          />
                        </Field>
                        <Field label="Part 1 matures on" req>
                          <DateIn value={mat} min={s(f.payment_received_date) || undefined} onChange={(v) => setF((p) => ({ ...p, first_installment_maturity: v }))} />
                        </Field>
                      </>
                    )
                  })()
                ) : (
                  <div className="text-[12px] font-semibold" style={{ color: T.inkSoft }}>
                    The whole {inrFull(reached)} reaches the supplier on the payment received date.
                  </div>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

function ErrorNote({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex flex-none items-start gap-[9px] rounded-[3px] border px-[13px] py-[11px]"
      style={{ background: T.alertBg, borderColor: T.alertRule, borderLeft: `4px solid ${T.alert}` }}
    >
      <AlertTriangle className="h-[18px] w-[18px] shrink-0" style={{ color: T.alert }} />
      <span className="text-[12px] font-bold leading-[1.5]" style={{ color: T.alertInk }}>
        {text}
      </span>
    </div>
  )
}

// =============================================================== payment in

// The customer's money for the resale, on a trading LC. It is settled against
// the invoices it pays, so at least one of them has to be picked.
function PaymentInScreen({
  l,
  onClose,
  onSaved
}: {
  l: Row
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [inv, setInv] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.api.lc
      .openTradingInvoices(Number(l.id))
      .catch(() => [] as Row[])
      .then((rows) => {
        if (!live) return
        setInv(rows)
        const all = rows.map((x) => s(x.key))
        setPicked(all)
        setAmount(String(round2(rows.reduce((t, x) => t + n(x.due), 0))))
      })
    return () => {
      live = false
    }
  }, [l.id])

  function toggle(key: string): void {
    const nextKeys = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]
    setPicked(nextKeys)
    setAmount(String(round2((inv || []).filter((x) => nextKeys.includes(s(x.key))).reduce((t, x) => t + n(x.due), 0))))
  }

  const missing = [!(n(amount) > 0.005) && 'Amount', !picked.length && 'An invoice'].filter(Boolean) as string[]

  async function save(): Promise<void> {
    if (missing.length) return setErr(`Still needed: ${missing.join(', ')}`)
    setBusy(true)
    setErr(null)
    try {
      await window.api.lc.paymentIn(Number(l.id), n(amount), date, picked)
      toast.success('Payment IN recorded — no voucher')
      await onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      kicker="Trading LC · payment in"
      title={<span style={{ fontFamily: MONO }}>{s(l.lc_no) || 'LC'}</span>}
      sub={`From ${s(l.receivable_party_name) || 'the customer'} · for the resale`}
      onClose={onClose}
      footer={
        <>
          <Req missing={missing} />
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CANCEL</Btn>
            <Btn kind="go" onClick={() => void save()} disabled={busy} icon={<Banknote className="h-[19px] w-[19px]" />}>
              {busy ? 'POSTING…' : 'POST PAYMENT'}
            </Btn>
          </div>
        </>
      }
    >
      <Panel title="The money in">
        <div className="grid gap-[13px]">
          <Field label="Amount received (₹)" req>
            <TextIn value={amount} onChange={(v) => setAmount(num(v))} placeholder="0.00" mono big inputMode="decimal" />
          </Field>
          <Field label="Received on" req>
            <DateIn value={date} onChange={setDate} max={todayISO()} />
          </Field>
        </div>
      </Panel>
      <Panel
        title="Invoices this settles"
        right={
          <span className="text-[11px] font-bold" style={{ fontFamily: MONO, color: T.inkSoft }}>
            {picked.length} of {inv?.length ?? 0}
          </span>
        }
        bodyClass="px-[15px] pb-[13px] pt-1.5"
      >
        {inv == null ? (
          <div className="py-4 text-center text-[12px] font-semibold" style={{ color: T.inkSoft }}>
            Reading the invoices…
          </div>
        ) : inv.length === 0 ? (
          <div className="py-4 text-center text-[12px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
            This LC has no open resale invoice to settle — there is nothing for a payment in to go against.
          </div>
        ) : (
          inv.map((x) => {
            const on = picked.includes(s(x.key))
            return (
              <button
                key={s(x.key)}
                type="button"
                onClick={() => toggle(s(x.key))}
                className="flex w-full items-center gap-[11px] border-b py-2.5 text-left"
                style={{ borderColor: T.rule2 }}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px]"
                  style={{ border: `1.5px solid ${on ? T.forest : T.field}`, background: on ? T.lime : '#fff' }}
                >
                  {on && <Check className="h-[15px] w-[15px]" style={{ color: T.forest }} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-bold" style={{ fontFamily: MONO }}>
                    {s(x.invoice_no || x.label || x.key)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                    {s(x.party || x.customer_name)} {x.sale_date || x.date ? `· ${fmtD(x.sale_date || x.date)}` : ''}
                  </span>
                </span>
                <span className="ml-auto shrink-0 text-[12.5px] font-bold" style={{ fontFamily: MONO }}>
                  {inrFull(n(x.due))}
                </span>
              </button>
            )
          })
        )}
      </Panel>
      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// ================================================================= preclose

// Wind the LC up early (or repay it once it has matured). The bank debits the
// open amount plus whatever it takes on top; that excess has to be split into
// commission and bank charges before it will post.
function PrecloseScreen({
  l,
  editing = false,
  onClose,
  onSaved
}: {
  l: Row
  // Correcting a closure already booked: the sheet opens on how it WAS
  // closed, and saving re-posts the closure's vouchers from the new figures.
  editing?: boolean
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const openAmount = n(l.amount)
  const matured = isLcPastMaturity(l)
  const closedOn = s(l.preclosed_date).slice(0, 10)
  const [date, setDate] = useState(editing && closedOn ? closedOn : todayISO())
  const [total, setTotal] = useState(String(openAmount))
  // The bank's charges in this debit, one row per ledger.
  const [chg, setChg] = useState<ChargeRow[]>([])
  const [premature, setPremature] = useState(editing && l.preclose_premature_interest != null ? String(round2(n(l.preclose_premature_interest))) : '')
  const [dir, setDir] = useState<'credit_to_us' | 'pay_to_party'>(
    editing && s(l.preclose_interest_route) === 'pay_to_party' ? 'pay_to_party' : 'credit_to_us'
  )
  // Off unless asked for, as on the desktop — on by default, a phone preclose
  // posted a margin-release voucher nobody chose.
  const [release, setRelease] = useState(editing && s(l.preclose_settlement_direction) === 'margin_released')
  // The repayment the closure logged carries the bank's debit and its split.
  useEffect(() => {
    if (!editing) return
    let live = true
    void window.api.lc
      .repayments(Number(l.id))
      .catch(() => [] as Row[])
      .then((reps) => {
        if (!live) return
        const rep =
          (reps as Row[]).find((r) => s(r.note) === 'Preclosure repayment' && s(r.repay_date).slice(0, 10) === closedOn) ||
          (reps as Row[]).find((r) => s(r.repay_date).slice(0, 10) === closedOn)
        if (!rep) return
        setTotal(String(round2(n(rep.amount))))
        setChg(chargeRowsFrom(rep))
      })
    return () => {
      live = false
    }
  }, [editing, l.id, closedOn])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const start = s(l.payment_received_date || l.opened_date || l.open_date).slice(0, 10)
  const elapsed = start ? Math.max(0, daysBetween(start, date) ?? 0) : 0
  const pending = s(l.expiry_date) ? Math.max(0, daysBetween(date, l.expiry_date) ?? 0) : 0
  const interestDue = lcInterestOfDays(l, elapsed)
  const prematureSuggest = lcInterestOfDays(l, pending)
  const margin = round2((openAmount * n(l.margin_pct)) / 100)
  const excess = round2(n(total) - openAmount)
  const split = chargeRowsTotal(chg)
  const balanced = excess <= 0.005 || Math.abs(split - excess) <= 0.005
  const tooLow = !(n(total) >= openAmount - 0.005)

  // Offer the days that will never happen as the rebate, the first time the
  // figure is there to offer.
  useEffect(() => {
    if (!editing && !matured && premature === '' && prematureSuggest > 0) setPremature(String(prematureSuggest))
  }, [prematureSuggest]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save(): Promise<void> {
    if (!date) return setErr('Pick the pre-closure date')
    if (l.open_date && date < s(l.open_date)) return setErr('Pre-closure date cannot be before the application date')
    if (tooLow) return setErr(`The total debited (${inrFull(n(total))}) cannot be less than the open amount (${inrFull(openAmount)})`)
    const rowProblem = chargeRowsProblem(chg)
    if (rowProblem) return setErr(rowProblem)
    if (!balanced) return setErr(`The charges must add up to the ${inrFull(excess)} over the open amount`)
    setBusy(true)
    setErr(null)
    try {
      const values = {
        preclose_date: date,
        amount: n(total),
        comm_charges: 0,
        bank_charges: 0,
        charges: excess > 0.005 ? chargeRowsPayload(chg) : [],
        premature_interest: n(premature),
        premature_interest_direction: dir,
        release_margin: release
      }
      if (editing) await window.api.lc.editPreclosure(Number(l.id), values)
      else await window.api.lc.preclose(Number(l.id), values)
      toast.success(
        editing
          ? 'Closure updated — its repayment, rebate and ledger entries re-posted'
          : matured
            ? 'LC repaid — posted to the books'
            : 'LC preclosed — repayment logged and rebate posted to the books'
      )
      await onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      kicker={editing ? 'Edit closure' : matured ? 'Repay at maturity' : 'Wind up early'}
      title={`${editing ? 'Edit closure of' : matured ? 'Repay' : 'Preclose'} ${s(l.lc_no) || 'this LC'}`}
      sub={`${s(l.bank) || 'Bank'} · ${s(l.supplier_name) || '—'} · maturity ${fmtD(l.expiry_date)}`}
      onClose={onClose}
      footer={
        <>
          <div className="flex min-w-0 flex-1 items-center gap-[7px] text-[12px] font-bold" style={{ color: T.inkSoft }}>
            <History className="h-[17px] w-[17px] shrink-0" style={{ color: T.inkFaint }} />
            {editing ? 'Saving re-posts its ledger entries.' : 'Preclosure can be undone later.'}
          </div>
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CANCEL</Btn>
            <Btn kind="go" onClick={() => void save()} disabled={busy || tooLow || !balanced} icon={<CalendarCheck className="h-[19px] w-[19px]" />}>
              {busy ? 'SAVING…' : editing ? 'SAVE' : matured ? 'REPAY' : 'PRECLOSE'}
            </Btn>
          </div>
        </>
      }
    >
      <Panel>
        <Field label="Pre-closure date" req>
          <DateIn value={date} onChange={setDate} max={todayISO()} />
        </Field>
      </Panel>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <Calculator className="h-[17px] w-[17px]" /> What the bank will debit
          </span>
        }
        tone="alert"
        bodyClass="px-[15px] pb-3.5 pt-1.5"
      >
        <Lines
          rows={[
            { k: 'Open amount', v: inrFull(openAmount) },
            { k: `Interest for the ${elapsed} days elapsed`, v: inrFull(interestDue), fg: T.alertInk, sub: `from ${fmtD(start)} to ${fmtD(date)}` },
            ...(matured ? [] : [{ k: `Premature interest · ${pending} days not run`, v: inrFull(prematureSuggest), fg: T.warnInk }]),
            { k: `Margin refunded · ${formatNum(l.margin_pct)}%`, v: `+ ${inrFull(margin)}`, fg: T.green }
          ]}
        />
      </Panel>

      <Panel title="The debit">
        <div className="grid gap-[13px]">
          <Field
            label="Total debited by the bank (₹)"
            req
            hint={tooLow ? `Cannot be less than the open amount, ${inrFull(openAmount)}.` : excess > 0.005 ? `${inrFull(excess)} over the open amount — split it below.` : 'The open amount exactly.'}
            hintFg={tooLow ? T.alert : excess > 0.005 ? T.warnInk : T.green}
          >
            <TextIn value={total} onChange={(v) => setTotal(num(v))} mono big bad={tooLow} inputMode="decimal" />
          </Field>
          {excess > 0.005 && (
            <Field label="Charges in this debit — one row per ledger">
              <ChargeRows value={chg} onChange={setChg} />
            </Field>
          )}
          {excess > 0.005 &&
            (balanced ? (
              <div
                className="flex items-center gap-[9px] rounded-[3px] border px-[13px] py-[11px]"
                style={{ background: T.greenBg, borderColor: T.greenRule, borderLeft: `4px solid ${T.greenBright}` }}
              >
                <CheckCircle2 className="h-[18px] w-[18px] shrink-0" style={{ color: T.greenBright }} />
                <span className="text-[12px] font-bold" style={{ color: T.green }}>
                  The split adds up. Margin of {inrFull(margin)} is refunded on closure.
                </span>
              </div>
            ) : (
              <ErrorNote text={`Comm. + bank charges come to ${inrFull(split)} — they have to make the ${inrFull(excess)} over the open amount.`} />
            ))}
        </div>
      </Panel>

      {!matured && (
        <Panel title="The days that will not run">
          <div className="grid gap-[13px]">
            <Field label="Premature interest (₹)" hint={`Suggested ${inrFull(prematureSuggest)} for ${pending} days.`}>
              <TextIn value={premature} onChange={(v) => setPremature(num(v))} placeholder="0.00" mono inputMode="decimal" />
            </Field>
            <Field label="It goes">
              <Seg
                wide
                value={dir}
                onChange={setDir}
                options={[
                  { k: 'credit_to_us', label: 'Back to us' },
                  { k: 'pay_to_party', label: 'To the party' }
                ]}
              />
            </Field>
          </div>
        </Panel>
      )}

      <Panel>
        <Toggle
          on={release}
          onClick={() => setRelease((r) => !r)}
          label={`Release the margin (${inrFull(margin)})`}
          note="The FD held against this LC comes back into the account on closure."
        />
      </Panel>

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// =================================================================== repay

// Money back to the NBFC on a discounted bill — the principal, in full or in
// part, from the bank or through the party. Interest on a serviced bill is paid
// here too, up to a date.
function RepayScreen({
  b,
  initialKind = 'full',
  onClose,
  onChanged,
  onDone
}: {
  b: Row
  initialKind?: 'full' | 'interest'
  onClose: () => void
  onChanged: () => void | Promise<void>
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const [row, setRow] = useState<Row>(b)
  const due = bdDue(row)
  const [kind, setKind] = useState<'full' | 'interest'>(initialKind)
  const [amount, setAmount] = useState(String(due))
  const [date, setDate] = useState(todayISO())
  const [via, setVia] = useState<'bank' | 'party'>('bank')
  const [ref, setRef] = useState('')
  const [release, setRelease] = useState(true)
  // The same as the desktop Repay form: interest, then a row per ledger the
  // debit carried — as many as it carried.
  const [intr, setIntr] = useState('')
  // PENALTY INTEREST past maturity — the NBFC's rate, worked out until typed
  // over (same as the desktop Repay form).
  const [penPct, setPenPct] = useState('')
  const [penAmt, setPenAmt] = useState('')
  useEffect(() => {
    let live = true
    void window.api.data
      .list('nbfcs')
      .then((list: Row[]) => {
        const nb = list.find((x) => String(x.id) === String(row.nbfc_id))
        if (live && n(nb?.penalty_pct) > 0) setPenPct(String(n(nb?.penalty_pct)))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [row.nbfc_id])
  const [chg, setChg] = useState<{ account: string; amount: string }[]>([])
  const [reps, setReps] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Interest up to a date — only for a bill whose interest is serviced as it runs.
  const [win, setWin] = useState<Row | null>(null)
  const [intDate, setIntDate] = useState(todayISO())

  const serviced = s(row.interest_mode) === 'serviced' || s(row.interest_mode) === 'monthly'

  const reload = useCallback(async () => {
    const r = await window.api.billDiscounting.repayments(Number(row.id)).catch(() => [] as Row[])
    setReps(r)
  }, [row.id])
  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (kind !== 'interest') return
    let live = true
    void window.api.billDiscounting
      .interestWindow(Number(row.id), intDate)
      .catch(() => null)
      .then((w) => live && setWin(w))
    return () => {
      live = false
    }
  }, [kind, intDate, row.id])

  const lateDays = (() => {
    const mat = s(row.maturity_date).slice(0, 10)
    const on = s(date).slice(0, 10)
    return mat && on && on > mat ? daysBetween(mat, on) || 0 : 0
  })()
  const penWorked = round2((due * n(penPct) * lateDays) / (100 * (n(row.days_year) || 360)))
  const penalty = lateDays > 0 ? (penAmt.trim() === '' ? penWorked : round2(n(penAmt))) : 0
  const paid = round2(n(row.amount) - due)
  const paidPct = n(row.amount) > 0 ? (paid / n(row.amount)) * 100 : 0
  const nowPct = n(row.amount) > 0 ? (Math.min(n(amount), due) / n(row.amount)) * 100 : 0
  const over = n(amount) - due > 0.004
  const missing = kind === 'full' ? ([!(n(amount) > 0) && 'Amount'].filter(Boolean) as string[]) : []

  async function saveRepay(): Promise<void> {
    const amt = round2(n(amount))
    if (amt <= 0) return setErr('Enter the amount being repaid')
    if (amt - due > 0.004) return setErr(`Only ${inrFull(due)} is still outstanding on this bill`)
    const bad = chg.find((c) => (c.account.trim() || n(c.amount)) && !(c.account.trim() && n(c.amount) > 0))
    if (bad) return setErr(bad.account.trim() ? `Enter the amount charged to ${bad.account}` : 'Pick the ledger for each charge')
    setBusy(true)
    setErr(null)
    try {
      const res = await window.api.billDiscounting.repay(Number(row.id), {
        repay_date: date || undefined,
        settle_via: via,
        ref: via === 'party' && ref ? ref : null,
        release_margin: release,
        amount: amt,
        also: [],
        interest: intr.trim() === '' ? null : Number(intr),
        penalty: penalty > 0.004 ? penalty : null,
        penalty_pct: penalty > 0.004 ? n(penPct) || null : null,
        penalty_days: penalty > 0.004 ? lateDays : null,
        charges: chg.filter((c) => c.account.trim() && round2(n(c.amount)) > 0).map((c) => ({ account: c.account.trim(), amount: round2(n(c.amount)) })),
        party_id: via === 'party' && row.party_id ? Number(row.party_id) : null
      })
      toast.success(res.closed ? 'Bill repaid in full — posted to the books' : `${inrFull(res.amount)} repaid — ${inrFull(res.outstanding)} still outstanding`)
      if (res.closed) {
        await onDone()
        return
      }
      // A part payment keeps the screen on the same bill, so the next
      // instalment can go straight in.
      await onChanged()
      const fresh = (await window.api.billDiscounting.list().catch(() => [] as Row[])).find((x) => Number(x.id) === Number(row.id))
      if (fresh) {
        setRow(fresh)
        setAmount(String(bdDue(fresh)))
      }
      setRef('')
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function payInterest(post: boolean): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const res = await window.api.billDiscounting.payInterestUpto(Number(row.id), { to_date: intDate, post })
      toast.success(
        `${inrFull(res.gross)} interest ${post ? 'posted' : 'recorded'} for ${res.days} day${res.days === 1 ? '' : 's'}` +
          (res.tds > 0.004 ? ` · ${inrFull(res.tds)} TDS withheld` : '')
      )
      await onChanged()
      const w = await window.api.billDiscounting.interestWindow(Number(row.id), intDate).catch(() => null)
      setWin(w)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeRepayment(id: number): Promise<void> {
    if (!confirm('Remove this repayment? Its voucher reverses too.')) return
    try {
      await window.api.billDiscounting.deleteRepayment(id)
      toast.success('Repayment removed')
      await onChanged()
      const fresh = (await window.api.billDiscounting.list().catch(() => [] as Row[])).find((x) => Number(x.id) === Number(row.id))
      if (fresh) {
        setRow(fresh)
        setAmount(String(bdDue(fresh)))
      }
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  let bal = n(row.amount)
  const history = [...reps]
    .sort((a, c) => s(a.repay_date).localeCompare(s(c.repay_date)))
    .map((r): Row => {
      bal = round2(bal - n(r.amount))
      return { ...r, after: bal }
    })

  return (
    <Screen
      kicker="Bill discounting · repay"
      title={<span style={{ fontFamily: MONO }}>BD {s(row.bd_no)}</span>}
      sub={`${s(row.nbfc_name) || 'NBFC'} · matures ${fmtD(row.maturity_date)}`}
      headBg={T.navy}
      onClose={onClose}
      footer={
        <>
          {kind === 'full' ? <Req missing={missing} /> : <div className="flex-1" />}
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CANCEL</Btn>
            {kind === 'full' && (
              <Btn kind="navy" onClick={() => void saveRepay()} disabled={busy || over || due <= 0} icon={<Banknote className="h-[19px] w-[19px]" />}>
                {busy ? 'SAVING…' : n(amount) >= due - 0.004 ? 'REPAY IN FULL' : 'REPAY PART'}
              </Btn>
            )}
          </div>
        </>
      }
    >
      <div className="flex-none overflow-hidden rounded-[4px] border bg-white" style={{ borderColor: T.border }}>
        <div className="flex flex-col gap-[11px] px-4 py-[13px]">
          <div className="text-[12.5px] font-extrabold" style={{ color: T.inkMid }}>
            {s(row.party_names || row.supplier_name || row.customer_name) || '—'}
          </div>
          <div className="flex flex-col gap-[7px]">
            {[
              { k: 'Drawn', v: inrFull(n(row.amount)), bg: '#fff', bd: T.border, fg: T.ink },
              { k: 'Repaid so far', v: inrFull(paid), bg: T.greenBg, bd: T.greenRule, fg: T.green, kFg: T.green },
              { k: 'Still owed', v: inrFull(due), bg: T.blueBg, bd: T.blueRule, fg: T.navy, kFg: T.navy }
            ].map((x) => (
              <div
                key={x.k}
                className="flex min-w-0 items-baseline justify-between gap-3 rounded-[4px] border px-3 py-2.5"
                style={{ background: x.bg, borderColor: x.bd }}
              >
                <Cap fg={x.kFg}>{x.k}</Cap>
                <Money size={15} fg={x.fg}>
                  {x.v}
                </Money>
              </div>
            ))}
          </div>
          <div className="flex h-2 overflow-hidden rounded-[2px]" style={{ background: T.rule }}>
            <div className="h-full" style={{ width: `${paidPct}%`, background: T.greenBright }} />
            {kind === 'full' && <div className="h-full" style={{ width: `${nowPct}%`, background: T.sky }} />}
          </div>
          <div className="text-[11.5px] font-bold" style={{ color: T.inkSoft }}>
            {paidPct.toFixed(0)}% repaid{kind === 'full' && n(amount) > 0 ? ` · this payment takes it to ${Math.min(100, paidPct + nowPct).toFixed(0)}%` : ''}
          </div>
        </div>
      </div>

      {serviced && (
        <div className="grid flex-none grid-cols-2 gap-2 rounded-[4px] border bg-white p-2" style={{ borderColor: T.border }}>
          {([
            { k: 'full' as const, t: 'Repay principal', sd: 'Money back to the NBFC' },
            { k: 'interest' as const, t: 'Pay interest', sd: 'Up to a date, as it runs' }
          ]).map((o) => {
            const on = kind === o.k
            return (
              <button
                key={o.k}
                type="button"
                onClick={() => setKind(o.k)}
                className="min-w-0 rounded-[4px] border px-3.5 py-3 text-left"
                style={{ borderColor: on ? T.navy : T.border, background: on ? T.blueBg : '#fff' }}
              >
                <div className="text-[13px] font-extrabold" style={{ color: on ? T.navy : T.ink }}>
                  {o.t}
                </div>
                <div className="mt-[3px] text-[11px] font-semibold leading-[1.45]" style={{ color: T.inkSoft }}>
                  {o.sd}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {kind === 'interest' ? (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Percent className="h-[17px] w-[17px]" /> Interest paid up to
            </span>
          }
          tone="blue"
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="Paid up to" req full>
              <DateIn value={intDate} onChange={setIntDate} max={todayISO()} />
            </Field>
            <Field label="Days">
              <div className="flex h-[42px] items-center rounded-[4px] border px-[11px] text-[13px] font-bold" style={{ fontFamily: MONO, borderColor: '#DCE7DB', background: T.head, color: T.inkMid }}>
                {win ? `${n(win.days)} d` : '—'}
              </div>
            </Field>
            <Field label="Interest">
              <div className="flex h-[42px] items-center rounded-[4px] border px-[11px] text-[13px] font-bold" style={{ fontFamily: MONO, borderColor: T.alertRule, background: '#FDF8F7', color: T.alertInk }}>
                {win ? inrFull(n(win.gross)) : '—'}
              </div>
            </Field>
            <Field label="Out of the bank" full hint={win && n(win.tds) > 0 ? `${inrFull(n(win.tds))} TDS withheld from the NBFC.` : undefined}>
              <div className="flex h-[42px] items-center rounded-[4px] border px-[11px] text-[13px] font-bold" style={{ fontFamily: MONO, borderColor: T.greenRule, background: T.greenBg, color: T.green }}>
                {win ? inrFull(n(win.net ?? n(win.gross) - n(win.tds))) : '—'}
              </div>
            </Field>
          </div>
          {win && Array.isArray(win.parts) && win.parts.length > 1 && <PartsTable parts={win.parts as Row[]} />}
          {/* bdInterestWindow names it `blocked` (the fact) and `blocked_note`
              (why, and the way round it) — as the desktop shows them. */}
          {win && !!win.blocked && (
            <div className="mt-3 text-[12.5px] font-semibold leading-[1.5]" style={{ color: T.warnInk }}>
              <div className="font-extrabold">{s(win.blocked)}</div>
              {!!win.blocked_note && <div className="mt-[3px]" style={{ color: T.inkSoft }}>{s(win.blocked_note)}</div>}
            </div>
          )}
          <div className="mt-3.5 flex flex-wrap gap-2">
            <Btn onClick={() => void payInterest(false)} disabled={busy || !win || n(win.gross) <= 0}>
              RECORD ONLY
            </Btn>
            <Btn kind="navy" grow onClick={() => void payInterest(true)} disabled={busy || !win || n(win.gross) <= 0} icon={<Percent className="h-[18px] w-[18px]" />}>
              {busy ? 'POSTING…' : 'PAY & POST'}
            </Btn>
          </div>
        </Panel>
      ) : (
        <Panel title="The repayment">
          <div className="flex flex-col gap-[15px]">
            <Field
              label="Amount being repaid"
              req
              hint={over ? `Only ${inrFull(due)} is still outstanding on this bill.` : n(amount) >= due - 0.004 && due > 0 ? 'The whole balance — the bill closes with this.' : n(amount) > 0 ? `Leaves ${inrFull(round2(due - n(amount)))} still owed.` : undefined}
              hintFg={over ? T.alert : T.inkSoft}
            >
              <div className="flex items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <TextIn value={amount} onChange={(v) => setAmount(num(v))} placeholder="0.00" mono big bad={over} inputMode="decimal" />
                </div>
                <button
                  type="button"
                  onClick={() => setAmount(String(due))}
                  className="h-12 shrink-0 whitespace-nowrap rounded-[4px] px-3.5 text-[12px] font-extrabold"
                  style={{ border: `1.5px solid ${T.field}`, color: T.inkMid }}
                >
                  FULL BALANCE
                </button>
              </div>
            </Field>
            <Field label="Repay date" hint="Money already gone back — today at the latest.">
              <DateIn value={date} onChange={setDate} max={todayISO()} />
            </Field>
            {lateDays > 0 && (
              <div className="grid gap-2.5 rounded-[4px] border p-3" style={{ borderColor: T.alertRule, background: '#FDF8F7' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em]" style={{ color: T.alertInk }}>
                    Penalty interest
                  </span>
                  <Tag bg="#fff" fg={T.alert} bd={T.alertRule}>
                    {lateDays} day{lateDays === 1 ? '' : 's'} past {formatDate(s(row.maturity_date))}
                  </Tag>
                </div>
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
                  <Field label="Rate % p.a.">
                    <TextIn value={penPct} onChange={(v) => { setPenPct(num(v)); setPenAmt('') }} placeholder="0.00" mono inputMode="decimal" />
                  </Field>
                  <Field label="Penalty (₹)">
                    <TextIn value={penAmt.trim() === '' ? (penWorked ? String(penWorked) : '') : penAmt} onChange={(v) => setPenAmt(num(v))} placeholder="0.00" mono inputMode="decimal" />
                  </Field>
                </div>
                <div className="text-[11.5px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
                  {inrFull(due)} × {n(penPct) || 0}% × {lateDays} / {n(row.days_year) || 360} = {inrFull(penWorked)} — posts to Penal Interest in the same debit.
                </div>
              </div>
            )}
            <Field
              label="Settle through"
              hint={via === 'party' ? 'The party paid the NBFC direct — it posts against their ledger.' : 'Out of your own bank account.'}
            >
              <Seg
                wide
                value={via}
                onChange={setVia}
                options={[
                  { k: 'bank', label: 'Our bank' },
                  { k: 'party', label: 'The party' }
                ]}
              />
            </Field>
            {via === 'party' && (
              <Field label="Bill reference" hint="Blank settles it On Account.">
                <TextIn value={ref} onChange={setRef} placeholder="Invoice / bill no to settle against" />
              </Field>
            )}
            <Field label="Interest in this debit (₹)">
              <TextIn value={intr} onChange={(v) => setIntr(num(v))} placeholder="0.00" mono inputMode="decimal" />
            </Field>
            <Field label="Charges in this debit">
              <ChargeRows value={chg} onChange={setChg} />
            </Field>
            {n(row.margin_pct) > 0 && (
              <div className="rounded-[4px] border px-[13px]" style={{ borderColor: release ? T.blueRule : T.border, background: release ? T.blueBg : '#fff' }}>
                <Toggle
                  on={release}
                  onClick={() => setRelease((r) => !r)}
                  label="Release the margin with this"
                  note={`The ${formatNum(row.margin_pct)}% margin held against this bill comes back to you.`}
                />
              </div>
            )}
          </div>
        </Panel>
      )}

      <Panel
        title={
          <span className="flex items-center gap-2">
            <History className="h-[17px] w-[17px]" /> Already repaid
          </span>
        }
        tone="sand"
        right={
          <span className="rounded-[2px] border bg-white px-[7px] py-[2px] text-[10.5px] font-bold" style={{ fontFamily: MONO, color: T.inkSoft, borderColor: T.sandRule }}>
            {reps.length}
          </span>
        }
        bodyClass="p-0"
      >
        {history.length === 0 ? (
          <div className="px-4 py-5 text-center text-[12px] font-semibold" style={{ color: T.inkSoft }}>
            Nothing has gone back on this bill yet. The whole {inrFull(n(row.amount))} is outstanding.
          </div>
        ) : (
          history.map((r) => (
            <div key={String(r.id)} className="flex flex-wrap items-center gap-[11px] border-b px-4 py-[11px]" style={{ borderColor: T.rule2 }}>
              <span className="shrink-0 text-[12px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                {fmtD(r.repay_date)}
              </span>
              <span className="shrink-0 text-[13px] font-bold" style={{ fontFamily: MONO }}>
                {inrFull(n(r.amount))}
              </span>
              <span className="shrink-0 rounded-[2px] px-[7px] py-[3px] text-[10.5px] font-bold" style={{ background: T.chip, color: T.inkSoft }}>
                {s(r.settle_via) === 'party' ? 'via party' : 'from bank'}
              </span>
              <span className="ml-auto shrink-0 text-[11.5px] font-semibold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                bal {inrShort(r.after)}
              </span>
              <button
                type="button"
                onClick={() => void removeRepayment(Number(r.id))}
                title="Remove this repayment — its voucher reverses too"
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[3px] border"
                style={{ borderColor: T.alertRule, background: T.alertBg }}
              >
                <Trash2 className="h-4 w-4" style={{ color: T.alert }} />
              </button>
            </div>
          ))
        )}
      </Panel>

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// ============================================================== LC wizard

// Four steps, the way the design takes them: the credit, the amount and its
// terms, what it finances, then the stage it stands at with everything
// reviewed. Each step can be revisited from the review; the footer always
// says what is still missing.
function LcWizard({
  form,
  setForm,
  lcs,
  banks,
  suppliers,
  customers,
  facilities,
  orders,
  onClose,
  onSaved
}: {
  form: Row
  setForm: React.Dispatch<React.SetStateAction<Row | null>>
  lcs: Row[]
  banks: Row[]
  suppliers: Row[]
  customers: Row[]
  facilities: Row[]
  orders: Row[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [headroom, setHeadroom] = useState<Row | null>(null)
  const set = (patch: Row): void => setForm((p) => (p ? { ...p, ...patch } : p))
  const editing = !!form.id

  const stage = s(form.stage || 'application')
  const pastApp = stage !== 'application'
  const isPaid = stage === 'payment_received'
  const trading = s(form.purpose) === 'trading'

  useEffect(() => {
    if (!form.facility_id) return setHeadroom(null)
    let live = true
    void window.api.facility
      .headroom(Number(form.facility_id), form.id ? Number(form.id) : undefined)
      .catch(() => null)
      .then((h) => live && setHeadroom(h))
    return () => {
      live = false
    }
  }, [form.facility_id, form.id])

  const supplierInvoices = useMemo(
    () =>
      orders.filter(
        (o) =>
          Number(o.supplier_id) === Number(form.party_id) &&
          (trading ? !!Number(o.is_trading) : !Number(o.is_trading))
      ),
    [orders, form.party_id, trading]
  )
  const linked: number[] = Array.isArray(form.linked_order_ids) ? form.linked_order_ids.map(Number) : []
  const cover = round2(supplierInvoices.filter((o) => linked.includes(Number(o.id))).reduce((t, o) => t + n(o.net_amount), 0))

  const payDays = isPaid ? daysBetween(form.payment_received_date, form.expiry_date) : null
  const preview = { ...form, amount: n(form.amount), usance_days: isPaid ? (payDays ?? 0) : n(form.usance_days) }
  const interest = lcInterestOfDays(preview, preview.usance_days)
  const charges = round2(n(form.charges))
  const margin = round2((n(form.amount) * n(form.margin_pct)) / 100)
  const reached = form.interest_upfront ? round2(n(form.amount)) : round2(n(form.amount) - interest - charges)
  const room = headroom ? n(headroom.headroom ?? headroom.available) : null

  // What each stage makes obligatory — the same list the desktop refuses on.
  const missing = [
    !s(form.bank).trim() && 'Issuing bank',
    !s(form.fd_no).trim() && 'FD no',
    !s(form.open_date) && 'Application date',
    !form.party_id && 'Supplier',
    !(n(form.amount) > 0) && 'Open amount',
    pastApp && !s(form.lc_no).trim() && 'LC no',
    pastApp && !s(form.opened_date) && 'Opened date',
    isPaid && !s(form.payment_received_date) && 'Payment received date',
    isPaid && !s(form.expiry_date) && 'Maturity date',
    trading && !form.receivable_party_id && 'Receivable from'
  ].filter(Boolean) as string[]

  const STEPS = ['The credit', 'Amount & terms', 'Purpose', 'Stage & review']

  async function save(): Promise<void> {
    if (missing.length) {
      setErr(`Still needed: ${missing.join(', ')}`)
      return
    }
    const clash = lcNoClash(lcs, form.lc_no, form.id)
    if (clash) {
      setErr(`LC ${s(form.lc_no).trim()} already exists in this company — ${s(clash.bank) || 'another bank'}. Give this one a number of its own.`)
      return
    }
    if (linked.length && n(form.amount) > cover + 0.005) {
      setErr(`The open amount cannot exceed ${inrFull(cover)}, the total of the selected invoices`)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const payload = {
        ...form,
        facility_type: 'lc',
        party_type: 'supplier',
        party_id: form.party_id ? Number(form.party_id) : null,
        facility_id: form.facility_id ? Number(form.facility_id) : null,
        our_bank_id: form.our_bank_id ? Number(form.our_bank_id) : null,
        receivable_party_id: trading && form.receivable_party_id ? Number(form.receivable_party_id) : null,
        linked_order_ids: linked,
        status: form.status || 'open',
        ...(isPaid ? { usance_days: payDays ?? 0 } : {})
      }
      const res = editing ? await window.api.lc.update(Number(form.id), payload) : await window.api.lc.create(payload)
      const warn = (res as Row)?.warning
      if (warn) toast.warning(warn, { duration: 10000 })
      else toast.success(`LC ${s(form.lc_no) || ''} saved — margin, interest & charges posted to the books`.replace('  ', ' '))
      await onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const supplierOpts = suppliers
    .filter((p) => isTradingParty(p) === trading)
    .map((p) => ({ value: String(p.id), label: s(p.name) }))
  const customerOpts = customers.filter((p) => isTradingParty(p)).map((p) => ({ value: String(p.id), label: s(p.name) }))

  return (
    <Screen
      kicker={editing ? 'Edit letter of credit' : 'Open a letter of credit'}
      title={editing ? s(form.lc_no) || 'This LC' : 'New LC'}
      onClose={onClose}
      head={
        <div className="mt-[15px] flex items-center">
          {STEPS.map((label, i) => {
            const nStep = i + 1
            const done = nStep < step
            const on = nStep === step
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(nStep)}
                className="flex min-w-0 flex-1 items-center gap-2 pb-[11px] text-left"
                style={{ borderBottom: `3px solid ${on ? T.lime : done ? T.muted : 'rgba(255,255,255,.12)'}` }}
              >
                <span
                  className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                  style={{
                    fontFamily: MONO,
                    background: done ? T.muted : on ? T.lime : 'transparent',
                    color: done || on ? T.forest : T.muted,
                    border: `1.5px solid ${done ? T.muted : on ? T.lime : 'rgba(255,255,255,.3)'}`
                  }}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : nStep}
                </span>
                <span className="min-w-0 text-[11.5px] font-extrabold leading-[1.25]" style={{ color: on ? '#fff' : T.muted }}>
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      }
      footer={
        <>
          <Req missing={step === 4 ? missing : []} />
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={() => (step === 1 ? onClose() : setStep(step - 1))} icon={step > 1 ? <ArrowLeft className="h-[19px] w-[19px]" /> : undefined}>
              {step === 1 ? 'CANCEL' : 'BACK'}
            </Btn>
            {step < 4 ? (
              <Btn kind="go" onClick={() => setStep(step + 1)} icon={<ArrowRight className="h-[19px] w-[19px]" />}>
                NEXT
              </Btn>
            ) : (
              <Btn kind="lime" onClick={() => void save()} disabled={busy} icon={<Check className="h-[19px] w-[19px]" />}>
                {busy ? 'SAVING…' : editing ? 'SAVE LC' : 'OPEN LC'}
              </Btn>
            )}
          </div>
        </>
      }
    >
      {editing && pastApp && step === 1 && (
        <div
          className="flex flex-none items-start gap-[9px] rounded-[4px] border px-[13px] py-[11px]"
          style={{ background: T.warnBg, borderColor: T.warnRule, borderLeft: `4px solid ${T.warnMark}` }}
        >
          <History className="h-[18px] w-[18px] shrink-0" style={{ color: T.warnMark }} />
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold" style={{ color: T.warnInk }}>
              You are amending a live LC
            </div>
            <div className="mt-[3px] text-[11.5px] font-semibold leading-[1.5]" style={{ color: T.warnInk }}>
              It is at stage {STAGE_LABEL[stage]}. Saving re-posts its margin, interest and settlement to match.
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <>
          <Panel title="The credit">
            <div className="grid grid-cols-1 gap-[13px]">
              <Field label="Issuing bank" req>
                <TextIn value={s(form.bank)} onChange={(v) => set({ bank: v })} placeholder="KEB HANA BANK" />
              </Field>
              <Field label="Our bank account">
                <Pick
                  value={s(form.our_bank_id)}
                  onChange={(v) => set({ our_bank_id: v })}
                  placeholder="Pick our account"
                  options={banks.map((b) => ({ value: String(b.id), label: s(b.name || b.bank_name) }))}
                />
              </Field>
              <Field label="FD no" req>
                <TextIn value={s(form.fd_no)} onChange={(v) => set({ fd_no: v })} placeholder="FD/2026/0184" mono />
              </Field>
              <Field label="Application date" req>
                <DateIn value={s(form.open_date)} onChange={(v) => set({ open_date: v })} max={todayISO()} />
              </Field>
            </div>
          </Panel>
          <Panel title="Beneficiary">
            <Field label="Supplier" req>
              <Pick
                value={s(form.party_id)}
                onChange={(v) => set({ party_id: v, linked_order_ids: [] })}
                placeholder={trading ? 'Pick a trading supplier' : 'Pick the supplier'}
                options={supplierOpts}
              />
            </Field>
          </Panel>
          <Panel title="Sanctioned facility">
            <Pick
              value={s(form.facility_id)}
              onChange={(v) => set({ facility_id: v })}
              placeholder="Draw on a facility"
              options={facilities.map((f) => ({ value: String(f.id), label: s(f.name || f.facility_name || `Facility ${f.id}`), sub: s(f.bank_name) }))}
            />
            {room != null && (
              <>
                <div className="mt-3.5 flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-[12.5px] font-bold" style={{ color: T.inkMid }}>
                    Headroom on this facility
                  </span>
                  <Money size={16} fg={room >= n(form.amount) ? T.green : T.alert}>
                    {inrFull(room)}
                  </Money>
                </div>
                {n(form.amount) > room + 0.005 && (
                  <div className="mt-2 text-[11.5px] font-bold leading-[1.5]" style={{ color: T.alert }}>
                    This LC is {inrFull(round2(n(form.amount) - room))} more than the facility has room for.
                  </div>
                )}
              </>
            )}
          </Panel>
        </>
      )}

      {step === 2 && (
        <>
          <Panel title="Amount and terms">
            <div className="grid grid-cols-2 gap-[13px]">
              <Field
                label="Open amount (₹)"
                req
                full
                hint={margin > 0 ? `Margin of ${inrFull(margin)} is blocked in the FD.` : undefined}
              >
                <TextIn value={s(form.amount)} onChange={(v) => set({ amount: num(v) })} placeholder="45000000" mono big inputMode="decimal" />
              </Field>
              <Field label="Margin %">
                <TextIn value={s(form.margin_pct)} onChange={(v) => set({ margin_pct: num(v) })} placeholder="10" mono inputMode="decimal" />
              </Field>
              <Field label="Interest % p.a.">
                <TextIn value={s(form.interest_pct)} onChange={(v) => set({ interest_pct: num(v) })} placeholder="6.8" mono inputMode="decimal" />
              </Field>
              <Field label="Usance days">
                <TextIn value={s(form.usance_days)} onChange={(v) => set({ usance_days: num(v) })} placeholder="112" mono inputMode="numeric" />
              </Field>
              <Field label="Charges (₹)">
                <TextIn value={s(form.charges)} onChange={(v) => set({ charges: num(v) })} placeholder="0" mono inputMode="decimal" />
              </Field>
              <Field label="Interest adj. (₹)">
                <TextIn value={s(form.interest_adj)} onChange={(v) => set({ interest_adj: num(v) })} placeholder="-70.11" mono inputMode="decimal" />
              </Field>
              <Field label="Expiry date">
                <DateIn value={s(form.expiry_date)} onChange={(v) => set({ expiry_date: v })} />
              </Field>
              <div className="col-span-full flex flex-wrap items-center gap-[9px]">
                <span className="text-[11.5px] font-bold" style={{ color: T.inkSoft }}>
                  Usance
                </span>
                {[30, 60, 90, 112, 180].map((d) => {
                  const on = n(form.usance_days) === d
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => set({ usance_days: String(d) })}
                      className="flex h-8 items-center rounded-[3px] border px-[13px] text-[12px] font-bold"
                      style={{ fontFamily: MONO, borderColor: on ? T.forest : T.field, background: on ? T.forest : '#fff', color: on ? '#fff' : T.inkMid }}
                    >
                      {d}d
                    </button>
                  )
                })}
              </div>
            </div>
          </Panel>
          <Panel title="How the fees are settled" bodyClass="px-[15px] pb-[15px] pt-[3px]">
            <Toggle
              on={!!form.interest_excl_charges}
              onClick={() => set({ interest_excl_charges: !form.interest_excl_charges })}
              label="Interest leaves the charges out"
              note="Interest runs on the open amount less the bank's own charges."
            />
            <Toggle
              on={!!form.interest_upfront}
              onClick={() => set({ interest_upfront: !form.interest_upfront })}
              label="Interest taken upfront"
              note="The bank deducts the whole interest the day it pays the supplier."
            />
          </Panel>
        </>
      )}

      {step === 3 && (
        <>
          <Panel title="Purpose">
            <div className="grid gap-[13px]">
              <Field label="This LC finances">
                <Seg
                  value={(s(form.purpose) || 'manufacturing') as 'manufacturing' | 'trading'}
                  onChange={(v) => set({ purpose: v, party_id: '', receivable_party_id: '', linked_order_ids: [] })}
                  options={[
                    { k: 'manufacturing', label: 'Manufacturing' },
                    { k: 'trading', label: 'Trading' }
                  ]}
                />
              </Field>
              {trading && (
                <Field label="Receivable from" req hint="The customer the goods are resold to — the repayment comes from them.">
                  <Pick
                    value={s(form.receivable_party_id)}
                    onChange={(v) => set({ receivable_party_id: v })}
                    placeholder="The customer the repayment will come from"
                    options={customerOpts}
                  />
                </Field>
              )}
            </div>
          </Panel>
          <Panel
            title="Purchase invoices covered"
            right={
              <span className="text-[11px] font-bold" style={{ fontFamily: MONO, color: T.inkSoft }}>
                {linked.length} of {supplierInvoices.length}
              </span>
            }
            bodyClass="px-[15px] pb-[13px] pt-1.5"
          >
            {!form.party_id ? (
              <div className="py-3 text-[12px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
                Pick the supplier on step 1 and their invoices appear here.
              </div>
            ) : supplierInvoices.length === 0 ? (
              <div className="py-3 text-[12px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
                This supplier has no {trading ? 'trading' : 'purchase'} invoice on file to link.
              </div>
            ) : (
              supplierInvoices.map((o) => {
                const on = linked.includes(Number(o.id))
                return (
                  <button
                    key={String(o.id)}
                    type="button"
                    onClick={() =>
                      set({ linked_order_ids: on ? linked.filter((x) => x !== Number(o.id)) : [...linked, Number(o.id)] })
                    }
                    className="flex w-full items-center gap-[11px] border-b py-2.5 text-left"
                    style={{ borderColor: T.rule2 }}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px]"
                      style={{ border: `1.5px solid ${on ? T.forest : T.field}`, background: on ? T.lime : '#fff' }}
                    >
                      {on && <Check className="h-[15px] w-[15px]" style={{ color: T.forest }} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-bold" style={{ fontFamily: MONO, color: on ? T.ink : T.inkMid }}>
                        {s(o.invoice_no) || `Order ${o.id}`}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                        {fmtD(o.order_date)}
                      </span>
                    </span>
                    <span className="ml-auto shrink-0 text-[12.5px] font-bold" style={{ fontFamily: MONO }}>
                      {inrFull(n(o.net_amount))}
                    </span>
                  </button>
                )
              })
            )}
            {linked.length > 0 && (
              <>
                <div className="flex items-baseline justify-between gap-3 pb-0.5 pt-[11px]">
                  <Cap>Cover selected</Cap>
                  <Money size={15}>{inrFull(cover)}</Money>
                </div>
                <div
                  className="mt-[9px] flex items-start gap-2 rounded-[4px] border px-3 py-2.5"
                  style={{
                    background: n(form.amount) > cover + 0.005 ? T.alertBg : T.greenBg,
                    borderColor: n(form.amount) > cover + 0.005 ? T.alertRule : T.greenRule
                  }}
                >
                  {n(form.amount) > cover + 0.005 ? (
                    <AlertTriangle className="h-[17px] w-[17px] shrink-0" style={{ color: T.alert }} />
                  ) : (
                    <CheckCircle2 className="h-[17px] w-[17px] shrink-0" style={{ color: T.greenBright }} />
                  )}
                  <span className="text-[11.5px] font-bold leading-[1.5]" style={{ color: n(form.amount) > cover + 0.005 ? T.alertInk : T.green }}>
                    {n(form.amount) > cover + 0.005
                      ? `The open amount is ${inrFull(round2(n(form.amount) - cover))} more than these invoices cover.`
                      : 'The invoices cover the open amount.'}
                  </span>
                </div>
              </>
            )}
          </Panel>
        </>
      )}

      {step === 4 && (
        <>
          <Panel title="Stage">
            <Seg
              value={stage as 'application' | 'open' | 'payment_received'}
              onChange={(v) => set({ stage: v })}
              options={[
                { k: 'application', label: 'Application' },
                { k: 'open', label: 'Open' },
                { k: 'payment_received', label: 'Payment received' }
              ]}
            />
            <div className="mt-3.5 grid grid-cols-2 gap-[13px]">
              <Field label="LC no" req={pastApp} full>
                <TextIn
                  value={s(form.lc_no)}
                  onChange={(v) => set({ lc_no: v })}
                  placeholder={pastApp ? '027LC03261500005' : 'Not issued yet — optional'}
                  mono
                  bad={pastApp && !!err && !s(form.lc_no).trim()}
                />
              </Field>
              {pastApp && (
                <Field label="Opened date" req full>
                  <DateIn value={s(form.opened_date)} onChange={(v) => set({ opened_date: v })} max={todayISO()} />
                </Field>
              )}
              {isPaid && (
                <>
                  <Field label="Payment received" req>
                    <DateIn value={s(form.payment_received_date)} onChange={(v) => set({ payment_received_date: v })} max={todayISO()} />
                  </Field>
                  <Field label="Maturity date" req>
                    <DateIn value={s(form.expiry_date)} onChange={(v) => set({ expiry_date: v })} />
                  </Field>
                  <Field label="Interest days (computed)" full>
                    <div className="flex h-[44px] items-center gap-[9px] rounded-[4px] border px-[11px] text-[13.5px] font-bold" style={{ fontFamily: MONO, borderColor: T.headRule, background: T.head }}>
                      <Timer className="h-[18px] w-[18px]" style={{ color: T.inkFaint }} />
                      {payDays == null ? '—' : `${payDays} days`}
                    </div>
                  </Field>
                </>
              )}
              <Field label="Note" full>
                <TextIn value={s(form.note)} onChange={(v) => set({ note: v })} placeholder="Anything the desk should know" />
              </Field>
            </div>
            <div className="mt-[13px] flex items-start gap-2">
              <Info className="h-[17px] w-[17px] shrink-0" style={{ color: isPaid && !linked.length ? T.warnMark : T.inkSoft }} />
              <span className="text-[11.5px] font-bold leading-[1.5]" style={{ color: isPaid && !linked.length ? T.warnInk : T.inkSoft }}>
                {stage === 'application'
                  ? 'Saved as an application — the LC number and open date come when the bank opens it.'
                  : isPaid && !linked.length
                    ? 'Past Application an LC has to name the invoice(s) it covers — link them on step 3.'
                    : 'The bank has this credit; its figures post to the books on save.'}
              </span>
            </div>
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-2">
                <ArrowUpRight className="h-[17px] w-[17px]" /> What will reach the beneficiary
              </span>
            }
            tone="green"
            bodyClass="px-[15px] pb-3.5 pt-1.5"
          >
            <Lines
              rows={[
                { k: 'Open amount', v: inrFull(n(form.amount)) },
                { k: `Interest · ${formatNum(form.interest_pct)}% for ${preview.usance_days}d`, v: `− ${inrFull(interest)}`, fg: T.alertInk },
                { k: 'Charges', v: `− ${inrFull(charges)}`, fg: T.alertInk },
                { k: 'To the supplier', v: inrFull(reached), strong: true, big: true, fg: T.green },
                { k: `Margin blocked · ${formatNum(form.margin_pct)}%`, v: inrFull(margin), fg: T.inkSoft }
              ]}
            />
          </Panel>

          <Panel title="Everything you entered" bodyClass="px-[15px] pb-[13px] pt-1">
            {[
              { step: 1, label: 'The credit', v: `${s(form.bank) || '—'} · FD ${s(form.fd_no) || '—'} · applied ${fmtD(form.open_date)} · ${s(suppliers.find((p) => String(p.id) === s(form.party_id))?.name) || 'no supplier'}` },
              { step: 2, label: 'Amount & terms', v: `${inrFull(n(form.amount))} · margin ${formatNum(form.margin_pct)}% · ${formatNum(form.interest_pct)}% for ${formatNum(form.usance_days)}d · charges ${inrFull(charges)}` },
              { step: 3, label: 'Purpose', v: `${trading ? 'Trading' : 'Manufacturing'} · ${linked.length} invoice${linked.length === 1 ? '' : 's'} covered` }
            ].map((r) => (
              <div key={r.step} className="border-b py-2.5" style={{ borderColor: T.rule2 }}>
                <div className="flex items-center justify-between gap-2.5">
                  <Cap>{r.label}</Cap>
                  <button
                    type="button"
                    onClick={() => setStep(r.step)}
                    className="flex shrink-0 items-center gap-[5px] text-[11px] font-extrabold tracking-[.04em]"
                    style={{ color: T.green }}
                  >
                    <Pencil className="h-[15px] w-[15px]" /> EDIT
                  </button>
                </div>
                <div className="mt-1 text-[12.5px] font-bold leading-[1.5]">{r.v}</div>
              </div>
            ))}
          </Panel>
        </>
      )}

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// ============================================================ discount a bill

function BillForm({
  form,
  setForm,
  suppliers,
  customers,
  nbfcs,
  onClose,
  onSaved
}: {
  form: Row
  setForm: React.Dispatch<React.SetStateAction<Row | null>>
  suppliers: Row[]
  customers: Row[]
  nbfcs: Row[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (patch: Row): void => setForm((p) => (p ? { ...p, ...patch } : p))
  const editing = !!form.id
  const sid = s(form.finance_type) === 'SID'
  const trading = s(form.purpose) === 'trading'
  // The bank ledgers a disbursement can land in.
  const [bankLedgers, setBankLedgers] = useState<Row[]>([])
  useEffect(() => {
    let gone = false
    void window.api.journal
      .accountNames()
      .then((a) => !gone && setBankLedgers(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(s(x.acc_group)))))
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [])
  const route = s(form.disbursement_route) || (editing ? 'unconfirmed' : 'bank')

  // The open amount follows the invoice less the margin, until someone types
  // one of their own. An empty margin is a question nobody has answered yet,
  // not a nought — so nothing is filled until it has been.
  const marginAnswered = form.margin_pct != null && s(form.margin_pct).trim() !== ''
  // The invoice as adjusted by its Adj. figure, as the desktop form strikes it.
  const invEff = n(form.invoice_amount) > 0 ? Math.max(0, round2(n(form.invoice_amount) + n(form.invoice_adj))) : 0
  const target = marginAnswered && invEff > 0 ? round2(invEff * (1 - n(form.margin_pct) / 100)) : null
  useEffect(() => {
    if (target == null || form.amount_touched) return
    if (round2(n(form.amount)) !== target) set({ amount: String(target) })
  }, [target, form.amount_touched]) // eslint-disable-line react-hooks/exhaustive-deps

  const pool = (sid ? customers : suppliers).filter((p) => isTradingParty(p) === trading)
  const provides = (x: Row): string => s(x.provides || x.finance_types || x.finance_type).toUpperCase()
  const nbfcOpts = nbfcs
    .filter((x) => !provides(x) || provides(x).includes(sid ? 'SID' : 'PID') || provides(x).includes('BOTH'))
    .map((x) => ({
      value: String(x.id),
      label: s(x.name),
      sub: [n(x.interest_pct) ? `${formatNum(x.interest_pct)}%` : '', n(x.margin_pct) ? `M ${formatNum(x.margin_pct)}%` : ''].filter(Boolean).join(' · ')
    }))

  // What is drawn: the Open amount itself — interest runs on all of it. The
  // Adj. only moves what reaches the bank (bdCalc's open_adj_charge basis).
  const amount = round2(n(form.amount))
  const adjCharge = round2(n(form.open_adj))
  // With "count the first day" the receipt date earns interest too (bdCalc).
  const rawDays = daysBetween(form.payment_received_date, form.maturity_date)
  const days = rawDays != null ? rawDays + (form.days_incl_start ? 1 : 0) : null
  const yearDays = n(form.days_year) || 360
  // Interest runs on the Open amount — or on it after the Adj. when the NBFC
  // charges it that way (bdCalc's interestBase).
  const intBase = form.interest_after_adj ? Math.max(0, round2(amount + adjCharge)) : amount
  const interest = days != null && days > 0 ? round2((intBase * n(form.interest_pct) * days) / (100 * yearDays)) : 0
  const tds = round2((interest * n(form.tds_pct)) / 100)
  const upfront = !!form.interest_upfront
  // What lands in the bank, by the server's rule: the whole open amount when
  // the interest is paid upfront or serviced over the tenor, otherwise the
  // amount less the interest the NBFC keeps back. (This had it inverted.)
  const serviced = s(form.interest_mode) === 'serviced'
  const received = round2((upfront || serviced ? amount : amount - interest) + adjCharge)

  const missing = [
    !s(form.bd_no).trim() && 'BD no',
    !form.nbfc_id && 'NBFC',
    !form.party_id && 'Party',
    !s(form.maturity_date) && 'Maturity date',
    !(n(form.invoice_amount) > 0) && 'Invoice amount',
    trading && !form.receivable_party_id && 'Receivable from',
    route === 'bank' && !s(form.disbursement_account) && 'Bank the money landed in'
  ].filter(Boolean) as string[]

  async function save(): Promise<void> {
    if (missing.length) return setErr(`Still needed: ${missing.join(', ')}`)
    setBusy(true)
    setErr(null)
    try {
      // An edit on the same side keeps the bill's other parties and their
      // split; the party picked here stands first as the primary. A new bill,
      // or one switched between PID and SID, has only the party picked.
      const side = sid ? 'customer' : 'supplier'
      const keep = editing && s(form._orig_party_type) === side
      const primary = form.party_id ? Number(form.party_id) : 0
      const others: number[] = keep && Array.isArray(form.party_ids) ? form.party_ids.map(Number).slice(1) : []
      const partyIds = primary ? [primary, ...others.filter((x) => x && x !== primary)] : others
      const payload: Row = {
        bd_no: s(form.bd_no).trim(),
        nbfc_id: form.nbfc_id ? Number(form.nbfc_id) : null,
        finance_type: form.finance_type,
        party_type: side,
        party_id: primary || null,
        party_ids: partyIds,
        party_amounts: keep && form.party_amounts ? form.party_amounts : {},
        purpose: form.purpose,
        amount: round2(Number(form.amount) || 0),
        invoice_amount: s(form.invoice_amount).trim() === '' ? null : Number(form.invoice_amount),
        invoice_adj: Number(form.invoice_adj) || 0,
        open_adj: round2(Number(form.open_adj) || 0),
        open_adj_charge: 1,
        interest_after_adj: form.interest_after_adj ? 1 : 0,
        payment_received_date: form.payment_received_date || null,
        maturity_date: form.maturity_date || null,
        payment_in_expected: form.payment_in_expected ? 1 : 0,
        payment_in_days: s(form.payment_in_days).trim() === '' ? null : Number(form.payment_in_days),
        margin_pct: Number(form.margin_pct) || 0,
        interest_pct: Number(form.interest_pct) || 0,
        tds_pct: Number(form.tds_pct) || 0,
        days_year: Number(form.days_year) || 360,
        days_incl_start: !!form.days_incl_start,
        interest_upfront: !!form.interest_upfront,
        interest_mode: s(form.interest_mode || (form.interest_upfront ? 'upfront' : 'discounted')),
        interest_freq: s(form.interest_freq || 'monthly'),
        receivable_party_id: trading && form.receivable_party_id ? Number(form.receivable_party_id) : null,
        // As the desktop sends it: a trading bill keeps its links.
        linked_order_ids: trading && Array.isArray(form.linked_order_ids) ? form.linked_order_ids.map(Number) : [],
        note: form.note || null,
        disbursement_route: route,
        disbursement_account: route === 'bank' ? s(form.disbursement_account) || null : null
      }
      if (editing) await window.api.billDiscounting.update(Number(form.id), payload)
      else await window.api.billDiscounting.create(payload)
      toast.success(editing ? 'Bill Discounting updated' : 'Bill discounted')
      await onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      kicker={editing ? 'Edit bill discounting' : 'Bill discounting'}
      title={editing ? `BD ${s(form.bd_no)}` : 'Discount a bill'}
      onClose={onClose}
      footer={
        <>
          <Req missing={missing} />
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CANCEL</Btn>
            <Btn kind="lime" onClick={() => void save()} disabled={busy} icon={<Check className="h-[19px] w-[19px]" />}>
              {busy ? 'SAVING…' : editing ? 'SAVE BILL' : 'DISCOUNT'}
            </Btn>
          </div>
        </>
      }
    >
      <Panel title="The bill">
        <div className="grid grid-cols-1 gap-[13px]">
          <Field label="Provides" hint="PID discounts a supplier bill; SID discounts one you have raised on a customer.">
            <Seg
              value={(s(form.finance_type) || 'PID') as 'PID' | 'SID'}
              onChange={(v) => set({ finance_type: v, party_id: '', nbfc_id: '', disbursement_route: v === 'SID' ? 'bank' : 'supplier' })}
              options={[
                { k: 'PID', label: 'PID' },
                { k: 'SID', label: 'SID' }
              ]}
            />
          </Field>
          <Field label="BD no" req>
            <TextIn value={s(form.bd_no)} onChange={(v) => set({ bd_no: v })} placeholder="1" mono />
          </Field>
          <Field label="NBFC" req hint={nbfcOpts.length === 0 ? `No NBFC on file provides ${sid ? 'SID' : 'PID'} — add one in the masters.` : undefined} hintFg={T.warnInk}>
            <Pick
              value={s(form.nbfc_id)}
              onChange={(v) => {
                const x = nbfcs.find((y) => String(y.id) === v)
                // The NBFC's terms apply on a pick, as the desktop's chooseNbfc
                // does: its rates where it carries one, its day-count year and
                // first-day rule (copied onto the bill, never read live), and
                // its tenor as the maturity. Missing, a phone bill was priced on
                // a 360-day year whatever the NBFC's terms said.
                const next: Row = { nbfc_id: v }
                if (x) {
                  if (n(x.interest_pct) > 0) next.interest_pct = String(x.interest_pct)
                  if (n(x.margin_pct) > 0) next.margin_pct = String(x.margin_pct)
                  if (n(x.tds_pct) > 0) next.tds_pct = String(x.tds_pct)
                  if (n(x.days_year) > 0) next.days_year = x.days_year
                  next.days_incl_start = !!Number(x.days_incl_start)
                  if (n(x.interest_days) > 0) {
                    const base = s(form.payment_received_date || todayISO()).slice(0, 10)
                    const d = new Date(`${base}T00:00:00`)
                    d.setDate(d.getDate() + n(x.interest_days))
                    next.maturity_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                  }
                }
                set(next)
              }}
              placeholder="Pick the NBFC"
              options={nbfcOpts}
            />
          </Field>
          <Field
            label="Disbursement paid to"
            req
            hint={
              route === 'supplier'
                ? 'Posts as a journal that settles the supplier — no bank entry.'
                : route === 'unconfirmed'
                  ? 'Not confirmed yet — keeps posting into the bank on its voucher until you pick one.'
                  : 'Posts as a receipt into the bank you pick.'
            }
            hintFg={route === 'unconfirmed' ? T.warnInk : undefined}
          >
            <Seg
              value={(route === 'supplier' ? 'supplier' : route === 'bank' ? 'bank' : '') as 'bank' | 'supplier'}
              onChange={(v) => set({ disbursement_route: v, ...(v !== 'bank' ? { disbursement_account: '' } : {}) })}
              options={[
                { k: 'bank', label: 'Our bank' },
                ...(sid ? [] : [{ k: 'supplier' as const, label: 'Supplier direct' }])
              ]}
            />
          </Field>
          {route === 'bank' && (
            <Field label="Bank the money landed in" req>
              <Pick
                value={s(form.disbursement_account)}
                onChange={(v) => set({ disbursement_account: v })}
                placeholder="Pick the bank"
                options={bankLedgers.map((a) => ({ value: s(a.name), label: s(a.name) }))}
              />
            </Field>
          )}
          <Field label="Purpose">
            <Seg
              value={(s(form.purpose) || 'manufacturing') as 'manufacturing' | 'trading'}
              onChange={(v) => set({ purpose: v, party_id: '', receivable_party_id: '' })}
              options={[
                { k: 'manufacturing', label: 'Manufacturing' },
                { k: 'trading', label: 'Trading' }
              ]}
            />
          </Field>
          <Field label={sid ? 'Customer' : 'Supplier'} req>
            <Pick
              value={s(form.party_id)}
              onChange={(v) => set({ party_id: v })}
              placeholder={`Pick the ${sid ? 'customer' : 'supplier'}`}
              options={pool.map((p) => ({ value: String(p.id), label: s(p.name) }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-[13px]">
            <Field label="Receipt date" hint="Blank until the money lands.">
              <DateIn value={s(form.payment_received_date)} onChange={(v) => set({ payment_received_date: v })} max={todayISO()} />
            </Field>
            <Field label="Maturity date" req>
              <DateIn value={s(form.maturity_date)} onChange={(v) => set({ maturity_date: v })} />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel title="Amount and terms">
        <div className="grid grid-cols-2 gap-[13px]">
          <Field
            label="Invoice amount (₹)"
            req
            full
            hint={n(form.invoice_adj) ? `Includes an older invoice adjustment — counted as ${inrFull(invEff)}.` : undefined}
          >
            <TextIn value={s(form.invoice_amount)} onChange={(v) => set({ invoice_amount: num(v) })} placeholder="4000000" mono big inputMode="decimal" />
          </Field>
          <Field label="Margin %">
            <TextIn value={s(form.margin_pct)} onChange={(v) => set({ margin_pct: num(v) })} placeholder="10" mono inputMode="decimal" />
          </Field>
          <Field label="Open amount (₹)" hint={form.amount_touched ? 'Your own figure.' : 'Invoice less margin.'}>
            <TextIn value={s(form.amount)} onChange={(v) => set({ amount: num(v), amount_touched: true })} placeholder="auto" mono inputMode="decimal" />
          </Field>
          <Field
            label="Adj. on the open amount (₹ +/−)"
            full
            hint={
              n(form.open_adj)
                ? `${n(form.open_adj) < 0 ? `Charged to ${adjPostsTo(form.open_adj_ledger, form.open_adj_split, n(form.open_adj))}` : 'Added to the payout'} — ${form.interest_after_adj ? `interest runs on ${inrFull(intBase)}, after it` : `drawn and interest stay on ${inrFull(amount)}`}; ${inrFull(received)} reaches the bank.`
                : 'What the NBFC takes off (−) or adds to (+) its payout. Drawn and interest stay on the Open amount.'
            }
          >
            <TextIn
              value={s(form.open_adj)}
              onChange={(v) => set({ open_adj: v.replace(/[^\d.-]/g, '').replace(/(?!^)-/g, '') })}
              placeholder="0"
              mono
              inputMode="text"
            />
          </Field>
          <Field label="Interest % p.a.">
            <TextIn value={s(form.interest_pct)} onChange={(v) => set({ interest_pct: num(v) })} placeholder="13.6" mono inputMode="decimal" />
          </Field>
          <Field label="TDS % on interest">
            <TextIn value={s(form.tds_pct)} onChange={(v) => set({ tds_pct: num(v) })} placeholder="10" mono inputMode="decimal" />
          </Field>
          <Field label="Days in year" full hint="Bill discounting conventionally uses 360, not the calendar 365.">
            <TextIn value={s(form.days_year)} onChange={(v) => set({ days_year: num(v) })} mono inputMode="numeric" />
          </Field>
        </div>
        {form.amount_touched && target != null && round2(n(form.amount)) !== target && (
          <button
            type="button"
            onClick={() => set({ amount: String(target), amount_touched: false })}
            className="mt-3 h-[34px] rounded-[4px] border bg-white px-[13px] text-[11.5px] font-bold"
            style={{ borderColor: T.field, color: T.inkMid }}
          >
            Draw it all · {inrFull(target)}
          </button>
        )}
      </Panel>

      <Panel bodyClass="px-[15px] pb-[15px] pt-[3px]">
        <Toggle
          on={upfront}
          onClick={() => set({ interest_upfront: !upfront, interest_mode: !upfront ? 'upfront' : 'discounted' })}
          label="Interest taken upfront"
          note="The interest is settled separately, so the whole open amount lands in your bank. Off, the NBFC keeps it back from the payout."
        />
        <Toggle
          on={!!form.interest_after_adj}
          onClick={() => set({ interest_after_adj: !form.interest_after_adj })}
          label="Interest charged after adjusted amount"
          note={
            !n(form.open_adj)
              ? 'No Adj. entered — makes no difference until there is one.'
              : form.interest_after_adj
                ? `Interest on ${inrFull(intBase)} — the Open amount after the Adj.`
                : `Off — interest stays on the full ${inrFull(amount)} Open amount.`
          }
        />
        <Toggle
          on={!!form.days_incl_start}
          onClick={() => set({ days_incl_start: !form.days_incl_start })}
          label="Count the first day"
          note="Interest runs from the day the money lands, inclusive."
        />
        <Toggle
          on={!!form.payment_in_expected}
          onClick={() => set({ payment_in_expected: !form.payment_in_expected })}
          label="A payment back is expected"
          note="The party pays us for the goods; the register tracks when."
        />
      </Panel>

      {trading && (
        <Panel title="Trading round trip" tone="green">
          <Field label="Payment received back from" req hint="The customer the goods are resold to. Payment IN posts against their ledger.">
            <Pick
              value={s(form.receivable_party_id)}
              onChange={(v) => set({ receivable_party_id: v })}
              placeholder="Select the customer"
              options={customers.filter((p) => isTradingParty(p)).map((p) => ({ value: String(p.id), label: s(p.name) }))}
            />
          </Field>
        </Panel>
      )}

      {!s(form.payment_received_date) ? (
        <div
          className="flex flex-none items-start gap-2.5 rounded-[4px] border px-3.5 py-3"
          style={{ background: T.warnBg, borderColor: T.warnRule }}
        >
          <Clock className="h-[18px] w-[18px] shrink-0" style={{ color: T.warnMark }} />
          <span className="text-[11.5px] font-semibold leading-[1.55]" style={{ color: T.warnInk }}>
            Interest, TDS and payout are worked out on <b>Mark payment received</b> — interest runs from the day the money lands, and that date is not known yet.
          </span>
        </div>
      ) : (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <ArrowUpRight className="h-[17px] w-[17px]" /> What you will receive
            </span>
          }
          tone="green"
          bodyClass="px-[15px] pb-3.5 pt-1.5"
        >
          <Lines
            rows={[
              { k: n(form.invoice_adj) ? 'Invoice (adj.)' : 'Invoice', v: inrFull(invEff), sub: n(form.invoice_adj) ? `${inrFull(n(form.invoice_amount))} ${n(form.invoice_adj) > 0 ? '+' : '−'} ${inrFull(Math.abs(n(form.invoice_adj)))}` : undefined },
              { k: `Margin · ${formatNum(form.margin_pct)}%`, v: `− ${inrFull(round2(invEff - amount))}`, fg: T.alertInk },
              { k: 'Drawn from the NBFC', v: inrFull(amount), strong: true },
              // Kept back by the NBFC only when it is neither settled upfront
              // nor serviced over the tenor — the same rule as `received`.
              {
                k: `Interest · ${formatNum(form.interest_pct)}% for ${days ?? 0}d / ${yearDays}`,
                v: `${upfront || serviced ? '' : '− '}${inrFull(interest)}`,
                fg: T.alertInk,
                sub:
                  `${upfront ? 'settled upfront, not taken out of the payout' : serviced ? 'paid as it runs' : 'taken out of the payout'}` +
                  (form.interest_after_adj && n(form.open_adj) ? ` · on ${inrFull(intBase)}, after the Adj.` : '')
              },
              { k: `TDS · ${formatNum(form.tds_pct)}%`, v: `+ ${inrFull(tds)}`, fg: T.green },
              ...(adjCharge
                ? [
                    {
                      k: adjCharge < 0 ? `Adj. — ${adjKindsLabel(form.open_adj_ledger, form.open_adj_split)}` : 'Adj. — added to the payout',
                      v: `${adjCharge > 0 ? '+' : '−'} ${inrFull(Math.abs(adjCharge))}`,
                      fg: adjCharge < 0 ? T.alertInk : T.green
                    }
                  ]
                : []),
              { k: 'Into your bank', v: inrFull(received), strong: true, big: true, fg: T.green }
            ]}
          />
        </Panel>
      )}

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// =================================================================== delete

function ConfirmDelete({
  target,
  onCancel,
  onDone
}: {
  target: { kind: 'lc' | 'bd'; row: Row }
  onCancel: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const isLc = target.kind === 'lc'
  const label = isLc ? `LC ${s(target.row.lc_no) || '(no number)'}` : `BD ${s(target.row.bd_no)}`
  async function go(): Promise<void> {
    setBusy(true)
    try {
      if (isLc) await window.api.lc.remove(Number(target.row.id))
      else await window.api.billDiscounting.remove(Number(target.row.id))
      toast.success(`${label} deleted`)
      await onDone()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[70] flex items-end justify-center">
      <button type="button" aria-label="Keep it" onClick={onCancel} className="absolute inset-0" style={{ background: 'rgba(10,31,23,.5)' }} />
      <div className="relative w-full rounded-t-[10px] bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: T.alertBg }}>
            <Trash2 className="h-5 w-5" style={{ color: T.alert }} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold">Delete {label}?</div>
            <div className="mt-1 text-[12.5px] font-semibold leading-[1.55]" style={{ color: T.inkSoft }}>
              Every voucher it posted is reversed with it. The server refuses if something still depends on it — it will say what.
            </div>
          </div>
        </div>
        <div className="mt-5 flex gap-2.5">
          <Btn grow onClick={onCancel}>
            KEEP IT
          </Btn>
          <Btn grow kind="danger" onClick={() => void go()} disabled={busy} icon={<Trash2 className="h-[18px] w-[18px]" />}>
            {busy ? 'DELETING…' : 'DELETE'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ================================================================ pay party

// The bank paying the supplier in parts — the phone's copy of the desktop's
// Parts screen. An LC the bank pays the supplier in parts: every part so far —
// its LC amount, its own maturity and interest, and whether the bank has been
// repaid for it — and the next part (date, LC amount, maturity, note). Only
// the latest part can be taken back, and never part 1, which is the Payment
// received itself. The bank is repaid here too, part by part — tick the parts a
// repayment clears; one repaid before its maturity gets the unexpired interest
// back, and the repayment that clears the last part closes the LC.
function PayPartyScreen({
  l,
  onClose,
  onChanged
}: {
  l: Row
  onClose: () => void
  onChanged: () => void | Promise<void>
}): React.JSX.Element {
  const [parts, setParts] = useState<Row[]>([])
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [maturity, setMaturity] = useState(s(l.expiry_date).slice(0, 10))
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [undoAsk, setUndoAsk] = useState(false)
  // Repaying the bank.
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [rep, setRep] = useState<{ date: string; comm: string; bank: string; chg: ChargeRow[]; route: 'credit_to_us' | 'pay_to_party'; margin: boolean }>({
    chg: [],
    date: todayISO(),
    comm: '',
    bank: '',
    route: 'credit_to_us',
    margin: true
  })
  const [undoRepAsk, setUndoRepAsk] = useState(false)

  const lcAmount = round2(n(l.amount))
  const drawn = round2(parts.reduce((t, p) => t + n(p.amount), 0))
  const left = round2(Math.max(0, lcAmount - drawn))
  const owed = round2(parts.filter((p) => !p.repaid_date).reduce((t, p) => t + n(p.amount), 0))
  const last = parts.length ? s(parts[parts.length - 1].pay_date).slice(0, 10) : s(l.payment_received_date).slice(0, 10)
  // The repayment that clears the last part closes the LC, and taking it back
  // reopens it — read that off the parts, not the row this screen opened with.
  const closed = parts.length ? parts.every((p) => !!p.repaid_date) : !!l.preclosed_date

  const reload = useCallback(async () => {
    const rows = ((await window.api.lc.parts(Number(l.id)).catch(() => [] as Row[])) as Row[]) || []
    setParts(rows)
    const used = round2(rows.reduce((t, p) => t + n(p.amount), 0))
    const rest = round2(Math.max(0, n(l.amount) - used))
    setAmount(rest > 0 ? String(rest) : '')
    // The parts already due are the ones a repayment usually clears.
    const open = rows.filter((p) => !p.repaid_date)
    const due = open.filter((p) => s(p.maturity_date).slice(0, 10) <= todayISO())
    setPick(new Set((due.length ? due : open.slice(0, 1)).map((p) => n(p.part_no))))
  }, [l.id, l.amount])
  useEffect(() => {
    void reload()
  }, [reload])

  const amt = round2(n(amount))
  const over = amt > left + 0.005
  const pv = lcPartPreview(l, amt, date, maturity, parts.length === 0)
  // What a repayment of the ticked parts comes to.
  const picked = parts.filter((p) => pick.has(n(p.part_no)) && !p.repaid_date)
  const principal = round2(picked.reduce((t, p) => t + n(p.amount), 0))
  const rebateOf = (p: Row): number => {
    const a = Date.parse(`${rep.date}T00:00:00`)
    const b = Date.parse(`${s(p.maturity_date).slice(0, 10)}T00:00:00`)
    const daysLeft = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400000)) : 0
    return n(p.days) > 0 && daysLeft > 0 ? round2((n(p.interest) * daysLeft) / n(p.days)) : 0
  }
  const rebate = round2(picked.reduce((t, p) => t + rebateOf(p), 0))
  const charges = chargeRowsTotal(rep.chg)
  const debit = round2(principal - rebate + charges)
  const closesLc = picked.length > 0 && parts.every((p) => p.repaid_date || pick.has(n(p.part_no)))
  const lastRepaidId = parts.reduce((m, p) => Math.max(m, n(p.repayment_id)), 0)

  async function repay(): Promise<void> {
    if (!picked.length) return setErr('Tick the parts this repayment clears')
    if (!rep.date) return setErr('Pick the repayment date')
    if (rep.date > todayISO()) return setErr('The repayment date cannot be in the future')
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.lc.repayParts(Number(l.id), {
        date: rep.date,
        parts: picked.map((p) => n(p.part_no)),
        comm_charges: 0,
        bank_charges: 0,
        charges: chargeRowsPayload(rep.chg),
        rebate_route: rep.route,
        release_margin: rep.margin
      })
      toast.success(
        `${inrFull(principal)} repaid to the bank${r.rebate > 0.005 ? ` · ${inrFull(r.rebate)} rebate` : ''}${r.closed ? ' — LC closed' : ''}`
      )
      setRep((x) => ({ ...x, comm: '', bank: '', chg: [] }))
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function undoRepayment(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.lc.undoPartRepayment(Number(l.id))
      toast.success(`Repayment of part${r.parts.length === 1 ? '' : 's'} ${r.parts.join(', ')} taken back`)
      setUndoRepAsk(false)
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const missing = [!date && 'Date paid', !(amt > 0) && 'LC amount', !maturity && 'Maturity'].filter(Boolean) as string[]

  async function save(): Promise<void> {
    if (missing.length) return setErr(`Still needed: ${missing.join(', ')}`)
    if (over) return setErr(`Only ${inrFull(left)} of this LC is still undrawn`)
    if (date > todayISO()) return setErr('The payment date cannot be in the future')
    if (last && date < last) return setErr(`The last part was paid on ${fmtD(last)} — this one cannot be dated before it`)
    if (maturity < date) return setErr('A part cannot mature before it was paid')
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.lc.payParty(Number(l.id), { date, amount: amt, maturity, note: memo })
      toast.success(`Part ${r.installment_no}: ${inrFull(pv.net)} to the supplier, maturing ${fmtD(maturity)}`)
      setMemo('')
      setDate(todayISO())
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function undoLast(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.lc.removeInstallment(Number(l.id))
      toast.success(`Part ${r.installment_no} taken back — its voucher is removed`)
      setUndoAsk(false)
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const lastPart = parts[parts.length - 1]
  return (
    <Screen
      kicker="Paid and repaid in parts"
      title={`Parts · ${s(l.lc_no) || 'this LC'}`}
      sub={`${s(l.bank) || 'Bank'} → ${s(l.supplier_name) || 'the supplier'}`}
      onClose={onClose}
      footer={
        <>
          {left > 0.005 && !closed ? <Req missing={missing} /> : <div className="flex-1" />}
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CLOSE</Btn>
            {left > 0.005 && !closed && (
              <Btn kind="go" onClick={() => void save()} disabled={busy || over} icon={<Check className="h-[19px] w-[19px]" />}>
                {busy ? 'SAVING…' : `PAY PART ${parts.length + 1}`}
              </Btn>
            )}
          </div>
        </>
      }
    >
      <Panel tone="green">
        <Lines
          rows={[
            { k: 'LC amount', v: inrFull(lcAmount) },
            { k: `Drawn · ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`, v: inrFull(drawn), fg: T.green },
            { k: closed ? 'Never drawn' : 'Still undrawn', v: inrFull(left), fg: left > 0.005 && !closed ? T.warnInk : T.inkFaint },
            { k: 'Owed to the bank', v: inrFull(owed), strong: true, big: true, fg: owed > 0.005 ? T.alert : T.inkFaint }
          ]}
        />
      </Panel>

      <Panel title="The parts">
        {parts.length === 0 ? (
          <div className="text-[12.5px] font-semibold" style={{ color: T.inkSoft }}>
            No part paid yet.
          </div>
        ) : (
          <div className="grid gap-2">
            {parts.map((p) => {
              const due = daysTo(p.maturity_date)
              return (
                <div key={String(p.part_no)} className="rounded-[4px] border px-3 py-2.5" style={{ borderColor: T.rule2 }}>
                  <div className="flex items-center gap-3">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-extrabold"
                      style={{ background: T.greenBg, color: T.green }}
                    >
                      {String(p.part_no)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-extrabold" style={{ color: T.ink }}>
                        {inrFull(n(p.amount))}
                      </div>
                      <div className="mt-0.5 text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                        Paid {fmtD(s(p.pay_date))} · matures {fmtD(s(p.maturity_date))} ({n(p.days)}d)
                      </div>
                    </div>
                    {p.repaid_date ? (
                      <span className="shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10.5px] font-extrabold" style={{ background: T.okBg, color: T.green }}>
                        REPAID {fmtD(s(p.repaid_date))}
                      </span>
                    ) : (
                      <span
                        className="shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10.5px] font-extrabold"
                        style={due != null && due < 0 ? { background: T.alertBg, color: T.alert } : { background: T.chip, color: T.inkMid }}
                      >
                        {due == null ? '—' : due < 0 ? `${Math.abs(due)}D OVERDUE` : `${due}D LEFT`}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                    <span>Interest {inrFull(n(p.interest))}{n(p.charges) > 0.005 ? ` + ${inrFull(n(p.charges))} charges` : ''}</span>
                    <span style={{ color: T.green }}>Supplier got {inrFull(n(p.net))}</span>
                  </div>
                </div>
              )
            })}
            {!closed && lastPart && n(lastPart.part_no) > 1 && !lastPart.repaid_date && !undoAsk && (
              <button
                type="button"
                onClick={() => setUndoAsk(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[4px] border bg-white text-[12px] font-extrabold"
                style={{ borderColor: T.alertRule, color: T.alertInk }}
              >
                <History className="h-4 w-4" /> Take back part {String(lastPart.part_no)}
              </button>
            )}
            {undoAsk && lastPart && (
              <div className="grid gap-2 rounded-[4px] border px-3 py-2.5" style={{ background: T.alertBg, borderColor: T.alertRule }}>
                <span className="text-[12px] font-bold" style={{ color: T.alertInk }}>
                  Take back part {String(lastPart.part_no)} ({inrFull(n(lastPart.amount))})? Its voucher is deleted.
                </span>
                <div className="flex gap-2">
                  <Btn onClick={() => setUndoAsk(false)}>KEEP IT</Btn>
                  <Btn kind="danger" onClick={() => void undoLast()} disabled={busy}>
                    TAKE BACK
                  </Btn>
                </div>
              </div>
            )}
            {lastRepaidId > 0 && !undoRepAsk && (
              <button
                type="button"
                onClick={() => setUndoRepAsk(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[4px] border bg-white text-[12px] font-extrabold"
                style={{ borderColor: T.alertRule, color: T.alertInk }}
              >
                <History className="h-4 w-4" /> Take back the last repayment
              </button>
            )}
            {undoRepAsk && (
              <div className="grid gap-2 rounded-[4px] border px-3 py-2.5" style={{ background: T.alertBg, borderColor: T.alertRule }}>
                <span className="text-[12px] font-bold" style={{ color: T.alertInk }}>
                  Take back the last repayment? Its bank voucher and any rebate are deleted{closed ? ', and the LC reopens' : ''}.
                </span>
                <div className="flex gap-2">
                  <Btn onClick={() => setUndoRepAsk(false)}>KEEP IT</Btn>
                  <Btn kind="danger" onClick={() => void undoRepayment()} disabled={busy}>
                    TAKE BACK
                  </Btn>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* REPAY THE BANK — part by part. */}
      {owed > 0.005 && !closed && (
        <Panel title="Repay the bank" tone="blue">
          <div className="grid gap-[13px]">
            <div className="grid gap-1.5">
              {parts
                .filter((p) => !p.repaid_date)
                .map((p) => {
                  const no = n(p.part_no)
                  const on = pick.has(no)
                  const due = daysTo(p.maturity_date)
                  return (
                    <button
                      key={no}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setPick((sel) => {
                          const nx = new Set(sel)
                          if (nx.has(no)) nx.delete(no)
                          else nx.add(no)
                          return nx
                        })
                      }
                      className="flex min-h-[48px] items-center gap-3 rounded-[4px] border px-3 text-left"
                      style={on ? { background: T.okBg, borderColor: T.greenRule } : { background: '#fff', borderColor: T.rule2 }}
                    >
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border text-[12px] font-extrabold"
                        style={on ? { background: T.forest, borderColor: T.forest, color: '#fff' } : { borderColor: T.field, color: 'transparent' }}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-extrabold" style={{ color: T.ink }}>
                          Part {no} · {inrFull(n(p.amount))}
                        </span>
                        <span className="block text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                          Matures {fmtD(s(p.maturity_date))}
                          {due != null ? ` · ${due < 0 ? `${Math.abs(due)}d overdue` : `${due}d left`}` : ''}
                        </span>
                      </span>
                    </button>
                  )
                })}
            </div>
            <Field label="Repaid on" req>
              <DateIn value={rep.date} onChange={(v) => setRep((x) => ({ ...x, date: v }))} max={todayISO()} />
            </Field>
            <Field label="Charges in this debit — one row per ledger">
              <ChargeRows value={rep.chg} onChange={(next) => setRep((x) => ({ ...x, chg: next }))} />
            </Field>
            {rebate > 0.005 && (
              <Field label={`Interest rebate ${inrFull(rebate)} — repaid before maturity`}>
                <Seg
                  wide
                  value={rep.route}
                  onChange={(k) => setRep((x) => ({ ...x, route: k }))}
                  options={[
                    { k: 'credit_to_us', label: 'Keep it' },
                    { k: 'pay_to_party', label: 'Pass to supplier' }
                  ]}
                />
              </Field>
            )}
            {closesLc && (
              <button
                type="button"
                onClick={() => setRep((x) => ({ ...x, margin: !x.margin }))}
                className="flex min-h-[44px] items-center gap-2.5 rounded-[4px] border px-3 text-left text-[12px] font-bold"
                style={{ borderColor: T.rule2, color: T.ink }}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border"
                  style={rep.margin ? { background: T.forest, borderColor: T.forest, color: '#fff' } : { borderColor: T.field, color: 'transparent' }}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                <span>
                  Also release the margin
                  <span className="block text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                    This clears the last part, so the LC closes{left > 0.005 ? ` — the ${inrFull(left)} never drawn is not owed` : ''}.
                  </span>
                </span>
              </button>
            )}
            {picked.length > 0 && (
              <Lines
                rows={[
                  { k: 'Principal', v: inrFull(principal) },
                  ...(rebate > 0.005 ? [{ k: 'Less rebate', v: `− ${inrFull(rebate)}`, fg: T.green }] : []),
                  ...(charges > 0.005 ? [{ k: 'Plus charges', v: inrFull(charges) }] : []),
                  { k: 'Bank debit', v: inrFull(debit), strong: true, big: true }
                ]}
              />
            )}
            <Btn kind="navy" onClick={() => void repay()} disabled={busy || !picked.length} grow>
              {busy ? 'SAVING…' : `REPAY ${picked.length} PART${picked.length === 1 ? '' : 'S'}`}
            </Btn>
          </div>
        </Panel>
      )}

      {left > 0.005 && !closed && (
        <Panel title={`Part ${parts.length + 1}`}>
          <div className="grid gap-[13px]">
            <Field label="Date paid" req hint={last ? `On or after ${fmtD(last)}, up to today.` : 'Up to today.'}>
              <DateIn value={date} onChange={setDate} max={todayISO()} min={last || undefined} />
            </Field>
            <Field
              label="Part's LC amount (₹)"
              req
              hint={
                over
                  ? `More than the ${inrFull(left)} still undrawn.`
                  : `Interest ${inrFull(pv.interest)} (${pv.days}d) · supplier receives ${inrFull(amt > 0 ? pv.net : 0)}`
              }
              hintFg={over ? T.alert : T.inkSoft}
            >
              <TextIn value={amount} onChange={(v) => setAmount(num(v))} mono big bad={over} inputMode="decimal" />
            </Field>
            <Field label="Matures on" req>
              <DateIn value={maturity} onChange={setMaturity} min={date || undefined} />
            </Field>
            <Field label="Note">
              <TextIn value={memo} onChange={setMemo} placeholder="Bank advice no., remarks" />
            </Field>
          </div>
        </Panel>
      )}

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}

// The same parts screen for a discounted bill the NBFC pays the supplier in parts.
function BdPayPartyScreen({
  l,
  onClose,
  onChanged
}: {
  l: Row
  onClose: () => void
  onChanged: () => void | Promise<void>
}): React.JSX.Element {
  const [bills, setBills] = useState<Row[]>([])
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [undoAsk, setUndoAsk] = useState(false)

  const net = round2(n(l.receiptAmount))
  const paid = round2(bills.reduce((t, b) => t + n(b.amount), 0))
  const left = round2(Math.max(0, net - paid))
  const parts = useMemo(() => {
    const m = new Map<number, { no: number; date: string; amount: number; refs: string[]; note: string }>()
    for (const b of bills) {
      const no = n(b.part_no) || 1
      const g = m.get(no) || { no, date: s(b.pay_date), amount: 0, refs: [], note: '' }
      g.amount = round2(g.amount + n(b.amount))
      const ref = s(b.invoice_no || b.bill_no).trim()
      if (ref && !g.refs.includes(ref)) g.refs.push(ref)
      if (b.note && !g.note) g.note = s(b.note)
      m.set(no, g)
    }
    return [...m.values()].sort((a, b) => a.no - b.no)
  }, [bills])
  const last = parts.length ? parts[parts.length - 1].date.slice(0, 10) : s(l.payment_received_date).slice(0, 10)
  const closed = s(l.status) === 'repaid'

  const reload = useCallback(async () => {
    const rows = (await window.api.billDiscounting.partyPayments(Number(l.id)).catch(() => [] as Row[])) as Row[]
    setBills(rows)
    const got = round2(rows.reduce((t, b) => t + n(b.amount), 0))
    const rest = round2(Math.max(0, round2(n(l.receiptAmount)) - got))
    setAmount(rest > 0 ? String(rest) : '')
  }, [l.id, l.receiptAmount])
  useEffect(() => {
    void reload()
  }, [reload])

  const amt = round2(n(amount))
  const over = amt > left + 0.005
  const missing = [!date && 'Date paid', !(amt > 0) && 'Amount'].filter(Boolean) as string[]

  async function save(): Promise<void> {
    if (missing.length) return setErr(`Still needed: ${missing.join(', ')}`)
    if (over) return setErr(`Only ${inrFull(left)} is still to be paid on this bill`)
    if (date > todayISO()) return setErr('The payment date cannot be in the future')
    if (last && date < last) return setErr(`The last part was paid on ${fmtD(last)} — this one cannot be dated before it`)
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.billDiscounting.payParty(Number(l.id), { date, amount: amt, note: memo })
      toast.success(`Part ${r.part_no} of ${inrFull(amt)} posted to the supplier`)
      setMemo('')
      setDate(todayISO())
      await onChanged()
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function undoLast(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.api.billDiscounting.removePartyPayment(Number(l.id))
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

  const pct = net > 0 ? Math.min(100, (paid / net) * 100) : 0
  const lastPart = parts[parts.length - 1]
  return (
    <Screen
      kicker="Payment to party"
      title={`Parts · BD ${s(l.bd_no) || ''}`}
      sub={`${s(l.nbfc_name) || 'NBFC'} → ${s(l.party_name) || 'the supplier'}`}
      onClose={onClose}
      footer={
        <>
          {left > 0.005 && !closed ? <Req missing={missing} /> : <div className="flex-1" />}
          <div className="ml-auto flex gap-2.5">
            <Btn onClick={onClose}>CLOSE</Btn>
            {left > 0.005 && !closed && (
              <Btn kind="go" onClick={() => void save()} disabled={busy || over} icon={<Check className="h-[19px] w-[19px]" />}>
                {busy ? 'SAVING…' : 'POST'}
              </Btn>
            )}
          </div>
        </>
      }
    >
      <Panel tone="green">
        <Lines
          rows={[
            { k: 'Due to the supplier', v: inrFull(net) },
            { k: `Paid · ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`, v: inrFull(paid), fg: T.green },
            { k: 'Still to pay', v: inrFull(left), strong: true, big: true, fg: left > 0.005 ? T.warnInk : T.inkFaint }
          ]}
        />
        <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: T.rule }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: T.greenBright }} />
        </div>
      </Panel>

      <Panel title="Paid so far">
        {parts.length === 0 ? (
          <div className="text-[12.5px] font-semibold" style={{ color: T.inkSoft }}>
            Nothing paid yet.
          </div>
        ) : (
          <div className="grid gap-2">
            {parts.map((p) => (
              <div key={p.no} className="flex items-center gap-3 rounded-[4px] border px-3 py-2.5" style={{ borderColor: T.rule2 }}>
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-extrabold"
                  style={{ background: T.greenBg, color: T.green }}
                >
                  {p.no}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-extrabold" style={{ color: T.ink }}>
                    {fmtD(p.date)}
                    {p.no === 1 && (
                      <span className="ml-1.5 text-[11px] font-bold" style={{ color: T.inkSoft }}>
                        Payment received
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] font-semibold" style={{ color: T.inkSoft }}>
                    {p.refs.length ? `Against ${p.refs.join(', ')}` : 'On account'}
                    {p.note ? ` · ${p.note}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-[13.5px] font-bold tabular-nums" style={{ color: T.ink }}>
                  {inrFull(p.amount)}
                </span>
              </div>
            ))}
            {!closed && lastPart && lastPart.no > 1 && !undoAsk && (
              <button
                type="button"
                onClick={() => setUndoAsk(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[4px] border bg-white text-[12px] font-extrabold"
                style={{ borderColor: T.alertRule, color: T.alertInk }}
              >
                <History className="h-4 w-4" /> Take back part {lastPart.no}
              </button>
            )}
            {undoAsk && lastPart && (
              <div className="grid gap-2 rounded-[4px] border px-3 py-2.5" style={{ background: T.alertBg, borderColor: T.alertRule }}>
                <span className="text-[12px] font-bold" style={{ color: T.alertInk }}>
                  Take back part {lastPart.no} ({inrFull(lastPart.amount)})? Its voucher is deleted.
                </span>
                <div className="flex gap-2">
                  <Btn onClick={() => setUndoAsk(false)}>KEEP IT</Btn>
                  <Btn kind="danger" onClick={() => void undoLast()} disabled={busy}>
                    TAKE BACK
                  </Btn>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      {left > 0.005 && !closed && (
        <Panel title={`Part ${parts.length + 1}`}>
          <div className="grid gap-[13px]">
            <Field label="Date paid" req hint={last ? `On or after ${fmtD(last)}, up to today.` : 'Up to today.'}>
              <DateIn value={date} onChange={setDate} max={todayISO()} min={last || undefined} />
            </Field>
            <Field
              label="Amount (₹)"
              req
              hint={
                over
                  ? `More than the ${inrFull(left)} still to pay.`
                  : amt > 0 && amt < left - 0.005
                    ? `${inrFull(round2(left - amt))} will still be left after this.`
                    : 'Clears what is left on this bill.'
              }
              hintFg={over ? T.alert : T.inkSoft}
            >
              <TextIn value={amount} onChange={(v) => setAmount(num(v))} mono big bad={over} inputMode="decimal" />
            </Field>
            <Field label="Note">
              <TextIn value={memo} onChange={setMemo} placeholder="NBFC advice no., remarks" />
            </Field>
            <div className="text-[11.5px] font-semibold leading-[1.5]" style={{ color: T.inkSoft }}>
              Posts a journal on that date: Dr {s(l.party_name) || 'supplier'} · Cr Bills discounted — {s(l.nbfc_name) || 'NBFC'}. Interest, margin and
              charges were taken with the first part.
            </div>
          </div>
        </Panel>
      )}

      {err && <ErrorNote text={err} />}
    </Screen>
  )
}
