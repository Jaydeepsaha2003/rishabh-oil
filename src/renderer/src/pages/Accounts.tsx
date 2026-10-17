import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { escMayDiscard, escToClose, hasOpenOverlay, useDrawerEscape } from '@/lib/escape'
import { toast } from 'sonner'
import { loadUser } from '@/lib/session'
import { parsePerms, rightsOf, type Rights } from '@/lib/userRights'
import { VOUCHER_SECTION, type AccountsSectionKey } from '@/lib/accessSections'
import { sortCompanies } from '@/lib/companyOrder'
import {
  ArrowLeftRight,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpDown,
  Banknote,
  BookOpen,
  BookOpenText,
  Building2,
  Calculator,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCheck,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  CirclePlus,
  Columns3,
  FileStack,
  FilterX,
  Keyboard as KeyboardIcon,
  ListTree,
  Network,
  Package,
  Percent,
  PiggyBank,
  ReceiptText,
  ShoppingCart,
  Split,
  Store,
  Tag,
  TriangleAlert,
  Zap,
  User,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  FileText,
  FileSpreadsheet,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  IndianRupee,
  Pencil,
  Info,
  Truck,
  Landmark,
  Lightbulb,
  Monitor,
  PackageSearch,
  PieChart,
  Plus,
  Receipt,
  Save,
  Scale,
  ScrollText,
  Search,
  Trash2,
  Wallet,
  X,
  Lock as LockIcon,
  ArrowUpRight,
  Link2Off,
  RotateCcw,
  CheckCircle2,
  Hourglass,
  Undo2,
  Download,
  LayoutList,
  AlignJustify,
  TrendingUp,
  SearchX,
  ChevronsUpDown,
  Eye,
  EyeOff
} from 'lucide-react'
import { exportRowsToExcel, NUM_MONEY, NUM_QTY } from '@/lib/excel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TallyLedgers } from '@/components/TallyLedgers'
import { TallyNotesImport } from '@/components/TallyNotesImport'
import { CashflowRegister } from '@/components/CashflowRegister'
import { PayReceiptRegister } from '@/components/PayReceiptRegister'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DbStatus } from '@/components/DbStatus'
import { UpdateBadge } from '@/components/UpdateBadge'
import { useHeaderExtras } from '@/lib/companyContext'
import { FyPicker } from '@/components/FyPicker'
import { errText, formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { orderVoucherLines, TAX_NAME } from '@/lib/voucherOrder'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/useIsMobile'
import { TagPicker, TagChip, useTagMap } from '@/components/Tags'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { colFilter, useColFilterStore } from '@/lib/colFilters'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The same look as <Input>, without its auto-uppercase. Used where the text is
// a heading rather than a master — a ledger GROUP's name, which sits in a
// column beside Tally's own title-case ones.
const PLAIN_INPUT =
  'flex h-9 w-full rounded-none border border-input bg-transparent px-3 py-1 text-sm shadow-sm ' +
  'transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

// products.category is the master's "Sub-category" (products.material_type is
// its "Category"), stored lower-case.
const SUB_CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished',
  'by-product': 'By-product',
  waste: 'Waste'
}

// ---------------------------------------------------------------------------
// THE MODULE'S PALETTE — the product's, in Tally's structure.
//
// Forest frame, pale-green paper, lime selection, red key letters. What
// carries over from Tally is the SHAPE of the thing: dense grids, a dark band
// at the head of every table, a letter in red saying which key jumps where.
// The colours are this software's own, because a module that arrives in navy
// and cream reads as a different product wearing the same login.
// ---------------------------------------------------------------------------
const T = {
  frame: 'bg-[#0B3D2E]',
  paper: 'bg-[#F7FAF6]',
  paperEdge: 'border-[#D6E2D6]',
  headBar: 'bg-[#E3EEE0] text-[#0B3D2E]',
  select: 'bg-[#DFF0C4]',
  key: 'text-[#B3261E]'
}

// THE SAME PALETTE AS HEX, for the website's rebuild of this module.
// ---------------------------------------------------------------------------
// T above is Tailwind classes, which is what the desktop app's markup is
// written in. The website's Accounting is built to its own canvas — dense
// tables, tinted totals, a forest frame — where nearly every colour is a one-off
// on an inline style, and a `bg-[#...]` for each would be a class Tailwind has
// to generate for a single use. Same values, stated once, in the form this
// half of the file needs them.
const A = {
  frame: '#0B3D2E',
  // A darker inset on the frame, and the two weights of text that sit on it:
  // the label weight for column headers, the body weight for the key bar.
  frameDeep: '#072B20',
  onLabel: '#8FBFA8',
  onBody: '#B9D3C6',
  paper: '#F7FAF6',
  edge: '#D6E2D6',
  edgeSoft: '#DCE7DB',
  head: '#E3EEE0',
  headEdge: '#C3D2C6',
  rule: '#EAF0E9',
  fill: '#EFF5EC',
  fill2: '#EAF0E9',
  select: '#DFF0C4',
  key: '#B3261E',
  keySoft: '#8FBFA8',
  muted: '#5A6B62',
  accent: '#C7F03F',
  ink: '#0A1F17',
  inkMid: '#33473E',
  inkSky: '#8FBFA8',
  dr: '#1B4E82',
  cr: '#8C2F26',
  good: '#0B6B45',
  warn: '#8A5300',
  bad: '#B3261E',
  none: '#C3D2C6',
  link: '#1B4E82'
} as const

// THE APP'S OWN FACE, not a second one for this module.
//
// The canvas is drawn in Manrope with IBM Plex Mono for its figures. Loading
// both here gave Accounting a typeface nothing else in the software uses —
// every other register is Inter — so the module read as a different product
// wearing a borrowed face. It is the same books; it should be the same voice.
//
// What the mono face was FOR is worth keeping, though: a column of amounts has
// to sit on one pitch to be read down. Inter carries tabular, slashed-zero
// figures (it is what `.doc-ref` turns on across the rest of the app), so the
// digits still line up — they simply line up in the app's own font. FIGS is
// applied wherever the canvas called for mono.
const SANS = 'inherit'
const MONO = 'inherit'
const FIGS = 'tabular-nums slashed-zero'

// HOW WIDE A STRING IS, in the page's own font — so a register can size a
// column to the longest entry actually in it rather than to a guess, and
// nothing in it has to be cut short with an ellipsis.
let measureCtx: CanvasRenderingContext2D | null = null
let measureFamily = ''
function textWidth(text: string, weight: number, size: number, letterSpacingEm = 0): number {
  if (typeof document === 'undefined') return text.length * size * 0.62
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
    measureFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
  if (!measureCtx) return text.length * size * 0.62
  measureCtx.font = `${weight} ${size}px ${measureFamily}`
  return measureCtx.measureText(text).width + text.length * size * letterSpacingEm
}

// A REGISTER AS IT WAS LEFT. Opening a bill or an invoice from a register
// leaves Accounting altogether — it unmounts — so everything it was showing
// went with it: the search, the month, the LC chip, the open row, the place in
// the list. It is written down here on the way out and read back on the way in,
// and only then: a register visited afresh starts clean.
type RegMemo = {
  screen: string
  regFrom: string
  regTo: string
  regSearch: string
  regFunding: string[]
  nrFrom: string
  nrTo: string
  nrSearch: string
  noteKind: 'all' | 'debit' | 'credit'
  openRow: string | null
  post: Record<string, Row | 'loading'>
  scrollTop: number
}
let regMemo: RegMemo | null = null

// WHERE A LEDGER WAS LEFT when one of its lines drilled out to its document —
// a purchase, a sale, an LC, a discounted bill. The page unmounts on the way
// out, and the way back used to land on the plain Vouchers view whatever was
// open; bill-wise lost the bill that was clicked. Kept here, read once on the
// way back in, for the same ledger only.
interface LgMemo {
  ledgerId: number | null
  view: 'vouchers' | 'monthly' | 'columnar' | 'billwise'
  bills: boolean
  monthly: boolean
  detailed: boolean
  condensed: boolean
  bwDetailed: boolean
  bwSel: number
  bwFlip: string[]
}
let lgMemo: LgMemo | null = null

/**
 * A LEDGER IS FOUND HOWEVER ITS NAME IS PUNCTUATED. "KR FINMARK" has to find
 * "K.R FINMARK (P) LTD CREDITORS" — a dot, a bracket or a space in the name
 * is not something anybody types the same way twice. The plain match still
 * comes first; the loose one only widens it.
 */
function ledgerNameMatches(name: unknown, q: string): boolean {
  const nm = String(name || '').toLowerCase()
  if (nm.includes(q)) return true
  const loose = (s: string): string => s.replace(/[^a-z0-9]/g, '')
  const lq = loose(q)
  return !!lq && loose(nm).includes(lq)
}

// What the header calls the screen you are on.
const SCREEN_TITLE: Record<string, string> = {
  gateway: 'Gateway',
  voucher: 'Accounting Vouchers',
  daybook: 'Day Book',
  ledger: 'Ledger Accounts',
  trial: 'Trial Balance',
  purchreg: 'Purchase Register',
  salesreg: 'Sales Register',
  notesreg: 'Debit / Credit Notes',
  tfpur: 'Fr. Inward Working',
  tfsal: 'Fr. Outward Working',
  openings: 'Opening Balances',
  masters: 'Masters · Groups & Ledgers',
  tallyimport: 'Tally File Updation',
  cashflow: 'Cashflow Register',
  payreg: 'Payment / Receipt Register'
}

// What each gateway card is FOR, and the colour of its edge. A list of eleven
// names tells a newcomer nothing about which one answers their question; one
// line each does, and it is the difference between a menu and a gateway.
const GW_META: Record<string, { sub: string; mark: string }> = {
  V: { sub: 'Payments, receipts, journals and notes', mark: '#0B3D2E' },
  P: { sub: 'Every purchase bill with its GST and TDS', mark: '#1B4E82' },
  S: { sub: 'Every sale invoice and what it is owed', mark: '#0B6B45' },
  D: { sub: 'One day or a range, vouchers and material', mark: '#33473E' },
  N: { sub: 'Shortage, quality and rate claims raised', mark: '#B3261E' },
  C: { sub: 'Allowances, returns and rate cuts given', mark: '#0B6B45' },
  R: { sub: 'Freight payable to transporters on purchases', mark: '#8A5300' },
  O: { sub: 'Freight recoverable on sales', mark: '#8A5300' },
  L: { sub: 'Any account and its statement', mark: '#0B3D2E' },
  T: { sub: 'Group by group, Dr against Cr', mark: '#1B4E82' },
  B: { sub: 'What each ledger opened the year at', mark: '#33473E' },
  M: { sub: 'The chart of accounts — groups, and what sits under them', mark: '#0B3D2E' },
  U: { sub: 'Tally notes in; sales, purchase, journal and bank books checked', mark: '#8A5300' },
  F: { sub: 'Every voucher opened up — invoice, refs, ledgers, breakdown, what is not right', mark: '#1B4E82' },
  Y: { sub: 'Payments, receipts and contra — by bank, with the running balance', mark: '#0B6B45' }
}

// WHICH SIDE OF THE BOOKS A GROUP FALLS ON, IN COLOUR.
//
// Debits blue and credits maroon are already how every figure in this module
// is read, so an asset and a liability wear those; income and expense take the
// good/warn pair. Used by the ledger list and by Masters, from one place, so a
// SUNDRY CREDITOR is the same colour wherever it is named.
const NATURE_TONE: Record<string, { bg: string; fg: string; bd: string }> = {
  asset: { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0' },
  liability: { bg: '#FDF3F2', fg: '#8C2F26', bd: '#F0D6D4' },
  income: { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' },
  expense: { bg: '#FFF4E0', fg: '#8A5300', bd: '#F0E4CB' }
}
const natureTone = (n: unknown): { bg: string; fg: string; bd: string } =>
  NATURE_TONE[String(n || '')] || { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB' }

// WHAT EACH VOUCHER TYPE LOOKS LIKE.
// Money in is green, money out amber, a debit note red, and the two that only
// move figures between accounts stay neutral — so a day's work can be read by
// colour before any of it is read by name.
const TYPE_TONE: Record<string, { bg: string; fg: string; bd: string }> = {
  PURCHASE: { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0' },
  SALE: { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' },
  RECEIPT: { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' },
  PAYMENT: { bg: '#FFF4E0', fg: '#8A5300', bd: '#F0E4CB' },
  JOURNAL: { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB' },
  CONTRA: { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB' },
  'DEBIT NOTE': { bg: '#FDF3F2', fg: '#B3261E', bd: '#F0D6D4' },
  'CREDIT NOTE': { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' }
}
// What a note was raised against: the bill (Agst Ref), on account, or — for a
// note entered on the voucher screen with no bill-wise line — just that.
const noteAgainst = (r: Row): string => {
  if (r.against_ref) return String(r.against_ref)
  if (r.against_account) return String(r.against_account)
  if (r.from_voucher) return r.against_on_account ? 'on account' : 'Entered as a voucher'
  return 'on account'
}
const toneOf = (t: unknown): { bg: string; fg: string; bd: string } =>
  TYPE_TONE[String(t || '').toUpperCase()] || { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB' }

// The groups a trial balance is read in — assets and liabilities before the
// accounts that explain the year's movement, which is the order Tally prints
// and the order the mill's own accountant reads.
const TB_GROUP_ORDER = [
  'Capital Account',
  'Bank Accounts',
  'Bank OD A/c',
  'Cash-in-Hand',
  'Sundry Debtors',
  'Sundry Creditors',
  'Duties & Taxes',
  'Loans (Liability)',
  'Current Assets',
  'Current Liabilities',
  'Fixed Assets',
  'Purchase Accounts',
  'Sales Accounts',
  'Direct Expenses',
  'Direct Incomes',
  'Indirect Expenses',
  'Indirect Incomes'
]

// A key on the bottom bar. Tally's button bar is contextual — the same key
// means one thing on a statement and another on a voucher — so what is on it
// is decided per screen and this only draws it.
// THE KEY BAR, ON A SCREEN TOO NARROW FOR IT.
//
// Fourteen keys fit across 1600. They do not fit across a laptop at 1280 or a
// window dragged narrow, and a bar that simply clips its right-hand end hides
// Openings and Quit with nothing to say they are there. It has always
// scrolled; what it lacked was any sign that it could.
//
// So: an arrow at each end, drawn only when there is something past it, and
// disabled the moment there is not — the arrows themselves are the statement
// that the bar continues. On a screen wide enough for every key neither
// appears, which is why this is not simply two permanent buttons.
function KeyBarScroller({ children }: { children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [edge, setEdge] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // A pixel of slack: a fractional scrollWidth (which a zoomed browser
    // produces) would otherwise leave the right arrow live at the far end.
    setEdge({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    })
  }, [])

  useEffect(() => {
    measure()
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', measure, { passive: true })
    // The bar's own width changes with the window, and its CONTENT changes
    // with the screen — the ledger swaps the voucher keys for its four views —
    // so both are watched rather than only the window.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, children])

  const nudge = (dir: -1 | 1): void => {
    const el = ref.current
    if (!el) return
    // Most of a screenful, not all of it: a key left in view is what tells you
    // where you were.
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' })
  }

  const arrow = (dir: -1 | 1, live: boolean): React.JSX.Element => (
    <button
      type="button"
      aria-label={dir < 0 ? 'Earlier keys' : 'Later keys'}
      disabled={!live}
      onClick={() => nudge(dir)}
      className="flex h-[32px] w-[26px] flex-none items-center justify-center rounded-[3px] transition-colors"
      style={{
        background: live ? 'rgba(255,255,255,.14)' : 'transparent',
        color: live ? A.onBody : 'transparent',
        cursor: live ? 'pointer' : 'default'
      }}
    >
      {dir < 0 ? <ChevronLeft className="h-[18px] w-[18px]" /> : <ChevronRight className="h-[18px] w-[18px]" />}
    </button>
  )

  return (
    <div
      className="flex h-[50px] flex-none items-center gap-1.5"
      style={{
        padding: '0 22px',
        background: 'linear-gradient(180deg,#0B3D2E,#072B20)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)'
      }}
    >
      {arrow(-1, edge.left)}
      <div ref={ref} className="sc flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {children}
      </div>
      {arrow(1, edge.right)}
    </div>
  )
}

function AcctKey({
  k,
  label,
  on,
  onClick
}: {
  k: string
  label: string
  on?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[32px] flex-none items-center gap-[7px] whitespace-nowrap rounded-[6px] px-2.5 transition-colors hover:bg-white/10"
      style={{
        background: on ? 'rgba(199,240,63,.14)' : 'rgba(255,255,255,.04)',
        border: '1px solid rgba(255,255,255,.08)',
        color: on ? '#fff' : '#A9CDBB',
        fontSize: 11.5,
        fontWeight: 700
      }}
    >
      <span
        style={{
          fontFamily: MONO,
          fontVariantNumeric: FIGS,
          fontSize: 9.5,
          fontWeight: 600,
          color: A.accent,
          background: 'rgba(199,240,63,.1)',
          borderRadius: 3,
          padding: '2px 5px'
        }}
      >
        {k}
      </span>
      {label}
    </button>
  )
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// A money field that is readable when you are not in it.
//
// A raw number input shows 16054441.64, and nobody can tell at a glance whether
// that is sixteen lakh or one crore sixty. Grouped, it reads 1,60,54,441.64 and
// the magnitude is obvious — which on a voucher is the whole point, since the
// commonest error is an amount an order of magnitude out.
//
// Grouped while blurred, raw while focused: grouping separators fight the caret
// and the keyboard, so they are dropped the moment you start typing.
function AmountInput({
  value,
  onChange,
  onFocus,
  className,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  onFocus?: () => void
  className?: string
  placeholder?: string
}): React.JSX.Element {
  const [live, setLive] = useState(false)
  const num = Number(value)
  const shown = live || value === '' || !Number.isFinite(num) ? value : formatNum(num)
  return (
    <input
      // Not type=number: that forbids the grouping separators shown when
      // blurred, and its spinner has no business on a ledger amount.
      inputMode="decimal"
      className={cn(
        'doc-ref h-8 w-full rounded-md border bg-white px-2 text-right text-[13px] tabular-nums outline-none',
        'focus:border-[#0B3D2E] focus:ring-1 focus:ring-[#0B3D2E]/20',
        className
      )}
      value={shown}
      placeholder={placeholder}
      onFocus={() => {
        setLive(true)
        onFocus?.()
      }}
      onBlur={() => setLive(false)}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
    />
  )
}

// The Trading Account screen (U) was taken out at the client's request on
// 30 Sep 2026; journal:tradingAccount on the server is left for any report
// that wants the roll-up.
type Screen = 'gateway' | 'voucher' | 'daybook' | 'ledger' | 'trial' | 'purchreg' | 'salesreg' | 'notesreg' | 'tfpur' | 'tfsal' | 'openings' | 'masters' | 'tallyimport' | 'cashflow' | 'payreg'
type VchType = 'CONTRA' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'DEBIT NOTE' | 'CREDIT NOTE'

// `label` names the VOUCHER TYPE and is used wherever one is named — the tab
// row, the type dropdown, a saved voucher's own heading. `barLabel` is what
// the key bar down the side calls the key, which is not always the same
// thing: F6 is asked for by what it OPENS rather than by the type it lands on.
// Only set it where the two differ.
const VCH_TYPES: { key: VchType; fkey: string; label: string; barLabel?: string }[] = [
  { key: 'CONTRA', fkey: 'F4', label: 'Contra' },
  { key: 'PAYMENT', fkey: 'F5', label: 'Payment' },
  { key: 'RECEIPT', fkey: 'F6', label: 'Receipt', barLabel: 'Vouchers' },
  { key: 'JOURNAL', fkey: 'F7', label: 'Journal' },
  { key: 'DEBIT NOTE', fkey: 'Alt F5', label: 'Debit Note' },
  { key: 'CREDIT NOTE', fkey: 'Alt F6', label: 'Credit Note' }
]

// Which User Access row each screen answers to (accessSections.ts). The
// gateway and the voucher form belong to none: the page opens on Accounting
// or on any one section, and the form is gated by the voucher TYPE instead
// (VOUCHER_SECTION) — a voucher can be looked at from a ledger by someone who
// may not enter one.
const SCREEN_SECTION: Record<Screen, AccountsSectionKey | null> = {
  gateway: null,
  voucher: null,
  daybook: 'accountsDaybook',
  ledger: 'accountsLedgers',
  trial: 'accountsTrial',
  purchreg: 'accountsPurchReg',
  salesreg: 'accountsSalesReg',
  notesreg: 'accountsNotesReg',
  tfpur: 'accountsFrInward',
  tfsal: 'accountsFrOutward',
  openings: 'accountsOpenings',
  masters: 'accountsMasters',
  tallyimport: 'accountsTallyImport',
  cashflow: 'accountsCashflow',
  payreg: 'accountsPayReg'
}
const SCREEN_LABEL: Record<Screen, string> = {
  gateway: 'the Gateway',
  voucher: 'Vouchers',
  daybook: 'the Day Book',
  ledger: 'Ledgers',
  trial: 'the Trial Balance',
  purchreg: 'the Purchase Register',
  salesreg: 'the Sales Register',
  notesreg: 'Debit / Credit Notes',
  tfpur: 'Fr. Inward Working',
  tfsal: 'Fr. Outward Working',
  openings: 'Opening Balances',
  masters: 'Masters',
  tallyimport: 'Tally File Updation',
  cashflow: 'the Cashflow Register',
  payreg: 'the Payment / Receipt Register'
}
// The gateway letters that open a screen ('V' opens a voucher instead).
const GATE_SCREEN: Record<string, Screen> = {
  P: 'purchreg', S: 'salesreg', D: 'daybook', N: 'notesreg', C: 'notesreg', R: 'tfpur', O: 'tfsal',
  L: 'ledger', T: 'trial', B: 'openings', M: 'masters', U: 'tallyimport', F: 'cashflow', Y: 'payreg'
}
const ALL_RIGHTS: Rights = { view: true, create: true, edit: true, delete: true, editDays: '', viewDays: '', scope: '' }

/** One row of the working behind a line's figure. See SplitPanel. */
interface SplitRow {
  name: string
  amount: string
  note?: string
}

interface VLine {
  side: 'dr' | 'cr'
  account: string
  group: string
  amount: string
  allocs: AllocRow[]
  // Optional, and absent on almost every line: how this one's total was
  // arrived at. Not a posting — see the note on SplitPanel.
  splits?: SplitRow[]
  // A Debit/Credit note line that stands for a stock item. When a product
  // ledger (Purchase/Sales Accounts) is picked the line can carry a quantity,
  // and the amount then follows qty × rate. These ride only on note vouchers;
  // every other voucher type leaves them empty.
  product_id?: number | null
  qty?: string
  rate?: string
}

// Tally-format payment/receipt entry: one money account, party lines with
// bill-wise adjustments (Agst Ref / Advance / On Account / New Ref).
interface AllocRow {
  method: 'agst_ref' | 'advance' | 'on_account' | 'new_ref'
  ref_name: string
  order_id?: number | null
  sale_invoice_group?: string | null
  amount: string
}
interface PayLine {
  account: string
  group: string
  amount: string
  allocs: AllocRow[]
}
const CASH_BANK_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']
const BILLWISE_GROUPS = ['Sundry Creditors', 'Sundry Debtors']
// A group of the books' own sits under a standard one — SC-OIL under Sundry
// Creditors — and reads as it: bill-wise, a supplier, Cr by nature. Filled
// from the chart (listGroupNames' base) whenever the groups load.
let GROUP_BASE = new Map<string, string>()
const baseGroup = (g: unknown): string => {
  const s = String(g || '').trim()
  return GROUP_BASE.get(s) || s
}
const isBillwise = (g: unknown): boolean => BILLWISE_GROUPS.includes(baseGroup(g))
// The ledgers that stand for stock — a purchase or sale account. A note line on
// one of these can carry a quantity, and the amount then follows qty × rate.
const PRODUCT_LEDGER_GROUPS = ['Purchase Accounts', 'Sales Accounts']
const METHODS:{ key: AllocRow['method']; label: string }[] = [
  { key: 'agst_ref', label: 'Agst Ref' },
  { key: 'advance', label: 'Advance' },
  { key: 'on_account', label: 'On Account' },
  { key: 'new_ref', label: 'New Ref' }
]
const blankPayLine = (): PayLine => ({ account: '', group: '', amount: '', allocs: [] })
const typeLabelOf = (t: string): string => VCH_TYPES.find((v) => v.key === t)?.label || t

function monthLabelLong(m: string): string {
  const [y, mo] = m.split('-')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[Number(mo) - 1] || mo} ${y}`
}

// A credit note opens Dr then Cr like every other voucher but a receipt — the
// sales / return head is debited first and the customer credited after.
const blankLines = (t: VchType): VLine[] =>
  t === 'RECEIPT'
    ? [
        { side: 'cr', account: '', group: '', amount: '', allocs: [] },
        { side: 'dr', account: '', group: '', amount: '', allocs: [] }
      ]
    : [
        { side: 'dr', account: '', group: '', amount: '', allocs: [] },
        { side: 'cr', account: '', group: '', amount: '', allocs: [] }
      ]

// A Tally-style function-key button for the right-hand bar.
/**
 * A MACBOOK HAS NO FUNCTION KEYS, NOT REALLY.
 *
 * F1 to F12 are the top row's SECOND job on a Mac: unmodified, they dim the
 * screen, change the volume, open Mission Control. The browser never sees
 * them unless the reader holds fn, or has gone into System Settings and
 * turned the whole row around. So a screen built on F1/F5/F6/F7 — which this
 * one is, deliberately, because it is the keyboard Tally taught them — simply
 * does not respond on a Mac. Every shortcut on the page reads as broken.
 *
 * So on a Mac the same actions answer to CONTROL and a digit. Control is
 * chosen over Command on purpose: Cmd+1…9 already jumps browser tabs, and a
 * shortcut that fights the browser is a shortcut nobody can use. Option
 * stands in for Alt exactly as it does everywhere else.
 *
 * Everything below this line keeps asking about 'F5'. The normaliser answers
 * for both keyboards, so not one of the branches had to learn about Macs.
 */
const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '')

/** The logical function key this keystroke means, or '' if it is not one. */
function fKeyOf(e: KeyboardEvent): string {
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return e.key
  // Ctrl+1…9 on a Mac is F1…F9. Ctrl is free there; on Windows it is not
  // (Ctrl+1 is a browser tab), so this is Mac-only on purpose.
  if (IS_MAC && e.ctrlKey && /^[1-9]$/.test(e.key)) return `F${e.key}`
  return ''
}

/** How to WRITE a function key for whoever is reading the bar. */
function fKeyLabel(k: string): string {
  const m = /^F([1-9]|1[0-2])$/.exec(k)
  if (!IS_MAC || !m || Number(m[1]) > 9) return k
  return `⌃${m[1]}`
}

/** …and the same for a chord written "Alt F2" or "Alt+F1". */
function chordLabel(k: string): string {
  if (!IS_MAC) return k
  return k.replace(/\bAlt\s*\+?\s*/i, '⌥').replace(/F([1-9])\b/g, (_m, d) => `⌃${d}`)
}

function FKey({ k, label, active, onClick }: { k: string; label: string; active?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors',
        active ? 'bg-amber-200 text-[#0B3D2E]' : 'bg-white/10 text-white hover:bg-white/20'
      )}
    >
      <span className={cn('w-9 shrink-0 font-bold', active ? T.key : 'text-amber-300')}>{chordLabel(k)}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * WHAT A LINE IS MADE OF.
 *
 * SALARY A/C 20,000 against BANK A/C is a true posting and a poor record: it
 * is four people, or basic and HRA and an allowance, and a month later nobody
 * can say which. This is where that is written down — the working behind the
 * figure, kept with the voucher and handed back when it is read again.
 *
 * It is a MEMO, not a posting. Nothing here moves a rupee, the double entry is
 * untouched, and the ledger reads exactly as it did. Splitting into real
 * postings is what extra voucher lines are for; what was missing was anywhere
 * to say how one line's own total was reached.
 *
 * It must add up. The moment somebody writes the parts down, those parts ARE
 * the explanation, and an explanation that comes to 18,500 against a line of
 * 20,000 misinforms every reader after it — so the difference is stated in
 * the panel and the server refuses the save.
 */
function SplitPanel({
  rows,
  lineAmount,
  onChange,
  onClose
}: {
  rows: SplitRow[]
  lineAmount: number
  onChange: (rows: SplitRow[]) => void
  onClose: () => void
}): React.JSX.Element {
  const total = rows.reduce((t, r) => t + (Number(r.amount) || 0), 0)
  const diff = Math.round((lineAmount - total) * 100) / 100
  const set = (i: number, patch: Partial<SplitRow>): void =>
    onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const add = (): void => onChange([...rows, { name: '', amount: '' }])
  const drop = (i: number): void => onChange(rows.filter((_, k) => k !== i))

  return (
    <div className="mt-1.5 rounded-[4px] border border-[#C6DAF0] bg-[#F7FAFE] p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#1B4E82]">
          What this line is made of
        </span>
        <span className="min-w-0 flex-1" />
        <span className="text-[11px] font-semibold text-[#5A6B62]">
          {rows.length} {rows.length === 1 ? 'part' : 'parts'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[3px] border border-[#C3D2C6] bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#33473E] hover:bg-[#EDF3EC]"
        >
          Close
        </button>
      </div>
      {rows.length === 0 && (
        <div className="px-1 py-2 text-[11.5px] font-medium text-[#5A6B62]">
          Nothing written down yet — add a part for each person, head or item this figure covers.
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="mb-1.5 flex items-center gap-1.5">
          <span className="w-[14px] flex-none text-right text-[10.5px] font-extrabold tabular-nums text-[#8CA396]">
            {i + 1}
          </span>
          <input
            value={r.name}
            autoFocus={i === rows.length - 1 && rows.length > 1}
            onChange={(e) => set(i, { name: e.target.value })}
            placeholder="Who or what — e.g. RAMESH · basic pay"
            className="h-8 min-w-0 flex-1 rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-[12px] font-semibold outline-none focus:border-[#1B4E82]"
          />
          <input
            inputMode="decimal"
            value={r.amount}
            onChange={(e) => set(i, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && i === rows.length - 1) {
                e.preventDefault()
                add()
              }
            }}
            placeholder="0.00"
            className="doc-ref h-8 w-[130px] flex-none rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-right text-[12px] font-bold tabular-nums outline-none focus:border-[#1B4E82]"
          />
          <button
            type="button"
            onClick={() => drop(i)}
            title="Remove this part"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[3px] border border-[#C3D2C6] bg-white text-[#8CA396] hover:border-[#B3261E] hover:text-[#B3261E]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-t-[#DCE7F7] pt-2">
        <button
          type="button"
          onClick={add}
          className="flex h-8 items-center gap-1.5 rounded-[3px] border border-dashed border-[#B6CBE4] bg-white px-2.5 text-[11.5px] font-extrabold text-[#1B4E82] hover:bg-[#EAF0FA]"
        >
          <Plus className="h-3.5 w-3.5" /> Add a part
        </button>
        <span className="min-w-0 flex-1" />
        <span className="doc-ref text-[11.5px] font-bold tabular-nums text-[#33473E]">
          {formatINR(total)} of {formatINR(lineAmount)}
        </span>
        {/* The difference, said plainly — the save refuses one that is not
            zero, so it should never be a surprise at the bottom of the page. */}
        {Math.abs(diff) > 0.005 && rows.length > 0 && (
          <span className="doc-ref rounded-[2px] bg-[#FDECEA] px-2 py-0.5 text-[11.5px] font-extrabold tabular-nums text-[#8C2F26]">
            {diff > 0 ? `${formatINR(diff)} unaccounted for` : `${formatINR(-diff)} too much`}
          </span>
        )}
        {Math.abs(diff) <= 0.005 && rows.length > 0 && (
          <span className="rounded-[2px] bg-[#E9F5EE] px-2 py-0.5 text-[11.5px] font-extrabold text-[#0B6B45]">
            adds up
          </span>
        )}
      </div>
    </div>
  )
}

// The bill-wise details editor (method of adjustment), Tally style. Used under
// party lines in payments/receipts AND in the journal / note grid.
// How a settled bill reads in an Agst Ref list: the bill's amount, and — once
// a note or payment has run past it — by how much, the figure a refund would
// later be set against.
function settledNote(r: Row): string {
  const over = -Number(r.pending) || 0
  return over > 0.005
    ? `settled · ${formatINR(over)} over (bill ${formatINR(r.amount)})`
    : `settled · link only (${formatINR(r.amount)})`
}

function AllocPanel({
  lineAmount,
  allocs,
  refs: pendingRefs,
  linkRefs = [],
  onChange,
  look
}: {
  lineAmount: number
  allocs: AllocRow[]
  refs: Row[]
  // The party's bills with nothing left pending — offered below the pending
  // ones, to LINK a voucher to (a debit note for a shortage on a bill that is
  // already paid), the way Tally lists them.
  linkRefs?: Row[]
  onChange: (allocs: AllocRow[]) => void
  // 'card' is the website voucher's own drawing of the same panel. The rules —
  // pending bills, no bill twice, the New Ref collision — are the same ones.
  look?: 'card'
}): React.JSX.Element {
  // A BILL THIS VOUCHER ALREADY SETTLES stays on the list. Altering a voucher
  // (or a note) that settled an invoice, that invoice may no longer read as
  // pending — it is this very voucher that cleared it — so it dropped off the
  // picker and the row showed blank, as if it were against nothing.
  const keyOf = (ref: unknown, orderId: unknown, saleGroup: unknown): string =>
    `${ref ?? ''}::${orderId ?? ''}::${saleGroup ?? ''}`
  const pendingKeys = new Set(pendingRefs.map((r) => keyOf(r.ref, r.order_id, r.sale_invoice_group)))
  const linkKeys = new Set(linkRefs.map((r) => keyOf(r.ref, r.order_id, r.sale_invoice_group)))
  const ownBills = new Map<string, Row>()
  for (const a of allocs) {
    if (a.method !== 'agst_ref' || !a.ref_name) continue
    const k = keyOf(a.ref_name, a.order_id, a.sale_invoice_group)
    if (pendingKeys.has(k) || linkKeys.has(k) || ownBills.has(k)) continue
    ownBills.set(k, { ref: a.ref_name, order_id: a.order_id ?? null, sale_invoice_group: a.sale_invoice_group ?? null, pending: Number(a.amount) || 0, _own: true })
  }
  const refs: Row[] = [...pendingRefs, ...ownBills.values()]
  const settledBills: Row[] = linkRefs.filter((r) => !pendingKeys.has(keyOf(r.ref, r.order_id, r.sale_invoice_group)))
  // Every bill a row may name — pending or settled — for looking one up.
  const everyBill: Row[] = [...refs, ...settledBills]
  const billLabel = (r: Row): string =>
    `${String(r.ref)} — ${r._own ? 'settled by this voucher' : r.settled ? settledNote(r) : `${formatINR(r.pending)} pending`}`
  const allocated = allocs.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
  const matched = Math.abs(allocated - lineAmount) < 0.005
  const remaining = (skip = -1): number =>
    Math.round((lineAmount - allocs.reduce((sum, a, j) => (j === skip ? sum : sum + (Number(a.amount) || 0)), 0)) * 100) / 100
  const set = (j: number, patch: Partial<AllocRow>): void =>
    onChange(allocs.map((a, y) => (y === j ? { ...a, ...patch } : a)))
  // A hand-typed New Ref / Advance that happens to spell an already-tracked
  // bill exactly gets its amount silently merged into that bill's pending
  // total on the backend (same ref_name, different row) — inflating it rather
  // than settling it. Catch the collision here, before it can happen.
  const knownRefs = new Set(everyBill.map((r) => String(r.ref).trim().toUpperCase()))
  const collidesWithKnownBill = (name: string): boolean => {
    const key = name.trim().toUpperCase()
    return key.length > 0 && knownRefs.has(key)
  }
  // Two different bills can legitimately show the same ref text (a duplicate
  // or blank invoice number on the same party) — key the picker on the exact
  // bill identity, not the text, so they never collide.
  const billKey = (ref: unknown, orderId: unknown, saleGroup: unknown): string =>
    `${ref ?? ''}::${orderId ?? ''}::${saleGroup ?? ''}`
  // Picking a pending bill: sized from the bill, capped by what is still open.
  const pickBill = (j: number, v: string): void => {
    const bill = everyBill.find((r) => billKey(r.ref, r.order_id, r.sale_invoice_group) === v)
    const rest = remaining(j)
    set(j, {
      ref_name: bill ? String(bill.ref) : '',
      order_id: bill?.order_id ?? null,
      sale_invoice_group: bill?.sale_invoice_group ?? null,
      // A settled bill has nothing pending to cap at (or less than nothing,
      // once a note already ran past it) — the row takes what is left.
      amount: String(bill?.settled ? rest : Math.min(Number(bill?.pending) || rest, rest))
    })
  }
  // The bills a row may still pick — every pending one not already claimed on
  // another row of this voucher, and always the row's own.
  const openBills = (j: number, a: AllocRow): Row[] => {
    const mine = billKey(a.ref_name, a.order_id, a.sale_invoice_group)
    const taken = new Set(
      allocs
        .filter((o, y) => y !== j && o.method === 'agst_ref')
        .map((o) => billKey(o.ref_name, o.order_id, o.sale_invoice_group))
    )
    return refs.filter((r) => {
      const k = billKey(r.ref, r.order_id, r.sale_invoice_group)
      return k === mine || !taken.has(k)
    })
  }
  // The settled bills a row may link to — the same no-bill-twice rule.
  const openLinks = (j: number, a: AllocRow): Row[] => {
    const mine = billKey(a.ref_name, a.order_id, a.sale_invoice_group)
    const taken = new Set(
      allocs
        .filter((o, y) => y !== j && o.method === 'agst_ref')
        .map((o) => billKey(o.ref_name, o.order_id, o.sale_invoice_group))
    )
    return settledBills.filter((r) => {
      const k = billKey(r.ref, r.order_id, r.sale_invoice_group)
      return k === mine || !taken.has(k)
    })
  }
  const SEP_KEY = '__settled_sep__'
  const addRow = (): void =>
    onChange([
      ...allocs,
      refs.length
        ? { method: 'agst_ref', ref_name: '', amount: '' }
        : { method: 'on_account', ref_name: '', amount: String(Math.max(0, remaining())) }
    ])

  if (look === 'card') {
    const left = remaining()
    const note = !(lineAmount > 0)
      ? 'enter the line amount first'
      : allocs.length === 0
        ? `none — treated as plain balance · ${formatINR(lineAmount)} to allocate`
        : Math.abs(left) < 0.005
          ? 'fully allocated'
          : left > 0
            ? `${formatINR(left)} still to allocate`
            : `over-allocated by ${formatINR(-left)}`
    const noteFg =
      allocs.length === 0 || !(lineAmount > 0) ? '#8A5300' : Math.abs(left) < 0.005 ? '#0B6B45' : left > 0 ? '#8A5300' : '#B3261E'
    const HINT: Record<AllocRow['method'], string> = {
      agst_ref: 'Bill no being adjusted',
      new_ref: 'New reference',
      advance: 'Advance reference',
      on_account: 'No reference needed'
    }
    // What each method MEANS — the four are not interchangeable, and the
    // difference between an advance and an on-account figure is the reason
    // bill-wise entry exists. Said on hover, where the canvas has no room.
    const WHY: Record<AllocRow['method'], string> = {
      agst_ref: 'Settles an existing bill — pick which one.',
      new_ref: 'Opens a new reference on this party for later settlement.',
      advance: 'Paid before the bill exists — it sits as an advance until one is raised.',
      on_account: 'Not tied to any bill — it reduces the running balance only.'
    }
    const box: React.CSSProperties = {
      height: 32,
      borderRadius: 5,
      border: '1px solid #E3C98C',
      background: '#fff',
      padding: '0 10px',
      fontVariantNumeric: FIGS,
      fontSize: 12,
      fontWeight: 600,
      color: A.ink,
      outline: 0,
      minWidth: 0,
      width: '100%'
    }
    return (
      <div style={{ border: '1px dashed #E3C98C', borderRadius: 8, background: 'linear-gradient(180deg,#FFF9EC,#FFF4DD)', padding: '10px 12px' }}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <ReceiptText className="h-4 w-4 flex-none" style={{ color: '#8A5300' }} />
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#8A5300' }}>
            Bill-wise details — method of adjustment
          </span>
          <span className="ml-auto" style={{ fontSize: 11, fontWeight: 800, color: noteFg, fontVariantNumeric: FIGS }}>
            {note}
          </span>
        </div>
        {allocs.map((a, j) => {
          const collides = (a.method === 'new_ref' || a.method === 'advance') && collidesWithKnownBill(a.ref_name)
          const bills = a.method === 'agst_ref' ? openBills(j, a) : []
          const links = a.method === 'agst_ref' ? openLinks(j, a) : []
          return (
            <Fragment key={j}>
              <div className="mt-2 grid items-center gap-2" style={{ gridTemplateColumns: '128px minmax(0,1fr) 170px 30px' }} title={WHY[a.method]}>
                <Select
                  value={a.method}
                  onValueChange={(v) => set(j, { method: v as AllocRow['method'], ref_name: '', order_id: null, sale_invoice_group: null })}
                >
                  <SelectTrigger className="h-8 rounded-[5px] border-[#E3C98C] bg-white px-[9px] text-left text-[11.5px] font-extrabold normal-case text-[#6B4200] shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {a.method === 'agst_ref' ? (
                  <Select value={billKey(a.ref_name, a.order_id, a.sale_invoice_group)} onValueChange={(v) => pickBill(j, v)}>
                    <SelectTrigger
                      className="h-8 min-w-0 rounded-[5px] border-[#E3C98C] bg-white px-2.5 text-left text-[12px] font-semibold normal-case shadow-none"
                      style={{ fontVariantNumeric: FIGS, color: a.ref_name ? A.ink : '#A89366' }}
                    >
                      <SelectValue
                        placeholder={
                          refs.length ? HINT.agst_ref : settledBills.length ? 'No pending bills — pick a settled one to link' : 'No bills found for this party'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {bills.length === 0 && links.length === 0 ? (
                        <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                          {refs.length ? 'Every pending bill is already allocated on this voucher.' : 'This party has no bills.'}
                        </div>
                      ) : (
                        [
                          ...bills.map((r) => (
                            <SelectItem key={billKey(r.ref, r.order_id, r.sale_invoice_group)} value={billKey(r.ref, r.order_id, r.sale_invoice_group)}>
                              {billLabel(r)}
                            </SelectItem>
                          )),
                          ...(links.length
                            ? [
                                <SelectItem key={SEP_KEY} value={SEP_KEY} disabled>
                                  — Settled bills · to link to —
                                </SelectItem>,
                                ...links.map((r) => (
                                  <SelectItem key={billKey(r.ref, r.order_id, r.sale_invoice_group)} value={billKey(r.ref, r.order_id, r.sale_invoice_group)}>
                                    {billLabel(r)}
                                  </SelectItem>
                                ))
                              ]
                            : [])
                        ]
                      )}
                    </SelectContent>
                  </Select>
                ) : a.method === 'on_account' ? (
                  <input disabled placeholder={HINT.on_account} style={{ ...box, background: '#FFFCF4', cursor: 'not-allowed' }} />
                ) : (
                  <Input
                    className={cn(
                      'h-8 rounded-[5px] border-[#E3C98C] bg-white px-2.5 text-[12px] font-semibold shadow-none',
                      collides && 'border-red-500 focus-visible:ring-red-500'
                    )}
                    placeholder={HINT[a.method]}
                    value={a.ref_name}
                    onChange={(e) => set(j, { ref_name: e.target.value })}
                  />
                )}
                <input
                  inputMode="decimal"
                  value={a.amount}
                  placeholder="0.00"
                  aria-label="Amount adjusted"
                  onChange={(e) => set(j, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                  style={{ ...box, textAlign: 'right', fontSize: 12.5, fontWeight: 700 }}
                />
                <button
                  type="button"
                  title="Remove this adjustment"
                  onClick={() => onChange(allocs.filter((_, y) => y !== j))}
                  className="flex h-[30px] w-[30px] items-center justify-center rounded-[5px] hover:bg-[#F7E4E1]"
                >
                  <X className="h-[17px] w-[17px]" style={{ color: '#8C2F26' }} />
                </button>
              </div>
              {collides && (
                <p className="mt-1 pl-[136px] text-[10.5px] font-semibold text-red-700">
                  "{a.ref_name}" is already a real bill on this account — use Agst Ref to settle it, or the amount will double up
                  against that bill instead of a new one.
                </p>
              )}
            </Fragment>
          )
        })}
        <button
          type="button"
          onClick={addRow}
          className="mt-[9px] inline-flex h-[30px] items-center gap-1.5 rounded-[5px] bg-white px-[11px] hover:bg-[#FFF6E2]"
          style={{ border: '1px solid #E3C98C', fontSize: 11.5, fontWeight: 800, color: '#6B4200' }}
        >
          <Plus className="h-4 w-4" /> Add adjustment
        </button>
      </div>
    )
  }

  return (
    <div className="ml-3 mt-1.5 rounded border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-800">
          Bill-wise details — method of adjustment
        </span>
        <span className={cn('text-[10px] font-semibold tabular-nums', matched ? 'text-emerald-700' : 'text-amber-700')}>
          {allocs.length === 0 ? 'none — treated as plain balance' : `${formatINR(allocated)} of ${formatINR(lineAmount)} allocated`}
        </span>
      </div>
      {allocs.map((a, j) => {
        const collides = (a.method === 'new_ref' || a.method === 'advance') && collidesWithKnownBill(a.ref_name)
        return (
        <Fragment key={j}>
        <div className="mb-1 grid grid-cols-[120px_1fr_120px_24px] items-center gap-1.5">
          <Select value={a.method} onValueChange={(v) => set(j, { method: v as AllocRow['method'], ref_name: '', order_id: null, sale_invoice_group: null })}>
            <SelectTrigger className="h-7 bg-white text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {a.method === 'agst_ref' ? (
            <Select
              value={billKey(a.ref_name, a.order_id, a.sale_invoice_group)}
              onValueChange={(v) => {
                const bill = everyBill.find((r) => billKey(r.ref, r.order_id, r.sale_invoice_group) === v)
                const rest = remaining(j)
                set(j, {
                  ref_name: bill ? String(bill.ref) : '',
                  order_id: bill?.order_id ?? null,
                  sale_invoice_group: bill?.sale_invoice_group ?? null,
                  // ALWAYS recomputed from the bill just picked, capped by what
                  // is still unallocated. This used to keep whatever was already
                  // in the field (`a.amount || …`), and since a new row is
                  // pre-filled with the remaining balance, the first bill
                  // swallowed the whole voucher — leaving every later row stuck
                  // at "0" (a truthy string, so the pick could not fix it) and
                  // only one invoice linkable per voucher.
                  amount: String(Math.min(Number(bill?.pending) || rest, rest))
                })
              }}
            >
              <SelectTrigger className="h-7 bg-white text-[12px]">
                <SelectValue
                  placeholder={refs.length ? 'Pick a pending bill' : settledBills.length ? 'No pending bills — pick a settled one to link' : 'No bills found'}
                />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {(() => {
                  // A bill already claimed on another row is dropped, so the
                  // same invoice cannot be allocated twice on one voucher. The
                  // row's own pick stays listed, or the trigger would blank.
                  const mine = billKey(a.ref_name, a.order_id, a.sale_invoice_group)
                  const taken = new Set(
                    allocs
                      .filter((o, y) => y !== j && o.method === 'agst_ref')
                      .map((o) => billKey(o.ref_name, o.order_id, o.sale_invoice_group))
                  )
                  const open = refs.filter((r) => {
                    const k = billKey(r.ref, r.order_id, r.sale_invoice_group)
                    return k === mine || !taken.has(k)
                  })
                  const links = openLinks(j, a)
                  if (open.length === 0 && links.length === 0) {
                    return (
                      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                        {refs.length ? 'Every pending bill is already allocated on this voucher.' : 'This party has no bills.'}
                      </div>
                    )
                  }
                  return [
                    ...open.map((r) => (
                      <SelectItem key={billKey(r.ref, r.order_id, r.sale_invoice_group)} value={billKey(r.ref, r.order_id, r.sale_invoice_group)}>
                        {billLabel(r)}
                      </SelectItem>
                    )),
                    ...(links.length
                      ? [
                          <SelectItem key={SEP_KEY} value={SEP_KEY} disabled>
                            — Settled bills · to link to —
                          </SelectItem>,
                          ...links.map((r) => (
                            <SelectItem key={billKey(r.ref, r.order_id, r.sale_invoice_group)} value={billKey(r.ref, r.order_id, r.sale_invoice_group)}>
                              {billLabel(r)}
                            </SelectItem>
                          ))
                        ]
                      : [])
                  ]
                })()}
              </SelectContent>
            </Select>
          ) : a.method === 'on_account' ? (
            <span className="px-1 text-[11px] italic text-muted-foreground">no reference — unallocated</span>
          ) : (
            <Input
              className={cn('h-7 bg-white text-[12px]', collides && 'border-red-500 focus-visible:ring-red-500')}
              placeholder={a.method === 'advance' ? 'Advance reference (e.g. ADV-1)' : 'New reference name'}
              value={a.ref_name}
              onChange={(e) => set(j, { ref_name: e.target.value })}
            />
          )}
          <Input
            type="number"
            className="h-7 bg-white text-right text-[12px] tabular-nums"
            value={a.amount}
            onChange={(e) => set(j, { amount: e.target.value })}
          />
          <button
            type="button"
            className="cursor-pointer text-muted-foreground hover:text-red-600"
            onClick={() => onChange(allocs.filter((_, y) => y !== j))}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {collides && (
          <p className="mb-1 -mt-0.5 pl-1 text-[10px] font-medium text-red-600">
            "{a.ref_name}" is already a real bill on this account — use Agst Ref to settle it, or the amount will
            double up against that bill instead of a new one.
          </p>
        )}
        </Fragment>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-amber-800 hover:bg-amber-100"
        onClick={() =>
          onChange([
            ...allocs,
            refs.length
              // Agst Ref sizes itself from whichever bill is picked next, so it
              // starts blank rather than grabbing the whole remaining balance.
              ? { method: 'agst_ref', ref_name: '', amount: '' }
              : { method: 'on_account', ref_name: '', amount: String(Math.max(0, remaining())) }
          ])
        }
      >
        <Plus className="h-3 w-3" /> Add adjustment
      </Button>
    </div>
  )
}

/**
 * THE FACILITY A LEDGER LINE BELONGS TO.
 *
 * An LC or a bill discounting posts its journals with no bill-wise allocation
 * at all, so the Ref no column had nothing to name them by and fell back to
 * the voucher number — which for an LC is its own number and for a BD is a
 * bare "V2" or "1", neither of which says what it is.
 *
 * Both write the number in a fixed place, because both are posted by this app
 * and not typed: "LC LC-5 — SOUTH INDIAN BANK charged 1180.00", "Bill
 * Discounting V2 (…) opened with …". Read from there rather than guessed at
 * from a pattern — a BD number carries no prefix to recognise, and matching a
 * bare "1" against every voucher numbered 1 is how a Ref column starts lying.
 */
function facilityRef(l: Row): { kind: 'LC' | 'BD'; no: string } | null {
  const note = String(l?.narration || '').trim()
  // A NUMBER, NOT THE NEXT WORD.
  //
  // Both narrations put the number straight after the name, so the token after
  // it is nearly always right — but "LC opening entry" would hand back
  // "opening" and print it as an LC number. Every facility in these books is
  // numbered with a digit in it (LC-1…LC-14, V2, T1, I1, 1), so requiring one
  // costs nothing real and stops the column inventing references.
  const numbered = (t: string): boolean => /\d/.test(t)
  const bd = /^\s*Bill\s+Discounting\s+(\S+)/i.exec(note)
  if (bd && numbered(bd[1])) return { kind: 'BD', no: bd[1] }
  const lc = /^\s*LC\s+(\S+)/i.exec(note)
  if (lc && numbered(lc[1])) return { kind: 'LC', no: lc[1] }
  // An LC's own voucher number is the LC number; nothing else in the books is
  // shaped like it, so this is safe where the narration has been edited away.
  const vch = String(l?.vch_no || '').trim()
  if (/^LC-\d+$/i.test(vch)) return { kind: 'LC', no: vch }
  return null
}

/**
 * WHICH DOCUMENT A LEDGER LINE IS ANSWERING FOR.
 *
 * The Ref no column printed the narration — a sentence, in a column six
 * characters wide, so what it actually showed was the first few words of one.
 * A reference is the number the rest of the world knows the entry by: the
 * supplier's invoice number on a purchase, the invoice raised on a sale, the
 * bill a receipt was set against, the LC or the BD that posted it.
 *
 * Read in order of how directly each one names a document. A bill-wise
 * allocation is the strongest — somebody chose that bill by hand — then the
 * document the voucher was posted FROM, then a facility that writes its number
 * into its own narration, and only then the voucher number, which is this
 * book's own counter and says nothing about the world outside it.
 */
function lineRef(l: Row): { no: string; kind: string; full: string } | null {
  const named = Array.from(
    new Set(((l.allocs as Row[]) || []).map((a) => String(a.ref_name || '').trim()).filter(Boolean))
  )
  if (named.length) {
    return {
      // A lump receipt can settle six bills. The column says the first and how
      // many more; hovering says all of them, because the column is 130px wide
      // and the answer to "which bills" is sometimes six lines long.
      no: named.length > 1 ? `${named[0]} +${named.length - 1}` : named[0],
      kind: named.length > 1 ? `${named.length} bills` : 'Bill',
      full: named.join(', ')
    }
  }
  const po = String(l.order_invoice_no || '').trim()
  if (po) return { no: po, kind: 'Purchase inv', full: po }
  const so = String(l.sale_invoice_no || '').trim()
  if (so) return { no: so, kind: 'Sales inv', full: so }
  // The LC this voucher actually belongs to, where the link is on file. Its
  // number is the letter's own rather than whatever the narration says — and
  // where a book has two letters sharing a number, this is the only one of the
  // two that is right.
  const lc = String(l.lc_no || '').trim()
  if (lc) return { no: lc, kind: 'LC no', full: lc }
  const f = facilityRef(l)
  if (f) return { no: f.no, kind: f.kind === 'BD' ? 'BD no' : 'LC no', full: f.no }
  const v = String(l.vch_no || '').trim()
  if (v) return { no: v, kind: 'Voucher', full: v }
  return null
}

// A CLOSING BALANCE, WRITTEN ONE WAY.
//
// Lifted out of ledgerWeb, which had them as locals, so the picker states a
// balance in exactly the words the ledger list states it in — a figure that
// reads two ways on two screens is a figure nobody trusts.
const bal = (v: number): string =>
  Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`
const balFg = (v: number): string => (Math.abs(v) < 0.005 ? A.muted : v > 0 ? A.dr : A.cr)

// Searchable ledger picker (cmdk) with inline "create new ledger".
function AccountPicker({
  value,
  accounts,
  onPick,
  onCreate,
  autoFocus,
  icon
}: {
  value: string
  accounts: Row[]
  onPick: (name: string, group: string) => void
  onCreate: (query: string) => void
  autoFocus?: boolean
  // The website's voucher draws the box its own way — taller, rounded, with
  // what KIND of ledger it is at the front. Passing the icon asks for that.
  icon?: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // A ledger hidden in Masters is not offered — unless it is the one already
  // on the line, which still has to read as itself.
  const all = accounts
  accounts = all.filter((a) => !Number(a.is_hidden) || String(a.name) === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {icon ? (
          <button
            type="button"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={autoFocus}
            className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-[9px] rounded-[6px] border border-[#C3D2C6] bg-white px-[11px] text-left shadow-[inset_0_1px_2px_rgba(10,31,23,.04)] transition-colors hover:border-[#8FA79A] focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15"
          >
            <span className="flex flex-none text-[#5A6B62]">{icon}</span>
            <span
              className="min-w-0 flex-1 truncate"
              style={{ fontSize: 12.5, fontWeight: value ? 800 : 600, letterSpacing: '.01em', color: value ? '#0A1F17' : '#8CA396' }}
            >
              {value || 'Select ledger…'}
            </span>
            <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
          </button>
        ) : (
        <button
          type="button"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          className={cn(
            'h-8 w-full cursor-pointer truncate rounded border bg-white px-2 text-left text-[13px]',
            'focus:outline-none focus:ring-2 focus:ring-amber-400',
            // A LEDGER NAME IS THE ANSWER, NOT A PROMPT.
            // It sat at the same weight as the placeholder it replaced, so a
            // filled row and an empty one read alike down a column of six.
            // The name is what somebody scans this voucher for.
            value ? 'font-semibold text-[#0A1F17]' : 'text-muted-foreground'
          )}
        >
          {value || 'Select ledger…'}
        </button>
        )}
      </PopoverTrigger>
      {/* Wider, and a row to a ledger rather than a line.
          At 340px a real name — ANAND GLOBAL INDUSTRIES PVT LTD — and its
          group were fighting over one line, so the group wrapped and the rows
          stopped being the same height. The name now owns the top line, the
          group and the closing balance share the one under it, and nothing
          has to truncate to make room for anything else. */}
      <PopoverContent align="start" className="w-[460px] p-0">
        <Command>
          <CommandInput placeholder="Type a ledger name…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>
              <button
                type="button"
                className="mx-auto flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-emerald-700 hover:bg-emerald-50"
                onClick={() => {
                  setOpen(false)
                  onCreate(query)
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Create ledger “{query.toUpperCase()}”
              </button>
            </CommandEmpty>
              {accounts.map((a) => {
                const b = Number(a.balance) || 0
                return (
                <CommandItem
                  key={String(a.id)}
                  value={String(a.name)}
                  className="items-start gap-2 py-1.5"
                  onSelect={() => {
                    onPick(String(a.name), String(a.acc_group || ''))
                    setOpen(false)
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-semibold text-[#0A1F17]">{a.name}</span>
                    <span className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {a.acc_group}
                    </span>
                  </span>
                  {/* WHAT IT STANDS AT, which is the question being asked at
                      the moment a ledger is picked: a payment goes to the
                      party that is owed, and the figure is the reason this one
                      is being chosen over the one above it. */}
                  <span className="flex flex-none flex-col items-end gap-0.5 pl-2">
                    <span className="doc-ref text-[12px] font-bold tabular-nums" style={{ color: balFg(b) }}>
                      {bal(b)}
                    </span>
                    <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">
                      closing
                    </span>
                  </span>
                </CommandItem>
                )
              })}
              {query.trim() && (
                <CommandItem value={`__create__${query}`} onSelect={() => { setOpen(false); onCreate(query) }}>
                  <Plus className="h-3.5 w-3.5 text-emerald-700" />
                  <span className="text-emerald-700">Create ledger “{query.toUpperCase()}”</span>
                </CommandItem>
              )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * PUT THE CARET IN A BOX THAT MAY NOT EXIST YET.
 *
 * A single setTimeout is a guess at how long a panel takes to mount, and a
 * guess that is 40ms short focuses nothing at all and says nothing about it.
 * This keeps asking until the box is there AND has actually taken focus, then
 * stops — so it is right whether the panel mounts instantly or after a fetch.
 *
 * It gives up the moment the reader is typing somewhere else: an auto-focus
 * that yanks the caret out of the field somebody chose is worse than one that
 * never fires.
 */
function focusWhenReady(ref: React.RefObject<HTMLInputElement | null>): () => void {
  let stopped = false
  let tries = 0
  const tick = (): void => {
    if (stopped) return
    const el = ref.current
    const active = typeof document !== 'undefined' ? document.activeElement : null
    // Somebody is already typing in something else. Leave them alone.
    if (active && active !== el && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
    if (el) {
      el.focus()
      if (document.activeElement === el) return
    }
    if (++tries < 30) window.setTimeout(tick, 50)
  }
  tick()
  return () => {
    stopped = true
  }
}

export function Accounts({
  onExit,
  onOpenRecord,
  resume,
  onResumed
}: {
  onExit?: () => void
  // Drill through to the source document's own page. Absent when Accounts is
  // mounted somewhere that cannot navigate, in which case a line falls back to
  // showing its voucher in place.
  onOpenRecord?: (
    target: 'orders' | 'sales' | 'lc' | 'bd' | 'trading',
    id: number,
    resume?: { screen: string; ledgerId: number | null; companyId?: number; voucherId?: number | null }
  ) => void
  // Where this page was when it drilled out, handed back on the way in. A
  // voucher that was open (voucherId) is opened again over the screen it came
  // from, so Esc walks back the way it came.
  resume?: { screen: string; ledgerId: number | null; companyId?: number; voucherId?: number | null } | null
  onResumed?: () => void
}): React.JSX.Element {
  const { bell: headerBell } = useHeaderExtras()
  // Accounting is a Tally-style grid of dense ledger tables — genuinely
  // unreadable on a phone. Rather than ship a cramped version, the website
  // shows a friendly hand-off screen on a small screen and keeps the full
  // page for the desktop.
  const isMobile = useIsMobile()
  // Tally opens on Select Company — every report and voucher below is pinned
  // to this choice (F3 changes it), never silently the app-wide company.
  const [companies, setCompanies] = useState<Row[]>([])
  const [company, setCompany] = useState<Row | null>(null)
  const [coIndex, setCoIndex] = useState(0)
  useEffect(() => {
    Promise.all([window.api.company.list(), window.api.company.getActive()])
      .then(([listed, active]) => {
        // In the order set in Manage Companies (Priority), so 1, 2… on the
        // picker and F3 follow it — see lib/companyOrder.
        const cs = sortCompanies(listed)
        setCompanies(cs)
        const resuming = pendingCoRef.current != null
        const want = pendingCoRef.current ?? Number(active.id)
        pendingCoRef.current = null
        const i = cs.findIndex((x) => Number(x.id) === Number(want))
        setCoIndex(i >= 0 ? i : 0)
        // Coming back from a drill-through, the company was CHOSEN before we
        // left — so choose it again rather than asking. `coIndex` is only the
        // cursor on the picker; `company` is the answer, and the Select Company
        // gate reads the answer. Moving the cursor and not the answer put every
        // return trip back on the picker.
        if (resuming && i >= 0) setCompany(cs[i])
      })
      .catch(() => {})
  }, [])
  const cid = company ? Number(company.id) : 0

  const [screen, setScreenState] = useState<Screen>('gateway')

  // ── WHAT THIS USER MAY DO HERE ──────────────────────────────────────────
  // Every voucher type and screen is a User Access row of its own (Accounting
  // · Payment, Accounting · Day Book…) that follows the Accounting row until
  // it is set on its own. The server refuses a write the user lacks either
  // way; this keeps the page from offering what would only be refused, and
  // any section added later is one entry in accessSections.ts plus its line
  // in SCREEN_SECTION above.
  const me = useMemo(() => loadUser(), [])
  const myPerms = useMemo(() => parsePerms(me?.permissions), [me])
  function rightsIn(key: string | null | undefined): Rights {
    if (!key || !me || me.role === 'admin') return ALL_RIGHTS
    return rightsOf(myPerms, key)
  }
  // A voucher type's section; a type outside the six answers to Accounting.
  const vchRights = (t: string): Rights => rightsIn(VOUCHER_SECTION[String(t).toUpperCase()] || 'accounts')
  const vchLabel = (t: string): string => VCH_TYPES.find((x) => x.key === t)?.label || t
  // May key a NEW voucher of this type.
  const mayEnter = (t: VchType): boolean => vchRights(t).create
  const firstVch = (): VchType | null => VCH_TYPES.find((v) => mayEnter(v.key))?.key ?? null
  const mayScreen = (s: Screen): boolean => rightsIn(SCREEN_SECTION[s]).view
  // WHERE A LEDGER WAS OPENED FROM, when that was a screen of its own —
  // Masters, Opening Balances, the Trial Balance. Esc on the statement goes
  // back there rather than all the way out to the Gateway, which is nowhere
  // the desk was. Kept while a voucher is opened from the statement and closed
  // again; let go the moment the desk goes anywhere else.
  //
  // DECLARED ABOVE setScreen, which clears it. Coming back from a
  // drill-through calls setScreen DURING RENDER (the resume block below), and
  // a state declared further down is not there yet at that point — returning
  // to a register from a bill threw "cannot access before initialization" and
  // blanked the page. A ledger never hit it: that path does not clear this.
  const [lgBack, setLgBack] = useState<Screen | null>(null)

  // Every way onto a screen comes through here. A screen the user does not
  // hold lands them on the gateway instead — quietly when it is where a save
  // or a refresh was taking them rather than something they clicked.
  function setScreen(s: Screen, quiet = false): void {
    if (mayScreen(s)) {
      if (s !== 'ledger' && s !== 'voucher') setLgBack(null)
      setScreenState(s)
      return
    }
    if (!quiet) toast.error(`You do not have access to ${SCREEN_LABEL[s]}`)
    setScreenState('gateway')
  }
  const [gwIndex, setGwIndex] = useState(0)
  const [accounts, setAccounts] = useState<Row[]>([])
  // MASTERS AND OPENINGS SHOW THIS COMPANY'S LEDGERS. The list is shared, so
  // the other book's — KR FINMARK's LC PAYABLE - CSB in KR FOODS — used to sit
  // here too. `in_company` comes from the server (journal.ts, listAccounts);
  // "All companies" shows the whole shared list when it is wanted.
  const [ledScopeAll, setLedScopeAll] = useState(false)
  // The chart's groups (moved up from below, so the scope rule can read them).
  const [groupRows, setGroupRows] = useState<Row[]>([])
  // ONLY BANKS AND LENDERS BELONG TO ONE BOOK. Every other ledger — freight,
  // purchases, taxes, parties — and every group is common to both companies
  // and shows in both. A bank account, a loan or an NBFC line, and the LC and
  // bill-discounting ledgers that are a bank's or a lender's facility, are each
  // company's own: those show only where the company has used them.
  const coLedgerIds = useMemo(() => {
    const byName = new Map(groupRows.map((g) => [String(g.name).trim().toUpperCase(), g]))
    const byId = new Map(groupRows.map((g) => [Number(g.id), g]))
    const SCOPED_ROOTS = new Set(['BANK ACCOUNTS', 'LOANS (LIABILITY)'])
    const underScoped = (groupName: unknown): boolean => {
      const nm = String(groupName || '').trim().toUpperCase()
      let g = byName.get(nm)
      // Groups not loaded on this screen: the standard bank and loan groups,
      // and anything named as a loan or an NBFC, by name.
      if (!g) return SCOPED_ROOTS.has(nm) || ['BANK OD A/C', 'SECURED LOANS', 'UNSECURED LOANS'].includes(nm) || /\b(NBFC|LOAN)\b/.test(nm)
      const seen = new Set<number>()
      while (g && !seen.has(Number(g.id))) {
        if (SCOPED_ROOTS.has(String(g.name).trim().toUpperCase())) return true
        seen.add(Number(g.id))
        g = g.parent_id == null ? undefined : byId.get(Number(g.parent_id))
      }
      return false
    }
    const scoped = (a: Row): boolean => underScoped(a.acc_group) || /^(LC PAYABLE|BILLS DISCOUNTED)\b/i.test(String(a.name || '').trim())
    return new Set(accounts.filter((a) => !scoped(a) || Number(a.in_company) === 1).map((a) => Number(a.id)))
  }, [accounts, groupRows])
  // A server not yet restarted sends no in_company — then nothing is narrowed.
  const ledScopeKnown = accounts.some((a) => a.in_company != null)
  // Every group in the books, each knowing where it sits: name, nature, the
  // parent it is under, its depth and its full path. Was a fixed list of
  // twenty-six; it is now whatever the chart of accounts actually holds.
  const [groupNames, setGroupNames] = useState<Row[]>([])

  // Voucher entry / alteration state.
  const [vchType, setVchType] = useState<VchType>('PAYMENT')
  const [vchDate, setVchDate] = useState(todayISO())
  const [vchNo, setVchNo] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<VLine[]>(blankLines('PAYMENT'))
  // Which line's breakdown is open. One at a time: it is a panel under the
  // row, not a column, and two of them push the totals off the screen.
  const [splitOpen, setSplitOpen] = useState(-1)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const dateRef = useRef<HTMLDivElement | null>(null)
  // Tally-format payment/receipt entry state. The money side is a list too —
  // a Payment/Receipt can split across more than one cash/bank account, the
  // same way the party side already allows more than one party.
  const [payAccounts, setPayAccounts] = useState<PayLine[]>([blankPayLine()])
  // Tally-style GST computation for debit/credit notes: taxable + GST% ->
  // GST leg + round off so the party total lands on a whole rupee.
  const [gstCalc, setGstCalc] = useState({ taxable: '', pct: '5', igst: false })
  // Rate-difference helper (Journal only): a later price revision on an
  // already-invoiced purchase/sale, settled through RATE DIFFERENCE A/C
  // rather than reopening the original document.
  const [rateDiffOpen, setRateDiffOpen] = useState(false)
  const [rateDiff, setRateDiff] = useState({ party: '', group: '', amount: '', direction: 'owes_more' as 'owes_more' | 'owes_less' })
  // Tally invoice-mode for Debit/Credit notes: party -> original invoice ->
  // item lines (qty x rate) -> GST + round off, posted through the notes engine.
  const [noteMode, setNoteMode] = useState(true)
  const [noteParty, setNoteParty] = useState('')
  // Whose ledger the note lands in. Independent of the note kind — a credit
  // note to a supplier and a debit note to a customer are both ordinary — so
  // it is chosen rather than inferred from Alt-F5 vs Alt-F6.
  const [notePartyKind, setNotePartyKind] = useState<'supplier' | 'customer' | 'transporter'>('supplier')
  const [noteInvoice, setNoteInvoice] = useState('')
  const [noteGst, setNoteGst] = useState('5')
  const [noteItems, setNoteItems] = useState<{ product_id: string; qty: string; rate: string; amount?: string }[]>([
    { product_id: '', qty: '', rate: '' }
  ])
  // WITH vs WITHOUT quantity, the Tally way. ON: each line is product × qty ×
  // rate and its quantity moves stock on a real return. OFF: each line is a
  // product and a value only — a rate difference / discount / claim — priced by
  // its amount and touching no stock. Defaults ON.
  const [noteWithQty, setNoteWithQty] = useState(true)
  const [noteParties, setNoteParties] = useState<Row[]>([])
  const [noteProducts, setNoteProducts] = useState<Row[]>([])
  // A customer credit note is a sales return, so the quantity can go straight
  // back onto the bargain it was drawn from instead of being re-added by hand
  // through the sales-bargain Adjust dialog.
  const [noteBargain, setNoteBargain] = useState('')
  const [noteBargains, setNoteBargains] = useState<Row[]>([])
  // Narrows the item picker by the product's SUB-CATEGORY — raw, intermediate,
  // finished, by-product, waste — which is the split that matters when picking
  // what came back on a return.
  const [noteSubCat, setNoteSubCat] = useState('ALL')
  const [payLines, setPayLines] = useState<PayLine[]>([blankPayLine()])
  const [rawAlter, setRawAlter] = useState(false)
  // A voucher opened from a ledger or the Day Book that a document owns — a
  // bill, an LC, a sale, a purchase. It is shown on the voucher screen like
  // any other, in full and as posted, but nothing on it can be changed there:
  // the document that wrote it is the only place it may change. Holds the
  // voucher as fetched plus the screen to go back to.
  const [viewOnly, setViewOnly] = useState<Row | null>(null)
  // The website voucher's own furniture: the number the next voucher of this
  // type will take, the number of the one being altered, what the last Accept
  // posted, the window width the layout answers to, the narrow screen's
  // posting drawer, and a note's GST breakdown under its party line.
  const [nextCode, setNextCode] = useState('')
  const [vchCode, setVchCode] = useState('')
  const [postedMsg, setPostedMsg] = useState<string | null>(null)
  const [postedSeq, setPostedSeq] = useState(0)
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1600))
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900))
  const [dockOpen, setDockOpen] = useState(false)
  const [noteSplitOpen, setNoteSplitOpen] = useState(false)
  // GST ON A DEBIT / CREDIT NOTE ENTERED IN THE GRID.
  // Chosen once — the type and the rate — and the tax lines are worked out
  // from the lines above: INPUT for a supplier's note, OUTPUT for a customer's,
  // on the same side as the purchase/sale lines, with the party's figure and
  // the rupee round-off following. The type and rate start from the party's
  // own master (its state and GST %) until somebody picks one by hand.
  const [noteGstType, setNoteGstType] = useState<'none' | 'CGST_SGST' | 'IGST'>('CGST_SGST')
  const [noteGstPct, setNoteGstPct] = useState('')
  const noteGstPicked = useRef(false)
  const partyAutoAmount = useRef('')
  const [gstParties, setGstParties] = useState<{ sup: Row[]; cus: Row[]; map: Row[] } | null>(null)
  const [refsCache, setRefsCache] = useState<Record<string, Row[]>>({})
  // The same parties' bills with nothing left pending — offered only for
  // linking a voucher to (a debit note on a bill already paid), as Tally does.
  const [linkCache, setLinkCache] = useState<Record<string, Row[]>>({})

  // Day book.
  const monthStart = `${todayISO().slice(0, 7)}-01`
  const [dbFrom, setDbFrom] = useState(monthStart)
  const [dbTo, setDbTo] = useState(todayISO())
  // Empty = every voucher type.
  const [dbType, setDbType] = useState<string[]>([])
  const [dayRows, setDayRows] = useState<Row[]>([])
  const [viewRow, setViewRow] = useState<Row | null>(null)
  // Tally's ledger list beside this book's — opened from Masters, which is
  // where the chart of accounts is kept and therefore where it is reconciled.
  const [tallyOpen, setTallyOpen] = useState(false)
  // Tags on the vouchers in view — the day book's rows wear them read-only
  // (the row is itself a button and cannot hold another), and the voucher that
  // is open carries the picker.
  const vchTags = useTagMap(
    'voucher',
    useMemo(
      () => Array.from(new Set([...dayRows.map((r) => Number(r.id)), Number(viewRow?.id) || 0])).filter(Boolean),
      [dayRows, viewRow]
    )
  )
  // Debit/Credit note register — the notes raised through Alt-F5/Alt-F6, which
  // previously had nowhere to be seen or corrected once accepted.
  const [noteRows, setNoteRows] = useState<Row[]>([])
  // Debit and credit notes entered straight on the voucher screen (Alt F5 /
  // Alt F6). They post a DEBIT NOTE / CREDIT NOTE voucher but leave no record
  // in the notes table, so the register used to miss them while the gateway —
  // which counts vouchers — did not. Website register only.
  const [noteVchRows, setNoteVchRows] = useState<Row[]>([])
  const [noteRowItems, setNoteRowItems] = useState<Record<number, Row[]>>({})
  const [noteOpen, setNoteOpen] = useState<number | null>(null)
  // Back from a bill or invoice opened off a register: that register's
  // filters as they were left (see RegMemo). Read once, on the way in.
  const regBack = useRef<RegMemo | null | undefined>(undefined)
  if (regBack.current === undefined) {
    regBack.current = resume?.screen && regMemo && regMemo.screen === resume.screen ? regMemo : null
  }
  useEffect(() => {
    regMemo = null
  }, [])
  const [noteKindFilter, setNoteKindFilter] = useState<'all' | 'debit' | 'credit'>(() => regBack.current?.noteKind ?? (__WEB__ ? 'debit' : 'all'))
  // On the website the Debit Notes and Credit Notes registers are separate, so
  // the notes screen always shows one kind — reaching it any other way lands
  // on Debit Notes.
  useEffect(() => {
    if (__WEB__ && noteKindFilter === 'all') setNoteKindFilter('debit')
  }, [noteKindFilter])
  // Transporter freight registers — one per side. Freight accrues to a control
  // account when the goods move and only reaches the transporter's own ledger
  // when their (usually monthly, multi-tanker) bill is entered here.
  const [tfRows, setTfRows] = useState<Row[]>([])
  const [tfKpi, setTfKpi] = useState<Row | null>(null)
  const [tfState, setTfState] = useState<'all' | 'unbilled' | 'billed'>('unbilled')
  const [tfFrom, setTfFrom] = useState('')
  const [tfTo, setTfTo] = useState('')
  const [tfPicked, setTfPicked] = useState<number[]>([])
  const [tfPickBy, setTfPickBy] = useState<'tanker' | 'invoice'>('tanker')
  const [tfBillOpen, setTfBillOpen] = useState(false)
  // WHICH BOOKED LINE IS OPEN, AND WHAT ITS BILL STILL OWES.
  //
  // The three figures under a booked row are the transporter's own ledger
  // answering — bill amount, paid, pending — because paying a transporter is a
  // voucher like any other and this register must not invent a second answer
  // to it. Cached by transporter: a bill covers several lines and a month of
  // freight is a handful of parties.
  const [tfBillRow, setTfBillRow] = useState(0)
  const [tfBillWise, setTfBillWise] = useState<Record<string, Row[]>>({})
  const [tfBill, setTfBill] = useState<Row>({ bill_no: '', bill_date: todayISO(), gst_pct: '5', tds_pct: '', adjustment: '', adjustment_note: '', note: '', others_amount: '', others_ledger: '', others_note: '' })
  const [tfSaving, setTfSaving] = useState(false)
  const [nrFrom, setNrFrom] = useState(() => regBack.current?.nrFrom ?? '')
  const [nrTo, setNrTo] = useState(() => regBack.current?.nrTo ?? '')
  const [nrSearch, setNrSearch] = useState(() => regBack.current?.nrSearch ?? '')
  // Set while altering a posted note: the save path updates that note in
  // place (reversing and re-posting it) instead of raising a new one.
  const [noteEditId, setNoteEditId] = useState<number | null>(null)

  // Ledger screen.
  const [ledgerId, setLedgerId] = useState<number | null>(null)

  // Coming back from a drill-through: put the page where it was. Done before
  // anything paints, so the Gateway never flashes, and consumed immediately so
  // a later manual visit starts fresh.
  const resumedRef = useRef(false)
  // The company to restore once the company list has loaded — it arrives after
  // the resume does, so the index cannot be set on the spot.
  const pendingCoRef = useRef<number | null>(null)
  // The voucher to open again once the book is chosen (see the effect below).
  const pendingVoucherRef = useRef<number | null>(null)
  if (resume && !resumedRef.current) {
    resumedRef.current = true
    if (resume.voucherId) pendingVoucherRef.current = Number(resume.voucherId)
    if (resume.screen) setScreen(resume.screen as Screen, true)
    if (resume.ledgerId != null) setLedgerId(resume.ledgerId)
    // Come back to the book the ledger was being read in, not to whichever the
    // drill-through left the app working in.
    if (resume.companyId != null) pendingCoRef.current = Number(resume.companyId)
  }
  useEffect(() => {
    if (resumedRef.current) onResumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [ledgerLines, setLedgerLines] = useState<Row[]>([])
  const [ledgerSearch, setLedgerSearch] = useState('')
  const ledgerSearchRef = useRef<HTMLInputElement>(null)
  // The list's own search, which is a different box from the picker's.
  const lgListSearchRef = useRef<HTMLInputElement>(null)
  // Keyboard walk of the ledger list: type to narrow, arrows to move, Enter to
  // open. The cursor is an INDEX into the filtered list rather than an id, so
  // narrowing the search always leaves it on a row that exists.
  const [lgCursor, setLgCursor] = useState(0)
  // Tally's way: the list is not a permanent column stealing a third of the
  // screen, it is a picker you call up, choose from and dismiss. The statement
  // then gets the whole width — which is what anyone is actually reading.
  const [lgPickerOpen, setLgPickerOpen] = useState(false)
  // The balance rail — closing balance, where it moved, voucher mix — the same
  // way: folded away so the register has the whole width, and called up over
  // it from the right (F8 or Summary) the way the list comes in from the left.
  // Every figure on it is also in the header line and the foot of the table.
  const [lgRailOpen, setLgRailOpen] = useState(false)
  // The registers' summary — the four tiles and the note on what the register
  // is — called up over the table the same way (F8 or Summary), so the table
  // itself has the whole screen.
  const [regSumOpen, setRegSumOpen] = useState(false)
  // A purchase or sale opened in its register to show its ledger entries, the
  // way a ledger row opens to show its voucher's lines — and what each one's
  // document put in the books, read once and kept while the register is up.
  const [regOpenRow, setRegOpenRow] = useState<string | null>(() => regBack.current?.openRow ?? null)
  const [regPost, setRegPost] = useState<Record<string, Row | 'loading'>>(() => {
    // A row's entries still being read when the desk left would never finish.
    const p = { ...(regBack.current?.post || {}) }
    for (const k of Object.keys(p)) if (p[k] === 'loading') delete p[k]
    return p
  })
  // The register's scroll box, and where to put it back to once its rows are in.
  const regScrollEl = useRef<HTMLDivElement | null>(null)
  const regScrollTo = useRef<number | null>(regBack.current?.scrollTop ?? null)
  const lgItemRefs = useRef<(HTMLDivElement | null)[]>([])
  // Back from a document opened off this ledger: the view it was read in, and
  // on bill-wise the bill that was open (see LgMemo). Only for the same ledger.
  const lgReturn = useRef<LgMemo | null | undefined>(undefined)
  if (lgReturn.current === undefined) {
    lgReturn.current = resume?.screen === 'ledger' && lgMemo && lgMemo.ledgerId === (resume.ledgerId ?? null) ? lgMemo : null
  }
  useEffect(() => {
    lgMemo = null
  }, [])
  // The desktop drops its bills view whenever the ledger changes; coming back
  // to the same ledger is not a change, once.
  const lgKeepBillsFor = useRef<number | null | undefined>(lgReturn.current?.bills ? lgReturn.current.ledgerId : undefined)
  // Tally's Bills Outstanding for the open ledger: F5 while a party is
  // selected. A sub-view of the ledger rather than a screen of its own, so Esc
  // drops back to the statement it was opened from.
  const [lgBills, setLgBills] = useState(() => !!lgReturn.current?.bills)
  const [bills, setBills] = useState<Row | null>(null)
  const [lgFrom, setLgFrom] = useState('')
  const [lgTo, setLgTo] = useState('')
  const [lgMonthly, setLgMonthly] = useState(() => !!lgReturn.current?.monthly)
  const [lgDetailed, setLgDetailed] = useState(() => !!lgReturn.current?.detailed)
  // FOUR WAYS OF READING ONE STATEMENT.
  //
  // The desktop keeps three independent flags — monthly, detailed, bills —
  // which can all be on at once and mean nothing together. They are one
  // question with four answers, so the website asks it once and sets the old
  // flags from the answer: the loaders below still watch `lgBills`, and the
  // desktop screen is untouched.
  type LgView = 'vouchers' | 'monthly' | 'columnar' | 'billwise'
  const [lgView, setLgViewRaw] = useState<LgView>(() => lgReturn.current?.view ?? 'vouchers')
  const [lgCondensed, setLgCondensed] = useState(() => !!lgReturn.current?.condensed)
  const [lgMonOpen, setLgMonOpen] = useState<Record<string, boolean>>({})
  // The website ledger's own: the voucher row opened to show its lines, the
  // register's search and type filter, and the order the list is drawn in —
  // which is the order ↑ and ↓ walk from anywhere on the screen.
  const [lgOpenRow, setLgOpenRow] = useState<number | null>(null)
  const lgOpenRowRef = useRef<number | null>(null)
  lgOpenRowRef.current = lgOpenRow
  const [lgFQuery, setLgFQuery] = useState('')
  const [lgFTypes, setLgFTypes] = useState<string[]>([])
  const lgOrderRef = useRef<number[]>([])
  const setLgView = useCallback((v: LgView) => {
    setLgViewRaw(v)
    setLgBills(v === 'billwise')
    setLgMonthly(v === 'monthly')
    setLgDetailed(v === 'columnar')
  }, [])

  // THE ADDRESS BAR KNOWS WHERE YOU ARE IN ACCOUNTING (website).
  //
  // The page itself was always in the URL (/accounts), but everything inside
  // it — the company, the screen, the ledger, how it is being read, the
  // voucher open — lived in memory, so a refresh put everybody back on Select
  // Company. It is written into the query now (/accounts?co=1&s=ledger&l=9171
  // &v=columnar) and read back once on the way in, through the same restore a
  // drill-through return uses. replaceState, not pushState: moving about
  // inside Accounting should not fill the browser's Back button with steps.
  // An unsaved voucher's lines are not in the URL — only which voucher it is.
  const ACCT_SCREENS: Screen[] = ['gateway', 'voucher', 'daybook', 'ledger', 'trial', 'purchreg', 'salesreg', 'notesreg', 'tfpur', 'tfsal', 'openings', 'masters', 'cashflow', 'payreg']
  const urlVoucher = useRef<{ t: string; id: number } | null>(null)
  const urlRead = useRef(false)
  if (__WEB__ && !urlRead.current) {
    urlRead.current = true
    if (!resume && window.location.pathname.replace(/\/+$/, '') === '/accounts') {
      const q = new URLSearchParams(window.location.search)
      const co = Number(q.get('co'))
      const sc = String(q.get('s') || '') as Screen
      if (co > 0) {
        pendingCoRef.current = co
        if (ACCT_SCREENS.includes(sc) && sc !== 'voucher') setScreen(sc, true)
        const l = Number(q.get('l'))
        if (l > 0) setLedgerId(l)
        const v = String(q.get('v') || '') as LgView
        if (['vouchers', 'monthly', 'columnar', 'billwise'].includes(v)) setLgView(v)
        if (sc === 'voucher') {
          urlVoucher.current = { t: String(q.get('t') || ''), id: Number(q.get('id')) || 0 }
          // Opened from a ledger: stand on that ledger first, so Esc from the
          // voucher goes back to it, as it did before the refresh.
          if (q.get('from') === 'ledger' && l > 0) setScreen('ledger', true)
        }
      }
    }
  }

  // Trial balance.
  // Which groups are open on the trial balance. Closed to begin with: the
  // question it is opened for is "do the books agree", and ten groups of
  // ledgers unrolled is the answer to a different one.
  const [tbOpen, setTbOpen] = useState<Record<string, boolean>>({})
  const [tbFrom, setTbFrom] = useState('')
  const [tbTo, setTbTo] = useState(todayISO())
  const [tb, setTb] = useState<Row | null>(null)

  // New-ledger dialog (from the picker or the ledger list).
  const [newLedger, setNewLedger] = useState<{ name: string; group: string; forLine: number | null; target?: 'payLine' | 'payAccount'; index?: number } | null>(null)

  // Purchase / sales registers — the plain "what did we buy and sell, and how
  // was it funded" view. Deliberately document-level, not ledger-level.
  const [purchases, setPurchases] = useState<Row[]>([])
  const [saleRows, setSaleRows] = useState<Row[]>([])
  const [lcList, setLcList] = useState<Row[]>([])
  const [regFrom, setRegFrom] = useState(() => regBack.current?.regFrom ?? '')
  const [regTo, setRegTo] = useState(() => regBack.current?.regTo ?? '')
  const [regSearch, setRegSearch] = useState(() => regBack.current?.regSearch ?? '')
  // Excel-style funnels on the columns of every Accounting table (lib/colFilters).
  const colF = useColFilterStore()
  // THE WEB DAY BOOK'S OWN VIEW (daybookWeb): which half, the search and what
  // it looks at, the type chips, density, the voucher open in the drawer and
  // where the summary panel is anchored.
  const [dbTab, setDbTab] = useState<'vch' | 'gate'>('vch')
  const [dbQuery, setDbQuery] = useState('')
  const [dbField, setDbField] = useState(0)
  const [dbTypes, setDbTypes] = useState<string[]>([])
  const [dbDense, setDbDense] = useState(false)
  const [dbSel, setDbSel] = useState<number | null>(null)
  const [dbSum, setDbSum] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null)
  const dbVisRef = useRef<Row[]>([])
  const dbScrollRef = useRef<HTMLDivElement>(null)
  const dbSumBtnRef = useRef<HTMLButtonElement>(null)
  // 'all' | 'lc' (funded by an LC) | 'nolc' (not tagged to any LC)
  // Empty = both — checking neither/both funding types is the same as "all".
  const [regFunding, setRegFunding] = useState<string[]>(() => regBack.current?.regFunding ?? [])
  // Tag-a-purchase-to-an-LC dialog.
  const [tagForm, setTagForm] = useState<Row | null>(null)
  // Books beginning from, and the opening balance each ledger was given as at
  // that date. Everything before the cutoff is excluded from the ledger and
  // these figures stand in its place — so they are not a convenience, they are
  // the only record of where the business stood when the books opened.
  const [obRows, setObRows] = useState<Row[]>([])
  const [obFrom, setObFrom] = useState('')
  const [obEdit, setObEdit] = useState<Record<number, { dr: string; cr: string }>>({})
  const [obQuery, setObQuery] = useState('')
  const [obSaving, setObSaving] = useState(false)
  const [obOnlySet, setObOnlySet] = useState(false)
  // MOVING OPENINGS TO THE OTHER COMPANY — for figures entered in the wrong
  // book. Ledgers are ticked here, the move is previewed (what goes, what the
  // other company already has, what it will have) and then done in one go.
  const [obPicked, setObPicked] = useState<Set<number>>(() => new Set())
  const [obMoveTo, setObMoveTo] = useState(0)
  const [obMove, setObMove] = useState<{ to: number; target: Row[] | null; saving: boolean } | null>(null)
  useEffect(() => {
    setObPicked(new Set())
    setObMove(null)
    setObMoveTo(0)
  }, [cid])
  // What the last save did, for the sheet's footer; and which figure box is
  // being typed in — that one shows raw digits, the rest are grouped.
  const [obSavedNote, setObSavedNote] = useState('')
  const [obFocus, setObFocus] = useState<string | null>(null)

  // `clear` drops what has been typed and not saved — only after a save. A
  // reload for any other reason (coming back to the screen, moving the start
  // date, the website's tab between the chart and this sheet) keeps it, so a
  // half-entered sheet is not lost to a tab switch.
  const loadOpenings = useCallback(async (clear = false): Promise<void> => {
    try {
      const r = await window.api.journal.openings(cid || undefined)
      setObRows((r.rows as Row[]) || [])
      setObFrom(String(r.books_from || ''))
      if (clear) setObEdit({})
    } catch (e) {
      toast.error(errText(e))
    }
  }, [cid])

  useEffect(() => {
    // The website's chart tab counts how many ledgers have an opening, so it
    // reads the sheet too.
    if (screen === 'openings' || (__WEB__ && screen === 'masters')) void loadOpenings()
  }, [screen, loadOpenings])
  // Openings are per company while ledgers are shared, so a figure typed for
  // one book must never ride along into another's save.
  useEffect(() => {
    setObEdit({})
    setObSavedNote('')
  }, [cid])

  // What is typed wins over what is stored, so the difference moves as you go
  // rather than only after a save.
  const obLive = useMemo(() => {
    const rows: Row[] = obRows.map((r): Row => {
      const e = obEdit[Number(r.id)]
      return {
        ...r,
        dr: e ? Number(e.dr || 0) || 0 : Number(r.dr || 0),
        cr: e ? Number(e.cr || 0) || 0 : Number(r.cr || 0)
      }
    })
    const dr = rows.reduce((t, r) => t + Number(r.dr || 0), 0)
    const cr = rows.reduce((t, r) => t + Number(r.cr || 0), 0)
    return { rows, dr, cr, difference: Math.round((dr - cr) * 100) / 100 }
  }, [obRows, obEdit])

  const obVisible = useMemo(() => {
    const q = obQuery.trim().toUpperCase()
    return obLive.rows.filter((r) => {
      // Another company's ledger is not this book's to open — unless it already
      // carries an opening here, which is then shown so it can be seen to.
      const hasFigure = Math.abs(Number(r.dr || 0)) >= 0.005 || Math.abs(Number(r.cr || 0)) >= 0.005
      if (!ledScopeAll && ledScopeKnown && !hasFigure && !coLedgerIds.has(Number(r.id))) return false
      if (obOnlySet && !hasFigure) return false
      if (!q) return true
      return String(r.name || '').toUpperCase().includes(q) || String(r.acc_group || '').toUpperCase().includes(q)
    })
  }, [obLive, obQuery, obOnlySet, ledScopeAll, ledScopeKnown, coLedgerIds])

  async function saveOpenings(): Promise<void> {
    if (!rightsIn('accountsOpenings').edit) return void toast.error('You do not have rights to change Opening Balances')
    const rows = Object.entries(obEdit).map(([id, v]) => ({
      account_id: Number(id),
      dr: Number(v.dr || 0) || 0,
      cr: Number(v.cr || 0) || 0
    }))
    if (!rows.length) return void toast.message('Nothing changed')
    setObSaving(true)
    try {
      await window.api.journal.saveOpenings(rows, cid || undefined)
      toast.success(`Saved ${rows.length} opening balance${rows.length === 1 ? '' : 's'}`)
      setObSavedNote(`Saved ${rows.length} opening balance${rows.length === 1 ? '' : 's'}`)
      await loadOpenings(true)
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setObSaving(false)
    }
  }

  async function saveBooksFrom(v: string): Promise<void> {
    if (!rightsIn('accountsOpenings').edit) return void toast.error('You do not have rights to change Opening Balances')
    try {
      await window.api.journal.setBooksFrom(v || null, cid || undefined)
      setObFrom(v)
      toast.success(v ? `Books now begin on ${formatDate(v)}` : 'Books run from the beginning')
      await loadOpenings()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const dObSigned = (v: number): string => (Math.abs(v) < 0.005 ? '—' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`)
  const dObCf = colFilter<Row>(colF, 'd:openings', obVisible, [
    { key: 'ledger', get: (r) => r.name },
    { key: 'under', get: (r) => r.acc_group },
    { key: 'dr', get: (r) => (n(r.dr) > 0.004 ? formatINR(n(r.dr)) : '—'), sort: 'num' },
    { key: 'cr', get: (r) => (n(r.cr) > 0.004 ? formatINR(n(r.cr)) : '—'), sort: 'num' },
    { key: 'since', get: (r) => dObSigned(n(r.movement)), sort: 'num' },
    { key: 'before', get: (r) => dObSigned(n(r.before_cutoff)), sort: 'num' }
  ])
  const dObRows = dObCf.rows
  const openingsScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Opening Balances</span>
          <div className="flex items-center gap-2 text-[11px]">
            <span>Books beginning from</span>
            <div className="w-40">
              <DatePicker value={obFrom} onChange={(v) => void saveBooksFrom(v)} />
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              value={obQuery}
              onChange={(e) => setObQuery(e.target.value)}
              placeholder="Find a ledger…"
              className="h-9 w-52 bg-white text-xs"
            />
            <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px]">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={obOnlySet}
                onChange={(e) => setObOnlySet(e.target.checked)}
              />
              Only with a figure
            </label>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px]" title="Show the ledgers of every company, not only this one's">
              <input type="checkbox" className="h-3.5 w-3.5" checked={ledScopeAll} onChange={(e) => setLedScopeAll(e.target.checked)} />
              All companies
            </label>
            {/* Tally calls this "Difference in opening balances". It stays on
                screen until it is nil, because a difference is not an error to
                tuck away — it is the part of the opening position not yet
                accounted for. */}
            <span
              className={cn(
                'rounded px-2 py-1 text-[11.5px] font-semibold tabular-nums',
                Math.abs(obLive.difference) < 0.005
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-200 text-amber-900'
              )}
              title={
                Math.abs(obLive.difference) < 0.005
                  ? 'Debits and credits agree'
                  : 'Debits and credits do not agree — this is what is still unaccounted for'
              }
            >
              {Math.abs(obLive.difference) < 0.005
                ? 'Balanced'
                : `Difference ${formatINR(Math.abs(obLive.difference))} ${obLive.difference > 0 ? 'Dr' : 'Cr'}`}
            </span>
            <Button
              size="sm"
              className="h-9 bg-[#0B3D2E] text-xs font-semibold text-white hover:bg-[#0A3327]"
              disabled={obSaving || !Object.keys(obEdit).length}
              onClick={() => void saveOpenings()}
            >
              {obSaving ? 'Saving…' : `Save${Object.keys(obEdit).length ? ` (${Object.keys(obEdit).length})` : ''}`}
            </Button>
          </div>
        </div>

        {!obFrom && (
          <div className="border-b bg-amber-50 px-4 py-2 text-[11.5px] text-amber-900" style={{ borderColor: '#DCE7DB' }}>
            No start date is set, so the ledgers show every entry ever made and these figures are ignored. Set{' '}
            <b>Books beginning from</b> above to bring them into effect.
          </div>
        )}

        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-[#EAF0E9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">{dObCf.head('ledger', 'Ledger')}</th>
                <th className="px-2 py-1.5">{dObCf.head('under', 'Under')}</th>
                <th className="border-l px-2 py-1.5 text-right" style={{ borderColor: '#C3D2C6' }}>
                  {dObCf.head('dr', 'Opening Dr', { align: 'end' })}
                </th>
                <th className="px-2 py-1.5 text-right">{dObCf.head('cr', 'Opening Cr', { align: 'end' })}</th>
                <th
                  className="border-l px-2 py-1.5 text-right"
                  style={{ borderColor: '#C3D2C6' }}
                  title="What this ledger has recorded from the start date onward"
                >
                  {dObCf.head('since', 'Since start', { align: 'end' })}
                </th>
                <th
                  className="px-3 py-1.5 text-right"
                  title="What this ledger holds BEFORE the start date — excluded from the books, and what your opening figure stands in for"
                >
                  {dObCf.head('before', 'Before start', { align: 'end' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {dObRows.map((r) => {
                const id = n(r.id)
                const e = obEdit[id]
                const before = n(r.before_cutoff)
                const moved = n(r.movement)
                const drVal = e ? e.dr : n(r.dr) ? String(r.dr) : ''
                const crVal = e ? e.cr : n(r.cr) ? String(r.cr) : ''
                return (
                  <tr key={id} className="border-b hover:bg-amber-50/60" style={{ borderColor: '#DCE7DB' }}>
                    <td className="whitespace-nowrap px-4 py-1 font-medium">{String(r.name)}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-[11.5px] text-muted-foreground">
                      {String(r.acc_group || '')}
                    </td>
                    <td className="border-l px-2 py-1 text-right" style={{ borderColor: '#C3D2C6' }}>
                      <Input
                        inputMode="decimal"
                        className="ml-auto h-7 w-32 bg-white text-right text-[12px] tabular-nums"
                        value={drVal}
                        placeholder="—"
                        onChange={(ev) => setObEdit((prev) => ({ ...prev, [id]: { dr: ev.target.value, cr: crVal } }))}
                      />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Input
                        inputMode="decimal"
                        className="ml-auto h-7 w-32 bg-white text-right text-[12px] tabular-nums"
                        value={crVal}
                        placeholder="—"
                        onChange={(ev) => setObEdit((prev) => ({ ...prev, [id]: { dr: drVal, cr: ev.target.value } }))}
                      />
                    </td>
                    <td
                      className="whitespace-nowrap border-l px-2 py-1 text-right tabular-nums text-muted-foreground"
                      style={{ borderColor: '#C3D2C6' }}
                    >
                      {Math.abs(moved) < 0.005 ? '—' : `${formatINR(Math.abs(moved))} ${moved > 0 ? 'Dr' : 'Cr'}`}
                    </td>
                    {/* The strongest hint the screen can give: what the
                        pre-cutoff entries add up to, which is usually close to
                        the opening figure that belongs beside it. */}
                    <td
                      className={cn(
                        'whitespace-nowrap px-3 py-1 text-right tabular-nums',
                        Math.abs(before) > 0.005 ? 'font-medium text-sky-700' : 'text-muted-foreground'
                      )}
                    >
                      {Math.abs(before) < 0.005 ? '—' : `${formatINR(Math.abs(before))} ${before > 0 ? 'Dr' : 'Cr'}`}
                    </td>
                  </tr>
                )
              })}
              {!dObRows.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    No ledger matches.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="sticky bottom-0 bg-[#EAF0E9] font-semibold text-[#0B3D2E]">
              <tr className="border-t-2" style={{ borderColor: '#D6E2D6' }}>
                <td className="px-4 py-1.5" colSpan={2}>
                  Total
                </td>
                <td className="border-l px-2 py-1.5 text-right tabular-nums" style={{ borderColor: '#C3D2C6' }}>
                  {formatINR(obLive.dr)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(obLive.cr)}</td>
                <td className="border-l px-2 py-1.5" style={{ borderColor: '#C3D2C6' }} />
                <td className="px-3 py-1.5" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )

  // Alt+F2 broadcasts a period from anywhere — every date-filtered tab here
  // (Day Book, Ledger, Trial Balance, registers) adopts it.
  const globalRange = useGlobalDateRange()
  const regKeepDates = useRef(!!regBack.current)
  useEffect(() => {
    // Coming back to a register keeps the dates it was left on; any later
    // change of period applies as usual.
    const keepReg = regKeepDates.current
    regKeepDates.current = false
    if (!globalRangeAppliesTo(globalRange, 'accounts')) return
    setDbFrom(globalRange.from); setDbTo(globalRange.to)
    setLgFrom(globalRange.from); setLgTo(globalRange.to)
    setTbFrom(globalRange.from); setTbTo(globalRange.to)
    if (!keepReg) {
      setRegFrom(globalRange.from); setRegTo(globalRange.to)
    }
    // The freight workings, which were left off this list and so answered for
    // a period of their own while the header stated another.
    setTfFrom(globalRange.from); setTfTo(globalRange.to)
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadRegisters = useCallback(async () => {
    const [o, s, l] = await Promise.all([
      window.api.orders.list('accounts'),
      window.api.sales.list(undefined, 'accounts'),
      window.api.lc.list()
    ])
    setPurchases(o)
    setSaleRows(s)
    setLcList(l)
  }, [])

  const loadAccounts = useCallback(async () => {
    if (!cid) return
    setAccounts(await window.api.journal.accounts(cid))
  }, [cid])
  useEffect(() => {
    loadAccounts()
    window.api.journal.groupNames().then(setGroupNames).catch(() => {})
  }, [loadAccounts])
  useLiveRefresh(loadAccounts)

  // ── MASTERS ───────────────────────────────────────────────────────────
  //
  // The chart of accounts, as a tree that can be added to. Groups used to be a
  // fixed list of twenty-six names; they are rows now, each sitting UNDER
  // another to whatever depth the books want — see src/main/ledgerGroups.ts.
  const [mSearch, setMSearch] = useState('')
  const [mOpen, setMOpen] = useState<Record<number, boolean>>({})
  // Ledgers ticked in Masters, to move to another group together, and where.
  const [mPicked, setMPicked] = useState<Set<number>>(new Set())
  const [mMoving, setMMoving] = useState(false)
  // Hidden ledgers are left out of the chart's list unless asked for.
  const [mShowHidden, setMShowHidden] = useState(false)
  // A new group, or a new ledger — the same dialog, because the only thing
  // that differs is which of the two it makes, and both need a name and an
  // Under.
  const [mNew, setMNew] = useState<{ kind: 'group' | 'ledger'; name: string; under: string; nature: string } | null>(null)
  // Renaming a group, or moving either a group or a ledger to another Under.
  const [mEdit, setMEdit] = useState<
    { kind: 'group' | 'ledger'; id: number; name: string; act: 'rename' | 'move'; under: string } | null
  >(null)
  // Where the app's own postings are addressed to a name other than the
  // ledger's own — written whenever a ledger is renamed, so the next posting
  // follows it. Shown on the row so a redirect is never invisible.
  const [ledMap, setLedMap] = useState<Row[]>([])
  const [mBusy, setMBusy] = useState(false)
  // The website's one form for the chart — new, rename or move, a group or a
  // ledger — as a drawer beside the tree rather than a dialog over it. The
  // old* fields are what it was when opened, so the form can say when nothing
  // would change.
  type MDrawer = {
    kind: 'group' | 'ledger'
    act: 'new' | 'rename' | 'move'
    id: number | null
    name: string
    oldName: string
    under: string
    oldUnder: string
    nature: string
    oldNature: string
    find: string
    // Several ticked ledgers moved together — the same drawer, the same tree.
    ids?: number[]
  }
  const [mDrawer, setMDrawer] = useState<MDrawer | null>(null)
  // Esc closes it — through the drawer hook, since the page's own key handler
  // stands aside while any dialog is up.
  const mDrawerRef = useRef<HTMLDivElement>(null)
  const closeMDrawer = useCallback(() => setMDrawer(null), [])
  // Esc on it: closes at once when nothing was changed; with a name typed or
  // a group picked, the first Esc says so and a second discards.
  const mDrawerLive = useRef(mDrawer)
  mDrawerLive.current = mDrawer
  const escMDrawer = useCallback(() => {
    const d = mDrawerLive.current
    const dirty = !!d && (d.name.trim() !== d.oldName.trim() || d.under !== d.oldUnder)
    if (!escMayDiscard(dirty)) return false
    setMDrawer(null)
    return true
  }, [])
  useDrawerEscape(!!mDrawer, mDrawerRef, escMDrawer)
  const openMDrawer = (o: { kind: MDrawer['kind']; act: MDrawer['act']; id?: number; name?: string; under?: string; nature?: string }): void =>
    setMDrawer({
      kind: o.kind,
      act: o.act,
      id: o.id ?? null,
      name: o.name || '',
      oldName: o.name || '',
      under: o.under || '',
      oldUnder: o.under || '',
      nature: o.nature || '',
      oldNature: o.nature || '',
      find: ''
    })
  // Whether the books agree, for the chart's rail.
  const [mTb, setMTb] = useState<Row | null>(null)

  // Which side of the books a group name falls on. Read from the chart itself,
  // so a group somebody created this morning under CURRENT ASSETS colours as an
  // asset rather than dropping to neutral.
  const natureOfGroup = useCallback(
    (name: string): string =>
      String(groupNames.find((g) => String(g.name) === String(name || ''))?.nature || ''),
    [groupNames]
  )

  // Whether a voucher line is a tax — its ledger sits under Duties & Taxes (or
  // a group made inside it), or is named like one: a TDS RECEIVABLE is often
  // kept under Loans & Advances. A party or a bank is never one, whatever its
  // name says. The ledger's own group is looked up when the line does not carry it.
  const accGroupByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of accounts) m.set(String(a.name), String(a.acc_group || ''))
    return m
  }, [accounts])
  const isTaxLine = useCallback(
    (account: string, group?: string): boolean => {
      const g = String(group || accGroupByName.get(account) || '')
      if (g === 'Duties & Taxes') return true
      if (String(groupNames.find((x) => String(x.name) === g)?.path || '').includes('Duties & Taxes')) return true
      if (isBillwise(g) || CASH_BANK_GROUPS.includes(g)) return false
      return TAX_NAME.test(account)
    },
    [accGroupByName, groupNames]
  )

  const loadGroups = useCallback(async () => {
    if (!cid) return
    const [tree, names, map] = await Promise.all([
      window.api.journal.groupTree(cid),
      window.api.journal.groupNames(),
      window.api.journal.ledgerMap(cid).catch(() => [] as Row[])
    ])
    GROUP_BASE = new Map(names.map((g) => [String(g.name), String(g.base || g.name)]))
    setGroupRows(tree)
    setGroupNames(names)
    setLedMap(map)
  }, [cid])
  useEffect(() => {
    // Openings too on the website — its tab strip counts the groups.
    if (screen === 'masters' || screen === 'gateway' || (__WEB__ && (screen === 'openings' || screen === 'tfpur' || screen === 'tfsal'))) void loadGroups()
  }, [screen, loadGroups])
  useEffect(() => {
    if (!__WEB__ || screen !== 'masters' || !cid) return
    let dead = false
    window.api.journal
      .trialBalance({ from: tbFrom || undefined, to: tbTo || undefined, companyId: cid })
      .then((t) => !dead && setMTb(t))
      .catch(() => !dead && setMTb(null))
    return () => {
      dead = true
    }
  }, [screen, cid, tbFrom, tbTo])

  const loadDaybook = useCallback(async () => {
    if (screen !== 'daybook' || !cid) return
    setDayRows(
      await window.api.vouchers.list({
        from: dbFrom || undefined,
        to: dbTo || undefined,
        vchType: !__WEB__ && dbType.length ? dbType : undefined,
        companyId: cid
      })
    )
  }, [screen, dbFrom, dbTo, dbType, cid])
  useEffect(() => {
    loadDaybook()
  }, [loadDaybook])
  useLiveRefresh(loadDaybook)

  const onRegister = screen === 'purchreg' || screen === 'salesreg' || screen === 'notesreg'
  useEffect(() => {
    if (onRegister) void loadRegisters()
  }, [onRegister, loadRegisters])
  const refreshRegisters = useCallback(async () => {
    if (onRegister) await loadRegisters()
  }, [onRegister, loadRegisters])
  useLiveRefresh(refreshRegisters)

  // The statement no longer carries anything dated before the books begin, so
  // the entered opening has to come alongside it — otherwise the ledger would
  // start from nil and understate the party by whatever was brought forward.
  const [lgOpening, setLgOpening] = useState(0)
  const [lgBooksFrom, setLgBooksFrom] = useState('')
  const loadLedger = useCallback(async () => {
    if (screen !== 'ledger' || !ledgerId || !cid) return
    const [lines, ob] = await Promise.all([
      window.api.journal.statement(ledgerId, cid),
      window.api.journal.opening(ledgerId, cid).catch(() => ({ opening: 0, books_from: '' }))
    ])
    setLedgerLines(lines)
    setLgOpening(Number((ob as Row).opening) || 0)
    setLgBooksFrom(String((ob as Row).books_from || ''))
  }, [screen, ledgerId, cid])
  useEffect(() => {
    loadLedger()
  }, [loadLedger])
  useLiveRefresh(loadLedger)

  const ledgerSide: 'customer' | 'supplier' | undefined = (() => {
    const g = baseGroup(accounts.find((a2) => Number(a2.id) === ledgerId)?.acc_group)
    return g === 'Sundry Debtors' ? 'customer' : g === 'Sundry Creditors' ? 'supplier' : undefined
  })()
  const loadBills = useCallback(async () => {
    const nm = String(accounts.find((a2) => Number(a2.id) === ledgerId)?.name || '')
    if (!lgBills || !nm || !cid) return
    const g = baseGroup(accounts.find((a2) => Number(a2.id) === ledgerId)?.acc_group)
    const side = g === 'Sundry Debtors' ? 'customer' : g === 'Sundry Creditors' ? 'supplier' : undefined
    try {
      setBills(await window.api.journal.billsOutstanding(nm, cid, { asOf: lgTo || undefined, side }))
    } catch {
      setBills(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lgBills, ledgerId, cid, lgTo, accounts])
  useEffect(() => {
    void loadBills()
  }, [loadBills])
  // Switching party closes the bills view — its figures belonged to the old one.
  useEffect(() => {
    setLgOpenRow(null)
    // On the website the chosen view stays with the next ledger, bill-wise
    // included — the old ledger's bills are cleared and the new one's read.
    if (__WEB__) setBills(null)
    else if (lgKeepBillsFor.current !== undefined && lgKeepBillsFor.current === ledgerId) lgKeepBillsFor.current = undefined
    else setLgBills(false)
  }, [ledgerId])

  // Landing on Ledgers, the first thing anyone does is name a ledger — so the
  // picker opens itself when nothing is chosen yet. With one already open the
  // screen stays on the statement, which is what you came back for.
  useEffect(() => {
    if (screen !== 'ledger') return
    // THE PICKER IS THE DESKTOP APP'S, AND ONLY ITS.
    //
    // The website keeps the ledger list permanently down the left instead —
    // a modal there hid the statement you were comparing against, which is
    // why it was replaced. But this still raised the flag on both, and on the
    // website that opened nothing at all while telling the list's own focus
    // to stand down (see the effect below, which bails while the picker is
    // up). The result was a Ledgers screen that focused neither box.
    //
    // Resumed onto a ledger already: show the statement, not the picker. With
    // nothing chosen yet the picker comes up first — on the website too, where
    // the list is now a called-up overlay rather than a permanent column.
    if (!ledgerId) setLgPickerOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  // The caret belongs in the search box whenever the picker is up. Mount has to
  // settle first or it lands nowhere.
  useEffect(() => {
    if (!lgPickerOpen) return
    // And the arrows start from the ledger that is open, not from the top.
    if (__WEB__) {
      const at = lgOrderRef.current.indexOf(Number(ledgerId))
      setLgCursor(at < 0 ? 0 : at)
    }
    return focusWhenReady(ledgerSearchRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lgPickerOpen])

  // ARRIVING ON LEDGERS MEANS LOOKING FOR ONE.
  //
  // Nobody opens this screen to admire the list - they open it with a
  // party's name already in mind, and typing it was costing a click on a
  // 276px box first. The delay is the panel's own mount: focusing a node
  // that is not on screen yet does nothing at all.
  //
  // Not while the picker modal is up - that owns the keyboard while it is
  // open, and two boxes fighting for the first keystroke is worse than
  // neither taking it.
  useEffect(() => {
    if (screen !== 'ledger' || lgPickerOpen) return
    return focusWhenReady(lgListSearchRef)
  }, [screen, lgPickerOpen])

  // Unbooking a transporter bill, and bills whose voucher was deleted from the
  // Day Book on its own (which used to leave their freight stuck on Booked).
  // Which bill row is open in the bill-wise view. Keyed by ref + index, since a
  // duplicate-ref line can legitimately appear twice.
  const [billOpen, setBillOpen] = useState<string | null>(null)
  // Bill-wise, Tally's way: Detailed prints every voucher under its bill;
  // Condensed prints the bills alone and a click opens one.
  // Opens Condensed — the bills alone — and Alt F1 explodes them all.
  const [bwDetailed, setBwDetailed] = useState(() => !!lgReturn.current?.bwDetailed)
  // DUE ON — COUNTED FROM THE INVOICE, OR FROM THE TANKER EMPTYING. Oil
  // moves by tanker both ways, and credit is often reckoned from the day it
  // was emptied (at our plant for a purchase, at the customer's for a sale)
  // rather than the invoice date. The server sends both; this picks which the
  // Due on and Overdue columns read. A bill with no tanker behind it keeps its
  // invoice date either way. Kept on this computer.
  const [bwDueOn, setBwDueOnState] = useState<'invoice' | 'empty'>(() => {
    try {
      return localStorage.getItem('ledger.billsDueOn') === 'empty' ? 'empty' : 'invoice'
    } catch {
      return 'invoice'
    }
  })
  const setBwDueOn = (v: 'invoice' | 'empty'): void => {
    setBwDueOnState(v)
    try {
      localStorage.setItem('ledger.billsDueOn', v)
    } catch {
      /* the choice just is not remembered */
    }
  }
  // One bill's due date and days overdue under the chosen basis. `held`: the
  // tanker has not emptied yet, so it is not due at all. `fallback`: no tanker
  // behind this bill, so the invoice basis stands in.
  const billDue = (b: Row): { on: string; late: number; held: boolean; fallback: boolean } => {
    if (bwDueOn === 'empty' && b.empty_state === 'empty' && b.due_on_empty) {
      return { on: String(b.due_on_empty), late: Number(b.overdue_days_empty) || 0, held: false, fallback: false }
    }
    if (bwDueOn === 'empty' && b.empty_state === 'awaiting') return { on: '', late: 0, held: true, fallback: false }
    return { on: String(b.due_on || b.bill_date || ''), late: Number(b.overdue_days) || 0, held: false, fallback: bwDueOn === 'empty' }
  }
  // THE DATE COLUMN FOLLOWS THE SAME SWITCH. On Tanker empty a bill is dated
  // the day its tanker was emptied; one still on the road, or with no tanker
  // behind it, keeps its invoice date, marked so it is not taken for one.
  const billDateOf = (b: Row): { on: string; held: boolean; fallback: boolean } => {
    if (bwDueOn === 'empty' && b.empty_state === 'empty' && b.empty_on) return { on: String(b.empty_on), held: false, fallback: false }
    return { on: String(b.bill_date || ''), held: bwDueOn === 'empty' && b.empty_state === 'awaiting', fallback: bwDueOn === 'empty' && b.empty_state !== 'awaiting' }
  }
  const billDateTitle = (b: Row): string | undefined => {
    const d = billDateOf(b)
    if (bwDueOn !== 'empty') return undefined
    return d.held
      ? `Invoice date — the tanker has not been emptied yet`
      : d.fallback
        ? 'Invoice date — no tanker behind this bill'
        : `Tanker emptied ${formatDate(d.on)} · invoice ${formatDate(String(b.bill_date || ''))}`
  }
  // Listed by the date shown, so the column reads in order either way.
  const byBillDate = (list: Row[]): Row[] =>
    bwDueOn === 'empty' ? [...list].sort((x, y) => billDateOf(x).on.localeCompare(billDateOf(y).on)) : list
  // The small switch both bill-wise views carry.
  const dueToggle = (): React.JSX.Element => (
    <div
      className="flex items-center gap-[3px] rounded-[4px] p-[3px]"
      style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}
      title="Count Due on (and Overdue) from the invoice date, or from the day the tanker was emptied — at our plant for a purchase, at the customer's for a sale"
    >
      <span className="pl-1 pr-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">Due on</span>
      {([
        { v: 'invoice', label: 'Invoice date' },
        { v: 'empty', label: 'Tanker empty' }
      ] as const).map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => setBwDueOn(o.v)}
          className="h-7 rounded-[3px] px-2.5"
          style={bwDueOn === o.v ? { background: '#0B3D2E', color: '#fff', fontSize: 11, fontWeight: 800 } : { color: '#5A6B62', fontSize: 11, fontWeight: 700 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
  // TALLY'S KEYS ON THE WEB BILL-WISE VIEW. Alt F1 flips the whole
  // report between Detailed and Condensed; ↑ ↓ pick a bill; Shift Enter (or
  // Enter) opens that one bill — or, in Detailed, folds it — leaving every
  // other line as it was. `bwFlip` holds the bills set the other way from the
  // report's mode, so several can be open at once; a mode change clears it.
  const [bwFlip, setBwFlip] = useState<Set<string>>(() => new Set())
  const [bwSel, setBwSel] = useState(-1)
  const bwNav = useRef<{ on: boolean; keys: string[] }>({ on: false, keys: [] })
  // A Shift Enter pressed while the bills are still loading — kept, and done
  // the moment they arrive, rather than lost to an empty list.
  const bwPending = useRef(false)
  // The remembered bill, put back once the bills are on screen.
  const bwRestore = useRef<number>(-1)
  useEffect(() => {
    const back = lgReturn.current
    if (back && back.ledgerId === ledgerId) {
      // Back from a document: the same bill picked and open as it was left.
      lgReturn.current = null
      setBwSel(back.bwSel)
      setBwFlip(new Set(back.bwFlip))
      bwRestore.current = back.bwSel
      bwPending.current = false
      return
    }
    setBwSel(-1)
    setBwFlip(new Set())
    bwPending.current = false
  }, [ledgerId])
  // LANDING ON BILL-WISE PICKS THE FIRST BILL, so the keys have somewhere to
  // act straight away — no click needed to "wake" the list — and an early
  // Shift Enter is carried out once the bills are on screen.
  useEffect(() => {
    if (lgView !== 'billwise' || !bills) return
    const keys = bwNav.current.keys
    if (!keys.length) return
    const at = bwSel >= 0 && bwSel < keys.length ? bwSel : 0
    if (at !== bwSel) setBwSel(at)
    if (bwRestore.current >= 0) {
      bwRestore.current = -1
      setTimeout(() => document.querySelector(`[data-bw-row="${at}"]`)?.scrollIntoView({ block: 'center' }))
    }
    if (bwPending.current) {
      bwPending.current = false
      toggleBw(keys[at])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lgView, bills])
  const toggleBw = useCallback((key: string) => {
    setBwFlip((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const [tfUnbook, setTfUnbook] = useState<Row | null>(null)
  const [tfUnbooking, setTfUnbooking] = useState(false)
  const [tfOrphans, setTfOrphans] = useState<Row[]>([])
  // The website's register filters on the page: a search, one transporter,
  // and how much is still to bill on the OTHER side for its tab.
  const [tfQuery, setTfQuery] = useState('')
  const [tfTr, setTfTr] = useState('all')
  const [tfTrOpen, setTfTrOpen] = useState(false)
  const [tfSideCounts, setTfSideCounts] = useState<Record<string, number>>({})

  const tfSide: 'purchase' | 'sales' = screen === 'tfsal' ? 'sales' : 'purchase'
  const loadTFreight = useCallback(async () => {
    if (!cid || (screen !== 'tfpur' && screen !== 'tfsal')) return
    const side: 'purchase' | 'sales' = screen === 'tfsal' ? 'sales' : 'purchase'
    const opts = { companyId: cid, from: tfFrom || undefined, to: tfTo || undefined }
    try {
      const other: 'purchase' | 'sales' = side === 'purchase' ? 'sales' : 'purchase'
      const [rows, kpi, orphans, otherRows] = await Promise.all([
        // The website reads the whole side and filters on the page, so each
        // state chip can say how many rows it holds.
        window.api.transporterFreight.list(side, { ...opts, state: __WEB__ ? 'all' : tfState }),
        window.api.transporterFreight.kpis(side, opts),
        window.api.transporterFreight.orphanBills(cid).catch(() => [] as Row[]),
        __WEB__ ? window.api.transporterFreight.list(other, { ...opts, state: 'unbilled' }).catch(() => [] as Row[]) : Promise.resolve([] as Row[])
      ])
      setTfRows(rows)
      setTfKpi(kpi)
      setTfOrphans(orphans)
      if (__WEB__) {
        const toBill = (list: Row[]): number => list.filter((r) => r.bill_id == null && r.note_id == null && r.waived_at == null).length
        setTfSideCounts({ [side]: toBill(rows), [other]: toBill(otherRows) })
      }
    } catch {
      setTfRows([])
      setTfKpi(null)
      setTfOrphans([])
    }
  }, [cid, screen, tfFrom, tfTo, tfState])
  useEffect(() => {
    void loadTFreight()
  }, [loadTFreight])
  // Only ever for the row actually opened — a register of two hundred booked
  // lines must not read two hundred ledgers to draw itself.
  useEffect(() => {
    if (!tfBillRow || !cid) return
    const row = tfRows.find((r) => Number(r.id) === tfBillRow)
    const party = String(row?.transporter_name || '').trim()
    if (!party || tfBillWise[party]) return
    let alive = true
    void window.api.journal
      .billsOutstanding(party, cid, { side: 'supplier' })
      .then((res) => {
        if (alive) setTfBillWise((p) => ({ ...p, [party]: Array.isArray(res?.rows) ? (res.rows as Row[]) : [] }))
      })
      .catch(() => {
        if (alive) setTfBillWise((p) => ({ ...p, [party]: [] }))
      })
    return () => {
      alive = false
    }
  }, [tfBillRow, tfRows, cid, tfBillWise])
  // A booked bill that has just been paid, or a filter change, must not leave
  // yesterday's figures under a row.
  useEffect(() => {
    setTfBillRow(0)
    setTfBillWise({})
  }, [screen, tfState, tfFrom, tfTo])
  // Switching side or filter invalidates the tick-list — the picked ids may not
  // even be on screen any more.
  useEffect(() => {
    setTfPicked([])
  }, [screen, tfState, tfFrom, tfTo])
  // A transporter picked on one side is very likely not on the other.
  useEffect(() => {
    setTfTr('all')
  }, [screen])

  useEffect(() => {
    if (regScrollTo.current == null) return
    const el = regScrollEl.current
    const have = screen === 'purchreg' ? purchases.length : screen === 'salesreg' ? saleRows.length : noteRows.length + noteVchRows.length
    if (!el || !have) return
    el.scrollTop = regScrollTo.current
    regScrollTo.current = null
  }, [screen, purchases.length, saleRows.length, noteRows.length, noteVchRows.length])

  const loadNoteRegister = useCallback(async () => {
    if (!cid) return
    try {
      setNoteRows(await window.api.notes.list(cid))
    } catch {
      setNoteRows([])
    }
    if (!__WEB__) return
    try {
      const vs = (await window.api.vouchers.list({ vchType: ['DEBIT NOTE', 'CREDIT NOTE'], companyId: cid })) as Row[]
      setNoteVchRows(
        vs
          .filter((v) => !Number(v.note_id))
          .map((v) => {
            const credit = String(v.vch_type || '').toUpperCase().includes('CREDIT')
            return {
              // Not a note id — a string key, so it can never collide with one.
              id: `vch-${v.id}`,
              from_voucher: true,
              note_type: credit ? 'credit' : 'debit',
              // Its voucher number (DN/10), with the reference typed on it
              // kept beside — not the reference in the number's place.
              note_no: v.voucher_code || v.vch_no,
              vch_ref: v.voucher_code && v.vch_no && v.vch_no !== v.voucher_code ? v.vch_no : '',
              note_date: v.entry_date,
              // The party is the side the note moves: debited on a debit
              // note, credited on a credit note.
              party_name: credit ? v.cr_account : v.dr_account,
              // What it was set against on the voucher's bill-wise lines.
              against_ref: String(v.agst_refs || '').split(',').filter(Boolean).join(', ') || null,
              against_on_account: Number(v.on_account_allocs) > 0,
              against_account: null,
              narration: v.narration,
              total_amount: v.amount,
              journal_entry_id: v.id
            }
          })
      )
    } catch {
      setNoteVchRows([])
    }
  }, [cid])
  useEffect(() => {
    if (!onRegister) return
    void loadNoteRegister()
  }, [onRegister, loadNoteRegister])

  const loadTb = useCallback(async () => {
    if (screen !== 'trial' || !cid) return
    setTb(await window.api.journal.trialBalance({ from: tbFrom || undefined, to: tbTo || undefined, companyId: cid }))
  }, [screen, tbFrom, tbTo, cid])
  useEffect(() => {
    loadTb()
  }, [loadTb])
  useLiveRefresh(loadTb)


  // ------- voucher helpers -------
  const totals = useMemo(() => {
    const dr = lines.reduce((s, l) => s + (l.side === 'dr' ? Number(l.amount) || 0 : 0), 0)
    const cr = lines.reduce((s, l) => s + (l.side === 'cr' ? Number(l.amount) || 0 : 0), 0)
    return { dr, cr, diff: Math.round((dr - cr) * 100) / 100 }
  }, [lines])

  /**
   * ONE TAB, ONE VOUCHER, AND NOTHING CARRIED BETWEEN THEM.
   *
   * Switching type used to change the label and leave everything else alone
   * whenever a voucher was open for alter — so LC-7's three journal lines, its
   * number and its narration sat under the Debit Note tab, described as
   * "adjusts a party balance", and Accept would have filed them as one. On a
   * NEW voucher it did the opposite and wiped the lines without a word, which
   * loses work just as quietly.
   *
   * A tab is now always a fresh voucher of that type, and anything already
   * entered is asked about first: keep it, or let it go. Nothing decided on
   * the reader's behalf in either direction.
   */
  function voucherHasWork(): boolean {
    // Altering: work is anything changed since it opened.
    if (editingId != null || noteEditId != null) return !editBaseline.current || editBaseline.current.snap !== draftSnapshot()
    const typed = (v: unknown): boolean => String(v ?? '').trim() !== ''
    if (typed(narration) || typed(vchNo)) return true
    if (lines.some((l) => typed(l.account) || typed(l.amount))) return true
    if (payLines.some((l) => typed(l.account) || typed(l.amount))) return true
    if (noteInvoiceMode) {
      if (typed(noteParty) || typed(noteInvoice)) return true
      if (noteItems.some((it) => typed(it.product_id) || typed(it.qty) || typed(it.rate))) return true
    }
    return false
  }

  /** The switch itself, once it is allowed to happen. */
  function applyType(t: VchType): void {
    setEditingId(null)
    setNoteEditId(null)
    setAlterBack(null)
    setVchType(t)
    setVchNo('')
    setVchCode('')
    setNoteSplitOpen(false)
    setNarration('')
    setLines(blankLines(t))
    setPayLines([blankPayLine()])
    setRawAlter(false)
    setNoteInvoice('')
    setNoteItems([{ product_id: '', qty: '', rate: '' }])
  }

  // The type waiting on an answer, and null when nothing is being asked.
  const [pendingType, setPendingType] = useState<VchType | null>(null)
  const [pendingLeave, setPendingLeave] = useState(false)
  // WHERE AN OPENED VOUCHER GOES BACK TO. A voucher opened from the Day Book,
  // a register or a ledger to be altered is left with Esc to the screen it was
  // opened from — it went to the Gateway, which is nowhere the desk was.
  const [alterBack, setAlterBack] = useState<Screen | null>(null)
  // THE FORM AS IT OPENED, for a voucher being altered — so Esc on one nobody
  // has touched simply goes back, instead of asking to discard a draft that
  // does not exist. Taken on the first render after the voucher loads.
  const draftSnapshot = (): string =>
    JSON.stringify({ vchDate, vchNo, narration, lines, payLines, payAccounts, noteItems, noteInvoice, noteParty })
  const editBaseline = useRef<{ key: string; snap: string } | null>(null)
  const editKey = editingId != null ? `e${editingId}` : noteEditId != null ? `n${noteEditId}` : ''
  useEffect(() => {
    if (!editKey) {
      editBaseline.current = null
      return
    }
    if (editBaseline.current?.key !== editKey) editBaseline.current = { key: editKey, snap: draftSnapshot() }
  })
  function backFromVoucher(): void {
    const to = alterBack && alterBack !== 'voucher' ? alterBack : 'gateway'
    setAlterBack(null)
    setEditingId(null)
    setNoteEditId(null)
    setScreen(to)
  }

  // Back to the screen the statement was opened from (see lgBack), else out.
  function leaveLedger(): void {
    const to = lgBack
    if (to && to !== 'ledger') {
      setLgBack(null)
      setScreen(to, true)
      return
    }
    leaveVoucher()
  }

  function leaveVoucher(): void {
    if (viewOnly) {
      const back = String(viewOnly.back || '') as Screen
      setViewOnly(null)
      setScreen(back && back !== 'voucher' ? back : 'gateway', true)
      return
    }
    if (saving) return
    if (screen === 'voucher' && voucherHasWork()) {
      setPendingLeave(true)
      return
    }
    backFromVoucher()
  }

  function switchType(t: VchType): void {
    if (!mayEnter(t)) {
      toast.error(`You do not have rights to enter a ${vchLabel(t)} voucher`)
      return
    }
    if (viewOnly) {
      setViewOnly(null)
      openVoucher(t)
      return
    }
    if (t === vchType && editingId == null && noteEditId == null) return
    if (voucherHasWork()) {
      setPendingType(t)
      return
    }
    applyType(t)
  }

  /**
   * MOVE WHAT IS TYPED TO ANOTHER VOUCHER TYPE.
   *
   * Half-way through a Debit Note the desk realises it should have been a
   * Journal, or a Credit Note, or a Payment. The choice used to be throw it
   * away or file it wrongly first. This carries the date, the narration and
   * every line into a fresh voucher of the other type, still unsaved:
   *
   *   - A note's goods lines keep their qty × rate on the other note; on any
   *     other voucher they become the amount they came to, and the GST (and
   *     round off) the note was working out becomes real lines — otherwise the
   *     voucher it lands in would not balance. A party total the note was only
   *     suggesting is written in.
   *   - Into a Payment or Receipt, lines that already have its shape (parties
   *     on one side, cash and bank on the other) fill its own form; anything
   *     else opens in the grid, so no line is lost to the reshaping.
   *   - Out of a Payment or Receipt, the party lines and the cash/bank lines
   *     become ordinary Dr and Cr lines.
   *
   * Drafts only: a saved voucher being altered is not copied into a second
   * one, which would book it twice.
   */
  function canMoveTo(t: VchType): boolean {
    if (editingId != null || noteEditId != null) return false
    const toNote = t === 'DEBIT NOTE' || t === 'CREDIT NOTE'
    // The desktop's invoice-style note screen moves between the two notes only.
    if (noteInvoiceMode && !toNote) return false
    return true
  }

  function moveToType(t: VchType): void {
    const toNote = t === 'DEBIT NOTE' || t === 'CREDIT NOTE'
    const toPay = t === 'PAYMENT' || t === 'RECEIPT'
    const typed = (v: unknown): boolean => String(v ?? '').trim() !== ''
    const r2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100
    const keepNarration = narration

    if (noteInvoiceMode) {
      const items = noteItems
      const invoice = noteInvoice
      applyType(t)
      setNarration(keepNarration)
      setNoteItems(items)
      setNoteInvoice(invoice)
      return
    }

    let carried: VLine[]
    if (structured) {
      const partyDr = vchType === 'PAYMENT'
      const party = payLines.filter((l) => typed(l.account) || typed(l.amount))
      const total = r2(party.reduce((s, l) => s + (Number(l.amount) || 0), 0))
      const money = payAccounts.filter((l) => typed(l.account))
      carried = [
        ...party.map((l): VLine => ({ side: partyDr ? 'dr' : 'cr', account: l.account, group: l.group, amount: l.amount, allocs: l.allocs || [] })),
        ...money.map((l): VLine => ({
          side: partyDr ? 'cr' : 'dr',
          account: l.account,
          group: l.group,
          // One account carries the whole total without it being typed.
          amount: money.length === 1 ? (total ? String(total) : '') : l.amount,
          allocs: l.allocs || []
        }))
      ]
    } else {
      carried = lines.filter((l) => typed(l.account) || typed(l.amount)).map((l) => ({ ...l }))
      if (gridNote) {
        if (gridGst.partyTarget != null && gridGst.party) {
          const p = gridGst.party
          const at = carried.findIndex((c) => c.account === p.account && c.side === p.side)
          if (at >= 0 && !typed(carried[at].amount)) carried[at] = { ...carried[at], amount: String(gridGst.partyTarget) }
        }
        if (!toNote) {
          carried = carried.map((l) => {
            const goods = PRODUCT_LEDGER_GROUPS.includes(String(l.group)) && Number(l.qty) > 0 && Number(l.rate) > 0
            const plain: VLine = { side: l.side, account: l.account, group: l.group, amount: l.amount, allocs: l.allocs || [], splits: l.splits }
            return goods ? { ...plain, amount: String(r2(Number(l.qty) * Number(l.rate))) } : plain
          })
          if (gridGst.active) {
            carried.push(
              ...gridGst.virtual.map((v): VLine => ({ side: v.side, account: v.account, group: v.group, amount: String(v.amount), allocs: [] }))
            )
          }
        }
      }
    }

    applyType(t)
    setNarration(keepNarration)
    if (toPay && carried.length) {
      const partyDr = t === 'PAYMENT'
      const isMoney = (l: VLine): boolean => CASH_BANK_GROUPS.includes(String(l.group))
      const money = carried.filter((l) => isMoney(l) && l.side === (partyDr ? 'cr' : 'dr'))
      const party = carried.filter((l) => !isMoney(l) && l.side === (partyDr ? 'dr' : 'cr'))
      if (money.length && party.length && money.length + party.length === carried.length) {
        setPayLines(party.map((l) => ({ account: l.account, group: l.group, amount: l.amount, allocs: l.allocs || [] })))
        setPayAccounts(money.map((l) => ({ account: l.account, group: l.group, amount: money.length === 1 ? '' : l.amount, allocs: l.allocs || [] })))
        return
      }
      setRawAlter(true)
    }
    setLines(carried.length ? carried : blankLines(t))
  }

  function openVoucher(t: VchType): void {
    if (!mayEnter(t)) {
      toast.error(`You do not have rights to enter a ${vchLabel(t)} voucher`)
      return
    }
    resetNoteGst()
    setViewOnly(null)
    setEditingId(null)
    setNoteEditId(null)
    setVchType(t)
    setVchDate(todayISO())
    setVchNo('')
    setVchCode('')
    setPostedMsg(null)
    setNoteSplitOpen(false)
    setNarration('')
    setLines(blankLines(t))
    setPayLines([blankPayLine()])
    setRawAlter(false)
    setNoteMode(true)
    setNoteParty('')
    setNoteInvoice('')
    setNoteItems([{ product_id: '', qty: '', rate: '' }])
    setNoteSubCat('ALL')
    // Default the money side to the first bank ledger, like Tally remembers one.
    const bank = accounts.find((a) => String(a.name) === 'BANK A/C') || cashBankAccounts[0]
    setPayAccounts([bank ? { account: String(bank.name), group: String(bank.acc_group), amount: '', allocs: [] } : blankPayLine()])
    setScreen('voucher')
  }

  // Alter a posted note: the same Alt-F5/Alt-F6 invoice form, pre-filled, saving
  // through notes.update so the voucher, ledger row and stock are re-posted.
  async function openNoteForAlter(r: Row, stay = false): Promise<void> {
    let its: Row[] = []
    try {
      its = await window.api.notes.items(Number(r.id))
    } catch {
      its = []
    }
    setEditingId(null)
    setNoteEditId(Number(r.id))
    setVchType(String(r.note_type) === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE')
    setVchDate(String(r.note_date || todayISO()).slice(0, 10))
    setVchNo(String(r.note_no || ''))
    setNarration(String(r.narration || ''))
    setRawAlter(false)
    setNoteMode(true)
    setNotePartyKind(
      (['supplier', 'customer', 'transporter'].includes(String(r.party_type))
        ? String(r.party_type)
        : 'supplier') as 'supplier' | 'customer' | 'transporter'
    )
    setNoteParty(String(r.party_id ?? ''))
    setNoteBargain(r.bargain_id == null ? '' : String(r.bargain_id))
    setNoteInvoice(String(r.against_ref || ''))
    setNoteGst(String(Number(r.gst_pct) || 0))
    setNoteItems(
      its.length
        ? its.map((it) => ({ product_id: String(it.product_id ?? ''), qty: String(it.qty ?? ''), rate: String(it.rate ?? '') }))
        : [{ product_id: '', qty: '', rate: '' }]
    )
    // Unfiltered, or the lines already on the note could point at products the
    // picker is currently hiding.
    setNoteSubCat('ALL')
    if (!stay) setScreen('voucher')
  }

  function setLine(i: number, patch: Partial<VLine>): void {
    setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  const structured = (vchType === 'PAYMENT' || vchType === 'RECEIPT') && !rawAlter
  const isNoteType = vchType === 'DEBIT NOTE' || vchType === 'CREDIT NOTE'
  // New notes open in Tally's invoice mode; altering an old grid voucher keeps the grid.
  // On the website the note is entered in the ledger grid itself (a product ledger
  // line carries its own quantity), so the separate invoice screen never opens there.
  // The desktop's note editor. The website enters — and now alters — a note in
  // the ledger grid instead (openNoteInGrid), saved through notes:update.
  const noteInvoiceMode = isNoteType && noteMode && editingId == null && !__WEB__
  // Only a customer credit note puts goods back into our hands, so only it can
  // credit a sales bargain.
  const noteCanCreditBargain = vchType === 'CREDIT NOTE' && notePartyKind === 'customer'
  const noteReturnQty = useMemo(
    () => noteItems.reduce((sum, it) => sum + (Number(it.qty) || 0), 0),
    [noteItems]
  )

  // --- GST on a grid note (see noteGstType) ---------------------------------
  const gridNote = __WEB__ && isNoteType && !structured && !viewOnly && editingId == null && noteEditId == null
  const gridGst = useMemo(() => {
    // The party: Sundry Creditors / Debtors or a group under them (SC-OIL) —
    // read as an item line, its amount turned the GST round to the wrong side.
    const r2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100
    const partyIdx = lines.findIndex((l) => l.account && isBillwise(l.group))
    const party = partyIdx >= 0 ? lines[partyIdx] : null
    // A GST line typed by hand is the user's own; the panel stands aside.
    const manual = lines.some((l) => String(l.group) === 'Duties & Taxes' && /GST/i.test(String(l.account)))
    const amt = (l: VLine): number =>
      PRODUCT_LEDGER_GROUPS.includes(String(l.group)) && n(l.qty) > 0 && n(l.rate) > 0 ? r2(n(l.qty) * n(l.rate)) : n(l.amount)
    const baseLines = lines.filter(
      (l) => l.account && !isBillwise(l.group) && baseGroup(l.group) !== 'Duties & Taxes' && !/ROUND OFF/i.test(String(l.account))
    )
    const signed = r2(baseLines.reduce((t, l) => t + (l.side === 'cr' ? amt(l) : -amt(l)), 0))
    const base = Math.abs(signed)
    const baseSide: 'dr' | 'cr' = signed >= 0 ? (baseLines.length ? 'cr' : vchType === 'DEBIT NOTE' ? 'cr' : 'dr') : 'dr'
    const partySide: 'dr' | 'cr' = baseSide === 'cr' ? 'dr' : 'cr'
    const taxSide: 'INPUT' | 'OUTPUT' = party
      ? baseGroup(party.group) === 'Sundry Debtors'
        ? 'OUTPUT'
        : 'INPUT'
      : vchType === 'DEBIT NOTE'
        ? 'INPUT'
        : 'OUTPUT'
    const pct = n(noteGstPct)
    const active = gridNote && noteGstType !== 'none' && pct > 0 && base > 0 && !manual
    // CGST and SGST are equal by law, to the paisa — so each half is rounded
    // first and the tax is their sum; any paisa over lands on the round-off.
    const half = active && noteGstType !== 'IGST' ? r2((base * pct) / 200) : 0
    const gst = !active ? 0 : noteGstType === 'IGST' ? r2((base * pct) / 100) : r2(half * 2)
    // The same names the note posting uses (gstLedgers.ts): one spelling per rate.
    const label = (x: number): string => String(Math.round(x * 1000) / 1000)
    const taxRows: { account: string; amount: number }[] = !active
      ? []
      : noteGstType === 'IGST'
        ? [{ account: `${taxSide} IGST ${label(pct)}%`, amount: gst }]
        : [
            { account: `${taxSide} CGST ${label(pct / 2)}%`, amount: half },
            { account: `${taxSide} SGST ${label(pct / 2)}%`, amount: half }
          ]
    // Rounded to the whole rupee against the party, the paise on ROUND OFF —
    // exactly what the note posting does.
    const raw = r2(base + gst)
    const total = active ? Math.round(raw) : raw
    const roundOff = active ? r2(total - raw) : 0
    const virtual: { account: string; group: string; side: 'dr' | 'cr'; amount: number }[] = [
      ...taxRows.map((t) => ({ ...t, group: 'Duties & Taxes', side: baseSide })),
      ...(Math.abs(roundOff) > 0.004
        ? [{ account: 'ROUND OFF A/C', group: 'Indirect Expenses', side: (roundOff > 0 ? baseSide : partySide) as 'dr' | 'cr', amount: Math.abs(roundOff) }]
        : [])
    ]
    // WHAT THE PARTY'S LINE SHOULD SAY, the way Tally fills it: the note's
    // total, with or without GST — items first, and the party follows. Not
    // offered when a GST line was typed by hand (the user is doing the sum).
    const partyTarget = gridNote && base > 0 && !manual ? (active ? total : r2(base)) : null
    // A party and an item ledger from opposite sides of the business: a
    // customer against a purchase head, or a supplier against a sales head.
    const itemGroups = new Set(baseLines.map((l) => String(l.group)))
    const mismatch =
      !!party &&
      ((baseGroup(party.group) === 'Sundry Debtors' && itemGroups.has('Purchase Accounts')) ||
        (baseGroup(party.group) === 'Sundry Creditors' && itemGroups.has('Sales Accounts')))
    return { active, manual, partyIdx, party, base, baseSide, partySide, taxSide, pct, gst, total, roundOff, virtual, partyTarget, mismatch }
  }, [lines, noteGstType, noteGstPct, gridNote, vchType])

  // The party masters, for the type and rate a party's note starts from.
  useEffect(() => {
    if (!gridNote || gstParties) return
    Promise.all([
      window.api.data.list('suppliers').catch(() => [] as Row[]),
      window.api.data.list('customers').catch(() => [] as Row[]),
      window.api.journal.ledgerMap(cid || undefined).catch(() => [] as Row[])
    ]).then(([sup, cus, map]) => setGstParties({ sup, cus, map }))
  }, [gridNote, gstParties, cid])

  // WHICH GST, FROM WHO THE PARTY IS. Same state as this company — read off
  // the first two digits of each GSTIN, or the state names where a GSTIN is
  // missing — is CGST + SGST; another state is IGST. The rate is the one on
  // the party's master. Only until the user picks one; after that it is theirs.
  const gridPartyName = gridGst.party ? String(gridGst.party.account) : ''
  useEffect(() => {
    if (!gridNote || !gstParties || !gridPartyName || noteGstPicked.current) return
    const up = (x: unknown): string => String(x ?? '').trim().toUpperCase()
    const wanted = up(gridPartyName)
    // A renamed ledger is still its party: the master keeps the old name.
    const aliases = new Set([wanted, ...gstParties.map.filter((m) => up(m.use_name) === wanted).map((m) => up(m.posts_as))])
    const pool = gridGst.taxSide === 'OUTPUT' ? [...gstParties.cus, ...gstParties.sup] : [...gstParties.sup, ...gstParties.cus]
    const master = pool.find((x) => aliases.has(up(x.name)))
    if (!master) return
    if (n(master.gst_pct) > 0) setNoteGstPct(String(n(master.gst_pct)))
    const code = (g: unknown): string => (/^\d{2}/.test(up(g)) ? up(g).slice(0, 2) : '')
    const ours = code(company?.gstin)
    const theirs = code(master.gstin)
    if (ours && theirs) setNoteGstType(ours === theirs ? 'CGST_SGST' : 'IGST')
    else if (up(company?.state) && up(master.state)) setNoteGstType(up(company?.state) === up(master.state) ? 'CGST_SGST' : 'IGST')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridNote, gstParties, gridPartyName])

  // The party's figure follows the note: purchase/sale lines + GST, to the
  // rupee. Only while it is blank or still the figure this filled in — a
  // number the user typed over it is left alone.
  useEffect(() => {
    if (gridGst.partyTarget == null || gridGst.partyIdx < 0) return
    const cur = String(lines[gridGst.partyIdx]?.amount ?? '')
    const want = String(gridGst.partyTarget)
    if (cur === want && lines[gridGst.partyIdx]?.side === gridGst.partySide) return
    if (cur !== '' && cur !== partyAutoAmount.current && cur !== want) return
    partyAutoAmount.current = want
    setLine(gridGst.partyIdx, { amount: want, side: gridGst.partySide })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridGst.partyTarget, gridGst.partyIdx, gridGst.partySide])

  useEffect(() => {
    const r = urlVoucher.current
    if (!r || !company) return
    urlVoucher.current = null
    if (r.id) void openForAlter({ id: r.id })
    else {
      // A refresh on a type this user no longer holds lands on one they do.
      const t = (VCH_TYPES.some((x) => x.key === r.t) ? r.t : 'PAYMENT') as VchType
      const go = mayEnter(t) ? t : firstVch()
      if (go) openVoucher(go)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company])

  useEffect(() => {
    if (!__WEB__) return
    if (window.location.pathname.replace(/\/+$/, '') !== '/accounts') return
    // Until the company list has answered, the URL is left as it came in —
    // it is still waiting to be restored from.
    if (!company && (pendingCoRef.current != null || urlVoucher.current)) return
    const q = new URLSearchParams()
    if (company) {
      q.set('co', String(company.id))
      if (screen !== 'gateway') q.set('s', screen)
      if (screen === 'ledger' && ledgerId) {
        q.set('l', String(ledgerId))
        if (lgView !== 'vouchers') q.set('v', lgView)
      }
      if (screen === 'voucher') {
        const id = editingId ?? (viewOnly ? Number(viewOnly.id) || null : null)
        if (id) q.set('id', String(id))
        else q.set('t', vchType)
        if (viewOnly && String(viewOnly.back) === 'ledger' && ledgerId) {
          q.set('from', 'ledger')
          q.set('l', String(ledgerId))
        }
      }
    }
    const qs = q.toString()
    const next = `/accounts${qs ? `?${qs}` : ''}`
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(window.history.state, '', next)
  }, [company, screen, ledgerId, lgView, vchType, editingId, viewOnly])

  useEffect(() => {
    if (!__WEB__) return
    const on = (): void => {
      setVw(window.innerWidth)
      setVh(window.innerHeight)
    }
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // The number the voucher being keyed will take — asked again whenever the
  // type or the company changes, and after every Accept.
  useEffect(() => {
    if (!__WEB__ || screen !== 'voucher' || editingId != null || viewOnly || !company) return
    let live = true
    window.api.vouchers
      .nextCode(vchType, cid || undefined)
      .then((c) => {
        if (live) setNextCode(String(c || ''))
      })
      .catch(() => {
        if (live) setNextCode('')
      })
    return () => {
      live = false
    }
  }, [screen, vchType, cid, editingId, viewOnly, company, postedSeq])

  function resetNoteGst(): void {
    setNoteGstType('CGST_SGST')
    setNoteGstPct('')
    noteGstPicked.current = false
    partyAutoAmount.current = ''
  }

  // Switching voucher type resets the party side to the usual one for it, which
  // keeps Alt-F5/Alt-F6 behaving as before unless the kind is changed by hand.
  useEffect(() => {
    if (!isNoteType) return
    // An alter already carries the side the note was raised on — only a fresh
    // Alt-F5/Alt-F6 gets the usual default.
    if (noteEditId != null) return
    setNotePartyKind(vchType === 'DEBIT NOTE' ? 'supplier' : 'customer')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vchType, isNoteType])

  useEffect(() => {
    if (!isNoteType) return
    const master =
      notePartyKind === 'supplier' ? 'suppliers' : notePartyKind === 'customer' ? 'customers' : 'transporters'
    window.api.data
      .list(master)
      .then(setNoteParties)
      .catch(() => setNoteParties([]))
    if (!noteProducts.length) {
      window.api.data.list('products').then(setNoteProducts).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePartyKind, isNoteType])

  // The chosen customer's sales bargains, so a return can be credited back to
  // the one it was drawn from. Fetched per customer rather than up front —
  // the register call is range-wide and there is no point paying for it until
  // a credit note is actually being raised against a customer.
  useEffect(() => {
    if (!noteCanCreditBargain || !noteParty) {
      setNoteBargains([])
      return
    }
    let live = true
    window.api.salesBargains
      .list()
      .then((rows) => {
        if (!live) return
        setNoteBargains(rows.filter((r) => String(r.customer_id ?? '') === String(noteParty)))
      })
      .catch(() => {
        if (live) setNoteBargains([])
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteCanCreditBargain, noteParty])

  // Only sub-categories that actually have products behind them, in the
  // master's own order rather than alphabetical, each with its count.
  const noteSubCats = useMemo(() => {
    const order = ['raw', 'intermediate', 'finished', 'by-product', 'waste']
    const count = new Map<string, number>()
    for (const x of noteProducts) {
      const k = String(x.category || '').trim().toLowerCase()
      if (k) count.set(k, (count.get(k) || 0) + 1)
    }
    const known = order.filter((k) => count.has(k))
    const extra = [...count.keys()].filter((k) => !order.includes(k)).sort()
    return [...known, ...extra].map((k) => ({ key: k, label: SUB_CAT_LABEL[k] || k, count: count.get(k) || 0 }))
  }, [noteProducts])
  const noteProductsShown = useMemo(
    () =>
      noteSubCat === 'ALL'
        ? noteProducts
        : noteProducts.filter((x) => String(x.category || '').trim().toLowerCase() === noteSubCat),
    [noteProducts, noteSubCat]
  )
  const notePartyName = String(noteParties.find((x) => String(x.id) === noteParty)?.name || '')
  // Which of the party's documents a note can be set against: a customer's
  // sales invoices, or a supplier's purchase bills. A transporter has neither,
  // so it falls back to whatever its ledger group implies.
  const noteSide: 'customer' | 'supplier' | undefined =
    notePartyKind === 'customer' ? 'customer' : notePartyKind === 'supplier' ? 'supplier' : undefined
  const noteRefs = refsCache[refsKey(notePartyName.toUpperCase(), noteSide)] || []
  const noteLinks = (linkCache[refsKey(notePartyName.toUpperCase(), noteSide)] || []).filter(
    (r) => !noteRefs.some((p) => String(p.ref) === String(r.ref))
  )
  const noteTotals = (() => {
    const base = noteItems.reduce(
      (sum, it) =>
        sum +
        (noteWithQty
          ? Math.round((Number(it.qty) || 0) * (Number(it.rate) || 0) * 100) / 100
          : Math.round((Number(it.amount) || 0) * 100) / 100),
      0
    )
    const gst = Math.round(base * (Number(noteGst) || 0)) / 100
    const raw = Math.round((base + gst) * 100) / 100
    const total = Math.round(raw)
    return { base: Math.round(base * 100) / 100, gst, ro: Math.round((total - raw) * 100) / 100, total }
  })()
  const cashBankAccounts = accounts.filter((a) => CASH_BANK_GROUPS.includes(String(a.acc_group)))
  const payTotal = payLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const payAccountTotal = payAccounts.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  // `side` is passed when the caller knows which of the party's documents it
  // wants — a note against a customer wants their sales invoices even if the
  // party also happens to be a supplier. Cached under the side too, or the
  // supplier view of a dual-role party would be served to the customer view.
  function refsKey(name: string, side?: 'customer' | 'supplier'): string {
    return side ? `${side}:${name}` : name
  }
  async function loadRefs(name: string, side?: 'customer' | 'supplier'): Promise<void> {
    const key = refsKey(name, side)
    if (!name || refsCache[key]) return
    try {
      // Every bill in one fetch: the pending ones are what every picker has
      // always offered (refsCache); the settled ones go beside them, offered
      // only to LINK a voucher to (linkCache).
      const r: Row[] = await window.api.journal.pendingRefs(name, cid, side, true)
      setRefsCache((p) => ({ ...p, [key]: r.filter((b) => !b.settled) }))
      setLinkCache((p) => ({ ...p, [key]: r.filter((b) => !!b.settled) }))
    } catch {
      /* refs are a convenience — entry still works without them */
    }
  }

  function setPayLine(i: number, patch: Partial<PayLine>): void {
    setPayLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  function setPayAccountLine(i: number, patch: Partial<PayLine>): void {
    setPayAccounts((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  // Fill a blank money-side amount with whatever the party side still needs —
  // the same "Tally suggestion" convenience the party lines already get.
  function suggestPayAccountAmount(i: number): void {
    if (payAccounts[i].amount) return
    const restOfMoney = payAccounts.reduce((s, x, j) => (j === i ? s : s + (Number(x.amount) || 0)), 0)
    const rest = Math.round((payTotal - restOfMoney) * 100) / 100
    if (rest > 0.004) setPayAccountLine(i, { amount: String(rest) })
  }

  // Fill the amount that would balance the voucher — Tally's suggestion.
  function suggestAmount(i: number): void {
    const l = lines[i]
    if (l.amount) return
    const rest = Math.abs(
      lines.reduce((s, x, j) => (j === i ? s : s + (x.side === 'dr' ? 1 : -1) * (Number(x.amount) || 0)), 0)
    )
    if (rest > 0.004) setLine(i, { amount: String(Math.round(rest * 100) / 100) })
  }

  // Build the note's legs from taxable + GST%, Tally style: the goods ledger
  // carries the taxable, GST INPUT/OUTPUT its tax, ROUND OFF the paise so the
  // party line is a whole rupee. Accounts stay pickable afterwards.
  function applyGstCalc(): void {
    const taxable = Number(gstCalc.taxable) || 0
    if (taxable <= 0) return void toast.error('Type the taxable amount first')
    const pct = Number(gstCalc.pct) || 0
    const gst = Math.round(taxable * pct) / 100
    const raw = taxable + gst
    const total = Math.round(raw)
    const ro = Math.round((total - raw) * 100) / 100
    const isDn = vchType === 'DEBIT NOTE'
    const partySide: 'dr' | 'cr' = isDn ? 'dr' : 'cr'
    const goodsSide: 'dr' | 'cr' = isDn ? 'cr' : 'dr'
    const gstAccount = isDn ? 'GST INPUT A/C' : 'GST OUTPUT A/C'
    // Keep any party/goods ledgers already picked on the first two lines.
    const party = lines.find((l) => l.side === partySide)
    const goods = lines.find((l) => l.side === goodsSide)
    const next: VLine[] = [
      { side: partySide, account: party?.account || '', group: party?.group || '', amount: String(total), allocs: party?.allocs || [] },
      { side: goodsSide, account: goods?.account || '', group: goods?.group || '', amount: String(taxable), allocs: [] }
    ]
    if (gst > 0) next.push({ side: goodsSide, account: gstAccount, group: 'Duties & Taxes', amount: String(gst), allocs: [] })
    if (Math.abs(ro) >= 0.005) {
      // +ro rounds the party UP -> the extra sits on ROUND OFF's other side.
      next.push({
        side: ro > 0 ? goodsSide : partySide,
        account: 'ROUND OFF A/C',
        group: 'Indirect Expenses',
        amount: String(Math.abs(ro)),
        allocs: []
      })
    }
    setLines(next)
    toast.success(`Taxable ${formatINR(taxable)} + GST ${formatINR(gst)}${Math.abs(ro) >= 0.005 ? ` + round off ${formatINR(ro)}` : ''} = ${formatINR(total)}`)
  }

  // A price revision on an already-invoiced purchase/sale, settled through
  // RATE DIFFERENCE A/C instead of reopening the original document. "Owes
  // more" always means the PARTY's own balance grows — which side that is
  // depends on whether they're a customer (Dr) or a supplier (Cr).
  function applyRateDiff(): void {
    if (!rateDiff.party) return void toast.error('Pick the party')
    const amt = Number(rateDiff.amount) || 0
    if (amt <= 0) return void toast.error('Enter the rate-difference amount')
    const isDebtor = baseGroup(rateDiff.group) === 'Sundry Debtors'
    const partySide: 'dr' | 'cr' =
      rateDiff.direction === 'owes_more' ? (isDebtor ? 'dr' : 'cr') : (isDebtor ? 'cr' : 'dr')
    const otherSide: 'dr' | 'cr' = partySide === 'dr' ? 'cr' : 'dr'
    setLines([
      { side: partySide, account: rateDiff.party, group: rateDiff.group, amount: String(amt), allocs: [] },
      { side: otherSide, account: 'RATE DIFFERENCE A/C', group: 'Indirect Expenses', amount: String(amt), allocs: [] }
    ])
    toast.success(`${formatINR(amt)} rate difference posted ${rateDiff.direction === 'owes_more' ? 'against' : 'in favour of'} ${rateDiff.party}`)
  }

  // Close a sub-rupee Dr/Cr gap with the ROUND OFF ledger — Tally's Alt+R habit.
  function addRoundOffLine(): void {
    const diff = Math.round((totals.dr - totals.cr) * 100) / 100
    if (Math.abs(diff) < 0.005 || Math.abs(diff) >= 1) return
    setLines((p) => [
      ...p,
      { side: diff > 0 ? 'cr' : 'dr', account: 'ROUND OFF A/C', group: 'Indirect Expenses', amount: String(Math.abs(diff)), allocs: [] }
    ])
  }

  /**
   * Returns whether the voucher actually went in.
   *
   * It used to say nothing, which was fine while the only caller was the
   * Accept button — the screen itself showed the outcome. Switching voucher
   * type can now offer to save first, and that has to know: switching away
   * after a save that was refused would throw away the very work it offered
   * to keep.
   */
  async function saveVoucher(): Promise<boolean> {
    if (saving) return false
    {
      const altering = editingId != null || noteEditId != null
      const r = vchRights(vchType)
      if (altering ? !r.edit : !r.create) {
        toast.error(`You do not have rights to ${altering ? 'alter' : 'enter'} a ${vchLabel(vchType)} voucher`)
        return false
      }
    }
    let ok = false
    if (noteInvoiceMode) {
      if (!noteParty) {
        toast.error(`Select the ${notePartyKind}`)
        return false
      }
      // With quantity: keep lines that carry one, priced qty × rate. Without
      // quantity: keep lines that carry a value, sent with no qty (so they
      // never move stock) and the amount taken as entered.
      const items = noteWithQty
        ? noteItems.filter((it) => it.product_id && Number(it.qty) > 0 && Number(it.rate) > 0)
        : noteItems.filter((it) => Number(it.amount) > 0)
      if (!items.length) {
        toast.error(noteWithQty ? 'Add at least one item line (product, qty and rate)' : 'Add at least one line with an amount')
        return false
      }
      setSaving(true)
      try {
        const values = {
          note_type: vchType === 'DEBIT NOTE' ? 'debit' : 'credit',
          company_id: cid || undefined,
          party_type: notePartyKind,
          party_id: Number(noteParty),
          note_date: vchDate,
          gst_pct: Number(noteGst) || 0,
          narration: narration || null,
          against_invoice: noteInvoice || null,
          bargain_id: noteCanCreditBargain && noteBargain ? Number(noteBargain) : null,
          items: items.map((it) =>
            noteWithQty
              ? { product_id: Number(it.product_id), qty: Number(it.qty), rate: Number(it.rate) }
              : { product_id: it.product_id ? Number(it.product_id) : null, qty: 0, rate: 0, amount: Number(it.amount) || 0 }
          )
        }
        // Altering keeps the note's own number: the old voucher, ledger row and
        // item lines are reversed and re-posted from these values.
        const res =
          noteEditId != null
            ? await window.api.notes.update(noteEditId, values)
            : await window.api.notes.create(values)
        toast.success(
          noteEditId != null
            ? `${vchType} ${res.note_no} altered — ${formatINR(noteTotals.total)}`
            : `${vchType} ${res.note_no} accepted — ${formatINR(noteTotals.total)}${noteInvoice ? ` against ${noteInvoice}` : ' on account'}`
        )
        setNoteInvoice('')
        setNoteBargain('')
        setNoteItems([{ product_id: '', qty: '', rate: '' }])
        setNarration('')
        setRefsCache({})
        setLinkCache({})
        loadAccounts()
        if (noteEditId != null) {
          setNoteEditId(null)
          setNoteRowItems({})
          setScreen('notesreg', true)
          void loadNoteRegister()
        }
        ok = true
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setSaving(false)
      }
      return ok
    }
    // THE WEBSITE ENTERS A NOTE IN THE LEDGER GRID.
    //
    // A note line put on a purchase or sale ledger can carry a quantity, and a
    // quantity is what moves stock. So the moment any grid line has one, the
    // note is posted through the note machinery — which numbers it, writes the
    // party-ledger row, moves the stock and shows it in the register — rather
    // than as a plain journal. A money-only grid note (no quantity anywhere)
    // still posts the old way, unchanged.
    if (
      isNoteType &&
      !structured &&
      editingId == null &&
      // A note being altered always saves back through the note — even one
      // whose lines carry no quantity — or it would post as a fresh journal.
      (noteEditId != null || lines.some((l) => PRODUCT_LEDGER_GROUPS.includes(String(l.group)) && Number(l.qty) > 0))
    ) {
      // THE PARTY IS WHICHEVER PARTY LEDGER IS ON THE NOTE. A debit note is
      // usually a supplier's and a credit note a customer's, but not always —
      // a debit note can charge a customer, a credit note can refund a
      // supplier — so the ledger's own group says which, and the server finds
      // the master behind it (following a rename if it has had one).
      const partyLine =
        lines.find((l) => l.account && baseGroup(l.group) === (vchType === 'DEBIT NOTE' ? 'Sundry Creditors' : 'Sundry Debtors')) ||
        lines.find((l) => l.account && isBillwise(String(l.group)))
      if (!partyLine) {
        toast.error('Put the party on a line — a Sundry Creditors or Sundry Debtors ledger')
        return false
      }
      const partyKind: 'supplier' | 'customer' = baseGroup(partyLine.group) === 'Sundry Debtors' ? 'customer' : 'supplier'
      const itemLines = lines.filter(
        (l) => PRODUCT_LEDGER_GROUPS.includes(String(l.group)) && (Number(l.qty) > 0 || Number(l.amount) > 0)
      )
      const base = itemLines.reduce(
        (s, l) => s + (Number(l.qty) > 0 ? Math.round(Number(l.qty) * Number(l.rate) * 100) / 100 : Number(l.amount) || 0),
        0
      )
      // GST: the type and rate picked on the note, or — where the user typed a
      // GST ledger line of their own instead — its figure as a percent of base.
      // Every GST line counts — CGST and SGST are two lines, and taking only
      // the first read the rate as half of what it was.
      const gstLines = lines.filter((l) => l.group === 'Duties & Taxes' && /GST/i.test(String(l.account)))
      const gstAmt = gstLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
      const typedGstType = gstLines.some((l) => /IGST/i.test(String(l.account)))
        ? 'IGST'
        : gstLines.some((l) => /CGST|SGST/i.test(String(l.account)))
          ? 'CGST_SGST'
          : undefined
      const gstPct = gridGst.active
        ? gridGst.pct
        : base > 0 && gstAmt > 0
          ? Math.round((gstAmt / base) * 10000) / 100
          : 0
      setSaving(true)
      try {
        // A stock note is numbered by the note register, so the Reference
        // typed on the screen has no number field to go to there — it goes at
        // the head of the narration instead of being dropped.
        // (Altering keeps the note's own number, so nothing is prefixed.)
        const refNo = noteEditId != null ? '' : vchNo.trim()
        const noteValues = {
          note_type: vchType === 'DEBIT NOTE' ? 'debit' : 'credit',
          company_id: cid || undefined,
          party_type: partyKind,
          party_name: partyLine.account,
          party_group: partyLine.group,
          against_account: itemLines[0]?.account || undefined,
          note_date: vchDate,
          gst_pct: gstPct,
          // Named when picked; otherwise read off the GST lines typed, and
          // failing that the posting decides it from the original invoice.
          gst_type: gridGst.active ? noteGstType : typedGstType,
          // An altered credit note keeps the sales bargain it credited back.
          ...(noteEditId != null ? { bargain_id: noteBargain ? Number(noteBargain) : null } : {}),
          narration: [refNo ? `Ref ${refNo}` : '', narration.trim()].filter(Boolean).join(' · ') || null,
          // The party line's bill-wise split — Agst Ref against the invoices
          // picked. It was dropped on this path, so a stock note always landed
          // On Account whatever the panel said.
          allocs: (partyLine.allocs || [])
            .filter((a) => Number(a.amount) > 0)
            .map((a) => ({
              method: a.method,
              ref_name: a.ref_name || null,
              order_id: a.order_id || null,
              sale_invoice_group: a.sale_invoice_group || null,
              amount: Number(a.amount)
            })),
          items: itemLines.map((l) =>
            Number(l.qty) > 0
              ? { product_id: l.product_id ? Number(l.product_id) : null, qty: Number(l.qty), rate: Number(l.rate) }
              : { product_id: l.product_id ? Number(l.product_id) : null, qty: 0, rate: 0, amount: Number(l.amount) || 0 }
          )
        }
        if (noteEditId != null) {
          // The note is reversed and re-posted from these lines: its voucher,
          // the party ledger row, the bill-wise split and the stock follow.
          const res = await window.api.notes.update(noteEditId, noteValues)
          toast.success(`${vchLabel(vchType)} ${String(res.note_no)} altered — dues and stock updated`)
          setNoteEditId(null)
          setNoteBargain('')
          setVchNo('')
          setVchCode('')
          setNarration('')
          resetNoteGst()
          setLines(blankLines(vchType))
          setRefsCache({})
          setLinkCache({})
          loadAccounts()
          setScreen('notesreg', true)
          void loadNoteRegister()
          return true
        }
        const res = await window.api.notes.create(noteValues)
        if (__WEB__) {
          const total = gridGst.partyTarget ?? base
          const count = itemLines.length + 1 + (gridGst.active ? gridGst.virtual.length : 0)
          setPostedMsg(`Posted ${String(res.note_no)} — ${formatINR(total)} across ${count} ledgers, stock moved.`)
          setPostedSeq((x) => x + 1)
        } else toast.success(`${vchType} ${res.note_no} accepted — stock moved`)
        setVchNo('')
        setNarration('')
        resetNoteGst()
        setLines(blankLines(vchType))
        setRefsCache({})
        setLinkCache({})
        loadAccounts()
        ok = true
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setSaving(false)
      }
      return ok
    }
    setSaving(true)
    try {
      const structuredLines = (): Row[] => {
        const party = payLines.filter((l) => l.account && Number(l.amount) > 0)
        if (!party.length) throw new Error('Add at least one party line')
        const money = payAccounts.filter((l) => l.account)
        if (!money.length) throw new Error(`Pick the cash or bank account the money ${vchType === 'PAYMENT' ? 'goes out of' : 'comes into'}`)
        const total = party.reduce((s, l) => s + Number(l.amount), 0)
        // One account: it always carries the whole total, same as before this
        // could split — no need to type an amount that could only ever be one
        // value. More than one: each carries what was actually typed, and
        // together they must add up to the party side.
        const moneyAmounts =
          money.length === 1
            ? [total]
            : money.map((l) => Number(l.amount) || 0)
        if (money.length > 1) {
          const moneySum = moneyAmounts.reduce((s, x) => s + x, 0)
          if (Math.abs(moneySum - total) > 0.005) {
            throw new Error(`The split across accounts (${moneySum.toFixed(2)}) does not add up to the total (${total.toFixed(2)})`)
          }
        }
        return [
          ...party.map((l) => ({
            account: l.account,
            group: l.group || undefined,
            dr: vchType === 'PAYMENT' ? Number(l.amount) : 0,
            cr: vchType === 'RECEIPT' ? Number(l.amount) : 0,
            allocs: l.allocs
              .filter((a) => Number(a.amount) > 0)
              .map((a) => ({ method: a.method, ref_name: a.ref_name || null, order_id: a.order_id || null, sale_invoice_group: a.sale_invoice_group || null, amount: Number(a.amount) }))
          })),
          ...money.map((l, i) => ({
            account: l.account,
            group: l.group || undefined,
            dr: vchType === 'RECEIPT' ? moneyAmounts[i] : 0,
            cr: vchType === 'PAYMENT' ? moneyAmounts[i] : 0
          }))
        ]
      }
      const payload = {
        date: vchDate,
        vchType,
        vchNo: vchNo || null,
        narration: narration || null,
        companyId: cid || undefined,
        lines: structured
          ? structuredLines()
          : lines
              .filter((l) => l.account && Number(l.amount) > 0)
              .map((l) => ({
                account: l.account,
                group: l.group || undefined,
                dr: l.side === 'dr' ? Number(l.amount) : 0,
                cr: l.side === 'cr' ? Number(l.amount) : 0,
                // The bill picked, by its own id — not only its number, which
                // the server would otherwise look up again and could match to
                // a second invoice carrying the same number.
                allocs: l.allocs
                  .filter((a) => Number(a.amount) > 0)
                  .map((a) => ({
                    method: a.method,
                    ref_name: a.ref_name || null,
                    order_id: a.order_id || null,
                    sale_invoice_group: a.sale_invoice_group || null,
                    amount: Number(a.amount)
                  })),
                // The working behind this figure, where one was written.
                splits: (l.splits || [])
                  .filter((sp) => String(sp.name || '').trim() || Number(sp.amount) > 0)
                  .map((sp) => ({ name: String(sp.name || '').trim(), amount: Number(sp.amount) || 0 }))
              }))
              // The GST and round-off the note panel worked out.
              .concat(
                gridGst.active
                  ? gridGst.virtual.map((v) => ({
                      account: v.account,
                      group: v.group,
                      dr: v.side === 'dr' ? v.amount : 0,
                      cr: v.side === 'cr' ? v.amount : 0,
                      allocs: [],
                      splits: []
                    }))
                  : []
              )
      }
      if (editingId != null) {
        await window.api.vouchers.update(editingId, payload)
        toast.success('Voucher altered')
        setEditingId(null)
        setScreen('daybook', true)
      } else {
        const made = await window.api.vouchers.create(payload)
        if (__WEB__) {
          // Said on the screen, with the number it was given, rather than in a
          // toast that is gone before it is read.
          const got = await window.api.vouchers.get(Number(made?.id)).catch(() => null)
          const posted = payload.lines as Row[]
          const total = posted.reduce((t, l) => t + (Number(l.dr) || 0), 0)
          const count = new Set(posted.map((l) => String(l.account))).size
          setPostedMsg(
            `Posted ${String(got?.code || `${typeLabelOf(vchType)} voucher`)} — ${formatINR(total)} across ${count} ${count === 1 ? 'ledger' : 'ledgers'}.`
          )
          setPostedSeq((x) => x + 1)
        } else toast.success(`${vchType} voucher accepted`)
        // Tally stays in the entry screen, ready for the next voucher.
        setVchNo('')
        setNarration('')
        resetNoteGst()
        setLines(blankLines(vchType))
        setPayLines([blankPayLine()])
        setRefsCache({})
        setLinkCache({})
      }
      loadAccounts()
      ok = true
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
    return ok
  }

  /**
   * A LETTER OF CREDIT IS A DOCUMENT TOO.
   *
   * An LC's postings reach the ledger as journals — LC PAYABLE, LC MARGIN, the
   * interest — and journals carry no order_id or sale_id, so the click fell
   * through to openForAlter. That fetches the voucher and, for anything the
   * app posted itself, shows it read-only; where the fetch came back empty it
   * returned in silence and the row simply did nothing, which is what was
   * being reported.
   *
   * These lines do name their source, just not by id: the bill-wise allocation
   * carries the LC's own number as its reference. That is enough to find it.
   * Matched token by token rather than by substring — "LC-1" must not answer
   * for "LC-11" — and only looked up when a row has nothing better, so an
   * ordinary ledger never fetches the register at all.
   */
  async function openLineSource(l: Row, here: { screen: string; ledgerId: number | null; companyId?: number }): Promise<void> {
    // WHERE AN LC ACTUALLY WRITES ITS NUMBER.
    //
    // The first version of this read bill-wise references only, and an LC's
    // own postings carry none at all — no allocation, nothing to match — so
    // every LC row skipped the lookup and fell through to the voucher fetch.
    // The number is in the voucher number and in the narration instead
    // ("LC-5", "LC LC-5 — SOUTH INDIAN BANK charged 1180.00"), which is where
    // the ledger has been printing it in the Ref no column all along.
    //
    // THE LINK IS RECORDED. IT WAS NEVER A MATTER FOR GUESSWORK.
    //
    // Every LC voucher is named by the row that wrote it — the LC's own
    // journal_entry_id, or one of its issuances, repayments or payment-ins —
    // so the statement carries lc_id and the click follows it exactly.
    //
    // It used to read the LC NUMBER out of the narration and match it against
    // the register. Two things were wrong with that. lc.list() is scoped to the
    // APP's active company while the ledger is read in whichever book the
    // Accounting selector is on, so a KR FOODS ledger matched against KR
    // FINMARK's letters. And an LC number does not identify an LC: this book
    // holds LC-1 through LC-8 TWICE in one company, so the match took whichever
    // the register returned first — the newest, by id — and half of them opened
    // the wrong letter.
    if (l.lc_id && onOpenRecord) return onOpenRecord('lc', Number(l.lc_id), here)

    // No recorded link. Rather than open a letter that might be the wrong one,
    // say what the row names and let the reader go to it themselves — a
    // confident jump to the wrong LC is worse than no jump.
    const named = facilityRef(l)
    if (named?.kind === 'LC') {
      toast.info(
        `This voucher mentions ${named.no} but is not linked to a letter of credit — open it from Treasury to be sure of which one.`
      )
    }
    await openForAlter({ id: l.entry_id ?? l.id })
  }

  /**
   * A PURCHASE VOUCHER IS A PURCHASE BILL, AND IT HAS A PAGE.
   *
   * The desktop ledger has opened documents for a while — a row carrying an
   * order_id goes to Purchases, a sale_id to Sales. The web ledger and the web
   * Day Book never did: every row went straight to openForAlter, which for an
   * auto-posted voucher shows a read-only copy of the journal. So clicking a
   * purchase in the Day Book produced a box of debits and credits rather than
   * the bill, and there was no way through to the document at all.
   *
   * Same rule in both places now. Only a voucher with no document behind it —
   * a manual journal, a contra — has nothing better to show than itself.
   */
  // Note where the ledger is before a line leaves for its document.
  function rememberLedger(): void {
    if (screen !== 'ledger') return
    lgMemo = {
      ledgerId: ledgerId ?? null,
      view: lgView,
      bills: lgBills,
      monthly: lgMonthly,
      detailed: lgDetailed,
      condensed: lgCondensed,
      bwDetailed,
      bwSel,
      bwFlip: [...bwFlip]
    }
  }

  function openRowSource(r: Row, ledger: number | null): void {
    rememberLedger()
    // FROM AN OPEN VOUCHER, the way back is the voucher — over the screen it
    // was opened from (Tally File Updation, a ledger, the Day Book), not the
    // bare voucher screen, which comes back empty with nowhere for Esc to go.
    const fromVoucher = screen === 'voucher'
    const backScreen = fromVoucher ? String(viewOnly?.back || alterBack || 'gateway') : screen
    const backVoucher = fromVoucher ? Number(viewOnly?.id || editingId || 0) || null : null
    // WHICH BOOK TO OPEN IT IN.
    //
    // The document's own, where the row says — an inter-company transfer can
    // post its voucher in one company while the purchase belongs to the other,
    // and sent to the ledger's book instead the page opens somewhere the bill
    // does not exist and the click reads as broken. Otherwise the book this
    // ledger is being read in, which is the same thing nearly every time.
    const here = (own: unknown): { screen: string; ledgerId: number | null; companyId: number; voucherId: number | null } => ({
      screen: backScreen,
      ledgerId: ledger,
      companyId: Number(own) || cid,
      voucherId: backVoucher
    })
    // A TRADING DEAL BEFORE ITS HALVES.
    //
    // A trading purchase and the sale it was bought for are one deal, and the
    // deal is where the pair and the margin between them are readable. Opening
    // the purchase page instead shows one side of a two-sided thing.
    if (r.trading_deal_id && onOpenRecord)
      return onOpenRecord('trading', Number(r.trading_deal_id), here(null))
    if (r.order_id && onOpenRecord) return onOpenRecord('orders', Number(r.order_id), here(r.order_company_id))
    if (r.sale_id && onOpenRecord) return onOpenRecord('sales', Number(r.sale_id), here(r.sale_company_id))
    // Neither an LC nor a discounted bill is a page of its own — Treasury
    // opens the one it is handed, on the tab that holds it.
    if (r.lc_id && onOpenRecord) return onOpenRecord('lc', Number(r.lc_id), here(null))
    if (r.bd_id && onOpenRecord) return onOpenRecord('bd', Number(r.bd_id), here(null))
    void openLineSource(r, here(null))
  }

  /**
   * IS THERE A DOCUMENT BEHIND THIS LINE, AND WHAT IS IT CALLED.
   *
   * The Ref no column has always printed a document's number. Now it opens it,
   * so it has to know whether there is one — a manual journal has a reference
   * and no page to go to, and a reference that looks clickable and does
   * nothing is worse than one that never offered.
   */
  function docTarget(r: Row): { label: string; what: string } | null {
    if (!onOpenRecord) return null
    if (r.trading_deal_id) return { label: 'Trading', what: 'this trading deal' }
    if (r.order_id) return { label: 'Purchase', what: 'this purchase in Purchases' }
    if (r.sale_id) return { label: 'Sales', what: 'this invoice in Sales' }
    if (r.lc_id) return { label: 'LC', what: `${String(r.lc_no || 'this letter of credit')} in Treasury` }
    if (r.bd_id) return { label: 'BD', what: `${String(r.bd_no || 'this discounted bill')} in Treasury` }
    return null
  }

  // What a row's click will do, said before it is clicked.
  function rowSourceTitle(r: Row): string {
    const t = docTarget(r)
    if (t) return `Open ${t.what}`
    return `Open ${String(r.vch_type || 'this voucher')}${r.vch_no ? ` ${String(r.vch_no)}` : ''}`
  }

  /** What the ROW click does now: the voucher, as it was posted. */
  function voucherTitle(r: Row): string {
    return `Show this voucher as it was posted${
      docTarget(r) ? ' — click the Ref no to open the document itself' : ''
    }`
  }

  // ── ALTERING A VOUCHER A DOCUMENT WROTE ─────────────────────────────────
  // Every voucher but a purchase or a sale can be altered. Each goes through
  // its document (src/main/voucherAlter.ts): a note or LC or discounted bill
  // opens in its own editor; a BD repayment or payment in — which had no
  // editor — is altered in the form below, which reverses and re-records it in
  // one step so the bill's dues, the facility and the party balances follow.
  // `initial` is the form as it opened, so Esc can tell an untouched one
  // (closes at once) from an edited one (asks for a second Esc).
  const [alterDlg, setAlterDlg] = useState<{ entryId: number; vchType: string; info: Row; values: Row; initial?: string } | null>(null)
  const [alterBusy, setAlterBusy] = useState(false)
  const canAlterOwned = (v: Row | null): boolean =>
    !!v && !v.manual && !['order', 'sale'].includes(String((v.owner as Row | null)?.kind || '')) && vchRights(String(v.vch_type)).edit

  async function startAlterOwned(v: Row): Promise<void> {
    const entryId = Number(v.id)
    if (!vchRights(String(v.vch_type)).edit) {
      return void toast.error(`You do not have rights to alter a ${vchLabel(String(v.vch_type))} voucher`)
    }
    let info: Row
    try {
      info = await window.api.vouchers.alterInfo(entryId)
    } catch (e) {
      return void toast.error(errText(e))
    }
    const mode = String(info.mode)
    if (mode === 'locked') return void toast.info(String(info.reason))
    if (mode === 'note') {
      const list: Row[] = await window.api.notes.list(cid || undefined).catch(() => [] as Row[])
      const r = list.find((x) => Number(x.id) === Number(info.note_id))
      if (!r) return void toast.error('That note could not be found in this company')
      setViewRow(null)
      if (__WEB__) {
        const full = await window.api.vouchers.get(Number(v.id))
        if (full) await openNoteInGrid(r, full)
      } else {
        setViewOnly(null)
        await openNoteForAlter(r)
      }
      return
    }
    if (mode === 'freight' || mode === 'waiver') {
      setViewRow(null)
      setViewOnly(null)
      setScreen(String(info.side) === 'sale' ? 'tfsal' : 'tfpur')
      toast.info(
        mode === 'freight'
          ? 'A transporter bill is changed here: remove it and raise it again — its voucher and the freight dues follow.'
          : 'A waived shortage is changed here: un-waive it and waive it again.'
      )
      return
    }
    if (mode === 'lc' || mode === 'bd') {
      toast.info(String(info.hint))
      setViewRow(null)
      openRowSource({ lc_id: mode === 'lc' ? info.lc_id : null, bd_id: mode === 'bd' ? info.bd_id : null }, ledgerId)
      return
    }
    if (mode === 'form') {
      const r = (info.row as Row) || {}
      const values: Row =
        info.form === 'bd_repayment'
          ? {
              repay_date: String(r.repay_date || '').slice(0, 10),
              amount: r.amount ?? '',
              comm_charges: r.comm_charges ?? '',
              bank_charges: r.bank_charges ?? '',
              bank_account: r.bank_account ?? '',
              ref: r.ref ?? '',
              note: r.note ?? ''
            }
          : info.form === 'bd_payment_in'
            ? { date: String(r.pay_date || '').slice(0, 10), amount: r.amount ?? '', method: r.method ?? '', account: r.account ?? '', ref: r.ref_no ?? '' }
            : { date: String(r.pay_date || '').slice(0, 10), amount: r.amount ?? '' }
      setAlterDlg({ entryId, vchType: String(v.vch_type), info, values, initial: JSON.stringify(values) })
      return
    }
    toast.info('This voucher was entered by hand — alter it directly.')
  }

  async function saveAlterOwned(): Promise<void> {
    if (!alterDlg || alterBusy) return
    setAlterBusy(true)
    try {
      await window.api.vouchers.alterOwned(alterDlg.entryId, alterDlg.values)
      toast.success('Voucher altered — the dues and balances behind it are updated')
      setAlterDlg(null)
      setViewRow(null)
      if (viewOnly) {
        const back = String(viewOnly.back || '') as Screen
        setViewOnly(null)
        setScreen(back && back !== 'voucher' ? back : 'daybook', true)
      }
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setAlterBusy(false)
    }
  }

  // A note, laid back out in the grid it was entered in: the party line with
  // its bill-wise split, one product line per item (qty × rate, or the amount
  // for a money-only line), and the GST / round-off lines as posted.
  async function openNoteInGrid(nr: Row, v: Row): Promise<void> {
    let its: Row[] = []
    try {
      its = await window.api.notes.items(Number(nr.id))
    } catch {
      its = []
    }
    const t: VchType = String(nr.note_type) === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE'
    resetNoteGst()
    setViewRow(null)
    setViewOnly(null)
    setEditingId(null)
    setAlterBack(screen === 'voucher' ? null : screen)
    setNoteEditId(Number(nr.id))
    setNoteBargain(nr.bargain_id == null ? '' : String(nr.bargain_id))
    setVchType(t)
    setVchDate(String(nr.note_date || v.entry_date || todayISO()).slice(0, 10))
    // The note's number shows on the number card; the Reference box is for a
    // party's own reference, and is left empty.
    setVchNo('')
    setVchCode(String(nr.note_no || ''))
    setPostedMsg(null)
    setNarration(String(nr.narration || ''))
    const vLines = orderVoucherLines((v.lines as Row[]) || [], (l) => ({
      account: String(l.account),
      dr: Number(l.dr) > 0,
      tax: isTaxLine(String(l.account), String(l.acc_group || '')),
      amount: Number(l.dr) || Number(l.cr) || 0
    }))
    const out: VLine[] = []
    let itemsPlaced = false
    for (const l of vLines) {
      const side: 'dr' | 'cr' = Number(l.dr) > 0 ? 'dr' : 'cr'
      const group = String(l.acc_group || '')
      const base: VLine = {
        side,
        account: String(l.account),
        group,
        amount: String(Number(l.dr) > 0 ? l.dr : l.cr),
        allocs: ((l.allocs as Row[]) || []).map((a) => ({
          method: String(a.method) as AllocRow['method'],
          ref_name: String(a.ref_name || ''),
          order_id: a.order_id != null ? Number(a.order_id) : null,
          sale_invoice_group: a.sale_invoice_group || null,
          amount: String(a.amount)
        }))
      }
      if (PRODUCT_LEDGER_GROUPS.includes(group) && its.length && !itemsPlaced) {
        for (const it of its) {
          const withQty = Number(it.qty) > 0
          out.push({
            ...base,
            allocs: [],
            amount: String(Number(it.amount) || Math.round(Number(it.qty) * Number(it.rate) * 100) / 100),
            product_id: it.product_id != null ? Number(it.product_id) : null,
            qty: withQty ? String(it.qty) : '',
            rate: withQty ? String(it.rate) : ''
          })
        }
        itemsPlaced = true
        continue
      }
      out.push(base)
    }
    setLines(out)
    for (const l of vLines) if (isBillwise(String(l.acc_group))) void loadRefs(String(l.account))
    setNoteMode(false)
    setRawAlter(false)
    setScreen('voucher')
  }

  // BACK FROM A DRILL-THROUGH THAT LEFT FROM AN OPEN VOUCHER: once the book
  // is chosen, open that voucher again over the screen it came from.
  useEffect(() => {
    const id = pendingVoucherRef.current
    if (!id || !cid) return
    pendingVoucherRef.current = null
    void openForAlter({ id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  async function openForAlter(row: Row): Promise<void> {
    const v = await window.api.vouchers.get(Number(row.id))
    if (!v) {
      // It used to return here without a word, so a row that could not be
      // opened was indistinguishable from a row that ignored the click.
      // The id is named: a message that cannot be traced to a row is one
      // nobody can act on, and this is the second thing to go wrong here.
      toast.error(
        `Voucher #${Number(row.id) || '?'} could not be opened — it may have been re-posted or deleted since this statement was drawn. Reload the ledger.`
      )
      return
    }
    // A NOTE ENTERED IN ACCOUNTING IS EDITED HERE, DIRECTLY.
    //
    // It belongs to the note register (it numbers it, moves stock, writes the
    // party ledger), which is why it used to open view-only. It opens straight
    // into its editor now — the grid on the website, the note editor on the
    // desktop — and is saved back through the note, so all of that follows.
    if (!v.manual && String((v.owner as Row | null)?.kind || '') === 'note' && vchRights(String(v.vch_type)).edit) {
      const list: Row[] = await window.api.notes.list(cid || undefined).catch(() => [] as Row[])
      const nr = list.find((x) => Number(x.id) === Number((v.owner as Row).id))
      if (nr) {
        if (__WEB__) await openNoteInGrid(nr, v)
        else await openNoteForAlter(nr)
        return
      }
    }
    // The desktop keeps its small read-only box; the website opens the voucher
    // itself, view only.
    // One they may not alter (its type's Edit is off) opens as one they may
    // only read, the way a posted invoice's voucher does.
    const viewing = !v.manual || !vchRights(String(v.vch_type)).edit
    if (viewing && !__WEB__) {
      setViewRow(v)
      return
    }
    setViewOnly(viewing ? { ...v, back: screen } : null)
    setEditingId(viewing ? null : Number(v.id))
    setAlterBack(viewing || screen === 'voucher' ? null : screen)
    setNoteEditId(null)
    // A sale or purchase voucher is not one of the entry types this screen
    // offers; it is laid out as the plain Dr/Cr grid, its own type named in
    // the banner above it.
    const t = viewing
      ? ((VCH_TYPES.some((x) => x.key === String(v.vch_type)) ? String(v.vch_type) : 'JOURNAL') as VchType)
      : (String(v.vch_type) as VchType) || 'JOURNAL'
    setVchType(t)
    setVchDate(String(v.entry_date))
    setVchNo(String(v.vch_no || ''))
    setVchCode(String(v.code || ''))
    setPostedMsg(null)
    setNarration(String(v.narration || ''))
    const vLines = orderVoucherLines(v.lines as Row[], (l) => ({
      account: String(l.account),
      dr: Number(l.dr) > 0,
      tax: isTaxLine(String(l.account), String(l.acc_group || '')),
      amount: Number(l.dr) || Number(l.cr) || 0
    }))
    setLines(
      vLines.map((l) => ({
        side: Number(l.dr) > 0 ? 'dr' : 'cr',
        account: String(l.account),
        group: String(l.acc_group || ''),
        amount: String(Number(l.dr) > 0 ? l.dr : l.cr),
        allocs: ((l.allocs as Row[]) || []).map((a) => ({
          method: String(a.method) as AllocRow['method'],
          ref_name: String(a.ref_name || ''),
          order_id: a.order_id != null ? Number(a.order_id) : null,
          sale_invoice_group: a.sale_invoice_group || null,
          amount: String(a.amount)
        })),
        // The working comes back with the voucher, so altering one does not
        // quietly drop the explanation it was saved with.
        splits: ((l.splits as Row[]) || []).map((sp) => ({
          name: String(sp.name || ''),
          amount: String(sp.amount ?? ''),
          note: sp.note ? String(sp.note) : undefined
        }))
      }))
    )
    for (const l of vLines) if (isBillwise(String(l.acc_group))) void loadRefs(String(l.account))
    setNoteMode(false)
    // Payment/receipt vouchers whose money side is all cash/bank reopen in the
    // Tally format (one line or a split across several), bill-wise details
    // included; anything else falls back to the plain Dr/Cr grid.
    if (t === 'PAYMENT' || t === 'RECEIPT') {
      const moneySide = t === 'PAYMENT' ? 'cr' : 'dr'
      const money = vLines.filter((l) => Number(moneySide === 'cr' ? l.cr : l.dr) > 0 && CASH_BANK_GROUPS.includes(String(l.acc_group)))
      const parties = vLines.filter((l) => Number(moneySide === 'cr' ? l.dr : l.cr) > 0)
      if (money.length >= 1 && parties.length >= 1) {
        setPayAccounts(
          money.map((l) => ({
            account: String(l.account),
            group: String(l.acc_group || ''),
            amount: String(Number(moneySide === 'cr' ? l.cr : l.dr)),
            allocs: []
          }))
        )
        setPayLines(
          parties.map((l) => ({
            account: String(l.account),
            group: String(l.acc_group || ''),
            amount: String(Number(moneySide === 'cr' ? l.dr : l.cr)),
            allocs: ((l.allocs as Row[]) || []).map((a) => ({
              method: String(a.method) as AllocRow['method'],
              ref_name: String(a.ref_name || ''),
              order_id: a.order_id != null ? Number(a.order_id) : null,
              sale_invoice_group: a.sale_invoice_group || null,
              amount: String(a.amount)
            }))
          }))
        )
        for (const l of parties) void loadRefs(String(l.account))
        setRawAlter(false)
      } else {
        setRawAlter(true)
      }
    } else {
      setRawAlter(false)
    }
    // View only shows every line exactly as posted. The payment/receipt
    // layout keeps only the money and party lines, so an interest leg on a
    // disbursement would drop out of sight there.
    if (viewing) setRawAlter(true)
    setScreen('voucher')
  }

  async function deleteVoucher(): Promise<void> {
    if (editingId == null && noteEditId == null) return
    if (!vchRights(vchType).delete) {
      toast.error(`You do not have rights to delete a ${vchLabel(vchType)} voucher`)
      return
    }
    // A note goes through the note register, which reverses its voucher, its
    // party-ledger row and any stock it moved.
    if (noteEditId != null) {
      if (!confirm(`Delete ${vchLabel(vchType)} ${vchCode}? Its voucher, ledger entry and any stock it moved are reversed.`)) return
      try {
        await window.api.notes.remove(noteEditId, cid)
        toast.success(`${vchLabel(vchType)} ${vchCode} deleted`)
        setNoteEditId(null)
        setNoteBargain('')
        setVchNo('')
        setVchCode('')
        setNarration('')
        setLines(blankLines(vchType))
        loadAccounts()
        setScreen('notesreg', true)
        void loadNoteRegister()
      } catch (e) {
        toast.error((e as Error).message)
      }
      return
    }
    if (editingId == null || !confirm('Delete this voucher?')) return
    try {
      await window.api.vouchers.remove(editingId)
      toast.success('Voucher deleted')
      setEditingId(null)
      setScreen('daybook', true)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function createLedger(): Promise<void> {
    if (!newLedger) return
    if (!rightsIn('accountsMasters').create) return void toast.error('You do not have rights to create a ledger (Accounting · Masters)')
    const name = newLedger.name.trim().toUpperCase()
    if (!name) return void toast.error('Type the ledger name')
    if (!newLedger.group) return void toast.error('Pick the group')
    try {
      // The ledger materialises through the voucher line's group on first use;
      // creating it here just registers it immediately for picking.
      await window.api.journal.createAccount(name, newLedger.group, cid)
      await loadAccounts()
      if (newLedger.target === 'payAccount' && newLedger.index != null)
        setPayAccountLine(newLedger.index, { account: name, group: newLedger.group })
      else if (newLedger.target === 'payLine' && newLedger.index != null)
        setPayLine(newLedger.index, { account: name, group: newLedger.group })
      else if (newLedger.forLine != null) setLine(newLedger.forLine, { account: name, group: newLedger.group })
      toast.success(`Ledger ${name} created under ${newLedger.group}`)
      setNewLedger(null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ------- keyboard: Tally function keys -------
  // WHAT CAME IN AND WHAT WENT OUT, on the same day as the vouchers.
  //
  // A day book in a mill is not only money: the gate is where the day's work
  // actually shows, and a voucher list with no material beside it answers half
  // the question. Loaded only on this screen, and only for the period on it.
  const [dayGate, setDayGate] = useState<Row[]>([])
  useEffect(() => {
    if (!__WEB__ || screen !== 'daybook') return
    let dead = false
    void window.api.gate
      .list()
      .then((rows) => {
        if (dead) return
        setDayGate(
          rows.filter((g) => {
            const d = String(g.entry_date || '').slice(0, 10)
            if (dbFrom && d < dbFrom) return false
            if (dbTo && d > dbTo) return false
            return true
          })
        )
      })
      .catch(() => setDayGate([]))
    return () => {
      dead = true
    }
  }, [screen, dbFrom, dbTo, cid])

  // THE DAY BOOK'S KEYS. ↑ ↓ walk the vouchers on screen — the drawer opens on
  // the first press and follows — Enter opens the document behind the one
  // open, F8 the summary, Esc closes the drawer or the summary. The page's own
  // handler stands aside while either is open (they are overlays), so this is
  // the one that answers.
  useEffect(() => {
    if (!__WEB__ || screen !== 'daybook') {
      setDbSel(null)
      setDbSum(null)
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (el?.closest?.('[data-radix-popper-content-wrapper]')) return
      if (e.key === 'Escape') {
        if (dbSum) {
          e.preventDefault()
          setDbSum(null)
        } else if (dbSel != null) {
          e.preventDefault()
          setDbSel(null)
        }
        return
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'F8') {
        e.preventDefault()
        if (dbSum) setDbSum(null)
        else dbSumBtnRef.current?.click()
        return
      }
      if (dbSum) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = dbVisRef.current
        if (!list.length) return
        e.preventDefault()
        const at = list.findIndex((r) => Number(r.id) === dbSel)
        const to = e.key === 'ArrowDown' ? Math.min(list.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)
        setDbSel(Number(list[to].id))
        // Keep the row in view under the drawer's edge.
        requestAnimationFrame(() =>
          dbScrollRef.current?.querySelector(`[data-db-row="${Number(list[to].id)}"]`)?.scrollIntoView({ block: 'nearest' })
        )
        return
      }
      if (e.key === 'Enter' && dbSel != null) {
        const r = dbVisRef.current.find((x) => Number(x.id) === dbSel)
        if (r) {
          e.preventDefault()
          setDbSel(null)
          openRowSource(r, null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, dbSel, dbSum])

  // WHAT THE GATEWAY KNOWS BEFORE YOU PICK A SCREEN.
  //
  // Four figures and a count on every card, so the way in already answers "is
  // there anything to do here" — a menu of eleven names cannot. Read once when
  // the gateway is shown and thrown away on the way out: this is a summary, not
  // a screen's data, and every screen still loads its own.
  const [gwSum, setGwSum] = useState<Row | null>(null)
  useEffect(() => {
    if (!__WEB__ || screen !== 'gateway' || !cid) return
    let dead = false
    void (async () => {
      const [vs, tbal, obs] = await Promise.all([
        // Counts and turnover only — not the Day Book itself.
        window.api.vouchers.summary({ from: dbFrom || undefined, to: dbTo || undefined, companyId: cid }).catch(() => null),
        window.api.journal
          .trialBalance({ from: tbFrom || undefined, to: tbTo || undefined, companyId: cid })
          .catch(() => null),
        // Whether the opening balances are in — the Openings screen loads its
        // own, but the gateway has to be able to say so without it.
        window.api.journal.openings(cid).catch(() => null)
      ])
      const ob = obs
        ? {
            from: String((obs as Row).books_from || ''),
            any: (((obs as Row).rows as Row[]) || []).some((r) => Math.abs(n(r.dr)) + Math.abs(n(r.cr)) > 0.004)
          }
        : null
      if (!dead) setGwSum({ vouchers: vs, tb: tbal, ob })
    })()
    return () => {
      dead = true
    }
  }, [screen, cid, dbFrom, dbTo, tbFrom, tbTo])

  const GATEWAY_ITEMS = useMemo(
    () => [
      { key: 'V', label: 'Accounting Vouchers', icon: ScrollText, go: () => openVoucher(firstVch() || 'PAYMENT') },
      { key: 'P', label: 'Purchase Register', icon: PackageSearch, go: () => setScreen('purchreg') },
      { key: 'S', label: 'Sales Register', icon: Receipt, go: () => setScreen('salesreg') },
      { key: 'D', label: 'Day Book', icon: BookOpenText, go: () => setScreen('daybook') },
      // Two registers, one screen: each opens the notes of its own kind.
      {
        key: 'N',
        label: 'Debit Notes',
        icon: FileText,
        go: () => {
          setNoteKindFilter('debit')
          setScreen('notesreg')
        }
      },
      {
        key: 'C',
        label: 'Credit Notes',
        icon: FileText,
        go: () => {
          setNoteKindFilter('credit')
          setScreen('notesreg')
        }
      },
      { key: 'R', label: 'Fr. Inward Working', icon: Truck, go: () => setScreen('tfpur') },
      { key: 'O', label: 'Fr. Outward Working', icon: Truck, go: () => setScreen('tfsal') },
      { key: 'L', label: 'Ledger Accounts', icon: Wallet, go: () => setScreen('ledger') },
      { key: 'T', label: 'Trial Balance', icon: Scale, go: () => setScreen('trial') },
      { key: 'B', label: 'Opening Balances', icon: Landmark, go: () => setScreen('openings') },
      // Every voucher opened up on one page — see CashflowRegister.
      { key: 'F', label: 'Cashflow Register', icon: ArrowLeftRight, go: () => setScreen('cashflow') },
      // Payments, receipts and contra, one bank at a time if wanted.
      { key: 'Y', label: 'Payment / Receipt Register', icon: Banknote, go: () => setScreen('payreg') },
      ...(__WEB__
        ? [
            { key: 'M', label: 'Masters', icon: FolderTree, go: () => setScreen('masters') },
            { key: 'U', label: 'Tally File Updation', icon: FileSpreadsheet, go: () => setScreen('tallyimport') }
          ]
        : [])
    ].sort((a, b) => {
      // The website draws the gateway in four sections — Enter, Registers,
      // Workings, Reports & masters — so ↑ ↓ walks it in that order. The desktop list
      // keeps its own.
      if (!__WEB__) return 0
      const ORDER = 'VDBPSNCYROLTFMU'
      return ORDER.indexOf(a.key) - ORDER.indexOf(b.key)
    }).filter((g) => (g.key === 'V' ? !!firstVch() : mayScreen(GATE_SCREEN[g.key]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.defaultPrevented) return
      if (hasOpenOverlay()) return
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      // Which function key this is, on either keyboard — see fKeyOf. A Mac
      // sends Control and a digit, because its top row belongs to the system.
      const fk = fKeyOf(e)
      // The bill-wise view's own keys, before the ledger's — there ↑ ↓ walk the
      // bills rather than the ledgers. Alt F1 is Detailed; Alt F5 stays the
      // way to Columnar, as it is from every other view of a statement.
      if (__WEB__ && screen === 'ledger' && bwNav.current.on && !typing && !e.ctrlKey && !e.metaKey) {
        if (e.altKey && fk === 'F1') {
          e.preventDefault()
          setBwDetailed((d) => !d)
          setBwFlip(new Set())
          return
        }
        const keys = bwNav.current.keys
        if (!e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && keys.length) {
          e.preventDefault()
          setBwSel((s) => {
            const at = s < 0 || s >= keys.length ? (e.key === 'ArrowDown' ? -1 : keys.length) : s
            const to = Math.max(0, Math.min(keys.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
            requestAnimationFrame(() => document.querySelector(`[data-bw-row="${to}"]`)?.scrollIntoView({ block: 'nearest' }))
            return to
          })
          return
        }
        if (!e.altKey && e.key === 'Enter' && !keys.length) {
          e.preventDefault()
          bwPending.current = true
          return
        }
        if (!e.altKey && e.key === 'Enter' && keys.length) {
          e.preventDefault()
          setBwSel((s) => {
            const at = s >= 0 && s < keys.length ? s : 0
            toggleBw(keys[at])
            return at
          })
          return
        }
      }
      // Select Company gate: arrows (the cards sit side by side, so Left and
      // Right move too) + Enter, the number on a card opens it straight away,
      // Esc leaves the module.
      if (!company) {
        const digit = !e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key) ? Number(e.key) : 0
        if (digit) {
          e.preventDefault()
          const cm = companies[digit - 1]
          if (cm) {
            setCoIndex(digit - 1)
            setCompany(cm)
          }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          setCoIndex((i) => (companies.length ? (i + 1) % companies.length : 0))
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          setCoIndex((i) => (companies.length ? (i - 1 + companies.length) % companies.length : 0))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (companies[coIndex]) setCompany(companies[coIndex])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onExit?.()
        }
        return
      }
      if (fk === 'F3') {
        e.preventDefault()
        setScreen('gateway')
        setCompany(null)
        return
      }
      // On the Ledgers screen F4 picks a different ledger, which is what it
      // does in Tally's own ledger report — not a Contra voucher. Checked
      // before the voucher keys claim it, the same way F5 is below.
      if (__WEB__ && fk === 'F8' && !e.altKey && screen === 'ledger' && ledgerId) {
        e.preventDefault()
        setLgPickerOpen(false)
        setLgRailOpen((o) => !o)
        return
      }
      if (__WEB__ && fk === 'F8' && !e.altKey && (screen === 'purchreg' || screen === 'salesreg' || screen === 'notesreg')) {
        e.preventDefault()
        setRegSumOpen((o) => !o)
        return
      }
      if (fk === 'F4' && !e.altKey && screen === 'ledger') {
        e.preventDefault()
        // One drawer at a time: the list replaces the summary.
        setLgRailOpen(false)
        // F4 again puts the list away, when there is a ledger to go back to.
        if (__WEB__ && lgPickerOpen && ledgerId) {
          setLgPickerOpen(false)
          return
        }
        setLedgerSearch('')
        // Call the picker up — on the website too, where it is now an overlay
        // over the statement rather than a permanent column. The focus effect
        // puts the caret in its search box once it has mounted.
        setLgPickerOpen(true)
        return
      }
      // THE VIEW KEYS, while a statement is open.
      //
      // The website's ledger is four views of one statement, and F1/F5/F6/F7
      // are how Tally switches between them — so on this screen they are the
      // views and nothing else. The bar along the bottom says the same, which
      // is the point: a key that does one thing on screen and another on the
      // keyboard is worse than no key at all.
      //
      // F5 is Bill-wise and Alt F5 Columnar, as in Tally. F6, which used to be
      // Bill-wise here, still opens it, so a hand that learned it is not sent
      // to a Receipt voucher instead.
      if (__WEB__ && screen === 'ledger' && fk === 'F5' && e.altKey) {
        e.preventDefault()
        setLgView('columnar')
        return
      }
      if (__WEB__ && screen === 'ledger' && !e.altKey && ['F1', 'F5', 'F6', 'F7'].includes(fk)) {
        e.preventDefault()
        setLgView(fk === 'F1' ? 'vouchers' : fk === 'F5' || fk === 'F6' ? 'billwise' : 'monthly')
        return
      }
      // On a ledger with a party open, F5 is Tally's Bills Outstanding rather
      // than a Payment voucher — checked before the voucher keys claim it.
      if (fk === 'F5' && !e.altKey && screen === 'ledger' && ledgerId) {
        e.preventDefault()
        setLgBills((b2) => !b2)
        return
      }
      // Function keys work everywhere on this page; letters only outside inputs.
      if (fk === 'F4' || fk === 'F5' || fk === 'F6' || fk === 'F7') {
        e.preventDefault()
        const wanted = e.altKey && fk === 'F5' ? 'DEBIT NOTE' : e.altKey && fk === 'F6' ? 'CREDIT NOTE' : null
        const t = wanted || VCH_TYPES.find((v) => v.fkey === fk)!.key
        if (screen === 'voucher') switchType(t as VchType)
        else openVoucher(t as VchType)
        return
      }
      if (fk === 'F1' && e.altKey && screen === 'ledger') {
        e.preventDefault()
        setLgDetailed((d) => !d)
        return
      }
      // Plain F2 only — Alt F2 is the period, everywhere (App.tsx).
      if (fk === 'F2' && !e.altKey && screen === 'voucher') {
        e.preventDefault()
        dateRef.current?.querySelector('button')?.click()
        return
      }
      if (e.key === 'Escape') {
        // The ledger picker is the innermost thing on screen, so it backs out
        // first — Esc should close what is over the page, not the page under
        // it. With nothing chosen yet there is nothing to go back TO, so it
        // stays open and Esc leaves the screen as usual.
        if (lgPickerOpen && ledgerId) {
          e.preventDefault()
          return setLgPickerOpen(false)
        }
        // The summary drawer, likewise, before anything under it.
        if (__WEB__ && screen === 'ledger' && lgRailOpen) {
          e.preventDefault()
          return setLgRailOpen(false)
        }
        if (__WEB__ && regSumOpen && (screen === 'purchreg' || screen === 'salesreg' || screen === 'notesreg')) {
          e.preventDefault()
          return setRegSumOpen(false)
        }
        if (__WEB__ && regOpenRow && (screen === 'purchreg' || screen === 'salesreg')) {
          e.preventDefault()
          return setRegOpenRow(null)
        }
        // A voucher opened under its row closes before the screen does.
        if (__WEB__ && screen === 'ledger' && lgOpenRowRef.current != null) {
          e.preventDefault()
          return setLgOpenRow(null)
        }
        if (lgBills && !__WEB__) {
          e.preventDefault()
          return setLgBills(false)
        }
        if (viewRow) return setViewRow(null)
        if (newLedger) return setNewLedger(null)
        // A line's breakdown panel, open under it, closes before the voucher.
        if (screen === 'voucher' && (splitOpen >= 0 || noteSplitOpen)) {
          e.preventDefault()
          setSplitOpen(-1)
          setNoteSplitOpen(false)
          return
        }
        // Ledgers ticked in Masters are let go before Masters is.
        if (screen === 'masters' && mPicked.size) {
          e.preventDefault()
          return setMPicked(new Set())
        }
        // In a box on a register or report — a search, a date — the first Esc
        // steps out of the box and a second leaves the screen, so abandoning
        // what was typed does not also abandon the page. (A voucher is all
        // boxes; there Esc leaves at once, asking first if anything changed.)
        if (typing && screen !== 'voucher' && screen !== 'gateway') {
          e.preventDefault()
          ;(e.target as HTMLElement).blur?.()
          return
        }
        if (screen === 'ledger' && lgBack) {
          e.preventDefault()
          return leaveLedger()
        }
        if (screen !== 'gateway') {
          e.preventDefault()
          leaveVoucher()
        } else {
          // Esc from the Gateway steps back to Select Company, as F3 does;
          // Esc there leaves the accounting workspace, like quitting Tally
          // back to the rest of the software.
          e.preventDefault()
          setCompany(null)
        }
        return
      }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && screen === 'voucher') {
        e.preventDefault()
        if (viewOnly) return
        void saveVoucher()
        return
      }
      if (e.altKey && (e.key === 'd' || e.key === 'D') && screen === 'voucher' && (editingId != null || noteEditId != null)) {
        e.preventDefault()
        void deleteVoucher()
        return
      }
      // ↑ ↓ WALK THE LEDGER LIST from anywhere on the website's ledger screen
      // that is not a box being typed into — the next ledger opens at once.
      if (
        __WEB__ &&
        screen === 'ledger' &&
        !typing &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        !(e.target as HTMLElement)?.closest?.('[role="dialog"],[role="listbox"],[role="menu"],[data-radix-popper-content-wrapper]')
      ) {
        const order = lgOrderRef.current
        if (order.length) {
          e.preventDefault()
          const at = order.indexOf(Number(ledgerId))
          const to = at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
          if (order[to] && order[to] !== ledgerId) setLedgerId(order[to])
          return
        }
      }
      // Arrowing the Gateway list is the Gateway's own affair.
      if (screen === 'gateway' && !typing) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setGwIndex((i) => (i + 1) % GATEWAY_ITEMS.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setGwIndex((i) => (i - 1 + GATEWAY_ITEMS.length) % GATEWAY_ITEMS.length)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          GATEWAY_ITEMS[gwIndex].go()
          return
        }
      }
      // The section letters jump straight from ANY register or report to another,
      // so the sidebar's highlighted letters work wherever the sidebar itself is
      // — no need to go back to the Gateway first.
      //
      // Two deliberate exclusions. Voucher entry is a form: a stray letter with
      // focus outside a field would navigate away and lose what was typed. And a
      // plain letter with a modifier held belongs to whatever that combination
      // does, not here.
      // A dropdown, dialog or menu keeps focus on a non-input element, so
      // `typing` is false inside one — a letter there would navigate away and
      // yank the overlay out from under the user. Radix renders all of them in
      // a popper wrapper or with one of these roles, so this catches the lot.
      const inOverlay = !!(e.target as HTMLElement)?.closest?.(
        '[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"],[data-radix-popper-content-wrapper]'
      )
      if (!typing && !inOverlay && screen !== 'voucher' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const hit = GATEWAY_ITEMS.findIndex((g) => g.key.toLowerCase() === e.key.toLowerCase())
        if (hit >= 0) {
          e.preventDefault()
          GATEWAY_ITEMS[hit].go()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, gwIndex, viewRow, viewOnly, newLedger, editingId, noteEditId, lines, payLines, payAccounts, rawAlter, vchDate, vchNo, narration, vchType, saving, onExit, company, companies, coIndex, ledgerId, lgBills, lgPickerOpen, lgRailOpen, regSumOpen, regOpenRow, lgBack, splitOpen, noteSplitOpen, mPicked, alterBack, noteItems, noteInvoice, noteParty])

  // ------- derived -------
  const ledgerAccount = accounts.find((a) => Number(a.id) === ledgerId)
  // The statement for the chosen period: opening = everything before `from`,
  // rows within [from, to] with a running balance seeded from the opening.
  const stmt = useMemo(() => {
    let opening = lgOpening
    const rows: Row[] = []
    for (const l of ledgerLines) {
      const d = String(l.entry_date)
      const net = (Number(l.dr) || 0) - (Number(l.cr) || 0)
      if (lgFrom && d < lgFrom) {
        opening += net
        continue
      }
      if (lgTo && d > lgTo) continue
      rows.push(l)
    }
    let run = opening
    const out = rows.map((l): Row => {
      run += (Number(l.dr) || 0) - (Number(l.cr) || 0)
      return { ...l, running: run }
    })
    return {
      opening,
      rows: out,
      closing: run,
      totDr: out.reduce((sum, l) => sum + (Number(l.dr) || 0), 0),
      totCr: out.reduce((sum, l) => sum + (Number(l.cr) || 0), 0)
    }
  }, [ledgerLines, lgFrom, lgTo, lgOpening])

  // Tally's month-wise ledger summary: Dr/Cr per month and the cumulative
  // closing, drillable into that month's vouchers.
  const monthly = useMemo(() => {
    const by = new Map<string, { dr: number; cr: number }>()
    for (const l of ledgerLines) {
      const m = String(l.entry_date).slice(0, 7)
      const cur = by.get(m) || { dr: 0, cr: 0 }
      cur.dr += Number(l.dr) || 0
      cur.cr += Number(l.cr) || 0
      by.set(m, cur)
    }
    let run = 0
    return Array.from(by.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, v]) => {
        run += v.dr - v.cr
        return { month: m, dr: v.dr, cr: v.cr, closing: run }
      })
  }, [ledgerLines])

  function drillMonth(m: string): void {
    const [y, mo] = m.split('-').map(Number)
    const last = new Date(y, mo, 0).getDate()
    setLgFrom(`${m}-01`)
    setLgTo(`${m}-${String(last).padStart(2, '0')}`)
    setLgMonthly(false)
  }

  // MONTHS, WITH THE CLOSING CARRIED FORWARD.
  //
  // Built off `stmt`, not off the raw lines: the period's opening seeds the
  // first month, so the closing on the last row is the same figure the header
  // states. The desktop's own `monthly` starts from nil and answers a
  // different question — movement — which is why this one exists beside it.
  const lgMonthsWeb = useMemo(() => {
    const order: string[] = []
    const by = new Map<string, Row[]>()
    for (const r of stmt.rows as Row[]) {
      const k = String(r.entry_date).slice(0, 7)
      if (!by.has(k)) {
        by.set(k, [])
        order.push(k)
      }
      ;(by.get(k) as Row[]).push(r)
    }
    let carry = stmt.opening
    return order.map((k) => {
      const rows = by.get(k) as Row[]
      const dr = rows.reduce((t, r) => t + (Number(r.dr) || 0), 0)
      const cr = rows.reduce((t, r) => t + (Number(r.cr) || 0), 0)
      const openAt = carry
      carry = Math.round((carry + dr - cr) * 100) / 100
      let run = openAt
      return {
        key: k,
        label: monthLabelLong(k),
        n: rows.length,
        dr,
        cr,
        movement: Math.round((dr - cr) * 100) / 100,
        closing: carry,
        rows: rows.map((r) => {
          run = Math.round((run + (Number(r.dr) || 0) - (Number(r.cr) || 0)) * 100) / 100
          return { ...r, running: run }
        })
      }
    })
  }, [stmt])

  // THE CONTRA LEDGERS — and the trap in them.
  //
  // A contra is a ledger on the OPPOSITE side of the voucher. A co-credit like
  // TDS PAYABLE sitting alongside the party is not something this ledger was
  // posted against, and counting it inflates the row. So a leg is a column
  // only where its side is the other one from this account's own posting.
  const lgContras = useMemo(() => {
    const tot = new Map<string, number>()
    for (const r of stmt.rows as Row[]) {
      const mine: 'dr' | 'cr' = (Number(r.dr) || 0) > 0 ? 'dr' : 'cr'
      for (const g of (r.legs as Row[]) || []) {
        const theirs = (Number(g.dr) || 0) > 0 ? 'dr' : 'cr'
        if (theirs === mine) continue
        const amt = (Number(g.dr) || 0) + (Number(g.cr) || 0)
        tot.set(String(g.name), (tot.get(String(g.name)) || 0) + amt)
      }
    }
    return Array.from(tot.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }, [stmt.rows])

  // One row per voucher — or per month, condensed — and one cell per contra.
  const lgColRows = useMemo(() => {
    const cellOf = (rows: Row[], acct: string): number =>
      rows.reduce((a, r) => {
        const mine: 'dr' | 'cr' = (Number(r.dr) || 0) > 0 ? 'dr' : 'cr'
        const leg = ((r.legs as Row[]) || []).find((g) => {
          const theirs = (Number(g.dr) || 0) > 0 ? 'dr' : 'cr'
          return String(g.name) === acct && theirs !== mine
        })
        return a + (leg ? (Number(leg.dr) || 0) + (Number(leg.cr) || 0) : 0)
      }, 0)
    // The row total is THIS account's own posting — the figure the Vouchers
    // view shows — never the sum of the contra cells, which is the whole
    // opposite side and larger wherever this account's side is split.
    const ownOf = (rows: Row[]): number =>
      rows.reduce((a, r) => a + (Number(r.dr) || 0) + (Number(r.cr) || 0), 0)
    const src = lgCondensed
      ? lgMonthsWeb.map((m) => ({ lead: '', label: m.label, rows: m.rows as Row[], strong: true }))
      : (stmt.rows as Row[]).map((r) => ({
          lead: formatDate(r.entry_date),
          label: String(r.voucher_code || r.vch_no || r.vch_type || ''),
          rows: [r],
          strong: false
        }))
    return src.map((r) => {
      // The deal behind the voucher, shown as its own columns beside the
      // contra amounts. Only a single voucher carries one — a condensed month
      // rolls many together and has none.
      const one = r.rows.length === 1 ? r.rows[0] : null
      return {
        ...r,
        cells: lgContras.map((c) => cellOf(r.rows, c)),
        total: ownOf(r.rows),
        detail: one
          ? {
              vchType: String(one.vch_type || ''),
              // The document's number where there is one; otherwise the
              // voucher's own, so every row has a Ref no to click.
              refNo: String(one.order_invoice_no || one.sale_invoice_no || one.bd_no || one.lc_no || lineRef(one)?.no || ''),
              entryId: Number(one.entry_id ?? one.id) || 0,
              bargainNo: String(one.bargain_no || ''),
              rate: Number(one.deal_rate) || 0,
              qty: Number(one.deal_qty) || 0,
              interest: Number(one.interest_amt) || 0,
              narration: String(one.narration || '')
            }
          : null
      }
    })
  }, [stmt.rows, lgContras, lgCondensed, lgMonthsWeb])

  // Which of the deal columns actually carry something in this ledger and
  // period — a bank ledger has interest but no bargain, a supplier ledger the
  // reverse. Only the ones with data are drawn, the way the contra columns are.
  const lgDetailCols = useMemo(() => {
    const rows = stmt.rows as Row[]
    const any = (f: (r: Row) => boolean): boolean => rows.some(f)
    return {
      vchType: any((r) => !!String(r.vch_type || '').trim()),
      refNo: any((r) => !!String(r.order_invoice_no || r.sale_invoice_no || r.bd_no || r.lc_no || lineRef(r)?.no || '').trim()),
      bargainNo: any((r) => !!String(r.bargain_no || '').trim()),
      rate: any((r) => (Number(r.deal_rate) || 0) > 0),
      qty: any((r) => Math.abs(Number(r.deal_qty) || 0) > 0.0001),
      interest: any((r) => Math.abs(Number(r.interest_amt) || 0) > 0.004),
      narration: any((r) => !!String(r.narration || '').trim())
    }
  }, [stmt.rows])

  /**
   * A REGISTER WIDER THAN THE SCREEN HAS TO SAY SO.
   *
   * The columnar view is one column per ledger this account was posted
   * against, and a busy party has thirty-five of them — far more than fits.
   * The columns were all there and all reachable, and nothing on screen said
   * either: the only scrollbar was the pane's own, at the very bottom, past a
   * hundred and forty rows, which is not a control anybody finds.
   *
   * So the pane's horizontal position is read here, and the columnar view
   * draws its own bar from it — pinned to the bottom of the view, always in
   * sight — plus a strip naming every column with its total, any of which
   * scrolls straight to it.
   */
  const lgPaneRef = useRef<HTMLDivElement | null>(null)
  const [colScroll, setColScroll] = useState({ left: 0, view: 0, total: 0 })
  useEffect(() => {
    const el = lgPaneRef.current
    if (!el || lgView !== 'columnar') return
    const read = (): void =>
      setColScroll({ left: el.scrollLeft, view: el.clientWidth, total: el.scrollWidth })
    read()
    el.addEventListener('scroll', read, { passive: true })
    // The table's width changes with the ledger, the period and Condensed, and
    // none of those fire a scroll event.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [lgView, lgCondensed, lgContras.length, lgColRows.length, ledgerId])

  // Which column was just jumped to, so it can be marked for a moment. A jump
  // that lands silently in the middle of thirty-five identical columns has not
  // answered the question that was asked.
  const [colFlash, setColFlash] = useState<number | null>(null)
  useEffect(() => {
    if (colFlash == null) return
    const t = window.setTimeout(() => setColFlash(null), 1400)
    return () => window.clearTimeout(t)
  }, [colFlash])

  // Tally's columnar register: in DETAILED mode every ledger involved in the
  // period's vouchers becomes its own column, biggest money first.
  const legCols = useMemo(() => {
    if (!lgDetailed) return [] as string[]
    const tot = new Map<string, number>()
    for (const r of stmt.rows) {
      for (const g of (r.legs as Row[]) || []) {
        const k = String(g.name)
        tot.set(k, (tot.get(k) || 0) + Math.abs((Number(g.dr) || 0) - (Number(g.cr) || 0)))
      }
    }
    return Array.from(tot.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }, [stmt.rows, lgDetailed])

  // One ledger's net share of one voucher (its legs summed), for a columnar cell.
  const legShare = (row: Row, col: string): number => {
    let v = 0
    for (const g of (row.legs as Row[]) || []) {
      if (String(g.name) === col) v += (Number(g.dr) || 0) - (Number(g.cr) || 0)
    }
    return Math.round(v * 100) / 100
  }

  const filteredAccounts = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase()
    return q ? accounts.filter((a) => ledgerNameMatches(a.name, q)) : accounts
  }, [accounts, ledgerSearch])

  // A narrower search can leave the cursor past the end; pull it back.
  useEffect(() => {
    setLgCursor((i) => (filteredAccounts.length === 0 ? 0 : Math.min(i, filteredAccounts.length - 1)))
  }, [filteredAccounts.length])
  // Typing is a fresh search, so start at the top of what it left.
  useEffect(() => {
    setLgCursor(0)
  }, [ledgerSearch])
  useEffect(() => {
    if (screen !== 'ledger') return
    lgItemRefs.current[lgCursor]?.scrollIntoView({ block: 'nearest' })
  }, [lgCursor, screen])

  // Arrows move, Enter opens. Bound to the search box (which this screen
  // focuses on arrival) so one uninterrupted run of keystrokes gets you from
  // landing on Ledgers to reading one.
  function ledgerKeyNav(e: React.KeyboardEvent): void {
    const n = filteredAccounts.length
    if (!n) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setLgCursor((i) => Math.min(i + 1, n - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setLgCursor((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setLgCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setLgCursor(n - 1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setLgCursor((i) => Math.min(i + 10, n - 1))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setLgCursor((i) => Math.max(i - 10, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = filteredAccounts[lgCursor]
      if (hit) {
        setLedgerId(Number(hit.id))
        setLgPickerOpen(false)
      }
    } else if (e.key === 'Escape' && lgPickerOpen) {
      // Only meaningful with a ledger already on screen behind it — otherwise
      // dismissing would leave an empty page and no way back but the button.
      if (ledgerId) {
        e.preventDefault()
        e.stopPropagation()
        setLgPickerOpen(false)
      }
    }
  }

  const tbGroups = useMemo(() => {
    if (!tb) return []
    const by = new Map<string, Row[]>()
    for (const r of tb.rows as Row[]) {
      const g = String(r.acc_group || 'General')
      if (!by.has(g)) by.set(g, [])
      by.get(g)!.push(r)
    }
    return Array.from(by.entries())
  }, [tb])

  // ------- screens -------
  const rightBar = (
    <div className="flex w-44 shrink-0 flex-col gap-1 p-2">
      <div className="mb-1 rounded bg-white/10 px-2.5 py-1.5 text-center text-[10px] font-bold uppercase tracking-widest text-amber-300">
        {screen === 'voucher' ? (editingId != null ? 'Alter voucher' : 'Voucher entry') : 'Gateway'}
      </div>
      {VCH_TYPES.filter((v) => mayEnter(v.key) || (screen === 'voucher' && v.key === vchType)).map((v) => (
        <FKey
          key={v.key}
          k={v.fkey}
          label={v.barLabel || v.label}
          active={screen === 'voucher' && vchType === v.key}
          onClick={() => (screen === 'voucher' ? switchType(v.key) : openVoucher(v.key))}
        />
      ))}
      <div className="my-1 border-t border-white/20" />
      {mayScreen('purchreg') && <FKey k="P" label="Purchases" active={screen === 'purchreg'} onClick={() => setScreen('purchreg')} />}
      {mayScreen('salesreg') && <FKey k="S" label="Sales" active={screen === 'salesreg'} onClick={() => setScreen('salesreg')} />}
      {mayScreen('daybook') && <FKey k="D" label="Day Book" active={screen === 'daybook'} onClick={() => setScreen('daybook')} />}
      {mayScreen('notesreg') && <FKey k="N" label="Dr / Cr Notes" active={screen === 'notesreg'} onClick={() => setScreen('notesreg')} />}
      {mayScreen('tfpur') && <FKey k="R" label="Fr. Inward Working" active={screen === 'tfpur'} onClick={() => setScreen('tfpur')} />}
      {mayScreen('tfsal') && <FKey k="O" label="Fr. Outward Working" active={screen === 'tfsal'} onClick={() => setScreen('tfsal')} />}
      {mayScreen('ledger') && <FKey k="L" label="Ledgers" active={screen === 'ledger'} onClick={() => setScreen('ledger')} />}
      {mayScreen('trial') && <FKey k="T" label="Trial Balance" active={screen === 'trial'} onClick={() => setScreen('trial')} />}
      {mayScreen('openings') && <FKey k="B" label="Opening Balances" active={screen === 'openings'} onClick={() => setScreen('openings')} />}
      {screen === 'ledger' && (
        <>
          <div className="my-1 border-t border-white/20" />
          <FKey
            k="F4"
            label="Change ledger"
            active={lgPickerOpen}
            onClick={() => { setLedgerSearch(''); setLgPickerOpen(true) }}
          />
          {!!ledgerId && (
            <FKey k="F5" label={lgBills ? 'Statement' : 'Bills outstanding'} active={lgBills} onClick={() => setLgBills((b2) => !b2)} />
          )}
          <FKey k="Alt F1" label={lgDetailed ? 'Condensed' : 'Columnar'} onClick={() => setLgDetailed((d) => !d)} />
          <FKey k="M" label={lgMonthly ? 'Vouchers' : 'Monthly'} active={lgMonthly} onClick={() => setLgMonthly((m) => !m)} />
        </>
      )}
      <div className="mt-auto space-y-1">
        {screen === 'voucher' && (
          <FKey k="Ctrl A" label={saving ? 'Saving…' : 'Accept'} onClick={() => void saveVoucher()} />
        )}
        {screen === 'voucher' && (editingId != null || noteEditId != null) && <FKey k="Alt D" label="Delete" onClick={() => void deleteVoucher()} />}
        {screen !== 'gateway' && <FKey k="Esc" label="Back" onClick={leaveVoucher} />}
      </div>
    </div>
  )

  // THE GATEWAY, AS THE CANVAS DRAWS IT.
  //
  // The desktop's 360px menu is a list of names in the middle of an empty
  // forest field. This is the whole paper: four figures across the top, then
  // every destination as a card that says what it is for and how much is in
  // it. Nothing is merged — Fr. Inward and Fr. Outward are two registers
  // because a bill from a transporter and a bill to a customer settle on
  // different ledgers, and a single card would hide one of them.
  // THE PERIOD, FOR THE WHOLE MODULE.
  //
  // Every screen here has its own From/To, and they were only ever set
  // together by the app-wide date broadcast — so the header could not state a
  // period, and there was nowhere to change one. Alt F2 sets all of them at
  // once, which is what a period means in Tally: the books are open on these
  // dates, and every report answers for them.
  const [periodOpen, setPeriodOpen] = useState(false)
  const applyPeriod = useCallback((from: string, to: string) => {
    setDbFrom(from)
    setDbTo(to)
    setLgFrom(from)
    setLgTo(to)
    setTbFrom(from)
    setTbTo(to)
    setRegFrom(from)
    setRegTo(to)
    // Fr. Inward and Fr. Outward were the pair this list forgot, which is
    // exactly why they still carried a From/To of their own: the header said
    // one period and those two screens answered for another. They are on the
    // module's period now, like every other report here.
    setTfFrom(from)
    setTfTo(to)
  }, [])
  const periodLabel =
    dbFrom && dbTo
      ? `${formatDate(dbFrom)} — ${formatDate(dbTo)}`
      : dbTo
        ? `up to ${formatDate(dbTo)}`
        : dbFrom
          ? `from ${formatDate(dbFrom)}`
          : 'All dates'

  const gatewayWeb = (() => {
    const vsum = (gwSum?.vouchers as Row | null) || null
    const byTypeN = (vsum?.by_type as Record<string, number>) || {}
    const vCount = n(vsum?.count)
    const tbal = gwSum?.tb as Row | null
    const ob = (gwSum?.ob as Row | null) || null
    const turned = n(vsum?.amount)
    const agrees =
      !!tbal && Math.abs(n((tbal.totals as Row)?.closing_dr) - n((tbal.totals as Row)?.closing_cr)) < 0.02
    const groups = new Set(((tbal?.rows as Row[]) || []).map((r) => String(r.group_name || r.group || ''))).size
    // Openings are SET when the books have a start date or any ledger carries
    // an opening figure — read here, since the Openings screen may never have
    // been visited this session.
    const obSet = !!ob && (!!String(ob.from || '') || !!ob.any)
    const obLabel = !ob ? '' : ob.from ? `from ${formatDate(ob.from)}` : ob.any ? 'set' : 'not set'
    const countOf = (key: string): string => {
      const byType = (t: string): number => n(byTypeN[t])
      if (!gwSum) return ''
      if (key === 'V') return `${vCount} entered`
      if (key === 'P') return `${byType('PURCHASE') + byType('PURCHASE OIL')} bills`
      if (key === 'S') return `${byType('SALE')} invoices`
      if (key === 'D') return `${vCount} vouchers`
      if (key === 'N') return `${byType('DEBIT NOTE')} notes`
      if (key === 'C') return `${byType('CREDIT NOTE')} notes`
      if (key === 'L') return `${accounts.length} ledgers`
      if (key === 'T') return tbal ? `${groups} ${groups === 1 ? 'group' : 'groups'}` : ''
      if (key === 'B') return obLabel
      if (key === 'M') return groupRows.length ? `${groupRows.length} groups` : ''
      return ''
    }

    const TONES = {
      green: { bg: '#E9F5EE', bd: '#BFE3CB', fg: '#0B6B45' },
      blue: { bg: '#EAF0FA', bd: '#C6DAF0', fg: '#1B4E82' },
      red: { bg: '#FDF3F2', bd: '#F0D6D4', fg: '#B3261E' },
      amber: { bg: '#FFF4DD', bd: '#F1D9A6', fg: '#8A5300' }
    }
    const LOOK: Record<string, { icon: typeof Landmark; tone: keyof typeof TONES }> = {
      V: { icon: ReceiptText, tone: 'green' },
      D: { icon: BookOpen, tone: 'green' },
      N: { icon: FileText, tone: 'red' },
      C: { icon: FileText, tone: 'green' },
      B: { icon: Landmark, tone: 'green' },
      P: { icon: ShoppingCart, tone: 'blue' },
      S: { icon: Tag, tone: 'green' },
      R: { icon: Truck, tone: 'blue' },
      O: { icon: Truck, tone: 'amber' },
      L: { icon: Wallet, tone: 'green' },
      T: { icon: Scale, tone: 'blue' },
      M: { icon: ListTree, tone: 'green' },
      U: { icon: FileSpreadsheet, tone: 'amber' },
      F: { icon: ArrowLeftRight, tone: 'blue' },
      Y: { icon: Banknote, tone: 'green' }
    }
    const SECTIONS = [
      { title: 'Enter', note: 'record what happened', accent: '#12855A', keys: ['V', 'D', 'B'] },
      // The notes are a register too — a list of documents already booked,
      // read beside the purchase and sale bills they adjust.
      { title: 'Registers', note: 'bills in and out', accent: '#1B4E82', keys: ['P', 'S', 'N', 'C', 'Y'] },
      // Not registers: a register lists bills already booked, and these are
      // the freight still being worked out before a transporter's bill is.
      { title: 'Workings', note: 'freight to bill', accent: '#8A5300', keys: ['R', 'O'] },
      { title: 'Reports & masters', note: 'read the books', accent: '#C2700A', keys: ['L', 'T', 'F', 'M'] },
      { title: 'Tally', note: 'bring files in', accent: '#8A5300', keys: ['U'] }
    ]

    const card: React.CSSProperties = {
      borderRadius: 12,
      background: '#fff',
      border: '1px solid #DCE7DB',
      boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 26px -18px rgba(10,31,23,.2)'
    }
    const cap: React.CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase' }
    const big = (color: string = A.ink): React.CSSProperties => ({
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: 21,
      fontWeight: 700,
      letterSpacing: '-0.03em',
      marginTop: 9,
      color
    })

    const attention = [
      ...(tbal && !agrees && mayScreen('trial')
        ? [{ text: 'Trial balance is out — review it before closing the period', dot: '#B3261E', fg: '#8C2F26', go: () => setScreen('trial') }]
        : []),
      ...(ob && !obSet && mayScreen('openings') ? [{ text: 'Opening balances are not set', dot: '#C2700A', fg: '#7A4E00', go: () => setScreen('openings') }] : [])
    ]

    return (
      <div className="sc min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex flex-col gap-4" style={{ maxWidth: 1680, padding: '18px 20px 24px' }}>
          {/* ── FOUR FIGURES ───────────────────────────────────────────────── */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
            <div
              className="relative overflow-hidden"
              style={{
                borderRadius: 12,
                background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 50%,#072B20 100%)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 16px 30px -18px rgba(7,43,32,.8)',
                padding: '15px 17px',
                color: '#fff'
              }}
            >
              <div
                className="pointer-events-none absolute rounded-full"
                style={{ top: -50, right: -40, width: 150, height: 150, background: 'radial-gradient(circle,rgba(199,240,63,.2),transparent 70%)' }}
              />
              <div className="relative flex items-center gap-2">
                <Banknote className="h-4 w-4" style={{ color: A.accent }} />
                <span style={{ ...cap, color: A.inkSky }}>Turnover</span>
              </div>
              <div className="relative truncate" style={big(A.accent)}>
                {gwSum ? formatINR(turned) : '—'}
              </div>
              <div className="relative" style={{ fontSize: 11, fontWeight: 600, color: '#A9CDBB', marginTop: 4 }}>
                total posted
              </div>
            </div>
            <div style={{ ...card, padding: '15px 17px' }}>
              <div className="flex items-center gap-2">
                <ReceiptText className="h-4 w-4" style={{ color: '#12855A' }} />
                <span style={{ ...cap, color: A.muted }}>Vouchers</span>
              </div>
              <div style={big()}>{gwSum ? vCount : '—'}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: A.muted, marginTop: 4 }}>in this period</div>
            </div>
            {(() => {
              const out = !!tbal && !agrees
              const ok = !!tbal && agrees
              return (
                <button
                  type="button"
                  onClick={() => setScreen('trial')}
                  className="text-left transition-transform hover:-translate-y-px"
                  style={{
                    ...card,
                    padding: '15px 17px',
                    background: out ? 'linear-gradient(180deg,#FFF8F7,#FDEFEE)' : ok ? 'linear-gradient(180deg,#F5FBF6,#EAF6EE)' : '#fff',
                    border: `1px solid ${out ? '#F0D6D4' : ok ? '#BFE3CB' : '#DCE7DB'}`,
                    boxShadow: out ? '0 1px 2px rgba(10,31,23,.04),0 10px 26px -18px rgba(140,47,38,.35)' : card.boxShadow
                  }}
                >
                  <span className="flex items-center gap-2">
                    <Scale className="h-4 w-4" style={{ color: out ? '#B3261E' : '#12855A' }} />
                    <span style={{ ...cap, color: out ? '#8C2F26' : ok ? A.good : A.muted }}>Trial balance</span>
                  </span>
                  <span className="flex items-center gap-2" style={{ marginTop: 9 }}>
                    <span style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.02em', color: out ? '#B3261E' : ok ? A.good : A.muted }}>
                      {!gwSum ? '—' : !tbal ? 'Unread' : ok ? 'Agrees' : 'Out'}
                    </span>
                    {(out || ok) && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 800,
                          letterSpacing: '.06em',
                          color: '#fff',
                          background: out ? '#B3261E' : A.good,
                          borderRadius: 4,
                          padding: '3px 7px'
                        }}
                      >
                        {out ? 'CHECK' : 'BALANCED'}
                      </span>
                    )}
                  </span>
                  <span
                    className="block"
                    style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 11, fontWeight: 600, color: out ? '#8C2F26' : A.muted, marginTop: 4 }}
                  >
                    {tbal ? `${formatINR(n((tbal.totals as Row).closing_dr))} each side` : 'not read yet'}
                  </span>
                </button>
              )
            })()}
            <div style={{ ...card, padding: '15px 17px' }}>
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" style={{ color: '#12855A' }} />
                <span style={{ ...cap, color: A.muted }}>Ledgers</span>
              </div>
              <div style={big()}>{accounts.length || '—'}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: A.muted, marginTop: 4 }}>
                {tbal ? `${groups} ${groups === 1 ? 'group' : 'groups'} in use` : 'in these books'}
              </div>
            </div>
          </div>

          {/* ── ENTER A VOUCHER ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2.5" style={{ ...card, padding: '12px 14px' }}>
            <div className="flex items-center gap-2" style={{ paddingRight: 6 }}>
              <Zap className="h-[18px] w-[18px]" style={{ color: A.frame }} />
              <span style={{ ...cap, fontSize: 10 }}>Enter a voucher</span>
            </div>
            {VCH_TYPES.filter((v) => mayEnter(v.key)).map((v) => {
              const lead = v.key === firstVch()
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => openVoucher(v.key)}
                  className="flex h-[38px] items-center gap-[9px] whitespace-nowrap rounded-[8px] px-[13px] transition hover:-translate-y-px hover:shadow-[0_8px_18px_-10px_rgba(10,31,23,.45)]"
                  style={{
                    background: lead ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : '#fff',
                    border: `1px solid ${lead ? '#D5F46A' : '#DCE7DB'}`,
                    color: A.frame,
                    fontSize: 12,
                    fontWeight: 800,
                    boxShadow: '0 1px 2px rgba(10,31,23,.05)'
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontVariantNumeric: FIGS,
                      fontSize: 10,
                      fontWeight: 600,
                      color: lead ? A.frame : '#12855A',
                      background: lead ? 'rgba(11,61,46,.12)' : '#EEF3EC',
                      borderRadius: 4,
                      padding: '2px 6px'
                    }}
                  >
                    {chordLabel(v.fkey)}
                  </span>
                  {v.label}
                </button>
              )
            })}
            {!firstVch() && (
              <span style={{ fontSize: 12, fontWeight: 600, color: A.muted }}>No voucher type is open to you — ask an admin in User Access.</span>
            )}
          </div>

          {/* ── NEEDS ATTENTION — only when something does ───────────────────── */}
          {attention.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-x-3.5 gap-y-2"
              style={{ borderRadius: 10, background: 'linear-gradient(180deg,#FFF9EC,#FFF3DA)', border: '1px solid #F1D9A6', padding: '11px 14px' }}
            >
              <div className="flex items-center gap-2">
                <CircleAlert className="h-[18px] w-[18px]" style={{ color: '#B07400' }} />
                <span style={{ ...cap, fontSize: 10, color: '#7A4E00' }}>Needs attention</span>
              </div>
              {attention.map((a) => (
                <button
                  key={a.text}
                  type="button"
                  onClick={a.go}
                  className="flex items-center gap-[7px] hover:underline"
                  style={{ fontSize: 12, fontWeight: 700, color: a.fg, textUnderlineOffset: 3 }}
                >
                  <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: a.dot }} />
                  {a.text}
                  <ArrowRight className="h-4 w-4" />
                </button>
              ))}
            </div>
          )}

          {/* ── THE GATEWAY ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <span style={{ ...cap, fontSize: 10, letterSpacing: '.16em', color: '#33473E' }}>Gateway of accounts</span>
            <span className="h-px flex-1" style={{ minWidth: 40, background: '#DCE7DB' }} />
            <span className="flex items-center gap-1.5" style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>
              <KeyboardIcon className="h-[15px] w-[15px]" />
              press the red letter, ↑ ↓ and Enter, or {chordLabel('F4')}–{chordLabel('F7')} for a voucher
            </span>
          </div>

          <div className="grid items-stretch gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(330px,1fr))' }}>
            {SECTIONS.map((sec) => (
              <div
                key={sec.title}
                className="flex flex-col overflow-hidden"
                style={{ ...card, boxShadow: '0 1px 2px rgba(10,31,23,.04),0 12px 30px -20px rgba(10,31,23,.25)' }}
              >
                <div
                  className="flex items-center gap-[9px]"
                  style={{ padding: '12px 15px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)' }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: sec.accent }} />
                  <span style={{ ...cap, fontSize: 10.5 }}>{sec.title}</span>
                  <span className="ml-auto" style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>
                    {sec.note}
                  </span>
                </div>
                <div className="grid flex-1 content-start gap-1" style={{ padding: 7 }}>
                  {sec.keys.map((key) => {
                    const idx = GATEWAY_ITEMS.findIndex((g) => g.key === key)
                    const g = GATEWAY_ITEMS[idx]
                    if (!g) return null
                    const look = LOOK[key] || { icon: g.icon, tone: 'green' as const }
                    const t = TONES[look.tone]
                    const warn = key === 'B' && !!ob && !obSet
                    const badge = countOf(key)
                    const on = idx === gwIndex
                    // The hotkey letter in red where the name starts with it;
                    // otherwise it is on the key chip only.
                    const leads = g.label.charAt(0).toUpperCase() === key
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={g.go}
                        onMouseEnter={() => setGwIndex(idx)}
                        className="flex items-center gap-3 text-left transition"
                        style={{
                          padding: '11px 10px',
                          borderRadius: 9,
                          border: `1px solid ${on ? '#D6E8C4' : 'transparent'}`,
                          background: on ? '#F4F9EF' : warn ? 'linear-gradient(180deg,#FFFCF4,#FFF8EA)' : 'transparent',
                          boxShadow: on ? '0 8px 18px -12px rgba(10,31,23,.35)' : 'none'
                        }}
                      >
                        <span
                          className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[9px]"
                          style={{ background: t.bg, border: `1px solid ${t.bd}` }}
                        >
                          <look.icon className="h-5 w-5" style={{ color: t.fg }} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block" style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                            {leads ? (
                              <>
                                <span style={{ color: A.key }}>{g.label.charAt(0)}</span>
                                {g.label.slice(1)}
                              </>
                            ) : (
                              g.label
                            )}
                          </span>
                          <span className="block" style={{ fontSize: 11, fontWeight: 600, color: A.muted, marginTop: 3, lineHeight: 1.4, textWrap: 'pretty' }}>
                            {(GW_META[key] || { sub: '' }).sub}
                          </span>
                        </span>
                        {!!badge && (
                          <span
                            className="flex-none whitespace-nowrap"
                            style={{
                              fontSize: 10.5,
                              fontWeight: 800,
                              color: warn ? A.warn : '#33473E',
                              background: warn ? '#FFF4DD' : '#F4F7F2',
                              border: `1px solid ${warn ? '#F1D9A6' : '#E4ECE3'}`,
                              borderRadius: 12,
                              padding: '3px 9px',
                              fontVariantNumeric: FIGS
                            }}
                          >
                            {badge}
                          </span>
                        )}
                        <span
                          className="flex-none text-center"
                          style={{
                            fontFamily: MONO,
                            fontVariantNumeric: FIGS,
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#8C2F26',
                            background: '#FDF3F2',
                            border: '1px solid #F0D6D4',
                            borderRadius: 4,
                            minWidth: 22,
                            padding: '2px 5px'
                          }}
                        >
                          {key}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  })()

  const gateway = (
    <div className="flex flex-1 items-start justify-center pt-10">
      <div className={cn('w-[360px] rounded-md border shadow-lg', T.paperEdge, T.paper)}>
      <div className={cn('rounded-t-md px-4 py-2 text-center text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
        Gateway of Accounts
      </div>
      <div className="px-2 py-3">
        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Transactions</div>
        {GATEWAY_ITEMS.map((g, i) => (
          <button
            key={g.key}
            type="button"
            onClick={g.go}
            onMouseEnter={() => setGwIndex(i)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-3 rounded px-3 py-2 text-left text-[14px] transition-colors',
              i === gwIndex ? T.select : 'hover:bg-amber-100/60'
            )}
          >
            <g.icon className="h-4 w-4 text-[#0B3D2E]" />
            <span>
              <span className={cn('font-bold', T.key)}>{g.label.charAt(0)}</span>
              {g.label.slice(1)}
            </span>
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </button>
        ))}
        <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Use the highlighted letter or the function keys — F4 Contra, F5 Payment, F6 Receipt, F7 Journal, Alt+F5 Debit Note, Alt+F6 Credit Note. Purchase
          and sale vouchers post automatically from their own pages and appear in the Day Book.
        </p>
      </div>
      </div>
    </div>
  )

  // The item-invoice note editor (product lines, qty/rate or amount, and
  // the with/without-quantity toggle), shared by the desktop voucher screen
  // and the website voucher editor so both offer it.
  const noteInvoiceEditor = noteInvoiceMode ? (
          <div className="flex min-h-0 flex-1 flex-col px-3 py-2 [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:text-[12px] [&_input]:h-8 [&_input]:text-[12px] [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide">
            <div className="mb-2 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <Label>Party type</Label>
                <Select
                  value={notePartyKind}
                  onValueChange={(v) => {
                    // The chosen party id belongs to the old master, so it and
                    // the picked invoice are cleared with the switch.
                    setNotePartyKind(v as 'supplier' | 'customer' | 'transporter')
                    setNoteParty('')
                    setNoteInvoice('')
                    setNoteBargain('')
                  }}
                >
                  <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supplier">Supplier</SelectItem>
                    <SelectItem value="customer">Customer</SelectItem>
                    <SelectItem value="transporter">Transporter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-0.5">
                <Label>
                  {notePartyKind === 'customer'
                    ? 'Customer (goods coming back)'
                    : notePartyKind === 'supplier'
                      ? 'Supplier (goods going back)'
                      : 'Transporter'}
                </Label>
                <Select
                  value={noteParty}
                  onValueChange={(v) => {
                    setNoteParty(v)
                    setNoteInvoice('')
                    setNoteBargain('')
                    const nm = String(noteParties.find((x) => String(x.id) === v)?.name || '')
                    if (nm) void loadRefs(nm.toUpperCase(), noteSide)
                  }}
                >
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select party" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {noteParties.map((x) => (
                      <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-0.5">
                <Label>Original invoice (Agst Ref)</Label>
                <Select value={noteInvoice || 'ON_ACCOUNT'} onValueChange={(v) => setNoteInvoice(v === 'ON_ACCOUNT' ? '' : v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder={noteParty ? 'On account' : 'Pick the party first'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="ON_ACCOUNT">On account (no invoice)</SelectItem>
                    {/* A note being altered already settles its invoice, so that
                        invoice may no longer show as pending — kept on the list
                        so the note reads as against it, not on account. */}
                    {!!noteInvoice &&
                      !noteRefs.some((r) => String(r.ref) === noteInvoice) &&
                      !noteLinks.some((r) => String(r.ref) === noteInvoice) && (
                        <SelectItem value={noteInvoice}>{noteInvoice} — this note&rsquo;s own invoice</SelectItem>
                      )}
                    {noteRefs.map((r) => (
                      <SelectItem key={String(r.ref)} value={String(r.ref)}>
                        {String(r.ref)} — {formatINR(r.pending)} pending
                      </SelectItem>
                    ))}
                    {/* Bills already settled — a note may still be raised
                        against one (a shortage found after it was paid). */}
                    {noteLinks.length > 0 && (
                      <SelectItem value="__settled_sep__" disabled>
                        — Settled bills · to link to —
                      </SelectItem>
                    )}
                    {noteLinks.map((r) => (
                      <SelectItem key={`s:${String(r.ref)}`} value={String(r.ref)}>
                        {String(r.ref)} — {settledNote(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {noteCanCreditBargain && (
                <div className="flex flex-col gap-0.5">
                  <Label>Credit back to sales bargain</Label>
                  <Select value={noteBargain || 'NONE'} onValueChange={(v) => setNoteBargain(v === 'NONE' ? '' : v)}>
                    <SelectTrigger className="bg-white">
                      <SelectValue placeholder={noteParty ? 'Do not touch any bargain' : 'Pick the customer first'} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value="NONE">Do not touch any bargain</SelectItem>
                      {noteBargains.map((b) => (
                        <SelectItem key={String(b.id)} value={String(b.id)}>
                          {String(b.manual_bargain_no || b.bargain_no || b.id)} — {String(b.product_name || '')}
                          {' · bal '}
                          {formatNum(b.balance_qty)} {String(b.uom || 'MT')}
                        </SelectItem>
                      ))}
                      {noteBargains.length === 0 && (
                        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No sales bargains for this customer</div>
                      )}
                    </SelectContent>
                  </Select>
                  {noteBargain && (
                    <span className="text-[10px] text-muted-foreground">
                      {formatNum(noteReturnQty)} will be added back to its balance
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Items take the room they need and scroll on their own; the
                running total sits alongside rather than under, so a long note
                never pushes its own figures off the screen. */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
              <div
                className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-white/40"
                style={{ borderColor: '#D6E2D6' }}
              >
                {/* Sub-category chips sit with the items, not with the party
                    fields — they only ever narrow this picker. Few enough
                    values that one click beats opening a dropdown. */}
                <div
                  className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-[#EFF5EC] px-3 py-1.5"
                  style={{ borderColor: '#D6E2D6' }}
                >
                  <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Sub-category
                  </span>
                  {[{ key: 'ALL', label: 'All', count: noteProducts.length }, ...noteSubCats].map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setNoteSubCat(c.key)}
                      className={cn(
                        'cursor-pointer rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors',
                        noteSubCat === c.key
                          ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                          : 'border-[#D6E2D6] bg-white text-muted-foreground hover:bg-amber-50'
                      )}
                    >
                      {c.label}
                      <span className={cn('ml-1 text-[10px]', noteSubCat === c.key ? 'text-white/70' : 'text-muted-foreground/70')}>
                        {c.count}
                      </span>
                    </button>
                  ))}
                  {/* Tally's with / without inventory, on one control. */}
                  <div className="ml-auto inline-flex overflow-hidden rounded-md border text-[11px] font-semibold" style={{ borderColor: '#C3D2C6' }}>
                    {(['qty', 'value'] as const).map((m) => {
                      const on = m === 'qty' ? noteWithQty : !noteWithQty
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setNoteWithQty(m === 'qty')}
                          className={cn('px-2.5 py-1 transition-colors', on ? 'bg-[#0B3D2E] text-white' : 'bg-white text-muted-foreground hover:text-foreground')}
                        >
                          {m === 'qty' ? 'With quantity' : 'Amount only'}
                        </button>
                      )
                    })}
                  </div>
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">
                    {noteProductsShown.length} to pick from
                  </span>
                </div>
                <div
                  className="hidden shrink-0 grid-cols-[24px_minmax(0,1fr)_88px_112px_120px_28px] items-center gap-2 border-b bg-[#EAF0E9] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground md:grid xl:grid-cols-[24px_minmax(0,1fr)_100px_130px_140px_28px]"
                  style={{ borderColor: '#D6E2D6' }}
                >
                  <span>#</span>
                  <span>Item</span>
                  <span className="text-right">Qty (MT)</span>
                  <span className="text-right">Rate (₹ / MT)</span>
                  <span className="text-right">Amount</span>
                  <span />
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {noteItems.map((it, i) => (
                    <div
                      key={i}
                      className={cn(
                        'grid grid-cols-[24px_minmax(0,1fr)_28px] items-center gap-x-2 gap-y-1 border-b border-dotted px-3 py-1.5',
                        'md:grid-cols-[24px_minmax(0,1fr)_88px_112px_120px_28px] md:gap-y-0 md:py-1',
                        'xl:grid-cols-[24px_minmax(0,1fr)_100px_130px_140px_28px]',
                        i % 2 === 1 && 'bg-[#F7FAF6]'
                      )}
                      style={{ borderColor: '#DCE7DB' }}
                    >
                      <span className="col-start-1 row-start-1 text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                      <div className="col-start-2 row-start-1 min-w-0 md:contents">
                      <Select
                        value={it.product_id}
                        onValueChange={(v) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, product_id: v } : x)))}
                      >
                        <SelectTrigger className="bg-white"><SelectValue placeholder="Product" /></SelectTrigger>
                        <SelectContent className="max-h-72">
                          {noteProductsShown.length === 0 && (
                            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                              No product in this sub-category.
                            </div>
                          )}
                          {noteProductsShown.map((x) => (
                            <SelectItem key={String(x.id)} value={String(x.id)}>
                              {x.code || x.name}
                              {x.code && x.name && x.code !== x.name && (
                                <span className="ml-1.5 text-[11px] text-muted-foreground">{x.name}</span>
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      </div>
                      <div className="col-start-2 row-start-2 flex items-center gap-2 md:contents">
                        {noteWithQty ? (
                          <>
                            <Input
                              type="number"
                              className="min-w-0 flex-1 bg-white text-right tabular-nums"
                              placeholder="Qty"
                              aria-label="Qty in MT"
                              value={it.qty}
                              onChange={(e) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                            />
                            <Input
                              type="number"
                              className="min-w-0 flex-1 bg-white text-right tabular-nums"
                              placeholder="Rate"
                              aria-label="Rate per MT"
                              value={it.rate}
                              onChange={(e) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                            />
                            <span className="shrink-0 text-right text-[12.5px] font-semibold tabular-nums">
                              {formatINR(Math.round((Number(it.qty) || 0) * (Number(it.rate) || 0) * 100) / 100)}
                            </span>
                          </>
                        ) : (
                          <>
                            {/* Qty and Rate columns stay empty on an amount-only
                                line — the value is entered straight into Amount
                                and no quantity is recorded, so nothing moves in
                                stock. */}
                            <span className="hidden text-right text-[11px] text-muted-foreground md:block">—</span>
                            <span className="hidden text-right text-[11px] text-muted-foreground md:block">—</span>
                            <Input
                              type="number"
                              className="min-w-0 flex-1 bg-white text-right tabular-nums"
                              placeholder="Amount"
                              aria-label="Amount"
                              value={it.amount ?? ''}
                              onChange={(e) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                            />
                          </>
                        )}
                      </div>
                      <span className="col-start-3 row-start-1 text-right md:col-auto md:row-auto">
                        {noteItems.length > 1 && (
                          <button
                            type="button"
                            title="Remove this line"
                            className="cursor-pointer text-muted-foreground hover:text-red-600"
                            onClick={() => setNoteItems((p) => p.filter((_, j) => j !== i))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  <div className="px-3 py-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 bg-white text-xs"
                      onClick={() => setNoteItems((p) => [...p, { product_id: '', qty: '', rate: '' }])}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add item
                    </Button>
                  </div>
                </div>
                <div
                  className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t-2 bg-[#EAF0E9] px-3 py-1.5 text-[12px] font-bold md:grid-cols-[24px_minmax(0,1fr)_88px_112px_120px_28px] xl:grid-cols-[24px_minmax(0,1fr)_100px_130px_140px_28px]"
                  style={{ borderColor: '#0B3D2E' }}
                >
                  <span className="hidden md:block" />
                  <span className="uppercase tracking-widest text-muted-foreground">
                    {noteItems.filter((x) => x.product_id).length} item{noteItems.filter((x) => x.product_id).length === 1 ? '' : 's'}
                    <span className="ml-2 normal-case tracking-normal tabular-nums md:hidden">
                      {(noteItems.reduce((t, x) => t + (Number(x.qty) || 0), 0)).toFixed(3)} MT
                    </span>
                  </span>
                  <span className="hidden text-right tabular-nums md:block">
                    {(noteItems.reduce((t, x) => t + (Number(x.qty) || 0), 0)).toFixed(3)}
                  </span>
                  <span className="hidden md:block" />
                  <span className="text-right tabular-nums">{formatINR(noteTotals.base)}</span>
                  <span className="hidden md:block" />
                </div>
              </div>

              <div className="flex w-full shrink-0 flex-col gap-2 lg:w-[280px] xl:w-[300px]">
                <div
                  className="rounded-md border bg-white/60 px-3 py-2 text-[12.5px]"
                  style={{ borderColor: '#D6E2D6' }}
                >
                  <div className="mb-2 flex items-center justify-between border-b border-dashed pb-2" style={{ borderColor: '#D6E2D6' }}>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {vchType === 'DEBIT NOTE' ? 'Debit note' : 'Credit note'}
                    </span>
                    <span className="min-w-0 truncate text-[12px] font-semibold">{notePartyName || '—'}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">Taxable value</span>
                    <span className="tabular-nums">{formatINR(noteTotals.base)}</span>
                  </div>
                  <div className="flex items-center justify-between py-0.5">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      GST
                      <Input
                        type="number"
                        className="h-7 w-14 bg-white px-1.5 text-right text-[12px] tabular-nums"
                        value={noteGst}
                        onChange={(e) => setNoteGst(e.target.value)}
                      />
                      %
                    </span>
                    <span className="tabular-nums">{formatINR(noteTotals.gst)}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted-foreground">Round off</span>
                    <span className="tabular-nums">{formatINR(noteTotals.ro)}</span>
                  </div>
                  <div
                    className="mt-1.5 flex items-baseline justify-between border-t-2 pt-2 font-bold"
                    style={{ borderColor: '#0B3D2E' }}
                  >
                    <span className="text-[11px] uppercase tracking-wide">
                      {vchType === 'DEBIT NOTE' ? 'Dr party' : 'Cr party'}
                    </span>
                    <span className="text-[17px] tabular-nums">{formatINR(noteTotals.total)}</span>
                  </div>
                </div>
                <div
                  className="rounded-md border border-dashed px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground"
                  style={{ borderColor: '#D6E2D6' }}
                >
                  Posts{' '}
                  <span className="font-semibold text-foreground">
                    {notePartyKind === 'customer' ? 'SALES RETURN' : 'PURCHASE RETURN'}
                  </span>{' '}
                  against{' '}
                  <span className="font-semibold text-foreground">
                    {notePartyKind === 'customer' ? 'GST OUTPUT' : 'GST INPUT'}
                  </span>{' '}
                  with the round off, numbered automatically, and settles{' '}
                  {noteInvoice ? (
                    <>bill-wise against <span className="font-semibold text-foreground">{noteInvoice}</span></>
                  ) : (
                    'on account'
                  )}
                  .
                  {noteItems.some((x) => x.product_id) && (
                    <>
                      {' '}Item lines move stock:{' '}
                      {vchType === 'CREDIT NOTE' && notePartyKind === 'customer'
                        ? 'goods come back in.'
                        : vchType === 'DEBIT NOTE' && notePartyKind === 'supplier'
                          ? 'goods go back out.'
                          : 'money only — stock is untouched for this party side.'}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
  ) : null

  const voucherScreen = (
    <div className="flex flex-1 p-3">
      <div
        className={cn(
          'mx-auto flex w-full flex-col rounded-md border shadow-lg',
          noteInvoiceMode ? 'max-w-none lg:min-h-[calc(100vh-68px)]' : 'max-w-6xl',
          T.paperEdge,
          T.paper
        )}
      >
        <div className={cn('flex items-center justify-between rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">
            {editingId != null || noteEditId != null ? `Alter ${vchType}` : `${vchType} voucher`}
          </span>
          <span className="flex items-center gap-3 text-[11px] font-medium">
            No: {vchNo || 'Auto'}
            {noteEditId != null && (
              <button
                type="button"
                className="rounded bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-white/30"
                onClick={() => { setNoteEditId(null); setScreen('notesreg') }}
              >
                Back to register
              </button>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-b border-dashed px-4 py-2.5" style={{ borderColor: '#D6E2D6' }}>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Date (F2)</Label>
            <div ref={dateRef} className="w-36">
              <DatePicker value={vchDate} onChange={setVchDate} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Voucher no (optional)</Label>
            <Input className="h-9 w-36 bg-white" value={vchNo} onChange={(e) => setVchNo(e.target.value)} />
          </div>
          {isNoteType && editingId == null && noteEditId == null && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 bg-white text-xs"
              title="Tally's Ctrl+H — switch between item invoice and plain voucher entry"
              onClick={() => setNoteMode((m) => !m)}
            >
              {noteMode ? 'As voucher' : 'Item invoice'}
            </Button>
          )}
          <div className="ml-auto text-right text-[11px] text-muted-foreground">
            {vchType === 'CONTRA' && 'Cash ↔ bank only, both sides'}
            {vchType === 'PAYMENT' && 'Credit side must be cash / bank'}
            {vchType === 'RECEIPT' && 'Debit side must be cash / bank'}
            {vchType === 'JOURNAL' && 'Any ledgers, Dr = Cr'}
            {vchType === 'DEBIT NOTE' && 'Purchase return — Dr the supplier, Cr the purchase/GST ledgers'}
            {vchType === 'CREDIT NOTE' && 'Sales return — Dr the sales/GST ledgers, Cr the customer'}
          </div>
        </div>

        {structured && (
          <div className="px-4 py-3">
            <div className="mb-3">
              <Label className="text-[10px] uppercase tracking-wide">
                Account{payAccounts.length > 1 ? 's' : ''} — {vchType === 'PAYMENT' ? 'paid out of' : 'received into'}
              </Label>
              <div className="mt-1 rounded border" style={{ borderColor: '#D6E2D6' }}>
                {payAccounts.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 border-b border-dotted px-2 py-1.5 last:border-0" style={{ borderColor: '#DCE7DB' }}>
                    <div className="w-80">
                      <AccountPicker
                        value={l.account}
                        accounts={cashBankAccounts}
                        autoFocus={i === 0}
                        onPick={(name, group) => setPayAccountLine(i, { account: name, group })}
                        onCreate={(q) => setNewLedger({ name: q, group: 'Bank Accounts', forLine: null, target: 'payAccount', index: i })}
                      />
                    </div>
                    {/* With a single account the amount is always the full total —
                        the input only appears once the money is actually split
                        across more than one, so the common case stays simple. */}
                    {payAccounts.length > 1 && (
                      <>
                        <Input
                          type="number"
                          className="h-8 w-32 bg-white text-right tabular-nums"
                          value={l.amount}
                          onFocus={() => suggestPayAccountAmount(i)}
                          onChange={(e) => setPayAccountLine(i, { amount: e.target.value })}
                        />
                        <button
                          type="button"
                          className="cursor-pointer text-muted-foreground hover:text-red-600"
                          onClick={() => setPayAccounts((p) => p.filter((_, j) => j !== i))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                <div className="px-2 py-1">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPayAccounts((p) => [...p, blankPayLine()])}>
                    <Plus className="h-3.5 w-3.5" /> Split across another account
                  </Button>
                </div>
              </div>
              <span className="text-[11px] text-muted-foreground">
                cash and bank ledgers only{payAccounts.length > 1 ? ` · total ${formatINR(payAccountTotal)}` : ''}
              </span>
            </div>

            <div className="rounded border" style={{ borderColor: '#D6E2D6' }}>
              <div
                className="grid grid-cols-[1fr_150px_32px] items-center gap-2 border-b bg-[#EAF0E9] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
                style={{ borderColor: '#D6E2D6' }}
              >
                <span>Particulars ({vchType === 'PAYMENT' ? 'Dr — who is paid' : 'Cr — who pays us'})</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {payLines.map((l, i) => {
                const refs = refsCache[l.account] || []
                const billwise = isBillwise(l.group) || l.allocs.length > 0
                const lineAmt = Number(l.amount) || 0
                return (
                  <div key={i} className="border-b border-dotted px-3 py-2 last:border-0" style={{ borderColor: '#DCE7DB' }}>
                    <div className="grid grid-cols-[1fr_150px_32px] items-center gap-2">
                      <AccountPicker
                        value={l.account}
                        accounts={accounts}
                        autoFocus={i === 0}
                        onPick={(name, group) => {
                          setPayLine(i, { account: name, group, allocs: [] })
                          void loadRefs(name)
                        }}
                        onCreate={(q) =>
                          setNewLedger({
                            name: q,
                            group: vchType === 'PAYMENT' ? 'Sundry Creditors' : 'Sundry Debtors',
                            forLine: null,
                            target: 'payLine',
                            index: i
                          })
                        }
                      />
                      <Input
                        type="number"
                        className="h-8 bg-white text-right tabular-nums"
                        value={l.amount}
                        onChange={(e) => setPayLine(i, { amount: e.target.value })}
                      />
                      <span className="text-right">
                        {payLines.length > 1 && (
                          <button
                            type="button"
                            className="cursor-pointer text-muted-foreground hover:text-red-600"
                            onClick={() => setPayLines((p) => p.filter((_, j) => j !== i))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>

                    {billwise && (
                      <AllocPanel
                        lineAmount={lineAmt}
                        allocs={l.allocs}
                        refs={refs}
                        linkRefs={linkCache[l.account] || []}
                        onChange={(al) => setPayLine(i, { allocs: al })}
                      />
                    )}
                  </div>
                )
              })}
              <div className="px-3 py-1.5">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPayLines((p) => [...p, blankPayLine()])}>
                  <Plus className="h-3.5 w-3.5" /> Add party
                </Button>
              </div>
              <div className="flex items-center justify-between border-t-2 px-3 py-2 font-semibold" style={{ borderColor: '#0B3D2E' }}>
                <span className="text-[12px]">
                  {vchType === 'PAYMENT' ? 'Total paid' : 'Total received'}
                  {payAccounts.length === 1 && payAccounts[0].account
                    ? ` — ${vchType === 'PAYMENT' ? 'Cr' : 'Dr'} ${payAccounts[0].account}`
                    : payAccounts.length > 1
                      ? ` — split across ${payAccounts.length} accounts`
                      : ''}
                </span>
                <span className="tabular-nums">{formatINR(payTotal)}</span>
              </div>
            </div>
          </div>
        )}

        {noteInvoiceEditor}

        {!structured && !noteInvoiceMode && (vchType === 'DEBIT NOTE' || vchType === 'CREDIT NOTE') && (
          <div className="mx-4 mt-3 flex flex-wrap items-end gap-3 rounded border border-dashed border-sky-300 bg-sky-50/60 px-3 py-2">
            <span className="pb-1.5 text-[10px] font-bold uppercase tracking-widest text-sky-800">GST helper</span>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Taxable value</Label>
              <Input
                type="number"
                className="h-8 w-36 bg-white text-right tabular-nums"
                value={gstCalc.taxable}
                onChange={(e) => setGstCalc((g) => ({ ...g, taxable: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">GST %</Label>
              <Input
                type="number"
                className="h-8 w-20 bg-white text-right tabular-nums"
                value={gstCalc.pct}
                onChange={(e) => setGstCalc((g) => ({ ...g, pct: e.target.value }))}
              />
            </div>
            <Button size="sm" variant="outline" className="h-8 bg-white text-xs" onClick={applyGstCalc}>
              Build the legs
            </Button>
            <span className="pb-1.5 text-[11px] text-sky-800">
              {(() => {
                const t = Number(gstCalc.taxable) || 0
                const g = Math.round(t * (Number(gstCalc.pct) || 0)) / 100
                const total = Math.round(t + g)
                const ro = Math.round((total - t - g) * 100) / 100
                return t > 0
                  ? `GST ${formatINR(g)} · round off ${formatINR(ro)} · party ${formatINR(total)} — ${vchType === 'DEBIT NOTE' ? 'GST INPUT reversed, supplier debited' : 'GST OUTPUT reversed, customer credited'}`
                  : 'Types the taxable and GST legs, with the round off, so the party total is a whole rupee.'
              })()}
            </span>
          </div>
        )}

        {/* A niche tool, folded away. It was sitting above the entry lines
            taking the best space on the form for something used on perhaps one
            voucher in fifty — and pushing the thing you actually came to read
            below the fold. */}
        {!structured && !noteInvoiceMode && vchType === 'JOURNAL' && !rateDiffOpen && (
          <div className="px-4 pt-2.5">
            <button
              type="button"
              className="text-[11px] font-medium text-sky-700 hover:underline"
              onClick={() => setRateDiffOpen(true)}
            >
              + Rate difference helper
              <span className="ml-1.5 font-normal text-muted-foreground">
                — a price revision on a bill already invoiced
              </span>
            </button>
          </div>
        )}
        {!structured && !noteInvoiceMode && vchType === 'JOURNAL' && rateDiffOpen && (
          <div className="mx-4 mt-3 flex flex-wrap items-end gap-3 rounded border border-dashed border-sky-300 bg-sky-50/60 px-3 py-2">
            <span className="pb-1.5 text-[10px] font-bold uppercase tracking-widest text-sky-800">Rate difference helper</span>
            <div className="flex w-56 flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Party</Label>
              <AccountPicker
                value={rateDiff.party}
                accounts={accounts.filter((a) => isBillwise(a.acc_group))}
                onPick={(name, group) => {
                  setRateDiff((p) => ({ ...p, party: name, group }))
                  void loadRefs(name)
                }}
                onCreate={(q) => setNewLedger({ name: q, group: '', forLine: null })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Direction</Label>
              <Select value={rateDiff.direction} onValueChange={(v) => setRateDiff((p) => ({ ...p, direction: v as 'owes_more' | 'owes_less' }))}>
                <SelectTrigger className="h-8 w-40 bg-white text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="owes_more">Rate went up</SelectItem>
                  <SelectItem value="owes_less">Rate went down</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Amount (₹)</Label>
              <Input
                type="number"
                className="h-8 w-32 bg-white text-right tabular-nums"
                value={rateDiff.amount}
                onChange={(e) => setRateDiff((p) => ({ ...p, amount: e.target.value }))}
              />
            </div>
            <Button size="sm" variant="outline" className="h-8 bg-white text-xs" onClick={applyRateDiff}>
              Build the legs
            </Button>
            <button
              type="button"
              className="pb-1.5 text-[11px] text-muted-foreground hover:underline"
              onClick={() => setRateDiffOpen(false)}
            >
              Hide
            </button>
            <span className="pb-1.5 text-[11px] text-sky-800">
              {rateDiff.party
                ? `${rateDiff.direction === 'owes_more' ? 'Party owes more' : 'Party owes less'} against RATE DIFFERENCE A/C — settle bill-wise below if it's against a specific invoice.`
                : "For a price revision on a bill already invoiced — settles through RATE DIFFERENCE A/C without reopening it."}
            </span>
          </div>
        )}

        {!structured && !noteInvoiceMode && (
        <table className="ruled-cols w-full text-[13px]">
          <thead>
            <tr
              className="border-y bg-[#EAF0E9] text-left text-[10px] uppercase tracking-widest text-[#0B3D2E]"
              style={{ borderColor: '#D6E2D6' }}
            >
              <th className="w-16 px-4 py-1.5">Dr/Cr</th>
              <th className="px-2 py-1.5">Particulars</th>
              <th className="w-40 px-2 py-1.5 text-right">Debit</th>
              <th className="w-40 px-2 py-1.5 text-right">Credit</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <Fragment key={i}>
              <tr className="border-b border-dotted" style={{ borderColor: '#DCE7DB' }}>
                <td className="px-4 py-1.5">
                  <button
                    type="button"
                    title="Toggle Dr / Cr"
                    onClick={() => setLine(i, { side: l.side === 'dr' ? 'cr' : 'dr' })}
                    className={cn(
                      'w-10 cursor-pointer rounded px-1.5 py-0.5 text-center text-[12px] font-bold',
                      l.side === 'dr' ? 'bg-sky-100 text-sky-800' : 'bg-rose-100 text-rose-700'
                    )}
                  >
                    {l.side === 'dr' ? 'Dr' : 'Cr'}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <AccountPicker
                    value={l.account}
                    // Contra only ever moves money between cash and bank — offering
                    // every ledger here just let a wrong pick through to a
                    // confusing rejection at save time instead of not being
                    // choosable in the first place.
                    accounts={vchType === 'CONTRA' ? cashBankAccounts : accounts}
                    autoFocus={i === 0}
                    onPick={(name, group) => {
                      setLine(i, { account: name, group, allocs: [] })
                      void loadRefs(name)
                    }}
                    onCreate={(q) => setNewLedger({ name: q, group: vchType === 'CONTRA' ? 'Bank Accounts' : '', forLine: i })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  {l.side === 'dr' && (
                    <AmountInput
                      value={l.amount}
                      onFocus={() => suggestAmount(i)}
                      onChange={(v) => setLine(i, { amount: v })}
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {l.side === 'cr' && (
                    <AmountInput
                      value={l.amount}
                      onFocus={() => suggestAmount(i)}
                      onChange={(v) => setLine(i, { amount: v })}
                    />
                  )}
                </td>
                <td className="pr-3 text-right">
                  {lines.length > 2 && (
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground hover:text-red-600"
                      onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
              {(isBillwise(l.group) || l.allocs.length > 0) && (
                <tr>
                  <td />
                  <td colSpan={3} className="px-2 pb-2">
                    <AllocPanel
                      lineAmount={Number(l.amount) || 0}
                      allocs={l.allocs}
                      refs={refsCache[l.account] || []}
                      linkRefs={linkCache[l.account] || []}
                      onChange={(al) => setLine(i, { allocs: al })}
                    />
                  </td>
                  <td />
                </tr>
              )}
              </Fragment>
            ))}
            <tr>
              <td colSpan={5} className="px-4 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setLines((p) => [...p, { side: 'cr', account: '', group: '', amount: '', allocs: [] }])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 bg-[#EAF0E9] font-semibold" style={{ borderColor: '#0B3D2E' }}>
              <td className="px-4 py-2" colSpan={2}>
                {/* The state of the voucher, said as a state rather than left
                    to be worked out by comparing two totals. Which side is
                    short is the useful half — it says where to type next. */}
                {Math.abs(totals.diff) < 0.005 ? (
                  <span className="inline-flex items-center gap-1.5 rounded bg-emerald-100 px-2 py-0.5 text-[12px] text-emerald-800">
                    <Check className="h-3.5 w-3.5" /> Balanced
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded bg-rose-100 px-2 py-0.5 text-[12px] text-rose-800">
                      {totals.diff > 0 ? 'Credit short by' : 'Debit short by'}{' '}
                      <span className="doc-ref tabular-nums">{formatINR(Math.abs(totals.diff))}</span>
                    </span>
                    {Math.abs(totals.diff) < 1 && (
                      <Button size="sm" variant="outline" className="h-6 bg-white px-1.5 text-[11px]" onClick={addRoundOffLine}>
                        Close with round off
                      </Button>
                    )}
                  </span>
                )}
              </td>
              <td className="doc-ref px-2 py-2 text-right tabular-nums">{formatINR(totals.dr)}</td>
              <td className="doc-ref px-2 py-2 text-right tabular-nums">{formatINR(totals.cr)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        )}

        <div
          className={cn(
            'flex items-end gap-3 px-4 pb-4 pt-1',
            noteInvoiceMode && 'mt-auto border-t border-dashed px-3 pb-3 pt-2'
          )}
          style={noteInvoiceMode ? { borderColor: '#D6E2D6' } : undefined}
        >
          <div className="flex flex-1 flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Narration</Label>
            <Input className="h-9 bg-white" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being…" />
          </div>
          <Button className="bg-[#0B3D2E] hover:bg-[#0A3327]" disabled={saving} onClick={() => void saveVoucher()}>
            {saving ? 'Saving…' : editingId != null || noteEditId != null ? 'Save changes (Ctrl+A)' : 'Accept (Ctrl+A)'}
          </Button>
          {editingId != null && (
            <Button variant="outline" className="text-red-600" onClick={() => void deleteVoucher()}>
              <Trash2 className="h-4 w-4" /> Delete (Alt+D)
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  // Shared filter bar for both registers: period, free text, funding state.
  // fundingLabels omitted = no funding filter for that register (the sales
  // register has none, since bill discounting no longer links to an invoice).
  function registerFilters(fundingLabels?: [string, string]): React.JSX.Element {
    return (
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-56 bg-white text-[12px]"
          placeholder="Search invoice, party, product…"
          value={regSearch}
          onChange={(e) => setRegSearch(e.target.value)}
        />
        <FyPicker from={regFrom} to={regTo} onRange={(f, t) => { setRegFrom(f); setRegTo(t) }} className="h-8 w-28 bg-white text-xs" />
        <DatePicker value={regFrom} onChange={(v) => setRegFrom(v || '')} max={regTo || undefined} className="h-8 w-[8.5rem] bg-white text-[11px]" />
        <span className="text-[11px] text-muted-foreground">to</span>
        <DatePicker value={regTo} onChange={(v) => setRegTo(v || '')} min={regFrom || undefined} className="h-8 w-[8.5rem] bg-white text-[11px]" />
        {fundingLabels && (
          <MultiSelectFilter
            options={[
              { value: 'lc', label: fundingLabels[0] },
              { value: 'nolc', label: fundingLabels[1] }
            ]}
            value={regFunding}
            onApply={setRegFunding}
            allLabel="All"
            className="h-8 w-40 bg-white text-[11px]"
          />
        )}
        {(regFrom || regTo || regSearch || regFunding.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => { setRegFrom(''); setRegTo(''); setRegSearch(''); setRegFunding([]) }}
          >
            Clear
          </Button>
        )}
      </div>
    )
  }

  // Period + text + funding filter, applied to whichever register is showing.
  function inPeriod(dateVal: unknown): boolean {
    const d = String(dateVal || '').slice(0, 10)
    if (regFrom && d < regFrom) return false
    if (regTo && d > regTo) return false
    return true
  }

  const purchaseRows = useMemo(() => {
    const q = regSearch.trim().toLowerCase()
    return purchases.filter((o) => {
      if (!inPeriod(o.order_date)) return false
      if (regFunding.length && !regFunding.includes(o.lc_nos ? 'lc' : 'nolc')) return false
      if (!q) return true
      return [o.invoice_no, o.supplier_name, o.oil_code, o.oil_name, o.lc_nos]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchases, regFrom, regTo, regSearch, regFunding])

  const salesRegRows = useMemo(() => {
    const q = regSearch.trim().toLowerCase()
    return saleRows.filter((s) => {
      if (!inPeriod(s.sale_date)) return false
      if (!q) return true
      return [s.invoice_no, s.customer, s.product_name, s.gate_vehicle_no]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleRows, regFrom, regTo, regSearch])

  // Tag a purchase to an LC — issues a bill under that LC against the invoice,
  // which is what makes the purchase show as LC-funded and eats the limit.
  async function saveTag(): Promise<void> {
    if (!tagForm) return
    if (!tagForm.lc_id) return void toast.error('Pick the LC this purchase is funded by')
    if (!(Number(tagForm.amount) > 0)) return void toast.error('Enter the amount drawn under the LC')
    try {
      await window.api.lc.issue({
        lc_id: Number(tagForm.lc_id),
        order_id: Number(tagForm.order_id),
        amount: Number(tagForm.amount),
        issue_date: tagForm.issue_date,
        due_date: tagForm.due_date || '',
        bill_no: tagForm.bill_no || ''
      })
      toast.success(`${tagForm.invoice_no} tagged to the LC`)
      setTagForm(null)
      void loadRegisters()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // The desktop registers' column funnels (lib/colFilters) — the totals
  // below read the rows they leave.
  const dRegBal = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : formatINR(v))
  const dPurCf = colFilter<Row>(colF, 'dreg:purchase', purchaseRows, [
    { key: 'date', get: (o) => formatDate(o.order_date), sort: 'num' },
    { key: 'invoice', get: (o) => o.invoice_no },
    { key: 'supplier', get: (o) => o.supplier_name },
    { key: 'material', get: (o) => o.oil_code || o.oil_name },
    { key: 'qty', get: (o) => `${n(o.ordered_qty)} ${String(o.uom || 'MT')}`, sort: 'num' },
    { key: 'amount', get: (o) => formatINR(o.net_amount), sort: 'num' },
    {
      key: 'lc',
      get: (o) =>
        o.lc_nos
          ? `LC ${String(o.lc_nos)} · ${n(o.lc_bills_open) > 0 ? (o.lc_next_due && String(o.lc_next_due) < todayISO() ? 'overdue' : 'open') : 'settled'}`
          : 'own funds'
    },
    { key: 'paid', get: (o) => (n(o.paid_amount) ? formatINR(o.paid_amount) : '—'), sort: 'num' },
    { key: 'balance', get: (o) => dRegBal(n(o.net_amount) - n(o.paid_amount)), sort: 'num' },
    { key: 'tag', get: (o) => (o.lc_nos ? 'LC tagged' : 'No LC') }
  ])
  const dPurRows = dPurCf.rows
  const purchaseTotals = dPurRows.reduce(
    (a, o) => ({
      net: a.net + n(o.net_amount),
      lc: a.lc + n(o.lc_amount),
      paid: a.paid + n(o.paid_amount)
    }),
    { net: 0, lc: 0, paid: 0 }
  )

  const purchaseRegisterScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Purchase Register</span>
          {registerFilters(['Funded by LC', 'No LC tagged'])}
        </div>
        <div className="max-h-[calc(100vh-230px)] overflow-auto">
          <table className="w-full min-w-[1050px] text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#EAF0E9] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-semibold">{dPurCf.head('date', 'Date')}</th>
                <th className="px-3 py-2 font-semibold">{dPurCf.head('invoice', 'Invoice')}</th>
                <th className="px-3 py-2 font-semibold">{dPurCf.head('supplier', 'Supplier')}</th>
                <th className="px-3 py-2 font-semibold">{dPurCf.head('material', 'Material')}</th>
                <th className="px-3 py-2 text-right font-semibold">{dPurCf.head('qty', 'Qty', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dPurCf.head('amount', 'Amount', { align: 'end' })}</th>
                <th className="px-3 py-2 font-semibold">{dPurCf.head('lc', 'LC / funding')}</th>
                <th className="px-3 py-2 text-right font-semibold">{dPurCf.head('paid', 'Paid', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dPurCf.head('balance', 'Balance', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dPurCf.head('tag', 'Tag', { align: 'end' })}</th>
              </tr>
            </thead>
            <tbody>
              {dPurRows.length === 0 ? (
                <tr><td colSpan={10} className="py-12 text-center text-muted-foreground">No purchases for this filter.</td></tr>
              ) : (
                dPurRows.map((o) => {
                  const bal = n(o.net_amount) - n(o.paid_amount)
                  const overdue = o.lc_next_due && String(o.lc_next_due) < todayISO()
                  return (
                    <tr key={String(o.id)} className="border-b border-dotted border-[#DCE7DB] hover:bg-amber-100/60">
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{formatDate(o.order_date)}</td>
                      <td className="px-3 py-1.5 font-medium">{o.invoice_no || '—'}</td>
                      <td className="max-w-[180px] truncate px-3 py-1.5" title={String(o.supplier_name || '')}>{o.supplier_name || '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{o.oil_code || o.oil_name || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n(o.ordered_qty)} {o.uom || 'MT'}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatINR(o.net_amount)}</td>
                      <td className="px-3 py-1.5">
                        {o.lc_nos ? (
                          <span className="inline-flex flex-wrap items-center gap-1">
                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">LC</span>
                            <span className="font-medium">{o.lc_nos}</span>
                            {n(o.lc_bills_open) > 0 ? (
                              <span
                                className={cn(
                                  'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                                  overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
                                )}
                              >
                                {overdue ? 'overdue' : 'open'}
                                {o.lc_next_due ? ` · ${formatDate(o.lc_next_due)}` : ''}
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">settled</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">own funds</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{n(o.paid_amount) ? formatINR(o.paid_amount) : '—'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-medium tabular-nums', bal > 0.005 ? 'text-rose-700' : 'text-muted-foreground')}>
                        {formatINR(bal)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          onClick={() =>
                            setTagForm({
                              order_id: o.id,
                              invoice_no: o.invoice_no,
                              supplier_name: o.supplier_name,
                              amount: String(Math.round(n(o.net_amount) - n(o.lc_amount))),
                              bill_no: o.invoice_no,
                              issue_date: todayISO()
                            })
                          }
                        >
                          {o.lc_nos ? '+ LC' : 'Tag LC'}
                        </Button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {dPurRows.length > 0 && (
              <tfoot className="sticky bottom-0">
                <tr className="border-t-2 border-amber-500 bg-amber-100 font-semibold">
                  <td className="px-3 py-2 text-[11px] uppercase tracking-wide text-amber-900" colSpan={5}>
                    {dPurRows.length} purchase{dPurRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.net)}</td>
                  <td className="px-3 py-2 text-right text-[11px] tabular-nums text-amber-900">{formatINR(purchaseTotals.lc)} on LC</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.paid)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.net - purchaseTotals.paid)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )

  const dSalNet = (s: Row): number =>
    n(s.amount) + n(s.gst_amount) + n(s.round_off) - (Number(s.deduct_freight) ? n(s.transport_amount) : 0)
  const dSalCf = colFilter<Row>(colF, 'dreg:sales', salesRegRows, [
    { key: 'date', get: (s) => formatDate(s.sale_date), sort: 'num' },
    { key: 'invoice', get: (s) => s.invoice_no },
    { key: 'vehicle', get: (s) => s.gate_vehicle_no || 'not gated out' },
    { key: 'customer', get: (s) => s.customer },
    { key: 'product', get: (s) => s.product_name },
    { key: 'qty', get: (s) => `${n(s.qty)} ${String(s.uom || 'MT')}`, sort: 'num' },
    { key: 'amount', get: (s) => formatINR(dSalNet(s)), sort: 'num' },
    { key: 'received', get: (s) => (n(s.received_amount) ? formatINR(s.received_amount) : '—'), sort: 'num' },
    { key: 'balance', get: (s) => dRegBal(dSalNet(s) - n(s.received_amount)), sort: 'num' }
  ])
  const dSalRows = dSalCf.rows
  const salesTotals = dSalRows.reduce(
    (a, s) => ({
      net: a.net + n(s.amount) + n(s.gst_amount) + n(s.round_off) - (Number(s.deduct_freight) ? n(s.transport_amount) : 0),
      recd: a.recd + n(s.received_amount)
    }),
    { net: 0, recd: 0 }
  )

  const salesRegisterScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Sales Register</span>
          {registerFilters()}
        </div>
        <div className="max-h-[calc(100vh-230px)] overflow-auto">
          <table className="w-full min-w-[1000px] text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#EAF0E9] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-semibold">{dSalCf.head('date', 'Date')}</th>
                <th className="px-3 py-2 font-semibold">{dSalCf.head('invoice', 'Invoice')}</th>
                <th className="px-3 py-2 font-semibold">{dSalCf.head('vehicle', 'Vehicle')}</th>
                <th className="px-3 py-2 font-semibold">{dSalCf.head('customer', 'Customer')}</th>
                <th className="px-3 py-2 font-semibold">{dSalCf.head('product', 'Product')}</th>
                <th className="px-3 py-2 text-right font-semibold">{dSalCf.head('qty', 'Qty', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dSalCf.head('amount', 'Amount', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dSalCf.head('received', 'Received', { align: 'end' })}</th>
                <th className="px-3 py-2 text-right font-semibold">{dSalCf.head('balance', 'Balance', { align: 'end' })}</th>
              </tr>
            </thead>
            <tbody>
              {dSalRows.length === 0 ? (
                <tr><td colSpan={9} className="py-12 text-center text-muted-foreground">No sales for this filter.</td></tr>
              ) : (
                dSalRows.map((s) => {
                  const net = n(s.amount) + n(s.gst_amount) + n(s.round_off) - (Number(s.deduct_freight) ? n(s.transport_amount) : 0)
                  const bal = net - n(s.received_amount)
                  return (
                    <tr key={String(s.id)} className="border-b border-dotted border-[#DCE7DB] hover:bg-amber-100/60">
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{formatDate(s.sale_date)}</td>
                      <td className="px-3 py-1.5 font-medium">{s.invoice_no || '—'}</td>
                      <td className="px-3 py-1.5">
                        {s.gate_vehicle_no ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="font-medium">{s.gate_vehicle_no}</span>
                            <span className="text-[10px] text-muted-foreground">{s.gate_entry_no}</span>
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">not gated out</span>
                        )}
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-1.5" title={String(s.customer || '')}>{s.customer || '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{s.product_name || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n(s.qty)} {s.uom || 'MT'}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatINR(net)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{n(s.received_amount) ? formatINR(s.received_amount) : '—'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-medium tabular-nums', bal > 0.005 ? 'text-rose-700' : 'text-muted-foreground')}>
                        {formatINR(bal)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {dSalRows.length > 0 && (
              <tfoot className="sticky bottom-0">
                <tr className="border-t-2 border-amber-500 bg-amber-100 font-semibold">
                  <td className="px-3 py-2 text-[11px] uppercase tracking-wide text-amber-900" colSpan={6}>
                    {dSalRows.length} sale{dSalRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.net)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.recd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.net - salesTotals.recd)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )

  const dDayCf = colFilter<Row>(colF, 'd:daybook', dayRows as Row[], [
    { key: 'date', get: (r) => formatDate(r.entry_date), sort: 'num' },
    { key: 'particulars', get: (r) => [String(r.dr_account || '—'), String(r.cr_account || '—')] },
    { key: 'type', get: (r) => r.vch_type },
    { key: 'no', get: (r) => r.vch_no },
    { key: 'amount', get: (r) => formatINR(r.amount), sort: 'num' },
    { key: 'entry', get: (r) => (r.manual ? 'Manual' : 'Auto') }
  ])
  const dDayRows = dDayCf.rows
  const daybookScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Day Book</span>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={dbFrom} to={dbTo} onRange={(f, t) => { setDbFrom(f); setDbTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={dbFrom} onChange={setDbFrom} max={dbTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={dbTo} onChange={setDbTo} min={dbFrom || undefined} /></div>
            <MultiSelectFilter
              options={[
                ...VCH_TYPES.map((v) => ({ value: v.key, label: v.label })),
                { value: 'PURCHASE OIL', label: 'Purchase (auto)' },
                { value: 'PURCHASE FREIGHT INWARD', label: 'Freight inward bill' },
                { value: 'PURCHASE FREIGHT OUTWARD', label: 'Freight outward bill' },
                { value: 'SALE', label: 'Sales (auto)' }
              ]}
              value={dbType}
              onApply={setDbType}
              allLabel="All vouchers"
              className="h-9 w-36 bg-white text-xs"
            />
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#EAF0E9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">{dDayCf.head('date', 'Date')}</th>
                <th className="px-2 py-1.5">{dDayCf.head('particulars', 'Particulars')}</th>
                <th className="px-2 py-1.5">{dDayCf.head('type', 'Vch type')}</th>
                <th className="px-2 py-1.5">{dDayCf.head('no', 'Vch no')}</th>
                <th className="px-2 py-1.5 text-right">{dDayCf.head('amount', 'Amount', { align: 'end' })}</th>
                <th className="w-20 py-1.5 pl-2 pr-5 text-center">{dDayCf.head('entry', 'Entry')}</th>
              </tr>
            </thead>
            <tbody>
              {dDayRows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No vouchers in this period.</td></tr>
              ) : (
                dDayRows.map((r) => (
                  <tr
                    key={String(r.id)}
                    className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                    style={{ borderColor: '#DCE7DB' }}
                    onClick={() => void openForAlter(r)}
                  >
                    <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">{formatDate(r.entry_date)}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{r.dr_account || '—'}</div>
                      <div className="text-[11px] text-muted-foreground">to {r.cr_account || '—'}</div>
                    </td>
                    <td className="px-2 py-1.5">{r.vch_type}</td>
                    <td className="px-2 py-1.5">{r.vch_no || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(r.amount)}</td>
                    <td className="py-1.5 pl-2 pr-5 text-center">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', r.manual ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600')}>
                        {r.manual ? 'Manual' : 'Auto'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  // Filtered view of the note register — kind, date range and a free-text match
  // on the note number, party or narration.
  const noteRegRows = useMemo(() => {
    const q = nrSearch.trim().toUpperCase()
    return noteRows.filter((r) => {
      if (noteKindFilter !== 'all' && String(r.note_type) !== noteKindFilter) return false
      const d = String(r.note_date || '').slice(0, 10)
      if (nrFrom && d < nrFrom) return false
      if (nrTo && d > nrTo) return false
      if (!q) return true
      return [r.note_no, r.party_name, r.narration, r.against_account, r.against_ref]
        .some((x) => String(x || '').toUpperCase().includes(q))
    })
  }, [noteRows, noteKindFilter, nrFrom, nrTo, nrSearch])

  // The website register: the notes AND the notes entered as plain vouchers,
  // filtered by the same rules, newest first — so its count agrees with the
  // gateway, which counts every DEBIT NOTE / CREDIT NOTE voucher.
  const noteRegRowsWeb = useMemo(() => {
    const q = nrSearch.trim().toUpperCase()
    const extra = noteVchRows.filter((r) => {
      if (noteKindFilter !== 'all' && String(r.note_type) !== noteKindFilter) return false
      const d = String(r.note_date || '').slice(0, 10)
      if (nrFrom && d < nrFrom) return false
      if (nrTo && d > nrTo) return false
      if (!q) return true
      return [r.note_no, r.party_name, r.narration].some((x) => String(x || '').toUpperCase().includes(q))
    })
    return [...noteRegRows, ...extra].sort((x, y) => String(y.note_date || '').localeCompare(String(x.note_date || '')))
  }, [noteRegRows, noteVchRows, noteKindFilter, nrFrom, nrTo, nrSearch])

  const noteRegTotals = useMemo(
    () =>
      noteRegRows.reduce(
        (t, r) => ({
          base: t.base + (Number(r.base_amount) || 0),
          gst: t.gst + (Number(r.gst_amount) || 0),
          total: t.total + (Number(r.total_amount) || 0)
        }),
        { base: 0, gst: 0, total: 0 }
      ),
    [noteRegRows]
  )

  async function toggleNoteRow(id: number): Promise<void> {
    if (noteOpen === id) return void setNoteOpen(null)
    setNoteOpen(id)
    if (noteRowItems[id]) return
    try {
      const its = await window.api.notes.items(id)
      setNoteRowItems((p) => ({ ...p, [id]: its }))
    } catch {
      setNoteRowItems((p) => ({ ...p, [id]: [] }))
    }
  }

  async function deleteNoteRow(r: Row): Promise<void> {
    if (!vchRights(String(r.note_type) === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE').delete) {
      toast.error(`You do not have rights to delete a ${String(r.note_type) === 'credit' ? 'credit' : 'debit'} note`)
      return
    }
    if (!window.confirm(`Delete ${String(r.note_type) === 'credit' ? 'credit' : 'debit'} note ${r.note_no}? Its voucher, ledger entry and any stock it moved are reversed.`)) return
    try {
      await window.api.notes.remove(Number(r.id), cid)
      toast.success(`Note ${r.note_no} deleted`)
      setNoteOpen(null)
      setNoteRowItems({})
      await loadNoteRegister()
      loadAccounts()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const dNoteCf = colFilter<Row>(colF, 'd:notes', noteRegRows, [
    { key: 'date', get: (r) => formatDate(r.note_date), sort: 'num' },
    { key: 'no', get: (r) => r.note_no },
    { key: 'type', get: (r) => (String(r.note_type) === 'credit' ? 'Credit' : 'Debit') },
    { key: 'party', get: (r) => r.party_name },
    { key: 'against', get: (r) => r.against_account },
    { key: 'orig', get: (r) => r.against_ref || 'On account' },
    { key: 'taxable', get: (r) => formatINR(r.base_amount), sort: 'num' },
    { key: 'gst', get: (r) => formatINR(r.gst_amount), sort: 'num' },
    { key: 'total', get: (r) => formatINR(r.total_amount), sort: 'num' }
  ])
  const dNoteRows = dNoteCf.rows
  const dNoteTot = dNoteRows.reduce(
    (a, r) => ({ base: a.base + n(r.base_amount), gst: a.gst + n(r.gst_amount), total: a.total + n(r.total_amount) }),
    { base: 0, gst: 0, total: 0 }
  )
  const notesRegisterScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Debit / Credit Notes</span>
          <div className="flex items-center gap-1">
            {(['all', 'debit', 'credit'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setNoteKindFilter(k)}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide',
                  noteKindFilter === k ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25'
                )}
              >
                {k === 'all' ? 'All' : k === 'debit' ? 'Debit notes' : 'Credit notes'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Input
              className="h-9 w-44 bg-white text-xs"
              placeholder="Search note / party…"
              value={nrSearch}
              onChange={(e) => setNrSearch(e.target.value)}
            />
            <FyPicker from={nrFrom} to={nrTo} onRange={(f, t) => { setNrFrom(f); setNrTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={nrFrom} onChange={setNrFrom} max={nrTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={nrTo} onChange={setNrTo} min={nrFrom || undefined} /></div>
            {(nrFrom || nrTo) && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-white hover:bg-white/20" onClick={() => { setNrFrom(''); setNrTo('') }}>
                All
              </Button>
            )}
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#EAF0E9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="w-8 py-1.5 pl-4" />
                <th className="px-2 py-1.5">{dNoteCf.head('date', 'Date')}</th>
                <th className="px-2 py-1.5">{dNoteCf.head('no', 'Note no')}</th>
                <th className="px-2 py-1.5">{dNoteCf.head('type', 'Type')}</th>
                <th className="px-2 py-1.5">{dNoteCf.head('party', 'Party')}</th>
                <th className="px-2 py-1.5">{dNoteCf.head('against', 'Against')}</th>
                <th className="px-2 py-1.5">{dNoteCf.head('orig', 'Orig. invoice')}</th>
                <th className="px-2 py-1.5 text-right">{dNoteCf.head('taxable', 'Taxable', { align: 'end' })}</th>
                <th className="px-2 py-1.5 text-right">{dNoteCf.head('gst', 'GST', { align: 'end' })}</th>
                <th className="px-2 py-1.5 text-right">{dNoteCf.head('total', 'Total', { align: 'end' })}</th>
                <th className="w-24 py-1.5 pl-2 pr-4 text-center">Actions</th>
              </tr>
              {dNoteRows.length > 0 && (
                <tr className="bg-[#C3D2C6] text-[12px] font-semibold">
                  <td className="py-1.5 pl-4" colSpan={7}>
                    {dNoteRows.length} note{dNoteRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(dNoteTot.base)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(dNoteTot.gst)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(dNoteTot.total)}</td>
                  <td className="py-1.5 pl-2 pr-4" />
                </tr>
              )}
            </thead>
            <tbody>
              {dNoteRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">
                    No debit or credit notes {noteRows.length ? 'match these filters' : 'raised yet'}.
                  </td>
                </tr>
              ) : (
                dNoteRows.map((r) => {
                  const id = Number(r.id)
                  const credit = String(r.note_type) === 'credit'
                  const open = noteOpen === id
                  return (
                    <Fragment key={id}>
                      <tr
                        className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                        style={{ borderColor: '#DCE7DB' }}
                        onClick={() => void toggleNoteRow(id)}
                      >
                        <td className="py-1.5 pl-4">
                          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{formatDate(r.note_date)}</td>
                        <td className="px-2 py-1.5 font-medium">{r.note_no}</td>
                        <td className="px-2 py-1.5">
                          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', credit ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700')}>
                            {credit ? 'Credit' : 'Debit'}
                          </span>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{r.party_name || '—'}</div>
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.party_type}</div>
                        </td>
                        <td className="px-2 py-1.5 text-[12px]">{r.against_account || '—'}</td>
                        <td className="px-2 py-1.5 text-[12px]">{r.against_ref || <span className="text-muted-foreground">On account</span>}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(r.base_amount)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatINR(r.gst_amount)}
                          {Number(r.gst_pct) ? <span className="ml-1 text-[10px] text-muted-foreground">@{Number(r.gst_pct)}%</span> : null}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{formatINR(r.total_amount)}</td>
                        <td className="py-1.5 pl-2 pr-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void openNoteForAlter(r)}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-rose-700 hover:bg-rose-100" onClick={() => void deleteNoteRow(r)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-dotted bg-amber-50/60" style={{ borderColor: '#DCE7DB' }}>
                          <td />
                          <td colSpan={10} className="px-2 py-2">
                            {r.narration ? (
                              <div className="mb-1.5 text-[12px] italic text-muted-foreground">{r.narration}</div>
                            ) : null}
                            {r.bargain_no ? (
                              <div className="mb-1.5 text-[12px]">
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                                  Credited back to bargain{' '}
                                </span>
                                <span className="font-semibold">{String(r.bargain_no)}</span>
                              </div>
                            ) : null}
                            {!noteRowItems[id] ? (
                              <div className="text-[12px] text-muted-foreground">Loading item lines…</div>
                            ) : noteRowItems[id].length === 0 ? (
                              <div className="text-[12px] text-muted-foreground">
                                No item lines — this note adjusts money only, so it does not move stock.
                              </div>
                            ) : (
                              <table className="w-full max-w-3xl text-[12px]">
                                <thead>
                                  <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                                    <th className="py-1 pr-2">Product</th>
                                    <th className="px-2 py-1 text-right">Qty</th>
                                    <th className="px-2 py-1 text-right">Rate</th>
                                    <th className="px-2 py-1 text-right">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {noteRowItems[id].map((it) => (
                                    <tr key={String(it.id)}>
                                      <td className="py-1 pr-2">{it.product_name || it.description || '—'}</td>
                                      <td className="px-2 py-1 text-right tabular-nums">{Number(it.qty) || 0}</td>
                                      <td className="px-2 py-1 text-right tabular-nums">{formatINR(it.rate)}</td>
                                      <td className="px-2 py-1 text-right tabular-nums">{formatINR(it.amount)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  // ---- Transporter freight register (both sides share this) ----
  const tfLabel = tfSide === 'purchase' ? 'Fr. Inward Working' : 'Fr. Outward Working'
  const tfPickedRows = useMemo(() => tfRows.filter((r) => tfPicked.includes(Number(r.id))), [tfRows, tfPicked])
  const tfPickedTotal = useMemo(() => tfPickedRows.reduce((t, r) => t + (Number(r.amount) || 0), 0), [tfPickedRows])
  // Every line on one bill has to be the same transporter — the backend
  // enforces it, so the button says why rather than letting the save fail.
  const tfPickedParties = useMemo(
    () => [...new Set(tfPickedRows.map((r) => String(r.transporter_name || '')))],
    [tfPickedRows]
  )
  // The transporter's GST registration decides the bill: registered carries
  // GST, unregistered none (reverse charge) and is booked as a JV.
  const tfUnreg = String(tfPickedRows[0]?.gst_registration || '') === 'unregistered'
  const tfBillCalc = (() => {
    const lines = Math.round(tfPickedTotal * 100) / 100
    // What the transporter actually billed, over or under the tanker lines.
    const adj = Math.round((Number(tfBill.adjustment) || 0) * 100) / 100
    const taxable = Math.round((lines + adj) * 100) / 100
    const gstPct = tfUnreg ? 0 : Number(tfBill.gst_pct) || 0
    const gst = Math.round(taxable * gstPct) / 100
    const tds = Math.round(taxable * (Number(tfBill.tds_pct) || 0)) / 100
    // Others: recovered on the bill, off what the transporter is paid.
    const others = Math.max(0, Math.round((Number(tfBill.others_amount) || 0) * 100) / 100)
    const raw = Math.round((taxable + gst - tds - others) * 100) / 100
    const total = Math.round(raw)
    return { lines, adj, taxable, gstPct, gst, tds, others, ro: Math.round((total - raw) * 100) / 100, total }
  })()

  function tfToggle(row: Row): void {
    const id = Number(row.id)
    // "By oil invoice" ticks every line of that document at once — one bill
    // usually covers a whole invoice's tankers.
    const ids =
      tfPickBy === 'invoice'
        ? tfRows
            .filter(
              (r) =>
                String(r.doc_no || '') === String(row.doc_no || '') &&
                String(r.transporter_name) === String(row.transporter_name) &&
                r.bill_id == null &&
                r.note_id == null &&
                r.waived_at == null &&
                !(String(r.entry_type) === 'shortage_penalty' && String(r.gst_registration || '') !== 'unregistered')
            )
            .map((r) => Number(r.id))
        : [id]
    setTfPicked((p) => (p.includes(id) ? p.filter((x) => !ids.includes(x)) : [...new Set([...p, ...ids])]))
  }

  async function tfSaveBill(): Promise<void> {
    if (!tfPickedRows.length) return void toast.error('Tick at least one freight line')
    if (tfPickedParties.length > 1) return void toast.error('All the lines on one bill must be the same transporter')
    setTfSaving(true)
    try {
      await window.api.transporterFreight.createBill({
        company_id: cid,
        transporter_id: Number(tfPickedRows[0].transporter_id),
        side: tfSide,
        bill_no: tfBill.bill_no || null,
        bill_date: tfBill.bill_date || todayISO(),
        gst_pct: tfBillCalc.gstPct,
        tds_pct: Number(tfBill.tds_pct) || 0,
        adjustment: Number(tfBill.adjustment) || 0,
        adjustment_note: tfBill.adjustment_note || null,
        others_amount: tfBillCalc.others,
        others_ledger: String(tfBill.others_ledger || '').trim() || null,
        others_note: String(tfBill.others_note || '').trim() || null,
        note: tfBill.note || null,
        line_ids: tfPickedRows.map((r) => Number(r.id))
      })
      toast.success(`Booked ${formatINR(tfBillCalc.total)} to ${tfPickedRows[0].transporter_name}`)
      setTfBillOpen(false)
      setTfPicked([])
      setTfBill({ bill_no: '', bill_date: todayISO(), gst_pct: '5', tds_pct: '', adjustment: '', adjustment_note: '', note: '', others_amount: '', others_ledger: '', others_note: '' })
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTfSaving(false)
    }
  }

  // Delete a booked bill: its voucher is reversed and every freight line on it
  // goes back to Pending. The freight itself is untouched — it was still
  // earned, it simply stops being billed.
  // A shortage can be recovered two ways and only ever one of them: netted off
  // the transporter's freight bill, or claimed on its own debit note. Raising
  // the note takes the line off the bill for good — the backend refuses to book
  // a claimed line — so the freight then goes on in full and the note stands
  // beside it, which is what a debit note actually means.
  const [tfNoting, setTfNoting] = useState<number | null>(null)
  // Writing a shortage off instead of claiming it. The reason is required —
  // a waived claim with no explanation cannot be reviewed months later.
  const [tfWaive, setTfWaive] = useState<Row | null>(null)
  const [tfWaiveReason, setTfWaiveReason] = useState('')
  // The website's two drawers, and their Esc: typed work takes a second Esc.
  const tfBookRef = useRef<HTMLDivElement>(null)
  const tfWaiveRef = useRef<HTMLDivElement>(null)
  useDrawerEscape(__WEB__ && tfBillOpen, tfBookRef, () => {
    if (tfSaving) return false
    const dirty = !!String(tfBill.bill_no || '').trim() || !!String(tfBill.adjustment || '').trim() || !!String(tfBill.note || '').trim()
    if (!escMayDiscard(dirty)) return false
    setTfBillOpen(false)
  })
  useDrawerEscape(__WEB__ && !!tfWaive, tfWaiveRef, () => {
    if (tfNoting != null) return false
    if (!escMayDiscard(!!tfWaiveReason.trim())) return false
    setTfWaive(null)
    setTfWaiveReason('')
  })
  async function tfRaiseNote(row: Row): Promise<void> {
    setTfNoting(Number(row.id))
    try {
      const res = await window.api.transporterFreight.raiseShortageNote(Number(row.id), undefined, cid)
      toast.success(`Debit note ${res.note_no} raised on ${row.transporter_name}`)
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTfNoting(null)
    }
  }
  async function tfUnraiseNote(row: Row): Promise<void> {
    if (!window.confirm(`Delete debit note ${row.note_no}? Its voucher is reversed and the shortage goes back to being a deduction on the freight bill.`)) return
    setTfNoting(Number(row.id))
    try {
      await window.api.transporterFreight.unraiseShortageNote(Number(row.id), cid)
      toast.success(`Debit note ${row.note_no} deleted`)
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTfNoting(null)
    }
  }

  async function tfDoWaive(): Promise<void> {
    const row = tfWaive
    if (!row) return
    if (!tfWaiveReason.trim()) return void toast.error('Say why this shortage is not the transporter\'s')
    setTfNoting(Number(row.id))
    try {
      await window.api.transporterFreight.waiveShortage(Number(row.id), tfWaiveReason.trim(), cid)
      toast.success('Written off — the transporter bills in full')
      setTfWaive(null)
      setTfWaiveReason('')
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTfNoting(null)
    }
  }
  async function tfUnwaive(row: Row): Promise<void> {
    if (!window.confirm('Undo this write-off? Its voucher is reversed and the shortage goes back to being a claim.')) return
    setTfNoting(Number(row.id))
    try {
      await window.api.transporterFreight.unwaiveShortage(Number(row.id), cid)
      toast.success('Write-off undone')
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTfNoting(null)
    }
  }

  async function tfConfirmUnbook(): Promise<void> {
    const bill = tfUnbook
    if (!bill) return
    setTfUnbooking(true)
    try {
      await window.api.transporterFreight.deleteBill(Number(bill.bill_id ?? bill.id), cid)
      toast.success(`Bill ${String(bill.bill_no || '')} deleted — its freight is back to pending`)
      setTfUnbook(null)
      setTfPicked([])
      await loadTFreight()
      loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTfUnbooking(false)
    }
  }

  // The two dialogs this register opens. Pulled out of the screen so the
  // canvas rebuild below can mount exactly the same ones — a screen that
  // books a bill must be able to book it on either reading of the page.
  const tfDialogs = (
    <>
        <Dialog open={!!tfUnbook} onOpenChange={(o) => !o && !tfUnbooking && setTfUnbook(null)}>
          <DialogContent className="max-w-md" onEscapeKeyDown={escToClose()}>
            <DialogHeader>
              <DialogTitle>Delete bill {String(tfUnbook?.bill_no || '')}?</DialogTitle>
            </DialogHeader>
            <p className="text-[12px] text-muted-foreground">
              The bill and its journal voucher are reversed, and every freight line on it goes back to{' '}
              <b>Pending</b> on this register. The freight itself is not touched — it was still earned, it just stops
              being billed. A bill can cover several lines, so all of them are released together.
            </p>
            {tfUnbook?.transporter_name && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-[12px]">
                <div><span className="text-muted-foreground">Transporter</span> · {String(tfUnbook.transporter_name)}</div>
                {tfUnbook.line_count != null && (
                  <div>
                    <span className="text-muted-foreground">Releases</span> · {String(tfUnbook.line_count)} line
                    {Number(tfUnbook.line_count) === 1 ? '' : 's'} · {formatINR(tfUnbook.line_amount)}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setTfUnbook(null)} disabled={tfUnbooking}>Cancel</Button>
              <Button variant="destructive" onClick={() => void tfConfirmUnbook()} disabled={tfUnbooking}>
                {tfUnbooking ? 'Deleting…' : 'Delete bill'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={tfBillOpen && !__WEB__} onOpenChange={(o) => !o && !tfSaving && setTfBillOpen(false)}>
          <DialogContent
            className="max-w-lg border-[#D6E2D6] bg-[#F7FAF6]"
            onEscapeKeyDown={escToClose(
              !!String(tfBill.bill_no || '').trim() || !!String(tfBill.adjustment || '').trim() || !!String(tfBill.note || '').trim()
            )}
          >
            <DialogHeader>
              <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#0B3D2E]">
                Book bill — {tfPickedRows[0]?.transporter_name || ''}
              </DialogTitle>
            </DialogHeader>
            <p className="text-[12px] text-muted-foreground">
              Posts the transporter&apos;s bill for the {tfPicked.length} ticked line{tfPicked.length === 1 ? '' : 's'}. Until now this
              freight sat against{' '}
              {tfPickedRows.every((r) => Number(r.accrued) === 1) ? 'FREIGHT PAYABLE' : 'no ledger at all'} — booking it is what puts it on
              their account.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">Bill no</Label>
                <Input className="bg-white" value={String(tfBill.bill_no ?? '')} onChange={(e) => setTfBill((p) => ({ ...p, bill_no: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">Bill date</Label>
                <DatePicker value={String(tfBill.bill_date || todayISO())} onChange={(v) => setTfBill((p) => ({ ...p, bill_date: v }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">GST %</Label>
                <Input type="number" className="bg-white" value={String(tfBill.gst_pct ?? '')} onChange={(e) => setTfBill((p) => ({ ...p, gst_pct: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">TDS % on freight</Label>
                <Input type="number" className="bg-white" value={String(tfBill.tds_pct ?? '')} onChange={(e) => setTfBill((p) => ({ ...p, tds_pct: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1 text-[10px] uppercase tracking-wide">
                  Adjustment (+ / −)
                </Label>
                <Input
                  type="number"
                  className="bg-white"
                  placeholder="0.00"
                  value={String(tfBill.adjustment ?? '')}
                  onChange={(e) => setTfBill((p) => ({ ...p, adjustment: e.target.value }))}
                />
                <span className="text-[10px] leading-snug text-muted-foreground">
                  Bill more or less than the tanker lines — a rate settled later, detention, a negotiated cut. Negative reduces.
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">Reason for the adjustment</Label>
                <Input
                  className="bg-white"
                  placeholder={Number(tfBill.adjustment) ? 'Say why' : 'Only if adjusted'}
                  value={String(tfBill.adjustment_note ?? '')}
                  onChange={(e) => setTfBill((p) => ({ ...p, adjustment_note: e.target.value }))}
                />
              </div>
            </div>
            <div className="rounded-md border bg-white/60 px-3 py-2 text-[13px]" style={{ borderColor: '#D6E2D6' }}>
              <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Freight on the ticked lines</span><span className="tabular-nums">{formatINR(tfBillCalc.lines)}</span></div>
              {!!tfBillCalc.adj && (
                <div className="flex justify-between py-0.5">
                  <span className="text-muted-foreground">Adjustment</span>
                  <span className={cn('tabular-nums', tfBillCalc.adj < 0 ? 'text-rose-700' : 'text-emerald-700')}>
                    {tfBillCalc.adj > 0 ? '+ ' : '− '}{formatINR(Math.abs(tfBillCalc.adj))}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Taxable</span><span className="tabular-nums">{formatINR(tfBillCalc.taxable)}</span></div>
              <div className="flex justify-between py-0.5"><span className="text-muted-foreground">GST</span><span className="tabular-nums">{formatINR(tfBillCalc.gst)}</span></div>
              <div className="flex justify-between py-0.5"><span className="text-muted-foreground">TDS withheld</span><span className="tabular-nums">− {formatINR(tfBillCalc.tds)}</span></div>
              <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Round off</span><span className="tabular-nums">{formatINR(tfBillCalc.ro)}</span></div>
              <div className="mt-1 flex items-baseline justify-between border-t-2 pt-1.5 font-bold" style={{ borderColor: '#0B3D2E' }}>
                <span className="text-[11px] uppercase tracking-wide">Cr transporter</span>
                <span className="text-[17px] tabular-nums">{formatINR(tfBillCalc.total)}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Note</Label>
              <Input className="bg-white" value={String(tfBill.note ?? '')} onChange={(e) => setTfBill((p) => ({ ...p, note: e.target.value }))} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTfBillOpen(false)} disabled={tfSaving}>Cancel</Button>
              <Button className="bg-[#0B3D2E] hover:bg-[#0A3327]" onClick={() => void tfSaveBill()} disabled={tfSaving}>
                {tfSaving ? 'Booking…' : 'Book bill'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </>
  )



  // PAY A BOOKED BILL: a Payment voucher to the transporter, against this bill,
  // for what is still pending on it. Opened, not posted — the bank and the date
  // are the desk's to choose — and Esc on it comes back here.
  function tfPayBill(r: Row, pending: number): void {
    if (!mayEnter('PAYMENT')) return void toast.error('You do not have rights to enter a Payment voucher')
    const party = String(r.transporter_name || '').trim()
    const billNo = String(r.bill_no || '').trim()
    const back = screen
    openVoucher('PAYMENT')
    setPayLines([
      {
        account: party,
        group: String(accounts.find((a) => String(a.name) === party)?.acc_group || 'Sundry Creditors'),
        amount: String(Math.round(pending * 100) / 100),
        allocs: billNo ? [{ method: 'agst_ref', ref_name: billNo, amount: String(Math.round(pending * 100) / 100) }] : []
      }
    ])
    setNarration(`Freight bill ${billNo || ''} — ${party}`.replace(/\s+/g, ' ').trim())
    setAlterBack(back)
  }

  // THE TWO DRAWERS the website's freight register opens, from the right, as
  // the canvas draws them: book a transporter bill for the ticked lines, and
  // write a shortage off. Same saves as the dialogs the desktop register
  // uses (tfSaveBill, tfDoWaive) — only the reading of the page differs.
  const tfPostedName = (name: string): string => {
    const up = name.trim().toUpperCase()
    const hit = ledMap.find(
      (m) => String(m.posts_as || '').trim().toUpperCase() === up && (m.company_id == null || Number(m.company_id) === Number(cid))
    )
    return hit ? String(hit.use_name || name) : name
  }
  const tfDrawers = (() => {
    if (!__WEB__) return null
    const inward = tfSide === 'purchase'
    const q3 = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
    const money = (v: number): string => `${v < -0.004 ? '−' : ''}${formatINR(Math.abs(v))}`
    const field: React.CSSProperties = {
      width: '100%',
      height: 42,
      borderRadius: 8,
      padding: '0 11px',
      fontSize: 12.5,
      fontWeight: 700,
      outline: 0,
      background: '#fff',
      color: A.ink
    }
    const label = (t: string, req?: boolean, reqOn = true): React.JSX.Element => (
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: A.muted, marginBottom: 7 }}>
        {t} {req && <span style={{ color: reqOn ? A.bad : 'transparent' }}>*</span>}
      </div>
    )
    const shell = (
      ref: React.RefObject<HTMLDivElement>,
      kicker: string,
      title: string,
      sub: string,
      close: () => void,
      content: React.ReactNode,
      need: string,
      saveLabel: string,
      save: () => void,
      busy: boolean,
      ready?: string
    ): React.JSX.Element => (
      <div className="fixed inset-0 z-[60] flex justify-end">
        <div className="flex-1" style={{ background: 'rgba(7,43,32,.42)' }} onClick={() => !busy && close()} />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          data-escape-layer="drawer"
          className="flex flex-none flex-col"
          style={{ width: 'min(100%,520px)', background: '#F4F7F2', boxShadow: '-18px 0 40px rgba(7,43,32,.28)' }}
        >
          <div className="flex-none text-white" style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', padding: '16px 20px' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: A.inkSky }}>{kicker}</div>
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 5, textWrap: 'pretty' }}>{title}</div>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: A.inkSky, marginTop: 4 }}>{sub}</div>
              </div>
              <button
                type="button"
                title="Close (Esc)"
                onClick={() => !busy && close()}
                className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[7px]"
                style={{ background: 'rgba(255,255,255,.1)' }}
              >
                <X className="h-[19px] w-[19px]" />
              </button>
            </div>
          </div>
          <div className="sc flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto" style={{ padding: '16px 20px' }}>
            {content}
          </div>
          <div className="flex flex-none flex-wrap items-center gap-2.5 border-t bg-white" style={{ borderColor: '#DCE7DB', padding: '13px 20px' }}>
            <span className="min-w-0 flex-1" style={{ fontSize: 11.5, fontWeight: 700, color: need ? A.warn : A.good, lineHeight: 1.4 }}>
              {need || ready || `Ready to ${saveLabel.toLowerCase()}.`}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="flex h-[42px] items-center rounded-[8px] px-4"
              style={{ border: '1px solid #C3D2C6', fontSize: 12, fontWeight: 800, color: A.inkMid }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!need || busy}
              onClick={save}
              className="flex h-[42px] items-center gap-[7px] whitespace-nowrap rounded-[8px] px-[18px]"
              style={{
                background: need || busy ? '#DCE7DB' : 'linear-gradient(180deg,#145A43,#0B3D2E)',
                color: need || busy ? '#8CA396' : '#fff',
                boxShadow: need || busy ? 'none' : '0 8px 18px -10px rgba(7,43,32,.8)',
                fontSize: 12,
                fontWeight: 800,
                cursor: need || busy ? 'not-allowed' : 'pointer'
              }}
            >
              <Check className="h-[17px] w-[17px]" />
              {busy ? 'Saving…' : saveLabel}
            </button>
          </div>
        </div>
      </div>
    )

    let book: React.JSX.Element | null = null
    if (tfBillOpen && tfPickedRows.length) {
      const party = tfPickedParties[0] || ''
      const c = tfBillCalc
      const need: string[] = []
      if (!String(tfBill.bill_no || '').trim()) need.push('the bill no')
      if (c.adj && !String(tfBill.adjustment_note || '').trim()) need.push('a reason for the adjustment')
      if (tfPickedParties.length !== 1) need.push('lines of one transporter only')
      // WHAT THE BILL POSTS, as transporterBilling.createBill writes it: the
      // part already accrued at dispatch comes off FREIGHT PAYABLE, the rest
      // (and the adjustment) is the expense, GST is input tax, TDS is withheld.
      const accrued = Math.round(tfPickedRows.filter((r) => n(r.accrued) === 1).reduce((t, r) => t + n(r.amount), 0) * 100) / 100
      const expense = Math.round((c.lines - accrued + c.adj) * 100) / 100
      const frLedger = tfPostedName(inward ? 'FREIGHT INWARD A/C' : 'FREIGHT OUTWARD A/C')
      const jr: { side: 'Dr' | 'Cr'; ledger: string; amount: number }[] = []
      if (accrued > 0.004) jr.push({ side: 'Dr', ledger: tfPostedName('FREIGHT PAYABLE A/C'), amount: accrued })
      if (Math.abs(expense) > 0.004) jr.push({ side: expense > 0 ? 'Dr' : 'Cr', ledger: frLedger, amount: Math.abs(expense) })
      if (c.gst > 0.004) jr.push({ side: 'Dr', ledger: `Input GST ${c.gstPct}% (CGST + SGST)`, amount: c.gst })
      if (Math.abs(c.ro) > 0.004) jr.push({ side: c.ro > 0 ? 'Dr' : 'Cr', ledger: tfPostedName('ROUND OFF A/C'), amount: Math.abs(c.ro) })
      if (c.tds > 0.004) jr.push({ side: 'Cr', ledger: tfPostedName('TDS PAYABLE A/C'), amount: c.tds })
      if (c.others > 0.004)
        jr.push({ side: 'Cr', ledger: String(tfBill.others_ledger || '').trim().toUpperCase() || frLedger, amount: c.others })
      jr.push({ side: 'Cr', ledger: party, amount: c.total })
      if (c.total <= 0) need.push('less in Others than the bill comes to')
      const estimated = tfPickedRows.filter((r) => n(r.provisional) === 1).length
      book = shell(
        tfBookRef,
        `${inward ? 'Freight inward' : 'Freight outward'} · book bill`,
        party,
        `${tfPickedRows.length} line${tfPickedRows.length === 1 ? '' : 's'} · ${money(c.lines)}`,
        () => {
          if (!tfSaving) setTfBillOpen(false)
        },
        <>
          <div className="grid flex-none grid-cols-2 gap-3">
            <div>
              {label('Bill no', true)}
              <input
                autoFocus
                value={String(tfBill.bill_no ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, bill_no: e.target.value }))}
                placeholder="Transporter’s bill no"
                style={{ ...field, fontFamily: MONO, border: `1px solid ${String(tfBill.bill_no || '').trim() ? '#C3D2C6' : '#E3C58C'}` }}
              />
            </div>
            <div>
              {label('Bill date')}
              <DatePicker value={String(tfBill.bill_date || todayISO())} onChange={(v) => setTfBill((p) => ({ ...p, bill_date: v }))} />
            </div>
            <div>
              {label(tfUnreg ? 'GST % · unregistered' : 'GST %')}
              <input
                type="number"
                value={tfUnreg ? '0' : String(tfBill.gst_pct ?? '')}
                disabled={tfUnreg}
                title={tfUnreg ? 'Unregistered transporter — no GST on the freight; RCM applicable' : undefined}
                onChange={(e) => setTfBill((p) => ({ ...p, gst_pct: e.target.value }))}
                style={{ ...field, fontFamily: MONO, textAlign: 'right', border: '1px solid #C3D2C6', ...(tfUnreg ? { background: '#F4F7F3', color: A.muted } : {}) }}
              />
            </div>
            <div>
              {label('TDS % on freight')}
              <input
                type="number"
                value={String(tfBill.tds_pct ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, tds_pct: e.target.value }))}
                placeholder="0"
                style={{ ...field, fontFamily: MONO, textAlign: 'right', border: '1px solid #C3D2C6' }}
              />
            </div>
          </div>

          <div className="flex-none overflow-hidden rounded-[10px] bg-white" style={{ border: '1px solid #DCE7DB' }}>
            <div className="flex items-center gap-2" style={{ padding: '10px 13px', borderBottom: '1px solid #EAF0E9' }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: A.muted }}>Lines on this bill</span>
              <span className="ml-auto" style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 10.5, fontWeight: 700, color: A.muted }}>
                {tfPickedRows.length}
              </span>
            </div>
            {tfPickedRows.map((r) => {
              const short = String(r.entry_type) === 'shortage_penalty'
              const sm = /shortage\s+([\d.]+)\s*MT/i.exec(String(r.note || ''))
              const qq = short ? Number(sm?.[1]) || 0 : n(r.provisional) === 1 ? n(r.dispatch_qty) : n(r.received_qty) || n(r.dispatch_qty)
              const rate = qq > 0 ? Math.abs(n(r.amount)) / qq : 0
              return (
                <div key={String(r.id)} className="flex items-center gap-2.5" style={{ padding: '9px 13px', borderBottom: '1px solid #EFF3EE' }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate" style={{ fontSize: 11.5, fontWeight: 700 }}>
                      <span style={{ fontFamily: MONO }}>{String(r.vehicle_no || '—')}</span> · {String(r.doc_no || '')}
                      {r.party_name ? ` · ${String(r.party_name)}` : ''}
                    </div>
                    <div style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 10.5, fontWeight: 600, color: A.muted, marginTop: 2 }}>
                      {qq > 0 ? `${q3(qq)} MT${short ? ' short' : ''} × ${formatINR(rate)}` : short ? 'oil shortage' : 'freight'}
                      {n(r.provisional) === 1 ? ' · estimated' : ''}
                    </div>
                  </div>
                  <span className="whitespace-nowrap" style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 12, fontWeight: 700, color: n(r.amount) < 0 ? A.cr : A.ink }}>
                    {money(n(r.amount))}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="grid flex-none gap-3" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
            <div>
              {label('Adjustment ₹')}
              <input
                type="number"
                value={String(tfBill.adjustment ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, adjustment: e.target.value }))}
                placeholder="0.00  (− to reduce)"
                style={{ ...field, fontFamily: MONO, textAlign: 'right', border: '1px solid #C3D2C6' }}
              />
            </div>
            <div>
              {label('Reason', true, !!c.adj)}
              <input
                value={String(tfBill.adjustment_note ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, adjustment_note: e.target.value }))}
                placeholder="Toll, detention, rate difference…"
                style={{ ...field, fontWeight: 600, border: `1px solid ${c.adj && !String(tfBill.adjustment_note || '').trim() ? '#E3C58C' : '#C3D2C6'}` }}
              />
            </div>
          </div>
          {tfUnreg && (
            <div
              className="flex-none"
              style={{ borderRadius: 8, border: '1px solid #F1D9A6', background: '#FFF8E9', padding: '10px 12px', fontSize: 11.5, fontWeight: 600, color: '#8A5300', lineHeight: 1.5 }}
            >
              <b>Unregistered transporter · RCM applicable.</b> No GST on this freight, and it is booked as a JV. Oil shortages come off at the oil rate plus its GST — no debit note.
            </div>
          )}
          <div className="grid flex-none gap-3" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
            <div>
              {label('Others ₹ (deduct)')}
              <input
                type="number"
                value={String(tfBill.others_amount ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, others_amount: e.target.value }))}
                placeholder="0.00"
                style={{ ...field, fontFamily: MONO, textAlign: 'right', border: '1px solid #C3D2C6' }}
              />
            </div>
            <div>
              {label('Credit to ledger')}
              <input
                list="tf-others-ledgers"
                value={String(tfBill.others_ledger ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, others_ledger: e.target.value }))}
                placeholder={inward ? 'FREIGHT INWARD A/C' : 'FREIGHT OUTWARD A/C'}
                style={{ ...field, fontWeight: 600, border: '1px solid #C3D2C6' }}
              />
              <datalist id="tf-others-ledgers">
                {(accounts as Row[]).slice(0, 400).map((a) => (
                  <option key={String(a.id)} value={String(a.name)} />
                ))}
              </datalist>
            </div>
          </div>
          {Number(tfBill.others_amount) > 0 && (
            <div className="flex-none">
              {label('What the others are for')}
              <input
                value={String(tfBill.others_note ?? '')}
                onChange={(e) => setTfBill((p) => ({ ...p, others_note: e.target.value }))}
                placeholder="Damage, detention, short-loaded drum…"
                style={{ ...field, fontWeight: 600, border: '1px solid #C3D2C6' }}
              />
            </div>
          )}
          <div className="flex-none">
            {label('Note')}
            <input
              value={String(tfBill.note ?? '')}
              onChange={(e) => setTfBill((p) => ({ ...p, note: e.target.value }))}
              placeholder="Anything to keep with the bill"
              style={{ ...field, fontWeight: 600, border: '1px solid #C3D2C6' }}
            />
          </div>

          <div
            className="flex-none text-white"
            style={{
              borderRadius: 12,
              background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 14px 30px -16px rgba(7,43,32,.7)',
              padding: '15px 16px'
            }}
          >
            <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: A.inkSky }}>
              {tfUnreg ? 'JV this books · RCM applicable' : 'Journal this books'}
            </div>
            <div className="mt-2.5 flex flex-col gap-[7px]">
              {orderVoucherLines(jr, (j) => ({ account: j.ledger, dr: j.side === 'Dr', tax: TAX_NAME.test(j.ledger), amount: j.amount })).map((j, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2.5"
                  style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 7, padding: '8px 11px' }}
                >
                  <span className="w-5 flex-none" style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: j.side === 'Dr' ? '#9EC2EA' : '#F0C4BF' }}>
                    {j.side}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, fontWeight: 700 }}>
                    {j.ledger}
                  </span>
                  <span className="whitespace-nowrap" style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 12.5, fontWeight: 700 }}>
                    {formatINR(j.amount)}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: A.inkSky, lineHeight: 1.5, marginTop: 10, textWrap: 'pretty' }}>
              Booking makes these lines final at {formatINR(c.lines + c.adj)} before tax and puts {formatINR(c.total)} on {party}&rsquo;s ledger as a
              payable reference{String(tfBill.bill_no || '').trim() ? ` (${String(tfBill.bill_no).trim()})` : ''}.
              {accrued > 0.004 ? ' The part accrued at dispatch comes off Freight Payable rather than being expensed twice.' : ''}
              {estimated ? ` ${estimated} line${estimated === 1 ? ' is' : 's are'} on an estimated quantity; a later weigh-in will need the bill adjusted.` : ''}
            </div>
          </div>
        </>,
        need.length ? `Needs ${need.join(' and ')}.` : '',
        'Book bill',
        () => void tfSaveBill(),
        tfSaving,
        `Ready to book ${formatINR(c.total)}.`
      )
    }

    let waive: React.JSX.Element | null = null
    if (tfWaive) {
      const r = tfWaive
      const amt = Math.abs(n(r.amount))
      waive = shell(
        tfWaiveRef,
        'Write off a shortage',
        String(r.transporter_name || ''),
        [r.vehicle_no, r.doc_no, r.party_name].filter(Boolean).map(String).join(' · '),
        () => {
          if (tfNoting == null) {
            setTfWaive(null)
            setTfWaiveReason('')
          }
        },
        <>
          <div className="flex-none rounded-[10px] bg-white" style={{ border: '1px solid #F0D6D4', borderLeft: `4px solid ${A.bad}`, padding: '13px 15px' }}>
            <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: A.cr }}>Shortage on this line</div>
            <div style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 20, fontWeight: 700, color: A.bad, marginTop: 6 }}>{formatINR(amt)}</div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: '#7A322C', lineHeight: 1.55, marginTop: 6, textWrap: 'pretty' }}>
              The transporter then bills in full, and {formatINR(amt)} posts as <b>Dr OIL SHORTAGE LOSS A/C</b> against the{' '}
              {inward ? 'purchase' : 'sale'} account it was bought as — naming the loss rather than leaving it inside material cost.
            </div>
          </div>
          <div className="flex-none">
            {label('Why it is being written off', true)}
            <input
              autoFocus
              value={tfWaiveReason}
              onChange={(e) => setTfWaiveReason(e.target.value)}
              placeholder="e.g. within transit tolerance, not worth claiming"
              style={{ ...field, fontWeight: 600, border: `1px solid ${tfWaiveReason.trim() ? '#C3D2C6' : '#E3C58C'}` }}
            />
          </div>
        </>,
        tfWaiveReason.trim() ? '' : 'Needs a reason.',
        'Write off',
        () => void tfDoWaive(),
        tfNoting != null
      )
    }
    return (
      <>
        {book}
        {waive}
      </>
    )
  })()

  // ===========================================================================
  // FR. INWARD / FR. OUTWARD WORKING — as the canvas draws them.
  // ===========================================================================
  //
  // TWO REGISTERS, NOT ONE. A bill FROM a transporter and a bill TO a customer
  // settle on different ledgers, so merging them would hide one behind the
  // other. Same screen, different side; the gateway offers both.
  //
  // NOTHING HERE IS FINAL UNTIL THE TRANSPORTER'S BILL IS BOOKED. The rate, the
  // received quantity and any adjustment on the bill can all still move it —
  // which is why the two provisional tiles are split by whether the QUANTITY
  // behind the figure is settled, and why every row says its basis.
  //
  // Built to the Accounting Freight canvas: the two sides as tabs on the
  // frame, four tiles, the register with its filters, and drawers from the
  // right to book a bill or write a shortage off. A booked line opens to what
  // its bill still owes, with Pay bill and Unbook beside it.
  const tfWeb = (() => {
    const W = vw
    const roomy = W >= 1180
    const inward = tfSide === 'purchase'
    const money = (v: unknown): string => {
      const x = n(v)
      return `${x < -0.004 ? '−' : ''}${formatINR(Math.abs(x))}`
    }
    const q3 = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
    const isShort = (r: Row): boolean => String(r.entry_type) === 'shortage_penalty'
    // A shortage line carries its own quantity in the note the ledger writer
    // stamps ("… oil shortage 0.150 MT beyond tolerance"), not in the tanker's.
    const shortQty = (r: Row): number => {
      const m = /shortage\s+([\d.]+)\s*MT/i.exec(String(r.note || ''))
      return m ? Number(m[1]) || 0 : 0
    }
    const qtyOf = (r: Row): number =>
      isShort(r) ? shortQty(r) : n(r.provisional) === 1 ? n(r.dispatch_qty) : n(r.received_qty) || n(r.dispatch_qty)
    const rateOf = (r: Row): number => {
      const qq = qtyOf(r)
      return qq > 0 ? Math.abs(n(r.amount)) / qq : 0
    }
    const bookedOf = (r: Row): boolean => r.bill_id != null
    const settledOf = (r: Row): boolean => !bookedOf(r) && (r.note_id != null || r.waived_at != null)
    const weighedOf = (r: Row): boolean => n(r.provisional) !== 1
    const orphanIds = new Set(tfOrphans.map((o) => Number(o.id)))
    // The register reads the whole side and filters here, so every chip can
    // say how many rows it would show.
    const stateOk = (r: Row, f: 'all' | 'unbilled' | 'billed'): boolean =>
      f === 'all' ? true : f === 'billed' ? bookedOf(r) : !bookedOf(r) && !settledOf(r)
    const query = tfQuery.trim().toLowerCase()
    const matchQ = (r: Row): boolean =>
      !query ||
      [r.transporter_name, r.vehicle_no, r.doc_no, r.party_name, r.product_name]
        .map((x) => String(x ?? ''))
        .join(' ')
        .toLowerCase()
        .includes(query)
    const matchTr = (r: Row): boolean => tfTr === 'all' || String(r.transporter_name || '') === tfTr
    // A funnel on every column, offered from what the chips and search leave.
    const tfCf = colFilter(colF, `tf:${inward ? 'in' : 'out'}`, tfRows.filter((r) => stateOk(r, tfState) && matchQ(r) && matchTr(r)), [
      { key: 'transporter', get: (r) => r.transporter_name },
      { key: 'vehicle', get: (r) => r.vehicle_no },
      { key: 'invoice', get: (r) => String(r.doc_no || '—') },
      { key: 'against', get: (r) => [String(r.party_name || ''), String(r.product_name || '')].filter(Boolean) },
      {
        key: 'qty',
        get: (r) => {
          const qq = qtyOf(r)
          return qq > 0 ? `${q3(qq)}${isShort(r) ? ' short' : ''}` : '—'
        },
        sort: 'num'
      },
      { key: 'rate', get: (r) => (qtyOf(r) > 0 ? formatINR(rateOf(r)) : '—'), sort: 'num' },
      { key: 'freight', get: (r) => money(n(r.amount)), sort: 'num' },
      { key: 'basis', get: (r) => (weighedOf(r) ? 'Weighed' : 'Estimated') },
      {
        key: 'bill',
        get: (r) =>
          settledOf(r)
            ? r.note_id != null
              ? `Note ${String(r.note_no || '')}`
              : 'Written off'
            : bookedOf(r)
              ? String(r.bill_no || 'Booked')
              : 'Not billed'
      }
    ])
    const shown = tfCf.rows
    const sum = (arr: Row[]): number => arr.reduce((t, r) => t + n(r.amount), 0)
    const counts = {
      unbilled: tfRows.filter((r) => stateOk(r, 'unbilled')).length,
      billed: tfRows.filter((r) => stateOk(r, 'billed')).length,
      all: tfRows.length
    }
    // The four figures, off the same rows as the register. A shortage settled
    // on a note or written off is neither provisional nor booked.
    const earned = sum(tfRows)
    const finalAmt = sum(tfRows.filter(bookedOf))
    const firm = sum(tfRows.filter((r) => !bookedOf(r) && !settledOf(r) && weighedOf(r)))
    const est = sum(tfRows.filter((r) => !bookedOf(r) && !settledOf(r) && !weighedOf(r)))
    const trBase = tfRows.filter((r) => stateOk(r, tfState) && matchQ(r))
    const trList = Array.from(new Set(tfRows.map((r) => String(r.transporter_name || '')).filter(Boolean))).sort()
    const GRID = '40px minmax(230px,1.1fr) 124px 150px minmax(200px,1.4fr) 110px 120px 140px 110px 230px'
    const bodyPad = W >= 1400 ? '16px 20px' : '12px 14px'
    const cap: React.CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }
    const mono: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: FIGS }
    const chipStyle = (fg: string, bg: string, bd: string): React.CSSProperties => ({
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.05em',
      textTransform: 'uppercase',
      color: fg,
      background: bg,
      border: `1px solid ${bd}`,
      borderRadius: 4,
      padding: '3px 7px',
      whiteSpace: 'nowrap'
    })
    const miniBtn = (fg: string, bd: string): React.CSSProperties => ({
      flex: 'none',
      height: 24,
      display: 'flex',
      alignItems: 'center',
      padding: '0 7px',
      borderRadius: 5,
      border: `1px solid ${bd}`,
      background: '#fff',
      color: fg,
      fontSize: 9.5,
      fontWeight: 800
    })

    // ── THE STRIP: the two sides, each saying how much is still to bill ────
    const sideCount = (side: 'purchase' | 'sales'): number =>
      side === tfSide ? counts.unbilled : n(tfSideCounts[side])
    const strip = (
      <div className="sc flex h-12 items-center gap-1.5 overflow-x-auto">
        {([
          { side: 'purchase' as const, label: 'Fr. inward working', Icon: ArrowDownLeft, key: 'R', go: () => setScreen('tfpur'), hide: !mayScreen('tfpur') },
          { side: 'sales' as const, label: 'Fr. outward working', Icon: ArrowUpRight, key: 'O', go: () => setScreen('tfsal'), hide: !mayScreen('tfsal') }
        ])
          .filter((t) => !t.hide)
          .map((t) => {
            const on = tfSide === t.side
            return (
              <button
                key={t.side}
                type="button"
                onClick={t.go}
                className="flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[7px] px-[13px]"
                style={{
                  background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
                  border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
                  boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.6),0 6px 16px -6px rgba(199,240,63,.55)' : 'none',
                  color: on ? A.frame : '#DCEFE4',
                  fontSize: 12,
                  fontWeight: 800
                }}
              >
                <t.Icon className="h-4 w-4" />
                {t.label}
                <span
                  style={{
                    ...mono,
                    fontSize: 10,
                    fontWeight: 600,
                    color: on ? A.frame : A.accent,
                    background: on ? 'rgba(11,61,46,.12)' : 'rgba(199,240,63,.1)',
                    borderRadius: 9,
                    padding: '1px 7px'
                  }}
                >
                  {sideCount(t.side)} to bill
                </span>
                <span
                  style={{
                    ...mono,
                    fontSize: 9.5,
                    fontWeight: 600,
                    color: on ? A.frame : A.inkSky,
                    background: on ? 'rgba(11,61,46,.12)' : 'rgba(255,255,255,.07)',
                    borderRadius: 3,
                    padding: '2px 5px'
                  }}
                >
                  {t.key}
                </span>
              </button>
            )
          })}
        <div className="flex-1" />
        {roomy && (
          <div className="flex flex-none items-center gap-[7px] whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: A.inkSky }}>
            <KeyboardIcon className="h-[15px] w-[15px]" />R inward · O outward · Esc closes a form
          </div>
        )}
      </div>
    )

    // ── THE PAGE ───────────────────────────────────────────────────────────
    const tiles = [
      { k: 'Freight earned', v: money(earned), sub: `${tfRows.length} line${tfRows.length === 1 ? '' : 's'} this period`, Icon: Truck, accent: A.frame, dark: true, go: () => setTfState('all'), on: false },
      { k: 'Booked to ledger · final', v: money(finalAmt), sub: 'on a transporter bill', Icon: CheckCircle2, accent: '#1B4E82', dark: false, go: () => setTfState('billed'), on: tfState === 'billed' },
      { k: 'Provisional · qty weighed', v: money(firm), sub: 'quantity settled, bill not booked', Icon: Scale, accent: '#8A5300', dark: false, go: () => setTfState('unbilled'), on: tfState === 'unbilled' },
      { k: 'Provisional · qty estimated', v: money(est), sub: 'quantity still an estimate', Icon: Hourglass, accent: '#B3261E', dark: false, go: () => setTfState('unbilled'), on: false }
    ]

    const billFigs = (r: Row): React.JSX.Element => {
      const party = String(r.transporter_name || '')
      const bw = tfBillWise[party]
      const hit = bw?.find((b) => String(b.ref || '').trim().toUpperCase() === String(r.bill_no || '').trim().toUpperCase())
      const lines = tfRows.filter((x) => x.bill_id != null && Number(x.bill_id) === Number(r.bill_id))
      const pending = hit ? n(hit.pending) : 0
      const cell = (k: string, v: string, fg: string): React.JSX.Element => (
        <div key={k} style={{ background: '#F4F9EF', padding: '10px 14px' }}>
          <div style={{ ...cap, fontSize: 9, color: A.muted }}>{k}</div>
          <div style={{ ...mono, fontSize: 15, fontWeight: 700, color: fg, marginTop: 3 }}>{v}</div>
        </div>
      )
      return (
        <div className="grid gap-px" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr)) auto', background: '#DCE7DB', borderBottom: '1px solid #DCE7DB' }}>
          {!bw ? (
            <div style={{ gridColumn: 'span 3', background: '#F4F9EF', padding: '12px 14px', fontSize: 11.5, fontWeight: 600, color: A.muted }}>
              Reading {party || 'the transporter'}&rsquo;s ledger…
            </div>
          ) : !hit ? (
            <div style={{ gridColumn: 'span 3', background: '#F4F9EF', padding: '12px 14px', fontSize: 11.5, fontWeight: 600, color: A.muted, lineHeight: 1.5 }}>
              Bill {String(r.bill_no || '')} has nothing open on {party || 'this transporter'}&rsquo;s ledger — it was settled in full, or paid on account
              rather than against this bill.
            </div>
          ) : (
            [cell('Bill amount', money(hit.opening), A.ink), cell('Paid', money(hit.paid), A.good), cell('Pending', money(pending), pending > 0.005 ? A.warn : A.good)]
          )}
          <div className="flex items-center gap-2" style={{ background: '#F4F9EF', padding: '10px 14px' }}>
            {pending > 0.005 && mayEnter('PAYMENT') && (
              <button
                type="button"
                onClick={() => tfPayBill(r, pending)}
                title={`Open a Payment voucher to ${party}, against bill ${String(r.bill_no || '')}`}
                className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3"
                style={{ background: 'linear-gradient(180deg,#145A43,#0B3D2E)', color: '#fff', fontSize: 11.5, fontWeight: 800 }}
              >
                <Banknote className="h-4 w-4" style={{ color: A.accent }} />
                Pay bill
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                setTfUnbook({
                  bill_id: r.bill_id,
                  bill_no: r.bill_no,
                  transporter_name: party,
                  line_count: lines.length,
                  line_amount: sum(lines)
                })
              }
              title="Delete the bill and its voucher — its lines go back to provisional"
              className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-[11px]"
              style={{ border: '1px solid #F0D6D4', background: '#fff', color: A.bad, fontSize: 11.5, fontWeight: 800 }}
            >
              <Trash2 className="h-4 w-4" />
              Unbook
            </button>
          </div>
        </div>
      )
    }

    const body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: bodyPad }}>
          {/* A bill whose voucher was deleted on its own leaves its freight
              stuck on Booked. Said first: until it is cleared the register is
              understating what is still to bill. */}
          {tfOrphans.length > 0 && (
            <div
              className="flex-none"
              style={{ background: 'linear-gradient(180deg,#FFF6F5,#FDEEEC)', border: '1px solid #F0D6D4', borderLeft: `4px solid ${A.bad}`, borderRadius: 10, padding: '12px 15px' }}
            >
              <div className="flex items-center gap-2">
                <Link2Off className="h-[18px] w-[18px]" style={{ color: A.bad }} />
                <span style={{ fontSize: 12, fontWeight: 800, color: A.bad }}>
                  {tfOrphans.length} bill{tfOrphans.length === 1 ? '' : 's'} with no voucher behind {tfOrphans.length === 1 ? 'it' : 'them'}
                </span>
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: '#7A322C', lineHeight: 1.55, marginTop: 4, textWrap: 'pretty' }}>
                The journal voucher was deleted on its own, so the bill stayed and its freight is still showing as booked. Clearing it releases those lines back to
                provisional.
              </div>
              <div className="mt-[9px] flex flex-wrap gap-[7px]">
                {tfOrphans.map((o) => (
                  <button
                    key={String(o.id)}
                    type="button"
                    onClick={() => setTfUnbook({ ...o, bill_id: o.id })}
                    className="flex h-8 items-center gap-[7px] rounded-[6px] px-[11px]"
                    style={{ background: '#fff', border: '1px solid #F0D6D4', color: A.bad, fontSize: 11.5, fontWeight: 800 }}
                  >
                    <RotateCcw className="h-[15px] w-[15px]" />
                    Clear {String(o.bill_no || `#${o.id}`)} · {String(o.transporter_name || '')} · {money(o.line_amount)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* The four figures. Both provisional ones are unbilled — the split
              says whether the QUANTITY behind them is settled. */}
          <div className="grid flex-none gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))' }}>
            {tiles.map((k) => (
              <button
                key={k.k}
                type="button"
                onClick={k.go}
                className="relative min-w-0 overflow-hidden text-left"
                style={{
                  borderRadius: 12,
                  background: k.dark ? 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)' : '#fff',
                  border: `1px solid ${k.dark ? 'transparent' : k.on ? k.accent : '#DCE7DB'}`,
                  boxShadow: k.dark
                    ? 'inset 0 1px 0 rgba(255,255,255,.1),0 14px 30px -16px rgba(7,43,32,.7)'
                    : k.on
                      ? `0 0 0 2px ${k.accent}22`
                      : '0 1px 2px rgba(10,31,23,.04)',
                  padding: '14px 16px'
                }}
              >
                <span
                  className="pointer-events-none absolute rounded-full"
                  style={{ top: -50, right: -50, width: 140, height: 140, background: `radial-gradient(circle,${k.dark ? 'rgba(199,240,63,.18)' : `${k.accent}1A`},transparent 70%)` }}
                />
                <span className="relative flex items-center gap-2">
                  <k.Icon className="h-[17px] w-[17px]" style={{ color: k.dark ? A.accent : k.accent }} />
                  <span style={{ ...cap, letterSpacing: '.13em', color: k.dark ? A.inkSky : A.muted }}>{k.k}</span>
                </span>
                <span
                  className="relative block whitespace-nowrap"
                  style={{ ...mono, fontSize: 20, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 8, color: k.dark ? A.accent : k.accent }}
                >
                  {k.v}
                </span>
                <span className="relative block" style={{ fontSize: 11, fontWeight: 600, color: k.dark ? A.inkSky : A.muted, marginTop: 4 }}>
                  {k.sub}
                </span>
              </button>
            ))}
          </div>

          <div
            className="flex flex-col overflow-hidden"
            style={{
              flex: '1 0 auto',
              minHeight: 320,
              background: '#fff',
              border: '1px solid #DCE7DB',
              borderRadius: 10,
              boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)'
            }}
          >
            <div
              className="flex flex-none flex-wrap items-center gap-[9px]"
              style={{ padding: '11px 14px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)' }}
            >
              <label
                className="flex h-9 min-w-0 items-center gap-2 rounded-[7px] px-2.5"
                style={{
                  flex: '1 1 220px',
                  maxWidth: 300,
                  border: `1px solid ${query ? '#12855A' : '#C3D2C6'}`,
                  background: '#fff',
                  boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)'
                }}
              >
                <Search className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
                <input
                  value={tfQuery}
                  onChange={(e) => setTfQuery(e.target.value)}
                  placeholder={inward ? 'Transporter, tanker, supplier or invoice' : 'Transporter, vehicle, customer or invoice'}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  style={{ fontSize: 12, fontWeight: 600, color: A.ink }}
                />
                {!!tfQuery && (
                  <button type="button" title="Clear" onClick={() => setTfQuery('')} style={{ color: A.muted }}>
                    <X className="h-4 w-4" />
                  </button>
                )}
              </label>
              <Popover open={tfTrOpen} onOpenChange={setTfTrOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 max-w-[260px] items-center gap-2 whitespace-nowrap rounded-[7px] bg-white px-[11px]"
                    style={{ border: `1px solid ${tfTr === 'all' ? '#C3D2C6' : '#12855A'}`, fontSize: 12, fontWeight: 800, color: A.ink }}
                  >
                    <Truck className="h-4 w-4 flex-none" style={{ color: A.muted }} />
                    <span className="min-w-0 truncate">{tfTr === 'all' ? 'All transporters' : tfTr}</span>
                    <ChevronDown className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="!w-[260px] !rounded-[8px] !border-[#C3D2C6] !p-1 !shadow-[0_14px_32px_rgba(7,43,32,.2)]">
                  {['all', ...trList].map((t) => {
                    const on = tfTr === t
                    const c = t === 'all' ? trBase.length : trBase.filter((r) => String(r.transporter_name || '') === t).length
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setTfTr(t)
                          setTfTrOpen(false)
                        }}
                        className="flex min-h-9 w-full items-center gap-[9px] rounded-[6px] px-2.5 text-left hover:bg-[#F4F9EF]"
                        style={{ background: on ? '#F3FBE2' : undefined, fontSize: 12, fontWeight: on ? 800 : 600 }}
                      >
                        <Check className="h-[15px] w-[15px] flex-none" style={{ color: A.frame, visibility: on ? 'visible' : 'hidden' }} />
                        <span className="min-w-0 flex-1 truncate">{t === 'all' ? 'All transporters' : t}</span>
                        <span style={{ ...mono, fontSize: 10.5, color: A.muted }}>{c}</span>
                      </button>
                    )
                  })}
                </PopoverContent>
              </Popover>
              <div className="flex gap-0.5 rounded-[7px] p-0.5" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}>
                {([
                  { k: 'unbilled' as const, label: 'Provisional', title: 'Freight with no transporter bill booked against it — provisional' },
                  { k: 'billed' as const, label: 'Booked', title: 'Freight a booked transporter bill has made final' },
                  { k: 'all' as const, label: 'All', title: '' }
                ]).map((w) => {
                  const on = tfState === w.k
                  return (
                    <button
                      key={w.k}
                      type="button"
                      title={w.title || undefined}
                      onClick={() => setTfState(w.k)}
                      className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[5px] px-[11px]"
                      style={{
                        background: on ? 'linear-gradient(180deg,#145A43,#0B3D2E)' : 'transparent',
                        color: on ? A.accent : A.inkMid,
                        boxShadow: on ? '0 4px 10px -6px rgba(7,43,32,.8)' : 'none',
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase'
                      }}
                    >
                      {w.label}
                      <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: on ? '#DCEFE4' : '#8CA396' }}>{counts[w.k]}</span>
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="whitespace-nowrap" style={{ ...cap, color: A.muted }}>
                  Pick by
                </span>
                <div className="flex gap-0.5 rounded-[7px] p-0.5" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}>
                  {([
                    { k: 'tanker' as const, label: inward ? 'Tanker' : 'Line', title: 'One tick, one line' },
                    { k: 'invoice' as const, label: 'Oil invoice', title: 'One tick takes every line of that transporter on the same oil invoice' }
                  ]).map((w) => {
                    const on = tfPickBy === w.k
                    return (
                      <button
                        key={w.k}
                        type="button"
                        title={w.title}
                        onClick={() => {
                          setTfPickBy(w.k)
                          setTfPicked([])
                        }}
                        className="flex h-[30px] items-center whitespace-nowrap rounded-[5px] px-[11px]"
                        style={{ background: on ? '#fff' : 'transparent', color: on ? A.frame : A.muted, fontSize: 11, fontWeight: 800 }}
                      >
                        {w.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <span className="ml-auto whitespace-nowrap" style={{ fontSize: 11.5, fontWeight: 600, color: A.muted }}>
                {shown.length} line{shown.length === 1 ? '' : 's'} shown
              </span>
            </div>

            <div className="sc min-h-0 flex-1 overflow-auto">
              <div style={{ minWidth: 1350 }}>
                <div
                  className="sticky top-0 z-[2] grid items-center"
                  style={{
                    gridTemplateColumns: GRID,
                    height: 34,
                    background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)',
                    color: '#A9CDBB',
                    ...cap
                  }}
                >
                  <span />
                  <span style={{ padding: '0 10px' }}>{tfCf.head('transporter', 'Transporter', { onDark: true })}</span>
                  <span style={{ padding: '0 10px' }}>{tfCf.head('vehicle', 'Vehicle', { onDark: true })}</span>
                  <span style={{ padding: '0 10px' }}>{tfCf.head('invoice', 'Invoice no', { onDark: true })}</span>
                  <span style={{ padding: '0 10px' }}>{tfCf.head('against', inward ? 'Supplier · product' : 'Customer · product', { onDark: true })}</span>
                  <span style={{ padding: '0 10px', display: 'flex', justifyContent: 'flex-end' }}>{tfCf.head('qty', 'Qty MT', { onDark: true, align: 'end' })}</span>
                  <span style={{ padding: '0 10px', display: 'flex', justifyContent: 'flex-end' }}>{tfCf.head('rate', 'Rate', { onDark: true, align: 'end' })}</span>
                  <span style={{ padding: '0 10px', display: 'flex', justifyContent: 'flex-end' }}>{tfCf.head('freight', 'Freight', { onDark: true, align: 'end' })}</span>
                  <span style={{ padding: '0 10px' }}>{tfCf.head('basis', 'Basis', { onDark: true })}</span>
                  <span style={{ padding: '0 12px' }}>{tfCf.head('bill', 'Bill', { onDark: true })}</span>
                </div>

                {shown.map((r, i) => {
                  const id = Number(r.id)
                  const booked = bookedOf(r)
                  const settled = settledOf(r)
                  // A registered transporter's shortage is claimed on a debit
                  // note, never netted into their bill — so it is not ticked.
                  const canPick = !booked && !settled && !(isShort(r) && String(r.gst_registration || '') !== 'unregistered')
                  const picked = tfPicked.includes(id)
                  const openRow = booked && tfBillRow === id
                  const weighed = weighedOf(r)
                  const short = isShort(r)
                  const unreg = String(r.gst_registration || '') === 'unregistered'
                  const orphan = booked && orphanIds.has(Number(r.bill_id))
                  const noted = r.note_id != null
                  const qq = qtyOf(r)
                  const amt = n(r.amount)
                  const busy = tfNoting === id
                  return (
                    <div key={id}>
                      <div
                        role={canPick || booked ? 'button' : undefined}
                        onClick={() => (booked ? setTfBillRow(openRow ? 0 : id) : canPick ? tfToggle(r) : undefined)}
                        className="grid items-center hover:!bg-[#F4F9EF]"
                        style={{
                          gridTemplateColumns: GRID,
                          minHeight: 48,
                          borderBottom: '1px solid #EFF3EE',
                          background: picked ? '#F3FBE2' : openRow ? '#F4F9EF' : i % 2 ? '#FBFDFA' : '#fff',
                          boxShadow: `inset 3px 0 0 ${picked ? '#9ACD2A' : orphan ? A.bad : 'transparent'}`,
                          cursor: settled ? 'default' : 'pointer'
                        }}
                      >
                        <div className="flex items-center" style={{ paddingLeft: 12 }}>
                          {canPick ? (
                            <span
                              className="flex h-4 w-4 items-center justify-center rounded-[4px]"
                              style={{ border: `1.5px solid ${picked ? A.frame : '#C3D2C6'}`, background: picked ? A.frame : '#fff' }}
                            >
                              {picked && <Check className="h-[13px] w-[13px]" style={{ color: A.accent }} />}
                            </span>
                          ) : booked ? (
                            <ChevronRight className="h-[18px] w-[18px]" style={{ color: A.muted, transform: openRow ? 'rotate(90deg)' : 'none' }} />
                          ) : (
                            <span style={{ fontSize: 12, color: '#C3D2C6', paddingLeft: 3 }}>—</span>
                          )}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5" style={{ padding: '0 10px' }}>
                          <span className="truncate" style={{ fontSize: 12, fontWeight: 800 }}>
                            {String(r.transporter_name || '—')}
                          </span>
                          {unreg && (
                            <span
                              className="flex-none"
                              title="Unregistered transporter — no GST on their freight (RCM applicable); shortages are deducted on the freight JV at oil rate + GST, no debit note"
                              style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: A.warn, background: '#FFF4DD', border: '1px solid #F1D9A6', borderRadius: 3, padding: '1px 5px' }}
                            >
                              UNREG · RCM
                            </span>
                          )}
                        </div>
                        <span className="truncate" style={{ padding: '0 10px', ...mono, fontSize: 11.5, fontWeight: 600, color: A.inkMid }}>
                          {String(r.vehicle_no || '—')}
                        </span>
                        <span className="truncate" style={{ padding: '0 10px', ...mono, fontSize: 12, fontWeight: 700 }}>
                          {String(r.doc_no || '—')}
                        </span>
                        <div className="min-w-0" style={{ padding: '6px 10px' }}>
                          <div className="truncate" style={{ fontSize: 12, fontWeight: 700 }}>
                            {String(r.party_name || '—')}
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5" style={{ marginTop: 3 }}>
                            <span className="truncate" style={{ fontSize: 10.5, fontWeight: 600, color: A.muted }}>
                              {String(r.product_name || '')}
                              {short && qq > 0 ? ` · ${q3(qq)} MT short` : ''}
                            </span>
                            {short && (
                              <span
                                className="flex-none"
                                style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: A.bad, background: '#FDF3F2', border: '1px solid #F0D6D4', borderRadius: 3, padding: '1px 6px' }}
                              >
                                SHORTAGE RECOVERED
                              </span>
                            )}
                          </div>
                        </div>
                        <span style={{ padding: '0 10px', textAlign: 'right', ...mono, fontSize: 12, fontWeight: 600, color: short ? A.bad : qq > 0 ? A.ink : A.none }}>
                          {qq > 0 ? `${q3(qq)}${short ? ' short' : ''}` : '—'}
                        </span>
                        <span style={{ padding: '0 10px', textAlign: 'right', ...mono, fontSize: 11.5, fontWeight: 600, color: qq > 0 ? A.muted : A.none }}>
                          {qq > 0 ? `${formatINR(rateOf(r))}${short ? '/MT' : ''}` : '—'}
                        </span>
                        <span className="whitespace-nowrap" style={{ padding: '0 10px', textAlign: 'right', ...mono, fontSize: 12.5, fontWeight: 700, color: amt < 0 ? A.cr : A.ink }}>
                          {money(amt)}
                        </span>
                        <div style={{ padding: '0 10px' }}>
                          <span
                            title={
                              weighed
                                ? 'The quantity behind this freight is the weighed-in figure — it will not move again.'
                                : inward
                                  ? 'Tanker not emptied yet — worked out on the ordered qty until it is weighed in.'
                                  : 'Not unloaded yet — worked out on the dispatched qty. It settles to received qty × rate once the invoice is marked Unloaded.'
                            }
                            style={weighed ? chipStyle(A.good, '#E9F5EE', '#BFE3CB') : chipStyle(A.bad, '#FDF3F2', '#F0D6D4')}
                          >
                            {weighed ? 'Weighed' : 'Estimated'}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center gap-[5px]" style={{ padding: '0 12px 0 10px' }}>
                          <span
                            className="min-w-0 truncate"
                            title={
                              settled
                                ? noted
                                  ? `Claimed on debit note ${String(r.note_no || '')}`
                                  : `Written off: ${String(r.waived_reason || 'no reason given')}`
                                : booked
                                  ? `Booked on bill ${String(r.bill_no || '')}${r.bill_date ? ` dated ${formatDate(String(r.bill_date))}` : ''}`
                                  : 'No transporter bill against this line yet — the figure is still provisional.'
                            }
                            style={
                              settled
                                ? chipStyle(A.inkMid, '#EEF3EC', '#DCE7DB')
                                : booked
                                  ? orphan
                                    ? chipStyle(A.bad, '#FDF3F2', '#F0D6D4')
                                    : chipStyle(A.dr, '#EAF0FA', '#C6DAF0')
                                  : chipStyle(A.warn, '#FFF4DD', '#F1D9A6')
                            }
                          >
                            {settled
                              ? noted
                                ? `Note ${String(r.note_no || '')}`
                                : 'Written off'
                              : booked
                                ? `${String(r.bill_no || 'Booked')}${orphan ? ' · no voucher' : ''}`
                                : 'Not billed'}
                          </span>
                          {short && !booked && !settled && (
                            <>
                              {!unreg && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void tfRaiseNote(r)
                                  }}
                                  title={`Raise a debit note on ${String(r.transporter_name || '')} for this oil shortage — Dr ${String(r.transporter_name || '')}, Cr Freight ${inward ? 'Inward' : 'Outward'} + GST on the oil`}
                                  style={miniBtn(A.bad, '#F0D6D4')}
                                >
                                  NOTE
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setTfWaiveReason('')
                                  setTfWaive(r)
                                }}
                                title="Write the shortage off as a loss instead of claiming it"
                                style={miniBtn(A.inkMid, '#DCE7DB')}
                              >
                                WAIVE
                              </button>
                            </>
                          )}
                          {settled && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation()
                                void (noted ? tfUnraiseNote(r) : tfUnwaive(r))
                              }}
                              title={noted ? 'Delete the debit note and put the shortage back to claim' : 'Reverse the write-off'}
                              className="flex h-6 w-6 flex-none items-center justify-center rounded-[5px]"
                              style={{ border: '1px solid #DCE7DB', background: '#fff' }}
                            >
                              <Undo2 className="h-3.5 w-3.5" style={{ color: A.muted }} />
                            </button>
                          )}
                        </div>
                      </div>
                      {openRow && billFigs(r)}
                    </div>
                  )
                })}

                {shown.length === 0 && (
                  <div style={{ padding: '44px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
                    No {inward ? 'inward' : 'outward'} freight{' '}
                    {tfState === 'unbilled' ? 'waiting to be booked' : tfState === 'billed' ? 'booked yet' : 'in this period'}
                    {query || tfTr !== 'all' ? ' under these filters' : ''}.
                  </div>
                )}

                <div
                  className="sticky bottom-0 z-[2] grid items-center"
                  style={{ gridTemplateColumns: GRID, minHeight: 42, background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)' }}
                  title="What the rows on screen come to — the filtered set, so it agrees with the list rather than with the tiles above."
                >
                  <span />
                  <span style={{ gridColumn: 'span 3', padding: '0 10px', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: '#A9CDBB' }}>
                    {shown.length} line{shown.length === 1 ? '' : 's'} shown
                  </span>
                  <span style={{ padding: '0 10px', textAlign: 'right', ...mono, fontSize: 12, fontWeight: 700, color: '#DCEFE4' }}>
                    {q3(shown.filter((r) => !isShort(r)).reduce((t, r) => t + qtyOf(r), 0))}
                  </span>
                  <span />
                  <span className="whitespace-nowrap" style={{ padding: '0 10px', textAlign: 'right', ...mono, fontSize: 13, fontWeight: 700, color: A.accent }}>
                    {money(sum(shown))}
                  </span>
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>

          {/* What is ticked, and the one button that books it. */}
          {tfPickedRows.length > 0 && (
            <div
              className="sticky bottom-0 z-[5] flex flex-none flex-wrap items-center gap-3"
              style={{
                background: '#fff',
                border: `1px solid ${tfPickedParties.length > 1 ? '#F0D6D4' : '#CDE89A'}`,
                borderRadius: 10,
                boxShadow: '0 -6px 24px -12px rgba(7,43,32,.3)',
                padding: '11px 14px'
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                <b style={mono}>{tfPickedRows.length}</b> ticked · <b style={mono}>{money(tfPickedTotal)}</b>
                {tfPickedParties.length === 1 ? ` · ${tfPickedParties[0]}` : ''}
              </span>
              {tfPickedParties.length > 1 && (
                <span className="flex items-center gap-1.5" style={{ fontSize: 11.5, fontWeight: 700, color: A.bad }}>
                  <CircleAlert className="h-4 w-4" />
                  Mixed transporters ({tfPickedParties.join(', ')}) — one bill can only cover one.
                </span>
              )}
              {tfPickedRows.some((r) => !weighedOf(r)) && (
                <span className="flex items-center gap-1.5" style={{ fontSize: 11.5, fontWeight: 600, color: A.warn }}>
                  <Scale className="h-4 w-4" />
                  {tfPickedRows.filter((r) => !weighedOf(r)).length} of these{' '}
                  {tfPickedRows.filter((r) => !weighedOf(r)).length === 1 ? 'is' : 'are'} still on an estimated quantity — the final freight lands once
                  weighed in.
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setTfPicked([])}
                  className="flex h-9 items-center rounded-[7px] px-[13px]"
                  style={{ border: '1px solid #C3D2C6', fontSize: 12, fontWeight: 800, color: A.inkMid }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  disabled={tfPickedParties.length !== 1}
                  onClick={() => setTfBillOpen(true)}
                  className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[15px]"
                  style={{
                    background: tfPickedParties.length === 1 ? 'linear-gradient(180deg,#145A43,#0B3D2E)' : '#DCE7DB',
                    color: tfPickedParties.length === 1 ? A.accent : '#8CA396',
                    boxShadow: tfPickedParties.length === 1 ? '0 8px 18px -10px rgba(7,43,32,.8)' : 'none',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: tfPickedParties.length === 1 ? 'pointer' : 'not-allowed'
                  }}
                >
                  <ReceiptText className="h-[17px] w-[17px]" />
                  Book transporter bill
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-none items-start gap-[9px]" style={{ padding: '2px 4px 4px' }}>
            <Info className="h-4 w-4 flex-none" style={{ color: '#8CA396', marginTop: 1 }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: A.muted, lineHeight: 1.6, textWrap: 'pretty' }}>
              Nothing on this register is final until the transporter&rsquo;s bill is booked: the rate, the received quantity and any adjustment on the bill
              can all still move it. <b style={{ color: A.inkMid }}>Basis</b> says whether the quantity behind a figure is settled —{' '}
              <b style={{ color: A.good }}>Weighed</b> is the received figure, <b style={{ color: A.bad }}>Estimated</b> is still the dispatched one.{' '}
              <b style={{ color: A.inkMid }}>Bill</b> says whether it has reached the transporter&rsquo;s account yet.
            </span>
          </div>
        </div>

        {tfDrawers}
        {tfDialogs}
      </div>
    )
    return { strip, body }
  })()

  const dTfCf = colFilter<Row>(colF, `d:tf:${tfSide}`, tfRows, [
    { key: 'date', get: (r) => formatDate(r.entry_date), sort: 'num' },
    { key: 'transporter', get: (r) => r.transporter_name },
    { key: 'invoice', get: (r) => r.doc_no },
    { key: 'tanker', get: (r) => r.vehicle_no },
    { key: 'party', get: (r) => r.party_name },
    { key: 'product', get: (r) => r.product_name },
    { key: 'freight', get: (r) => formatINR(r.amount), sort: 'num' },
    {
      key: 'kind',
      get: (r) =>
        String(r.entry_type) === 'shortage_penalty'
          ? r.note_id != null
            ? 'Oil shortage · claimed'
            : r.waived_at != null
              ? 'Oil shortage · written off'
              : 'Oil shortage · to claim'
          : 'Freight'
    },
    {
      key: 'booked',
      get: (r) =>
        r.bill_id != null ? String(r.bill_no || 'Booked') : r.note_id != null ? String(r.note_no || 'Dr note') : r.waived_at != null ? 'Written off' : 'Not booked'
    }
  ])
  const dTfRows = dTfCf.rows
  const tFreightScreen = (
    <div className="flex-1 space-y-2 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">{tfLabel}</span>
          <div className="flex items-center gap-1">
            {(['unbilled', 'billed', 'all'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTfState(k)}
                title={
                  k === 'unbilled'
                    ? 'Freight with no transporter bill booked against it — provisional'
                    : k === 'billed'
                      ? 'Freight a booked transporter bill has made final'
                      : undefined
                }
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide',
                  tfState === k ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25'
                )}
              >
                {k === 'unbilled' ? 'Provisional' : k === 'billed' ? 'Booked' : 'All'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <span className="opacity-80">Pick by</span>
            {(['tanker', 'invoice'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setTfPickBy(k); setTfPicked([]) }}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                  tfPickBy === k ? 'bg-amber-300 text-slate-900' : 'bg-white/15 hover:bg-white/25'
                )}
              >
                {k === 'tanker' ? (tfSide === 'purchase' ? 'Tanker' : 'Line') : 'Oil invoice'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={tfFrom} to={tfTo} onRange={(f, t) => { setTfFrom(f); setTfTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={tfFrom} onChange={setTfFrom} max={tfTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={tfTo} onChange={setTfTo} min={tfFrom || undefined} /></div>
            {(tfFrom || tfTo) && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-white hover:bg-white/20" onClick={() => { setTfFrom(''); setTfTo('') }}>
                All
              </Button>
            )}
          </div>
        </div>

        {tfOrphans.length > 0 && (
          <div className="border-b border-rose-300 bg-rose-50 px-4 py-2" style={{ borderBottomWidth: 1 }}>
            <div className="text-[11px] font-bold uppercase tracking-widest text-rose-800">
              {tfOrphans.length} bill{tfOrphans.length === 1 ? '' : 's'} with no voucher behind them
            </div>
            <p className="mt-0.5 text-[11px] text-rose-900/80">
              The journal voucher was deleted on its own, so the bill stayed and its freight is still showing as
              booked. Clearing it releases those lines back to pending.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {tfOrphans.map((o) => (
                <button
                  key={String(o.id)}
                  type="button"
                  className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-semibold text-rose-800 hover:bg-rose-100"
                  onClick={() => setTfUnbook({ ...o, bill_id: o.id })}
                >
                  Clear {String(o.bill_no || `#${o.id}`)} · {String(o.transporter_name || '')} ·{' '}
                  {formatINR(o.line_amount)} on {String(o.line_count)} line{Number(o.line_count) === 1 ? '' : 's'}
                </button>
              ))}
            </div>
          </div>
        )}
        {tfKpi && (
          <div className="grid grid-cols-2 gap-px border-b bg-[#DCE7DB] sm:grid-cols-4" style={{ borderColor: '#D6E2D6' }}>
            {([
              { label: 'Freight earned', value: formatINR(tfKpi.total), tone: 'text-[#0B3D2E]' },
              { label: 'Booked to ledger · final', value: formatINR(tfKpi.billed), tone: 'text-emerald-700' },
              // Both of these are PROVISIONAL: nothing is final until the
              // transporter's bill is booked, because the rate, the received
              // quantity and any adjustment on the bill can all still move it.
              // The split says whether the QUANTITY behind the figure is settled.
              { label: 'Provisional · qty weighed', value: formatINR(tfKpi.firm), tone: 'text-amber-700' },
              { label: 'Provisional · qty estimated', value: formatINR(tfKpi.provisional), tone: 'text-rose-700' }
            ] as const).map((k) => (
              <div key={k.label} className="bg-[#F7FAF6] px-4 py-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{k.label}</div>
                <div className={cn('text-[15px] font-bold tabular-nums', k.tone)}>{k.value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="max-h-[calc(100vh-330px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#EAF0E9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="w-8 py-1.5 pl-4" />
                <th className="px-2 py-1.5">{dTfCf.head('date', 'Date')}</th>
                <th className="px-2 py-1.5">{dTfCf.head('transporter', 'Transporter')}</th>
                <th className="px-2 py-1.5">{dTfCf.head('invoice', 'Oil invoice')}</th>
                {tfSide === 'purchase' && <th className="px-2 py-1.5">{dTfCf.head('tanker', 'Tanker')}</th>}
                <th className="px-2 py-1.5">{dTfCf.head('party', tfSide === 'purchase' ? 'Supplier' : 'Customer')}</th>
                <th className="px-2 py-1.5">{dTfCf.head('product', 'Product')}</th>
                <th className="px-2 py-1.5 text-right">{dTfCf.head('freight', 'Freight', { align: 'end' })}</th>
                {/* What the line IS, out of the money column. Stacked under the
                    figure it turned "-2,69,932.24" into three wrapped lines and
                    made the amount hard to read at a glance. */}
                <th className="px-2 py-1.5">{dTfCf.head('kind', 'Kind')}</th>
                <th className="px-2 py-1.5">{dTfCf.head('booked', 'Booked')}</th>
              </tr>
            </thead>
            <tbody>
              {dTfRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">
                    No {tfSide === 'purchase' ? 'inward' : 'outward'} freight {tfState === 'unbilled' ? 'waiting to be booked' : 'here'}.
                  </td>
                </tr>
              ) : (
                dTfRows.map((r) => {
                  const id = Number(r.id)
                  const picked = tfPicked.includes(id)
                  const booked = r.bill_id != null
                  const isShortage = String(r.entry_type) === 'shortage_penalty'
                  // Claimed on its own note: it has already come off what the
                  // transporter is owed, so it must not be tickable onto a bill
                  // as well.
                  const noted = r.note_id != null
                  // Written off: the transporter is owed the freight in full,
                  // so this line has nothing left to net off their bill.
                  const waived = r.waived_at != null
                  const settled = noted || waived
                  return (
                    <tr
                      key={id}
                      className={cn('border-b border-dotted', picked ? 'bg-amber-100/70' : 'hover:bg-amber-50', !booked && !settled && 'cursor-pointer')}
                      style={{ borderColor: '#DCE7DB' }}
                      onClick={() => !booked && !settled && tfToggle(r)}
                    >
                      <td className="py-1.5 pl-4">
                        {!booked && !settled && (
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 cursor-pointer accent-[#0B3D2E]"
                            checked={picked}
                            readOnly
                          />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{formatDate(r.entry_date)}</td>
                      <td className="px-2 py-1.5 font-medium">{r.transporter_name || '—'}</td>
                      <td className="px-2 py-1.5">{r.doc_no || '—'}</td>
                      {tfSide === 'purchase' && <td className="px-2 py-1.5 text-[12px]">{r.vehicle_no || '—'}</td>}
                      <td className="px-2 py-1.5 text-[12px]">{r.party_name || '—'}</td>
                      <td className="px-2 py-1.5 text-[12px]">{r.product_name || '—'}</td>
                      {/* Money coming IN to us reads green, money going back
                          out reads red. The figure's own sign is the thing to
                          see first on a register that now carries both freight
                          earned and debit notes against it; whether the bill is
                          booked yet is a separate question, and stays with the
                          italics and the badge in the last column. */}
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                        <span
                          className={cn(
                            Number(r.amount) < 0 ? 'text-rose-700' : 'text-emerald-700',
                            !booked && 'italic'
                          )}
                          title={
                            String(r.entry_type) === 'shortage_penalty'
                              ? String(r.note || 'Oil shortage beyond the agreed tolerance')
                              : booked
                                ? undefined
                                : 'Provisional until the transporter bill is booked — the rate, the received qty and any adjustment on the bill can still move it.'
                          }
                        >
                          {formatINR(r.amount)}
                        </span>
                      </td>
                      {/* A debit note is not freight and must not read as a
                          negative freight line — it is money coming back off
                          what the transporter is owed, and the bill it goes on
                          nets the two. */}
                      <td className="whitespace-nowrap px-2 py-1.5 text-[10px] uppercase tracking-wide">
                        {isShortage ? (
                          <span
                            className={cn('font-semibold', noted ? 'text-rose-800' : 'text-rose-700')}
                            title={String(r.note || '')}
                          >
                            {noted
                              ? 'Oil shortage · claimed'
                              : waived
                                ? 'Oil shortage · written off'
                                : 'Oil shortage · to claim'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Freight</span>
                        )}
                        {Number(r.provisional) === 1 && (
                          <div
                            className="font-normal text-rose-700"
                            title={
                              tfSide === 'sales'
                                ? 'Not unloaded yet — worked out on the dispatched qty. It settles to received qty x rate once the invoice is marked Unloaded.'
                                : 'Tanker not emptied yet — worked out on the ordered qty until it is weighed in.'
                            }
                          >
                            qty not weighed
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {booked ? (
                          <button
                            type="button"
                            className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700 hover:bg-rose-100 hover:text-rose-700"
                            title="Delete this bill — its voucher is reversed and its freight goes back to pending"
                            onClick={(e) => { e.stopPropagation(); setTfUnbook(r) }}
                          >
                            {r.bill_no || 'Booked'}
                          </button>
                        ) : noted ? (
                          <button
                            type="button"
                            className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-800 hover:bg-rose-200"
                            title={`Debit note ${r.note_no} raised on the transporter — Dr ${r.transporter_name}, Cr Freight ${tfSide === 'purchase' ? 'Inward' : 'Outward'}. Click to delete it and put the oil shortage back on the freight bill.`}
                            disabled={tfNoting === id}
                            onClick={(e) => { e.stopPropagation(); void tfUnraiseNote(r) }}
                          >
                            {r.note_no || 'Dr note'}
                          </button>
                        ) : waived ? (
                          <button
                            type="button"
                            className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700 hover:bg-slate-300"
                            title={`Written off by ${r.waived_by || 'someone'}: ${r.waived_reason || ''} — the transporter bills in full. Click to undo.`}
                            disabled={tfNoting === id}
                            onClick={(e) => { e.stopPropagation(); void tfUnwaive(r) }}
                          >
                            Written off
                          </button>
                        ) : isShortage ? (
                          <div className="flex flex-col items-stretch gap-1">
                            <button
                              type="button"
                              className="rounded border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                              title={`Raise a debit note on ${r.transporter_name} for this oil shortage — Dr ${r.transporter_name}, Cr Freight ${tfSide === 'purchase' ? 'Inward' : 'Outward'}, no GST. The freight then bills in full and the note stands on its own.`}
                              disabled={tfNoting === id}
                              onClick={(e) => { e.stopPropagation(); void tfRaiseNote(r) }}
                            >
                              {tfNoting === id ? 'Raising…' : 'Raise Dr note'}
                            </button>
                            {/* Not every shortage is the carrier's doing. An
                                accident is written off rather than claimed —
                                the transporter is paid in full and the loss is
                                named instead of hiding in material cost. */}
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground hover:bg-slate-100 disabled:opacity-50"
                              title="Not the transporter's — write it off. They bill in full and the loss posts to Oil Shortage Loss."
                              disabled={tfNoting === id}
                              onClick={(e) => { e.stopPropagation(); setTfWaive(r); setTfWaiveReason('') }}
                            >
                              Not theirs
                            </button>
                          </div>
                        ) : (
                          <span
                            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800"
                            title="No transporter bill booked against this freight yet, so the figure is not final"
                          >
                            Provisional
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sticky action bar — what is ticked, and the one button that books it. */}
      {tfPicked.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-3 rounded-md border px-4 py-2 shadow-lg', T.paperEdge, T.paper)}>
          <span className="text-[12px]">
            <span className="font-bold tabular-nums">{tfPicked.length}</span> line{tfPicked.length === 1 ? '' : 's'} ticked ·{' '}
            <span className="font-bold tabular-nums">{formatINR(tfPickedTotal)}</span>
            {tfPickedParties.length === 1 && <> · {tfPickedParties[0]}</>}
          </span>
          {tfPickedParties.length > 1 && (
            <span className="text-[12px] font-semibold text-rose-700">
              Mixed transporters ({tfPickedParties.join(', ')}) — one bill can only cover one.
            </span>
          )}
          {tfPickedRows.some((r) => Number(r.provisional) === 1) && (
            <span className="text-[12px] font-medium text-amber-800">
              {tfPickedRows.filter((r) => Number(r.provisional) === 1).length} of these is still provisional — the final freight
              lands once it is unloaded.
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setTfPicked([])}>Clear</Button>
            <Button
              size="sm"
              className="h-8 bg-[#0B3D2E] text-xs hover:bg-[#0A3327]"
              disabled={tfPickedParties.length !== 1}
              onClick={() => setTfBillOpen(true)}
            >
              Book transporter bill
            </Button>
          </div>
        </div>
      )}

      {tfDialogs}
    </div>
  )

  // One row per ledger in the picker. Pulled out of the panel it used to live
  // in so the modal and nothing else renders it.
  const ledgerRow = (a: Row, ai: number): React.JSX.Element => {
    // Stranded, not merely quiet: no postings, no allocations, and no
    // master claiming the name. CASH A/C or a transporter not yet
    // billed has none of the first two either, and must stay put.
    const unused =
      a.line_count != null &&
      Number(a.line_count) === 0 &&
      Number(a.alloc_count || 0) === 0 &&
      Number(a.claimed_by_master || 0) === 0 &&
      !/\bA\/C$/i.test(String(a.name || ''))
    return (
            <div
              key={String(a.id)}
              ref={(el) => { lgItemRefs.current[ai] = el }}
              role="button"
              tabIndex={0}
              onClick={() => { setLgCursor(ai); setLedgerId(Number(a.id)); setLgPickerOpen(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setLedgerId(Number(a.id))
                  setLgPickerOpen(false)
                } else {
                  // Arrows work from the list too, not only the search box.
                  ledgerKeyNav(e)
                }
              }}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12.5px]',
                ledgerId === Number(a.id)
                  ? T.select
                  : ai === lgCursor
                    ? 'bg-amber-100 ring-1 ring-inset ring-amber-400'
                    : 'hover:bg-amber-100/60'
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{a.name}</span>
                  {unused && (
                    <span
                      className="shrink-0 rounded bg-slate-200 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-slate-600"
                      title="Stranded: no postings, no allocations, and no master list claims this name — left behind when a party was renamed after its first voucher. Renaming that party onto this name merges the two."
                    >
                      unused
                    </span>
                  )}
                </span>
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{a.acc_group}</span>
              </span>
              <span className={cn('shrink-0 tabular-nums text-[12px] font-semibold', Number(a.balance) >= 0 ? 'text-sky-800' : 'text-rose-700')}>
                {formatINR(Math.abs(Number(a.balance) || 0))} {Number(a.balance) >= 0 ? 'Dr' : 'Cr'}
              </span>
            </div>
    )
  }

  // ===========================================================================
  // REGISTERS — purchase, sales, and the notes raised against them.
  // ===========================================================================
  //
  // Three screens on the gateway, one screen here with three tabs: they are the
  // same question asked of three documents, and the tab keeps the period and
  // the search while you move between them.
  //
  // A NOTE ON THE COLUMN NAMES. The canvas heads the fourth column "Ref". These
  // registers are document-level — a purchase is its supplier's invoice, not a
  // voucher number — so the columns are named for what they actually hold:
  // Invoice, and the oil or product behind it. The shape, the widths and the
  // alignment are the canvas's.
  const registerWeb = (() => {
    const tab: 'purchase' | 'sales' | 'notes' =
      screen === 'salesreg' ? 'sales' : screen === 'notesreg' ? 'notes' : 'purchase'
    const isPur = tab === 'purchase'
    const isSal = tab === 'sales'
    const isNotes = tab === 'notes'
    const today = todayISO()

    // Each register keeps its own filters: the notes have theirs, the two
    // document registers share one set — as they always have.
    const fFrom = isNotes ? nrFrom : regFrom
    const fTo = isNotes ? nrTo : regTo
    const fQuery = isNotes ? nrSearch : regSearch
    const setPeriod = (from: string, to: string): void => {
      if (isNotes) {
        setNrFrom(from)
        setNrTo(to)
      } else {
        setRegFrom(from)
        setRegTo(to)
      }
    }
    const setQuery = (v: string): void => (isNotes ? setNrSearch(v) : setRegSearch(v))
    const clearAll = (): void => {
      setPeriod('', '')
      setQuery('')
      // The kind is the register itself on the website, not a filter on it.
      if (isNotes && !__WEB__) setNoteKindFilter('all')
      else setRegFunding([])
      colF.clear(`reg:${tab}`)
    }

    // THE FIGURES THE BOOKS HOLD. A purchase's amount is its net_amount —
    // exactly what its voucher credited the supplier, on every bill in the
    // book. It used to prefer final_net_amount, a recomputation that leaves the
    // additional interest per MT out of the rate, and so reported TI/DL1/26/602
    // at ₹47,53,606.94 against the ₹48,61,643.45 the bill and the ledger say.
    // A sale's amount is what its customer was debited: the lines, GST and
    // round off, less any freight the customer deducted (KRFL/478).
    const pNet = (o: Row): number => n(o.net_amount)
    // The register reads like Tally's: one Debit column, the taxable value the
    // bill debited to purchases — before GST, TDS and round off.
    const pTaxable = (o: Row): number => n(o.taxable_value)
    // And a sale's Credit is what its voucher credited to the sale account:
    // the lines' taxable amount, before GST and round off.
    const sTaxable = (v: Row): number => n(v.amount)
    // What was written on the bill: a purchase's Remarks, a sale's Note.
    // A purchase's vehicle: its tankers' numbers, or the one typed on a
    // tanker-less receipt.
    const purVehicle = (r: Row): string => String(r.tanker_nos || r.tanker_no || '').trim()
    const remarkOf = (r: Row): string => String((isPur ? r.remarks : r.note) || '').trim()
    const sNet = (v: Row): number =>
      n(v.amount) + n(v.gst_amount) + n(v.round_off) - (Number(v.deduct_freight) ? n(v.transport_amount) : 0)
    const lcOverdue = (o: Row): boolean =>
      n(o.lc_bills_open) > 0 && !!o.lc_next_due && String(o.lc_next_due).slice(0, 10) < today

    const base: Row[] = isPur ? purchases : isSal ? saleRows : [...noteRows, ...noteVchRows]
    const preRows: Row[] = isPur ? purchaseRows : isSal ? salesRegRows : noteRegRowsWeb
    // A funnel on every column; the sums below read the rows they leave.
    const regCf = colFilter<Row>(
      colF,
      `reg:${tab}`,
      preRows,
      isPur
        ? [
            { key: 'Date', get: (r) => formatDate(r.order_date), sort: 'num' },
            { key: 'Invoice', get: (r) => r.invoice_no },
            { key: 'Vehicle', get: (r) => purVehicle(r) || 'No vehicle' },
            { key: 'Supplier', get: (r) => r.supplier_name },
            { key: 'Product', get: (r) => r.oil_code || r.oil_name },
            { key: 'Qty', get: (r) => `${formatNum(n(r.ordered_qty))} ${String(r.uom || 'MT')}`, sort: 'num' },
            { key: 'Debit', get: (r) => formatINR(pTaxable(r)), sort: 'num' },
            { key: 'Remarks', get: (r) => remarkOf(r) || '—' }
          ]
        : isSal
          ? [
              { key: 'Date', get: (r) => formatDate(r.sale_date), sort: 'num' },
              { key: 'Invoice', get: (r) => r.invoice_no },
              { key: 'Vehicle', get: (r) => r.gate_vehicle_no || 'Not gated out' },
              { key: 'Customer', get: (r) => r.customer },
              { key: 'Product', get: (r) => r.product_name },
              { key: 'Qty', get: (r) => `${formatNum(n(r.qty))} ${String(r.uom || 'MT')}`, sort: 'num' },
              { key: 'Credit', get: (r) => formatINR(sTaxable(r)), sort: 'num' },
              { key: 'Remarks', get: (r) => remarkOf(r) || '—' }
            ]
          : [
              { key: 'Date', get: (r) => formatDate(r.note_date), sort: 'num' },
              { key: 'Vch no', get: (r) => r.note_no },
              { key: 'Party', get: (r) => r.party_name },
              { key: 'Kind', get: (r) => (String(r.note_type) === 'debit' ? 'Debit note' : 'Credit note') },
              { key: 'Ref', get: (r) => noteAgainst(r) },
              { key: 'What it is for', get: (r) => r.narration },
              { key: 'Amount', get: (r) => formatINR(n(r.total_amount)), sort: 'num' }
            ]
    )
    const rows: Row[] = regCf.rows
    const dateOf = (r: Row): string => String((isPur ? r.order_date : isSal ? r.sale_date : r.note_date) || '').slice(0, 10)

    // ── the sums ──────────────────────────────────────────────────────────
    const pTot = rows.reduce(
      (a, o) => ({ net: a.net + pNet(o), taxable: a.taxable + pTaxable(o), lc: a.lc + n(o.lc_amount), paid: a.paid + n(o.paid_amount) }),
      { net: 0, taxable: 0, lc: 0, paid: 0 }
    )
    const sTot = rows.reduce((a, v) => ({ net: a.net + sNet(v), taxable: a.taxable + sTaxable(v), recd: a.recd + n(v.received_amount) }), { net: 0, taxable: 0, recd: 0 })
    const nTot = rows.reduce(
      (a, r) => {
        const amt = n(r.total_amount)
        const debit = String(r.note_type) === 'debit'
        return {
          total: a.total + amt,
          dr: a.dr + (debit ? amt : 0),
          cr: a.cr + (debit ? 0 : amt),
          drN: a.drN + (debit ? 1 : 0),
          crN: a.crN + (debit ? 0 : 1),
          vch: a.vch + (r.from_voucher ? 1 : 0)
        }
      },
      { total: 0, dr: 0, cr: 0, drN: 0, crN: 0, vch: 0 }
    )
    const pct = (part: number, whole: number): number => (whole > 0.005 ? Math.round((part / whole) * 100) : 0)
    const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`

    // ── the four tiles ────────────────────────────────────────────────────
    type Tile = {
      k: string
      v: string
      sub: string
      icon: typeof ShoppingCart
      accent: string
      dark?: boolean
      go?: () => void
      title?: string
    }
    const overdueN = rows.filter((o) => isPur && lcOverdue(o)).length
    const tiles: Tile[] = isPur
      ? [
          { k: 'Bought', v: formatINR(pTot.net), sub: `${plural(rows.length, 'purchase')} in view`, icon: ShoppingCart, accent: '#0B3D2E', dark: true },
          {
            k: 'Funded by LC',
            v: formatINR(pTot.lc),
            sub: `${rows.filter((o) => !!o.lc_nos).length} tagged to an LC`,
            icon: Landmark,
            accent: '#1B4E82',
            go: () => setRegFunding(['lc']),
            title: 'Show only the purchases funded by an LC'
          },
          { k: 'Paid', v: formatINR(pTot.paid), sub: `${pct(pTot.paid, pTot.net)}% of what was bought`, icon: CircleCheck, accent: '#0B6B45' },
          {
            k: 'Owed to suppliers',
            v: formatINR(pTot.net - pTot.paid),
            sub: overdueN ? `${plural(overdueN, 'LC bill')} overdue` : 'nothing overdue on LC',
            icon: Hourglass,
            accent: overdueN ? '#B3261E' : '#8A5300'
          }
        ]
      : isSal
        ? [
            { k: 'Sold', v: formatINR(sTot.net), sub: `${plural(rows.length, 'invoice')} in view`, icon: ReceiptText, accent: '#0B3D2E', dark: true },
            { k: 'Received', v: formatINR(sTot.recd), sub: `${pct(sTot.recd, sTot.net)}% collected`, icon: CircleCheck, accent: '#0B6B45' },
            {
              k: 'Outstanding',
              v: formatINR(sTot.net - sTot.recd),
              sub: `${plural(rows.filter((v) => sNet(v) - n(v.received_amount) > 0.005).length, 'invoice')} still open`,
              icon: Hourglass,
              accent: '#8A5300'
            },
            {
              k: 'Not gated out',
              v: String(rows.filter((v) => !v.gate_vehicle_no).length),
              sub: 'invoiced but the vehicle has not left',
              icon: Truck,
              accent: '#B3261E'
            }
          ]
        : [
            { k: 'Notes', v: formatINR(nTot.total), sub: `${plural(rows.length, 'note')} in view`, icon: FileStack, accent: '#0B3D2E', dark: true },
            {
              k: 'Debit notes',
              v: formatINR(nTot.dr),
              sub: plural(nTot.drN, 'debit note'),
              icon: FileText,
              accent: '#B3261E',
              go: () => setNoteKindFilter('debit'),
              title: 'Show only the debit notes'
            },
            {
              k: 'Credit notes',
              v: formatINR(nTot.cr),
              sub: plural(nTot.crN, 'credit note'),
              icon: FileText,
              accent: '#0B6B45',
              go: () => setNoteKindFilter('credit'),
              title: 'Show only the credit notes'
            },
            {
              k: 'Entered as vouchers',
              v: String(nTot.vch),
              sub: 'posted from Alt F5 / Alt F6, no note form',
              icon: Receipt,
              accent: '#8A5300'
            }
          ]

    // ── the month shortcuts: the last three months that have entries ────
    const months = Array.from(new Set(base.map(dateOf).filter((d) => d.length >= 7).map((d) => d.slice(0, 7))))
      .sort()
      .slice(-3)
    const monthRange = (ym: string): [string, string] => {
      const [y, m] = ym.split('-').map(Number)
      const last = new Date(y, m, 0).getDate()
      return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`]
    }
    // Spelled out here: the en-IN locale gives "Sept", which no other date
    // on the site uses.
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const monthName = (ym: string): string => MON[Number(ym.slice(5, 7)) - 1] || ym

    // Funding counts are over the period alone, so each chip says what it
    // would show before it is pressed.
    const inPer = (d: string): boolean => (!fFrom || d >= fFrom) && (!fTo || d <= fTo)
    const periodPur = isPur ? purchases.filter((o) => inPer(String(o.order_date || '').slice(0, 10))) : []
    const hasFilter = !!(fFrom || fTo || fQuery.trim() || (isPur && regFunding.length) || (!__WEB__ && isNotes && noteKindFilter !== 'all') || regCf.active > 0)

    // ── the table ─────────────────────────────────────────────────────────
    // EVERY COLUMN WIDE ENOUGH FOR WHAT IS IN IT. The number columns — the
    // invoice no, the note no, the material, what a note was raised against —
    // are measured off the rows themselves (the whole register, not the
    // filtered view, so the columns do not jump about as a search narrows it);
    // the party and the narration take the room that is left and wrap onto a
    // second line rather than being cut short.
    const widest = (vals: string[], weight: number, size: number, pad: number, min: number, max: number, ls = 0): number =>
      Math.round(Math.min(max, Math.max(min, ...vals.map((v) => textWidth(v, weight, size, ls) + pad))))
    const chipW = (vals: string[], size: number): number =>
      // chip text in capitals, its own padding and border, and the cell's
      widest(vals.map((v) => v.toUpperCase()), 800, size, 7 * 2 + 2 + 20 + 2, 0, 420, 0.04)
    const invW = widest(base.map((r) => String(r.invoice_no || '—')), 700, 12, 22, 110, 260)
    const partyMin = (vals: string[]): number => widest(vals, 800, 12, 22, 170, 300)
    // Capped: a packaging item named in full ("MULTYLAYER PLASTIC FILM
    // PRINTED 3 LAYER…") wraps inside its chip rather than widening the whole
    // register for one row.
    const matW = Math.min(
      230,
      Math.max(96, chipW(base.map((r) => String((isPur ? r.oil_code || r.oil_name : r.product_name) || '—')), 10))
    )
    const noteW = widest(base.map((r) => String(r.note_no || '—')), 700, 12, 22, 90, 260)
    const agW = Math.max(
      120,
      base.some((r) => r.from_voucher && noteAgainst(r) === 'Entered as a voucher') ? chipW(['Entered as a voucher'], 9.5) : 0,
      widest(base.filter((r) => noteAgainst(r) !== 'Entered as a voucher').map((r) => noteAgainst(r)), 700, 11.5, 22, 0, 320)
    )
    type Col = number | [number, string]
    const cols: Col[] = isPur
      ? [122, invW, 140, [partyMin(base.map((r) => String(r.supplier_name || '—'))), '1.3fr'], matW, 112, 170, [200, '1.2fr']]
      : isSal
        ? [122, invW, 140, [partyMin(base.map((r) => String(r.customer || '—'))), '1.5fr'], matW, 112, 170, [200, '1.2fr']]
        : [108, noteW, [partyMin(base.map((r) => String(r.party_name || '—'))), '1fr'], 112, agW, [220, '1.6fr'], 150]
    const grid = cols.map((c) => (typeof c === 'number' ? `${c}px` : `minmax(${c[0]}px,${c[1]})`)).join(' ')
    const minW = cols.reduce<number>((t, c) => t + (typeof c === 'number' ? c : c[0]), 0)
    const heads: [string, 'left' | 'right'][] = isPur
      ? [['Date', 'left'], ['Invoice', 'left'], ['Vehicle', 'left'], ['Supplier', 'left'], ['Product', 'left'], ['Qty', 'right'], ['Debit', 'right'], ['Remarks', 'left']]
      : isSal
        ? [['Date', 'left'], ['Invoice', 'left'], ['Vehicle', 'left'], ['Customer', 'left'], ['Product', 'left'], ['Qty', 'right'], ['Credit', 'right'], ['Remarks', 'left']]
        : [['Date', 'left'], ['Vch no', 'left'], ['Party', 'left'], ['Kind', 'left'], ['Ref', 'left'], ['What it is for', 'left'], ['Amount', 'right']]

    const chipStyle = (fg: string, bg: string, bd: string): React.CSSProperties => ({
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      color: fg,
      background: bg,
      border: `1px solid ${bd}`,
      borderRadius: 4,
      padding: '2px 6px',
      whiteSpace: 'nowrap'
    })
    const fig = (size: number, weight = 700, color?: string): React.CSSProperties => ({
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: size,
      fontWeight: weight,
      color,
      whiteSpace: 'nowrap'
    })
    const cellPad: React.CSSProperties = { padding: '0 10px', minWidth: 0 }
    const material = (text: string): React.JSX.Element => (
      <span style={cellPad}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '.04em',
            color: '#33473E',
            background: '#EEF3EC',
            border: '1px solid #DCE7DB',
            borderRadius: 4,
            padding: '3px 7px',
            display: 'inline-block',
            lineHeight: 1.3,
            overflowWrap: 'anywhere'
          }}
        >
          {text}
        </span>
      </span>
    )

    // THE ROW AND ITS NUMBER DO TWO THINGS, as a ledger line does: the invoice
    // no is a link to the document itself, and the rest of the row opens the
    // ledger entries that document wrote, under it.
    type Ctx = { open: boolean; openDoc: () => void }
    const dateCell = (d: unknown, ctx?: Ctx): React.JSX.Element => (
      <span key="d" className="flex items-center gap-1" style={{ ...fig(11.5, 600, '#33473E'), padding: '0 6px 0 7px' }}>
        <ChevronRight
          className="h-[15px] w-[15px] flex-none transition-transform"
          style={{ color: '#8CA396', transform: ctx?.open ? 'rotate(90deg)' : 'none' }}
        />
        {formatDate(d ? String(d) : null)}
      </span>
    )
    const invoiceLink = (no: unknown, what: string, ctx?: Ctx): React.JSX.Element => (
      <button
        key="i"
        type="button"
        title={`Open ${what} ${String(no || '')}`.trim()}
        onClick={(e) => {
          e.stopPropagation()
          ctx?.openDoc()
        }}
        // Enter on the link opens the document — not also the row under it.
        onKeyDown={(e) => e.stopPropagation()}
        className="min-w-0 text-left"
        style={cellPad}
      >
        <span className="block whitespace-nowrap" style={{ ...fig(12, 700, A.link), textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {String(no || '—')}
        </span>
      </button>
    )

    // Two lines at most, the whole text on hover — a remark can run long.
    const remarkCell = (r: Row): React.JSX.Element => {
      const txt = remarkOf(r)
      return (
        <span
          key="rm"
          title={txt || undefined}
          style={{
            ...cellPad,
            padding: '6px 10px',
            fontSize: 11.5,
            fontWeight: 600,
            lineHeight: 1.35,
            color: txt ? '#33473E' : '#C3D2C6',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {txt || '—'}
        </span>
      )
    }
    const cellsOf = (r: Row, ctx?: Ctx): React.JSX.Element[] => {
      if (isPur) {
        return [
          dateCell(r.order_date, ctx),
          invoiceLink(r.invoice_no, 'the bill', ctx),
          <div key="v" style={{ padding: '5px 10px', minWidth: 0 }}>
            {purVehicle(r) ? (
              <>
                <div style={{ ...fig(11.5, 700), overflowWrap: 'anywhere' }}>{purVehicle(r)}</div>
                {!!r.gate_entry_nos && <div style={{ ...fig(10, 600, '#5A6B62'), marginTop: 2, overflowWrap: 'anywhere' }}>{String(r.gate_entry_nos)}</div>}
              </>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, color: '#C3D2C6' }}>—</span>
            )}
          </div>,
          <span key="p" style={{ ...cellPad, fontSize: 12, fontWeight: 800, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35, padding: '6px 10px' }}>
            {String(r.supplier_name || '—')}
          </span>,
          <Fragment key="m">{material(String(r.oil_code || r.oil_name || '—'))}</Fragment>,
          <span key="q" style={{ ...fig(12, 600), ...cellPad, textAlign: 'right' }}>
            {formatNum(n(r.ordered_qty))} {String(r.uom || 'MT')}
          </span>,
          <span key="a" style={{ ...fig(12.5, 700), ...cellPad, textAlign: 'right' }}>{formatINR(pTaxable(r))}</span>,
          remarkCell(r)
        ]
      }
      if (isSal) {
        return [
          dateCell(r.sale_date, ctx),
          invoiceLink(r.invoice_no, 'the invoice', ctx),
          <div key="v" style={{ padding: '5px 10px', minWidth: 0 }}>
            {r.gate_vehicle_no ? (
              <>
                <div style={fig(11.5, 700)}>{String(r.gate_vehicle_no)}</div>
                {!!r.gate_entry_no && <div style={{ ...fig(10, 600, '#5A6B62'), marginTop: 2 }}>{String(r.gate_entry_no)}</div>}
              </>
            ) : (
              <span style={chipStyle('#8A5300', '#FFF4DD', '#F1D9A6')}>Not gated out</span>
            )}
          </div>,
          <span key="c" style={{ ...cellPad, fontSize: 12, fontWeight: 800, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35, padding: '6px 10px' }}>
            {String(r.customer || '—')}
          </span>,
          <Fragment key="m">{material(String(r.product_name || '—'))}</Fragment>,
          <span key="q" style={{ ...fig(12, 600), ...cellPad, textAlign: 'right' }}>
            {formatNum(n(r.qty))} {String(r.uom || 'MT')}
          </span>,
          <span key="a" style={{ ...fig(12.5, 700), ...cellPad, textAlign: 'right' }}>{formatINR(sTaxable(r))}</span>,
          remarkCell(r)
        ]
      }
      const debit = String(r.note_type) === 'debit'
      return [
        <span key="d" style={{ ...fig(11.5, 600, '#33473E'), padding: '0 10px 0 14px' }}>{formatDate(r.note_date)}</span>,
        <span key="i" style={{ ...fig(12, 700), ...cellPad }}>{String(r.note_no || '—')}</span>,
        <span key="p" style={{ ...cellPad, fontSize: 12, fontWeight: 800, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35, padding: '6px 10px' }}>
          {String(r.party_name || '—')}
        </span>,
        <span key="k" style={cellPad}>
          <span style={debit ? chipStyle('#B3261E', '#FDF3F2', '#F0D6D4') : chipStyle('#0B6B45', '#E9F5EE', '#BFE3CB')}>
            {debit ? 'Debit note' : 'Credit note'}
          </span>
        </span>,
        // A note entered on the voucher screen reads its Agst Ref from the
        // voucher's bill-wise lines, like any note; only one set against no
        // bill at all says it was entered as a voucher.
        noteAgainst(r) === 'Entered as a voucher' ? (
          <span key="ag" style={cellPad}>
            <span style={chipStyle('#8A5300', '#FFF4DD', '#F1D9A6')}>Entered as a voucher</span>
          </span>
        ) : (
          <span key="ag" style={{ ...fig(11.5, 700, '#33473E'), ...cellPad, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
            {noteAgainst(r)}
          </span>
        ),
        <span key="n" style={{ ...cellPad, fontSize: 11.5, fontWeight: 600, color: '#33473E', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35, padding: '6px 10px' }}>
          {String(r.narration || '—')}
        </span>,
        <span key="a" style={{ ...fig(12.5, 700, debit ? '#B3261E' : '#0B6B45'), ...cellPad, textAlign: 'right' }}>{formatINR(n(r.total_amount))}</span>
      ]
    }

    // ── WHAT THE DOCUMENT PUT IN THE LEDGERS, under its row ─────────────
    const toggleEntries = (r: Row, rk: string): void => {
      if (regOpenRow === rk) return setRegOpenRow(null)
      setRegOpenRow(rk)
      const have = regPost[rk]
      if (have && (have === 'loading' || !(have as Row).error)) return
      setRegPost((p) => ({ ...p, [rk]: 'loading' }))
      window.api.vouchers
        .forDocument(isPur ? 'order' : 'sale', Number(r.id))
        .then((d) => setRegPost((p) => ({ ...p, [rk]: d })))
        .catch((e) => setRegPost((p) => ({ ...p, [rk]: { error: (e as Error).message } })))
    }
    const entriesPanel = (rk: string, openDoc: () => void): React.JSX.Element => {
      const st = regPost[rk]
      const what = isPur ? 'bill' : 'invoice'
      const wrap = (inner: React.ReactNode): React.JSX.Element => (
        <div style={{ padding: '10px 16px 12px 40px', background: '#F7FAF6', borderBottom: '1px solid #EAF0E9' }}>{inner}</div>
      )
      if (!st || st === 'loading') {
        return wrap(<span style={{ fontSize: 11.5, fontWeight: 600, color: A.muted }}>Reading the ledger entries…</span>)
      }
      if ((st as Row).error) {
        return wrap(
          <span style={{ fontSize: 11.5, fontWeight: 700, color: A.bad }}>Could not read the ledger entries — {String((st as Row).error)}</span>
        )
      }
      const posted = ((st as Row).posted as Row[]) || []
      const settled = ((st as Row).settled as Row[]) || []
      const smallBtn: React.CSSProperties = {
        border: '1px solid #C3D2C6',
        background: '#fff',
        fontSize: 11,
        fontWeight: 800,
        color: A.inkMid
      }
      return wrap(
        <div className="flex flex-col gap-2" style={{ maxWidth: 780 }}>
          {posted.length === 0 && (
            <div style={{ fontSize: 11.5, fontWeight: 600, color: A.muted }}>Nothing in the ledgers for this {what} yet.</div>
          )}
          {posted.map((p) => {
            const lines = orderVoucherLines((p.lines as Row[]) || [], (l) => ({
              account: String(l.account),
              dr: n(l.dr) > 0,
              tax: isTaxLine(String(l.account), String(l.acc_group || '')),
              amount: n(l.dr) || n(l.cr)
            }))
            return (
              <div key={String(p.id)} className="overflow-hidden" style={{ background: '#fff', border: '1px solid #DCE7DB', borderRadius: 8 }}>
                <div className="flex flex-wrap items-center gap-2" style={{ padding: '7px 12px', background: '#FBFDFA', borderBottom: '1px solid #EFF3EE' }}>
                  <span style={chipStyle('#33473E', '#EEF3EC', '#DCE7DB')}>{String(p.vch_type || 'Voucher')}</span>
                  <span style={fig(11.5, 700)}>{String(p.code || p.vch_no || '—')}</span>
                  <span style={fig(11, 600, A.muted)}>{formatDate(p.entry_date)}</span>
                  {!!p.role && <span style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>· {String(p.role)}</span>}
                  {p.balanced === false && <span style={chipStyle('#B3261E', '#FDF3F2', '#F0D6D4')}>Not balanced</span>}
                  <button
                    type="button"
                    onClick={() => void openForAlter({ id: Number(p.id) })}
                    className="ml-auto flex h-7 flex-none items-center gap-1.5 rounded-[6px] px-2.5"
                    style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff', fontSize: 11, fontWeight: 800 }}
                  >
                    Open voucher
                  </button>
                </div>
                {lines.map((l, k) => (
                  <div
                    key={k}
                    className="grid items-center"
                    style={{ gridTemplateColumns: '40px minmax(0,1fr) 140px 140px', minHeight: 32, borderBottom: '1px solid #EFF3EE' }}
                  >
                    <span style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 800, color: n(l.dr) > 0 ? A.dr : A.cr }}>
                      {n(l.dr) > 0 ? 'Dr' : 'Cr'}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 8px', overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                      {String(l.account)}
                    </span>
                    <span style={{ textAlign: 'right', padding: '0 12px', ...fig(11.5, 700, A.dr) }}>{n(l.dr) > 0 ? formatINR(n(l.dr)) : ''}</span>
                    <span style={{ textAlign: 'right', padding: '0 12px', ...fig(11.5, 700, A.cr) }}>{n(l.cr) > 0 ? formatINR(n(l.cr)) : ''}</span>
                  </div>
                ))}
                {!!String(p.narration || '').trim() && (
                  <div style={{ padding: '7px 12px', fontSize: 11, fontWeight: 600, color: A.muted, lineHeight: 1.45 }}>{String(p.narration)}</div>
                )}
              </div>
            )
          })}
          {settled.length > 0 && (
            <div className="overflow-hidden" style={{ background: '#fff', border: '1px solid #DCE7DB', borderRadius: 8 }}>
              <div style={{ padding: '7px 12px', background: '#FBFDFA', borderBottom: '1px solid #EFF3EE', fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: A.muted }}>
                {isPur ? 'Paid by' : 'Received by'}
              </div>
              {settled.map((p) => (
                <button
                  key={String(p.id)}
                  type="button"
                  title="Open this voucher"
                  onClick={() => void openForAlter({ id: Number(p.id) })}
                  className="grid w-full items-center text-left hover:bg-[#F4F9EF]"
                  style={{ gridTemplateColumns: '96px 120px minmax(0,1fr) 150px', minHeight: 32, borderBottom: '1px solid #EFF3EE' }}
                >
                  <span style={{ padding: '0 12px', ...fig(11, 600, A.muted) }}>{formatDate(p.entry_date)}</span>
                  <span style={{ padding: '0 8px', ...fig(11.5, 700) }}>{String(p.code || p.vch_no || '—')}</span>
                  <span style={{ padding: '5px 8px', fontSize: 11, fontWeight: 600, color: A.muted, overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                    {String(p.vch_type || '')}
                    {p.role ? ` · ${String(p.role)}` : ''}
                  </span>
                  <span style={{ padding: '0 12px', textAlign: 'right', ...fig(11.5, 700, A.good) }}>{formatINR(n(p.allocated ?? p.amount))}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={openDoc} className="flex h-7 flex-none items-center gap-1.5 rounded-[6px] px-2.5" style={smallBtn}>
              Open {what}
            </button>
            <span style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>
              {plural(posted.length, 'voucher')} posted{settled.length ? ` · ${plural(settled.length, isPur ? 'payment' : 'receipt')} against it` : ''} · Esc closes
            </span>
          </div>
        </div>
      )
    }

    // The footer, in the frame's own colours: the count, then the sums under
    // the columns they add up.
    const footLabel = (text: string, span: number): React.JSX.Element => (
      <span
        key="lbl"
        style={{ gridColumn: `span ${span}`, padding: '0 10px 0 14px', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: '#A9CDBB', whiteSpace: 'nowrap' }}
      >
        {text}
      </span>
    )
    const footFig = (key: string, v: string, color = '#DCEFE4', size = 12.5): React.JSX.Element => (
      <span key={key} style={{ ...fig(size, 700, color), padding: '0 10px', textAlign: 'right' }}>
        {v}
      </span>
    )
    const foot: React.JSX.Element[] = isPur
      ? [
          footLabel(plural(rows.length, 'purchase'), 6),
          footFig('net', formatINR(pTot.taxable), '#C7F03F')
        ]
      : isSal
        ? [
            footLabel(plural(rows.length, 'invoice'), 6),
            footFig('net', formatINR(sTot.taxable), '#C7F03F')
          ]
        : [footLabel(plural(rows.length, 'note'), 6), footFig('tot', formatINR(nTot.total), '#C7F03F')]

    // Each notes register's own count, whichever of them is open.
    const allNotes = [...(noteRows as Row[]), ...(noteVchRows as Row[])]
    const noteKindCount = {
      debit: allNotes.filter((r) => String(r.note_type) === 'debit').length,
      credit: allNotes.filter((r) => String(r.note_type) === 'credit').length
    }
    const tabsList = [
      { k: 'purchase' as const, label: 'Purchase register', icon: ShoppingCart, key: 'P', screen: 'purchreg' as Screen, n: purchaseRows.length },
      { k: 'sales' as const, label: 'Sales register', icon: ReceiptText, key: 'S', screen: 'salesreg' as Screen, n: salesRegRows.length },
      { k: 'debit' as const, label: 'Debit notes', icon: FileText, key: 'N', screen: 'notesreg' as Screen, n: noteKindCount.debit },
      { k: 'credit' as const, label: 'Credit notes', icon: FileText, key: 'C', screen: 'notesreg' as Screen, n: noteKindCount.credit }
    ].filter((t) => mayScreen(t.screen))

    return (
      <>
        {/* THE REGISTERS' OWN STRIP, in the frame's green under the module
            header: one pill per register, lime for the one open, each with its
            count and the key that opens it. */}
        <div
          className="sc flex h-12 flex-none items-center gap-1.5 overflow-x-auto"
          style={{
            padding: '0 20px',
            background: 'linear-gradient(180deg,#0B3D2E 0%,#093324 100%)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06),0 6px 18px -8px rgba(7,43,32,.6)',
            position: 'relative',
            zIndex: 3
          }}
        >
          {tabsList.map((t) => {
            const on = tab === t.k || (tab === 'notes' && noteKindFilter === t.k)
            return (
              <button
                key={t.k}
                type="button"
                onClick={() => {
                  if (t.k === 'debit' || t.k === 'credit') setNoteKindFilter(t.k)
                  setScreen(t.screen)
                }}
                className="flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[7px] px-[13px]"
                style={{
                  background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
                  border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
                  boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.6),0 6px 16px -6px rgba(199,240,63,.55)' : 'none',
                  color: on ? '#0B3D2E' : '#DCEFE4',
                  fontSize: 12,
                  fontWeight: 800
                }}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
                <span
                  style={{
                    ...fig(10, 600, on ? '#0B3D2E' : '#C7F03F'),
                    background: on ? 'rgba(11,61,46,.12)' : 'rgba(199,240,63,.1)',
                    borderRadius: 9,
                    padding: '1px 7px'
                  }}
                >
                  {t.n}
                </span>
                <span
                  style={{
                    ...fig(9.5, 600, on ? '#0B3D2E' : '#8FBFA8'),
                    background: on ? 'rgba(11,61,46,.12)' : 'rgba(255,255,255,.07)',
                    borderRadius: 3,
                    padding: '2px 5px'
                  }}
                >
                  {t.key}
                </span>
              </button>
            )
          })}
          <div className="flex-1" />
          <span className="hidden items-center gap-1.5 whitespace-nowrap 2xl:flex" style={{ fontSize: 11, fontWeight: 600, color: '#8FBFA8' }}>
            <KeyboardIcon className="h-[15px] w-[15px]" />P purchases · S sales · N notes
          </span>
          <button
            type="button"
            title="Summary — what this register comes to (F8)"
            aria-expanded={regSumOpen}
            onClick={() => setRegSumOpen((o) => !o)}
            className="ml-2 flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3"
            style={{
              background: regSumOpen ? 'rgba(199,240,63,.16)' : 'rgba(255,255,255,.07)',
              border: `1px solid ${regSumOpen ? '#C7F03F' : 'rgba(255,255,255,.14)'}`,
              color: regSumOpen ? '#C7F03F' : '#fff',
              fontSize: 12,
              fontWeight: 800
            }}
          >
            <PieChart className="h-4 w-4" style={{ color: '#C7F03F' }} />
            Summary
            <span style={{ ...fig(9.5, 600, '#8FBFA8'), background: 'rgba(255,255,255,.07)', borderRadius: 3, padding: '2px 5px' }}>F8</span>
          </button>
        </div>

        {/* The table, the whole height of the screen. `relative` so the
            summary can come in over it. */}
        <div
          className="relative flex min-h-0 flex-1 flex-col px-[14px] py-3 min-[1400px]:px-5 min-[1400px]:py-4"
          style={{ background: '#EEF3EC' }}
        >
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px]"
            style={{ background: '#fff', border: '1px solid #DCE7DB', boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)' }}
          >
            {/* The filters, on the card they filter. */}
            <div
              className="flex flex-none flex-wrap items-center gap-[9px]"
              style={{ padding: '11px 14px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)' }}
            >
              <div
                className="flex h-9 max-w-[320px] flex-[1_1_220px] items-center gap-2 rounded-[7px] bg-white px-2.5"
                style={{ border: `1px solid ${fQuery.trim() ? '#12855A' : '#C3D2C6'}`, boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)' }}
              >
                <Search className="h-4 w-4 flex-none" style={{ color: '#5A6B62' }} />
                <input
                  value={fQuery}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={isPur ? 'Invoice, supplier, material or LC no' : isSal ? 'Invoice, customer, product or vehicle' : 'Note, party or reason'}
                  className="min-w-0 flex-1 border-0 bg-transparent outline-none"
                  style={{ fontSize: 12, fontWeight: 600, color: '#0A1F17' }}
                />
              </div>
              <div
                className="flex h-9 items-center gap-1 rounded-[7px] bg-white pl-1 pr-1"
                style={{ border: `1px solid ${fFrom || fTo ? '#12855A' : '#C3D2C6'}` }}
              >
                <DatePicker
                  value={fFrom}
                  onChange={(v) => setPeriod(v, fTo)}
                  max={fTo || undefined}
                  placeholder="From"
                  className="!h-[30px] !w-[122px] !rounded-[5px] !border-0 !bg-transparent !px-1.5 !text-[11.5px] !font-semibold !shadow-none"
                />
                <span style={{ fontSize: 11, color: '#8CA396' }}>→</span>
                <DatePicker
                  value={fTo}
                  onChange={(v) => setPeriod(fFrom, v)}
                  min={fFrom || undefined}
                  placeholder="To"
                  className="!h-[30px] !w-[122px] !rounded-[5px] !border-0 !bg-transparent !px-1.5 !text-[11.5px] !font-semibold !shadow-none"
                />
              </div>
              {months.length > 0 && (
                <div className="flex gap-0.5 rounded-[7px] p-0.5" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}>
                  {[{ ym: '', label: 'All' }, ...months.map((ym) => ({ ym, label: monthName(ym) }))].map((m) => {
                    const [a, z] = m.ym ? monthRange(m.ym) : ['', '']
                    const on = m.ym ? fFrom === a && fTo === z : !fFrom && !fTo
                    return (
                      <button
                        key={m.ym || 'all'}
                        type="button"
                        onClick={() => setPeriod(a, z)}
                        title={m.ym ? `${formatDate(a)} to ${formatDate(z)}` : 'Every date'}
                        className="flex h-[30px] items-center whitespace-nowrap rounded-[5px] px-2.5"
                        style={{ background: on ? '#fff' : 'transparent', color: on ? '#0B3D2E' : '#5A6B62', fontSize: 11, fontWeight: 800, boxShadow: on ? '0 1px 2px rgba(10,31,23,.1)' : 'none' }}
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              )}
              {isPur && (
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { k: 'lc', label: 'Funded by LC', icon: Landmark },
                    { k: 'nolc', label: 'No LC tagged', icon: PiggyBank }
                  ].map((f) => {
                    const on = regFunding.includes(f.k)
                    const count = periodPur.filter((o) => (o.lc_nos ? 'lc' : 'nolc') === f.k).length
                    return (
                      <button
                        key={f.k}
                        type="button"
                        onClick={() => setRegFunding(on ? regFunding.filter((x) => x !== f.k) : [...regFunding, f.k])}
                        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-[11px]"
                        style={{ border: `1px solid ${on ? '#1B4E82' : '#DCE7DB'}`, background: on ? '#EAF0FA' : '#fff', color: on ? '#1B4E82' : '#33473E', fontSize: 11.5, fontWeight: 800 }}
                      >
                        <f.icon className="h-[15px] w-[15px]" />
                        {f.label}
                        <span style={{ ...fig(10, 700), opacity: 0.75 }}>{count}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {!__WEB__ && isNotes && noteKindFilter !== 'all' && (
                <span style={chipStyle(noteKindFilter === 'debit' ? '#B3261E' : '#0B6B45', noteKindFilter === 'debit' ? '#FDF3F2' : '#E9F5EE', noteKindFilter === 'debit' ? '#F0D6D4' : '#BFE3CB')}>
                  {noteKindFilter === 'debit' ? 'Debit notes only' : 'Credit notes only'}
                </span>
              )}
              {hasFilter && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="flex h-8 items-center gap-1.5 rounded-[7px] px-2.5"
                  style={{ color: '#0B6B45', fontSize: 11.5, fontWeight: 800 }}
                >
                  <FilterX className="h-[15px] w-[15px]" />
                  Clear
                </button>
              )}
              <span className="ml-auto whitespace-nowrap" style={{ fontSize: 11.5, fontWeight: 600, color: '#5A6B62' }}>
                {rows.length} of {base.length} shown
              </span>
            </div>

            <div ref={regScrollEl} className="sc min-h-0 flex-1 overflow-auto">
              <div style={{ minWidth: minW }}>
                <div
                  className="sticky top-0 z-[2] grid h-[34px] items-center"
                  style={{
                    gridTemplateColumns: grid,
                    background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)',
                    color: '#A9CDBB',
                    fontSize: 9.5,
                    fontWeight: 800,
                    letterSpacing: '.12em',
                    textTransform: 'uppercase'
                  }}
                >
                  {heads.map(([label, align], i) => (
                    <span
                      key={label}
                      style={{ padding: i === 0 ? '0 10px 0 14px' : '0 10px', textAlign: align, whiteSpace: 'nowrap', display: 'flex', justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
                    >
                      {regCf.head(label, label, { onDark: true, align: align === 'right' ? 'end' : 'start' })}
                    </span>
                  ))}
                </div>

                {rows.map((r, i) => {
                  // A REGISTER LINE, LIKE A LEDGER LINE: its number opens the
                  // document (the bill in Purchases, the invoice in Sales — Esc or
                  // Back returns here), and the row opens the ledger entries
                  // that document wrote, under it. A note is a voucher already,
                  // so its row opens that voucher.
                  const rk = `${tab}:${String(r.id)}`
                  const open = !isNotes && regOpenRow === rk
                  const openDoc = (): void => {
                    if (!onOpenRecord || !Number(r.id)) return
                    regMemo = {
                      screen,
                      regFrom,
                      regTo,
                      regSearch,
                      regFunding,
                      nrFrom,
                      nrTo,
                      nrSearch,
                      noteKind: noteKindFilter,
                      openRow: regOpenRow,
                      post: regPost,
                      scrollTop: regScrollEl.current?.scrollTop ?? 0
                    }
                    onOpenRecord(isPur ? 'orders' : 'sales', Number(r.id), { screen, ledgerId: null, companyId: cid })
                  }
                  const openable = isNotes ? !!Number(r.journal_entry_id) : !!Number(r.id)
                  const onRow = (): void => {
                    if (!openable) return
                    if (isNotes) return void openForAlter({ id: Number(r.journal_entry_id) })
                    toggleEntries(r, rk)
                  }
                  const stripe = open ? '#F3FBE2' : i % 2 ? '#FBFDFA' : '#fff'
                  return (
                    <Fragment key={String(r.id)}>
                      <div
                        role={openable ? 'button' : undefined}
                        tabIndex={openable ? 0 : undefined}
                        aria-expanded={isNotes ? undefined : open}
                        title={
                          openable
                            ? isNotes
                              ? `Open ${String(r.note_no || 'this note')} to alter or delete it`
                              : open
                                ? 'Hide the ledger entries'
                                : `Show the ledger entries for this ${isPur ? 'bill' : 'invoice'}`
                            : undefined
                        }
                        onClick={onRow}
                        onKeyDown={(ev) => {
                          if (openable && (ev.key === 'Enter' || ev.key === ' ')) {
                            ev.preventDefault()
                            onRow()
                          }
                        }}
                        onMouseEnter={(ev) => {
                          if (!open) ev.currentTarget.style.background = '#F4F9EF'
                        }}
                        onMouseLeave={(ev) => {
                          ev.currentTarget.style.background = stripe
                        }}
                        className={cn('grid min-h-[46px] items-center outline-none focus-visible:bg-[#F4F9EF]', openable && 'cursor-pointer')}
                        style={{
                          gridTemplateColumns: grid,
                          borderBottom: '1px solid #EFF3EE',
                          background: stripe,
                          // An LC bill past its due date marks its purchase.
                          boxShadow: `inset 3px 0 0 ${isPur && lcOverdue(r) ? '#B3261E' : open ? '#12855A' : 'transparent'}`
                        }}
                      >
                        {cellsOf(r, { open, openDoc })}
                      </div>
                      {open && entriesPanel(rk, openDoc)}
                    </Fragment>
                  )
                })}

                {rows.length === 0 && (
                  <div style={{ padding: '44px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#5A6B62' }}>
                    {base.length === 0
                      ? 'Nothing in this register yet.'
                      : isPur
                        ? 'No purchases for this filter.'
                        : isSal
                          ? 'No sales for this filter.'
                          : 'No notes for this filter.'}
                  </div>
                )}

                <div
                  className="sticky bottom-0 z-[2] grid min-h-[42px] items-center"
                  style={{ gridTemplateColumns: grid, background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)' }}
                >
                  {foot}
                </div>
              </div>
            </div>
          </div>

          {/* THE SUMMARY, OVER THE TABLE. The table has the whole screen; what
              the register comes to is called up over it from the right — F8 or
              Summary — and put away with Esc or a click outside, the same way
              the ledger's summary is. */}
          {regSumOpen && (
            <>
              <div className="absolute inset-0 z-[30]" style={{ background: 'rgba(10,31,23,.28)' }} onMouseDown={() => setRegSumOpen(false)} />
              <div
                className="absolute bottom-3 right-[14px] top-3 z-[31] flex flex-col overflow-hidden min-[1400px]:bottom-3.5 min-[1400px]:right-5 min-[1400px]:top-4"
                style={{
                  width: 'min(400px, calc(100% - 28px))',
                  background: A.paper,
                  border: '1px solid #DCE7DB',
                  borderRadius: 12,
                  boxShadow: '-18px 0 44px -22px rgba(10,31,23,.5)'
                }}
              >
                <div className="flex flex-none items-center gap-2" style={{ padding: '10px 12px', borderBottom: '1px solid #EAF0E9', background: '#fff' }}>
                  <PieChart className="h-[17px] w-[17px] flex-none" style={{ color: A.frame }} />
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: A.ink }}>
                    Summary · {isPur ? 'Purchase register' : isSal ? 'Sales register' : noteKindFilter === 'credit' ? 'Credit notes' : 'Debit notes'}
                  </span>
                  <button
                    type="button"
                    title="Close (Esc)"
                    onClick={() => setRegSumOpen(false)}
                    className="flex h-8 flex-none items-center rounded-[7px] px-2.5"
                    style={{ border: '1px solid #DCE7DB', fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: A.muted }}
                  >
                    ESC
                  </button>
                </div>
                <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>
                    {rows.length} of {base.length} shown{hasFilter ? ' — the figures follow the filters on the table' : ''}
                  </div>
                  {/* THE FOUR TILES — what the register comes to, the first one dark
                      because it is the total everything else is a share of. */}
                  <div className="grid flex-none gap-2.5" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                    {tiles.map((t) => (
                      <div
                        key={t.k}
                        role={t.go ? 'button' : undefined}
                        tabIndex={t.go ? 0 : undefined}
                        title={t.title}
                        onClick={() => {
                          if (!t.go) return
                          t.go()
                          setRegSumOpen(false)
                        }}
                        onKeyDown={(e) => {
                          if (t.go && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault()
                            t.go()
                            setRegSumOpen(false)
                          }
                        }}
                        className="relative min-w-0 overflow-hidden rounded-[12px]"
                        style={{
                          background: t.dark ? 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)' : '#fff',
                          border: `1px solid ${t.dark ? 'transparent' : '#DCE7DB'}`,
                          boxShadow: t.dark ? 'inset 0 1px 0 rgba(255,255,255,.1),0 14px 30px -16px rgba(7,43,32,.7)' : '0 1px 2px rgba(10,31,23,.04)',
                          padding: '14px 16px',
                          cursor: t.go ? 'pointer' : 'default'
                        }}
                      >
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            top: -50,
                            right: -50,
                            width: 140,
                            height: 140,
                            borderRadius: '50%',
                            background: `radial-gradient(circle,${t.dark ? 'rgba(199,240,63,.18)' : `${t.accent}1A`},transparent 70%)`
                          }}
                        />
                        <div className="relative flex items-center gap-2">
                          <t.icon className="h-[17px] w-[17px]" style={{ color: t.dark ? '#C7F03F' : t.accent }} />
                          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: t.dark ? '#8FBFA8' : '#5A6B62' }}>{t.k}</span>
                        </div>
                        <div className="relative" style={{ ...fig(20, 700, t.dark ? '#C7F03F' : t.accent), letterSpacing: '-0.03em', marginTop: 8 }}>
                          {t.v}
                        </div>
                        <div className="relative" style={{ fontSize: 11, fontWeight: 600, color: t.dark ? '#8FBFA8' : '#5A6B62', marginTop: 4 }}>
                          {t.sub}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-none items-start gap-[9px] rounded-[10px]" style={{ padding: '11px 12px', background: '#fff', border: '1px solid #DCE7DB' }}>
                    <Info className="h-4 w-4 flex-none" style={{ color: '#8CA396' }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#5A6B62', lineHeight: 1.6 }}>
                      {isPur
                        ? 'Document-level, not ledger-level: what was bought and how it was funded. A purchase shows as LC-funded once a bill is issued under the LC against its invoice. A red edge marks an LC bill past its due date. Click the invoice no to open the bill, or the row for its ledger entries.'
                        : isSal
                          ? 'Document-level, not ledger-level: what was sold, and what has come back. Amount includes GST and round-off. Vehicle comes from the gate entry; an invoice with none has not been gated out yet. Click the invoice no to open the invoice, or the row for its ledger entries.'
                          : 'Debit and credit notes — those raised on the notes form, and those entered straight on the voucher screen (Alt F5 / Alt F6), which say so in Against. Click a row to open its voucher.'}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </>
    )
  })()

  // ===========================================================================
  // OPENING BALANCES — where the books started, and where they stand now.
  // ===========================================================================
  // ===========================================================================
  // ACCOUNTING VOUCHERS — one grid, whichever way the voucher is entered.
  // ===========================================================================
  //
  // TWO MODELS BEHIND ONE TABLE.
  //
  // A payment or a receipt is entered Tally's way: party lines, and the cash
  // or bank account the money moved through — the SIDE is not a choice there,
  // it follows from the type, and the posting code enforces that the money
  // side adds up to the party side. Everything else is free Dr/Cr lines.
  //
  // The canvas draws one table for all of them, so this builds one row shape
  // out of whichever model is in use and renders that. Nothing about how a
  // voucher posts changes — saveVoucher is untouched — but the desk sees the
  // same grid whatever it is entering, and a side it cannot flip says why
  // rather than simply refusing the click.
  // ── MASTERS: CREATING AND MOVING ──────────────────────────────────────
  //
  // Everything here is presentation of the chart, not a posting: nothing below
  // touches a journal line or a balance. The one thing deliberately absent is
  // renaming a LEDGER — half this app finds its ledger by name when it posts
  // (getOrCreateAccount), so a rename would strand the account's history and
  // quietly open a second one under the new name at the next purchase. Groups
  // rename freely, because every ledger under one is carried with it.
  async function masterCreate(): Promise<void> {
    if (!rightsIn('accountsMasters').create) return void toast.error('You do not have rights to create in Masters')
    if (!mNew) return
    const name = mNew.name.trim()
    if (!name) return
    setMBusy(true)
    try {
      if (mNew.kind === 'group') {
        await window.api.journal.createGroup({
          name,
          under: mNew.under || null,
          nature: mNew.under ? undefined : mNew.nature
        })
        toast.success(mNew.under ? `${name} created under ${mNew.under}` : `${name} created as a primary group`)
      } else {
        await window.api.journal.createAccount(name.toUpperCase(), mNew.under || 'General', cid)
        toast.success(`${name.toUpperCase()} created under ${mNew.under || 'General'}`)
      }
      setMNew(null)
      await Promise.all([loadGroups(), loadAccounts()])
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setMBusy(false)
    }
  }

  async function masterSaveEdit(): Promise<void> {
    if (!rightsIn('accountsMasters').edit) return void toast.error('You do not have rights to change Masters')
    if (!mEdit) return
    setMBusy(true)
    try {
      if (mEdit.act === 'rename' && mEdit.kind === 'ledger') {
        // The account takes the new name AND a redirect is written, so a
        // posting addressed to the old one lands here instead of opening a
        // second account under it. That redirect is the whole reason this is
        // now offered at all.
        const r = await window.api.journal.renameLedger(mEdit.id, mEdit.name.trim(), cid)
        toast.success(
          `${r.from} is now ${r.to} — postings addressed to ${r.from} will follow it`
        )
      } else if (mEdit.act === 'rename') {
        await window.api.journal.renameGroup(mEdit.id, mEdit.name.trim())
        toast.success(`Renamed to ${mEdit.name.trim()}`)
      } else if (mEdit.kind === 'group') {
        const parent = groupRows.find((g) => String(g.name) === mEdit.under)
        // Moved to the top it becomes a primary, and a primary declares its own
        // side of the books. It keeps the one it has been reading as rather
        // than dropping to a default — a group does not change sides because
        // somebody changed where it sits.
        const mine = groupRows.find((g) => Number(g.id) === mEdit.id)
        await window.api.journal.moveGroup(
          mEdit.id,
          parent ? Number(parent.id) : null,
          String(mine?.nature || 'asset')
        )
        toast.success(mEdit.under ? `${mEdit.name} moved under ${mEdit.under}` : `${mEdit.name} is now a primary group`)
      } else {
        await window.api.journal.setAccountGroup(mEdit.id, mEdit.under)
        toast.success(`${mEdit.name} moved to ${mEdit.under}`)
      }
      setMEdit(null)
      await Promise.all([loadGroups(), loadAccounts()])
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setMBusy(false)
    }
  }

  // SEVERAL LEDGERS TO ONE GROUP. The same move a single ledger's Move makes,
  // for every ticked ledger at once and all-or-none on the server — so a
  // dozen party ledgers filed under the wrong head are one action, not twelve.
  async function masterMoveMany(ids: number[], group: string): Promise<boolean> {
    if (!rightsIn('accountsMasters').edit) {
      toast.error('You do not have rights to change Masters')
      return false
    }
    if (!ids.length) return false
    if (!group) {
      toast.error('Pick the group to move them to')
      return false
    }
    setMMoving(true)
    try {
      const r = await window.api.journal.setAccountsGroup(ids, group)
      toast.success(`${r.moved} ledger${r.moved === 1 ? '' : 's'} moved to ${r.group}`)
      setMPicked(new Set())
      await Promise.all([loadGroups(), loadAccounts()])
      // Open the way to where they went, so the result is on screen.
      const dest = groupRows.find((g) => String(g.name) === r.group)
      if (dest) {
        setMOpen((o) => {
          const next = { ...o }
          let cur: Row | undefined = dest
          const guard = new Set<number>()
          while (cur && !guard.has(Number(cur.id))) {
            guard.add(Number(cur.id))
            next[Number(cur.id)] = true
            const pid: unknown = cur.parent_id
            cur = pid == null ? undefined : groupRows.find((g) => Number(g.id) === Number(pid))
          }
          return next
        })
      }
      return true
    } catch (e) {
      toast.error(errText(e))
      return false
    } finally {
      setMMoving(false)
    }
  }

  // Hide ledgers from the pickers and the chart's list, or bring them back.
  async function masterSetHidden(ids: number[], hidden: boolean): Promise<void> {
    if (!rightsIn('accountsMasters').edit) return void toast.error('You do not have rights to change Masters')
    if (!ids.length) return
    setMMoving(true)
    try {
      const r = await window.api.journal.setAccountsHidden(ids, hidden)
      toast.success(`${r.changed} ledger${r.changed === 1 ? '' : 's'} ${hidden ? 'hidden' : 'shown again'}`)
      setMPicked(new Set())
      await loadAccounts()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setMMoving(false)
    }
  }

  // The website drawer's save — the same calls the two dialogs above make.
  async function mDrawerSave(d: MDrawer): Promise<void> {
    if (d.ids) {
      if (await masterMoveMany(d.ids, d.under)) setMDrawer(null)
      return
    }
    const name = d.name.trim()
    setMBusy(true)
    try {
      if (d.act === 'new' && d.kind === 'group') {
        await window.api.journal.createGroup({ name, under: d.under || null, nature: d.under ? undefined : d.nature })
        toast.success(d.under ? `${name} created under ${d.under}` : `${name} created as a primary group`)
      } else if (d.act === 'new') {
        await window.api.journal.createAccount(name.toUpperCase(), d.under, cid)
        toast.success(`${name.toUpperCase()} created under ${d.under}`)
      } else if (d.act === 'rename' && d.kind === 'ledger' && d.id) {
        // The account takes the new name AND a redirect is written, so a
        // posting addressed to the old one lands here instead of opening a
        // second account under it.
        const r = await window.api.journal.renameLedger(d.id, name, cid)
        toast.success(`${r.from} is now ${r.to} — postings addressed to ${r.from} will follow it`)
      } else if (d.act === 'rename' && d.id) {
        await window.api.journal.renameGroup(d.id, name)
        toast.success(`Renamed to ${name}`)
      } else if (d.kind === 'group' && d.id) {
        const parent = groupRows.find((g) => String(g.name) === d.under)
        // Moved to the top it becomes a primary, and keeps the side it already
        // reads as unless another was picked.
        await window.api.journal.moveGroup(d.id, parent ? Number(parent.id) : null, d.nature || d.oldNature || 'asset')
        toast.success(d.under ? `${d.oldName} moved under ${d.under}` : `${d.oldName} is now a primary group`)
      } else if (d.id) {
        await window.api.journal.setAccountGroup(d.id, d.under)
        toast.success(`${d.oldName} moved to ${d.under}`)
      }
      setMDrawer(null)
      // Open the way to where it went, so the result is on screen.
      const dest = groupRows.find((g) => String(g.name) === d.under)
      if (dest) {
        setMOpen((o) => {
          const next = { ...o }
          let cur: Row | undefined = dest
          const guard = new Set<number>()
          while (cur && !guard.has(Number(cur.id))) {
            guard.add(Number(cur.id))
            next[Number(cur.id)] = true
            const pid: unknown = cur.parent_id
            cur = pid == null ? undefined : groupRows.find((g) => Number(g.id) === Number(pid))
          }
          return next
        })
      }
      await Promise.all([loadGroups(), loadAccounts()])
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setMBusy(false)
    }
  }

  async function masterDeleteGroup(g: Row): Promise<void> {
    if (!rightsIn('accountsMasters').delete) return void toast.error('You do not have rights to delete in Masters')
    if (!window.confirm(`Delete the group ${String(g.name)}? Nothing is posted to it.`)) return
    try {
      await window.api.journal.deleteGroup(Number(g.id))
      toast.success(`${String(g.name)} deleted`)
      await Promise.all([loadGroups(), loadAccounts()])
    } catch (e) {
      toast.error(errText(e))
    }
  }

  /**
   * MASTERS & OPENING BALANCES — THE WEBSITE'S TWO MASTER SCREENS, ONE CANVAS.
   *
   * The chart of accounts and the figures each ledger opens at are two views of
   * the same list, so they sit on one canvas with a tab each (M and B) rather
   * than on two unrelated paper panels. Nothing here is new behaviour: every
   * create, rename, move and save goes through the same calls the old screens
   * made, and the openings still save as one batch.
   *
   * The chart is Tally's List of Accounts, with the part this app never had: a
   * group can be created under any other group, to any depth, and a ledger can
   * be moved between them. A group's figure is its SUBTREE's — CURRENT ASSETS is
   * worth what everything beneath it is worth.
   */
  const booksWeb = (() => {
    const onOpenings = screen === 'openings'
    // This company's ledgers, or every company's — see ledScopeAll.
    const coAccounts = ledScopeAll || !ledScopeKnown ? accounts : accounts.filter((a) => coLedgerIds.has(Number(a.id)))
    const otherCount = accounts.length - accounts.filter((a) => coLedgerIds.has(Number(a.id))).length
    const scopeToggle = !ledScopeKnown ? null : (
      <div
        className="flex flex-none items-center gap-[3px] rounded-[7px] p-[3px]"
        style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}
        title="Ledgers are shared between the companies; this shows the ones this company uses, or all of them"
      >
        {([
          { v: false, label: String(company?.name || 'This company').split(' ').slice(0, 2).join(' ') },
          { v: true, label: `All companies${otherCount > 0 ? ` · +${otherCount}` : ''}` }
        ] as const).map((o) => (
          <button
            key={String(o.v)}
            type="button"
            onClick={() => setLedScopeAll(o.v)}
            className="h-[30px] whitespace-nowrap rounded-[5px] px-2.5"
            style={
              ledScopeAll === o.v
                ? { background: '#fff', color: '#0B3D2E', fontSize: 11.5, fontWeight: 800, boxShadow: '0 1px 3px rgba(10,31,23,.12)' }
                : { color: A.muted, fontSize: 11.5, fontWeight: 700 }
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    )
    const NAT: Record<string, { label: string; fg: string; bg: string; bd: string; bar: string }> = {
      asset: { label: 'Asset', fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', bar: 'linear-gradient(90deg,#9EC2EA,#1B4E82)' },
      liability: { label: 'Liability', fg: '#8C2F26', bg: '#FDF3F2', bd: '#F0D6D4', bar: 'linear-gradient(90deg,#E7A7A0,#8C2F26)' },
      income: { label: 'Income', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', bar: 'linear-gradient(90deg,#9FE3BF,#0B6B45)' },
      expense: { label: 'Expense', fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', bar: 'linear-gradient(90deg,#F3D48B,#8A5300)' }
    }
    const natOf = (k: unknown): (typeof NAT)[string] => NAT[String(k || '').toLowerCase()] || NAT.asset
    // Positive is Dr, negative Cr — the same convention as the Ledgers screen.
    const bal = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`)
    const balFg = (v: number): string => (Math.abs(v) < 0.005 ? '#8CA396' : v > 0 ? '#1B4E82' : '#8C2F26')
    const grp = (v: number): string => Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const mono: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: FIGS }
    const DASH = '—'
    const card: React.CSSProperties = {
      background: '#fff',
      border: '1px solid #DCE7DB',
      borderRadius: 10,
      boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)'
    }
    const toolbar: React.CSSProperties = {
      padding: '11px 14px',
      borderBottom: '1px solid #EAF0E9',
      background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)'
    }
    const headRow: React.CSSProperties = {
      position: 'sticky',
      top: 0,
      zIndex: 2,
      background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)',
      color: '#A9CDBB',
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      height: 34,
      alignItems: 'center'
    }
    const kicker: React.CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase' }
    const showRail = vw >= 1280
    const railW = vw >= 1900 ? 360 : 310
    const gutter = vw >= 1400 ? 16 : 12
    const bodyPad = vw >= 1400 ? '16px 20px' : '12px 14px'
    const openStatement = (id: number): void => {
      // Masters or Opening Balances — Esc on the statement comes back here.
      const from = screen
      setLedgerId(id)
      setLgView('vouchers')
      setScreen('ledger')
      setLgBack(from)
    }

    // ── THE CHART ─────────────────────────────────────────────────────────
    const byId = new Map<number, Row>(groupRows.map((g) => [Number(g.id), g]))
    const groupByName = new Map<string, Row>(groupRows.map((g) => [String(g.name), g]))
    const kids = new Map<number, Row[]>()
    for (const g of groupRows) {
      const k = g.parent_id == null ? 0 : Number(g.parent_id)
      if (!kids.has(k)) kids.set(k, [])
      kids.get(k)!.push(g)
    }
    for (const list of kids.values()) list.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const ledgersOf = new Map<string, Row[]>()
    // A hidden ledger leaves the list (Show hidden brings it back to unhide);
    // its figures still count in every total.
    const hiddenCount = coAccounts.filter((a) => Number(a.is_hidden)).length
    for (const a of coAccounts) {
      if (!mShowHidden && Number(a.is_hidden)) continue
      const k = String(a.acc_group || '').trim()
      if (!ledgersOf.has(k)) ledgersOf.set(k, [])
      ledgersOf.get(k)!.push(a)
    }
    for (const list of ledgersOf.values()) list.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    // A group's ledger count over the ledgers on show — this company's, or
    // every company's — rather than the server's count of the shared list.
    const coCountMemo = new Map<number, number>()
    const coCount = (gid: number, guard = new Set<number>()): number => {
      if (coCountMemo.has(gid)) return coCountMemo.get(gid) as number
      if (guard.has(gid)) return 0
      guard.add(gid)
      const g = byId.get(gid)
      let c = g ? (ledgersOf.get(String(g.name)) || []).length : 0
      for (const k of kids.get(gid) || []) c += coCount(Number(k.id), guard)
      coCountMemo.set(gid, c)
      return c
    }

    // SEARCHING A TREE MEANS KEEPING THE BRANCH, NOT ONLY THE LEAF — every
    // ancestor of a match is kept and opened, so typing walks the chart open to
    // what was typed and clearing it folds back to wherever the reader had it.
    const q = mSearch.trim().toLowerCase()
    // The column funnels narrow the LEDGERS; a group stays while one of its
    // ledgers does, exactly as the search keeps a branch.
    const grpByName = new Map(groupRows.map((g) => [String(g.name), g]))
    const msCf = colFilter<Row>(colF, 'masters', coAccounts as Row[], [
      { key: 'group', get: (a) => a.acc_group },
      { key: 'ledger', get: (a) => a.name },
      { key: 'nature', get: (a) => natOf(grpByName.get(String(a.acc_group || '').trim())?.nature).label },
      { key: 'balance', get: (a) => bal(Number(a.balance) || 0), sort: 'num' }
    ])
    const cfOn = msCf.active > 0
    const allowed = new Set(msCf.rows.map((a) => Number(a.id)))
    const okLedger = (a: Row, g: Row): boolean =>
      (!cfOn || allowed.has(Number(a.id))) &&
      (!q || ledgerNameMatches(g.name, q) || ledgerNameMatches(a.name, q))
    const narrowing = !!q || cfOn
    const keep = new Set<number>()
    if (narrowing) {
      const hit = (g: Row): boolean =>
        cfOn
          ? (ledgersOf.get(String(g.name)) || []).some((a) => okLedger(a, g))
          : ledgerNameMatches(g.name, q) || (ledgersOf.get(String(g.name)) || []).some((a) => ledgerNameMatches(a.name, q))
      for (const g of groupRows) {
        if (!hit(g)) continue
        let cur: Row | undefined = g
        const guard = new Set<number>()
        while (cur && !guard.has(Number(cur.id))) {
          guard.add(Number(cur.id))
          keep.add(Number(cur.id))
          cur = cur.parent_id == null ? undefined : byId.get(Number(cur.parent_id))
        }
      }
    }
    type Line =
      | { kind: 'group'; g: Row; depth: number; open: boolean; empty: boolean }
      | { kind: 'ledger'; a: Row; g: Row; depth: number }
    const lines: Line[] = []
    const walk = (parent: number, depth: number): void => {
      for (const g of kids.get(parent) || []) {
        const id = Number(g.id)
        if (narrowing && !keep.has(id)) continue
        const mine = (ledgersOf.get(String(g.name)) || []).filter((a) => okLedger(a, g))
        const empty = !Number(g.child_groups) && !(ledgersOf.get(String(g.name)) || []).length
        const open = narrowing ? true : !!mOpen[id]
        lines.push({ kind: 'group', g, depth, open, empty })
        if (!open) continue
        // The group's OWN ledgers first, straight under its heading, then its
        // sub-groups. Listed after the sub-groups they sat directly beneath
        // the last one — seven ledgers of Loans (Liability) read as the
        // contents of an empty Unsecured Loans that had no arrow to open.
        for (const a of mine) lines.push({ kind: 'ledger', a, g, depth: depth + 1 })
        walk(id, depth + 1)
      }
    }
    walk(0, 0)
    // THE TOTAL ROW: every ledger, or — while searching — every ledger the
    // search matches (by its own name or its group's, as the tree does),
    // whether or not its group is open. Debit and credit balances added up
    // apart, because netted together a whole book just comes to its trial
    // balance difference.
    const totalSet = (
      q
        ? coAccounts.filter((a) => ledgerNameMatches(a.name, q) || ledgerNameMatches(a.acc_group, q))
        : coAccounts
    ).filter((a) => !cfOn || allowed.has(Number(a.id)))
    const totDr = totalSet.reduce((t, a) => t + Math.max(0, Number(a.balance) || 0), 0)
    const totCr = totalSet.reduce((t, a) => t + Math.max(0, -(Number(a.balance) || 0)), 0)
    // The ledgers on screen, for "Select all shown".
    const shownLedgerIds = lines.filter((l) => l.kind === 'ledger').map((l) => Number((l as { a: Row }).a.id))
    const groupsByPath = [...groupRows].sort((x, y) => String(x.path || x.name).localeCompare(String(y.path || y.name)))
    const deepest = groupRows.reduce((t, g) => Math.max(t, Number(g.depth) || 0), 0)
    const primaries = groupRows.filter((g) => g.parent_id == null)
    // A group and everything under it — so a group is never offered as a new
    // home for itself.
    const branchOf = (id: number): Set<number> => {
      const out = new Set<number>([id])
      const go = (p: number): void => {
        for (const k of kids.get(p) || []) {
          if (out.has(Number(k.id))) continue
          out.add(Number(k.id))
          go(Number(k.id))
        }
      }
      go(id)
      return out
    }

    // ── THE OPENINGS ──────────────────────────────────────────────────────
    const obSetCount = obLive.rows.filter((r) => n(r.dr) > 0.004 || n(r.cr) > 0.004).length
    const obEdits = Object.keys(obEdit).length
    const obBalanced = Math.abs(obLive.difference) < 0.005
    const diffLabel = `${formatINR(Math.abs(obLive.difference))} ${obLive.difference > 0 ? 'Dr' : 'Cr'}`
    const setSide = (r: Row, side: 'dr' | 'cr', v: string): void => {
      const id = Number(r.id)
      const clean = v.replace(/[^0-9.]/g, '')
      setObSavedNote('')
      setObEdit((p) => {
        const cur = p[id] || { dr: n(r.dr) ? String(n(r.dr)) : '', cr: n(r.cr) ? String(n(r.cr)) : '' }
        // A ledger opens on one side only, so typing on one clears the other.
        const next = side === 'dr' ? { dr: clean, cr: clean ? '' : cur.cr } : { cr: clean, dr: clean ? '' : cur.dr }
        // Typed back to what is saved, it is no longer a change — so it
        // leaves the unsaved count rather than being saved again as itself.
        // Compared as text, so a "0." half-way through typing is not taken
        // for the nil it will not be.
        const stored = obRows.find((x) => Number(x.id) === id)
        const asText = (v: unknown): string => (n(v) ? String(n(v)) : '')
        if (next.dr === asText(stored?.dr) && next.cr === asText(stored?.cr)) {
          const rest = { ...p }
          delete rest[id]
          return rest
        }
        return { ...p, [id]: next }
      })
    }
    // The balance a ledger carried INTO the start date, taken as its opening.
    const useBefore = (r: Row): void => {
      const b = Math.round(n(r.before_cutoff) * 100) / 100
      setObSavedNote('')
      setObEdit((p) => ({ ...p, [Number(r.id)]: b > 0 ? { dr: String(b), cr: '' } : { dr: '', cr: String(-b) } }))
    }
    const hints = obLive.rows.filter(
      (r) => Math.abs(n(r.before_cutoff)) > 0.004 && n(r.dr) < 0.005 && n(r.cr) < 0.005
    )
    const obFocusNext = (i: number, side: 'dr' | 'cr', step: number): void => {
      const el = document.querySelector<HTMLInputElement>(`[data-ob="${i + step}-${side}"]`)
      el?.focus()
      el?.select()
    }

    // ── THE STRIP: the two tabs ───────────────────────────────────────────
    const TABS = [
      { k: 'masters' as Screen, label: 'Chart of accounts', icon: FolderTree, key: 'M', count: groupRows.length ? `${groupRows.length} groups` : '…' },
      { k: 'openings' as Screen, label: 'Opening balances', icon: Landmark, key: 'B', count: obRows.length ? `${obSetCount} set` : '…' }
    ].filter((t) => mayScreen(t.k))
    const strip = (
      <div className="sc flex h-12 items-center gap-1.5 overflow-x-auto">
        {TABS.map((t) => {
          const on = screen === t.k
          const Icon = t.icon
          return (
            <button
              key={t.k}
              type="button"
              onClick={() => setScreen(t.k)}
              className="flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[7px] px-[13px]"
              style={{
                background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
                border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
                boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.6),0 6px 16px -6px rgba(199,240,63,.55)' : 'none',
                color: on ? A.frame : '#DCEFE4',
                fontSize: 12,
                fontWeight: 800
              }}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              <span
                style={{
                  ...mono,
                  fontSize: 10,
                  fontWeight: 600,
                  color: on ? A.frame : A.accent,
                  background: on ? 'rgba(11,61,46,.12)' : 'rgba(199,240,63,.1)',
                  borderRadius: 9,
                  padding: '1px 7px'
                }}
              >
                {t.count}
              </span>
              <span
                style={{
                  ...mono,
                  fontSize: 9.5,
                  fontWeight: 600,
                  color: on ? A.frame : A.inkSky,
                  background: on ? 'rgba(11,61,46,.12)' : 'rgba(255,255,255,.07)',
                  borderRadius: 3,
                  padding: '2px 5px'
                }}
              >
                {t.key}
              </span>
            </button>
          )
        })}
        <div className="flex-1" />
        {vw >= 1240 && (
          <div className="flex flex-none items-center gap-[7px] whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: A.inkSky }}>
            <KeyboardIcon className="h-[15px] w-[15px]" />M masters · B openings · Esc closes a form
          </div>
        )}
      </div>
    )

    // ── MASTERS: the tree ─────────────────────────────────────────────────
    const M_GRID = 'minmax(300px,1fr) 110px 90px 190px 168px'
    const actBtn = (
      title: string,
      on: () => void,
      node: ReactNode,
      opts?: { off?: boolean; danger?: boolean }
    ): React.JSX.Element => (
      <button
        type="button"
        title={title}
        // aria-disabled, not disabled — a disabled button shows no tooltip,
        // and the tooltip is the only place that says WHY it cannot be used.
        aria-disabled={opts?.off || undefined}
        onClick={(ev) => {
          ev.stopPropagation()
          if (!opts?.off) on()
        }}
        className={cn(
          'flex h-7 w-7 flex-none items-center justify-center rounded-[6px] border transition-colors',
          opts?.off
            ? 'cursor-not-allowed border-[#EAF0E9] bg-white text-[#C3D2C6]'
            : opts?.danger
              ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E] hover:bg-[#FBE7E5]'
              : 'border-[#DCE7DB] bg-white text-[#33473E] hover:border-[#12855A] hover:bg-[#F3FBE2]'
        )}
      >
        {node}
      </button>
    )
    const toolBtn = (
      label: string,
      on: () => void,
      node: ReactNode,
      primary?: boolean,
      title?: string
    ): React.JSX.Element => (
      <button
        type="button"
        onClick={on}
        title={title}
        className="flex h-9 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[13px] transition-colors"
        style={
          primary
            ? {
                background: 'linear-gradient(180deg,#145A43,#0B3D2E)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12),0 6px 14px -8px rgba(7,43,32,.7)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 800
              }
            : { background: '#fff', border: '1px solid #C3D2C6', color: A.ink, fontSize: 12, fontWeight: 800 }
        }
      >
        {node}
        {label}
      </button>
    )

    const mastersCard = (
      <>
        <div className="flex flex-none flex-wrap items-center gap-[9px]" style={toolbar}>
          <div
            className="flex h-9 items-center gap-2 rounded-[7px] px-2.5"
            style={{
              flex: '1 1 240px',
              maxWidth: 320,
              border: `1px solid ${q ? '#12855A' : '#C3D2C6'}`,
              background: '#fff',
              boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)'
            }}
          >
            <Search className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
            <input
              value={mSearch}
              onChange={(e) => setMSearch(e.target.value)}
              placeholder="Find a group or a ledger"
              className="min-w-0 flex-1 border-0 bg-transparent outline-none"
              style={{ fontSize: 12, fontWeight: 600, color: A.ink }}
            />
            {!!mSearch && (
              <button type="button" onClick={() => setMSearch('')} title="Clear" style={{ color: A.muted }}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {toolBtn(
            'New group',
            () => openMDrawer({ kind: 'group', act: 'new', under: 'Current Liabilities' }),
            <FolderPlus className="h-[17px] w-[17px]" style={{ color: A.accent }} />,
            true
          )}
          {toolBtn('New ledger', () => openMDrawer({ kind: 'ledger', act: 'new', under: 'Sundry Creditors' }), <Plus className="h-[17px] w-[17px]" />)}
          {toolBtn(
            'Tally ledgers',
            () => setTallyOpen(true),
            <FileSpreadsheet className="h-[17px] w-[17px]" />,
            false,
            "Bring Tally's ledger list alongside this book's"
          )}
          <span className="h-[18px] w-px flex-none" style={{ background: '#DCE7DB' }} />
          {scopeToggle}
          <button
            type="button"
            onClick={() => setMOpen(Object.fromEntries(groupRows.map((g) => [Number(g.id), true])))}
            className="h-8 rounded-[6px] px-[9px] hover:bg-[#EEF3EC]"
            style={{ fontSize: 11.5, fontWeight: 700, color: A.muted }}
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setMOpen({})}
            className="h-8 rounded-[6px] px-[9px] hover:bg-[#EEF3EC]"
            style={{ fontSize: 11.5, fontWeight: 700, color: A.muted }}
          >
            Collapse all
          </button>
          {(hiddenCount > 0 || mShowHidden) && (
            <button
              type="button"
              onClick={() => setMShowHidden((v) => !v)}
              className="flex h-8 items-center gap-1.5 rounded-[6px] px-[9px] hover:bg-[#EEF3EC]"
              style={{ fontSize: 11.5, fontWeight: 700, color: mShowHidden ? A.frame : A.muted, background: mShowHidden ? '#F3FBE2' : undefined }}
              title={mShowHidden ? 'Leave the hidden ledgers out of the list again' : 'List the hidden ledgers too, to unhide one'}
            >
              {mShowHidden ? <EyeOff className="h-[15px] w-[15px]" /> : <Eye className="h-[15px] w-[15px]" />}
              {mShowHidden ? 'Hide hidden' : 'Show hidden'} · {hiddenCount}
            </button>
          )}
          <span className="ml-auto whitespace-nowrap" style={{ fontSize: 11.5, fontWeight: 600, color: A.muted }}>
            {groupRows.length} groups · {coAccounts.length} ledgers · {deepest + 1} levels deep
          </span>
        </div>

        {/* SEVERAL LEDGERS AT ONCE — shown while any is ticked. */}
        {mPicked.size > 0 && (
          <div
            className="flex flex-none flex-wrap items-center gap-2"
            style={{ padding: '9px 14px', background: '#F3FBE2', borderBottom: '1px solid #D5EBA8' }}
          >
            <span className="whitespace-nowrap" style={{ fontSize: 12, fontWeight: 800, color: A.frame }}>
              {mPicked.size} ledger{mPicked.size === 1 ? '' : 's'} selected
            </span>
            <button
              type="button"
              disabled={mMoving}
              onClick={() =>
                setMDrawer({
                  kind: 'ledger',
                  act: 'move',
                  id: null,
                  name: '',
                  oldName: `${mPicked.size} ledger${mPicked.size === 1 ? '' : 's'}`,
                  under: '',
                  oldUnder: '',
                  nature: '',
                  oldNature: '',
                  find: '',
                  ids: [...mPicked]
                })
              }
              className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 disabled:opacity-50"
              style={{ background: A.frame, color: '#fff', fontSize: 12, fontWeight: 800 }}
            >
              <FolderInput className="h-[15px] w-[15px]" />
              {mMoving ? 'Moving…' : `Move ${mPicked.size} to a group…`}
            </button>
            <button
              type="button"
              disabled={mMoving}
              onClick={() => void masterSetHidden([...mPicked], true)}
              className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[6px] border bg-white px-3 disabled:opacity-50"
              style={{ borderColor: '#C3D2C6', color: A.ink, fontSize: 12, fontWeight: 800 }}
              title="Leave these ledgers out of the pickers and this list"
            >
              <EyeOff className="h-[15px] w-[15px]" /> Hide {mPicked.size}
            </button>
            {accounts.some((a) => mPicked.has(Number(a.id)) && Number(a.is_hidden)) && (
              <button
                type="button"
                disabled={mMoving}
                onClick={() => void masterSetHidden([...mPicked], false)}
                className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[6px] border bg-white px-3 disabled:opacity-50"
                style={{ borderColor: '#C3D2C6', color: A.ink, fontSize: 12, fontWeight: 800 }}
              >
                <Eye className="h-[15px] w-[15px]" /> Unhide
              </button>
            )}
            <button
              type="button"
              onClick={() => setMPicked(new Set([...mPicked, ...shownLedgerIds]))}
              className="h-8 rounded-[6px] px-[9px] hover:bg-white/70"
              style={{ fontSize: 11.5, fontWeight: 700, color: A.muted }}
              title="Tick every ledger currently on screen"
            >
              Select all shown
            </button>
            <button
              type="button"
              onClick={() => setMPicked(new Set())}
              className="h-8 rounded-[6px] px-[9px] hover:bg-white/70"
              style={{ fontSize: 11.5, fontWeight: 700, color: A.muted }}
            >
              Clear
            </button>
          </div>
        )}

        <div className="sc-both min-h-0 flex-1 overflow-auto">
          <div style={{ minWidth: 860 }}>
            <div className="grid" style={{ ...headRow, gridTemplateColumns: M_GRID }}>
              <span className="flex items-center gap-2" style={{ padding: '0 14px' }}>
                {msCf.head('group', 'Group', { onDark: true })} · {msCf.head('ledger', 'Ledger', { onDark: true })}
              </span>
              <span style={{ padding: '0 10px' }}>{msCf.head('nature', 'Nature', { onDark: true })}</span>
              <span style={{ padding: '0 10px', textAlign: 'right' }}>Ledgers</span>
              <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>{msCf.head('balance', 'Balance', { onDark: true, align: 'end' })}</span>
              <span style={{ padding: '0 12px' }}>Actions</span>
            </div>
            {coAccounts.length > 0 && (
              <div
                className="grid items-center"
                style={{
                  gridTemplateColumns: M_GRID,
                  minHeight: 44,
                  position: 'sticky',
                  top: 34,
                  zIndex: 1,
                  background: '#E8F6C4',
                  borderBottom: '1px solid #CFE59A'
                }}
              >
                <span className="flex items-center gap-2" style={{ padding: '0 14px' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 900, letterSpacing: '.1em', textTransform: 'uppercase', color: A.frame }}>Total</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#4A6B3A' }}>
                    {q ? `ledgers matching “${mSearch.trim()}”` : 'all ledgers'}
                  </span>
                </span>
                <span />
                <span style={{ ...mono, padding: '0 10px', textAlign: 'right', fontSize: 12.5, fontWeight: 800, color: A.frame }}>
                  {totalSet.length}
                </span>
                <span className="flex flex-col items-end" style={{ ...mono, padding: '4px 12px', fontSize: 12, fontWeight: 800, lineHeight: 1.45 }}>
                  <span style={{ color: '#1B4E82' }}>{totDr > 0.005 ? `${formatINR(totDr)} Dr` : 'Dr —'}</span>
                  <span style={{ color: '#8C2F26' }}>{totCr > 0.005 ? `${formatINR(totCr)} Cr` : 'Cr —'}</span>
                </span>
                <span style={{ padding: '0 12px', fontSize: 11, fontWeight: 700, color: '#4A6B3A' }}>
                  {Math.abs(totDr - totCr) < 0.02 ? 'Dr = Cr' : `Net ${bal(totDr - totCr)}`}
                </span>
              </div>
            )}

            {!groupRows.length && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
                Reading the chart of accounts…
              </div>
            )}
            {!!groupRows.length && !lines.length && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
                No group or ledger matches &ldquo;{mSearch.trim()}&rdquo;.
              </div>
            )}

            {lines.map((ln, i) => {
              const zebra = i % 2 ? '#FBFDFA' : '#fff'
              if (ln.kind === 'ledger') {
                const v = Number(ln.a.balance) || 0
                const id = Number(ln.a.id)
                return (
                  <div
                    key={`l${id}`}
                    className="m-row grid items-center"
                    style={{ gridTemplateColumns: M_GRID, minHeight: 40, borderBottom: '1px solid #EFF3EE', background: zebra }}
                  >
                    <div className="flex min-w-0 items-center gap-2" style={{ padding: `6px 10px 6px ${14 + ln.depth * 20}px` }}>
                      <input
                        type="checkbox"
                        checked={mPicked.has(id)}
                        onChange={() =>
                          setMPicked((s) => {
                            const next = new Set(s)
                            if (next.has(id)) next.delete(id)
                            else next.add(id)
                            return next
                          })
                        }
                        title={`Select ${String(ln.a.name)} to move with others`}
                        aria-label={`Select ${String(ln.a.name)}`}
                        className="h-[15px] w-[15px] flex-none cursor-pointer accent-[#0B3D2E]"
                      />
                      <CornerDownRight className="h-4 w-4 flex-none" style={{ color: '#C3D2C6' }} />
                      <FileText className="h-[15px] w-[15px] flex-none" style={{ color: '#8CA396' }} />
                      <button
                        type="button"
                        onClick={() => openStatement(id)}
                        title={`Open the statement of ${String(ln.a.name)}`}
                        className="min-w-0 truncate text-left hover:underline"
                        style={{ fontSize: 12, fontWeight: 600, color: '#33473E' }}
                      >
                        {String(ln.a.name)}
                      </button>
                      {!!Number(ln.a.is_hidden) && (
                        <span
                          className="flex-none"
                          title="Hidden — left out of the ledger pickers and this list"
                          style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#5A6B62', background: '#EEF3EC', border: '1px solid #DCE7DB', borderRadius: 4, padding: '2px 6px' }}
                        >
                          Hidden
                        </span>
                      )}
                      {/* The book the party behind this ledger runs — Trading or
                          Manufacturing — from its customer or supplier master. */}
                      {!!ln.a.business_type &&
                        (() => {
                          const trading = String(ln.a.business_type).toUpperCase().startsWith('T')
                          return (
                            <span
                              className="flex-none"
                              title={`${String(ln.a.business_type)} party`}
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                letterSpacing: '.06em',
                                textTransform: 'uppercase',
                                color: trading ? '#1B4E82' : '#8A5300',
                                background: trading ? '#EAF0FA' : '#FBF3E2',
                                border: `1px solid ${trading ? '#C6DAF0' : '#EAD9AE'}`,
                                borderRadius: 4,
                                padding: '2px 6px'
                              }}
                            >
                              {String(ln.a.business_type)}
                            </span>
                          )
                        })()}
                      {/* A REDIRECT IS NEVER INVISIBLE — postings the app
                          addresses to an older name land here. */}
                      {ledMap
                        .filter((m) => String(m.use_name).trim().toUpperCase() === String(ln.a.name).trim().toUpperCase())
                        .map((m) => (
                          <span
                            key={String(m.id)}
                            title={`The app posts to “${String(m.posts_as)}” and that reaches this ledger${m.note ? ` — ${String(m.note)}` : ''}`}
                            className="flex-none"
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              letterSpacing: '.06em',
                              color: '#1B4E82',
                              background: '#EAF0FA',
                              border: '1px solid #C6DAF0',
                              borderRadius: 4,
                              padding: '2px 6px'
                            }}
                          >
                            ← {String(m.posts_as)}
                          </span>
                        ))}
                    </div>
                    <div style={{ padding: '0 10px' }}>
                      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8CA396' }}>
                        Ledger
                      </span>
                    </div>
                    <span />
                    <span style={{ ...mono, padding: '0 12px', textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: balFg(v) }}>{bal(v)}</span>
                    <div className="flex items-center gap-1" style={{ padding: '0 10px' }}>
                      {actBtn(
                        `Rename ${String(ln.a.name)}`,
                        () => openMDrawer({ kind: 'ledger', act: 'rename', id, name: String(ln.a.name), under: String(ln.g.name) }),
                        <Pencil className="h-[15px] w-[15px]" />
                      )}
                      {actBtn(
                        `Move ${String(ln.a.name)} to another group`,
                        () => openMDrawer({ kind: 'ledger', act: 'move', id, name: String(ln.a.name), under: String(ln.g.name) }),
                        <FolderInput className="h-[15px] w-[15px]" />
                      )}
                      {actBtn(
                        Number(ln.a.is_hidden) ? `Unhide ${String(ln.a.name)}` : `Hide ${String(ln.a.name)} from the pickers and this list`,
                        () => void masterSetHidden([id], !Number(ln.a.is_hidden)),
                        Number(ln.a.is_hidden) ? <Eye className="h-[15px] w-[15px]" /> : <EyeOff className="h-[15px] w-[15px]" />
                      )}
                    </div>
                  </div>
                )
              }
              const g = ln.g
              const gid = Number(g.id)
              const nat = natOf(g.nature)
              const total = Number(g.total_balance) || 0
              const cnt = ledScopeKnown ? coCount(Number(g.id)) : Number(g.total_ledgers) || 0
              const direct = Number(g.ledgers) || 0
              const primary = ln.depth === 0
              const system = !!Number(g.is_system)
              const hasKids = !!Number(g.child_groups) || direct > 0
              return (
                <div
                  key={`g${gid}`}
                  className="m-row grid items-center"
                  style={{
                    gridTemplateColumns: M_GRID,
                    minHeight: 40,
                    borderBottom: '1px solid #EFF3EE',
                    background: primary ? 'linear-gradient(180deg,#F6FAF4,#EFF5EC)' : zebra
                  }}
                >
                  <button
                    type="button"
                    onClick={() => !ln.empty && setMOpen((o) => ({ ...o, [gid]: !o[gid] }))}
                    className="flex min-w-0 items-center gap-2 text-left"
                    style={{ padding: `6px 10px 6px ${10 + ln.depth * 20}px`, cursor: ln.empty ? 'default' : 'pointer' }}
                    title={String(g.path || g.name)}
                  >
                    {ln.empty ? (
                      <span className="flex h-[17px] w-[17px] flex-none items-center justify-center" style={{ color: '#DCE7DB', fontWeight: 800 }}>
                        –
                      </span>
                    ) : (
                      <ChevronRight
                        className="h-[17px] w-[17px] flex-none transition-transform"
                        style={{ color: A.muted, transform: ln.open ? 'rotate(90deg)' : 'none' }}
                      />
                    )}
                    {ln.open && !ln.empty ? (
                      <FolderOpen className="h-4 w-4 flex-none" style={{ color: primary ? A.frame : '#12855A' }} />
                    ) : (
                      <Folder className="h-4 w-4 flex-none" style={{ color: primary ? A.frame : '#12855A' }} />
                    )}
                    <span className="min-w-0 truncate" style={{ fontSize: primary ? 13 : 12.5, fontWeight: primary ? 800 : 700, color: A.ink }}>
                      {String(g.name)}
                    </span>
                    {!system && (
                      <span
                        className="flex-none"
                        style={{
                          fontSize: 9,
                          fontWeight: 800,
                          letterSpacing: '.08em',
                          color: '#0B6B45',
                          background: '#E9F5EE',
                          border: '1px solid #BFE3CB',
                          borderRadius: 4,
                          padding: '2px 6px'
                        }}
                      >
                        YOURS
                      </span>
                    )}
                  </button>
                  <div style={{ padding: '0 10px' }}>
                    <span
                      className="whitespace-nowrap"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 800,
                        letterSpacing: '.06em',
                        textTransform: 'uppercase',
                        color: nat.fg,
                        background: nat.bg,
                        border: `1px solid ${nat.bd}`,
                        borderRadius: 4,
                        padding: '3px 7px'
                      }}
                    >
                      {nat.label}
                    </span>
                  </div>
                  <span
                    title={cnt === direct ? undefined : `${direct} directly under it, ${cnt} counting the groups below`}
                    style={{ ...mono, padding: '0 10px', textAlign: 'right', fontSize: 12, fontWeight: 600, color: cnt ? '#33473E' : '#C3D2C6' }}
                  >
                    {cnt || DASH}
                  </span>
                  <span
                    title="Everything under this group, its sub-groups included"
                    style={{ ...mono, padding: '0 12px', textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: cnt ? balFg(total) : '#C3D2C6' }}
                  >
                    {cnt ? bal(total) : DASH}
                  </span>
                  <div className="flex items-center gap-1" style={{ padding: '0 10px' }}>
                    {actBtn(
                      `New group under ${String(g.name)}`,
                      () => openMDrawer({ kind: 'group', act: 'new', under: String(g.name) }),
                      <FolderPlus className="h-[15px] w-[15px]" />
                    )}
                    {actBtn(
                      `New ledger under ${String(g.name)}`,
                      () => openMDrawer({ kind: 'ledger', act: 'new', under: String(g.name) }),
                      <Plus className="h-[15px] w-[15px]" />
                    )}
                    {actBtn(
                      `Rename ${String(g.name)}`,
                      () => openMDrawer({ kind: 'group', act: 'rename', id: gid, name: String(g.name), under: String(g.parent || '') }),
                      <Pencil className="h-[15px] w-[15px]" />
                    )}
                    {actBtn(
                      `Move ${String(g.name)} under another group`,
                      () =>
                        openMDrawer({
                          kind: 'group',
                          act: 'move',
                          id: gid,
                          name: String(g.name),
                          under: String(g.parent || ''),
                          nature: String(g.nature || 'asset')
                        }),
                      <FolderInput className="h-[15px] w-[15px]" />
                    )}
                    {actBtn(
                      system
                        ? `${String(g.name)} is one of the standard groups — it can be added to, but not deleted`
                        : hasKids
                          ? `Empty ${String(g.name)} before deleting it`
                          : `Delete ${String(g.name)}`,
                      () => void masterDeleteGroup(g),
                      system ? <LockIcon className="h-[15px] w-[15px]" /> : <Trash2 className="h-[15px] w-[15px]" />,
                      { off: system || hasKids, danger: !system && !hasKids }
                    )}
                  </div>
                </div>
              )
            })}

            <div className="flex items-start gap-[9px]" style={{ padding: '12px 14px', background: '#FBFDFA', borderTop: '1px solid #EAF0E9' }}>
              <Info className="h-4 w-4 flex-none" style={{ color: '#8CA396' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: A.muted, lineHeight: 1.6, textWrap: 'pretty' }}>
                A group takes its side of the books from whichever primary it ultimately sits under, so a sub-group made
                under <b>Current Liabilities</b> is a liability without being told. A group&apos;s figure is everything
                beneath it. The fifteen primaries and the standard sub-groups cannot be deleted. Renaming a ledger writes a
                redirect, so postings the app addresses to the old name follow the ledger — an <b>← OLD NAME</b> mark
                shows one.
              </span>
            </div>
          </div>
        </div>
      </>
    )

    // The trial balance, for the rail: does every ledger added up agree?
    const mTbTotals = (mTb?.totals as Row | undefined) || null
    const mTbDiff = mTbTotals ? Math.round((n(mTbTotals.closing_dr) - n(mTbTotals.closing_cr)) * 100) / 100 : 0
    const mTbOk = !!mTbTotals && Math.abs(mTbDiff) < 0.02
    const natTotals = (['asset', 'liability', 'income', 'expense'] as const).map((k) => ({
      k,
      v: primaries.filter((g) => String(g.nature) === k).reduce((t, g) => t + (Number(g.total_balance) || 0), 0),
      groups: groupRows.filter((g) => String(g.nature) === k).length
    }))
    const natMax = Math.max(1, ...natTotals.map((x) => Math.abs(x.v)))

    const mastersRail = (
      <>
        <div
          className="relative flex-none overflow-hidden"
          style={{
            borderRadius: 12,
            background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 16px 34px -16px rgba(7,43,32,.7)',
            padding: 18,
            color: '#fff'
          }}
        >
          <div
            className="pointer-events-none absolute"
            style={{ top: -60, right: -60, width: 180, height: 180, borderRadius: '50%', background: 'radial-gradient(circle,rgba(199,240,63,.18),transparent 70%)' }}
          />
          <div className="relative" style={{ ...kicker, color: '#8FBFA8' }}>
            Chart of accounts
          </div>
          <div className="relative mt-3 grid grid-cols-3 gap-2">
            {[
              { k: 'Primaries', v: primaries.length },
              { k: 'Groups', v: groupRows.length },
              { k: 'Ledgers', v: coAccounts.length }
            ].map((c) => (
              <div key={c.k} style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, padding: '9px 10px' }}>
                <div style={{ ...mono, fontSize: 18, fontWeight: 700, color: A.accent }}>{c.v}</div>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: '#8FBFA8', marginTop: 3 }}>{c.k}</div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setScreen('trial')}
            title="Open the trial balance"
            className="relative mt-3.5 flex w-full items-center gap-2 text-left"
            style={{
              background: !mTbTotals ? 'rgba(255,255,255,.06)' : mTbOk ? 'rgba(199,240,63,.12)' : 'rgba(240,175,170,.16)',
              border: `1px solid ${!mTbTotals ? 'rgba(255,255,255,.1)' : mTbOk ? 'rgba(199,240,63,.3)' : 'rgba(240,175,170,.4)'}`,
              borderRadius: 8,
              padding: '9px 11px'
            }}
          >
            {mTbOk ? (
              <CircleCheck className="h-[17px] w-[17px] flex-none" style={{ color: A.accent }} />
            ) : (
              <CircleAlert className="h-[17px] w-[17px] flex-none" style={{ color: mTbTotals ? '#F4C3BE' : '#8FBFA8' }} />
            )}
            <span style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.4, color: !mTbTotals ? '#A9CDBB' : mTbOk ? A.accent : '#F4C3BE' }}>
              {!mTbTotals
                ? 'Reading the trial balance…'
                : mTbOk
                  ? 'Every ledger added up, Dr equals Cr — the chart balances.'
                  : `The trial balance is ${bal(mTbDiff)} out — check the opening balances.`}
            </span>
          </button>
        </div>

        <div className="flex-none overflow-hidden" style={card}>
          <div className="flex items-center gap-[9px]" style={{ padding: '12px 15px', borderBottom: '1px solid #EAF0E9' }}>
            <PieChart className="h-[17px] w-[17px]" style={{ color: A.frame }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>By nature</span>
          </div>
          <div className="flex flex-col gap-[11px]" style={{ padding: '6px 15px 14px' }}>
            {natTotals.map((x) => {
              const t = NAT[x.k]
              return (
                <div key={x.k}>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2.5">
                    <span className="flex items-center gap-[7px]" style={{ fontSize: 11.5, fontWeight: 800 }}>
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: t.fg }} />
                      {t.label}
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: A.muted }}>
                        {x.groups} {x.groups === 1 ? 'group' : 'groups'}
                      </span>
                    </span>
                    <span className="whitespace-nowrap" style={{ ...mono, fontSize: 11.5, fontWeight: 700, color: balFg(x.v) }}>
                      {bal(x.v)}
                    </span>
                  </div>
                  <div className="mt-[5px] h-1.5 overflow-hidden rounded-[3px]" style={{ background: '#EEF3EC' }}>
                    <div className="h-full rounded-[3px]" style={{ width: `${(Math.abs(x.v) / natMax) * 100}%`, background: t.bar }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </>
    )

    // ── OPENINGS: the sheet ───────────────────────────────────────────────
    // A funnel on every column, offered from what the search leaves.
    const obCf = colFilter(colF, 'openings', obVisible, [
      { key: 'ledger', get: (r) => r.name },
      { key: 'under', get: (r) => r.acc_group },
      { key: 'dr', get: (r) => (n(r.dr) > 0.004 ? formatINR(n(r.dr)) : DASH), sort: 'num' },
      { key: 'cr', get: (r) => (n(r.cr) > 0.004 ? formatINR(n(r.cr)) : DASH), sort: 'num' },
      { key: 'since', get: (r) => (Math.abs(n(r.movement)) < 0.005 ? DASH : bal(n(r.movement))), sort: 'num' },
      { key: 'before', get: (r) => (Math.abs(n(r.before_cutoff)) < 0.005 ? DASH : bal(n(r.before_cutoff))), sort: 'num' }
    ])
    const obShown = obCf.rows
    const O_GRID = 'minmax(190px,1.2fr) minmax(130px,.8fr) 150px 150px 150px 190px'
    const openingsCard = (
      <>
        <div className="flex flex-none flex-wrap items-center gap-2.5" style={toolbar}>
          {/* THE DATE THE OPENINGS ARE STRUCK ON — nothing before it is this
              company's accounts, and the entered opening stands in its place. */}
          <div className="flex flex-none items-center gap-2">
            <span className="whitespace-nowrap" style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: A.muted }}>
              Books begin
            </span>
            <div
              className="flex h-9 items-center gap-1.5 rounded-[7px] pl-2.5 pr-1.5"
              style={{ border: `1px solid ${obFrom ? '#C3D2C6' : '#E3C58C'}`, background: '#fff' }}
            >
              <CalendarDays className="h-[17px] w-[17px] flex-none" style={{ color: obFrom ? '#12855A' : '#B07400' }} />
              <div className="w-[112px] [&_button]:!h-7 [&_button]:!w-full [&_button]:!justify-start [&_button]:!rounded-[4px] [&_button]:!border-0 [&_button]:!bg-transparent [&_button]:!px-0 [&_button]:!font-mono [&_button]:!text-[12px] [&_button]:!font-bold [&_button]:!text-[#0A1F17] [&_button_svg]:!hidden">
                <DatePicker value={obFrom} onChange={(v) => void saveBooksFrom(v || '')} />
              </div>
              {!!obFrom && (
                <button
                  type="button"
                  title="Run the books from the beginning"
                  onClick={() => {
                    if (confirm('Run the books from the beginning?\n\nWith no start date the ledgers show every entry ever made, and the opening figures here are ignored until a date is set again.'))
                      void saveBooksFrom('')
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-[4px] hover:bg-[#EEF3EC]"
                  style={{ color: A.muted }}
                >
                  <X className="h-[15px] w-[15px]" />
                </button>
              )}
            </div>
          </div>
          <div
            className="flex h-9 items-center gap-2 rounded-[7px] px-2.5"
            style={{ flex: '1 1 200px', maxWidth: 280, border: `1px solid ${obQuery.trim() ? '#12855A' : '#C3D2C6'}`, background: '#fff', boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)' }}
          >
            <Search className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
            <input
              value={obQuery}
              onChange={(e) => setObQuery(e.target.value)}
              placeholder="Find a ledger or group"
              className="min-w-0 flex-1 border-0 bg-transparent outline-none"
              style={{ fontSize: 12, fontWeight: 600, color: A.ink }}
            />
            {!!obQuery && (
              <button type="button" onClick={() => setObQuery('')} title="Clear" style={{ color: A.muted }}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setObOnlySet((v) => !v)}
            className="flex h-9 flex-none items-center gap-[9px] whitespace-nowrap rounded-[7px] px-[11px]"
            style={{ border: '1px solid #DCE7DB', background: '#fff', fontSize: 11.5, fontWeight: 700, color: '#33473E' }}
          >
            <span
              className="flex h-[18px] w-[30px] rounded-[9px] p-0.5 transition-colors"
              style={{ background: obOnlySet ? '#12855A' : '#C3D2C6', justifyContent: obOnlySet ? 'flex-end' : 'flex-start' }}
            >
              <span className="h-3.5 w-3.5 rounded-full bg-white" />
            </span>
            Only with a figure
          </button>
          {scopeToggle}
          <div className="flex-1" />
          <div
            title={obBalanced ? 'Debits and credits agree' : 'Debits and credits do not agree — this is what is still unaccounted for'}
            className="flex h-9 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3"
            style={{
              background: obBalanced ? '#E9F5EE' : 'linear-gradient(180deg,#FFF6E2,#FDEBC4)',
              border: `1px solid ${obBalanced ? '#BFE3CB' : '#E8C47C'}`,
              color: obBalanced ? '#0B6B45' : '#7A4E00',
              fontSize: 12,
              fontWeight: 800
            }}
          >
            {obBalanced ? <CircleCheck className="h-[17px] w-[17px]" /> : <CircleAlert className="h-[17px] w-[17px]" />}
            {obBalanced ? 'Balanced' : `Difference ${diffLabel}`}
          </div>
          <button
            type="button"
            disabled={obSaving || !obEdits}
            onClick={() => void saveOpenings()}
            title={obEdits ? 'Save the openings you have changed' : 'Nothing has been changed yet'}
            className="flex h-9 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[15px]"
            style={{
              background: obEdits ? 'linear-gradient(180deg,#145A43,#0B3D2E)' : '#DCE7DB',
              boxShadow: obEdits ? '0 8px 18px -10px rgba(7,43,32,.8)' : 'none',
              color: obEdits ? '#fff' : '#8CA396',
              fontSize: 12,
              fontWeight: 800,
              cursor: obEdits ? 'pointer' : 'not-allowed'
            }}
          >
            <Save className="h-[17px] w-[17px]" />
            {obSaving ? 'Saving…' : obEdits ? `Save (${obEdits})` : 'Save'}
          </button>
        </div>

        {!obFrom && (
          <div
            className="flex flex-none items-start gap-[9px]"
            style={{ padding: '10px 16px', background: 'linear-gradient(180deg,#FFF9EC,#FFF3DA)', borderBottom: '1px solid #F1D9A6' }}
          >
            <TriangleAlert className="h-[17px] w-[17px] flex-none" style={{ color: '#B07400' }} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#7A4E00', lineHeight: 1.5, textWrap: 'pretty' }}>
              No start date is set, so the ledgers show every entry ever made and these figures are ignored. Set{' '}
              <b>Books begin</b> above to bring them into effect.
            </span>
          </div>
        )}

        {obPicked.size > 0 && (
          <div
            className="flex flex-none flex-wrap items-center gap-2.5"
            style={{ padding: '9px 14px', background: 'linear-gradient(180deg,#FFF9EC,#FFF4DD)', borderBottom: '1px solid #F1E6CC' }}
          >
            <ArrowLeftRight className="h-4 w-4 flex-none" style={{ color: '#8A5300' }} />
            <span style={{ fontSize: 12, fontWeight: 800, color: '#5C3B00' }}>
              {obPicked.size} {obPicked.size === 1 ? 'ledger' : 'ledgers'} ticked
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#8A5300' }}>Move their openings to</span>
            <select
              value={obMoveTo || ''}
              onChange={(ev) => setObMoveTo(Number(ev.target.value) || 0)}
              className="h-8 rounded-[6px] border bg-white px-2 outline-none"
              style={{ borderColor: '#E8C47C', fontSize: 12, fontWeight: 700, color: A.ink }}
            >
              <option value="">Pick the company…</option>
              {companies
                .filter((cm) => Number(cm.id) !== cid)
                .map((cm) => (
                  <option key={String(cm.id)} value={String(cm.id)}>
                    {String(cm.name)}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!obMoveTo}
              onClick={() => {
                const to = obMoveTo || Number(companies.find((cm) => Number(cm.id) !== cid)?.id) || 0
                if (!to) return
                setObMove({ to, target: null, saving: false })
                void window.api.journal
                  .openings(to)
                  .then((r) => setObMove((m) => (m && m.to === to ? { ...m, target: ((r?.rows as Row[]) || []) } : m)))
                  .catch((err) => {
                    toast.error(errText(err))
                    setObMove(null)
                  })
              }}
              className="h-8 rounded-[6px] px-3 disabled:opacity-40"
              style={{ background: 'linear-gradient(180deg,#145A43,#0B3D2E)', color: '#C7F03F', fontSize: 12, fontWeight: 800 }}
            >
              Review the move
            </button>
            <button type="button" onClick={() => setObPicked(new Set())} className="h-8 px-2" style={{ fontSize: 11.5, fontWeight: 800, color: '#8A5300' }}>
              Clear
            </button>
          </div>
        )}

        {obMove &&
          (() => {
            const toName = String(companies.find((cm) => Number(cm.id) === obMove.to)?.name || 'the other company')
            const fromName = String(company?.name || 'this company')
            const saved = new Map(obRows.map((r) => [Number(r.id), r]))
            const tgt = new Map(((obMove.target || []) as Row[]).map((r) => [Number(r.id), r]))
            const netOf = (r?: Row): number => (r ? n(r.dr) - n(r.cr) : 0)
            const dc = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`)
            const lines = [...obPicked].map((id) => {
              const s = saved.get(id)
              const moving = netOf(s)
              const had = netOf(tgt.get(id))
              return { id, name: String(s?.name || accounts.find((a) => Number(a.id) === id)?.name || `#${id}`), moving, had, now: moving + had, unsaved: !!obEdit[id] }
            })
            const unsaved = lines.filter((l) => l.unsaved)
            const nothing = lines.filter((l) => Math.abs(l.moving) < 0.005)
            // ALREADY HELD THERE: refused, not added — the other company's own
            // figure has to be cleared first. Left out of the move.
            const clash = lines.filter((l) => Math.abs(l.moving) >= 0.005 && !l.unsaved && Math.abs(l.had) >= 0.005)
            const go = lines.filter((l) => Math.abs(l.moving) >= 0.005 && !l.unsaved && Math.abs(l.had) < 0.005)
            const blocked = (l: (typeof lines)[number]): boolean => l.unsaved || Math.abs(l.moving) < 0.005 || Math.abs(l.had) >= 0.005
            const M_GRID2 = 'minmax(0,1fr) 150px 150px 150px'
            return (
              <div role="dialog" aria-modal="true" aria-label="Move openings" className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: 'rgba(7,30,22,.42)' }}>
                <div className="flex max-h-[86vh] w-[min(100%,760px)] flex-col overflow-hidden rounded-[10px] bg-[#F4F7F2] shadow-[0_24px_60px_rgba(10,31,23,.35)]">
                  <div className="flex-none px-5 py-4 text-white" style={{ background: 'linear-gradient(160deg,#145A43,#0B3D2E)' }}>
                    <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Move opening balances</div>
                    <div className="mt-1 text-[17px] font-extrabold">
                      {fromName} <span className="text-[#C7F03F]">→</span> {toName}
                    </div>
                    <div className="mt-1 text-[11.5px] font-semibold text-[#8FBFA8]">
                      Each opening comes off {fromName} and goes to {toName}. A ledger {toName} already holds an opening for does not move.
                    </div>
                  </div>
                  <div className="sc min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    {!obMove.target ? (
                      <div className="py-10 text-center text-[12px] font-semibold text-[#5A6B62]">Reading {toName}&rsquo;s openings…</div>
                    ) : (
                      <div className="overflow-hidden rounded-[8px] border border-[#DCE7DB] bg-white">
                        <div className="grid items-center bg-[#0B3D2E]" style={{ gridTemplateColumns: M_GRID2 }}>
                          {['Ledger', 'Moving', `${toName.split(' ').slice(0, 2).join(' ')} has`, 'Will have'].map((h, hi) => (
                            <span key={h} className="px-3 py-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FBFA8]" style={{ textAlign: hi ? 'right' : 'left' }}>
                              {h}
                            </span>
                          ))}
                        </div>
                        {lines.map((l) => (
                          <div
                            key={l.id}
                            className="grid items-center border-t border-[#EEF3EC]"
                            style={{ gridTemplateColumns: M_GRID2, opacity: l.unsaved || Math.abs(l.moving) < 0.005 ? 0.5 : 1, background: !l.unsaved && Math.abs(l.moving) >= 0.005 && Math.abs(l.had) >= 0.005 ? '#FDF3F2' : undefined }}
                          >
                            <span className="min-w-0 px-3 py-2 text-[12px] font-bold text-[#0A1F17] [overflow-wrap:anywhere]">
                              {l.name}
                              {l.unsaved && <span className="ml-1.5 text-[10.5px] font-bold text-[#B3261E]">· unsaved change — save first</span>}
                              {!l.unsaved && Math.abs(l.moving) < 0.005 && <span className="ml-1.5 text-[10.5px] font-bold text-[#8CA396]">· nothing to move</span>}
                              {!l.unsaved && Math.abs(l.moving) >= 0.005 && Math.abs(l.had) >= 0.005 && (
                                <span className="ml-1.5 text-[10.5px] font-bold text-[#B3261E]">· already has an opening in {toName.split(' ').slice(0, 2).join(' ')} — clear it there first</span>
                              )}
                            </span>
                            <span className="doc-ref px-3 py-2 text-right text-[12px] font-bold text-[#8A5300]">{dc(l.moving)}</span>
                            <span className="doc-ref px-3 py-2 text-right text-[12px] font-semibold" style={{ color: Math.abs(l.had) >= 0.005 ? '#B3261E' : '#8CA396' }}>{dc(l.had)}</span>
                            <span className="doc-ref px-3 py-2 text-right text-[12.5px] font-bold text-[#0B3D2E]">{blocked(l) ? '—' : dc(l.now)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {!!obMove.target && clash.length > 0 && (
                      <p className="mt-3 rounded-[6px] border border-[#F0D6D4] bg-[#FDF3F2] px-3 py-2 text-[11.5px] font-semibold text-[#8C2F26]">
                        {clash.length} {clash.length === 1 ? 'ledger already has' : 'ledgers already have'} an opening in {toName}, so {clash.length === 1 ? 'it stays' : 'they stay'} here. Clear {toName}&rsquo;s figure first if this one is the right one, then move it.
                      </p>
                    )}
                    {unsaved.length > 0 && (
                      <p className="mt-3 rounded-[6px] border border-[#F1D9A6] bg-[#FFF4DD] px-3 py-2 text-[11.5px] font-semibold text-[#6B4200]">
                        {unsaved.length} ticked {unsaved.length === 1 ? 'ledger has' : 'ledgers have'} a change not saved yet — save or undo it first; {unsaved.length === 1 ? 'it is' : 'they are'} left out of this move.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-none items-center gap-2.5 border-t border-[#DCE7DB] bg-white px-5 py-3">
                    <span className="min-w-0 flex-1 text-[11.5px] font-bold text-[#5A6B62]">
                      {go.length} {go.length === 1 ? 'opening' : 'openings'} will move
                      {clash.length ? ` · ${clash.length} held there already` : ''}
                      {nothing.length ? ` · ${nothing.length} with nothing to move` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={obMove.saving}
                      onClick={() => setObMove(null)}
                      className="h-9 rounded-[6px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!obMove.target || !go.length || obMove.saving}
                      onClick={async () => {
                        if (!rightsIn('accountsOpenings').edit) return void toast.error('You do not have rights to change Opening Balances')
                        setObMove((m) => (m ? { ...m, saving: true } : m))
                        try {
                          const res = await window.api.journal.moveOpenings(go.map((l) => l.id), cid, obMove.to)
                          toast.success(`Moved ${res.moved} ${res.moved === 1 ? 'opening' : 'openings'} to ${toName}`)
                          setObPicked(new Set())
                          setObMove(null)
                          await loadOpenings()
                        } catch (err) {
                          toast.error(errText(err))
                          setObMove((m) => (m ? { ...m, saving: false } : m))
                        }
                      }}
                      className="flex h-9 items-center gap-2 rounded-[6px] px-4 text-[12px] font-extrabold disabled:opacity-40"
                      style={{ background: 'linear-gradient(180deg,#145A43,#0B3D2E)', color: '#C7F03F' }}
                    >
                      <ArrowLeftRight className="h-4 w-4" />
                      {obMove.saving ? 'Moving…' : `Move ${go.length} to ${toName.split(' ').slice(0, 2).join(' ')}`}
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

        <div className="sc-both relative min-h-0 flex-1 overflow-auto">
          <div style={{ minWidth: 960 }}>
            <div className="grid" style={{ ...headRow, gridTemplateColumns: O_GRID }}>
              <span className="flex items-center gap-2" style={{ padding: '0 14px' }}>
                {(() => {
                  const movable = obShown.filter((r) => n(r.dr) > 0.004 || n(r.cr) > 0.004).map((r) => Number(r.id))
                  const all = movable.length > 0 && movable.every((id) => obPicked.has(id))
                  return (
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={!movable.length}
                      onChange={() =>
                        setObPicked((prev) => {
                          const next = new Set(prev)
                          if (all) for (const id of movable) next.delete(id)
                          else for (const id of movable) next.add(id)
                          return next
                        })
                      }
                      title={all ? 'Untick every ledger shown' : 'Tick every ledger shown that has an opening — to move them to the other company'}
                      aria-label="Tick every ledger with an opening"
                      className="h-[15px] w-[15px] flex-none cursor-pointer accent-[#C7F03F]"
                    />
                  )
                })()}
                {obCf.head('ledger', 'Ledger', { onDark: true })}
              </span>
              <span style={{ padding: '0 10px' }}>{obCf.head('under', 'Under', { onDark: true })}</span>
              <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end', color: '#B9D3F0' }}>{obCf.head('dr', 'Opening Dr', { onDark: true, align: 'end' })}</span>
              <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end', color: '#F0C4BF' }}>{obCf.head('cr', 'Opening Cr', { onDark: true, align: 'end' })}</span>
              <span title="What this ledger has recorded from the start date onward" style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>
                {obCf.head('since', 'Since start', { onDark: true, align: 'end' })}
              </span>
              <span
                title="What this ledger holds before the start date — excluded from the books, and what your opening figure stands in for"
                style={{ padding: '0 14px', display: 'flex', justifyContent: 'flex-end' }}
              >
                {obCf.head('before', 'Before start', { onDark: true, align: 'end' })}
              </span>
            </div>

            {!obRows.length && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
                Reading the opening balances…
              </div>
            )}
            {!!obRows.length && !obShown.length && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>No ledger matches.</div>
            )}

            {obShown.map((r, i) => {
              const id = Number(r.id)
              const e = obEdit[id]
              const dr = n(r.dr)
              const cr = n(r.cr)
              const mov = n(r.movement)
              const before = n(r.before_cutoff)
              const raw = (side: 'dr' | 'cr'): string => (e ? e[side] : n(r[side]) ? String(n(r[side])) : '')
              // Grouped while blurred, raw while typing, so the size reads at a glance.
              const shown = (side: 'dr' | 'cr'): string => {
                const v = raw(side)
                return obFocus === `${id}${side}` ? v : n(v) ? grp(n(v)) : ''
              }
              const canUse = Math.abs(before) > 0.004 && dr < 0.005 && cr < 0.005
              const box = (side: 'dr' | 'cr'): React.JSX.Element => {
                const has = side === 'dr' ? dr > 0.004 : cr > 0.004
                return (
                  <div style={{ padding: '0 8px' }}>
                    <input
                      inputMode="decimal"
                      data-ob={`${i}-${side}`}
                      value={shown(side)}
                      placeholder="—"
                      onChange={(ev) => setSide(r, side, ev.target.value)}
                      onFocus={(ev) => {
                        setObFocus(`${id}${side}`)
                        const el = ev.target
                        requestAnimationFrame(() => el.select())
                      }}
                      onBlur={() => setObFocus(null)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
                          ev.preventDefault()
                          obFocusNext(i, side, 1)
                        } else if (ev.key === 'ArrowUp') {
                          ev.preventDefault()
                          obFocusNext(i, side, -1)
                        }
                      }}
                      className="w-full outline-none focus:!border-[#0B3D2E] focus:shadow-[0_0_0_2px_rgba(199,240,63,.45)]"
                      style={{
                        ...mono,
                        height: 32,
                        border: `1px solid ${has ? (side === 'dr' ? '#9EC2EA' : '#E7A7A0') : '#DCE7DB'}`,
                        borderRadius: 6,
                        padding: '0 9px',
                        textAlign: 'right',
                        fontSize: 12,
                        fontWeight: 700,
                        background: has ? (side === 'dr' ? '#F5F8FD' : '#FDF7F6') : '#fff',
                        color: side === 'dr' ? '#1B4E82' : '#8C2F26'
                      }}
                    />
                  </div>
                )
              }
              return (
                <div
                  key={id}
                  className="grid items-center"
                  style={{
                    gridTemplateColumns: O_GRID,
                    minHeight: 44,
                    borderBottom: '1px solid #EFF3EE',
                    background: e ? '#FFFBF1' : i % 2 ? '#FBFDFA' : '#fff',
                    boxShadow: e ? 'inset 3px 0 0 #C2700A' : 'none'
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2" style={{ padding: '0 14px' }}>
                    <input
                      type="checkbox"
                      checked={obPicked.has(id)}
                      disabled={!(dr > 0.004 || cr > 0.004)}
                      onChange={() =>
                        setObPicked((prev) => {
                          const next = new Set(prev)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                      title={dr > 0.004 || cr > 0.004 ? `Tick ${String(r.name)} to move its opening to the other company` : 'No opening here to move'}
                      aria-label={`Tick ${String(r.name)}`}
                      className="h-[15px] w-[15px] flex-none cursor-pointer accent-[#0B3D2E] disabled:cursor-default disabled:opacity-30"
                    />
                    <button
                      type="button"
                      onClick={() => openStatement(id)}
                      title={`Open the statement of ${String(r.name)}`}
                      className="min-w-0 truncate text-left hover:underline"
                      style={{ fontSize: 12, fontWeight: 800, color: A.ink }}
                    >
                      {String(r.name)}
                    </button>
                    {!!e && <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: '#C2700A' }} title="Changed, not saved" />}
                  </div>
                  <span className="truncate" style={{ padding: '0 10px', fontSize: 11, fontWeight: 600, color: A.muted }}>
                    {String(r.acc_group || '')}
                  </span>
                  {box('dr')}
                  {box('cr')}
                  <span style={{ ...mono, padding: '0 12px', textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: Math.abs(mov) < 0.005 ? '#C3D2C6' : A.muted }}>
                    {Math.abs(mov) < 0.005 ? DASH : bal(mov)}
                  </span>
                  <div className="flex items-center justify-end gap-[7px]" style={{ padding: '0 14px' }}>
                    <span
                      style={{
                        ...mono,
                        fontSize: 11.5,
                        fontWeight: Math.abs(before) < 0.005 ? 500 : 700,
                        color: Math.abs(before) < 0.005 ? '#C3D2C6' : '#1B4E82'
                      }}
                    >
                      {Math.abs(before) < 0.005 ? DASH : bal(before)}
                    </span>
                    {canUse && (
                      <button
                        type="button"
                        onClick={() => useBefore(r)}
                        title="Take the pre-start total as this ledger's opening"
                        className="flex h-6 items-center gap-[3px] whitespace-nowrap rounded-[5px] px-[7px]"
                        style={{ background: '#EAF0FA', border: '1px solid #C6DAF0', color: '#1B4E82', fontSize: 10, fontWeight: 800 }}
                      >
                        <ArrowDownLeft className="h-[13px] w-[13px]" />
                        USE
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            <div
              className="sticky bottom-0 z-[2] grid items-center"
              style={{ gridTemplateColumns: O_GRID, minHeight: 44, borderTop: '1px solid #BFE3CB', background: 'linear-gradient(180deg,#F1F9F3,#E6F4EA)' }}
            >
              <span style={{ gridColumn: 'span 2', padding: '0 14px', fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: '#0B6B45' }}>
                TOTAL · {obShown.length} {obShown.length === 1 ? 'LEDGER' : 'LEDGERS'}
              </span>
              <span style={{ ...mono, padding: '0 17px', textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: '#1B4E82' }}>{formatINR(obLive.dr)}</span>
              <span style={{ ...mono, padding: '0 17px', textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: '#8C2F26' }}>{formatINR(obLive.cr)}</span>
              <span
                className="whitespace-nowrap"
                style={{ gridColumn: 'span 2', padding: '0 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: obSavedNote && !obEdits ? '#0B6B45' : '#8A5300' }}
              >
                {obEdits ? `${obEdits} unsaved` : obSavedNote}
              </span>
            </div>
          </div>
        </div>
      </>
    )

    const drPct = obLive.dr + obLive.cr > 0 ? (obLive.dr / (obLive.dr + obLive.cr)) * 100 : 50
    const posK = obBalanced ? '#8FBFA8' : '#F4D9A6'
    const openingsRail = (
      <>
        <div
          className="relative flex-none overflow-hidden"
          style={{
            borderRadius: 12,
            background: obBalanced
              ? 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)'
              : 'linear-gradient(160deg,#8A5A12 0%,#6B4200 55%,#4F3000 100%)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 16px 34px -16px rgba(7,43,32,.7)',
            padding: 18,
            color: '#fff'
          }}
        >
          <div
            className="pointer-events-none absolute"
            style={{ top: -60, right: -60, width: 180, height: 180, borderRadius: '50%', background: 'radial-gradient(circle,rgba(255,255,255,.14),transparent 70%)' }}
          />
          <div className="relative" style={{ ...kicker, color: posK }}>
            Difference in opening balances
          </div>
          <div className="relative mt-1.5" style={{ ...mono, fontSize: 23, fontWeight: 700, letterSpacing: '-0.03em', color: obBalanced ? A.accent : '#FFE7B0' }}>
            {obBalanced ? 'Nil' : diffLabel}
          </div>
          <div className="relative mt-[5px]" style={{ fontSize: 11, fontWeight: 600, color: posK, lineHeight: 1.5, textWrap: 'pretty' }}>
            {obBalanced
              ? 'Debits and credits agree — the opening position is fully accounted for.'
              : 'The part of the opening position not yet accounted for. It stays on screen until it is nil.'}
          </div>
          <div className="relative mt-3.5 flex h-2 overflow-hidden rounded-[4px]" style={{ background: 'rgba(255,255,255,.12)' }}>
            <div className="h-full" style={{ width: `${drPct}%`, background: 'linear-gradient(90deg,#9EC2EA,#5B8FCC)' }} />
            <div className="h-full flex-1" style={{ background: 'linear-gradient(90deg,#E7A7A0,#C2554A)' }} />
          </div>
          <div className="relative mt-3 flex flex-col gap-2">
            {[
              { k: 'Opening Dr', v: formatINR(obLive.dr) },
              { k: 'Opening Cr', v: formatINR(obLive.cr) },
              { k: 'Ledgers set', v: `${obSetCount} of ${obRows.length}` }
            ].map((x) => (
              <div
                key={x.k}
                className="flex items-baseline justify-between gap-2.5"
                style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: '9px 12px' }}
              >
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: posK }}>{x.k}</span>
                <span className="whitespace-nowrap" style={{ ...mono, fontSize: 13, fontWeight: 700 }}>
                  {x.v}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-none overflow-hidden" style={card}>
          <div className="flex items-center gap-[9px]" style={{ padding: '12px 15px', borderBottom: '1px solid #EAF0E9' }}>
            <Lightbulb className="h-[17px] w-[17px]" style={{ color: '#1B4E82' }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>Suggested from before start</span>
          </div>
          <div className="flex flex-col gap-0.5" style={{ padding: '6px 15px 12px' }}>
            {!obFrom ? (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: A.muted, padding: '8px 0', lineHeight: 1.5 }}>
                Set the date the books begin, and what each ledger carried into it shows here to use as its opening.
              </span>
            ) : !hints.length ? (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: A.muted, padding: '8px 0', lineHeight: 1.5 }}>
                Every ledger with history before the start date has an opening figure.
              </span>
            ) : (
              <>
                {hints.slice(0, 8).map((r) => (
                  <div key={String(r.id)} className="flex items-center gap-2.5" style={{ padding: '9px 0', borderBottom: '1px solid #EFF3EE' }}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" style={{ fontSize: 11.5, fontWeight: 800 }}>
                        {String(r.name)}
                      </div>
                      <div className="mt-0.5" style={{ ...mono, fontSize: 11, fontWeight: 600, color: '#1B4E82' }}>
                        {bal(n(r.before_cutoff))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => useBefore(r)}
                      className="flex h-7 flex-none items-center rounded-[6px] px-2.5"
                      style={{ background: '#EAF0FA', border: '1px solid #C6DAF0', color: '#1B4E82', fontSize: 10.5, fontWeight: 800 }}
                    >
                      USE
                    </button>
                  </div>
                ))}
                {hints.length > 8 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: A.muted, padding: '8px 0 0' }}>
                    and {hints.length - 8} more in the sheet.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => hints.forEach((r) => useBefore(r))}
                  className="mt-[9px] flex h-[34px] items-center justify-center gap-1.5 rounded-[7px]"
                  style={{ border: '1px solid #C6DAF0', background: '#F5F8FD', color: '#1B4E82', fontSize: 11.5, fontWeight: 800 }}
                >
                  <CheckCheck className="h-4 w-4" />
                  Use all {hints.length}
                </button>
              </>
            )}
          </div>
        </div>
      </>
    )

    // ── THE DRAWER: new, rename or move ───────────────────────────────────
    let drawer: React.JSX.Element | null = null
    const d = mDrawer
    if (d) {
      const isGroup = d.kind === 'group'
      const asksUnder = d.act !== 'rename'
      const top = isGroup && asksUnder && !d.under
      const name = d.name.trim()
      const up = (s: unknown): string => String(s || '').trim().toUpperCase()
      const unchanged = d.act === 'rename' && up(name) === up(d.oldName) && (!isGroup || name === d.oldName)
      const taken =
        !!name &&
        !unchanged &&
        (isGroup
          ? groupRows.some((g) => up(g.name) === up(name) && Number(g.id) !== d.id)
          : accounts.some((a) => up(a.name) === up(name) && Number(a.id) !== d.id))
      const banned = isGroup && d.act === 'move' && d.id ? branchOf(d.id) : new Set<number>()
      const f = d.find.trim().toLowerCase()
      const opts: { label: string; value: string; depth: number; nature: string }[] = []
      if (isGroup && asksUnder) opts.push({ label: '— Top level (a primary group) —', value: '', depth: 0, nature: '' })
      const walkOpts = (parent: number, depth: number): void => {
        for (const g of kids.get(parent) || []) {
          if (banned.has(Number(g.id))) continue
          if (!f || String(g.name).toLowerCase().includes(f)) opts.push({ label: String(g.name), value: String(g.name), depth, nature: String(g.nature || '') })
          walkOpts(Number(g.id), depth + 1)
        }
      }
      walkOpts(0, 0)
      const need: string[] = []
      if (d.act !== 'move' && !name) need.push('a name')
      if (unchanged) need.push('a new name')
      if (taken) need.push('a name not already used')
      if (top && !d.nature) need.push('which side of the books it falls on')
      if (!isGroup && asksUnder && !d.under) need.push('a group')
      if (d.act === 'move' && !d.ids && (d.under || '') === (d.oldUnder || '') && !(top && d.nature !== d.oldNature)) need.push('a different place to move it to')
      // The ticked ledgers, named, with where each sits today.
      const many = d.ids ? accounts.filter((a) => d.ids!.includes(Number(a.id))) : []
      const ready = !need.length && !mBusy
      const inheritNat = d.under ? natOf(groupByName.get(d.under)?.nature).label.toLowerCase() : ''
      const verb = d.act === 'new' ? 'Create' : d.act === 'rename' ? 'Rename' : 'Move'
      const save = (): void => {
        if (ready) void mDrawerSave(d)
      }
      drawer = (
        <div
          ref={mDrawerRef}
          className="fixed inset-0 z-40 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label={`${verb} ${isGroup ? 'group' : 'ledger'}`}
        >
          <div className="flex-1" style={{ background: 'rgba(7,43,32,.42)' }} onClick={() => setMDrawer(null)} />
          <div className="flex flex-none flex-col" style={{ width: 'min(100%,480px)', background: '#F4F7F2', boxShadow: '-18px 0 40px rgba(7,43,32,.28)' }}>
            <div className="flex-none" style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', padding: '16px 20px', color: '#fff' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: '#8FBFA8' }}>
                    {verb === 'Create' ? 'New' : verb} {isGroup ? 'group' : d.ids ? 'ledgers' : 'ledger'}
                  </div>
                  <div className="mt-[5px] truncate" style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' }}>
                    {d.act === 'new' ? (isGroup ? 'Create a group' : 'Create a ledger') : d.oldName}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMDrawer(null)}
                  title="Close (Esc)"
                  className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[7px] hover:bg-white/20"
                  style={{ background: 'rgba(255,255,255,.1)' }}
                >
                  <X className="h-[19px] w-[19px]" />
                </button>
              </div>
            </div>

            <div className="sc flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto" style={{ padding: '16px 20px' }}>
              {!!d.ids && (
                <div className="flex-none overflow-hidden" style={{ background: '#fff', border: '1px solid #DCE7DB', borderRadius: 10 }}>
                  <div className="flex items-center gap-[9px]" style={{ padding: '11px 13px', borderBottom: '1px solid #EAF0E9' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: A.muted }}>Moving</span>
                    <span className="ml-auto" style={{ fontSize: 11.5, fontWeight: 800, color: A.frame }}>
                      {many.length} ledger{many.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="sc max-h-[150px] overflow-y-auto" style={{ padding: '4px 0' }}>
                    {many.map((a) => (
                      <div key={String(a.id)} className="flex items-center gap-2" style={{ padding: '5px 13px' }}>
                        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, fontWeight: 700, color: A.ink }}>
                          {String(a.name)}
                        </span>
                        <span className="flex-none" style={{ fontSize: 10, fontWeight: 700, color: A.muted }}>
                          now in {String(a.acc_group || '—')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {d.act !== 'move' && (
                <div className="flex-none">
                  <div className="mb-[7px]" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: A.muted }}>
                    Name <span style={{ color: '#B3261E' }}>*</span>
                  </div>
                  <input
                    autoFocus
                    value={d.name}
                    onChange={(e) => setMDrawer((x) => (x ? { ...x, name: e.target.value } : x))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        save()
                      }
                    }}
                    placeholder={isGroup ? 'e.g. Freight Payable' : 'e.g. SHREE ROADLINES'}
                    className="w-full outline-none focus:!border-[#0B3D2E]"
                    style={{
                      height: 44,
                      border: `1px solid ${taken ? '#C2700A' : '#C3D2C6'}`,
                      borderRadius: 8,
                      padding: '0 12px',
                      fontSize: 13,
                      fontWeight: 700,
                      background: '#fff',
                      color: A.ink,
                      textTransform: isGroup ? 'none' : 'uppercase'
                    }}
                  />
                  <div className="mt-1.5" style={{ fontSize: 11, fontWeight: 600, color: taken ? '#8A5300' : A.muted, lineHeight: 1.5, textWrap: 'pretty' }}>
                    {taken
                      ? 'Already in the chart — pick another name.'
                      : d.act === 'rename' && !isGroup
                        ? `Renaming writes a redirect: postings the app addresses to ${d.oldName} will follow this ledger instead of opening a second one.`
                        : d.act === 'rename'
                          ? 'Every ledger under it is carried across with it, so nothing is left pointing at the old name.'
                          : isGroup
                            ? 'It sits in the chart under the group picked below.'
                            : 'The ledger opens at nil — give it an opening figure on the Opening balances tab.'}
                  </div>
                </div>
              )}

              {asksUnder && (
                <div className="flex-none overflow-hidden" style={{ background: '#fff', border: '1px solid #DCE7DB', borderRadius: 10 }}>
                  <div className="flex items-center gap-[9px]" style={{ padding: '11px 13px', borderBottom: '1px solid #EAF0E9' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: A.muted }}>Under</span>
                    <span className="ml-auto min-w-0 truncate" style={{ fontSize: 11.5, fontWeight: 800, color: A.frame }}>
                      {d.under || (isGroup ? 'Top level' : 'Pick a group')}
                    </span>
                  </div>
                  <div style={{ padding: '9px 11px', borderBottom: '1px solid #EAF0E9' }}>
                    <div className="flex h-[34px] items-center gap-[7px] rounded-[7px] px-[9px]" style={{ border: '1px solid #C3D2C6' }}>
                      <Search className="h-4 w-4 flex-none" style={{ color: A.muted }} />
                      <input
                        autoFocus={d.act === 'move'}
                        value={d.find}
                        onChange={(e) => setMDrawer((x) => (x ? { ...x, find: e.target.value } : x))}
                        placeholder="Find a group"
                        className="min-w-0 flex-1 border-0 bg-transparent outline-none"
                        style={{ fontSize: 12, fontWeight: 600 }}
                      />
                    </div>
                  </div>
                  <div className="sc max-h-[260px] overflow-y-auto" style={{ padding: 5 }}>
                    {opts.map((o) => {
                      const on = (d.under || '') === o.value
                      return (
                        <button
                          key={o.value || '__top__'}
                          type="button"
                          onClick={() =>
                            setMDrawer((x) =>
                              x ? { ...x, under: o.value, nature: o.value ? x.nature : x.nature || (isGroup ? String(x.oldNature || '') : '') } : x
                            )
                          }
                          className="flex w-full items-center gap-[9px] rounded-[7px] text-left hover:bg-[#F7FAF6]"
                          style={{
                            padding: `8px 9px 8px ${9 + o.depth * 16}px`,
                            background: on ? '#F3FBE2' : undefined,
                            border: `1px solid ${on ? '#CDE89A' : 'transparent'}`
                          }}
                        >
                          <span
                            className="flex h-4 w-4 flex-none items-center justify-center rounded-full"
                            style={{ border: `1.5px solid ${on ? A.frame : '#C3D2C6'}`, background: on ? A.frame : '#fff' }}
                          >
                            {on && <Check className="h-[11px] w-[11px] text-white" />}
                          </span>
                          <span className="min-w-0 truncate" style={{ fontSize: 12, fontWeight: o.depth === 0 ? 800 : 600 }}>
                            {o.label}
                          </span>
                          {!!o.nature && (
                            <span
                              className="ml-auto flex-none"
                              style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: natOf(o.nature).fg }}
                            >
                              {natOf(o.nature).label}
                            </span>
                          )}
                        </button>
                      )
                    })}
                    {!opts.length && (
                      <div style={{ padding: '14px 9px', fontSize: 12, fontWeight: 600, color: A.muted }}>No group matches.</div>
                    )}
                  </div>
                </div>
              )}

              {top && (
                <div className="flex-none">
                  <div className="mb-[7px]" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: A.muted }}>
                    Side of the books <span style={{ color: '#B3261E' }}>*</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(['asset', 'liability', 'income', 'expense'] as const).map((k) => {
                      const on = d.nature === k
                      const t = NAT[k]
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setMDrawer((x) => (x ? { ...x, nature: k } : x))}
                          className="flex h-10 items-center justify-center rounded-[8px]"
                          style={{
                            background: on ? t.bg : '#fff',
                            border: `1px solid ${on ? t.fg : '#DCE7DB'}`,
                            color: on ? t.fg : '#33473E',
                            fontSize: 12,
                            fontWeight: 800
                          }}
                        >
                          {t.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-[7px]" style={{ fontSize: 11, fontWeight: 600, color: A.muted, lineHeight: 1.5, textWrap: 'pretty' }}>
                    A primary group has nothing above it to inherit from, so it has to say which side it falls on. Putting it
                    under an existing group instead — which is nearly always what is meant — decides this for it.
                  </div>
                </div>
              )}

              {asksUnder && !!d.under && (
                <div className="flex flex-none items-start gap-[9px]" style={{ background: '#E9F5EE', border: '1px solid #BFE3CB', borderRadius: 8, padding: '10px 12px' }}>
                  <Split className="h-[17px] w-[17px] flex-none" style={{ color: '#0B6B45' }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#0B6B45', lineHeight: 1.5, textWrap: 'pretty' }}>
                    {isGroup
                      ? `Sits under ${d.under}, so it reads as ${inheritNat} without being told${d.act === 'move' ? ' — and so does everything under it' : ''}.`
                      : `Posts under ${d.under} — ${inheritNat} side.${isBillwise(d.under) ? ' Bill-wise details will be kept.' : ''}${d.act === 'move' ? ' No posting changes.' : ''}`}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2.5" style={{ background: '#fff', borderTop: '1px solid #DCE7DB', padding: '13px 20px' }}>
              <span className="min-w-0 flex-1" style={{ fontSize: 11.5, fontWeight: 700, color: need.length ? '#8A5300' : '#0B6B45', lineHeight: 1.4 }}>
                {mBusy ? 'Saving…' : need.length ? `Needs ${need.join(' and ')}.` : d.act === 'new' ? 'Ready to create.' : 'Ready to save.'}
              </span>
              <button
                type="button"
                onClick={() => setMDrawer(null)}
                className="flex h-[42px] items-center rounded-[8px] px-4 hover:bg-[#F7FAF6]"
                style={{ border: '1px solid #C3D2C6', fontSize: 12, fontWeight: 800, color: '#33473E' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!ready}
                className="flex h-[42px] items-center gap-[7px] rounded-[8px] px-[18px]"
                style={{
                  background: ready ? 'linear-gradient(180deg,#145A43,#0B3D2E)' : '#DCE7DB',
                  color: ready ? '#fff' : '#8CA396',
                  boxShadow: ready ? '0 8px 18px -10px rgba(7,43,32,.8)' : 'none',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: ready ? 'pointer' : 'not-allowed'
                }}
              >
                <Check className="h-[17px] w-[17px]" />
                {verb}
              </button>
            </div>
          </div>
        </div>
      )
    }

    const body = (
      <div className="flex min-h-0 flex-1" style={{ gap: gutter, padding: bodyPad }}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={card}>
          {onOpenings ? openingsCard : mastersCard}
        </div>
        {showRail && (
          <div className="sc flex min-h-0 flex-none flex-col gap-3 overflow-y-auto pr-0.5" style={{ width: railW }}>
            {onOpenings ? openingsRail : mastersRail}
          </div>
        )}
        {drawer}
      </div>
    )
    return { strip, body }
  })()

  const voucherWeb = (() => {
    type VRow = {
      key: string
      side: 'dr' | 'cr'
      canFlip: boolean
      sideWhy: string
      account: string
      group: string
      dr: string
      cr: string
      allocs: AllocRow[]
      billwise: boolean
      onAccount: (name: string, group: string) => void
      onAmount: (v: string, side: 'dr' | 'cr') => void
      onAllocs: (a: AllocRow[]) => void
      onRemove: (() => void) | null
      refsSide?: 'customer' | 'supplier'
      // The working behind this line's figure — see SplitPanel. Absent on the
      // structured payment/receipt rows, whose money side is one figure by
      // construction and whose party side is bill-wise instead.
      splits?: SplitRow[]
      onSplits?: (rows: SplitRow[]) => void
      splitIndex?: number
      // Stock line: set only on a note whose ledger is a purchase/sale account.
      inventory?: boolean
      product_id?: number | null
      qty?: string
      rate?: string
      onInventory?: (patch: { product_id?: number | null; qty?: string; rate?: string }) => void
    }
    const partySide: 'dr' | 'cr' = vchType === 'PAYMENT' ? 'dr' : 'cr'
    const moneySide: 'dr' | 'cr' = vchType === 'PAYMENT' ? 'cr' : 'dr'
    const rows: VRow[] = structured
      ? [
          ...payLines.map((l, i) => ({
            key: `party-${i}`,
            side: partySide,
            canFlip: false,
            sideWhy:
              vchType === 'PAYMENT'
                ? 'A payment debits the party — the side follows the voucher type'
                : 'A receipt credits the party — the side follows the voucher type',
            account: l.account,
            group: l.group,
            dr: partySide === 'dr' ? l.amount : '',
            cr: partySide === 'cr' ? l.amount : '',
            allocs: l.allocs,
            billwise: isBillwise(String(l.group)),
            onAccount: (name: string, group: string) => {
              setPayLine(i, { account: name, group })
              // The party's own ledger decides whose bills are offered — a
              // customer refunded on a Payment settles against their SALES
              // bills, a supplier paying in on a Receipt against purchases.
              // Forcing the side from the voucher type hid exactly those.
              void loadRefs(name)
            },
            onAmount: (v: string) => setPayLine(i, { amount: v }),
            onAllocs: (a: AllocRow[]) => setPayLine(i, { allocs: a }),
            onRemove: payLines.length > 1 ? () => setPayLines((p) => p.filter((_, j) => j !== i)) : null,
            refsSide: undefined as 'customer' | 'supplier' | undefined
          })),
          ...payAccounts.map((l, i) => ({
            key: `money-${i}`,
            side: moneySide,
            canFlip: false,
            sideWhy:
              vchType === 'PAYMENT'
                ? 'The money left this account, so it is credited'
                : 'The money landed in this account, so it is debited',
            account: l.account,
            group: l.group,
            dr: moneySide === 'dr' ? (payAccounts.length === 1 ? String(payTotal || '') : l.amount) : '',
            cr: moneySide === 'cr' ? (payAccounts.length === 1 ? String(payTotal || '') : l.amount) : '',
            allocs: [] as AllocRow[],
            billwise: false,
            onAccount: (name: string, group: string) => setPayAccountLine(i, { account: name, group }),
            onAmount: (v: string) => setPayAccountLine(i, { amount: v }),
            onAllocs: () => undefined,
            onRemove: payAccounts.length > 1 ? () => setPayAccounts((p) => p.filter((_, j) => j !== i)) : null
          }))
        ]
      : lines.map((l, i) => {
          // A note line on a purchase/sale ledger can carry a quantity; the
          // figure then follows qty × rate rather than a typed amount.
          const inv = isNoteType && PRODUCT_LEDGER_GROUPS.includes(String(l.group))
          const invAmt =
            inv && n(l.qty) > 0 && n(l.rate) > 0 ? String(Math.round(n(l.qty) * n(l.rate) * 100) / 100) : null
          const amt = invAmt != null ? invAmt : l.amount
          return {
          key: `line-${i}`,
          side: l.side,
          canFlip: true,
          sideWhy: 'Click to flip this line between debit and credit',
          account: l.account,
          group: l.group,
          dr: l.side === 'dr' ? amt : '',
          cr: l.side === 'cr' ? amt : '',
          allocs: l.allocs,
          billwise: isBillwise(String(l.group)),
          inventory: inv,
          product_id: l.product_id ?? null,
          qty: l.qty || '',
          rate: l.rate || '',
          onInventory: (patch: { product_id?: number | null; qty?: string; rate?: string }) => setLine(i, patch),
          onAccount: (name: string, group: string) => {
            // Leaving a product ledger drops the quantity it was carrying.
            const keep = isNoteType && PRODUCT_LEDGER_GROUPS.includes(String(group))
            setLine(i, keep ? { account: name, group } : { account: name, group, product_id: null, qty: '', rate: '' })
            void loadRefs(name)
          },
          onAmount: (v: string, side: 'dr' | 'cr') => setLine(i, { amount: v, side }),
          onAllocs: (a: AllocRow[]) => setLine(i, { allocs: a }),
          splits: l.splits || [],
          onSplits: (rows: SplitRow[]) => setLine(i, { splits: rows }),
          splitIndex: i,
          onRemove: lines.length > 2 ? () => setLines((p) => p.filter((_, j) => j !== i)) : null
          }
        })

    const vDr = gridGst.active ? gridGst.virtual.filter((v) => v.side === 'dr').reduce((t, v) => t + v.amount, 0) : 0
    const vCr = gridGst.active ? gridGst.virtual.filter((v) => v.side === 'cr').reduce((t, v) => t + v.amount, 0) : 0
    const drTotal = rows.reduce((t, r) => t + n(r.dr), 0) + vDr
    const crTotal = rows.reduce((t, r) => t + n(r.cr), 0) + vCr
    const diff = Math.round((drTotal - crTotal) * 100) / 100
    const balanced = Math.abs(diff) < 0.005
    const named = rows.filter((r) => r.account && (n(r.dr) > 0 || n(r.cr) > 0))
    const need: string[] = []
    if (!rows.some((r) => r.account)) need.push('a ledger on at least one line')
    else if (rows.some((r) => !r.account && !r.key.startsWith('money') && n(r.dr) + n(r.cr) > 0))
      need.push('a ledger on every line with an amount')
    if (drTotal <= 0 && crTotal <= 0) need.push('an amount')
    if (structured && !payAccounts.some((l) => l.account))
      need.push(`the ${vchType === 'PAYMENT' ? 'account the money goes out of' : 'account the money comes into'}`)
    const requirement = need.length
      ? `Enter ${need.join(' and ')}.`
      : balanced
        ? `Balanced — accepting posts ${formatINR(drTotal)} across ${named.length + (gridGst.active ? gridGst.virtual.length : 0)} ${named.length + (gridGst.active ? gridGst.virtual.length : 0) === 1 ? 'ledger' : 'ledgers'}.`
        : `Debit and credit differ by ${formatINR(Math.abs(diff))}. A voucher cannot be accepted until they agree.`
    const canSave = !need.length && balanced && !saving

    const nature =
      vchType === 'PAYMENT'
        ? 'Money paid out from cash or bank'
        : vchType === 'RECEIPT'
          ? 'Money received into cash or bank'
          : vchType === 'CONTRA'
            ? 'Moves money between your own cash and bank accounts'
            : vchType === 'JOURNAL'
              ? 'Adjusts balances between ledgers with no money moving'
              : 'Adjusts a party balance against a purchase or sale account'

    // Where the owning document can be opened from here. A payment, a note or
    // a freight bill has no page this screen can open, so it is only named.
    const owner = (viewOnly?.owner as Row | null) || null
    const openOwner =
      owner && ['bd', 'lc', 'order', 'sale'].includes(String(owner.kind))
        ? () =>
            openRowSource(
              {
                bd_id: owner.kind === 'bd' ? owner.id : null,
                lc_id: owner.kind === 'lc' ? owner.id : null,
                order_id: owner.kind === 'order' ? owner.id : null,
                sale_id: owner.kind === 'sale' ? owner.id : null
              },
              ledgerId
            )
        : null

    // THE LAYOUT FOLLOWS THE WINDOW IT IS IN, NOT A FIXED CANVAS.
    // Wide: the balance and the Accept button sit in a rail beside the entry.
    // Narrower: they dock along the bottom, so the lines keep the full width
    // and Accept is never scrolled off-screen.
    const W = vw
    const wide = W >= 1180
    const V_GRID = W >= 1400 ? '64px minmax(0,1fr) 160px 150px 150px 40px' : '56px minmax(0,1fr) 140px 130px 130px 36px'
    const indent = W >= 1400 ? 68 : 60
    const railW = W >= 2000 ? 400 : W >= 1500 ? 360 : 320
    const gutter = W >= 1400 ? 18 : 14
    const bodyPad = W >= 1400 ? '18px 22px 16px' : '14px 16px 12px'

    const typeName = VCH_TYPES.find((v) => v.key === vchType)?.label || vchType
    // The number: the one it was posted under, or — for a voucher still being
    // keyed — the one it will take, labelled as a forecast.
    const altering = editingId != null || noteEditId != null
    const shownCode = viewOnly ? String(viewOnly.code || viewOnly.vch_no || '') : altering ? vchCode : nextCode
    const codeBadge = viewOnly ? 'POSTED' : altering ? 'ALTERING' : 'ON ACCEPT'
    const codeWhy = viewOnly
      ? 'The number this voucher was posted under'
      : altering
        ? 'Altering keeps the voucher its number'
        : 'The number this voucher takes when it is accepted'

    const tone = (side: 'dr' | 'cr'): { rowBg: string; mark: string; fg: string; bg: string } =>
      side === 'dr'
        ? { rowBg: '#F5F8FD', mark: '#1B4E82', fg: '#1B4E82', bg: '#E3ECF8' }
        : { rowBg: '#FDF7F6', mark: '#8C2F26', fg: '#8C2F26', bg: '#F7E4E1' }
    // What KIND of ledger a line is, at the front of its box — a party, a bank,
    // cash, stock, a tax, or anything else.
    const groupIcon = (group: string): React.JSX.Element => {
      const g = String(group || '')
      const cls = 'h-[17px] w-[17px]'
      if (isBillwise(g)) return <User className={cls} />
      if (g === 'Cash-in-Hand') return <Banknote className={cls} />
      if (g === 'Bank Accounts' || g === 'Bank OD A/c') return <Landmark className={cls} />
      if (PRODUCT_LEDGER_GROUPS.includes(g)) return <Package className={cls} />
      if (g === 'Duties & Taxes') return <Percent className={cls} />
      return <ArrowLeftRight className={cls} />
    }
    const card: React.CSSProperties = {
      flex: 'none',
      background: '#fff',
      border: '1px solid #DCE7DB',
      borderRadius: 10,
      boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)'
    }
    const cap: React.CSSProperties = {
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.13em',
      textTransform: 'uppercase',
      color: A.muted,
      marginBottom: 6
    }
    const field: React.CSSProperties = {
      width: '100%',
      height: 38,
      borderRadius: 6,
      border: '1px solid #C3D2C6',
      background: '#fff',
      padding: '0 11px',
      fontSize: 12.5,
      fontWeight: 600,
      color: A.ink,
      outline: 0
    }
    const roBox: React.CSSProperties = {
      height: 38,
      borderRadius: 6,
      background: '#F4F7F2',
      border: '1px solid #E4ECE3',
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      padding: '0 11px',
      minWidth: 0
    }
    const small: React.CSSProperties = {
      height: 32,
      borderRadius: 5,
      border: '1px solid #C3D2C6',
      background: '#fff',
      padding: '0 9px',
      textAlign: 'right',
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: 12.5,
      fontWeight: 700,
      color: A.ink,
      outline: 0
    }
    const fig = (size: number, color: string = A.ink): React.CSSProperties => ({
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: size,
      fontWeight: 700,
      color
    })
    const sideChip = (side: 'dr' | 'cr'): React.CSSProperties => ({
      fontSize: 11,
      fontWeight: 800,
      color: tone(side).fg,
      background: tone(side).bg,
      borderRadius: 4,
      padding: '4px 7px'
    })
    const keyTag: React.CSSProperties = {
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: 10,
      fontWeight: 600,
      border: '1px solid currentColor',
      borderRadius: 3,
      padding: '1px 5px'
    }

    // --- the figures the rail and the dock read out --------------------------
    const ok = balanced && drTotal > 0
    const empty = drTotal <= 0 && crTotal <= 0
    const matchPct = Math.max(drTotal, crTotal) > 0 ? Math.min(drTotal, crTotal) / Math.max(drTotal, crTotal) : 0
    const ringColor = ok ? '#C7F03F' : '#F0C98A'
    const RingIcon = ok ? Check : Scale
    const balHead = ok ? 'Balanced' : empty ? 'Nothing entered' : `Out by ${formatINR(Math.abs(diff))}`
    const balSub = viewOnly
      ? viewOnly.manual
        ? 'Entered by hand — your access lets you read this voucher type, not alter it.'
        : `Posted from ${owner ? String(owner.label) : 'its source document'} — view only.`
      : ok
        ? canSave
          ? 'Debit and credit agree — ready to accept.'
          : 'Debit and credit agree — what is still missing is said below.'
        : empty
          ? 'Pick the ledgers and put an amount on them.'
          : diff > 0
            ? 'Debit is higher. Add a credit line or trim a debit.'
            : 'Credit is higher. Add a debit line or trim a credit.'
    const typeLine = `${viewOnly ? String(viewOnly.vch_type || typeName) : typeName}${shownCode ? ` · ${shownCode}` : ''}`
    // Every ledger this voucher will touch, debits first — the way a voucher is
    // read — with the GST the note worked out included.
    const preview = orderVoucherLines([
      ...rows
        .filter((r) => r.account && n(r.dr) + n(r.cr) > 0)
        .map((r) => ({
          side: (n(r.dr) > 0 ? 'dr' : 'cr') as 'dr' | 'cr',
          name: r.account,
          group: r.group || '—',
          amount: n(r.dr) + n(r.cr)
        })),
      ...(gridGst.active ? gridGst.virtual.map((v) => ({ side: v.side, name: v.account, group: v.group, amount: v.amount })) : [])
    ], (p) => ({ account: p.name, dr: p.side === 'dr', tax: isTaxLine(p.name, p.group === '—' ? '' : p.group), amount: p.amount }))
    const ledgerCount = `${preview.length} ${preview.length === 1 ? 'ledger' : 'ledgers'}`
    const gstName = noteGstType === 'IGST' ? 'IGST' : 'CGST + SGST'
    const taxRows = gridNote
      ? [
          { k: 'Taxable value', v: formatINR(gridGst.base), strong: false },
          {
            k: gridGst.active ? `GST ${gridGst.pct}% (${gstName})` : 'GST',
            v: gridGst.active ? formatINR(gridGst.gst) : 'nil',
            strong: false
          },
          ...(Math.abs(gridGst.roundOff) > 0.004
            ? [{ k: 'Round off', v: `${gridGst.roundOff > 0 ? '+' : '−'}${formatINR(Math.abs(gridGst.roundOff))}`, strong: false }]
            : []),
          { k: 'On the party', v: formatINR(gridGst.partyTarget ?? 0), strong: true }
        ]
      : []

    const status = viewOnly ? `${formatINR(drTotal)} Dr · ${formatINR(crTotal)} Cr — as posted.` : requirement
    const StatusIcon = viewOnly ? LockIcon : canSave ? CircleCheck : CircleAlert
    const statusFg = viewOnly ? A.muted : canSave ? A.good : A.warn
    const acceptLabel = saving ? 'Posting…' : editingId != null || noteEditId != null ? 'Accept changes' : 'Accept'
    const acceptLook: React.CSSProperties = {
      background: canSave ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : '#DCE4DA',
      color: canSave ? '#0B3D2E' : '#8CA396',
      boxShadow: canSave ? 'inset 0 1px 0 rgba(255,255,255,.6),0 10px 22px -10px rgba(120,160,20,.7)' : 'none',
      cursor: canSave ? 'pointer' : 'not-allowed'
    }

    // The note's party line, while its figure is still the one the items and
    // the GST came to — the line the canvas marks FROM GST.
    const partyKey = gridGst.partyIdx >= 0 ? `line-${gridGst.partyIdx}` : ''

    const ring = (size: number, inner: number, iconPx: number, innerBg: string): React.JSX.Element => (
      <div
        className="flex flex-none items-center justify-center rounded-full"
        style={{
          width: size,
          height: size,
          background: `conic-gradient(${ringColor} ${(matchPct * 100).toFixed(1)}%, rgba(255,255,255,.12) 0)`,
          boxShadow: '0 0 0 1px rgba(255,255,255,.08)'
        }}
      >
        <div className="flex items-center justify-center rounded-full" style={{ width: inner, height: inner, background: innerBg }}>
          <RingIcon style={{ width: iconPx, height: iconPx, color: ringColor }} />
        </div>
      </div>
    )

    const previewRows = (withGroup: boolean): React.JSX.Element[] =>
      preview.map((pv, i) => (
        <div key={`${pv.name}-${i}`} className="flex items-center gap-2.5" style={{ padding: withGroup ? '10px 0' : '9px 0', borderBottom: '1px solid #F0F4EF' }}>
          <span className="flex-none text-center" style={{ ...sideChip(pv.side), width: 28, padding: '3px 0', fontSize: 10.5 }}>
            {pv.side === 'dr' ? 'Dr' : 'Cr'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate" style={{ fontSize: 11.5, fontWeight: 800 }}>
              {pv.name}
            </div>
            {withGroup && <div style={{ fontSize: 10, fontWeight: 600, color: A.muted, marginTop: 2 }}>{pv.group}</div>}
          </div>
          <span className="whitespace-nowrap" style={fig(12)}>
            {formatINR(pv.amount)}
          </span>
        </div>
      ))

    const discardBtn = (dock: boolean): React.JSX.Element => (
      <button
        type="button"
        // Esc and this button are one action: a voucher with work in it asks
        // before anything is thrown away.
        onClick={() => leaveVoucher()}
        className="flex flex-none items-center gap-2 rounded-[8px]"
        style={
          dock
            ? { height: 42, padding: '0 13px', border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.06)', fontSize: 12, fontWeight: 800, color: '#DCEFE4' }
            : { height: 46, padding: '0 15px', border: '1px solid #C3D2C6', background: '#fff', fontSize: 12.5, fontWeight: 800, color: '#33473E' }
        }
      >
        {!dock && <span style={{ ...keyTag, color: A.muted, borderColor: '#DCE7DB' }}>Esc</span>}
        {viewOnly ? 'Back' : 'Discard'}
      </button>
    )
    // Deleting the voucher (or note) being altered — only while altering one,
    // and only for a user whose rights on this type include Delete.
    const deleteBtn = (dock: boolean): React.JSX.Element | null =>
      !viewOnly && (editingId != null || noteEditId != null) && vchRights(vchType).delete ? (
        <button
          type="button"
          onClick={() => void deleteVoucher()}
          title="Delete this voucher (Alt D)"
          className="flex flex-none items-center gap-2 rounded-[8px]"
          style={
            dock
              ? { height: 42, padding: '0 13px', border: '1px solid rgba(240,175,170,.45)', background: 'rgba(179,38,30,.18)', fontSize: 12, fontWeight: 800, color: '#FFD9D5' }
              : { height: 46, padding: '0 15px', border: '1px solid #F0C9C4', background: '#FDF3F2', fontSize: 12.5, fontWeight: 800, color: '#B3261E' }
          }
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      ) : null
    const acceptBtn = (dock: boolean): React.JSX.Element | null => {
      if (viewOnly) {
        if (!openOwner) return null
        return (
          <button
            type="button"
            onClick={openOwner}
            className="flex items-center justify-center gap-2 rounded-[8px]"
            style={{
              flex: dock ? 'none' : 1,
              height: dock ? 42 : 46,
              padding: '0 16px',
              background: dock ? 'rgba(255,255,255,.1)' : 'linear-gradient(180deg,#11503C,#0B3D2E)',
              border: dock ? '1px solid rgba(255,255,255,.18)' : 'none',
              color: '#fff',
              fontSize: 12.5,
              fontWeight: 800,
              whiteSpace: 'nowrap'
            }}
          >
            Open {String(owner?.label || 'document')}
          </button>
        )
      }
      // INERT UNTIL IT BALANCES. The reason is beside it, not behind a toast
      // after the click — a button that can be pressed and then refuses is a
      // button that taught you nothing.
      return (
        <button
          type="button"
          disabled={!canSave}
          title={canSave ? 'Post this voucher' : requirement}
          onClick={() => void saveVoucher()}
          className="flex items-center justify-center rounded-[8px]"
          style={{
            ...acceptLook,
            flex: dock ? 'none' : 1,
            height: dock ? 42 : 46,
            padding: dock ? '0 18px' : 0,
            gap: dock ? 8 : 9,
            fontSize: dock ? 12.5 : 13,
            fontWeight: 800,
            whiteSpace: 'nowrap'
          }}
        >
          <Check style={{ width: dock ? 18 : 19, height: dock ? 18 : 19 }} />
          {acceptLabel}
          {!dock && <span style={{ ...keyTag, opacity: 0.75 }}>Ctrl A</span>}
        </button>
      )
    }

    return (
      <>
        <div className="flex min-h-0 flex-1" style={{ gap: gutter, padding: bodyPad }}>
          <div className="sc flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto" style={{ paddingRight: 4 }}>
            {/* What the last Accept did, until it is dismissed or the next one lands. */}
            {postedMsg && !viewOnly && (
              <div
                className="flex flex-none items-center gap-[11px]"
                style={{
                  padding: '11px 14px',
                  borderRadius: 8,
                  background: 'linear-gradient(180deg,#F1FBE0,#E6F6CC)',
                  border: '1px solid #CDE89A',
                  boxShadow: '0 6px 18px -10px rgba(63,90,18,.4)'
                }}
              >
                <CircleCheckBig className="h-5 w-5 flex-none" style={{ color: '#3F5A12' }} />
                <span className="min-w-0" style={{ fontSize: 12.5, fontWeight: 800, color: '#2E4A0B', fontVariantNumeric: FIGS }}>
                  {postedMsg}
                </span>
                <button
                  type="button"
                  title="Dismiss"
                  onClick={() => setPostedMsg(null)}
                  className="ml-auto flex h-7 w-7 flex-none items-center justify-center rounded-[5px] hover:bg-[#DDF0BE]"
                >
                  <X className="h-[17px] w-[17px]" style={{ color: '#3F5A12' }} />
                </button>
              </div>
            )}

            {/* A voucher another document posted: shown in full, changed only
                from where it came from. */}
            {viewOnly && (
              <div
                className="flex flex-none flex-wrap items-center gap-x-[11px] gap-y-2"
                style={{
                  padding: '11px 14px',
                  borderRadius: 8,
                  background: 'linear-gradient(180deg,#FFF9EC,#FFF3DA)',
                  border: '1px solid #F1D9A6',
                  boxShadow: '0 6px 18px -10px rgba(138,90,0,.35)'
                }}
              >
                <LockIcon className="h-[18px] w-[18px] flex-none" style={{ color: '#8A5A00' }} />
                <span style={{ fontSize: 12.5, fontWeight: 800, color: '#5C3D00' }}>
                  {String(viewOnly.vch_type || 'Voucher')}
                  {shownCode ? ` ${shownCode}` : ''} — view only
                </span>
                <span className="min-w-0" style={{ fontSize: 11.5, fontWeight: 600, color: '#8A5A00', lineHeight: 1.45 }}>
                  {viewOnly.manual
                    ? 'Entered by hand. Your access lets you read this voucher type, not alter it — ask an admin in User Access.'
                    : canAlterOwned(viewOnly)
                      ? `Posted from ${owner ? String(owner.label) : 'its source document'}. Alter changes it through that document, so the dues and balances follow.`
                      : `Posted from ${owner ? String(owner.label) : 'its source document'}. It changes only from there, and this voucher follows.`}
                </span>
                {(openOwner || canAlterOwned(viewOnly)) && (
                  <span className="ml-auto flex flex-none items-center gap-2">
                    {canAlterOwned(viewOnly) && (
                      <button
                        type="button"
                        onClick={() => void startAlterOwned(viewOnly)}
                        className="flex h-8 flex-none items-center gap-1.5 rounded-[6px] px-3"
                        style={{ background: '#C7F03F', color: '#12280B', fontSize: 11.5, fontWeight: 800 }}
                        title="Alter this voucher through its document, so the dues and balances follow"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Alter
                      </button>
                    )}
                    {openOwner && (
                      <button
                        type="button"
                        onClick={openOwner}
                        className="flex h-8 flex-none items-center gap-1.5 rounded-[6px] px-3"
                        style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff', fontSize: 11.5, fontWeight: 800 }}
                      >
                        Open {String(owner?.label || 'document')}
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}

            <div
              className="flex flex-none flex-col gap-3.5"
              // Nothing inside a viewed voucher takes a click, a key or focus.
              ref={(el) => {
                if (el) el.toggleAttribute('inert', !!viewOnly)
              }}
            >
              <div
                style={{
                  ...card,
                  padding: '14px 16px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
                  gap: 14
                }}
              >
                <div className="min-w-0">
                  <div style={cap}>Voucher no</div>
                  <div style={{ ...roBox, justifyContent: 'space-between' }} title={codeWhy}>
                    <span className="truncate" style={fig(13)}>
                      {shownCode || '—'}
                    </span>
                    <span
                      className="flex-none"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 800,
                        letterSpacing: '.06em',
                        color: A.muted,
                        background: '#fff',
                        border: '1px solid #DCE7DB',
                        borderRadius: 3,
                        padding: '2px 6px'
                      }}
                    >
                      {codeBadge}
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <div style={cap}>Date</div>
                  <input
                    type="date"
                    value={vchDate}
                    onChange={(e) => setVchDate(e.target.value)}
                    style={{ ...field, padding: '0 10px', fontFamily: MONO, fontVariantNumeric: FIGS }}
                  />
                </div>
                {/* THE REFERENCE IS THE VOUCHER'S OWN NUMBER FIELD — the one the
                    desktop calls "Voucher no (optional)". It posts as the
                    voucher's vch no: the Day Book prints it, and the ledger's
                    Ref column falls back to it. */}
                <div className="min-w-0">
                  <div style={cap}>Reference</div>
                  <input
                    value={vchNo}
                    onChange={(e) => setVchNo(e.target.value)}
                    placeholder="Party's note or bill no"
                    style={field}
                  />
                </div>
                <div className="min-w-0" style={{ gridColumn: 'span 2' }}>
                  <div style={cap}>Voucher nature</div>
                  <div style={roBox}>
                    <Info className="h-4 w-4 flex-none" style={{ color: '#12855A' }} />
                    <span className="truncate" style={{ fontSize: 12, fontWeight: 600, color: '#33473E' }}>
                      {nature}
                    </span>
                  </div>
                </div>
              </div>

              <div className="sc-x" style={{ ...card, overflowX: 'auto', overflowY: 'hidden' }}>
                <div style={{ minWidth: 780 }}>
                  <div
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: V_GRID,
                      height: 36,
                      background: 'linear-gradient(180deg,#0F4A38,#0B3D2E)',
                      color: '#A9CDBB',
                      fontSize: 9.5,
                      fontWeight: 800,
                      letterSpacing: '.14em',
                      textTransform: 'uppercase'
                    }}
                  >
                    <span style={{ textAlign: 'center' }}>Dr/Cr</span>
                    <span style={{ padding: '0 12px' }}>Particulars</span>
                    <span style={{ padding: '0 12px' }}>Group</span>
                    <span style={{ padding: '0 14px', textAlign: 'right' }}>Debit</span>
                    <span style={{ padding: '0 14px', textAlign: 'right' }}>Credit</span>
                    <span />
                  </div>

                  {rows.map((r) => {
                    const t = tone(r.side)
                    const lineAmt = n(r.dr) + n(r.cr)
                    const invAuto = !!r.inventory && n(r.qty) > 0 && n(r.rate) > 0
                    const moneyAuto = structured && r.key.startsWith('money') && payAccounts.length === 1
                    const isNoteParty = gridNote && r.key === partyKey
                    const partyAuto =
                      isNoteParty && gridGst.partyTarget != null && Math.abs(lineAmt - gridGst.partyTarget) < 0.005
                    const noteChips = isNoteParty && gridGst.active
                    const showSplitLink =
                      !noteChips &&
                      !!r.onSplits &&
                      !r.inventory &&
                      !!r.account &&
                      lineAmt > 0 &&
                      (!viewOnly || (r.splits || []).length > 0)
                    const splitIsOpen = splitOpen === r.splitIndex
                    return (
                      <div key={r.key}>
                        <div className="grid items-stretch" style={{ gridTemplateColumns: V_GRID, background: t.rowBg, borderBottom: '1px solid #EAF0E9' }}>
                          <div className="flex flex-col items-center justify-start gap-1.5" style={{ paddingTop: 12, borderLeft: `3px solid ${t.mark}` }}>
                            <button
                              type="button"
                              title={r.sideWhy}
                              onClick={() => {
                                if (!r.canFlip) return
                                setLine(Number(r.key.split('-')[1]), { side: r.side === 'dr' ? 'cr' : 'dr' })
                              }}
                              style={{ ...sideChip(r.side), cursor: r.canFlip ? 'pointer' : 'default' }}
                            >
                              {r.side === 'dr' ? 'Dr' : 'Cr'}
                            </button>
                            {/* SWAP THIS LINE, Dr ⇄ Cr — the chip above does it
                                too, but nothing said so. */}
                            {r.canFlip && !viewOnly && (
                              <button
                                type="button"
                                title={`Swap this line to ${r.side === 'dr' ? 'Credit' : 'Debit'}`}
                                aria-label={`Swap this line to ${r.side === 'dr' ? 'credit' : 'debit'}`}
                                onClick={() => setLine(Number(r.key.split('-')[1]), { side: r.side === 'dr' ? 'cr' : 'dr' })}
                                className="flex h-[22px] w-[26px] items-center justify-center rounded-[5px] border border-[#DCE7DB] bg-white text-[#5A6B62] transition-colors hover:border-[#0B3D2E] hover:text-[#0B3D2E]"
                              >
                                <ArrowLeftRight className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          <div className="flex min-w-0 flex-col gap-[7px]" style={{ padding: '9px 12px' }}>
                            <AccountPicker
                              value={r.account}
                              icon={groupIcon(
                                r.group ||
                                  (r.key.startsWith('party')
                                    ? 'Sundry Creditors'
                                    : r.key.startsWith('money')
                                      ? vchType === 'PAYMENT' || vchType === 'RECEIPT'
                                        ? 'Bank Accounts'
                                        : ''
                                      : vchType === 'CONTRA'
                                        ? 'Bank Accounts'
                                        : '')
                              )}
                              accounts={
                                structured && r.key.startsWith('money')
                                  ? cashBankAccounts
                                  : vchType === 'CONTRA'
                                    ? cashBankAccounts
                                    : accounts
                              }
                              onPick={(name, group) => r.onAccount(name, group)}
                              onCreate={(name) => setNewLedger({ name, group: '', forLine: null })}
                            />
                            {/* How the figure is made up: the note's own sum,
                                or the working written down against a line. */}
                            {(noteChips || showSplitLink) && (
                              <button
                                type="button"
                                onClick={() =>
                                  noteChips ? setNoteSplitOpen((o) => !o) : setSplitOpen(splitIsOpen ? -1 : (r.splitIndex as number))
                                }
                                className="inline-flex items-center gap-[5px] self-start"
                                style={{ fontSize: 11, fontWeight: 700, color: '#0B6B45' }}
                              >
                                {(noteChips ? noteSplitOpen : splitIsOpen) ? (
                                  <ChevronUp className="h-[15px] w-[15px]" />
                                ) : (
                                  <Split className="h-[15px] w-[15px]" />
                                )}
                                {(noteChips ? noteSplitOpen : splitIsOpen)
                                  ? 'hide the breakdown'
                                  : !noteChips && (r.splits || []).length
                                    ? `made of ${(r.splits || []).length} ${(r.splits || []).length === 1 ? 'part' : 'parts'}`
                                    : 'break this figure down'}
                              </button>
                            )}
                            {noteChips && noteSplitOpen && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {[
                                  { k: 'Taxable', v: gridGst.base },
                                  ...gridGst.virtual.map((v) => ({
                                    k: /ROUND OFF/i.test(v.account) ? 'Round off' : v.account.replace(/^(OUTPUT|INPUT) /, ''),
                                    v: v.amount
                                  })),
                                  { k: '=', v: gridGst.total }
                                ].map((sp, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1.5"
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      color: '#33473E',
                                      background: '#F4F7F2',
                                      border: '1px solid #E4ECE3',
                                      borderRadius: 5,
                                      padding: '4px 8px'
                                    }}
                                  >
                                    {sp.k}
                                    <span style={fig(11, A.ink)}>{formatINR(sp.v)}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                            {/* A NOTE LINE ON A PURCHASE OR SALE LEDGER IS A STOCK
                                LINE. Pick the item, put a quantity and a rate to
                                it, and the figure follows — this is how the
                                quantity reaches stock. */}
                            {r.inventory && r.onInventory && (
                              <div
                                className="flex flex-wrap items-center gap-2"
                                style={{ padding: 6, borderRadius: 7, background: '#F4F7F2', border: '1px solid #E4ECE3' }}
                              >
                                <Select
                                  value={r.product_id ? String(r.product_id) : ''}
                                  onValueChange={(v) => r.onInventory!({ product_id: v ? Number(v) : null })}
                                  searchable
                                >
                                  <SelectTrigger
                                    className="h-8 min-w-[150px] max-w-[230px] gap-1 rounded-[5px] border-[#C3D2C6] bg-white px-2.5 text-left text-[12px] font-extrabold normal-case shadow-none"
                                    style={{ color: r.product_id ? A.ink : A.muted }}
                                  >
                                    <SelectValue placeholder="Pick item…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {noteProducts.map((x) => (
                                      <SelectItem key={String(x.id)} value={String(x.id)}>
                                        {String(x.code || x.name)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <input
                                  inputMode="decimal"
                                  value={r.qty || ''}
                                  placeholder="Qty"
                                  aria-label="Quantity"
                                  onChange={(e) => r.onInventory!({ qty: e.target.value.replace(/[^0-9.]/g, '') })}
                                  style={{ ...small, width: 84 }}
                                />
                                <span style={{ fontSize: 10.5, fontWeight: 800, color: A.muted }}>MT ×</span>
                                <input
                                  inputMode="decimal"
                                  value={r.rate || ''}
                                  placeholder="Rate"
                                  aria-label="Rate"
                                  onChange={(e) => r.onInventory!({ rate: e.target.value.replace(/[^0-9.]/g, '') })}
                                  style={{ ...small, width: 120 }}
                                />
                                <span style={{ fontSize: 10.5, fontWeight: 800, color: A.muted }}>₹/MT =</span>
                                <span style={fig(13)}>
                                  {invAuto ? formatINR(Math.round(n(r.qty) * n(r.rate) * 100) / 100) : '—'}
                                </span>
                              </div>
                            )}
                          </div>
                          <div
                            className="flex min-w-0 items-center"
                            style={{ padding: '0 12px', fontSize: 11.5, fontWeight: 700, color: '#33473E' }}
                          >
                            <span className="truncate">{r.group || '—'}</span>
                          </div>
                          {(['dr', 'cr'] as const).map((sd) => {
                            const raw = sd === 'dr' ? r.dr : r.cr
                            const onSide = r.side === sd
                            const caption = !onSide
                              ? ''
                              : invAuto
                                ? 'QTY × RATE'
                                : moneyAuto
                                  ? 'TOTAL OF PARTIES'
                                  : partyAuto
                                    ? gridGst.active
                                      ? 'FROM GST'
                                      : 'FROM ITEMS'
                                    : ''
                            return (
                              <div
                                key={sd}
                                className="flex flex-col items-end justify-center"
                                style={{ padding: '6px 10px', borderLeft: '1px solid #EAF0E9' }}
                              >
                                {!onSide ? (
                                  r.canFlip && !viewOnly ? (
                                    <button
                                      type="button"
                                      title={`Move this line to the ${sd === 'dr' ? 'debit' : 'credit'} side`}
                                      onClick={() => r.onAmount(r.side === 'dr' ? r.dr : r.cr, sd)}
                                      className="rounded-[5px] px-1.5 hover:bg-white"
                                      style={fig(13.5, '#C3D2C6')}
                                    >
                                      —
                                    </button>
                                  ) : (
                                    <span style={{ ...fig(13.5, '#C3D2C6'), padding: '0 6px' }}>—</span>
                                  )
                                ) : invAuto || moneyAuto || viewOnly ? (
                                  <span style={{ ...fig(13.5), padding: '0 4px' }}>{n(raw) > 0 ? formatINR(n(raw)) : '—'}</span>
                                ) : (
                                  <AmountInput
                                    value={raw}
                                    placeholder="0.00"
                                    onChange={(v) => r.onAmount(v, sd)}
                                    className={cn(
                                      'h-[34px] rounded-[6px] border-[#C3D2C6] px-2.5 text-[13px] font-bold',
                                      // Filled in from the items and the GST: it
                                      // reads as a figure, and can still be typed over.
                                      partyAuto && 'border-transparent bg-transparent hover:border-[#C3D2C6] hover:bg-white'
                                    )}
                                  />
                                )}
                                {caption && (
                                  <span
                                    style={{
                                      fontSize: 9.5,
                                      fontWeight: 800,
                                      letterSpacing: '.06em',
                                      color: A.muted,
                                      marginTop: 3,
                                      paddingRight: 4,
                                      whiteSpace: 'nowrap'
                                    }}
                                  >
                                    {caption}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                          {viewOnly ? (
                            <span />
                          ) : (
                            <button
                              type="button"
                              title={r.onRemove ? 'Remove this line' : 'A voucher needs at least this many lines'}
                              onClick={() => r.onRemove?.()}
                              className="flex items-center justify-center"
                              style={{ color: r.onRemove ? '#A8B8AE' : '#DCE7DB', cursor: r.onRemove ? 'pointer' : 'default' }}
                            >
                              <X className="h-[17px] w-[17px]" />
                            </button>
                          )}
                        </div>

                        {/* The working behind this line's figure, while open. */}
                        {r.onSplits && splitIsOpen && !noteChips && (
                          <div style={{ padding: `0 16px 12px ${indent}px`, background: '#F7FAF6', borderBottom: '1px solid #EAF0E9' }}>
                            <SplitPanel
                              rows={r.splits || []}
                              lineAmount={lineAmt}
                              onChange={(rs) => r.onSplits?.(rs)}
                              onClose={() => setSplitOpen(-1)}
                            />
                          </div>
                        )}

                        {/* BILL-WISE DETAILS — only where a balance is made of
                            bills. It offers the party's real pending references,
                            so Agst Ref settles a bill that exists rather than a
                            name somebody typed. */}
                        {r.billwise && (!viewOnly || r.allocs.length > 0) && (
                          <div style={{ padding: `10px 16px 12px ${indent}px`, background: '#FFFCF5', borderBottom: '1px solid #F1E6CC' }}>
                            <AllocPanel
                              look="card"
                              lineAmount={lineAmt}
                              allocs={r.allocs}
                              refs={refsCache[refsKey(r.account, r.refsSide)] || []}
                              linkRefs={linkCache[refsKey(r.account, r.refsSide)] || []}
                              onChange={(a) => r.onAllocs(a)}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {gridGst.active &&
                    gridGst.virtual.map((v) => {
                      const tt = tone(v.side)
                      return (
                        <div
                          key={v.account}
                          className="grid items-center"
                          title="Worked out from the GST chosen below — change the type or rate there"
                          style={{ gridTemplateColumns: V_GRID, height: 40, background: tt.rowBg, borderBottom: '1px solid #EAF0E9' }}
                        >
                          <div className="flex h-full items-center justify-center" style={{ borderLeft: `3px solid ${tt.mark}` }}>
                            <span style={sideChip(v.side)}>{v.side === 'dr' ? 'Dr' : 'Cr'}</span>
                          </div>
                          <div className="flex min-w-0 items-center gap-[9px]" style={{ padding: '0 12px' }}>
                            <Percent className="h-4 w-4 flex-none" style={{ color: '#A8B8AE' }} />
                            <span className="truncate" style={{ fontSize: 12, fontWeight: 800 }}>
                              {v.account}
                            </span>
                            <span
                              className="flex-none"
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                letterSpacing: '.08em',
                                color: '#33473E',
                                background: '#EAF0E9',
                                border: '1px solid #DCE7DB',
                                borderRadius: 3,
                                padding: '2px 6px'
                              }}
                            >
                              AUTO
                            </span>
                          </div>
                          <div className="truncate" style={{ padding: '0 12px', fontSize: 11.5, fontWeight: 700, color: '#33473E' }}>
                            {v.group}
                          </div>
                          {(['dr', 'cr'] as const).map((sd) => (
                            <div
                              key={sd}
                              className="flex h-full items-center justify-end"
                              style={{ padding: '0 14px', borderLeft: '1px solid #EAF0E9', ...fig(13, v.side === sd ? A.ink : '#C3D2C6') }}
                            >
                              {v.side === sd ? formatINR(v.amount) : '—'}
                            </div>
                          ))}
                          <span />
                        </div>
                      )
                    })}

                  {!viewOnly && (
                    <button
                      type="button"
                      onClick={() =>
                        structured
                          ? setPayLines((p) => [...p, blankPayLine()])
                          : // A new line opens on the side and for the figure
                            // that would balance the voucher — Tally's habit.
                            setLines((p) => [
                              ...p,
                              {
                                side: diff > 0 ? 'cr' : 'dr',
                                account: '',
                                group: '',
                                amount: Math.abs(diff) > 0.004 ? String(Math.abs(diff)) : '',
                                allocs: []
                              }
                            ])
                      }
                      className="flex h-10 w-full items-center gap-[7px] transition-colors hover:bg-[#F4F9F3]"
                      style={{ padding: '0 16px', borderBottom: '1px solid #EAF0E9', fontSize: 12, fontWeight: 800, color: '#0B6B45' }}
                    >
                      <CirclePlus className="h-[18px] w-[18px]" /> {structured ? 'Add a party line' : 'Add a line'}
                    </button>
                  )}
                  {/* SWAP THE WHOLE VOUCHER, Dr ⇄ Cr. On the grid every line
                      changes side. On a Payment or a Receipt the sides follow
                      the type, so swapping them IS the other type — it moves
                      what is typed there, asking first. */}
                  {!viewOnly && (structured ? true : lines.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (structured) {
                          switchType(vchType === 'PAYMENT' ? 'RECEIPT' : 'PAYMENT')
                          return
                        }
                        setLines((p) => p.map((l) => ({ ...l, side: l.side === 'dr' ? 'cr' : 'dr' })))
                      }}
                      title={
                        structured
                          ? `Swap every line, Dr ⇄ Cr — this makes it a ${vchType === 'PAYMENT' ? 'Receipt' : 'Payment'}`
                          : 'Swap every line, Dr ⇄ Cr — debits become credits and credits debits'
                      }
                      className="flex h-10 w-full items-center gap-[7px] transition-colors hover:bg-[#F4F9F3]"
                      style={{ padding: '0 16px', borderBottom: '1px solid #EAF0E9', fontSize: 12, fontWeight: 800, color: '#33473E' }}
                    >
                      <ArrowLeftRight className="h-[17px] w-[17px]" />
                      {structured ? `Swap Dr ⇄ Cr (make it a ${vchType === 'PAYMENT' ? 'Receipt' : 'Payment'})` : 'Swap Dr ⇄ Cr on every line'}
                    </button>
                  )}
                  {structured && !viewOnly && (
                    <button
                      type="button"
                      onClick={() => setPayAccounts((p) => [...p, blankPayLine()])}
                      className="flex h-10 w-full items-center gap-[7px] transition-colors hover:bg-[#F4F9F3]"
                      style={{ padding: '0 16px', borderBottom: '1px solid #EAF0E9', fontSize: 12, fontWeight: 800, color: '#0B6B45' }}
                    >
                      <Split className="h-[18px] w-[18px]" /> Split across another {vchType === 'PAYMENT' ? 'paying' : 'receiving'} account
                    </button>
                  )}

                  <div
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: V_GRID,
                      height: 46,
                      background: ok || empty ? 'linear-gradient(180deg,#F1F9F3,#E6F4EA)' : 'linear-gradient(180deg,#FFF9EC,#FFF1D6)'
                    }}
                  >
                    <span />
                    <span
                      className="flex items-center gap-2"
                      style={{ padding: '0 12px', fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: ok || empty ? A.good : A.warn }}
                    >
                      {ok || empty ? <CircleCheck className="h-[17px] w-[17px]" /> : <CircleAlert className="h-[17px] w-[17px]" />}
                      {ok ? 'TOTAL · Dr equals Cr' : empty ? 'TOTAL' : `TOTAL · out by ${formatINR(Math.abs(diff))}`}
                    </span>
                    <span />
                    <span style={{ padding: '0 14px', textAlign: 'right', ...fig(14, ok || empty ? A.good : A.warn) }}>{formatINR(drTotal)}</span>
                    <span style={{ padding: '0 14px', textAlign: 'right', ...fig(14, ok || empty ? A.good : A.warn) }}>{formatINR(crTotal)}</span>
                    <span />
                  </div>
                </div>
              </div>

              {gridNote && (
                <div style={{ ...card, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
                    <span style={{ ...cap, marginBottom: 0 }}>GST on this note</span>
                    <div className="flex flex-none gap-[3px]" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB', borderRadius: 7, padding: 3 }}>
                      {(
                        [
                          { k: 'none', label: 'No GST' },
                          { k: 'CGST_SGST', label: 'CGST + SGST' },
                          { k: 'IGST', label: 'IGST' }
                        ] as const
                      ).map((o) => {
                        const on = noteGstType === o.k
                        return (
                          <button
                            key={o.k}
                            type="button"
                            onClick={() => {
                              noteGstPicked.current = true
                              setNoteGstType(o.k)
                            }}
                            className="flex h-8 items-center whitespace-nowrap rounded-[5px] px-3.5"
                            style={{
                              background: on ? 'linear-gradient(180deg,#11503C,#0B3D2E)' : 'transparent',
                              color: on ? '#fff' : '#33473E',
                              boxShadow: on ? '0 4px 10px -4px rgba(11,61,46,.6)' : 'none',
                              fontSize: 12,
                              fontWeight: 800
                            }}
                          >
                            {o.label}
                          </button>
                        )
                      })}
                    </div>
                    <span className="flex-none" style={{ width: 1, height: 26, background: '#DCE7DB' }} />
                    <span style={{ ...cap, marginBottom: 0 }}>Rate</span>
                    <div className="flex flex-wrap items-center gap-1.5" style={{ opacity: noteGstType === 'none' ? 0.45 : 1 }}>
                      {[5, 12, 18, 28].map((rt) => {
                        const on = noteGstType !== 'none' && n(noteGstPct) === rt
                        return (
                          <button
                            key={rt}
                            type="button"
                            onClick={() => {
                              noteGstPicked.current = true
                              setNoteGstPct(String(rt))
                              // A rate picked on "No GST" means GST after all.
                              if (noteGstType === 'none') setNoteGstType('CGST_SGST')
                            }}
                            className="flex h-8 min-w-[48px] items-center justify-center rounded-[6px] px-2.5"
                            style={{
                              background: on ? 'linear-gradient(180deg,#11503C,#0B3D2E)' : '#fff',
                              color: on ? '#C7F03F' : '#33473E',
                              border: `1px solid ${on ? '#0B3D2E' : '#DCE7DB'}`,
                              boxShadow: on ? '0 4px 10px -4px rgba(11,61,46,.6)' : 'none',
                              ...fig(12, on ? '#C7F03F' : '#33473E')
                            }}
                          >
                            {rt}%
                          </button>
                        )
                      })}
                      <div
                        className="flex h-8 items-center gap-1"
                        style={{ border: '1px solid #C3D2C6', borderRadius: 6, background: '#fff', padding: '0 9px' }}
                      >
                        <input
                          value={noteGstPct}
                          onChange={(e) => {
                            noteGstPicked.current = true
                            setNoteGstPct(e.target.value.replace(/[^\d.]/g, ''))
                          }}
                          inputMode="decimal"
                          aria-label="GST rate"
                          style={{ width: 40, border: 0, outline: 0, textAlign: 'right', background: 'transparent', ...fig(12.5) }}
                        />
                        <span style={{ fontSize: 11, fontWeight: 800, color: A.muted }}>%</span>
                      </div>
                    </div>
                  </div>

                  {gridGst.mismatch && (
                    <div
                      className="flex items-start gap-2.5"
                      style={{
                        padding: '10px 12px',
                        borderRadius: 7,
                        background: 'linear-gradient(180deg,#FFF9EC,#FFF3DA)',
                        border: '1px solid #F1D9A6'
                      }}
                    >
                      <TriangleAlert className="h-[18px] w-[18px] flex-none" style={{ color: '#B07400' }} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#7A4E00', lineHeight: 1.55, textWrap: 'pretty' }}>
                        {baseGroup(gridGst.party?.group) === 'Sundry Debtors'
                          ? `${String(gridGst.party?.account)} is a customer, but the item line is a purchase account${gridGst.active ? ' (the GST is still worked out as OUTPUT, from the customer)' : ''}. A customer’s note normally goes against a sales account; a purchase return belongs on the supplier’s note.`
                          : `${String(gridGst.party?.account)} is a supplier, but the item line is a sales account${gridGst.active ? ' (the GST is still worked out as INPUT, from the supplier)' : ''}. A supplier’s note normally goes against a purchase account; a sales return belongs on the customer’s note.`}
                      </span>
                    </div>
                  )}

                  <div className="flex items-start gap-[9px]" style={{ fontSize: 11.5, fontWeight: 600, color: '#33473E', lineHeight: 1.5 }}>
                    <Calculator className="mt-px h-4 w-4 flex-none" style={{ color: '#12855A' }} />
                    <span style={{ fontVariantNumeric: FIGS }}>
                      {gridGst.manual
                        ? 'A GST ledger line has been entered by hand, so it is used as typed — remove it to have the GST worked out here.'
                        : noteGstType === 'none'
                          ? `No GST${gridGst.base > 0 ? ` — ${formatINR(gridGst.base)}` : ''}${gridGst.partyIdx >= 0 ? ` on ${String(gridGst.party?.account)}` : ''}`
                          : !(gridGst.pct > 0)
                            ? 'Pick the rate.'
                            : !(gridGst.base > 0)
                              ? `Enter the purchase or sale line — ${gridGst.taxSide === 'INPUT' ? 'input' : 'output'} GST is worked out from it.`
                              : `Taxable ${formatINR(gridGst.base)} + ${gridGst.taxSide.toLowerCase()} ${
                                  noteGstType === 'IGST' ? `IGST ${gridGst.pct}%` : `CGST ${gridGst.pct / 2}% + SGST ${gridGst.pct / 2}%`
                                } ${formatINR(gridGst.gst)}${
                                  Math.abs(gridGst.roundOff) > 0.004
                                    ? ` ${gridGst.roundOff > 0 ? '+' : '−'} round off ${formatINR(Math.abs(gridGst.roundOff))}`
                                    : ''
                                } = ${formatINR(gridGst.total)} ${gridGst.partyIdx >= 0 ? `on ${String(gridGst.party?.account)}` : '— put the party on a line to receive it'}`}
                    </span>
                  </div>
                </div>
              )}

              <div style={{ ...card, padding: '12px 16px' }}>
                <div style={cap}>Narration</div>
                <input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What this voucher is for" style={field} />
              </div>
            </div>
          </div>

          {wide && (
            <div className="flex min-h-0 flex-none flex-col gap-3" style={{ width: railW }}>
              <div className="sc flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto" style={{ paddingRight: 2 }}>
                <div
                  className="relative flex-none overflow-hidden"
                  style={{
                    borderRadius: 12,
                    background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 16px 34px -16px rgba(7,43,32,.7)',
                    padding: 18,
                    color: '#fff'
                  }}
                >
                  <div
                    className="pointer-events-none absolute rounded-full"
                    style={{ top: -60, right: -60, width: 180, height: 180, background: 'radial-gradient(circle,rgba(199,240,63,.18),transparent 70%)' }}
                  />
                  <div className="relative flex items-center gap-4">
                    {ring(86, 68, 30, 'linear-gradient(160deg,#0F4A38,#072B20)')}
                    <div className="min-w-0">
                      <div className="truncate" style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: '#8FBFA8' }}>
                        {typeLine}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 4, color: ringColor, fontVariantNumeric: FIGS }}>
                        {balHead}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#A9CDBB', marginTop: 4, lineHeight: 1.45, textWrap: 'pretty' }}>{balSub}</div>
                    </div>
                  </div>
                  <div className="relative mt-4 grid grid-cols-2 gap-[9px]">
                    {[
                      { k: 'Debit', v: drTotal },
                      { k: 'Credit', v: crTotal }
                    ].map((x) => (
                      <div
                        key={x.k}
                        className="min-w-0"
                        style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: '10px 12px' }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: '#8FBFA8' }}>{x.k}</div>
                        <div className="truncate" style={{ ...fig(15, '#fff'), marginTop: 5 }}>
                          {formatINR(x.v)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ ...card, display: 'flex', flexDirection: 'column' }}>
                  <div className="flex flex-none items-center gap-[9px]" style={{ padding: '12px 15px', borderBottom: '1px solid #EAF0E9' }}>
                    <ListTree className="h-[17px] w-[17px]" style={{ color: A.frame }} />
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>Posting preview</span>
                    <span
                      className="ml-auto"
                      style={{
                        ...fig(10.5, A.muted),
                        background: '#F4F7F2',
                        border: '1px solid #E4ECE3',
                        borderRadius: 10,
                        padding: '2px 8px'
                      }}
                    >
                      {ledgerCount}
                    </span>
                  </div>
                  <div style={{ padding: '4px 15px' }}>
                    {preview.length ? (
                      previewRows(true)
                    ) : (
                      <div style={{ padding: '14px 0', fontSize: 11.5, fontWeight: 600, color: A.muted }}>
                        Nothing to post yet — each ledger appears here as it gets a figure.
                      </div>
                    )}
                  </div>
                  {gridNote && (
                    <div
                      className="flex flex-none flex-col gap-1.5"
                      style={{ borderTop: '1px solid #EAF0E9', background: '#F7FAF6', padding: '11px 15px', borderRadius: '0 0 10px 10px' }}
                    >
                      {taxRows.map((tr) => (
                        <div key={tr.k} className="flex items-baseline justify-between gap-2.5">
                          <span style={{ fontSize: 11, fontWeight: tr.strong ? 800 : 600, color: tr.strong ? A.ink : A.muted }}>{tr.k}</span>
                          <span style={fig(tr.strong ? 13 : 11.5)}>{tr.v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-none flex-col gap-[9px]" style={{ paddingTop: 10, borderTop: '1px solid #DCE7DB' }}>
                <div className="flex items-start gap-2" style={{ padding: '0 2px' }}>
                  <StatusIcon className="mt-px h-4 w-4 flex-none" style={{ color: statusFg }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: statusFg, lineHeight: 1.45, textWrap: 'pretty', fontVariantNumeric: FIGS }}>
                    {status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-[9px]">
                  {discardBtn(false)}
                  {deleteBtn(false)}
                  {acceptBtn(false)}
                </div>
              </div>
            </div>
          )}
        </div>

        {!wide && (
          <div
            className="relative z-[3] flex flex-none flex-wrap items-center gap-3.5"
            style={{
              background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 55%,#072B20 100%)',
              boxShadow: '0 -10px 26px -14px rgba(7,43,32,.6),inset 0 1px 0 rgba(255,255,255,.08)',
              padding: '10px 18px',
              color: '#fff'
            }}
          >
            {dockOpen && (
              <div
                className="sc absolute overflow-y-auto"
                style={{
                  left: 18,
                  bottom: 'calc(100% + 8px)',
                  width: 'min(420px, calc(100% - 36px))',
                  maxHeight: 360,
                  background: '#fff',
                  color: A.ink,
                  border: '1px solid #DCE7DB',
                  borderRadius: 10,
                  boxShadow: '0 20px 40px -14px rgba(10,31,23,.4)'
                }}
              >
                <div className="flex items-center gap-[9px]" style={{ padding: '11px 14px', borderBottom: '1px solid #EAF0E9' }}>
                  <ListTree className="h-[17px] w-[17px]" style={{ color: A.frame }} />
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>Posting preview</span>
                  <span className="ml-auto" style={fig(10.5, A.muted)}>
                    {ledgerCount}
                  </span>
                </div>
                <div style={{ padding: '2px 14px 6px' }}>
                  {preview.length ? (
                    previewRows(false)
                  ) : (
                    <div style={{ padding: '12px 0', fontSize: 11.5, fontWeight: 600, color: A.muted }}>Nothing to post yet.</div>
                  )}
                </div>
              </div>
            )}

            {ring(44, 34, 19, A.frame)}
            <div className="min-w-0">
              <div style={{ fontSize: 14, fontWeight: 800, color: ringColor, fontVariantNumeric: FIGS }}>{balHead}</div>
              <div className="truncate" style={{ fontSize: 10.5, fontWeight: 600, color: '#A9CDBB', marginTop: 2 }}>
                {typeLine}
              </div>
            </div>
            <div className="flex gap-2">
              {[
                { k: 'Debit', v: drTotal },
                { k: 'Credit', v: crTotal }
              ].map((x) => (
                <div key={x.k} style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 7, padding: '6px 11px' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: '#8FBFA8' }}>{x.k}</div>
                  <div style={{ ...fig(13, '#fff'), marginTop: 2 }}>{formatINR(x.v)}</div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDockOpen((o) => !o)}
              className="flex h-10 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3"
              style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)', fontSize: 11.5, fontWeight: 800 }}
            >
              <ListTree className="h-[17px] w-[17px]" style={{ color: '#C7F03F' }} />
              {ledgerCount}
              {dockOpen ? <ChevronDown className="h-[17px] w-[17px]" /> : <ChevronUp className="h-[17px] w-[17px]" />}
            </button>
            <div className="flex-1" />
            <div className="flex gap-2" title={status}>
              {discardBtn(true)}
              {deleteBtn(true)}
              {acceptBtn(true)}
            </div>
          </div>
        )}
      </>
    )
  })()

  // ===========================================================================
  // DAY BOOK — every voucher in the period, day by day, the way it was posted.
  // ===========================================================================
  //
  // Each voucher reads as its own lines: the debit side with each ledger's
  // amount, the credit side the same, so a split payment shows both banks and
  // a purchase shows its goods, its GST and its TDS rather than one total
  // under the party's name. Days carry their own Dr and Cr; the total says
  // whether the book agrees. A row opens the voucher in a drawer — its lines,
  // its narration, ↑ ↓ through the rest — and from there the document behind
  // it or any of its ledgers. The gate's in and out sit on their own tab, as
  // the material half of the same day.
  const daybookWeb = (() => {
    const US = String.fromCharCode(31)
    const RS = String.fromCharCode(30)
    type DbLine = { id: number; name: string; amt: number }
    const linesOf = (r: Row, side: 'dr' | 'cr'): DbLine[] => {
      const raw = String((side === 'dr' ? r.dr_lines : r.cr_lines) || '')
      const out = raw
        .split(RS)
        .filter(Boolean)
        .map((x) => {
          const [id, name, amt] = x.split(US)
          // As stored. A few purchase lines carry half a paisa; rounding each
          // line would invent a difference the ledgers do not have.
          return { id: Number(id) || 0, name: String(name || ''), amt: Number(amt) || 0 }
        })
      if (out.length) return out
      // A server not yet restarted sends the names alone — one line per side
      // for the whole amount, which is still the voucher.
      const names = String((side === 'dr' ? r.dr_accounts || r.dr_account : r.cr_accounts || r.cr_account) || '—')
      return [{ id: 0, name: names, amt: n(r.amount) }]
    }
    const sideSum = (r: Row, side: 'dr' | 'cr'): number => linesOf(r, side).reduce((t, l) => t + l.amt, 0)
    const refOf = (r: Row): string =>
      String(r.order_invoice_no || r.sale_invoice_no || r.lc_no || r.bd_no || '').trim()
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const weekday = (iso: string): string => {
      const d = new Date(`${iso}T00:00:00`)
      return Number.isNaN(d.getTime()) ? '' : WD[d.getDay()]
    }
    const typeLabel = (t: unknown): string => {
      const s2 = String(t || '').toLowerCase()
      return s2.replace(/\b\w/g, (m) => m.toUpperCase())
    }
    const plural = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`
    const wide = vw >= 820
    const roomy = vw >= 1100

    // ── WHAT IS SHOWN ─────────────────────────────────────────────────────
    const FIELDS: [string, string, string][] = [
      ['all', 'All', 'Voucher no, ledger, narration or ref'],
      ['no', 'Vch no', 'Voucher no or ref, e.g. PAY/0313'],
      ['ledger', 'Ledger', 'Ledger name, e.g. BANK A/C'],
      ['narr', 'Narration', 'Words in the narration']
    ]
    const fk = FIELDS[dbField % FIELDS.length][0]
    const q = dbQuery.trim().toUpperCase()
    const match = (r: Row): boolean => {
      if (!q) return true
      const no = `${String(r.vch_no || '')} ${refOf(r)}`.toUpperCase()
      const led = [...linesOf(r, 'dr'), ...linesOf(r, 'cr')].map((l) => l.name).join(' ').toUpperCase()
      const narr = String(r.narration || '').toUpperCase()
      return fk === 'no' ? no.includes(q) : fk === 'ledger' ? led.includes(q) : fk === 'narr' ? narr.includes(q) : `${no} ${led} ${narr}`.includes(q)
    }
    // Oldest first, as a day book is read; within a day, in the order entered.
    const all = [...(dayRows as Row[])].sort((a, b) =>
      String(a.entry_date) === String(b.entry_date) ? Number(a.id) - Number(b.id) : String(a.entry_date) < String(b.entry_date) ? -1 : 1
    )
    const pre = all.filter(match)
    const typed = pre.filter((r) => !dbTypes.length || dbTypes.includes(String(r.vch_type || '').toUpperCase()))
    const money = (v: number): string => formatINR(v)
    const dbCf = colFilter<Row>(colF, 'daybook', typed, [
      { key: 'date', get: (r) => formatDate(r.entry_date), sort: 'num' },
      { key: 'voucher', get: (r) => r.vch_no },
      { key: 'type', get: (r) => r.vch_type },
      { key: 'dr', get: (r) => linesOf(r, 'dr').map((l) => l.name) },
      { key: 'drAmt', get: (r) => money(sideSum(r, 'dr')), sort: 'num' },
      { key: 'cr', get: (r) => linesOf(r, 'cr').map((l) => l.name) },
      { key: 'crAmt', get: (r) => money(sideSum(r, 'cr')), sort: 'num' }
    ])
    const vis = dbCf.rows
    dbVisRef.current = vis
    const totDr = vis.reduce((t, r) => t + sideSum(r, 'dr'), 0)
    const totCr = vis.reduce((t, r) => t + sideSum(r, 'cr'), 0)
    const agrees = Math.abs(totDr - totCr) < 0.005

    // The gate, on its own tab — searched by the same box.
    const gq = dbQuery.trim().toLowerCase()
    const gatePre = (dayGate as Row[]).filter(
      (g) =>
        !gq ||
        [g.gate_entry_no, g.tanker_no, g.supplier_name, g.customer_name, g.sale_customer, g.person, g.rec_type]
          .map((x) => String(x || ''))
          .join(' ')
          .toLowerCase()
          .includes(gq)
    )
    // The day header carries the date, so the row carries the time it came in
    // (and went out, where it has).
    const gateTime = (g: Row): string => {
      const tin = String(g.entry_time || '').slice(0, 5)
      const tout = String(g.out_time || '').slice(0, 5)
      return tin && tout ? `${tin} → ${tout}` : tin || '—'
    }
    const gtCf = colFilter<Row>(colF, 'daygate', gatePre, [
      { key: 'date', get: (g) => gateTime(g), sort: 'num' },
      { key: 'dir', get: (g) => (String(g.direction || 'in') === 'out' ? 'OUT' : 'IN') },
      { key: 'rec', get: (g) => g.rec_type || 'OIL' },
      { key: 'gate', get: (g) => g.gate_entry_no },
      { key: 'vehicle', get: (g) => [String(g.tanker_no || '—'), String(g.supplier_name || g.customer_name || g.sale_customer || g.person || '—')] },
      {
        key: 'qty',
        get: (g) => {
          const qq = n(g.received_qty) || n(g.dispatch_qty)
          return qq > 0 ? `${formatNum(qq)} ${String(g.uom || 'MT')}` : '—'
        },
        sort: 'num'
      },
      { key: 'status', get: (g) => (String(g.status || '') === 'completed' ? 'Done' : 'Pending') }
    ])
    const gateRows = gtCf.rows
    const isVch = dbTab === 'vch'

    // ── the period ─────────────────────────────────────────────────────────
    const today = todayISO()
    const weekStart = (() => {
      const d = new Date(`${today}T00:00:00`)
      const back = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - back)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const mStart = `${today.slice(0, 8)}01`
    const fyStart = (() => {
      const y = Number(today.slice(0, 4))
      return Number(today.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`
    })()
    const monthName = new Date(`${today}T00:00:00`).toLocaleString('en-IN', { month: 'long' })
    const presets: [string, string, string][] = [
      ['Today', today, today],
      ['This week', weekStart, today],
      [monthName, mStart, today],
      ['This FY', fyStart, today]
    ]
    const presetOn = (p: [string, string, string]): boolean => dbFrom === p[1] && dbTo === p[2]
    const anyPreset = presets.some(presetOn)
    // The period has its own presets; Clear all lets go of everything else.
    const hasFilter = !!q || dbTypes.length > 0 || dbCf.active > 0 || gtCf.active > 0
    const clearAll = (): void => {
      setDbQuery('')
      setDbTypes([])
      dbCf.clear()
      gtCf.clear()
    }

    // ── day groups ─────────────────────────────────────────────────────────
    const days: { date: string; rows: Row[] }[] = []
    for (const r of vis) {
      const d = String(r.entry_date || '').slice(0, 10)
      const last = days[days.length - 1]
      if (last && last.date === d) last.rows.push(r)
      else days.push({ date: d, rows: [r] })
    }
    const gateDays: { date: string; rows: Row[] }[] = []
    for (const g of [...gateRows].sort((a, b) => (String(a.entry_date) < String(b.entry_date) ? -1 : String(a.entry_date) > String(b.entry_date) ? 1 : 0))) {
      const d = String(g.entry_date || '').slice(0, 10)
      const last = gateDays[gateDays.length - 1]
      if (last && last.date === d) last.rows.push(g)
      else gateDays.push({ date: d, rows: [g] })
    }

    // ── the summary ────────────────────────────────────────────────────────
    const largest = vis.reduce<Row | null>((m, r) => (!m || sideSum(r, 'dr') > sideSum(m, 'dr') ? r : m), null)
    const gIn = gateRows.filter((g) => String(g.direction || 'in') !== 'out')
    const gOut = gateRows.filter((g) => String(g.direction || 'in') === 'out')
    const gQty = (list: Row[]): number => list.reduce((t, g) => t + (n(g.received_qty) || n(g.dispatch_qty)), 0)
    type Kpi = { k: string; v: string; sub: string; Icon: typeof BookOpen; accent: string; dark?: boolean; subOk?: boolean | null }
    const kpis: Kpi[] = isVch
      ? [
          { k: 'Total debit', v: money(totDr), sub: `${plural(vis.length, 'voucher')} in view`, Icon: ArrowDownLeft, accent: '#0B6B45', dark: true },
          {
            k: 'Total credit',
            v: money(totCr),
            sub: agrees ? 'Dr = Cr — the day book agrees' : `Dr ≠ Cr by ${money(Math.abs(totDr - totCr))}`,
            Icon: ArrowUpRight,
            accent: '#8C2F26',
            subOk: agrees
          },
          { k: 'Days posted', v: String(days.length), sub: `${formatDate(dbFrom)} → ${formatDate(dbTo)}`, Icon: CalendarDays, accent: '#1B4E82' },
          {
            k: 'Largest voucher',
            v: largest ? money(sideSum(largest, 'dr')) : '—',
            sub: largest ? `${typeLabel(largest.vch_type)} ${String(largest.vch_no || '')}`.trim() : '',
            Icon: TrendingUp,
            accent: '#4A3D8C'
          }
        ]
      : [
          { k: 'Material in', v: plural(gIn.length, 'entry', 'entries'), sub: `${formatNum(gQty(gIn))} received`, Icon: ArrowDownLeft, accent: '#0B6B45', dark: true },
          { k: 'Material out', v: plural(gOut.length, 'entry', 'entries'), sub: `${formatNum(gQty(gOut))} dispatched`, Icon: ArrowUpRight, accent: '#8A5300' },
          {
            k: 'Still pending',
            v: String(gateRows.filter((g) => String(g.status || '') !== 'completed').length),
            sub: 'not completed at the gate',
            Icon: Hourglass,
            accent: '#B3261E'
          },
          { k: 'Days', v: String(gateDays.length), sub: `${formatDate(dbFrom)} → ${formatDate(dbTo)}`, Icon: CalendarDays, accent: '#1B4E82' }
        ]
    const openSum = (el: HTMLElement): void => {
      const r = el.getBoundingClientRect()
      const W = window.innerWidth
      const H = window.innerHeight
      const width = Math.min(W - 24, 620)
      const left = Math.max(12, Math.min(r.right - width, W - width - 12))
      const top = Math.round(r.bottom + 8)
      setDbSel(null)
      setDbSum({ top, left: Math.round(left), width: Math.round(width), maxH: Math.max(220, H - top - 12) })
    }

    // ── Excel ──────────────────────────────────────────────────────────────
    const exportXl = (): void => {
      const range = `${formatDate(dbFrom)} to ${formatDate(dbTo)}`
      if (isVch) {
        void exportRowsToExcel({
          filename: `Day Book ${range}`,
          sheetName: 'Day Book',
          title: `Day Book — ${String(company?.name || '')}`,
          subtitle: range,
          columns: [
            { header: 'Date', key: 'entry_date', width: 12, value: (r) => formatDate(r.entry_date) },
            { header: 'Type', key: 'vch_type', width: 14 },
            { header: 'Vch no', key: 'vch_no', width: 16 },
            { header: 'Ref', key: 'ref', width: 16, value: (r) => refOf(r) },
            { header: 'Debit ledgers', key: 'drl', width: 40, value: (r) => linesOf(r, 'dr').map((l) => `${l.name} ${formatINR(l.amt)}`).join('; ') },
            { header: 'Dr ₹', key: 'dra', width: 16, align: 'right', numFmt: NUM_MONEY, value: (r) => sideSum(r, 'dr') },
            { header: 'Credit ledgers', key: 'crl', width: 40, value: (r) => linesOf(r, 'cr').map((l) => `${l.name} ${formatINR(l.amt)}`).join('; ') },
            { header: 'Cr ₹', key: 'cra', width: 16, align: 'right', numFmt: NUM_MONEY, value: (r) => sideSum(r, 'cr') },
            { header: 'Narration', key: 'narration', width: 50 }
          ],
          rows: vis
        })
      } else {
        void exportRowsToExcel({
          filename: `Gate in-out ${range}`,
          sheetName: 'Material',
          title: `Material in / out — ${String(company?.name || '')}`,
          subtitle: range,
          columns: [
            { header: 'Date', key: 'entry_date', width: 12, value: (g) => formatDate(g.entry_date) },
            { header: 'In / out', key: 'direction', width: 9, value: (g) => (String(g.direction || 'in') === 'out' ? 'OUT' : 'IN') },
            { header: 'Rec type', key: 'rec_type', width: 14, value: (g) => g.rec_type || 'OIL' },
            { header: 'Gate no', key: 'gate_entry_no', width: 14 },
            { header: 'Vehicle', key: 'tanker_no', width: 14 },
            { header: 'Party', key: 'party', width: 34, value: (g) => g.supplier_name || g.customer_name || g.sale_customer || g.person || '' },
            { header: 'Qty', key: 'qty', width: 12, align: 'right', numFmt: NUM_QTY, value: (g) => n(g.received_qty) || n(g.dispatch_qty) },
            { header: 'Unit', key: 'uom', width: 7, value: (g) => g.uom || 'MT' },
            { header: 'Status', key: 'status', width: 10, value: (g) => (String(g.status || '') === 'completed' ? 'Done' : 'Pending') }
          ],
          rows: gateRows
        })
      }
    }

    // ── pieces ─────────────────────────────────────────────────────────────
    const MONO_FIG: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: FIGS }
    const GRID = '168px minmax(200px,1fr) 140px minmax(200px,1fr) 140px 34px'
    const MAT_GRID = '104px 74px 120px 112px minmax(0,1fr) 120px 96px'
    const seg = (on: boolean): React.CSSProperties => ({
      height: 30,
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      padding: '0 10px',
      borderRadius: 5,
      background: on ? '#fff' : 'transparent',
      color: on ? '#0B3D2E' : '#5A6B62',
      boxShadow: on ? '0 1px 3px rgba(10,31,23,.12)' : 'none',
      fontSize: 11,
      fontWeight: 800,
      whiteSpace: 'nowrap'
    })
    const typeChip = (t: unknown, big = false): React.JSX.Element => {
      const tone = toneOf(t)
      return (
        <span
          style={{
            fontSize: big ? 10 : 9.5,
            fontWeight: 800,
            letterSpacing: '.05em',
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.bd}`,
            borderRadius: 3,
            padding: big ? '3px 8px' : '2px 6px',
            whiteSpace: 'nowrap'
          }}
        >
          {String(t || '')}
        </span>
      )
    }
    const toLedger = (id: number): void => {
      if (!id) return
      setDbSel(null)
      setLedgerId(id)
      setLgView('vouchers')
      setLgBack('daybook')
      setScreen('ledger')
    }

    // ── THE STRIP: the two halves of the day ───────────────────────────────
    const strip = (
      <div className="sc flex h-12 items-center gap-1.5 overflow-x-auto">
        {(
          [
            ['vch', 'Vouchers', ReceiptText, pre.length],
            ['gate', 'Material in / out', Truck, gatePre.length]
          ] as const
        ).map(([key, label, Icon, count]) => {
          const on = dbTab === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setDbTab(key)
                setDbSel(null)
                setDbSum(null)
              }}
              className="flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[7px] px-[13px]"
              style={{
                background: on ? 'linear-gradient(180deg,#D7F76A,#B5E33A)' : 'rgba(255,255,255,.06)',
                border: `1px solid ${on ? 'transparent' : 'rgba(255,255,255,.1)'}`,
                boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.5)' : 'none',
                color: on ? '#0B3D2E' : '#DCEFE4',
                fontSize: 12,
                fontWeight: 800
              }}
            >
              <Icon className="h-4 w-4" />
              {label}
              <span
                style={{
                  ...MONO_FIG,
                  fontSize: 10,
                  fontWeight: 600,
                  color: on ? '#0B3D2E' : '#C7F03F',
                  background: on ? 'rgba(11,61,46,.14)' : 'rgba(255,255,255,.1)',
                  borderRadius: 9,
                  padding: '1px 7px'
                }}
              >
                {count}
              </span>
            </button>
          )
        })}
        <div className="flex-1" />
        {roomy && (
          <div className="flex flex-none items-center gap-[7px] whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: '#8FBFA8' }}>
            <KeyboardIcon className="h-[15px] w-[15px]" />↑ ↓ move · Enter opens the document · F8 summary · Esc closes
          </div>
        )}
      </div>
    )

    // ── a voucher row ──────────────────────────────────────────────────────
    const lineName = (side: 'dr' | 'cr', name: string): React.JSX.Element => (
      <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.35, textWrap: 'pretty', minHeight: 16, overflowWrap: 'anywhere' }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, color: side === 'dr' ? '#0B6B45' : '#B3261E', marginRight: 6 }}>{side === 'dr' ? 'Dr' : 'Cr'}</span>
        {name}
      </span>
    )
    const amtLine = (side: 'dr' | 'cr', v: number, k: number): React.JSX.Element => (
      <span key={k} style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, lineHeight: 1.35, minHeight: 16, color: side === 'dr' ? '#0B6B45' : '#8C2F26', whiteSpace: 'nowrap' }}>
        {money(v)}
      </span>
    )
    let zebra = 0
    const vRow = (r: Row): React.JSX.Element => {
      const id = Number(r.id)
      const on = dbSel === id
      const bg = on ? '#EEF6E8' : zebra++ % 2 ? '#FCFDFB' : '#fff'
      const drl = linesOf(r, 'dr')
      const crl = linesOf(r, 'cr')
      const dr = dbDense ? [{ id: 0, name: drl.map((l) => l.name).join(', '), amt: sideSum(r, 'dr') }] : drl
      const cr = dbDense ? [{ id: 0, name: crl.map((l) => l.name).join(', '), amt: sideSum(r, 'cr') }] : crl
      const ref = refOf(r)
      const tags = vchTags.tagsOf(id)
      return (
        <div
          key={id}
          role="button"
          tabIndex={0}
          data-db-row={id}
          title="Open this voucher"
          onClick={() => setDbSel(id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setDbSel(id)
            }
          }}
          className="grid cursor-pointer items-stretch outline-none transition-colors hover:!bg-[#F6FAF4]"
          style={{ gridTemplateColumns: GRID, borderBottom: '1px solid #EEF3EE', background: bg, boxShadow: `inset 3px 0 0 ${on ? '#12855A' : 'transparent'}` }}
        >
          <div className="flex min-w-0 flex-col gap-1" style={{ padding: '9px 12px 9px 14px' }}>
            <div className="flex items-center gap-[7px]">{typeChip(r.vch_type)}</div>
            <span style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(r.vch_no || '—')}</span>
            {!!ref && !dbDense && <span style={{ ...MONO_FIG, fontSize: 10, fontWeight: 600, color: '#8CA396', whiteSpace: 'nowrap' }}>ref {ref}</span>}
          </div>
          <div className="flex min-w-0 flex-col gap-[5px]" style={{ padding: '9px 12px', borderLeft: '1px solid #EEF3EC' }}>
            {dr.map((l, k) => (
              <Fragment key={k}>{lineName('dr', l.name)}</Fragment>
            ))}
            {!dbDense && !!String(r.narration || '').trim() && (
              <span className="flex items-start gap-[5px]" style={{ fontSize: 10.5, fontWeight: 600, color: '#5A6B62', lineHeight: 1.45, marginTop: 2, textWrap: 'pretty' }}>
                <FileText className="mt-px h-[13px] w-[13px] flex-none" style={{ color: '#A8B8AE' }} />
                {String(r.narration)}
              </span>
            )}
            {!dbDense && tags.length > 0 && (
              <span className="mt-0.5 flex flex-wrap gap-1">
                {tags.map((t) => (
                  <TagChip key={String(t.id)} tag={t} small />
                ))}
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-[5px]" style={{ padding: '9px 12px', background: on ? 'transparent' : '#F7FBF8' }}>
            {dr.map((l, k) => amtLine('dr', l.amt, k))}
          </div>
          <div className="flex min-w-0 flex-col gap-[5px]" style={{ padding: '9px 12px', borderLeft: '2px solid #E4ECE3' }}>
            {cr.map((l, k) => (
              <Fragment key={k}>{lineName('cr', l.name)}</Fragment>
            ))}
          </div>
          <div className="flex flex-col items-end gap-[5px]" style={{ padding: '9px 12px', background: on ? 'transparent' : '#FDF9F8' }}>
            {cr.map((l, k) => amtLine('cr', l.amt, k))}
          </div>
          <div className="flex items-center justify-center">
            <ChevronRight className="h-[18px] w-[18px]" style={{ color: '#A8B8AE' }} />
          </div>
        </div>
      )
    }

    // ── the vouchers table ─────────────────────────────────────────────────
    const headCell = (content: React.ReactNode, extra?: React.CSSProperties): React.JSX.Element => (
      <span style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6, ...extra }}>{content}</span>
    )
    const vouchersTable = wide ? (
      <div ref={dbScrollRef} className="sc min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: 900 }}>
          <div
            className="grid items-stretch"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              gridTemplateColumns: GRID,
              height: 38,
              background: 'linear-gradient(180deg,#11503C,#0B3D2E)',
              color: '#8FBFA8',
              fontSize: 9.5,
              fontWeight: 800,
              letterSpacing: '.12em',
              textTransform: 'uppercase'
            }}
          >
            {headCell(
              <span className="inline-flex items-center gap-2" style={{ color: '#fff' }}>
                {dbCf.head('voucher', 'Voucher', { onDark: true })}
                {dbCf.head('date', 'Date', { onDark: true })}
              </span>,
              { padding: '0 14px' }
            )}
            {headCell(
              <>
                <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: '#3EC487' }} />
                {dbCf.head('dr', 'Debit · particulars', { onDark: true })}
              </>,
              { borderLeft: '1px solid rgba(255,255,255,.1)', color: '#9FE3BF' }
            )}
            {headCell(dbCf.head('drAmt', 'Dr ₹', { onDark: true, align: 'end' }), { justifyContent: 'flex-end', color: '#9FE3BF', background: 'rgba(62,196,135,.1)' })}
            {headCell(
              <>
                <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: '#E0705F' }} />
                {dbCf.head('cr', 'Credit · particulars', { onDark: true })}
              </>,
              { borderLeft: '2px solid rgba(199,240,63,.35)', color: '#F5B9B3' }
            )}
            {headCell(dbCf.head('crAmt', 'Cr ₹', { onDark: true, align: 'end' }), { justifyContent: 'flex-end', color: '#F5B9B3', background: 'rgba(224,112,95,.1)' })}
            <span />
          </div>

          {vis.length === 0 && (
            <div className="flex flex-col items-center gap-2" style={{ padding: '46px 20px' }}>
              <SearchX className="h-8 w-8" style={{ color: '#C3D2C6' }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>{all.length ? 'No vouchers match' : 'No voucher in this period'}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#5A6B62' }}>Widen the dates or clear a filter.</span>
            </div>
          )}

          {days.map((dy) => {
            const dDr = dy.rows.reduce((t, r) => t + sideSum(r, 'dr'), 0)
            const dCr = dy.rows.reduce((t, r) => t + sideSum(r, 'cr'), 0)
            return (
              <div key={dy.date}>
                <div
                  className="grid items-center"
                  style={{
                    position: 'sticky',
                    top: 38,
                    zIndex: 1,
                    gridTemplateColumns: GRID,
                    minHeight: 34,
                    background: '#E8F0E5',
                    borderTop: '1px solid #D6E2D6',
                    borderBottom: '1px solid #D6E2D6'
                  }}
                >
                  <div className="flex items-center gap-[9px] whitespace-nowrap" style={{ padding: '0 14px' }}>
                    <CalendarDays className="h-4 w-4" style={{ color: '#0B3D2E' }} />
                    <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#0B3D2E' }}>{formatDate(dy.date)}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: '#5A6B62' }}>{weekday(dy.date)}</span>
                  </div>
                  <span style={{ padding: '0 12px', fontSize: 10.5, fontWeight: 700, color: '#5A6B62' }}>{plural(dy.rows.length, 'voucher')}</span>
                  <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 11.5, fontWeight: 700, color: '#0B6B45' }}>{money(dDr)}</span>
                  <span style={{ borderLeft: '2px solid #CFDCCC', height: '100%' }} />
                  <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 11.5, fontWeight: 700, color: '#8C2F26' }}>{money(dCr)}</span>
                  <span />
                </div>
                {dy.rows.map(vRow)}
              </div>
            )
          })}

          <div
            className="grid items-center"
            style={{ position: 'sticky', bottom: 0, zIndex: 2, gridTemplateColumns: GRID, minHeight: 46, background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff' }}
          >
            <div className="flex items-center gap-2 whitespace-nowrap" style={{ padding: '0 14px' }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>Total</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: '#8FBFA8' }}>
                {plural(vis.length, 'voucher')} · {plural(days.length, 'day')}
              </span>
            </div>
            <div style={{ padding: '0 12px' }}>
              <span
                className="inline-flex items-center gap-[5px]"
                style={{ fontSize: 10.5, fontWeight: 800, color: agrees ? '#0B3D2E' : '#fff', background: agrees ? '#C7F03F' : '#B3261E', borderRadius: 3, padding: '3px 8px' }}
              >
                {agrees ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                {agrees ? 'Dr = Cr' : `Off by ${money(Math.abs(totDr - totCr))}`}
              </span>
            </div>
            <span className="flex h-full items-center justify-end" style={{ padding: '0 12px', ...MONO_FIG, fontSize: 13.5, fontWeight: 700, color: '#9FE3BF', background: 'rgba(62,196,135,.1)' }}>
              {money(totDr)}
            </span>
            <span style={{ borderLeft: '2px solid rgba(199,240,63,.35)', height: '100%' }} />
            <span className="flex h-full items-center justify-end" style={{ padding: '0 12px', ...MONO_FIG, fontSize: 13.5, fontWeight: 700, color: '#F5B9B3', background: 'rgba(224,112,95,.1)' }}>
              {money(totCr)}
            </span>
            <span />
          </div>
        </div>
      </div>
    ) : (
      <div ref={dbScrollRef} className="sc flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto" style={{ padding: 12 }}>
        {vis.length === 0 && (
          <div style={{ padding: '30px 12px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#5A6B62' }}>No vouchers match.</div>
        )}
        {days.map((dy) => (
          <div key={dy.date} className="flex flex-none flex-col gap-2">
            <div className="flex items-center gap-2">
              <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#0B3D2E' }}>{formatDate(dy.date)}</span>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: '#5A6B62' }}>{weekday(dy.date)}</span>
              <span className="h-px flex-1" style={{ background: '#DCE7DB' }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: '#5A6B62' }}>{plural(dy.rows.length, 'voucher')}</span>
            </div>
            {dy.rows.map((r) => {
              const tone = toneOf(r.vch_type)
              return (
                <button
                  key={String(r.id)}
                  type="button"
                  onClick={() => setDbSel(Number(r.id))}
                  className="flex-none overflow-hidden rounded-[8px] text-left"
                  style={{ background: '#fff', border: '1px solid #DCE7DB', borderLeft: `3px solid ${tone.fg}` }}
                >
                  <div className="flex items-center gap-2" style={{ padding: '10px 12px', borderBottom: '1px solid #EEF3EC' }}>
                    {typeChip(r.vch_type)}
                    <span style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 700 }}>{String(r.vch_no || '—')}</span>
                    <span className="ml-auto whitespace-nowrap" style={{ ...MONO_FIG, fontSize: 13, fontWeight: 700 }}>{money(sideSum(r, 'dr'))}</span>
                  </div>
                  <div className="flex flex-col gap-[5px]" style={{ padding: '9px 12px' }}>
                    {linesOf(r, 'dr').map((l, k) => (
                      <div key={`d${k}`} className="flex items-baseline gap-2">
                        <span className="flex-none" style={{ fontSize: 9.5, fontWeight: 800, color: '#0B6B45' }}>Dr</span>
                        <span className="min-w-0 flex-1" style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{l.name}</span>
                        <span className="flex-none" style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 700, color: '#0B6B45' }}>{money(l.amt)}</span>
                      </div>
                    ))}
                    {linesOf(r, 'cr').map((l, k) => (
                      <div key={`c${k}`} className="flex items-baseline gap-2" style={{ paddingLeft: 14 }}>
                        <span className="flex-none" style={{ fontSize: 9.5, fontWeight: 800, color: '#B3261E' }}>Cr</span>
                        <span className="min-w-0 flex-1" style={{ fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{l.name}</span>
                        <span className="flex-none" style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 700, color: '#8C2F26' }}>{money(l.amt)}</span>
                      </div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
        ))}
        <div className="flex flex-none flex-wrap items-center gap-2.5 rounded-[8px]" style={{ background: '#0B3D2E', color: '#fff', padding: '11px 13px' }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>Total</span>
          <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#9FE3BF' }}>Dr {money(totDr)}</span>
          <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#F5B9B3' }}>Cr {money(totCr)}</span>
        </div>
      </div>
    )

    // ── the material table ─────────────────────────────────────────────────
    const gth = (content: React.ReactNode, right?: boolean, first?: boolean): React.JSX.Element => (
      <span
        style={{
          padding: first ? '0 12px 0 14px' : '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: right ? 'flex-end' : 'flex-start',
          borderLeft: first ? undefined : '1px solid rgba(255,255,255,.1)'
        }}
      >
        {content}
      </span>
    )
    const gtd = (right?: boolean, first?: boolean): React.CSSProperties => ({
      padding: first ? '8px 12px 8px 14px' : '8px 10px',
      textAlign: right ? 'right' : 'left',
      borderLeft: first ? undefined : '1px solid #EEF3EC',
      minWidth: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: right ? 'flex-end' : 'flex-start'
    })
    const pill = (bg: string, fg: string): React.CSSProperties => ({
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.05em',
      background: bg,
      color: fg,
      borderRadius: 3,
      padding: '2px 7px',
      whiteSpace: 'nowrap'
    })
    const materialTable = (
      <div className="sc min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: 820 }}>
          <div
            className="grid items-stretch"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              gridTemplateColumns: MAT_GRID,
              height: 38,
              background: 'linear-gradient(180deg,#11503C,#0B3D2E)',
              color: '#8FBFA8',
              fontSize: 9.5,
              fontWeight: 800,
              letterSpacing: '.12em',
              textTransform: 'uppercase'
            }}
          >
            {gth(gtCf.head('date', 'Time', { onDark: true }), false, true)}
            {gth(gtCf.head('dir', 'In / out', { onDark: true }))}
            {gth(gtCf.head('rec', 'Rec type', { onDark: true }))}
            {gth(gtCf.head('gate', 'Gate no', { onDark: true }))}
            {gth(gtCf.head('vehicle', 'Vehicle · party', { onDark: true }))}
            {gth(gtCf.head('qty', 'Qty', { onDark: true, align: 'end' }), true)}
            {gth(gtCf.head('status', 'Status', { onDark: true }))}
          </div>
          {gateRows.length === 0 && (
            <div className="flex flex-col items-center gap-2" style={{ padding: '46px 20px' }}>
              <Truck className="h-8 w-8" style={{ color: '#C3D2C6' }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>Nothing crossed the gate</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#5A6B62' }}>Widen the dates or clear a filter.</span>
            </div>
          )}
          {gateDays.map((dy) => (
            <div key={dy.date}>
              <div
                className="flex items-center gap-[9px]"
                style={{ position: 'sticky', top: 38, zIndex: 1, minHeight: 32, padding: '0 14px', background: '#E8F0E5', borderTop: '1px solid #D6E2D6', borderBottom: '1px solid #D6E2D6' }}
              >
                <CalendarDays className="h-4 w-4" style={{ color: '#0B3D2E' }} />
                <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#0B3D2E' }}>{formatDate(dy.date)}</span>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: '#5A6B62' }}>{weekday(dy.date)}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: '#5A6B62' }}>· {plural(dy.rows.length, 'entry', 'entries')}</span>
              </div>
              {dy.rows.map((g, i) => {
                const out = String(g.direction || 'in') === 'out'
                const done = String(g.status || '') === 'completed'
                const qty = n(g.received_qty) || n(g.dispatch_qty)
                return (
                  <div key={String(g.id)} className="grid" style={{ gridTemplateColumns: MAT_GRID, borderBottom: '1px solid #EEF3EE', background: i % 2 ? '#FCFDFB' : '#fff' }}>
                    <span style={{ ...gtd(false, true), ...MONO_FIG, fontSize: 11.5, fontWeight: 600, color: '#33473E' }}>
                      {gateTime(g)}
                    </span>
                    <span style={gtd()}>
                      <span style={pill(out ? '#FFF4E0' : '#E9F5EE', out ? '#8A5300' : '#0B6B45')}>{out ? 'OUT' : 'IN'}</span>
                    </span>
                    <span style={{ ...gtd(), fontSize: 10.5, fontWeight: 800, color: '#5A6B62' }}>{String(g.rec_type || 'OIL')}</span>
                    <span style={{ ...gtd(), ...MONO_FIG, fontSize: 11, fontWeight: 600, color: '#5A6B62' }}>{String(g.gate_entry_no || '—')}</span>
                    <span style={{ ...gtd(), flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center' }}>
                      <span style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 700 }}>{String(g.tanker_no || '—')}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: '#5A6B62', marginTop: 2, overflowWrap: 'anywhere' }}>
                        {String(g.supplier_name || g.customer_name || g.sale_customer || g.person || '—')}
                      </span>
                    </span>
                    <span style={{ ...gtd(true), ...MONO_FIG, fontSize: 11.5, fontWeight: 700 }}>{qty > 0 ? `${formatNum(qty)} ${String(g.uom || 'MT')}` : '—'}</span>
                    <span style={gtd()}>
                      <span style={pill(done ? '#E9F5EE' : '#FFF4E0', done ? '#0B6B45' : '#8A5300')}>{done ? 'Done' : 'Pending'}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          <div
            className="flex items-center gap-3"
            style={{ position: 'sticky', bottom: 0, zIndex: 2, minHeight: 44, padding: '0 14px', background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff' }}
          >
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>Total</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#8FBFA8' }}>{plural(gateRows.length, 'entry', 'entries')}</span>
            <span className="flex-1" />
            <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#9FE3BF' }}>
              In {gIn.length} · {formatNum(gQty(gIn))}
            </span>
            <span style={{ ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#F3D48B' }}>
              Out {gOut.length} · {formatNum(gQty(gOut))}
            </span>
          </div>
        </div>
      </div>
    )

    // ── the drawer: one voucher, whole ─────────────────────────────────────
    const dv = dbSel == null ? null : vis.find((r) => Number(r.id) === dbSel) || all.find((r) => Number(r.id) === dbSel) || null
    const idx = dv ? vis.findIndex((r) => Number(r.id) === Number(dv.id)) : -1
    const drawer = dv
      ? (() => {
          const drl = linesOf(dv, 'dr')
          const crl = linesOf(dv, 'cr')
          const dr = sideSum(dv, 'dr')
          const cr = sideSum(dv, 'cr')
          const bal = Math.abs(dr - cr) < 0.005
          const tone = toneOf(dv.vch_type)
          const doc = docTarget(dv)
          const lines = [...drl.map((l) => ({ ...l, side: 'dr' as const })), ...crl.map((l) => ({ ...l, side: 'cr' as const }))]
          // The ledger the voucher is about: its biggest line — the party on a
          // purchase or a sale, not the goods account above it.
          const primary = lines.filter((l) => l.id).reduce<(typeof lines)[number] | null>((m, l) => (!m || l.amt > m.amt + 0.004 ? l : m), null)?.id || 0
          const tags = vchTags.tagsOf(Number(dv.id))
          const L_GRID = '44px minmax(0,1fr) 124px 124px'
          const navBtn = (on: boolean): React.CSSProperties => ({
            width: 32,
            height: 32,
            borderRadius: 6,
            background: 'rgba(255,255,255,.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: on ? 1 : 0.35,
            cursor: on ? 'pointer' : 'default'
          })
          return (
            <div role="dialog" aria-modal="true" aria-label={`${String(dv.vch_type)} ${String(dv.vch_no || '')}`} className="fixed inset-0 z-[60] flex justify-end">
              <div className="flex-1" style={{ background: 'rgba(7,30,22,.42)', backdropFilter: 'blur(2px)' }} onClick={() => setDbSel(null)} />
              <div className="flex flex-none flex-col" style={{ width: 'min(100%,560px)', background: '#F4F7F2', boxShadow: '-24px 0 50px -10px rgba(7,30,22,.4)' }}>
                <div className="relative flex-none overflow-hidden text-white" style={{ background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 60%,#072B20 100%)', padding: '16px 20px 18px' }}>
                  <div className="pointer-events-none absolute" style={{ top: -80, right: -60, width: 220, height: 220, borderRadius: '50%', background: 'radial-gradient(circle,rgba(199,240,63,.18),transparent 70%)' }} />
                  <div className="relative flex items-center gap-2">
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', background: tone.bg, color: tone.fg, borderRadius: 3, padding: '3px 8px' }}>{String(dv.vch_type || '')}</span>
                    <span style={{ ...MONO_FIG, fontSize: 11.5, fontWeight: 600, color: '#8FBFA8' }}>
                      {formatDate(dv.entry_date)} · {weekday(String(dv.entry_date || '').slice(0, 10))}
                    </span>
                    <div className="flex-1" />
                    <button type="button" title="Previous voucher (↑)" disabled={idx <= 0} onClick={() => idx > 0 && setDbSel(Number(vis[idx - 1].id))} style={navBtn(idx > 0)}>
                      <ChevronUp className="h-[19px] w-[19px]" />
                    </button>
                    <button
                      type="button"
                      title="Next voucher (↓)"
                      disabled={idx < 0 || idx >= vis.length - 1}
                      onClick={() => idx >= 0 && idx < vis.length - 1 && setDbSel(Number(vis[idx + 1].id))}
                      style={navBtn(idx >= 0 && idx < vis.length - 1)}
                    >
                      <ChevronDown className="h-[19px] w-[19px]" />
                    </button>
                    <button type="button" title="Close (Esc)" onClick={() => setDbSel(null)} style={navBtn(true)}>
                      <X className="h-[19px] w-[19px]" />
                    </button>
                  </div>
                  <div className="relative" style={{ ...MONO_FIG, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginTop: 10 }}>{String(dv.vch_no || '—')}</div>
                  <div className="relative mt-2 flex flex-wrap items-baseline gap-3">
                    <span style={{ ...MONO_FIG, fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: '#C7F03F' }}>{money(dr)}</span>
                    <span
                      className="inline-flex items-center gap-1"
                      style={{ fontSize: 10.5, fontWeight: 800, color: bal ? '#0B3D2E' : '#fff', background: bal ? '#C7F03F' : '#B3261E', borderRadius: 3, padding: '3px 8px' }}
                    >
                      {bal ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                      {bal ? 'Balanced · Dr = Cr' : `Off by ${money(Math.abs(dr - cr))}`}
                    </span>
                  </div>
                  <div className="relative" style={{ fontSize: 11, fontWeight: 600, color: '#8FBFA8', marginTop: 6 }}>
                    {idx >= 0 ? `Voucher ${idx + 1} of ${vis.length} in this view` : 'Outside the current filter'}
                    {dv.manual ? ' · entered by hand' : ' · posted by its document'}
                  </div>
                </div>

                <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: '16px 20px 20px' }}>
                  <div className="grid flex-none grid-cols-2 gap-2.5">
                    <div className="rounded-[8px]" style={{ background: '#fff', border: '1px solid #DCE7DB', padding: '10px 12px' }}>
                      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#5A6B62' }}>Reference</div>
                      <div style={{ ...MONO_FIG, fontSize: 12.5, fontWeight: 700, marginTop: 5, overflowWrap: 'anywhere' }}>{refOf(dv) || '—'}</div>
                    </div>
                    <div className="rounded-[8px]" style={{ background: '#fff', border: '1px solid #DCE7DB', padding: '10px 12px' }}>
                      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#5A6B62' }}>Lines</div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 5 }}>
                        {plural(lines.length, 'line')} · {drl.length} Dr, {crl.length} Cr
                      </div>
                    </div>
                  </div>

                  <div className="flex-none overflow-hidden rounded-[10px]" style={{ background: '#fff', border: '1px solid #DCE7DB', boxShadow: '0 1px 2px rgba(10,31,23,.04)' }}>
                    <div
                      className="grid items-center"
                      style={{ gridTemplateColumns: L_GRID, height: 34, background: '#F1F5EF', borderBottom: '1px solid #DCE7DB', fontSize: 9.5, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase', color: '#5A6B62' }}
                    >
                      <span />
                      <span style={{ padding: '0 10px' }}>Ledger</span>
                      <span style={{ padding: '0 12px', textAlign: 'right', color: '#0B6B45' }}>Debit</span>
                      <span style={{ padding: '0 12px', textAlign: 'right', color: '#8C2F26' }}>Credit</span>
                    </div>
                    {lines.map((l, k) => (
                      <button
                        key={k}
                        type="button"
                        disabled={!l.id}
                        title={l.id ? `Open the statement of ${l.name}` : undefined}
                        onClick={() => toLedger(l.id)}
                        className={cn('grid w-full items-center text-left', l.id && 'hover:bg-[#F6FAF4]')}
                        style={{ gridTemplateColumns: L_GRID, minHeight: 44, borderBottom: '1px solid #EEF3EC', color: '#0A1F17' }}
                      >
                        <span style={{ paddingLeft: 12 }}>
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 800,
                              color: l.side === 'dr' ? '#0B6B45' : '#B3261E',
                              background: l.side === 'dr' ? '#E9F5EE' : '#FDF0EE',
                              borderRadius: 3,
                              padding: '2px 6px'
                            }}
                          >
                            {l.side === 'dr' ? 'Dr' : 'Cr'}
                          </span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5" style={{ padding: '6px 10px' }}>
                          <span className="min-w-0" style={{ fontSize: 12, fontWeight: 700, textWrap: 'pretty', overflowWrap: 'anywhere' }}>{l.name}</span>
                          {!!l.id && <ArrowUpRight className="h-3.5 w-3.5 flex-none" style={{ color: '#A8B8AE' }} />}
                        </span>
                        <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#0B6B45' }}>{l.side === 'dr' ? money(l.amt) : ''}</span>
                        <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 12, fontWeight: 700, color: '#8C2F26' }}>{l.side === 'cr' ? money(l.amt) : ''}</span>
                      </button>
                    ))}
                    <div className="grid items-center" style={{ gridTemplateColumns: L_GRID, minHeight: 40, background: '#E8F0E5' }}>
                      <span />
                      <span style={{ padding: '0 10px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>Total</span>
                      <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 12.5, fontWeight: 700, color: '#0B6B45' }}>{money(dr)}</span>
                      <span style={{ padding: '0 12px', textAlign: 'right', ...MONO_FIG, fontSize: 12.5, fontWeight: 700, color: '#8C2F26' }}>{money(cr)}</span>
                    </div>
                  </div>

                  {!!String(dv.narration || '').trim() && (
                    <div className="flex-none rounded-[8px]" style={{ background: '#fff', border: '1px solid #DCE7DB', padding: '11px 13px' }}>
                      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#5A6B62' }}>Narration</div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#33473E', lineHeight: 1.55, marginTop: 5, textWrap: 'pretty' }}>{String(dv.narration)}</div>
                    </div>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-none flex-wrap items-center gap-1.5">
                      {tags.map((t) => (
                        <TagChip key={String(t.id)} tag={t} small />
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-none flex-wrap items-center gap-2.5" style={{ background: '#fff', borderTop: '1px solid #DCE7DB', padding: '12px 20px' }}>
                  <button
                    type="button"
                    disabled={!primary}
                    onClick={() => toLedger(primary)}
                    title={primary ? `Open the statement of ${lines.find((l) => l.id === primary)?.name || 'this ledger'}` : undefined}
                    className="flex h-10 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3.5"
                    style={{ border: '1.5px solid #C3D2C6', fontSize: 12, fontWeight: 800, color: '#33473E' }}
                  >
                    <Wallet className="h-[17px] w-[17px]" />
                    {wide ? `Open ${(lines.find((l) => l.id === primary)?.name || 'ledger').slice(0, 28)}` : 'Open in ledger'}
                  </button>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setDbSel(null)
                      openRowSource(dv, null)
                    }}
                    title={rowSourceTitle(dv)}
                    className="flex h-10 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-4"
                    style={{ background: 'linear-gradient(180deg,#145A43,#0B3D2E)', color: '#C7F03F', fontSize: 12, fontWeight: 800, boxShadow: '0 8px 18px -10px rgba(11,61,46,.9)' }}
                  >
                    {doc ? <ArrowUpRight className="h-[17px] w-[17px]" /> : <Pencil className="h-[17px] w-[17px]" />}
                    {doc ? `Open ${doc.label.toLowerCase() === 'sales' ? 'the invoice' : doc.label === 'Purchase' ? 'the bill' : doc.label}` : dv.manual ? 'Alter voucher' : 'Open voucher'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()
      : null

    // ── the summary panel ──────────────────────────────────────────────────
    const summary = dbSum ? (
      <div role="dialog" aria-modal="true" aria-label="Day book summary" className="fixed inset-0 z-[55]">
        <div className="absolute inset-0" style={{ background: 'rgba(7,30,22,.28)', backdropFilter: 'blur(1.5px)' }} onClick={() => setDbSum(null)} />
        <div
          className="sc absolute overflow-y-auto"
          style={{
            top: dbSum.top,
            left: dbSum.left,
            width: dbSum.width,
            maxHeight: dbSum.maxH,
            background: 'linear-gradient(180deg,#FBFDFA,#F1F6EE)',
            border: '1px solid #D6E2D6',
            borderRadius: 14,
            boxShadow: '0 30px 60px -20px rgba(7,30,22,.55),0 2px 6px rgba(7,30,22,.08)',
            padding: 14
          }}
        >
          <div className="mb-3 flex items-center gap-[9px]">
            <PieChart className="h-[18px] w-[18px]" style={{ color: '#0B6B45' }} />
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: '#0B3D2E' }}>{isVch ? 'Vouchers summary' : 'Material summary'}</span>
            <span style={{ ...MONO_FIG, fontSize: 10.5, fontWeight: 600, color: '#5A6B62' }}>
              {formatDate(dbFrom)} → {formatDate(dbTo)}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              title="Close (Esc)"
              onClick={() => setDbSum(null)}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px]"
              style={{ background: '#fff', border: '1px solid #DCE7DB' }}
            >
              <X className="h-[17px] w-[17px]" style={{ color: '#33473E' }} />
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))' }}>
            {kpis.map((k) => (
              <div
                key={k.k}
                className="relative min-w-0 overflow-hidden rounded-[12px]"
                style={{
                  background: k.dark ? 'linear-gradient(160deg,#145A43 0%,#0B3D2E 55%,#072B20 100%)' : '#fff',
                  border: `1px solid ${k.dark ? 'transparent' : '#DCE7DB'}`,
                  boxShadow: k.dark ? 'inset 0 1px 0 rgba(255,255,255,.1),0 14px 30px -16px rgba(7,43,32,.8)' : '0 1px 2px rgba(10,31,23,.04)',
                  padding: '14px 16px'
                }}
              >
                <div
                  className="pointer-events-none absolute"
                  style={{ top: -50, right: -50, width: 140, height: 140, borderRadius: '50%', background: `radial-gradient(circle,${k.dark ? 'rgba(199,240,63,.22)' : `${k.accent}1A`},transparent 70%)` }}
                />
                <div className="relative flex items-center gap-2">
                  <k.Icon className="h-[17px] w-[17px]" style={{ color: k.dark ? '#C7F03F' : k.accent }} />
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: k.dark ? '#8FBFA8' : '#5A6B62' }}>{k.k}</span>
                </div>
                <div className="relative" style={{ ...MONO_FIG, fontSize: 20, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 8, color: k.dark ? '#fff' : k.accent, whiteSpace: 'nowrap' }}>
                  {k.v}
                </div>
                <div className="relative flex items-center gap-[5px]" style={{ fontSize: 11, fontWeight: 600, color: k.dark ? '#8FBFA8' : '#5A6B62', marginTop: 4 }}>
                  {k.subOk === true && <CircleCheck className="h-3.5 w-3.5" style={{ color: '#0B6B45' }} />}
                  {k.subOk === false && <CircleAlert className="h-3.5 w-3.5" style={{ color: '#B3261E' }} />}
                  {k.sub}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-[11px] flex items-center gap-1.5" style={{ fontSize: 10.5, fontWeight: 600, color: '#5A6B62' }}>
            <FilterX className="h-3.5 w-3.5" style={{ color: '#A8B8AE' }} />
            Figures follow the filters on screen.
          </div>
        </div>
      </div>
    ) : null

    // ── the body ───────────────────────────────────────────────────────────
    const typeKeys = Array.from(new Set(pre.map((r) => String(r.vch_type || '').toUpperCase()).filter(Boolean)))
    const body = (
      <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: wide ? '16px 20px 20px' : 12, background: '#EEF3EC' }}>
        <div
          className="flex flex-1 flex-col overflow-hidden"
          style={{ minHeight: 340, background: '#fff', border: '1px solid #DCE7DB', borderRadius: 10, boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)' }}
        >
          <div className="flex flex-none flex-col gap-2.5" style={{ padding: '11px 14px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)' }}>
            <div className="flex flex-wrap items-center gap-[9px]">
              <div
                className="flex h-9 items-center overflow-hidden"
                style={{ border: `1px solid ${q ? '#12855A' : '#DCE7DB'}`, borderRadius: 7, background: '#fff', boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)', flex: '1 1 300px', maxWidth: 440 }}
              >
                {isVch && (
                  <button
                    type="button"
                    onClick={() => setDbField((f) => (f + 1) % FIELDS.length)}
                    title="Change what the search looks at"
                    className="flex h-full flex-none items-center gap-[5px] whitespace-nowrap"
                    style={{ padding: '0 9px 0 10px', background: '#F4F7F2', borderRight: '1px solid #DCE7DB', fontSize: 11, fontWeight: 800, color: '#0B3D2E' }}
                  >
                    {FIELDS[dbField % FIELDS.length][1]}
                    <ChevronsUpDown className="h-[14px] w-[14px]" />
                  </button>
                )}
                <Search className="ml-[9px] h-[17px] w-[17px] flex-none" style={{ color: '#5A6B62' }} />
                <input
                  value={dbQuery}
                  onChange={(e) => setDbQuery(e.target.value)}
                  placeholder={isVch ? FIELDS[dbField % FIELDS.length][2] : 'Gate no, vehicle or party'}
                  className="min-w-0 flex-1 border-0 bg-transparent outline-none"
                  style={{ padding: '0 9px', fontSize: 12, fontWeight: 600, color: '#0A1F17' }}
                />
                {!!dbQuery && (
                  <button type="button" onClick={() => setDbQuery('')} title="Clear the search" className="mr-1.5 flex h-6 w-6 flex-none items-center justify-center rounded-[5px] hover:bg-[#EEF3EC]">
                    <X className="h-3.5 w-3.5" style={{ color: '#5A6B62' }} />
                  </button>
                )}
              </div>
              <div className="flex h-9 items-center gap-1.5" style={{ padding: '0 6px 0 10px', border: `1px solid ${anyPreset ? '#DCE7DB' : '#12855A'}`, borderRadius: 7, background: '#fff' }}>
                <CalendarRange className="h-4 w-4 flex-none" style={{ color: '#5A6B62' }} />
                <div className="w-[118px]">
                  <DatePicker value={dbFrom} onChange={(v) => setDbFrom(v || '')} max={dbTo || undefined} className="!h-7 !border-0 !bg-transparent !px-1 !text-[11.5px] !shadow-none" />
                </div>
                <span style={{ fontSize: 11, color: '#8CA396' }}>→</span>
                <div className="w-[118px]">
                  <DatePicker value={dbTo} onChange={(v) => setDbTo(v || '')} min={dbFrom || undefined} max={today} className="!h-7 !border-0 !bg-transparent !px-1 !text-[11.5px] !shadow-none" />
                </div>
              </div>
              <div className="flex gap-0.5" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB', borderRadius: 7, padding: 2 }}>
                {presets.map((p) => (
                  <button
                    key={p[0]}
                    type="button"
                    onClick={() => {
                      setDbFrom(p[1])
                      setDbTo(p[2])
                    }}
                    style={seg(presetOn(p))}
                  >
                    {p[0]}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              {isVch && wide && (
                <div className="flex gap-0.5" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB', borderRadius: 7, padding: 2 }}>
                  <button type="button" title="Every ledger line with its own amount" onClick={() => setDbDense(false)} style={seg(!dbDense)}>
                    <LayoutList className="h-[15px] w-[15px]" />
                    Detailed
                  </button>
                  <button type="button" title="One line per voucher" onClick={() => setDbDense(true)} style={seg(dbDense)}>
                    <AlignJustify className="h-[15px] w-[15px]" />
                    Compact
                  </button>
                </div>
              )}
              <button
                ref={dbSumBtnRef}
                type="button"
                title="Show the summary (F8)"
                onClick={(e) => (dbSum ? setDbSum(null) : openSum(e.currentTarget))}
                className="flex h-9 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3"
                style={{
                  border: `1px solid ${dbSum ? 'transparent' : '#C3D2C6'}`,
                  background: dbSum ? 'linear-gradient(180deg,#145A43,#0B3D2E)' : '#fff',
                  color: dbSum ? '#C7F03F' : '#0B3D2E',
                  boxShadow: dbSum ? '0 8px 18px -10px rgba(11,61,46,.9)' : 'none',
                  fontSize: 12,
                  fontWeight: 800
                }}
              >
                <PieChart className="h-[17px] w-[17px]" />
                Summary
                {dbSum ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              <button
                type="button"
                title="Export to Excel"
                onClick={exportXl}
                className="flex h-9 w-9 items-center justify-center rounded-[7px]"
                style={{ background: '#0B6B45', boxShadow: '0 6px 14px -8px rgba(11,107,69,.8)' }}
              >
                <Download className="h-[18px] w-[18px] text-white" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {isVch ? (
                <>
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: '#5A6B62', marginRight: 2 }}>Voucher type</span>
                  {typeKeys.map((t) => {
                    const on = dbTypes.includes(t)
                    const tone = toneOf(t)
                    const count = pre.filter((r) => String(r.vch_type || '').toUpperCase() === t).length
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setDbTypes((p) => (on ? p.filter((x) => x !== t) : [...p, t]))}
                        title={on ? `Showing ${typeLabel(t)} — click to drop it` : `Show only ${typeLabel(t)}`}
                        className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[14px] px-2.5"
                        style={{ border: `1px solid ${on ? tone.fg : '#DCE7DB'}`, background: on ? tone.bg : '#fff', color: on ? tone.fg : '#33473E', fontSize: 11, fontWeight: 800 }}
                      >
                        <span className="h-[7px] w-[7px] rounded-full" style={{ background: tone.fg }} />
                        {typeLabel(t)}
                        <span style={{ ...MONO_FIG, fontSize: 10, fontWeight: 600, opacity: 0.75 }}>{count}</span>
                      </button>
                    )
                  })}
                  {typeKeys.length === 0 && <span style={{ fontSize: 11, fontWeight: 600, color: '#8CA396' }}>No voucher in this period</span>}
                </>
              ) : (
                <span style={{ fontSize: 11, fontWeight: 700, color: '#5A6B62' }}>
                  What crossed the gate in the period — {gIn.length} in, {gOut.length} out
                </span>
              )}
              {hasFilter && (
                <button type="button" onClick={clearAll} className="flex h-7 items-center gap-[5px] px-[9px]" style={{ color: '#0B6B45', fontSize: 11, fontWeight: 800 }}>
                  <FilterX className="h-[15px] w-[15px]" />
                  Clear all
                </button>
              )}
              <span className="ml-auto whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: '#5A6B62' }}>
                {isVch ? `${vis.length} of ${all.length} shown` : `${gateRows.length} of ${(dayGate as Row[]).length} shown`}
              </span>
            </div>
          </div>

          {isVch ? vouchersTable : materialTable}
        </div>
        {drawer}
        {summary}
      </div>
    )

    return { strip, body }
  })()

  // ===========================================================================
  // TRIAL BALANCE — group by group, Dr against Cr.
  // ===========================================================================
  const trialWeb = (() => {
    const bal = (v: number): string =>
      Math.abs(v) < 0.005 ? '—' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`
    const balFg = (v: number): string => (Math.abs(v) < 0.005 ? A.muted : v > 0 ? A.dr : A.cr)
    const money = (v: number): string => (Math.abs(v) < 0.005 ? '—' : formatINR(v))
    const tbCf = colFilter<Row>(colF, 'trial', ((tb?.rows as Row[]) || []).filter((r) => Number(r.company_hidden) !== 1), [
      { key: 'group', get: (r) => r.acc_group || 'Unclassified' },
      { key: 'ledger', get: (r) => r.name },
      { key: 'opening', get: (r) => bal(n(r.opening)), sort: 'num' },
      { key: 'dr', get: (r) => money(n(r.period_dr)), sort: 'num' },
      { key: 'cr', get: (r) => money(n(r.period_cr)), sort: 'num' },
      { key: 'closing', get: (r) => bal(n(r.closing)), sort: 'num' }
    ])
    const rows = tbCf.rows
    // Narrowed by a funnel, the period totals are the shown ledgers' own sum.
    const totals: Row = tbCf.active
      ? {
          ...((tb?.totals as Row) || {}),
          period_dr: rows.reduce((t, r) => t + n(r.period_dr), 0),
          period_cr: rows.reduce((t, r) => t + n(r.period_cr), 0)
        }
      : (tb?.totals as Row) || {}
    const grouped = (() => {
      const byGroup = new Map<string, Row[]>()
      for (const r of rows) {
        const g = String(r.acc_group || 'Unclassified')
        if (!byGroup.has(g)) byGroup.set(g, [])
        ;(byGroup.get(g) as Row[]).push(r)
      }
      const order = [
        ...TB_GROUP_ORDER.filter((g) => byGroup.has(g)),
        // Anything the mill has named itself still has to appear — a group
        // left off the reading order would silently drop its ledgers.
        ...Array.from(byGroup.keys())
          .filter((g) => !TB_GROUP_ORDER.includes(g))
          .sort()
      ]
      return order.map((g) => {
        const gr = byGroup.get(g) as Row[]
        return {
          name: g,
          rows: gr,
          opening: gr.reduce((t, r) => t + n(r.opening), 0),
          dr: gr.reduce((t, r) => t + n(r.period_dr), 0),
          cr: gr.reduce((t, r) => t + n(r.period_cr), 0),
          closing: gr.reduce((t, r) => t + n(r.closing), 0)
        }
      })
    })()
    const totDr = n(totals.closing_dr)
    const totCr = n(totals.closing_cr)
    const agrees = Math.abs(totDr - totCr) < 0.02
    const totOpening = grouped.reduce((t, g) => t + g.opening, 0)
    const totClosing = grouped.reduce((t, g) => t + g.closing, 0)
    const TB_GRID = 'minmax(0,1fr) 148px 148px 148px 160px'
    const th = (label: React.ReactNode, right?: boolean, first?: boolean): React.JSX.Element => (
      <span
        style={{
          padding: '7px 10px',
          textAlign: right ? 'right' : 'left',
          borderLeft: first ? undefined : '1px solid rgba(255,255,255,.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: right ? 'flex-end' : 'flex-start'
        }}
      >
        {label}
      </span>
    )
    const fig = (right = true): React.CSSProperties => ({
      padding: '7px 10px',
      textAlign: right ? 'right' : 'left',
      fontFamily: MONO, fontVariantNumeric: FIGS,
      fontSize: 11.5,
      fontWeight: 700,
      whiteSpace: 'nowrap'
    })

    return (
      <div className="sc min-h-0 flex-1 overflow-y-auto" style={{ padding: '12px 14px 16px' }}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase', color: A.muted }}>
            Trial balance
          </span>
          <span
            style={{
              fontFamily: MONO, fontVariantNumeric: FIGS,
              fontSize: 10.5,
              fontWeight: 700,
              color: A.muted,
              background: A.fill,
              border: `1px solid ${A.edgeSoft}`,
              borderRadius: 2,
              padding: '1px 6px'
            }}
          >
            {periodLabel}
          </span>
          <span className="h-px min-w-[20px] flex-1" style={{ background: A.edgeSoft }} />
          <span className="flex items-center gap-1.5" style={{ fontSize: 11, fontWeight: 800, color: agrees ? A.good : A.bad }}>
            {agrees ? <Check className="h-4 w-4" /> : <Info className="h-4 w-4" />}
            {agrees ? 'Dr and Cr agree' : `Out by ${formatINR(Math.abs(totDr - totCr))}`}
          </span>
        </div>

        <div className="mt-2.5 overflow-hidden rounded-[3px]" style={{ border: `1px solid ${A.edge}`, background: '#fff' }}>
          <div
            className="grid text-[9px] font-extrabold uppercase tracking-[.12em]"
            style={{ gridTemplateColumns: TB_GRID, background: A.frame, color: A.inkSky }}
          >
            {th(
              <span className="inline-flex items-center gap-3">
                Particulars {tbCf.head('group', 'Group', { onDark: true })} {tbCf.head('ledger', 'Ledger', { onDark: true })}
              </span>,
              false,
              true
            )}
            {th(tbCf.head('opening', 'Opening', { onDark: true, align: 'end' }), true)}
            {th(tbCf.head('dr', 'Debit', { onDark: true, align: 'end' }), true)}
            {th(tbCf.head('cr', 'Credit', { onDark: true, align: 'end' }), true)}
            {th(tbCf.head('closing', 'Closing', { onDark: true, align: 'end' }), true)}
          </div>

          {grouped.length === 0 && (
            <div style={{ padding: '22px 12px', textAlign: 'center', fontSize: 11.5, fontWeight: 600, color: A.muted }}>
              Nothing posted in this period.
            </div>
          )}

          {grouped.map((g) => {
            // A ledger funnel opens the groups it leaves, or the match would hide.
            const open = !!tbOpen[g.name] || tbCf.active > 0
            return (
              <div key={g.name}>
                <button
                  type="button"
                  onClick={() => setTbOpen((o) => ({ ...o, [g.name]: !o[g.name] }))}
                  className="grid w-full text-left"
                  style={{ gridTemplateColumns: TB_GRID, background: A.fill2, borderBottom: `1px solid ${A.edgeSoft}` }}
                >
                  <span style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <ChevronRight
                      className="h-[15px] w-[15px] flex-none transition-transform"
                      style={{ color: A.muted, transform: open ? 'rotate(90deg)' : 'none' }}
                    />
                    <span className="min-w-0 truncate" style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.02em' }}>
                      {g.name}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: A.muted, flex: 'none' }}>
                      · {g.rows.length} {g.rows.length === 1 ? 'ledger' : 'ledgers'}
                    </span>
                  </span>
                  <span style={{ ...fig(), borderLeft: `1px solid ${A.edgeSoft}`, color: A.muted }}>{bal(g.opening)}</span>
                  <span style={{ ...fig(), borderLeft: `1px solid ${A.edgeSoft}` }}>{money(g.dr)}</span>
                  <span style={{ ...fig(), borderLeft: `1px solid ${A.edgeSoft}` }}>{money(g.cr)}</span>
                  <span style={{ ...fig(), borderLeft: `1px solid ${A.edgeSoft}`, color: balFg(g.closing) }}>{bal(g.closing)}</span>
                </button>
                {open &&
                  g.rows.map((r) => (
                    <button
                      key={String(r.id)}
                      type="button"
                      title="Open this ledger's statement"
                      onClick={() => {
                        setLedgerId(Number(r.id))
                        setLgView('vouchers')
                        setScreen('ledger')
                        setLgBack('trial')
                      }}
                      className="grid w-full text-left"
                      style={{ gridTemplateColumns: TB_GRID, borderBottom: `1px solid ${A.rule}` }}
                    >
                      <span
                        className="truncate"
                        style={{ padding: '6px 10px 6px 32px', fontSize: 11.5, fontWeight: 600, minWidth: 0 }}
                      >
                        {String(r.name)}
                      </span>
                      <span style={{ ...fig(), padding: '6px 10px', fontSize: 11, fontWeight: 600, borderLeft: `1px solid ${A.rule}`, color: A.muted }}>
                        {bal(n(r.opening))}
                      </span>
                      <span style={{ ...fig(), padding: '6px 10px', fontSize: 11, fontWeight: 600, borderLeft: `1px solid ${A.rule}` }}>
                        {money(n(r.period_dr))}
                      </span>
                      <span style={{ ...fig(), padding: '6px 10px', fontSize: 11, fontWeight: 600, borderLeft: `1px solid ${A.rule}` }}>
                        {money(n(r.period_cr))}
                      </span>
                      <span style={{ ...fig(), padding: '6px 10px', fontSize: 11, borderLeft: `1px solid ${A.rule}`, color: balFg(n(r.closing)) }}>
                        {bal(n(r.closing))}
                      </span>
                    </button>
                  ))}
              </div>
            )
          })}

          <div className="grid" style={{ gridTemplateColumns: TB_GRID, background: A.frame, color: '#fff' }}>
            <span
              style={{ padding: '9px 10px', fontSize: 10.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: A.inkSky }}
            >
              Grand total
            </span>
            {/* A netted zero IS the answer here, so it says Nil rather than the
                dash that everywhere else means nothing was posted. */}
            <span style={{ ...fig(), padding: '9px 10px', fontSize: 12, borderLeft: '1px solid rgba(255,255,255,.14)' }}>
              {Math.abs(totOpening) < 0.005 ? 'Nil' : bal(totOpening)}
            </span>
            <span style={{ ...fig(), padding: '9px 10px', fontSize: 12.5, color: A.accent, borderLeft: '1px solid rgba(255,255,255,.14)' }}>
              {formatINR(n(totals.period_dr))}
            </span>
            <span style={{ ...fig(), padding: '9px 10px', fontSize: 12.5, color: A.accent, borderLeft: '1px solid rgba(255,255,255,.14)' }}>
              {formatINR(n(totals.period_cr))}
            </span>
            <span style={{ ...fig(), padding: '9px 10px', fontSize: 12, borderLeft: '1px solid rgba(255,255,255,.14)' }}>
              {Math.abs(totClosing) < 0.005 ? 'Nil' : bal(totClosing)}
            </span>
          </div>
        </div>

        <div className="mt-2.5 flex items-start gap-2">
          <Info className="h-4 w-4 flex-none" style={{ color: '#8CA396' }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: A.muted, lineHeight: 1.5, textWrap: 'pretty' }}>
            Opening and closing read Dr or Cr as the balance falls; the debit and credit columns are the movement in
            the period. Every figure is summed from the same voucher lines the day book and each ledger statement
            read, so the three cannot disagree
            {agrees
              ? '.'
              : ` — and while Dr and Cr are out by ${formatINR(Math.abs(totDr - totCr))} the books do not close, which is an opening balance or a one-sided entry rather than a rounding difference.`}
          </span>
        </div>
      </div>
    )
  })()

  // ===========================================================================
  // LEDGER ACCOUNTS — the account list, the statement, and its four views.
  // ===========================================================================
  //
  // Every view below reads `stmt` — the same opening, the same rows, the same
  // closing the header states. Nothing here recomputes a figure another screen
  // already answers, which is the whole rule this module is built on.
  const ledgerWeb = (() => {
    // bal / balFg are module-level now — see the note above AccountPicker.
    const money = (v: number): string => (Math.abs(v) < 0.005 ? '—' : formatINR(v))

    // THE LAYOUT FOLLOWS THE WINDOW. The ledger list is called up with F4 (or
    // Change ledger) and put away again, so the register keeps the whole
    // width; the balance rail stands on the right when there is room, and
    // folds into four tiles above the register when there is not.
    const W = vw
    const wideRail = W >= 1400
    const narrowRail = !wideRail && vh >= 640
    const railW = W >= 2000 ? 380 : 320
    const gutter = W >= 1400 ? 16 : 12
    const bodyPad = W >= 1400 ? '16px 20px 14px' : '12px 14px 12px'

    // ── THE LEDGER LIST, grouped the way a trial balance reads ─────────────
    const q = ledgerSearch.trim().toLowerCase()
    const matchesSearch = (a2: Row): boolean =>
      !q || ledgerNameMatches(a2.name, q) || String(a2.acc_group || '').toLowerCase().includes(q)
    const groupRank = (g: string): number => {
      const i = TB_GROUP_ORDER.indexOf(g)
      return i < 0 ? TB_GROUP_ORDER.length : i
    }
    const listGroups = (() => {
      const m = new Map<string, Row[]>()
      for (const a2 of accounts) {
        if (!matchesSearch(a2)) continue
        const g = String(a2.acc_group || 'Ungrouped')
        if (!m.has(g)) m.set(g, [])
        ;(m.get(g) as Row[]).push(a2)
      }
      return [...m.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]))
    })()
    // The order on screen, which is the order the arrows walk.
    const shown = listGroups.flatMap(([, rows]) => rows)
    lgOrderRef.current = shown.map((a2) => Number(a2.id))
    const openLedger = (id: number): void => {
      setLedgerId(id)
      setLgPickerOpen(false)
      setLgOpenRow(null)
      // The list is put away once a ledger is chosen, so what was typed into it
      // goes too — otherwise ↑ ↓ would walk a filtered list nobody can see.
      setLedgerSearch('')
    }
    // Arrows through the list that is actually on screen, Enter opens.
    const lgKeys = (e: React.KeyboardEvent): void => {
      const count = shown.length
      if (!count) return
      const step = (to: number): void => {
        e.preventDefault()
        setLgCursor(Math.max(0, Math.min(to, count - 1)))
      }
      if (e.key === 'ArrowDown') step(lgCursor + 1)
      else if (e.key === 'ArrowUp') step(lgCursor - 1)
      else if (e.key === 'PageDown') step(lgCursor + 10)
      else if (e.key === 'PageUp') step(lgCursor - 10)
      else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = shown[Math.min(lgCursor, count - 1)]
        if (hit) openLedger(Number(hit.id))
      }
    }

    const group = String(ledgerAccount?.acc_group || '')
    const isParty = isBillwise(group)
    const baseG = baseGroup(group)
    const acName = String(ledgerAccount?.name || '')
    const iconOf = (g: string): typeof Landmark =>
      g === 'Bank Accounts' || g === 'Bank OD A/c'
        ? Landmark
        : g === 'Cash-in-Hand'
          ? Banknote
          : g === 'Capital Account'
            ? PiggyBank
            : g === 'Sundry Debtors'
              ? User
              : g === 'Sundry Creditors'
                ? Store
                : g === 'Duties & Taxes'
                  ? Percent
                  : g === 'Purchase Accounts'
                    ? ShoppingCart
                    : g === 'Sales Accounts'
                      ? Tag
                      : g === 'Direct Expenses'
                        ? Truck
                        : /Expenses/i.test(g)
                          ? Receipt
                          : BookOpen
    const AcIcon = iconOf(baseG)

    // ── WHAT IS SHOWN: the type chips and the search narrow the rows; the
    // running balance is still carried through every voucher, so a filtered
    // row keeps the true balance at that point.
    const allRows = stmt.rows as Row[]
    const typeOf = (r: Row): string => String(r.vch_type || '').toUpperCase()
    const presentTypes = [...new Set(allRows.map(typeOf).filter(Boolean))]
    const fTypes = lgFTypes.filter((t) => presentTypes.includes(t))
    const fq = lgFQuery.trim().toUpperCase()
    const rowText = (r: Row): string =>
      [
        r.voucher_code,
        r.vch_no,
        r.vch_type,
        r.particulars,
        r.narration,
        lineRef(r)?.full,
        ...((r.legs as Row[]) || []).map((g) => g.name)
      ]
        .map((x) => String(x || ''))
        .join(' ')
        .toUpperCase()
    const toolbarOk = (r: Row): boolean => (!fTypes.length || fTypes.includes(typeOf(r))) && (!fq || rowText(r).includes(fq))
    // The column funnels, offered from what the chips and search leave.
    const lgCf = colFilter<Row>(colF, 'ledger:vouchers', allRows.filter(toolbarOk), [
      { key: 'date', get: (r) => formatDate(r.entry_date), sort: 'num' },
      { key: 'type', get: (r) => r.vch_type },
      { key: 'voucher', get: (r) => r.voucher_code || r.vch_no },
      { key: 'particulars', get: (r) => r.particulars },
      { key: 'ref', get: (r) => lineRef(r)?.full },
      { key: 'dr', get: (r) => (Number(r.dr) > 0 ? formatINR(Number(r.dr)) : ''), sort: 'num' },
      { key: 'cr', get: (r) => (Number(r.cr) > 0 ? formatINR(Number(r.cr)) : ''), sort: 'num' },
      { key: 'balance', get: (r) => bal(Number(r.running)), sort: 'num' }
    ])
    const lgShown = new Set(lgCf.rows)
    const keep = allRows.map((r) => lgShown.has(r))
    const filtering = fTypes.length > 0 || !!fq || lgCf.active > 0
    const vRows = allRows.filter((_, i) => keep[i])
    const canFilter = lgView === 'vouchers' || (lgView === 'columnar' && !lgCondensed)
    // The columnar rows are one per statement row, in the same order, until
    // they are condensed into months — so the same filter applies to them.
    const colRows = lgCondensed ? lgColRows : lgColRows.filter((_, i) => keep[i])
    const shownFoot = filtering && canFilter
    const fDr = vRows.reduce((t, r) => t + (Number(r.dr) || 0), 0)
    const fCr = vRows.reduce((t, r) => t + (Number(r.cr) || 0), 0)
    const typeLabel = (t: string): string => t.charAt(0) + t.slice(1).toLowerCase()

    // ── THE RAIL ───────────────────────────────────────────────────────────
    const drShare = stmt.totDr + stmt.totCr > 0 ? (stmt.totDr / (stmt.totDr + stmt.totCr)) * 100 : 50
    // WHERE THIS LEDGER'S OWN AMOUNT WENT — not the whole opposite side of
    // every voucher it is on. Freight outward's ₹20,595 on a sale voucher went
    // to FREIGHT PAYABLE; adding up that voucher's whole credit side put ₹50 L
    // of RPO SALE beside a ₹5.87 L ledger. A line on the other side for exactly
    // this ledger's amount takes all of it; otherwise the amount is shared
    // across that side in proportion, so the rail adds up to the ledger.
    const contraTotals = (() => {
      const moved = new Map<string, number>()
      const add = (name: string, v: number): void => {
        moved.set(name, (moved.get(name) || 0) + v)
      }
      for (const r of allRows) {
        const own = (Number(r.dr) || 0) + (Number(r.cr) || 0)
        if (own < 0.005) continue
        const mine = (Number(r.dr) || 0) > 0 ? 'dr' : 'cr'
        const opp = ((r.legs as Row[]) || [])
          .map((g) => ({
            name: String(g.name),
            side: (Number(g.dr) || 0) > 0 ? 'dr' : 'cr',
            amt: (Number(g.dr) || 0) + (Number(g.cr) || 0)
          }))
          .filter((g) => g.side !== mine && g.amt > 0.004)
        if (!opp.length) continue
        const exact = opp.filter((g) => Math.abs(g.amt - own) < 0.005)
        if (exact.length === 1) {
          add(exact[0].name, own)
          continue
        }
        const tot = opp.reduce((t, g) => t + g.amt, 0)
        for (const g of opp) add(g.name, (own * g.amt) / tot)
      }
      return Array.from(moved, ([name, v]) => ({ name, v: Math.round(v * 100) / 100 }))
        .filter((x) => x.v >= 0.01)
        .sort((x, y) => y.v - x.v)
    })()
    const maxContra = Math.max(1, ...contraTotals.map((x) => x.v))
    const mix = (() => {
      const m = new Map<string, number>()
      for (const r of allRows) m.set(typeOf(r), (m.get(typeOf(r)) || 0) + 1)
      return [...m.entries()].sort((a, b) => b[1] - a[1])
    })()
    const closeMeaning =
      Math.abs(stmt.closing) < 0.005
        ? 'Nothing outstanding on this ledger.'
        : isParty
          ? stmt.closing < 0
            ? baseG === 'Sundry Creditors'
              ? `Owed to ${acName}.`
              : `${acName} has paid in advance.`
            : baseG === 'Sundry Debtors'
              ? `Receivable from ${acName}.`
              : `${acName} owes you — an advance or a note.`
          : stmt.closing > 0
            ? 'Debit balance at the end of the period.'
            : 'Credit balance at the end of the period.'

    // ── LOOK ───────────────────────────────────────────────────────────────
    const card: React.CSSProperties = {
      background: '#fff',
      border: '1px solid #DCE7DB',
      borderRadius: 10,
      boxShadow: '0 1px 2px rgba(10,31,23,.04),0 10px 28px -16px rgba(10,31,23,.18)'
    }
    const figS = (size: number, color: string = A.ink, weight = 700): React.CSSProperties => ({
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: size,
      fontWeight: weight,
      color
    })
    const clip: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const HEAD_BG = 'linear-gradient(180deg,#0F4A38,#0B3D2E)'
    const headRow: React.CSSProperties = {
      position: 'sticky',
      top: 0,
      zIndex: 2,
      background: HEAD_BG,
      color: '#A9CDBB',
      fontSize: 9.5,
      fontWeight: 800,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      alignItems: 'center'
    }
    const cap: React.CSSProperties = { fontSize: 9, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }
    const stripe = (i: number): string => (i % 2 ? '#FBFDFA' : '#fff')
    const typeChip = (t: string): React.JSX.Element => {
      const tt = toneOf(t)
      return (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: '.04em',
            background: tt.bg,
            color: tt.fg,
            border: `1px solid ${tt.bd}`,
            borderRadius: 4,
            padding: '3px 7px',
            whiteSpace: 'nowrap',
            // Never wider than its column: a longer type is cut with … and
            // read in full on hover, instead of running into the next cell.
            display: 'inline-block',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'middle'
          }}
          title={t || undefined}
        >
          {t || '—'}
        </span>
      )
    }

    const VIEWS: { k: LgView; label: string; fkey: string; Icon: typeof Landmark; note: string }[] = [
      { k: 'vouchers', label: 'Vouchers', fkey: 'F1', Icon: ReceiptText, note: 'Every voucher, with the running balance' },
      { k: 'columnar', label: 'Columnar', fkey: 'Alt F5', Icon: Columns3, note: 'A column per contra ledger — where the money went' },
      { k: 'billwise', label: 'Bill-wise', fkey: 'F5', Icon: FileStack, note: 'The balance broken into the bills that make it up' },
      { k: 'monthly', label: 'Monthly', fkey: 'F7', Icon: CalendarDays, note: 'Each month summed, with the closing carried forward' }
    ]
    const curView = VIEWS.find((v) => v.k === lgView) || VIEWS[0]
    const viewNote =
      lgView === 'vouchers'
        ? 'Click a row to open its voucher · the arrow shows its lines here.'
        : lgView === 'columnar'
          ? lgCondensed
            ? 'Condensed — one row per month.'
            : 'One row per voucher, one column per ledger it touched.'
          : lgView === 'billwise'
            ? isParty
              ? 'Oldest bill settled first, the way an Agst Ref allocation runs.'
              : ''
            : lgCondensed
              ? 'Condensed — month totals only.'
              : 'Click a month to open the vouchers behind it.'

    // ── THE HEADER STRIP: the four views, Condensed, and the keys ──────────
    const strip = (
      <div className="sc flex h-[48px] items-center gap-1.5 overflow-x-auto">
        {VIEWS.map((v) => {
          const on = lgView === v.k
          const off = v.k === 'billwise' && !!ledgerAccount && !isParty
          return (
            <button
              key={v.k}
              type="button"
              title={off ? 'Bill-wise details are kept on party ledgers only' : v.note}
              onClick={() => setLgView(v.k)}
              className="flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[7px] px-[13px] transition-colors"
              style={{
                background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
                border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
                boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.6),0 6px 16px -6px rgba(199,240,63,.55)' : 'none',
                color: on ? A.frame : '#DCEFE4',
                opacity: off ? 0.5 : 1,
                fontSize: 12,
                fontWeight: 800
              }}
            >
              <v.Icon className="h-4 w-4" />
              {v.label}
              <span
                style={{
                  ...figS(9.5, on ? A.frame : A.inkSky, 600),
                  background: on ? 'rgba(11,61,46,.12)' : 'rgba(255,255,255,.07)',
                  borderRadius: 3,
                  padding: '2px 5px'
                }}
              >
                {chordLabel(v.fkey)}
              </span>
            </button>
          )
        })}
        {(lgView === 'columnar' || lgView === 'monthly') && (
          <button
            type="button"
            title="Totals only — one row per month"
            onClick={() => setLgCondensed((c) => !c)}
            className="ml-1.5 flex h-[34px] flex-none items-center gap-[9px] whitespace-nowrap rounded-[7px] px-3"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)', color: '#DCEFE4', fontSize: 11.5, fontWeight: 700 }}
          >
            <span
              className="flex rounded-full"
              style={{
                width: 30,
                height: 18,
                padding: 2,
                background: lgCondensed ? A.accent : 'rgba(255,255,255,.2)',
                justifyContent: lgCondensed ? 'flex-end' : 'flex-start'
              }}
            >
              <span className="rounded-full bg-white" style={{ width: 14, height: 14 }} />
            </span>
            Condensed
          </button>
        )}
        <div className="flex-1" />
        {W >= 1240 && (
          <div className="flex flex-none items-center gap-[7px] whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: A.inkSky }}>
            <KeyboardIcon className="h-[15px] w-[15px]" />
            {lgView === 'billwise' ? '↑ ↓ pick a bill' : '↑ ↓ change ledger'} · {fKeyLabel('F4')} find · {[fKeyLabel('F1'), fKeyLabel('F5'), chordLabel('Alt F5'), fKeyLabel('F7')].join(' ')} change view · {fKeyLabel('F8')} summary
          </div>
        )}
      </div>
    )

    // ── THE LIST ───────────────────────────────────────────────────────────
    let flatIndex = -1
    const listRow = (a2: Row, compact: boolean): React.JSX.Element => {
      flatIndex += 1
      const ai = flatIndex
      const on = Number(a2.id) === ledgerId
      const cur = ai === lgCursor && !on
      const b = Number(a2.balance) || 0
      return (
        <button
          key={String(a2.id)}
          type="button"
          ref={(el) => {
            lgItemRefs.current[ai] = el as unknown as HTMLDivElement | null
          }}
          onClick={() => openLedger(Number(a2.id))}
          onKeyDown={lgKeys}
          className="flex w-full items-center gap-[9px] text-left transition-colors hover:bg-[#F4F7F2]"
          style={
            compact
              ? { padding: '9px 14px', background: on ? '#F3FBE2' : cur ? '#F4F7F2' : '#fff' }
              : {
                  margin: '0 7px',
                  width: 'calc(100% - 14px)',
                  padding: '8px 9px',
                  borderRadius: 7,
                  background: on ? 'linear-gradient(180deg,#F3FBE2,#E8F6CC)' : cur ? '#F4F7F2' : 'transparent',
                  border: `1px solid ${on ? '#CDE89A' : cur ? '#DCE7DB' : 'transparent'}`,
                  boxShadow: on ? '0 4px 12px -8px rgba(63,90,18,.5)' : 'none'
                }
          }
        >
          {!compact && (
            <span className="flex-none self-stretch rounded-[2px]" style={{ width: 4, background: on ? A.frame : 'transparent' }} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate" style={{ fontSize: compact ? 12 : 11.5, fontWeight: on ? 800 : 700, lineHeight: 1.3, color: A.ink }}>
              {String(a2.name)}
            </span>
            {compact && <span className="block" style={{ fontSize: 10, fontWeight: 600, color: A.muted, marginTop: 1 }}>{String(a2.acc_group || '')}</span>}
            {!compact && <span className="block" style={{ ...figS(10.5, balFg(b), 600), marginTop: 2 }}>{bal(b)}</span>}
          </span>
          {compact && <span className="flex-none whitespace-nowrap" style={figS(11, balFg(b), 600)}>{bal(b)}</span>}
          {!compact && on && stmt.rows.length > 0 && (
            <span
              className="flex-none"
              title={`${stmt.rows.length} ${stmt.rows.length === 1 ? 'voucher' : 'vouchers'} in the period`}
              style={{ ...figS(9.5, A.muted), background: '#F4F7F2', border: '1px solid #E4ECE3', borderRadius: 9, padding: '1px 6px' }}
            >
              {stmt.rows.length}
            </span>
          )}
        </button>
      )
    }
    const searchBox = (ref: React.RefObject<HTMLInputElement>, placeholder: string): React.JSX.Element => (
      <div
        className="flex h-9 items-center gap-2 rounded-[7px] px-2.5"
        style={{ border: '1px solid #C3D2C6', background: '#fff', boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)' }}
      >
        <Search className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
        <input
          ref={ref}
          value={ledgerSearch}
          onChange={(e) => setLedgerSearch(e.target.value)}
          onKeyDown={lgKeys}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent outline-none"
          style={{ fontSize: 12, fontWeight: 600, color: A.ink }}
        />
        {!!ledgerSearch && (
          <button type="button" title="Clear" onClick={() => setLedgerSearch('')} style={{ color: A.muted }}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    )
    // THE LEDGER LIST, CALLED UP OVER THE REGISTER — F4 or Change ledger —
    // and put away again by choosing one, Esc, or a click on the register.
    const drawer = lgPickerOpen && (
      <>
        <div
          className="absolute inset-0 z-[30]"
          style={{ background: 'rgba(10,31,23,.28)' }}
          onMouseDown={() => ledgerId && setLgPickerOpen(false)}
        />
        <div
          className="absolute z-[31] flex flex-col overflow-hidden"
          style={{
            ...card,
            left: W >= 1400 ? 20 : 14,
            top: W >= 1400 ? 16 : 12,
            bottom: W >= 1400 ? 14 : 12,
            width: 'min(340px, calc(100% - 28px))',
            boxShadow: '18px 0 44px -22px rgba(10,31,23,.5)'
          }}
        >
        <div className="flex flex-none items-center gap-2" style={{ padding: 11, borderBottom: '1px solid #EAF0E9' }}>
          <div className="min-w-0 flex-1">{searchBox(ledgerSearchRef, 'Find a ledger or group · ↑↓ Enter')}</div>
          {!!ledgerId && (
            <button
              type="button"
              title="Close (Esc)"
              onClick={() => setLgPickerOpen(false)}
              className="flex h-9 flex-none items-center rounded-[7px] px-2.5"
              style={{ border: '1px solid #DCE7DB', fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: A.muted }}
            >
              ESC
            </button>
          )}
        </div>
        <div className="sc min-h-0 flex-1 overflow-y-auto" style={{ padding: '4px 0 8px' }}>
          {listGroups.map(([g, rows]) => (
            <div key={g}>
              <div className="flex items-center gap-2" style={{ padding: '10px 14px 5px' }}>
                <span style={{ ...cap, color: A.muted, letterSpacing: '.14em' }}>{g}</span>
                <span className="h-px flex-1" style={{ background: '#EAF0E9' }} />
              </div>
              {rows.map((a2) => listRow(a2, false))}
            </div>
          ))}
          {listGroups.length === 0 && (
            <div style={{ padding: '22px 14px', textAlign: 'center', fontSize: 11.5, fontWeight: 600, color: A.muted }}>
              No ledger matches “{ledgerSearch.trim()}”.
            </div>
          )}
        </div>
        </div>
      </>
    )

    // ── ONE VOUCHER'S LINES, shown under its row ───────────────────────────
    const voucherLines = (r: Row): React.JSX.Element => {
      const own = { name: acName, dr: Number(r.dr) || 0, cr: Number(r.cr) || 0, own: true }
      const legs = ((r.legs as Row[]) || []).map((g) => ({ name: String(g.name), dr: Number(g.dr) || 0, cr: Number(g.cr) || 0, own: false }))
      const lines = orderVoucherLines([own, ...legs], (l) => ({ account: l.name, dr: l.dr > 0, tax: isTaxLine(l.name), amount: l.dr || l.cr }))
      const doc = docTarget(r)
      return (
        <div style={{ padding: '10px 16px 12px 42px', background: '#F7FAF6', borderBottom: '1px solid #EAF0E9' }}>
          <div className="overflow-hidden" style={{ maxWidth: 680, background: '#fff', border: '1px solid #DCE7DB', borderRadius: 8 }}>
            {lines.map((l, k) => (
              <div
                key={k}
                className="grid items-center"
                style={{
                  gridTemplateColumns: '40px minmax(0,1fr) 140px 140px',
                  minHeight: 34,
                  borderBottom: '1px solid #EFF3EE',
                  background: l.own ? '#F3FBE2' : '#fff'
                }}
              >
                <span style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 800, color: l.dr > 0 ? A.dr : A.cr }}>{l.dr > 0 ? 'Dr' : 'Cr'}</span>
                <span className="truncate" style={{ fontSize: 11.5, fontWeight: l.own ? 800 : 600, padding: '0 8px' }}>
                  {l.name}
                </span>
                <span style={{ textAlign: 'right', padding: '0 12px', ...figS(11.5, A.dr) }}>{l.dr > 0 ? formatINR(l.dr) : ''}</span>
                <span style={{ textAlign: 'right', padding: '0 12px', ...figS(11.5, A.cr) }}>{l.cr > 0 ? formatINR(l.cr) : ''}</span>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2" style={{ padding: '8px 12px', background: '#FBFDFA' }}>
              <span className="min-w-0 flex-1" style={{ fontSize: 11, fontWeight: 600, color: A.muted, lineHeight: 1.45 }}>
                {String(r.narration || '').trim() || 'No narration.'}
                {lineRef(r) ? ` · ref ${lineRef(r)?.full}` : ''}
              </span>
              {doc && (
                <button
                  type="button"
                  onClick={() => openRowSource(r, ledgerId)}
                  className="flex h-7 flex-none items-center gap-1.5 rounded-[6px] px-2.5"
                  style={{ border: '1px solid #C3D2C6', background: '#fff', fontSize: 11, fontWeight: 800, color: A.inkMid }}
                >
                  Open {doc.what}
                </button>
              )}
              <button
                type="button"
                onClick={() => void openForAlter({ id: r.entry_id ?? r.id })}
                className="flex h-7 flex-none items-center gap-1.5 rounded-[6px] px-2.5"
                style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff', fontSize: 11, fontWeight: 800 }}
              >
                Open voucher
              </button>
            </div>
          </div>
        </div>
      )
    }

    // ── THE VOUCHERS VIEW ──────────────────────────────────────────────────
    // Sized so the whole row fits beside the list without a sideways scroll on
    // a 1366 laptop, and beside the list AND the rail from 1760 up.
    // Type wide enough for the longest voucher type ("PURCHASE HUSK"), so
    // its chip never runs into the voucher number beside it.
    const V_GRID = '128px 140px 108px minmax(140px,1fr) 116px 122px 122px 148px'
    const vouchersView = (
      <div style={{ minWidth: 1020 }}>
        <div className="grid" style={{ ...headRow, gridTemplateColumns: V_GRID, height: 34 }}>
          <span style={{ padding: '0 14px' }}>{lgCf.head('date', 'Date', { onDark: true })}</span>
          <span style={{ padding: '0 8px' }}>{lgCf.head('type', 'Type', { onDark: true })}</span>
          <span style={{ padding: '0 8px' }}>{lgCf.head('voucher', 'Voucher', { onDark: true })}</span>
          <span style={{ padding: '0 8px' }}>{lgCf.head('particulars', 'Particulars', { onDark: true })}</span>
          <span style={{ padding: '0 8px' }}>{lgCf.head('ref', 'Ref', { onDark: true })}</span>
          <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>{lgCf.head('dr', 'Debit', { onDark: true, align: 'end' })}</span>
          <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>{lgCf.head('cr', 'Credit', { onDark: true, align: 'end' })}</span>
          <span style={{ padding: '0 14px', display: 'flex', justifyContent: 'flex-end' }}>{lgCf.head('balance', 'Balance', { onDark: true, align: 'end' })}</span>
        </div>
        <div className="grid items-center" style={{ gridTemplateColumns: V_GRID, height: 38, background: '#F4F7F2', borderBottom: '1px solid #E4ECE3' }}>
          <span style={{ padding: '0 14px', ...figS(11.5, A.muted, 600) }}>{lgFrom || lgBooksFrom ? formatDate(lgFrom || lgBooksFrom) : ''}</span>
          <span style={{ gridColumn: 'span 4', padding: '0 8px', fontSize: 11.5, fontWeight: 800, color: '#33473E' }}>Opening balance</span>
          <span />
          <span />
          <span style={{ padding: '0 14px', textAlign: 'right', ...figS(12, balFg(stmt.opening)) }}>{bal(stmt.opening)}</span>
        </div>
        {vRows.map((r, i) => {
          const eid = Number(r.entry_id ?? r.id)
          const open = lgOpenRow === Number(r.id)
          const ref = lineRef(r)
          const doc = docTarget(r)
          return (
            <div key={String(r.id)}>
              <div
                role="button"
                tabIndex={0}
                title={voucherTitle(r)}
                onClick={() => void openForAlter({ id: eid })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openForAlter({ id: eid })
                  }
                }}
                className="grid cursor-pointer items-center transition-colors hover:bg-[#F1F8EC]"
                style={{ gridTemplateColumns: V_GRID, minHeight: 46, borderBottom: '1px solid #EFF3EE', background: open ? '#F3FBE2' : stripe(i) }}
              >
                <span className="flex items-center gap-1.5" style={{ padding: '0 8px 0 8px', ...figS(11.5, '#33473E', 600) }}>
                  <button
                    type="button"
                    title={open ? 'Hide its lines' : 'Show its lines here'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setLgOpenRow(open ? null : Number(r.id))
                    }}
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-[5px] hover:bg-[#E4ECE3]"
                  >
                    <ChevronRight className="h-[15px] w-[15px] transition-transform" style={{ color: '#8CA396', transform: open ? 'rotate(90deg)' : 'none' }} />
                  </button>
                  {formatDate(r.entry_date)}
                </span>
                <span style={{ padding: '0 12px 0 8px', minWidth: 0, overflow: 'hidden' }}>{typeChip(typeOf(r))}</span>
                <span style={{ padding: '0 8px 0 4px', ...figS(11.5), ...clip }}>{String(r.voucher_code || r.vch_no || '—')}</span>
                <div style={{ padding: '6px 8px', minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, ...clip }}>{String(r.particulars || '—')}</div>
                  {/* One bank debit that repaid several discounted bills:
                      which bill took what. */}
                  {Array.isArray(r.bd_split) && r.bd_split.length > 1 && (
                    <div className="flex flex-wrap gap-1" style={{ marginTop: 3 }}>
                      {(r.bd_split as Row[]).map((p, k) => (
                        <span
                          key={k}
                          style={{ fontSize: 10.5, fontWeight: 800, color: '#0B6B45', background: '#E9F5EE', border: '1px solid #BFE3CB', borderRadius: 3, padding: '1px 6px', ...figS(10.5, '#0B6B45', 800) }}
                        >
                          {String(p.bd_no)} {formatINR(Number(p.amount) || 0)}
                        </span>
                      ))}
                    </div>
                  )}
                  {!!String(r.narration || '').trim() && (
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: A.muted, marginTop: 2, ...clip }}>{String(r.narration)}</div>
                  )}
                </div>
                {ref ? (
                  doc ? (
                    <button
                      type="button"
                      title={`Open ${doc.what}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openRowSource(r, ledgerId)
                      }}
                      style={{ padding: '0 8px', textAlign: 'left', minWidth: 0 }}
                    >
                      <span className="block truncate" style={{ ...figS(11, A.link), textDecoration: 'underline', textUnderlineOffset: 2 }}>
                        {ref.no}
                      </span>
                      <span className="block truncate" style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: A.muted, marginTop: 1 }}>
                        {ref.kind}
                      </span>
                    </button>
                  ) : (
                    <span style={{ padding: '0 8px', minWidth: 0 }} title={`${ref.kind}: ${ref.full}`}>
                      <span className="block truncate" style={figS(11, A.muted, 600)}>
                        {ref.no}
                      </span>
                      <span className="block truncate" style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: A.muted, marginTop: 1 }}>
                        {ref.kind}
                      </span>
                    </span>
                  )
                ) : (
                  <span style={{ padding: '0 8px', ...figS(11, A.none, 600) }}>—</span>
                )}
                <span style={{ padding: '0 12px', textAlign: 'right', ...figS(12.5, A.dr) }}>{Number(r.dr) > 0 ? formatINR(Number(r.dr)) : ''}</span>
                <span style={{ padding: '0 12px', textAlign: 'right', ...figS(12.5, A.cr) }}>{Number(r.cr) > 0 ? formatINR(Number(r.cr)) : ''}</span>
                <span
                  className="flex h-full items-center justify-end"
                  style={{ padding: '0 14px', background: 'rgba(199,240,63,.07)', ...figS(12, balFg(Number(r.running))) }}
                >
                  {bal(Number(r.running))}
                </span>
              </div>
              {open && voucherLines(r)}
            </div>
          )
        })}
        {vRows.length === 0 && (
          <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
            {allRows.length === 0
              ? 'Nothing posted to this ledger in the period — the opening carries straight through.'
              : `No voucher matches${fq ? ` “${lgFQuery.trim()}”` : ''}${fq && fTypes.length ? ' in' : ''}${fTypes.length ? ` ${fTypes.map((t) => t.toLowerCase()).join(', ')}` : ''}.`}
          </div>
        )}
      </div>
    )

    // ── THE MONTHLY VIEW ───────────────────────────────────────────────────
    const M_GRID = 'minmax(190px,1fr) minmax(140px,1.2fr) 150px 150px 170px'
    const mCf = colFilter(colF, 'ledger:monthly', lgMonthsWeb, [
      { key: 'month', get: (m) => m.label, sort: 'none' },
      { key: 'dr', get: (m) => money(m.dr), sort: 'num' },
      { key: 'cr', get: (m) => money(m.cr), sort: 'num' },
      { key: 'closing', get: (m) => bal(m.closing), sort: 'num' }
    ])
    const mMax = Math.max(1, ...lgMonthsWeb.map((m) => Math.max(m.dr, m.cr)))
    const monthlyView = (
      <div style={{ minWidth: 810 }}>
        <div className="grid" style={{ ...headRow, gridTemplateColumns: M_GRID, height: 34 }}>
          <span style={{ padding: '0 14px' }}>{mCf.head('month', 'Month', { onDark: true })}</span>
          <span style={{ padding: '0 8px' }}>Movement</span>
          <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>{mCf.head('dr', 'Debit', { onDark: true, align: 'end' })}</span>
          <span style={{ padding: '0 12px', display: 'flex', justifyContent: 'flex-end' }}>{mCf.head('cr', 'Credit', { onDark: true, align: 'end' })}</span>
          <span style={{ padding: '0 14px', display: 'flex', justifyContent: 'flex-end' }}>{mCf.head('closing', 'Closing', { onDark: true, align: 'end' })}</span>
        </div>
        {mCf.rows.map((m, i) => {
          const open = !lgCondensed && !!lgMonOpen[m.key]
          return (
            <div key={m.key}>
              <button
                type="button"
                onClick={() => !lgCondensed && setLgMonOpen((o) => ({ ...o, [m.key]: !o[m.key] }))}
                className="grid w-full items-center text-left transition-colors hover:bg-[#F1F8EC]"
                style={{ gridTemplateColumns: M_GRID, minHeight: 46, borderBottom: '1px solid #EFF3EE', background: open ? '#F3FBE2' : stripe(i) }}
              >
                <span className="flex items-center gap-[9px]" style={{ padding: '0 14px' }}>
                  {!lgCondensed && (
                    <ChevronRight className="h-[15px] w-[15px] flex-none transition-transform" style={{ color: '#8CA396', transform: open ? 'rotate(90deg)' : 'none' }} />
                  )}
                  <span style={{ fontSize: 12, fontWeight: 800 }}>{m.label}</span>
                  <span style={{ ...figS(9.5, A.good), background: '#E9F5EE', border: '1px solid #BFE3CB', borderRadius: 9, padding: '1px 7px' }}>{m.n}</span>
                </span>
                <span className="flex flex-col gap-1" style={{ padding: '0 8px' }}>
                  <span className="block h-1.5 overflow-hidden rounded-[3px]" style={{ background: '#EEF3EC' }}>
                    <span className="block h-full rounded-[3px]" style={{ width: `${(m.dr / mMax) * 100}%`, background: 'linear-gradient(90deg,#6E9FD6,#1B4E82)' }} />
                  </span>
                  <span className="block h-1.5 overflow-hidden rounded-[3px]" style={{ background: '#EEF3EC' }}>
                    <span className="block h-full rounded-[3px]" style={{ width: `${(m.cr / mMax) * 100}%`, background: 'linear-gradient(90deg,#E4A39D,#8C2F26)' }} />
                  </span>
                </span>
                <span style={{ padding: '0 12px', textAlign: 'right', ...figS(12.5, m.dr > 0.004 ? A.dr : A.none) }}>{money(m.dr)}</span>
                <span style={{ padding: '0 12px', textAlign: 'right', ...figS(12.5, m.cr > 0.004 ? A.cr : A.none) }}>{money(m.cr)}</span>
                <span className="flex h-full items-center justify-end" style={{ padding: '0 14px', background: 'rgba(199,240,63,.07)', ...figS(12.5, balFg(m.closing)) }}>
                  {bal(m.closing)}
                </span>
              </button>
              {open &&
                (m.rows as Row[]).map((r) => (
                  <button
                    key={String(r.id)}
                    type="button"
                    title={voucherTitle(r)}
                    onClick={() => void openForAlter({ id: r.entry_id ?? r.id })}
                    className="grid w-full items-center text-left transition-colors hover:bg-[#EEF6E8]"
                    style={{ gridTemplateColumns: M_GRID, minHeight: 36, borderBottom: '1px solid #EFF3EE', background: '#F7FAF6' }}
                  >
                    <span className="flex min-w-0 items-baseline gap-2" style={{ padding: '0 10px 0 38px' }}>
                      <span className="flex-none" style={figS(10.5, A.muted, 600)}>
                        {formatDate(r.entry_date)}
                      </span>
                      <span className="min-w-0 truncate" style={{ fontSize: 11, fontWeight: 700 }}>
                        {String(r.particulars || '—')}
                      </span>
                    </span>
                    <span className="flex items-center gap-2" style={{ padding: '0 8px' }}>
                      {typeChip(typeOf(r))}
                      <span className="truncate" style={figS(10.5, A.muted, 600)}>
                        {String(r.voucher_code || r.vch_no || '')}
                      </span>
                    </span>
                    <span style={{ padding: '0 12px', textAlign: 'right', ...figS(11.5, A.dr, 600) }}>{Number(r.dr) > 0 ? formatINR(Number(r.dr)) : ''}</span>
                    <span style={{ padding: '0 12px', textAlign: 'right', ...figS(11.5, A.cr, 600) }}>{Number(r.cr) > 0 ? formatINR(Number(r.cr)) : ''}</span>
                    <span style={{ padding: '0 14px', textAlign: 'right', ...figS(11.5, balFg(Number(r.running))) }}>{bal(Number(r.running))}</span>
                  </button>
                ))}
            </div>
          )
        })}
        {lgMonthsWeb.length === 0 && (
          <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
            Nothing posted to this ledger in the period.
          </div>
        )}
      </div>
    )

    // ── THE COLUMNAR VIEW ──────────────────────────────────────────────────
    const columnarView = (() => {
      // A column per ledger needs the width of a ledger — see the note that
      // came with this view: 232px holds a full party name and a nine-figure
      // amount, and the register scrolls sideways when the columns outrun the
      // screen, with the date and voucher pinned to the left.
      const COL_W = 200
      const LEAD_W = 150
      const TOT_W = 150
      const nCols = Math.max(1, lgContras.length)
      const DETAIL_META = [
        { key: 'vchType', label: 'Type', w: 118, num: false },
        { key: 'refNo', label: 'Ref no', w: 132, num: false },
        { key: 'bargainNo', label: 'Bargain', w: 120, num: false },
        { key: 'rate', label: 'Rate', w: 112, num: true },
        { key: 'qty', label: 'Qty', w: 100, num: true },
        { key: 'interest', label: 'Interest', w: 122, num: true },
        { key: 'narration', label: 'Narration', w: 300, num: false }
      ] as const
      const detailCols = lgCondensed ? [] : DETAIL_META.filter((d) => lgDetailCols[d.key])
      // A funnel on every column — the lead, each deal column, each ledger
      // column and the total. Keyed by the ledger's name so a funnel follows
      // its column when the set of columns changes.
      const cAmt = (v: number): string => (Math.abs(v) > 0.004 ? formatINR(v) : '—')
      const cCf = colFilter(colF, `ledger:columnar:${lgCondensed ? 'm' : 'v'}`, colRows, [
        { key: 'lead', get: (r) => r.label },
        ...(lgCondensed ? [] : [{ key: 'leadDate', get: (r: (typeof colRows)[number]) => r.lead, sort: 'num' as const }]),
        ...detailCols.map((d) => ({
          key: `d:${d.key}`,
          get: (r: (typeof colRows)[number]) => {
            const v = r.detail ? r.detail[d.key as keyof typeof r.detail] : ''
            if (!d.num) return v
            const num = Number(v) || 0
            return num > 0.004 ? (d.key === 'qty' ? formatNum(num) : formatINR(num)) : '—'
          },
          sort: d.num ? ('num' as const) : undefined
        })),
        ...lgContras.map((c, i) => ({ key: `c:${c}`, get: (r: (typeof colRows)[number]) => cAmt(r.cells[i]), sort: 'num' as const })),
        { key: 'total', get: (r) => cAmt(r.total), sort: 'num' }
      ])
      const colRowsF = cCf.rows
      // Each deal column takes the width of what is in it, measured here so
      // the header, rows and total — separate grids — line up.
      const detailWidth = (d: (typeof DETAIL_META)[number]): number => {
        // The type is a chip of a known width, and the narration a sentence
        // that wraps to two lines — neither is measured.
        if (d.key === 'narration' || d.key === 'vchType') return d.w
        const cellText = (v: unknown): string => {
          if (d.num) {
            const num = Number(v) || 0
            return num > 0.004 ? (d.key === 'qty' ? formatNum(num) : formatINR(num)) : '—'
          }
          return String(v || '—')
        }
        let chars = 0
        for (const r of colRowsF) chars = Math.max(chars, cellText(r.detail ? r.detail[d.key as keyof typeof r.detail] : '').length)
        if (d.key === 'qty' || d.key === 'interest') {
          const sum = colRowsF.reduce((s, r) => s + (r.detail ? Number(r.detail[d.key as 'qty' | 'interest']) || 0 : 0), 0)
          chars = Math.max(chars, cellText(sum).length)
        }
        // Bold figures run wider than the old 6.9px a glyph, which is what was
        // clipping the last digit or two off a rate.
        const bodyW = Math.ceil(chars * 7.6) + 26
        const headW = Math.ceil(d.label.length * 8.4) + 24
        return Math.min(Math.max(bodyW, headW, 56), 340)
      }
      const detailTpl = detailCols.map((d) => `${detailWidth(d)}px`).join(' ')
      const detailW = detailCols.reduce((s, d) => s + detailWidth(d), 0)
      const COL_GRID = `${LEAD_W}px ${detailTpl ? detailTpl + ' ' : ''}repeat(${nCols},minmax(${COL_W}px,1fr)) ${TOT_W}px`
      const COL_MIN = LEAD_W + detailW + nCols * COL_W + TOT_W
      const pin = (bg: string, z = 1): React.CSSProperties => ({ position: 'sticky', left: 0, zIndex: z, background: bg })
      const colTotal = (i: number): number => colRowsF.reduce((t, r) => t + r.cells[i], 0)
      const grand = colRowsF.reduce((t, r) => t + r.total, 0)

      // Getting about a table wider than the screen.
      const pane = (): HTMLDivElement | null => lgPaneRef.current
      const maxLeft = Math.max(0, colScroll.total - colScroll.view)
      const offScreen = maxLeft > 1
      const hidden = offScreen ? Math.ceil((maxLeft - colScroll.left) / COL_W) : 0
      const glide = (to: number): void => pane()?.scrollTo({ left: Math.max(0, Math.min(maxLeft, to)), behavior: 'smooth' })
      const nudge = (dir: -1 | 1): void => glide(colScroll.left + dir * COL_W * 2)
      const showCol = (i: number): void => {
        const x = LEAD_W + detailW + i * COL_W
        glide(x - Math.max(LEAD_W, (colScroll.view - COL_W) / 2))
        setColFlash(i)
      }
      const dragBar = (e: React.MouseEvent<HTMLDivElement>): void => {
        const track = e.currentTarget.getBoundingClientRect()
        const el = pane()
        if (!el || !track.width) return
        const ratio = colScroll.total / track.width
        const move = (ev: MouseEvent): void => {
          el.scrollLeft = Math.max(0, Math.min(maxLeft, (ev.clientX - track.left) * ratio - el.clientWidth / 2))
        }
        move(e.nativeEvent)
        const up = (): void => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const thumb = {
        w: colScroll.total > 0 ? Math.max(8, (colScroll.view / colScroll.total) * 100) : 100,
        x: colScroll.total > 0 ? (colScroll.left / colScroll.total) * 100 : 0
      }
      const BAR_H = 40
      const arrow = (at: boolean): React.CSSProperties => ({
        height: 24,
        width: 24,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        border: `1px solid ${at ? A.edgeSoft : A.headEdge}`,
        background: at ? 'transparent' : '#fff',
        color: at ? A.none : A.frame,
        cursor: at ? 'default' : 'pointer'
      })
      const TOT_BG = 'linear-gradient(180deg,#F1F9F3,#E6F4EA)'
      return (
        <>
          {/* Every column, named, wherever it is — click one to go to it. */}
          {lgContras.length > 0 && (
            <div
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 4,
                width: colScroll.view || undefined,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 12px',
                background: '#FBFDFA',
                borderBottom: '1px solid #EAF0E9'
              }}
            >
              <span className="flex-none" style={{ ...cap, color: A.muted }}>
                {lgContras.length} {lgContras.length === 1 ? 'column' : 'columns'}
              </span>
              <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5" style={{ overflowX: 'auto' }}>
                {lgContras.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    title={`${c} — ${formatINR(colTotal(i))}`}
                    onClick={() => showCol(i)}
                    className="flex-none truncate"
                    style={{
                      maxWidth: 190,
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 10.5,
                      fontWeight: 700,
                      border: `1px solid ${colFlash === i ? A.frame : '#DCE7DB'}`,
                      background: colFlash === i ? A.frame : '#fff',
                      color: colFlash === i ? '#fff' : A.inkMid
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid" style={{ ...headRow, gridTemplateColumns: COL_GRID, minWidth: COL_MIN, minHeight: 48, letterSpacing: '.08em' }}>
            <span style={{ padding: '0 14px', alignSelf: 'stretch', display: 'flex', alignItems: 'center', ...pin('#0D4533', 3) }}>
              {lgCondensed ? (
                cCf.head('lead', 'Month', { onDark: true })
              ) : (
                <span className="inline-flex items-center gap-2">
                  {cCf.head('lead', 'Voucher', { onDark: true })} · {cCf.head('leadDate', 'date', { onDark: true })}
                </span>
              )}
            </span>
            {detailCols.map((d) => (
              <span key={d.key} style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: d.num ? 'flex-end' : 'flex-start' }}>
                {cCf.head(`d:${d.key}`, d.label, { onDark: true, align: d.num ? 'end' : 'start' })}
              </span>
            ))}
            {lgContras.map((c, i) => (
              <span
                key={c}
                title={c}
                style={{
                  padding: '6px 12px',
                  textAlign: 'right',
                  lineHeight: 1.3,
                  minWidth: 0,
                  background: colFlash === i ? A.frameDeep : undefined,
                  color: colFlash === i ? A.accent : undefined,
                  alignSelf: 'stretch',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end'
                }}
              >
                {/* The ledger's whole name, on two lines — BILLS DISCOUNTED -
                    BLACKSOIL CAPITAL cut to "BLACKSOIL CAP…" told eight such
                    columns apart by their tooltips only. */}
                <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'normal' }}>{c}</span>
                <span className="ml-1 flex-none">{cCf.head(`c:${c}`, c, { onDark: true, align: 'end', bare: true })}</span>
              </span>
            ))}
            {lgContras.length === 0 && <span style={{ padding: '0 10px', textAlign: 'right' }}>—</span>}
            <span style={{ padding: '0 14px', color: A.accent, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              {cCf.head('total', 'Total', { onDark: true, align: 'end' })}
            </span>
          </div>
          {colRowsF.map((r, i) => (
            <div
              key={`${r.label}-${i}`}
              className="grid items-center"
              style={{ gridTemplateColumns: COL_GRID, minWidth: COL_MIN, minHeight: 50, borderBottom: '1px solid #EFF3EE', background: stripe(i) }}
            >
              {/* The voucher first, its date under it — one pinned column that
                  reads as a label, not two figures fighting for 176px. */}
              <span
                className="flex h-full min-w-0 flex-col justify-center"
                style={{ padding: '6px 14px', ...pin(stripe(i)), borderRight: '1px solid #EAF0E9' }}
              >
                <span className="truncate" style={{ ...figS(12, A.ink, r.strong ? 800 : 700), fontFamily: r.lead ? MONO : SANS }}>
                  {r.label}
                </span>
                {!!r.lead && (
                  <span style={{ ...figS(10.5, A.muted, 600), marginTop: 2 }}>
                    {r.lead}
                  </span>
                )}
              </span>
              {detailCols.map((d) => {
                const dt = r.detail
                if (d.num) {
                  const v = dt ? Number(dt[d.key as 'rate' | 'qty' | 'interest']) || 0 : 0
                  const shownV = d.key === 'qty' ? formatNum(v) : formatINR(v)
                  return (
                    <span key={d.key} style={{ padding: '0 10px', textAlign: 'right', ...figS(11.5, v > 0.004 ? A.ink : A.none, v > 0.004 ? 700 : 500) }}>
                      {v > 0.004 ? shownV : '—'}
                    </span>
                  )
                }
                const t = dt ? String(dt[d.key as 'vchType' | 'refNo' | 'bargainNo' | 'narration'] || '') : ''
                if (d.key === 'vchType') {
                  return (
                    <span key={d.key} style={{ padding: '0 10px' }}>
                      {t ? typeChip(t.toUpperCase()) : <span style={{ color: A.none }}>—</span>}
                    </span>
                  )
                }
                if (d.key === 'narration') {
                  return (
                    <span
                      key={d.key}
                      title={t || undefined}
                      style={{
                        padding: '0 12px',
                        fontSize: 11,
                        fontWeight: 600,
                        lineHeight: 1.4,
                        color: t ? A.inkMid : A.none,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        whiteSpace: 'normal'
                      }}
                    >
                      {t || '—'}
                    </span>
                  )
                }
                // THE REF NO OPENS ITS VOUCHER, the way Tally drills from a
                // columnar line into the entry behind it.
                if (d.key === 'refNo' && t && dt?.entryId) {
                  return (
                    <button
                      key={d.key}
                      type="button"
                      title={`Open the voucher — ${t}`}
                      onClick={() => void openForAlter({ id: dt.entryId })}
                      className="min-w-0 text-left underline decoration-[#C3D2C6] decoration-dotted underline-offset-[3px] hover:text-[#1B4E82] hover:decoration-[#1B4E82]"
                      style={{ padding: '0 10px', ...figS(11.5, A.ink), ...clip }}
                    >
                      {t}
                    </button>
                  )
                }
                return (
                  <span
                    key={d.key}
                    title={t || undefined}
                    style={{ padding: '0 10px', ...(d.key === 'refNo' ? figS(11.5, t ? A.ink : A.none) : { fontSize: 11, fontWeight: 600, color: t ? A.inkMid : A.none }), ...clip }}
                  >
                    {t || '—'}
                  </span>
                )
              })}
              {r.cells.map((v, j) => (
                <span key={j} style={{ padding: '0 10px', textAlign: 'right', ...figS(12, v > 0.004 ? A.ink : '#C3D2C6', v > 0.004 ? 700 : 500) }}>
                  {v > 0.004 ? formatINR(v) : '—'}
                </span>
              ))}
              {lgContras.length === 0 && <span style={{ padding: '0 10px', textAlign: 'right', color: A.none }}>—</span>}
              <span className="flex h-full items-center justify-end" style={{ padding: '0 14px', background: 'rgba(199,240,63,.08)', ...figS(12.5) }}>
                {formatINR(r.total)}
              </span>
            </div>
          ))}
          {colRowsF.length === 0 && (
            <div style={{ position: 'sticky', left: 0, width: colScroll.view || undefined, padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
              {allRows.length === 0 ? 'Nothing posted to this ledger in the period.' : 'No voucher matches the filter.'}
            </div>
          )}
          <div
            className="grid items-center"
            style={{
              gridTemplateColumns: COL_GRID,
              minWidth: COL_MIN,
              minHeight: 44,
              background: TOT_BG,
              borderTop: '1px solid #BFE3CB',
              position: 'sticky',
              bottom: offScreen ? BAR_H : 0,
              zIndex: 3
            }}
          >
            <span className="flex h-full flex-col justify-center" style={{ padding: '0 14px', ...pin('#EAF6EE', 3) }}>
              <span style={{ ...cap, fontSize: 11, letterSpacing: '.06em', color: A.good }}>Total</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: A.good, marginTop: 1 }}>
                {colRowsF.length} {lgCondensed ? (colRowsF.length === 1 ? 'month' : 'months') : colRowsF.length === 1 ? 'voucher' : 'vouchers'}
              </span>
            </span>
            {detailCols.map((d) => {
              if (d.key === 'qty' || d.key === 'interest') {
                const sum = colRowsF.reduce((s, r) => s + (r.detail ? Number(r.detail[d.key as 'qty' | 'interest']) || 0 : 0), 0)
                return (
                  <span key={d.key} style={{ padding: '0 10px', textAlign: 'right', whiteSpace: 'nowrap', ...figS(12, A.good) }}>
                    {sum > 0.004 ? (d.key === 'qty' ? formatNum(sum) : formatINR(sum)) : '—'}
                  </span>
                )
              }
              return <span key={d.key} />
            })}
            {lgContras.map((c, i) => (
              <span key={c} style={{ padding: '0 10px', textAlign: 'right', whiteSpace: 'nowrap', ...figS(12, A.good) }}>
                {formatINR(colTotal(i))}
              </span>
            ))}
            {lgContras.length === 0 && <span />}
            <span style={{ padding: '0 14px', textAlign: 'right', ...figS(13, A.good) }}>{formatINR(grand)}</span>
          </div>
          {offScreen && (
            <div
              style={{
                position: 'sticky',
                left: 0,
                bottom: 0,
                zIndex: 4,
                width: colScroll.view || undefined,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: BAR_H,
                boxSizing: 'border-box',
                padding: '0 12px',
                background: 'rgba(255,255,255,.94)',
                backdropFilter: 'blur(3px)',
                borderTop: '1px solid #EAF0E9'
              }}
            >
              <button type="button" title="Back two columns" onClick={() => nudge(-1)} disabled={colScroll.left < 1} style={arrow(colScroll.left < 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <div
                className="colbar-track"
                onMouseDown={dragBar}
                title="Drag to move across the register"
                style={{ position: 'relative', height: 14, flex: 1, minWidth: 0, borderRadius: 999, background: A.fill2, boxShadow: `inset 0 0 0 1px ${A.edgeSoft}` }}
              >
                <div
                  className="colbar-thumb"
                  style={{
                    position: 'absolute',
                    top: 3,
                    bottom: 3,
                    left: `calc(${thumb.x}% + 3px)`,
                    width: `max(30px, calc(${thumb.w}% - 6px))`,
                    borderRadius: 999,
                    background: A.frame
                  }}
                />
              </div>
              <span
                className="flex-none whitespace-nowrap"
                style={{
                  fontSize: 9.5,
                  fontWeight: 800,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: hidden > 0 ? A.frame : A.muted,
                  background: hidden > 0 ? A.fill : 'transparent',
                  border: `1px solid ${hidden > 0 ? A.edgeSoft : 'transparent'}`,
                  borderRadius: 4,
                  padding: '3px 7px'
                }}
              >
                {hidden > 0 ? `${hidden} more ${hidden === 1 ? 'column' : 'columns'} →` : 'end of the register'}
              </span>
              <button type="button" title="On two columns" onClick={() => nudge(1)} disabled={colScroll.left >= maxLeft - 1} style={arrow(colScroll.left >= maxLeft - 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </>
      )
    })()

    // ── THE BILL-WISE VIEW ─────────────────────────────────────────────────
    const B_GRID = 'minmax(180px,1.2fr) 108px 96px 150px minmax(170px,1fr) 150px'
    if (!isParty) bwNav.current = { on: false, keys: [] }
    const billwiseView = !isParty ? (
      <div className="flex flex-col items-center gap-2.5" style={{ padding: '40px 20px' }}>
        <ReceiptText className="h-[30px] w-[30px]" style={{ color: '#C3D2C6' }} />
        <span style={{ fontSize: 13, fontWeight: 800 }}>{acName} is not a bill-wise account</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: A.muted, maxWidth: 420, textAlign: 'center', lineHeight: 1.55, textWrap: 'pretty' }}>
          Bill-wise details are kept only on Sundry Debtors and Sundry Creditors, where each bill raised is settled by
          the payments against it.
        </span>
      </div>
    ) : (
      (() => {
        // BILLS OUTSTANDING, THE WAY TALLY PRINTS THEM.
        //
        // One line per bill — its date, reference, the amount it was raised
        // for, what is still pending, when it fell due and by how many days it
        // is overdue — and, in Detailed, every voucher that made or settled it
        // printed under it: the SALE that raised it, then the receipts, notes
        // and journals set against it, each with its number and side. Then a
        // Sub Total, the On Account part of the balance no bill claims, and the
        // grand total, which is the ledger's balance.
        const allBills = byBillDate(((bills?.rows as Row[]) || []).filter((b) => Math.abs(n(b.pending)) > 0.004 || Math.abs(n(b.paid)) > 0.004))
        const debtor = !!bills?.debtor
        const billSide = (b: Row): 'dr' | 'cr' => {
          const s2 = String((b.origin as Row | null)?.side || '')
          return s2 === 'dr' || s2 === 'cr' ? s2 : debtor ? 'dr' : 'cr'
        }
        const sgn = (side: 'dr' | 'cr'): number => (side === 'dr' ? 1 : -1)
        const dc = (v: number, side: 'dr' | 'cr'): string => `${formatINR(Math.abs(v))} ${side === 'dr' ? 'Dr' : 'Cr'}`
        const signed = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : dc(v, v > 0 ? 'dr' : 'cr'))
        const vNo = (x: Row | null | undefined): string => String(x?.code || x?.vch_no || '')
        const vType = (t: unknown): string => {
          const s2 = String(t || '').toLowerCase()
          return s2 ? s2.replace(/\b\w/g, (m) => m.toUpperCase()) : ''
        }
        // The server states it already, signed the ledger's way (+ is Dr).
        const onAcc = n(bills?.on_account)
        // OVERDUE AS OF TODAY, not as of the period's end. The bills are read
        // as at the period's last day, and against 31-03 of next year every
        // bill raised this summer was "overdue 263 days". What a reader wants
        // is how late it is now — or at the period's end, if that has passed.
        const dayNo = (d: unknown): number => {
          const v = String(d || '').slice(0, 10)
          return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Math.round(new Date(`${v}T00:00:00`).getTime() / 86400000) : NaN
        }
        const asOfDay = dayNo(lgTo && lgTo < todayISO() ? lgTo : todayISO())
        // Invoice date or tanker empty, as the switch says; a tanker still on
        // the road is not due yet, so it has no date and nothing overdue.
        const dueText = (b: Row): string => {
          const d = billDue(b)
          return d.held ? 'Not empty yet' : formatDate(d.on)
        }
        const overdueOf = (b: Row): number => {
          const d = billDue(b)
          if (d.held) return 0
          const due = dayNo(d.on)
          return Number.isFinite(due) && Number.isFinite(asOfDay) ? Math.max(0, asOfDay - due) : 0
        }
        // A funnel on every column; the sub total reads the bills it leaves.
        const bwCf = colFilter(colF, 'ledger:bills', allBills, [
          { key: 'date', get: (b) => formatDate(billDateOf(b).on), sort: 'num' },
          { key: 'ref', get: (b) => b.ref },
          { key: 'opening', get: (b) => dc(n(b.opening), billSide(b)), sort: 'num' },
          { key: 'pending', get: (b) => (Math.abs(n(b.pending)) > 0.004 ? dc(Math.abs(n(b.pending)), billSide(b)) : 'Nil'), sort: 'num' },
          { key: 'due', get: (b) => dueText(b), sort: 'num' },
          { key: 'overdue', get: (b) => (Math.abs(n(b.pending)) > 0.004 && !billDue(b).held ? String(overdueOf(b)) : ''), sort: 'num' }
        ])
        const rows = bwCf.rows
        // What the keys walk: these bills, while this view is the one open.
        bwNav.current = { on: lgView === 'billwise', keys: rows.map((b, i) => `${String(b.ref)}-${i}`) }
        const subOpen = rows.reduce((t, b) => t + Math.abs(n(b.opening)) * sgn(billSide(b)), 0)
        const subPend = rows.reduce((t, b) => t + Math.abs(n(b.pending)) * sgn(billSide(b)), 0)
        const T_GRID = '104px minmax(210px,1.3fr) 150px 160px 160px 104px 92px'
        const bwKey: React.CSSProperties = {
          fontFamily: MONO,
          fontVariantNumeric: FIGS,
          fontSize: 10,
          fontWeight: 700,
          color: A.frame,
          background: '#fff',
          border: '1px solid #C3D2C6',
          borderBottomWidth: 2,
          borderRadius: 4,
          padding: '1px 6px',
          whiteSpace: 'nowrap'
        }
        const cell = (align: 'left' | 'right' = 'left'): React.CSSProperties => ({ padding: '0 10px', textAlign: align })
        return (
          <div style={{ minWidth: 980 }}>
            <div className="flex items-center gap-2.5" style={{ padding: '8px 14px', background: '#FBFDFA', borderBottom: '1px solid #EAF0E9' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: A.ink }}>Bills outstanding</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: A.muted }}>
                {lgTo ? `as on ${formatDate(lgTo)}` : 'as on today'}
                {bills?.credit_days ? ` · ${bills.credit_days} days credit` : ''}
              </span>
              <span className="flex-1" />
              {/* The keys, said where they act — the way Tally prints them on
                  its button bar rather than leaving them to be remembered. */}
              <span className="hidden items-center gap-1.5 whitespace-nowrap lg:flex" style={{ fontSize: 10.5, fontWeight: 700, color: A.muted }}>
                <span style={bwKey}>↑ ↓</span> pick a bill
                <span style={{ color: '#C3D2C6' }}>·</span>
                <span style={bwKey}>{chordLabel('Shift')} ↵</span> {bwDetailed ? 'fold it' : 'open it'}
              </span>
              {dueToggle()}
              <div className="flex items-center gap-[3px] rounded-[4px] p-[3px]" style={{ background: '#EEF3EC', border: '1px solid #DCE7DB' }}>
                <span className="flex items-center pl-1 pr-0.5" title="Alt F1 switches between Detailed and Condensed">
                  <span style={bwKey}>{chordLabel('Alt F1')}</span>
                </span>
                {([
                  { v: true, label: 'Detailed' },
                  { v: false, label: 'Condensed' }
                ] as const).map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => {
                      setBwDetailed(o.v)
                      setBwFlip(new Set())
                    }}
                    title={`${o.label} (Alt F1) — Shift Enter opens or folds one bill`}
                    className="h-7 rounded-[3px] px-2.5"
                    style={bwDetailed === o.v ? { background: A.frame, color: '#fff', fontSize: 11, fontWeight: 800 } : { color: A.muted, fontSize: 11, fontWeight: 700 }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid" style={{ ...headRow, gridTemplateColumns: T_GRID, height: 38 }}>
              <span style={{ ...cell(), display: 'flex', alignItems: 'center' }}>{bwCf.head('date', bwDueOn === 'empty' ? 'Empty date' : 'Date', { onDark: true })}</span>
              <span style={{ ...cell(), display: 'flex', alignItems: 'center' }}>{bwCf.head('ref', 'Ref. No.', { onDark: true })}</span>
              <span />
              <span style={{ ...cell('right'), display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{bwCf.head('opening', 'Opening amount', { onDark: true, align: 'end' })}</span>
              <span style={{ ...cell('right'), display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{bwCf.head('pending', 'Pending amount', { onDark: true, align: 'end' })}</span>
              <span style={{ ...cell(), display: 'flex', alignItems: 'center' }}>{bwCf.head('due', 'Due on', { onDark: true })}</span>
              <span style={{ ...cell('right'), display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{bwCf.head('overdue', 'Overdue by days', { onDark: true, align: 'end' })}</span>
            </div>
            {!bills && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>Reading the bills…</div>
            )}
            {!!bills && rows.length === 0 && Math.abs(onAcc) < 0.005 && (
              <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: A.muted }}>
                No bill on this ledger{lgTo ? ` as on ${formatDate(lgTo)}` : ''}.
              </div>
            )}
            {rows.map((b, i) => {
              const key = `${String(b.ref)}-${i}`
              const open = bwDetailed !== bwFlip.has(key)
              const picked = bwSel === i
              const side = billSide(b)
              const pend = Math.abs(n(b.pending))
              const lateBy = overdueOf(b)
              const over = pend > 0.004 && lateBy > 0
              const origin = (b.origin as Row | null) || null
              const sett = (b.settlements as Row[]) || []
              // The voucher that raised the bill first, then what settled it.
              const lines: Row[] = [
                ...(origin ? [{ ...origin, amount: Math.abs(n(b.opening)), side }] : []),
                ...sett.map((x) => ({ ...x, side: String(x.side || (side === 'dr' ? 'cr' : 'dr')) }))
              ]
              return (
                <div
                  key={key}
                  data-bw-row={i}
                  style={{
                    borderBottom: '1px solid #EFF3EE',
                    background: picked ? '#EEF6E8' : open && !bwDetailed ? '#F7FBF1' : stripe(i),
                    boxShadow: picked ? 'inset 3px 0 0 #12855A' : undefined
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setBwSel(i)
                      toggleBw(key)
                    }}
                    title={open ? 'Fold this bill (Shift Enter)' : 'Show the vouchers that make up this bill (Shift Enter)'}
                    className="grid w-full items-center text-left hover:bg-[#F1F8EC]"
                    style={{ gridTemplateColumns: T_GRID, minHeight: 36, cursor: 'pointer' }}
                  >
                    {(() => {
                      const d = billDateOf(b)
                      const plain = d.held || d.fallback
                      return (
                        <span title={billDateTitle(b)} style={{ ...cell(), ...figS(12, plain ? '#8CA396' : A.ink, plain ? 700 : 800), fontStyle: plain ? 'italic' : undefined }}>
                          {formatDate(d.on)}
                        </span>
                      )
                    })()}
                    <span className="flex min-w-0 items-center gap-1.5" style={cell()}>
                      <ChevronRight className="h-[14px] w-[14px] flex-none transition-transform" style={{ color: '#8CA396', transform: open ? 'rotate(90deg)' : 'none' }} />
                      {origin && (origin.order_id || origin.sale_id) && onOpenRecord ? (
                        // THE BILL ITSELF, one click away: the purchase or
                        // sale that raised it. The rest of the row still
                        // folds and unfolds the bill.
                        <span
                          role="link"
                          tabIndex={-1}
                          title={`Open ${String(b.ref || 'this bill')} — the ${origin.order_id ? 'purchase' : 'sale'} that raised it`}
                          onClick={(e) => {
                            e.stopPropagation()
                            openRowSource(origin, ledgerId)
                          }}
                          className="truncate underline decoration-[#C3D2C6] decoration-dotted underline-offset-[3px] hover:text-[#1B4E82] hover:decoration-[#1B4E82]"
                          style={figS(12, A.ink, 700)}
                        >
                          {String(b.ref || '—')}
                        </span>
                      ) : (
                        <span className="truncate" style={figS(12, A.ink, 700)}>
                          {String(b.ref || '—')}
                        </span>
                      )}
                    </span>
                    <span />
                    <span style={{ ...cell('right'), ...figS(12, '#33473E', 600) }}>{dc(n(b.opening), side)}</span>
                    <span style={{ ...cell('right'), ...figS(12.5, over ? A.bad : A.ink, 800) }}>{pend > 0.004 ? dc(pend, side) : 'Nil'}</span>
                    {(() => {
                      const d = billDue(b)
                      return (
                        <span
                          title={
                            d.held
                              ? 'The tanker has not been emptied yet — not due'
                              : d.fallback
                                ? 'No tanker behind this bill — due from its invoice date'
                                : bwDueOn === 'empty' && b.empty_on
                                  ? `Tanker emptied ${formatDate(String(b.empty_on))}`
                                  : undefined
                          }
                          style={{
                            ...cell(),
                            ...figS(11.5, d.held || d.fallback ? '#8CA396' : '#33473E', 600),
                            fontStyle: d.held || d.fallback ? 'italic' : undefined
                          }}
                        >
                          {dueText(b)}
                        </span>
                      )
                    })()}
                    <span style={{ ...cell('right'), ...figS(12, over ? A.bad : A.muted, over ? 800 : 600), fontStyle: 'italic' }}>{pend > 0.004 && !billDue(b).held ? lateBy : ''}</span>
                  </button>
                  {open &&
                    lines.map((x, xi) => (
                      <div key={xi} className="grid items-center" style={{ gridTemplateColumns: T_GRID, minHeight: 24, fontStyle: 'italic' }}>
                        <span />
                        {/* Every voucher that made or settled the bill opens —
                            a purchase or sale to its page, a note, payment or
                            journal to the voucher. */}
                        <button
                          type="button"
                          disabled={!x.entry_id}
                          onClick={() => openRowSource({ ...x, id: x.entry_id }, ledgerId)}
                          title={
                            x.entry_id
                              ? `Open ${vType(x.vch_type) || 'voucher'} ${vNo(x)}${x.order_id ? ' — the purchase' : x.sale_id ? ' — the sale' : ''}${x.narration ? ` · ${String(x.narration)}` : ''}`
                              : String(x.narration || '')
                          }
                          className="group flex min-w-0 items-baseline gap-2.5 rounded-[4px] text-left hover:bg-[#EEF4FB] disabled:cursor-default disabled:hover:bg-transparent"
                          style={{ padding: '2px 10px 2px 26px', fontStyle: 'italic' }}
                        >
                          <span style={figS(11, '#5A6B62', 600)}>{formatDate(x.entry_date)}</span>
                          <span className="whitespace-nowrap group-hover:text-[#1B4E82]" style={{ fontSize: 11, fontWeight: 700, color: '#33473E' }}>
                            {vType(x.vch_type)}
                          </span>
                          <span
                            className="truncate underline decoration-[#C3D2C6] decoration-dotted underline-offset-[3px] group-hover:text-[#1B4E82] group-hover:decoration-[#1B4E82]"
                            style={figS(11, '#5A6B62', 600)}
                          >
                            {vNo(x)}
                          </span>
                        </button>
                        <span style={{ ...cell('right'), ...figS(11, String(x.side) === 'dr' ? A.dr : A.cr, 600) }}>
                          {dc(n(x.amount), String(x.side) === 'dr' ? 'dr' : 'cr')}
                        </span>
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                    ))}
                  {open && lines.length === 0 && (
                    <div style={{ padding: '2px 10px 8px 140px', fontSize: 11, fontStyle: 'italic', color: A.muted }}>No voucher on record for this bill yet.</div>
                  )}
                  {open && <div style={{ height: 4 }} />}
                </div>
              )
            })}
            {!!bills && rows.length > 0 && (
              <div className="grid items-center" style={{ gridTemplateColumns: T_GRID, minHeight: 38, background: '#FBFDFA', borderBottom: '1px solid #EAF0E9' }}>
                <span />
                <span style={{ ...cell(), fontSize: 12.5, fontWeight: 800, color: A.ink }}>Sub Total</span>
                <span />
                <span style={{ ...cell('right'), ...figS(12, '#33473E', 700), fontStyle: 'italic' }}>{signed(subOpen)}</span>
                <span style={{ ...cell('right'), ...figS(12, A.ink, 800), fontStyle: 'italic' }}>{signed(subPend)}</span>
                <span />
                <span />
              </div>
            )}
            {!!bills && Math.abs(onAcc) > 0.004 && (
              <div className="grid items-center" style={{ gridTemplateColumns: T_GRID, minHeight: 38, background: 'linear-gradient(180deg,#FFF9EC,#FFF4DD)', borderBottom: '1px solid #F1E6CC' }}>
                <span />
                <span style={{ ...cell(), fontSize: 12.5, fontWeight: 700, fontStyle: 'italic', color: '#6B4200' }} title="The part of the balance no bill answers for — an advance, or a payment not set against a bill">
                  On Account
                </span>
                <span />
                <span style={{ ...cell('right'), ...figS(12, A.warn, 700), fontStyle: 'italic' }}>{signed(onAcc)}</span>
                <span style={{ ...cell('right'), ...figS(12.5, A.warn, 800), fontStyle: 'italic' }}>{signed(onAcc)}</span>
                <span />
                <span />
              </div>
            )}
            {!!bills && (
              <div className="grid items-center" style={{ gridTemplateColumns: T_GRID, minHeight: 44, background: 'linear-gradient(180deg,#F1F9F3,#E6F4EA)', borderTop: '1px solid #BFE3CB' }}>
                <span />
                <span style={{ ...cell(), ...cap, fontSize: 11, letterSpacing: '.06em', color: A.good }}>
                  Total · {rows.length} {rows.length === 1 ? 'bill' : 'bills'}
                </span>
                <span />
                <span style={{ ...cell('right'), ...figS(12.5, A.good, 800) }}>{signed(subOpen + onAcc)}</span>
                <span style={{ ...cell('right'), ...figS(13, A.good, 800) }}>{signed(subPend + onAcc)}</span>
                <span />
                <span />
              </div>
            )}
          </div>
        )
      })()
    )

    // ── THE PAGE ───────────────────────────────────────────────────────────
    const kpis = [
      { k: 'Opening', v: bal(stmt.opening), bg: '#fff', bd: '#DCE7DB', kFg: A.muted, fg: A.ink },
      { k: shownFoot ? 'Debits shown' : 'Debits', v: formatINR(shownFoot ? fDr : stmt.totDr), bg: '#F5F8FD', bd: '#D6E3F3', kFg: A.dr, fg: A.dr },
      { k: shownFoot ? 'Credits shown' : 'Credits', v: formatINR(shownFoot ? fCr : stmt.totCr), bg: '#FDF7F6', bd: '#F0D6D4', kFg: A.cr, fg: A.cr },
      { k: 'Closing', v: bal(stmt.closing), bg: 'linear-gradient(160deg,#145A43,#0B3D2E)', bd: A.frame, kFg: A.inkSky, fg: A.accent }
    ]

    // THE SUMMARY, CALLED UP OVER THE REGISTER FROM THE RIGHT — F8 or the
    // Summary button — and put away by Esc, F8 again, or a click on the
    // register. It used to stand as a column beside the table on a wide
    // screen, which cost the register a fifth of its width for figures the
    // header line already states.
    const railDrawer = lgRailOpen && !!ledgerAccount && (
      <>
        <div className="absolute inset-0 z-[30]" style={{ background: 'rgba(10,31,23,.28)' }} onMouseDown={() => setLgRailOpen(false)} />
        <div
          className="absolute z-[31] flex flex-col overflow-hidden"
          style={{
            right: W >= 1400 ? 20 : 14,
            top: W >= 1400 ? 16 : 12,
            bottom: W >= 1400 ? 14 : 12,
            width: `min(${railW}px, calc(100% - 28px))`,
            background: A.paper,
            border: '1px solid #DCE7DB',
            borderRadius: 12,
            boxShadow: '-18px 0 44px -22px rgba(10,31,23,.5)'
          }}
        >
          <div className="flex flex-none items-center gap-2" style={{ padding: '10px 12px', borderBottom: '1px solid #EAF0E9', background: '#fff' }}>
            <PieChart className="h-[17px] w-[17px] flex-none" style={{ color: A.frame }} />
            <span className="min-w-0 flex-1 truncate" style={{ ...cap, fontSize: 10 }}>
              Summary
            </span>
            <button
              type="button"
              title="Close (Esc)"
              onClick={() => setLgRailOpen(false)}
              className="flex h-8 flex-none items-center rounded-[7px] px-2.5"
              style={{ border: '1px solid #DCE7DB', fontSize: 10, fontWeight: 800, letterSpacing: '.04em', color: A.muted }}
            >
              ESC
            </button>
          </div>
          <div className="sc flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: 12 }}>
                <div
                  className="relative flex-none overflow-hidden"
                  style={{
                    borderRadius: 12,
                    background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 48%,#072B20 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.1),0 16px 34px -16px rgba(7,43,32,.7)',
                    padding: 18,
                    color: '#fff'
                  }}
                >
                  <div
                    className="pointer-events-none absolute rounded-full"
                    style={{ top: -60, right: -60, width: 180, height: 180, background: 'radial-gradient(circle,rgba(199,240,63,.18),transparent 70%)' }}
                  />
                  <div className="relative">
                    <div style={{ ...cap, fontSize: 9.5, letterSpacing: '.14em', color: A.inkSky }}>Closing balance</div>
                    <div style={{ ...figS(24, A.accent), letterSpacing: '-0.03em', marginTop: 6 }}>{bal(stmt.closing)}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#A9CDBB', marginTop: 4, lineHeight: 1.45, textWrap: 'pretty' }}>{closeMeaning}</div>
                    <div className="mt-3.5 flex h-2 overflow-hidden rounded-[4px]" style={{ background: 'rgba(255,255,255,.1)' }}>
                      <div className="h-full" style={{ width: `${drShare}%`, background: 'linear-gradient(90deg,#9EC2EA,#5B8FCC)' }} />
                      <div className="h-full flex-1" style={{ background: 'linear-gradient(90deg,#E7A7A0,#C2554A)' }} />
                    </div>
                    <div className="mt-1.5 flex justify-between" style={{ fontSize: 10, fontWeight: 700, color: '#A9CDBB' }}>
                      <span>Debits {Math.round(drShare)}%</span>
                      <span>Credits {Math.round(100 - drShare)}%</span>
                    </div>
                  </div>
                  <div className="relative mt-3.5 flex flex-col gap-2">
                    {[
                      { k: 'Opening', v: bal(stmt.opening) },
                      { k: 'Debits', v: formatINR(stmt.totDr) },
                      { k: 'Credits', v: formatINR(stmt.totCr) }
                    ].map((k) => (
                      <div
                        key={k.k}
                        className="flex items-baseline justify-between gap-2.5"
                        style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, padding: '9px 12px' }}
                      >
                        <span style={{ ...cap, fontSize: 9.5, letterSpacing: '.12em', color: A.inkSky }}>{k.k}</span>
                        <span className="whitespace-nowrap" style={figS(13, '#fff')}>
                          {k.v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex-none overflow-hidden" style={card}>
                  <div className="flex items-center gap-[9px]" style={{ padding: '12px 15px', borderBottom: '1px solid #EAF0E9' }}>
                    <Network className="h-[17px] w-[17px]" style={{ color: A.frame }} />
                    <span style={{ ...cap, fontSize: 10 }}>Where it moved</span>
                  </div>
                  <div className="flex flex-col gap-2.5" style={{ padding: '6px 15px 12px' }}>
                    {contraTotals.slice(0, 6).map((c) => {
                      const acct = accounts.find((a2) => String(a2.name) === c.name)
                      return (
                        <button
                          key={c.name}
                          type="button"
                          disabled={!acct}
                          title={acct ? `Open ${c.name}` : c.name}
                          onClick={() => acct && openLedger(Number(acct.id))}
                          className="block w-full text-left"
                          style={{ cursor: acct ? 'pointer' : 'default' }}
                        >
                          <span className="mt-1.5 flex items-baseline justify-between gap-2.5">
                            <span className="min-w-0 truncate" style={{ fontSize: 11.5, fontWeight: 800 }}>
                              {c.name}
                            </span>
                            <span className="whitespace-nowrap" style={figS(11.5)}>
                              {formatINR(c.v)}
                            </span>
                          </span>
                          <span className="mt-[5px] block h-1.5 overflow-hidden rounded-[3px]" style={{ background: '#EEF3EC' }}>
                            <span className="block h-full rounded-[3px]" style={{ width: `${(c.v / maxContra) * 100}%`, background: 'linear-gradient(90deg,#9FE3BF,#12855A)' }} />
                          </span>
                        </button>
                      )
                    })}
                    {contraTotals.length === 0 && (
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: A.muted, padding: '8px 0' }}>Nothing posted yet.</span>
                    )}
                  </div>
                </div>

                {mix.length > 0 && (
                  <div className="flex-none" style={{ ...card, padding: '12px 15px' }}>
                    <div style={{ ...cap, fontSize: 10, marginBottom: 9 }}>Voucher mix</div>
                    <div className="flex flex-wrap gap-1.5">
                      {mix.map(([t, cnt]) => {
                        const tt = toneOf(t)
                        return (
                          <span
                            key={t}
                            className="inline-flex items-center gap-1.5"
                            style={{ fontSize: 10.5, fontWeight: 800, background: tt.bg, color: tt.fg, border: `1px solid ${tt.bd}`, borderRadius: 5, padding: '4px 8px' }}
                          >
                            {t || '—'}
                            <span style={{ fontFamily: MONO, fontVariantNumeric: FIGS }}>{cnt}</span>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
          </div>
        </div>
      </>
    )

    const body = (
      <div className="relative flex min-h-0 flex-1" style={{ gap: gutter, padding: bodyPad }}>
        {drawer}
        {railDrawer}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {!ledgerAccount ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5" style={{ ...card, padding: '30px 16px' }}>
              <BookOpen className="h-8 w-8" style={{ color: '#C3D2C6' }} />
              <div style={{ fontSize: 13, fontWeight: 800 }}>Pick a ledger</div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: A.muted, maxWidth: 420, textAlign: 'center', lineHeight: 1.55 }}>
                Press {fKeyLabel('F4')} or choose one from the list. Its vouchers, its months, what it was posted against, and the bills behind the balance all read the same
                postings.
              </div>
              <button
                type="button"
                onClick={() => setLgPickerOpen(true)}
                className="mt-1 flex h-9 items-center gap-1.5 rounded-[7px] px-3.5"
                style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)', color: '#fff', fontSize: 12, fontWeight: 800 }}
              >
                <Search className="h-4 w-4" />
                Choose a ledger
              </button>
            </div>
          ) : (
            <>
              {/* ONE SLIM LINE: the ledger, what it is, where it stands and
                  the two buttons — so the register below gets the height. */}
              <div className="relative flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5" style={{ ...card, padding: '7px 12px' }}>
                <div
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px]"
                  style={{ background: 'linear-gradient(160deg,#145A43,#0B3D2E)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)' }}
                >
                  <AcIcon className="h-[17px] w-[17px]" style={{ color: A.accent }} />
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-[7px]">
                    <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>{acName}</span>
                    <span
                      style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', color: '#33473E', background: '#EEF3EC', border: '1px solid #DCE7DB', borderRadius: 4, padding: '3px 8px' }}
                    >
                      {group || 'Ungrouped'}
                    </span>
                    {isParty && (
                      <span
                        style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', color: A.warn, background: '#FFF4DD', border: '1px solid #F1D9A6', borderRadius: 4, padding: '3px 8px' }}
                      >
                        BILL-WISE
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: A.muted, fontVariantNumeric: FIGS }}>
                    {stmt.rows.length} {stmt.rows.length === 1 ? 'voucher' : 'vouchers'} · opening {bal(stmt.opening)} · closing {bal(stmt.closing)}
                    {lgBooksFrom ? ` · books from ${formatDate(lgBooksFrom)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  title={`Summary — closing balance, where it moved, voucher mix (${fKeyLabel('F8')})`}
                  aria-expanded={lgRailOpen}
                  onClick={() => {
                    setLgPickerOpen(false)
                    setLgRailOpen((o) => !o)
                  }}
                  className="flex h-8 flex-none items-center gap-[7px] rounded-[7px] px-2.5"
                  style={{
                    border: `1px solid ${lgRailOpen ? A.frame : '#C3D2C6'}`,
                    background: lgRailOpen ? '#EEF3EC' : '#fff',
                    fontSize: 12,
                    fontWeight: 800,
                    color: '#33473E'
                  }}
                >
                  <PieChart className="h-[17px] w-[17px]" />
                  Summary
                  <span style={{ ...figS(9.5, A.muted, 600), border: '1px solid #DCE7DB', borderRadius: 3, padding: '1px 5px' }}>{fKeyLabel('F8')}</span>
                </button>
                <button
                  type="button"
                  title="Change ledger (F4)"
                  onClick={() => {
                    setLgRailOpen(false)
                    setLgPickerOpen(true)
                  }}
                  className="flex h-8 flex-none items-center gap-[7px] rounded-[7px] px-2.5"
                  style={{ border: '1px solid #C3D2C6', background: '#fff', fontSize: 12, fontWeight: 800, color: '#33473E' }}
                >
                  <ArrowUpDown className="h-[17px] w-[17px]" />
                  Change ledger
                  <span style={{ ...figS(9.5, A.muted, 600), border: '1px solid #DCE7DB', borderRadius: 3, padding: '1px 5px' }}>{fKeyLabel('F4')}</span>
                </button>
              </div>

              {narrowRail && (
                <div className="grid flex-none gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
                  {kpis.map((k) => (
                    <div
                      key={k.k}
                      style={{ background: k.bg, border: `1px solid ${k.bd}`, borderRadius: 9, padding: '10px 13px', boxShadow: '0 1px 2px rgba(10,31,23,.04)' }}
                    >
                      <div style={{ ...cap, color: k.kFg }}>{k.k}</div>
                      <div className="whitespace-nowrap" style={{ ...figS(14.5, k.fg), marginTop: 5 }}>
                        {k.v}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={card}>
                {!canFilter && (
                <div className="flex flex-none items-center gap-2.5" style={{ padding: '8px 14px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F4F7F2)' }}>
                  <curView.Icon className="h-[17px] w-[17px] flex-none" style={{ color: '#12855A' }} />
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>{curView.label}</span>
                  <span className="min-w-0 truncate" style={{ fontSize: 11.5, fontWeight: 600, color: A.muted }}>
                    {viewNote}
                  </span>
                </div>
                )}

                {canFilter && (
                  <div className="flex flex-none flex-wrap items-center gap-2" style={{ padding: '6px 12px', borderBottom: '1px solid #EAF0E9', background: 'linear-gradient(180deg,#FBFDFA,#F7FAF6)' }}>
                    {/* Which view this is, at the front of the one toolbar —
                        what it shows is on hover. */}
                    <span className="flex flex-none items-center gap-1.5" title={viewNote || undefined}>
                      <curView.Icon className="h-4 w-4 flex-none" style={{ color: '#12855A' }} />
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.13em', textTransform: 'uppercase' }}>{curView.label}</span>
                    </span>
                    <span className="h-5 w-px flex-none" style={{ background: '#DCE7DB' }} />
                    <div
                      className="flex h-[30px] items-center gap-2 rounded-[7px] px-2.5"
                      style={{
                        flex: '1 1 260px',
                        maxWidth: 420,
                        border: `1px solid ${fq ? '#12855A' : '#C3D2C6'}`,
                        background: '#fff',
                        boxShadow: 'inset 0 1px 2px rgba(10,31,23,.04)'
                      }}
                    >
                      <Search className="h-[17px] w-[17px] flex-none" style={{ color: A.muted }} />
                      <input
                        value={lgFQuery}
                        onChange={(e) => {
                          setLgFQuery(e.target.value)
                          setLgOpenRow(null)
                        }}
                        placeholder="Voucher no, ref, ledger name or narration"
                        className="min-w-0 flex-1 border-0 bg-transparent outline-none"
                        style={{ fontSize: 12, fontWeight: 600, color: A.ink }}
                      />
                      {!!lgFQuery && (
                        <button type="button" title="Clear" onClick={() => setLgFQuery('')} style={{ color: A.muted }}>
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <div className="sc flex min-w-0 items-center gap-1.5 overflow-x-auto" style={{ flex: '1 1 auto' }}>
                      <span className="whitespace-nowrap" style={{ ...cap, fontSize: 9.5, letterSpacing: '.12em', color: A.muted }}>
                        Voucher type
                      </span>
                      {[{ k: 'ALL', label: 'All', n: allRows.length }, ...presentTypes.map((t) => ({ k: t, label: typeLabel(t), n: allRows.filter((r) => typeOf(r) === t).length }))].map(
                        (c) => {
                          const on = c.k === 'ALL' ? fTypes.length === 0 : fTypes.includes(c.k)
                          const tt = toneOf(c.k)
                          return (
                            <button
                              key={c.k}
                              type="button"
                              onClick={() => {
                                setLgOpenRow(null)
                                setLgFTypes((p) => (c.k === 'ALL' ? [] : p.includes(c.k) ? p.filter((x) => x !== c.k) : [...p, c.k]))
                              }}
                              className="flex h-[26px] flex-none items-center gap-1.5 whitespace-nowrap rounded-[13px] px-2.5"
                              style={{
                                background: on ? (c.k === 'ALL' ? 'linear-gradient(180deg,#11503C,#0B3D2E)' : tt.bg) : '#fff',
                                border: `1px solid ${on ? (c.k === 'ALL' ? A.frame : tt.fg) : '#DCE7DB'}`,
                                color: on ? (c.k === 'ALL' ? '#fff' : tt.fg) : '#33473E',
                                boxShadow: on ? '0 3px 8px -4px rgba(10,31,23,.35)' : 'none',
                                fontSize: 11,
                                fontWeight: 800
                              }}
                            >
                              {on && c.k !== 'ALL' && <Check className="h-3.5 w-3.5" />}
                              {c.label}
                              <span style={{ ...figS(10, 'currentColor', 600), opacity: 0.8 }}>{c.n}</span>
                            </button>
                          )
                        }
                      )}
                    </div>
                    {filtering && (
                      <div className="flex flex-none items-center gap-2">
                        <span className="whitespace-nowrap" style={{ fontSize: 11, fontWeight: 700, color: A.good }}>
                          {vRows.length} of {allRows.length} {allRows.length === 1 ? 'voucher' : 'vouchers'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setLgFTypes([])
                            setLgFQuery('')
                            lgCf.clear()
                          }}
                          className="flex h-[30px] items-center gap-[5px] whitespace-nowrap rounded-[6px] px-2.5"
                          style={{ border: '1px solid #C3D2C6', background: '#fff', fontSize: 11, fontWeight: 800, color: '#33473E' }}
                        >
                          <FilterX className="h-[15px] w-[15px]" />
                          Clear
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* The columnar view draws its own sideways bar at the foot of
                    the table, so the browser's is suppressed there only. */}
                <div ref={lgPaneRef} className={cn('sc-both min-h-0 flex-1 overflow-auto', lgView === 'columnar' && 'no-hscrollbar')}>
                  {lgView === 'vouchers' && vouchersView}
                  {lgView === 'monthly' && monthlyView}
                  {lgView === 'columnar' && columnarView}
                  {lgView === 'billwise' && billwiseView}
                </div>

                <div
                  className="flex flex-none flex-wrap items-center gap-x-[18px] gap-y-1.5"
                  style={{ borderTop: '1px solid #DCE7DB', background: 'linear-gradient(180deg,#F7FAF6,#EEF3EC)', padding: '10px 16px' }}
                >
                  <span style={{ ...cap, fontSize: 10, color: A.muted }}>{shownFoot ? `Shown · ${vRows.length} of ${allRows.length}` : 'Period total'}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#33473E' }}>
                    Dr <span style={figS(11.5, A.dr)}>{formatINR(shownFoot ? fDr : stmt.totDr)}</span>
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#33473E' }}>
                    Cr <span style={figS(11.5, A.cr)}>{formatINR(shownFoot ? fCr : stmt.totCr)}</span>
                  </span>
                  <span className="flex-1" />
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: A.ink }}>
                    Closing <span style={figS(11.5, balFg(stmt.closing))}>{bal(stmt.closing)}</span>
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

      </div>
    )

    return { strip, body }
  })()

  // The desktop ledger tables' column funnels (lib/colFilters).
  const dBillRef = (l: Row): string => {
    const fac = facilityRef(l)
    if (fac) return `${fac.kind} ${fac.no}`
    const refs = [...new Set(((l.allocs as Row[]) || []).map((a2) => String(a2.ref_name || '').trim()).filter(Boolean))]
    const text = refs.length ? refs.join(', ') : String(l.vch_no || '').trim()
    if (text) return text
    return ((l.allocs as Row[]) || []).some((a2) => String(a2.method) === 'on_account') ? 'On account' : '—'
  }
  const dStmtCf = colFilter<Row>(colF, 'd:ledger:stmt', stmt.rows as Row[], [
    { key: 'date', get: (l) => formatDate(l.entry_date), sort: 'num' },
    { key: 'particulars', get: (l) => l.particulars || l.vch_type },
    { key: 'vch', get: (l) => l.voucher_code },
    { key: 'ref', get: (l) => dBillRef(l) },
    { key: 'dr', get: (l) => (Number(l.dr) ? formatINR(l.dr) : ''), sort: 'num' },
    { key: 'cr', get: (l) => (Number(l.cr) ? formatINR(l.cr) : ''), sort: 'num' },
    { key: 'balance', get: (l) => `${formatINR(Math.abs(l.running))} ${l.running >= 0 ? 'Dr' : 'Cr'}`, sort: 'num' },
    ...(lgDetailed
      ? legCols.map((c) => ({
          key: `leg:${c}`,
          get: (l: Row) => {
            const v = legShare(l, c)
            return Math.abs(v) > 0.004 ? `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}` : ''
          },
          sort: 'num' as const
        }))
      : [])
  ])
  const dStmtRows = dStmtCf.rows
  const dMonCf = colFilter(colF, 'd:ledger:monthly', monthly, [
    { key: 'month', get: (m) => monthLabelLong(m.month), sort: 'none' },
    { key: 'dr', get: (m) => (m.dr ? formatINR(m.dr) : ''), sort: 'num' },
    { key: 'cr', get: (m) => (m.cr ? formatINR(m.cr) : ''), sort: 'num' },
    { key: 'closing', get: (m) => `${formatINR(Math.abs(m.closing))} ${m.closing >= 0 ? 'Dr' : 'Cr'}`, sort: 'num' }
  ])
  const dMonthly = dMonCf.rows
  const ledgerScreen = (
    <div className="flex flex-1 flex-col gap-3 p-3">
      {/* The search bar IS the ledger picker: one line across the top that
          opens the list over the page. Nothing is chosen from it directly, so
          it reads as a button rather than a field. */}
      <button
        type="button"
        onClick={() => setLgPickerOpen(true)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left shadow-sm transition-colors hover:bg-amber-50',
          T.paperEdge,
          T.paper
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        {ledgerAccount ? (
          <>
            <span className="truncate text-[14px] font-semibold text-[#0B3D2E]">{String(ledgerAccount.name)}</span>
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
              {String(ledgerAccount.acc_group || '')}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">Search ledger… ↑↓ to move, Enter to open</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="rounded bg-[#0B3D2E]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#0B3D2E]">
            change
          </span>
          <span className="rounded border border-[#0B3D2E]/25 px-1 py-0.5 text-[10px] font-bold text-[#0B3D2E]/70">F4</span>
        </span>
      </button>

      {/* Over the page, not beside it — so the statement below keeps the full
          width whether the picker is up or not. */}
      {lgPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[8vh]"
          onClick={() => ledgerId && setLgPickerOpen(false)}
        >
          <div
            className={cn('flex max-h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border shadow-2xl', T.paperEdge, T.paper)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={cn('flex items-center gap-2 px-4 py-2 text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
              Ledgers
              <span className="ml-auto text-[10px] font-normal normal-case tracking-normal opacity-80">
                {filteredAccounts.length} of {accounts.length}
                {ledgerId ? ' · Esc to close' : ''}
              </span>
            </div>
            <div className="p-2">
              <Input
                ref={ledgerSearchRef}
                className="h-9 bg-white text-[13px]"
                placeholder="Search ledger… ↑↓ to move, Enter to open"
                value={ledgerSearch}
                onChange={(e) => setLedgerSearch(e.target.value)}
                onKeyDown={ledgerKeyNav}
              />
            </div>
            <div className="flex-1 overflow-auto px-2 pb-2">
              {filteredAccounts.length === 0 ? (
                <div className="px-2 py-10 text-center text-sm text-muted-foreground">No ledger matches that.</div>
              ) : (
                filteredAccounts.map((a, ai) => ledgerRow(a, ai))
              )}
            </div>
          </div>
        </div>
      )}

      <div className={cn('min-w-0 flex-1 rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        {!ledgerAccount ? (
          <div className="flex h-full items-center justify-center p-10 text-muted-foreground">
            <span className="flex items-center gap-2 text-sm"><Landmark className="h-4 w-4" /> Pick a ledger to see its vouchers.</span>
          </div>
        ) : (
          <>
            <div className={cn('flex flex-wrap items-center gap-2 rounded-t-md px-4 py-2', T.headBar)}>
              <span className="min-w-0 truncate text-[13px] font-bold uppercase tracking-widest">{ledgerAccount.name}</span>
              <span className="text-[11px]">{ledgerAccount.acc_group}</span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <FyPicker from={lgFrom} to={lgTo} onRange={(f, t) => { setLgFrom(f); setLgTo(t) }} className="h-8 w-28 bg-white text-xs" />
                <div className="w-40"><DatePicker value={lgFrom} onChange={setLgFrom} max={lgTo || undefined} /></div>
                <span className="text-[11px]">to</span>
                <div className="w-40"><DatePicker value={lgTo} onChange={setLgTo} min={lgFrom || undefined} /></div>
                {(lgFrom || lgTo) && (
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setLgFrom(''); setLgTo('') }}>
                    All
                  </Button>
                )}
                <Button
                  variant={lgMonthly ? 'default' : 'outline'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', lgMonthly && 'bg-[#0B3D2E] hover:bg-[#0A3327]')}
                  onClick={() => setLgMonthly((m) => !m)}
                >
                  Monthly
                </Button>
                <Button
                  variant={lgDetailed ? 'default' : 'outline'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', lgDetailed && 'bg-[#0B3D2E] hover:bg-[#0A3327]')}
                  title="Columnar register — a column per ledger involved (Alt+F1)"
                  onClick={() => setLgDetailed((d) => !d)}
                >
                  Columnar
                </Button>
              </div>
            </div>
            {lgBills ? (
              // Tally's Ledger Voucher Outstanding: a line per open bill, then a
              // sub total, then whatever the bills do not account for.
              (() => {
                const dc = bills?.debtor ? 'Dr' : 'Cr'
                const dDue = (b: Row): string => {
                  const d = billDue(b)
                  return d.held ? 'Not empty yet' : formatDate(d.on)
                }
                const dLate = (b: Row): number => billDue(b).late
                const dBillCf = colFilter<Row>(colF, 'd:ledger:bills', byBillDate((bills?.rows as Row[]) || []), [
                  { key: 'date', get: (b) => formatDate(billDateOf(b).on), sort: 'num' },
                  { key: 'ref', get: (b) => b.ref },
                  { key: 'opening', get: (b) => `${formatINR(Math.abs(Number(b.opening)))} ${dc}`, sort: 'num' },
                  { key: 'pending', get: (b) => `${formatINR(Math.abs(Number(b.pending)))} ${dc}`, sort: 'num' },
                  { key: 'due', get: (b) => dDue(b), sort: 'num' },
                  { key: 'overdue', get: (b) => (dLate(b) > 0 ? String(dLate(b)) : '—'), sort: 'num' }
                ])
                const rows = dBillCf.rows
                // Narrowed by a funnel, the sub total is the shown bills' own.
                const bSum = (k: string): number =>
                  dBillCf.active ? rows.reduce((t, b) => t + Math.abs(Number(b[k]) || 0), 0) : Math.abs(Number(bills?.[`total_${k}`]) || 0)
                const onAcc = Number(bills?.on_account) || 0
                return (
                  <div className="max-h-[calc(100vh-225px)] overflow-auto">
                    <div className="flex items-center justify-end border-b bg-[#FBFDFA] px-4 py-1.5">{dueToggle()}</div>
                    <table className="w-full text-[13px]">
                      <thead className="sticky top-0 bg-[#EAF0E9]">
                        <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                          <th className="px-4 py-1.5">{dBillCf.head('date', bwDueOn === 'empty' ? 'Empty date' : 'Date')}</th>
                          <th className="px-2 py-1.5">{dBillCf.head('ref', 'Ref. no')}</th>
                          <th className="px-2 py-1.5 text-right">{dBillCf.head('opening', 'Opening amount', { align: 'end' })}</th>
                          <th className="px-2 py-1.5 text-right">{dBillCf.head('pending', 'Pending amount', { align: 'end' })}</th>
                          <th className="px-2 py-1.5">{dBillCf.head('due', 'Due on')}</th>
                          <th className="px-2 py-1.5 text-right">{dBillCf.head('overdue', 'Overdue by days', { align: 'end' })}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                              Nothing outstanding on this ledger{lgTo ? ` as on ${formatDate(lgTo)}` : ''}.
                            </td>
                          </tr>
                        ) : (
                          rows.map((b, i) => {
                            const key = `${b.ref}-${i}`
                            const open = billOpen === key
                            const billed = Math.abs(Number(b.opening) || 0)
                            const paid = Math.abs(Number(b.paid) || 0)
                            const pend = Math.abs(Number(b.pending) || 0)
                            const sett = (b.settlements as Row[]) || []
                            const pct = billed > 0 ? Math.min(100, Math.round((paid / billed) * 100)) : 0
                            return (
                            <Fragment key={key}>
                            <tr
                              className={cn('cursor-pointer border-b border-dotted', open ? 'bg-amber-100/70' : 'hover:bg-amber-50')}
                              style={{ borderColor: '#DCE7DB' }}
                              onClick={() => setBillOpen(open ? null : key)}
                              title="Show what has been paid against this bill"
                            >
                              <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">
                                <span className="inline-flex items-center gap-1.5">
                                  {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                  <span
                                    title={billDateTitle(b)}
                                    className={cn((billDateOf(b).held || billDateOf(b).fallback) && 'italic text-muted-foreground')}
                                  >
                                    {formatDate(billDateOf(b).on)}
                                  </span>
                                </span>
                              </td>
                              <td className="px-2 py-1.5 font-medium">{b.ref}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                                {formatINR(Math.abs(Number(b.opening)))} {dc}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">
                                {formatINR(Math.abs(Number(b.pending)))} {dc}
                              </td>
                              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{dDue(b)}</td>
                              <td
                                className={cn(
                                  'px-2 py-1.5 text-right tabular-nums',
                                  dLate(b) > 0 ? 'font-semibold text-rose-700' : 'text-muted-foreground'
                                )}
                              >
                                {dLate(b) > 0 ? dLate(b) : '—'}
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-b border-dotted bg-[#F7FAF6]" style={{ borderColor: '#DCE7DB' }}>
                                <td colSpan={6} className="px-4 py-3">
                                  {/* Bill amount, paid, pending — the three
                                      figures the row itself can only imply. */}
                                  <div className="mb-2 grid max-w-3xl grid-cols-3 gap-px overflow-hidden rounded-md border" style={{ borderColor: '#D6E2D6', background: '#D6E2D6' }}>
                                    {([
                                      { label: 'Bill amount', value: billed, tone: 'text-[#0B3D2E]' },
                                      { label: 'Paid', value: paid, tone: paid > 0.004 ? 'text-emerald-700' : 'text-muted-foreground' },
                                      { label: 'Pending', value: pend, tone: 'text-rose-700' }
                                    ] as const).map((k) => (
                                      <div key={k.label} className="bg-[#F7FAF6] px-3 py-2">
                                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{k.label}</div>
                                        <div className={cn('text-[14px] font-bold tabular-nums', k.tone)}>
                                          {formatINR(k.value)} {dc}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="mb-2 flex max-w-3xl items-center gap-2">
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#DCE7DB]">
                                      <div className="h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground">
                                      {pct}% settled
                                    </span>
                                  </div>
                                  {sett.length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground">
                                      Nothing has been paid against this bill yet — the whole amount is still open.
                                    </p>
                                  ) : (
                                    <div className="max-w-3xl overflow-hidden rounded-md border" style={{ borderColor: '#D6E2D6' }}>
                                      <table className="w-full bg-white text-[11px]">
                                        <thead>
                                          <tr className="border-b bg-[#EFF5EC] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                                            <th className="px-3 py-1">Date</th>
                                            <th className="px-3 py-1">Voucher</th>
                                            <th className="px-3 py-1">Narration</th>
                                            <th className="px-3 py-1 text-right">Amount</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {sett.map((x, xi) => (
                                            <tr key={xi} className="border-b last:border-0">
                                              <td className="whitespace-nowrap px-3 py-1 tabular-nums">{formatDate(x.entry_date)}</td>
                                              <td className="whitespace-nowrap px-3 py-1 font-medium">
                                                {String(x.vch_type || '')}{x.vch_no ? ` ${String(x.vch_no)}` : ''}
                                              </td>
                                              <td className="px-3 py-1 text-muted-foreground">{String(x.narration || '—')}</td>
                                              <td className="whitespace-nowrap px-3 py-1 text-right font-semibold tabular-nums text-emerald-700">
                                                {formatINR(Math.abs(Number(x.amount) || 0))}
                                              </td>
                                            </tr>
                                          ))}
                                          <tr className="bg-[#EFF5EC] font-bold">
                                            <td className="px-3 py-1" colSpan={3}>Total paid</td>
                                            <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums">{formatINR(paid)}</td>
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                            </Fragment>
                            )
                          })
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 font-bold" style={{ borderColor: '#0B3D2E' }}>
                          <td className="px-4 py-2" colSpan={2}>Sub total</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                            {formatINR(bSum('opening'))} {dc}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                            {formatINR(bSum('pending'))} {dc}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-[11px] font-normal text-muted-foreground" colSpan={2}>
                            {bSum('paid') > 0.004 && (
                              <>paid so far {formatINR(bSum('paid'))}</>
                            )}
                          </td>
                        </tr>
                        {Math.abs(onAcc) > 0.004 && (
                          <tr className="border-t border-dashed italic" style={{ borderColor: '#D6E2D6' }}>
                            <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">{formatDate(bills?.as_of)}</td>
                            <td className="px-2 py-1.5" title="The part of the balance no bill accounts for — an advance, an unallocated receipt, or an opening figure.">
                              On account
                            </td>
                            <td />
                            <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums">
                              {formatINR(Math.abs(onAcc))} {onAcc >= 0 ? 'Dr' : 'Cr'}
                            </td>
                            <td colSpan={2} />
                          </tr>
                        )}
                        <tr className="bg-[#EAF0E9] text-[11px]">
                          <td className="px-4 py-1.5 uppercase tracking-wide text-muted-foreground" colSpan={3}>
                            Ledger closing balance{bills?.credit_days ? ` · ${bills.credit_days} days credit` : ''}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums">
                            {formatINR(Math.abs(Number(bills?.balance) || 0))} {Number(bills?.balance) >= 0 ? 'Dr' : 'Cr'}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )
              })()
            ) : lgMonthly ? (
              <div className="max-h-[calc(100vh-225px)] overflow-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-[#EAF0E9]">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="px-4 py-1.5">{dMonCf.head('month', 'Month')}</th>
                      <th className="px-2 py-1.5 text-right">{dMonCf.head('dr', 'Debit', { align: 'end' })}</th>
                      <th className="px-2 py-1.5 text-right">{dMonCf.head('cr', 'Credit', { align: 'end' })}</th>
                      <th className="px-2 py-1.5 text-right">{dMonCf.head('closing', 'Closing balance', { align: 'end' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dMonthly.map((m) => (
                      <tr
                        key={m.month}
                        className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                        style={{ borderColor: '#DCE7DB' }}
                        title="Open this month's vouchers"
                        onClick={() => drillMonth(m.month)}
                      >
                        <td className="px-4 py-1.5 font-medium">{monthLabelLong(m.month)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.dr ? formatINR(m.dr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.cr ? formatINR(m.cr) : ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                          {formatINR(Math.abs(m.closing))} {m.closing >= 0 ? 'Dr' : 'Cr'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-bold" style={{ borderColor: '#0B3D2E' }}>
                      <td className="px-4 py-2">Grand total</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(dMonthly.reduce((sum, m) => sum + m.dr, 0))}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(dMonthly.reduce((sum, m) => sum + m.cr, 0))}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {(() => {
                          const c = dMonthly.length ? dMonthly[dMonthly.length - 1].closing : 0
                          return `${formatINR(Math.abs(c))} ${c >= 0 ? 'Dr' : 'Cr'}`
                        })()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="max-h-[calc(100vh-225px)] overflow-auto [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-3 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-[#EFF5EC] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#0B3D2E]/50 hover:[&::-webkit-scrollbar-thumb]:bg-[#0B3D2E]/70">
                <table
                  className={cn(
                    'w-full text-[13px]',
                    // Fixed layout in the normal view: Particulars takes the
                    // slack and everything else keeps a stated width, so the
                    // Balance column can no longer be shoved off the right edge
                    // and the money columns line up down the page. Columnar mode
                    // genuinely needs to be wider than the pane, so it opts out.
                    // A floor on the whole table, so on a narrow pane it scrolls
                    // rather than crushing Particulars down to a few pixels —
                    // which is what fixed widths do to the one flexible column.
                    // Wider than the floor, Particulars takes all the slack.
                    lgDetailed && legCols.length > 0 ? 'min-w-max' : 'table-fixed min-w-[880px]'
                  )}
                >
                  {!(lgDetailed && legCols.length > 0) && (
                    <colgroup>
                      {/* Date needs room for dd-mm-yyyy at 13px plus padding —
                          84px clipped it into Particulars and wrapped the
                          opening row onto two lines. */}
                      <col className="w-[108px]" />
                      <col />
                      <col className="w-[62px]" />
                      <col className="w-[110px]" />
                      <col className="w-[116px]" />
                      <col className="w-[116px]" />
                      <col className="w-[140px]" />
                    </colgroup>
                  )}
                  <thead className="sticky top-0 z-20 bg-[#EAF0E9]">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className={cn('px-3 py-1.5', lgDetailed && 'sticky left-0 z-30 w-[104px] min-w-[104px] bg-[#EAF0E9]')}>{dStmtCf.head('date', 'Date')}</th>
                      <th className={cn('border-l px-2 py-1.5', lgDetailed && 'sticky left-[104px] z-30 w-[190px] min-w-[190px] bg-[#EAF0E9] shadow-[4px_0_6px_-4px_rgba(26,44,86,0.35)]')} style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('particulars', 'Particulars')}</th>
                      <th className="border-l px-2 py-1.5" style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('vch', 'Vch')}</th>
                      <th className="border-l px-2 py-1.5" style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('ref', 'Bill ref')}</th>
                      <th className="border-l px-2 py-1.5 text-right" style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('dr', 'Debit', { align: 'end' })}</th>
                      <th className="border-l px-2 py-1.5 text-right" style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('cr', 'Credit', { align: 'end' })}</th>
                      <th className="border-l px-3 py-1.5 text-right" style={{ borderColor: '#C3D2C6' }}>{dStmtCf.head('balance', 'Balance', { align: 'end' })}</th>
                      {lgDetailed &&
                        legCols.map((c) => (
                          <th key={c} className="max-w-[150px] truncate border-l px-2 py-1.5 text-right" style={{ borderColor: '#DCE7DB' }} title={c}>
                            <span className="inline-flex items-center gap-1">
                              {c}
                              {dStmtCf.head(`leg:${c}`, c, { align: 'end', bare: true })}
                            </span>
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(lgFrom || lgBooksFrom || Math.abs(stmt.opening) > 0.004) && (
                      <tr className="border-b bg-amber-50/60 font-medium" style={{ borderColor: '#DCE7DB' }}>
                        <td className={cn('whitespace-nowrap px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground', lgDetailed && 'sticky left-0 z-10 bg-[#EFF5EC]')}>
                          {lgFrom ? formatDate(lgFrom) : ''}
                        </td>
                        <td className={cn('border-l px-2 py-1.5 italic', lgDetailed && 'sticky left-[104px] z-10 bg-[#EFF5EC]')} style={{ borderColor: '#EFF5EC' }} colSpan={lgDetailed ? 1 : 5}>Opening balance</td>
                        {lgDetailed && <td colSpan={4} />}
                        <td className="whitespace-nowrap border-l px-3 py-1.5 text-right font-medium tabular-nums" style={{ borderColor: '#C3D2C6' }}>
                          {formatINR(Math.abs(stmt.opening))}{' '}
                          <span className="text-[10px] text-muted-foreground">{stmt.opening >= 0 ? 'Dr' : 'Cr'}</span>
                        </td>
                        {lgDetailed && legCols.length > 0 && <td colSpan={legCols.length} />}
                      </tr>
                    )}
                    {dStmtRows.map((l) => (
                      // A statement line is a pointer to a voucher, so it opens
                      // one — reading a purchase off the ledger and then hunting
                      // for it in the Day Book was the long way round. An
                      // auto-posted voucher opens read-only; a manual one opens
                      // for alteration, which is what openForAlter already
                      // decides.
                      <tr
                        key={String(l.id)}
                        className="cursor-pointer border-b border-dotted align-top hover:bg-amber-50"
                        style={{ borderColor: '#DCE7DB' }}
                        title={
                          l.order_id && onOpenRecord
                            ? 'Open this purchase in Purchases'
                            : l.sale_id && onOpenRecord
                              ? 'Open this invoice in Sales'
                              : `Open ${String(l.vch_type || 'this voucher')}${l.vch_no ? ` ${l.vch_no}` : ''}`
                        }
                        onClick={() => {
                          // The document itself where there is one — a purchase
                          // belongs in Purchases, where it can be read in full
                          // and edited. Only a voucher with no source document
                          // behind it (a manual journal, a contra) has nothing
                          // better to show than itself.
                          // The book this ledger is being read in travels with
                          // the request, so the document opens in its own
                          // company rather than whichever one the app happens
                          // to be working in.
                          const here = { screen, ledgerId, companyId: cid }
                          rememberLedger()
                          if (l.order_id && onOpenRecord) return onOpenRecord('orders', Number(l.order_id), here)
                          if (l.sale_id && onOpenRecord) return onOpenRecord('sales', Number(l.sale_id), here)
                          void openLineSource(l, here)
                        }}
                      >
                        <td className={cn('whitespace-nowrap px-3 py-1.5 tabular-nums', lgDetailed && 'sticky left-0 z-10 bg-[#F7FAF6]')}>{formatDate(l.entry_date)}</td>
                        <td className={cn('overflow-hidden border-l px-2 py-1.5', lgDetailed && 'sticky left-[104px] z-10 max-w-[190px] bg-[#F7FAF6] shadow-[4px_0_6px_-4px_rgba(26,44,86,0.25)]')} style={{ borderColor: '#EFF5EC' }}>
                          <div className="truncate font-medium" title={String(l.particulars || l.vch_type)}>{l.particulars || l.vch_type}</div>
                          {l.narration && <div className="truncate text-[11px] italic text-muted-foreground">{l.narration}</div>}
                        </td>
                        <td className="whitespace-nowrap border-l px-2 py-1.5 text-[11px]" style={{ borderColor: '#EFF5EC' }}>
                          <div className="doc-ref font-medium text-slate-500">{l.voucher_code}</div>
                          {lgDetailed && (
                            <div className="doc-ref text-[10.5px] text-muted-foreground">
                              {l.vch_type}{l.vch_no ? ` · ${l.vch_no}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="max-w-[150px] overflow-hidden border-l px-2 py-1.5 text-[11px]" style={{ borderColor: '#EFF5EC' }}>
                          {(() => {
                            // The bill this line is against. A bill-wise
                            // allocation is the truest answer — it names the
                            // document being settled — and the voucher's own
                            // number stands in when the line IS the document
                            // (a purchase, a transporter's freight bill).
                            // An LC or a BD names itself first: those lines
                            // carry no allocation, and the voucher number alone
                            // ("V2") says nothing about what it belongs to.
                            const fac = facilityRef(l)
                            if (fac) {
                              return (
                                <span
                                  className="inline-flex max-w-full items-center gap-1"
                                  title={`${fac.kind === 'LC' ? 'Letter of credit' : 'Bill discounting'} ${fac.no}${l.narration ? ` — ${String(l.narration)}` : ''}`}
                                >
                                  <span
                                    className="shrink-0 rounded-[2px] px-1 py-[1px] text-[9.5px] font-extrabold tracking-[.04em]"
                                    style={
                                      fac.kind === 'LC'
                                        ? { background: '#EAF0FA', color: '#1B4E82' }
                                        : { background: '#EDE9FB', color: '#4A3D8C' }
                                    }
                                  >
                                    {fac.kind}
                                  </span>
                                  <span className="doc-ref truncate font-medium text-slate-700">{fac.no}</span>
                                </span>
                              )
                            }
                            const refs = [
                              ...new Set(
                                ((l.allocs as Row[]) || [])
                                  .map((a2) => String(a2.ref_name || '').trim())
                                  .filter(Boolean)
                              )
                            ]
                            const text = refs.length ? refs.join(', ') : String(l.vch_no || '').trim()
                            if (!text) {
                              const onAccount = ((l.allocs as Row[]) || []).some((a2) => String(a2.method) === 'on_account')
                              return <span className="text-muted-foreground">{onAccount ? 'On account' : '—'}</span>
                            }
                            return <span className="doc-ref block truncate font-medium text-slate-700" title={text}>{text}</span>
                          })()}
                        </td>
                        <td className="whitespace-nowrap border-l px-2 py-1.5 text-right tabular-nums" style={{ borderColor: '#EFF5EC' }}>
                          {Number(l.dr) ? formatINR(l.dr) : ''}
                        </td>
                        <td className="whitespace-nowrap border-l px-2 py-1.5 text-right tabular-nums" style={{ borderColor: '#EFF5EC' }}>{Number(l.cr) ? formatINR(l.cr) : ''}</td>
                        <td className="whitespace-nowrap border-l px-3 py-1.5 text-right font-medium tabular-nums" style={{ borderColor: '#EFF5EC' }}>
                          {formatINR(Math.abs(l.running))}{' '}
                          <span className="text-[10px] text-muted-foreground">{l.running >= 0 ? 'Dr' : 'Cr'}</span>
                        </td>
                        {lgDetailed &&
                          legCols.map((c) => {
                            const v = legShare(l, c)
                            return (
                              <td key={c} className="whitespace-nowrap border-l px-2 py-1.5 text-right tabular-nums" style={{ borderColor: '#EFF5EC' }}>
                                {Math.abs(v) > 0.004 ? (
                                  <>
                                    {formatINR(Math.abs(v))} <span className="text-[10px] text-muted-foreground">{v > 0 ? 'Dr' : 'Cr'}</span>
                                  </>
                                ) : (
                                  ''
                                )}
                              </td>
                            )
                          })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 bg-[#F7FAF6] font-bold" style={{ borderColor: '#0B3D2E' }}>
                      <td className={cn('px-3 py-2', lgDetailed && 'sticky left-0 z-10 bg-[#F7FAF6]')} colSpan={lgDetailed ? 2 : 4}>
                        Closing balance{lgFrom || lgTo ? ' (period)' : ''}
                      </td>
                      {lgDetailed && <td colSpan={2} />}
                      <td className="whitespace-nowrap border-l px-2 py-2 text-right tabular-nums" style={{ borderColor: '#0B3D2E' }}>
                        {formatINR(dStmtCf.active ? dStmtRows.reduce((t, r) => t + (Number(r.dr) || 0), 0) : stmt.totDr)}
                      </td>
                      <td className="whitespace-nowrap border-l px-2 py-2 text-right tabular-nums" style={{ borderColor: '#0B3D2E' }}>{formatINR(dStmtCf.active ? dStmtRows.reduce((t, r) => t + (Number(r.cr) || 0), 0) : stmt.totCr)}</td>
                      <td className="whitespace-nowrap border-l px-3 py-2 text-right tabular-nums" style={{ borderColor: '#0B3D2E' }}>
                        {formatINR(Math.abs(stmt.closing))}{' '}
                        <span className="text-[10px] font-normal text-muted-foreground">{stmt.closing >= 0 ? 'Dr' : 'Cr'}</span>
                      </td>
                      {lgDetailed &&
                        legCols.map((c) => {
                          const v = Math.round(dStmtRows.reduce((sum, r) => sum + legShare(r, c), 0) * 100) / 100
                          return (
                            <td key={c} className="whitespace-nowrap border-l px-2 py-2 text-right tabular-nums" style={{ borderColor: '#DCE7DB' }}>
                              {Math.abs(v) > 0.004 ? `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}` : ''}
                            </td>
                          )
                        })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )

  // Desktop trial balance funnels: ledgers narrow, a group stays while one does.
  const dTbFlat = tbGroups.flatMap(([group, rows]) => (rows as Row[]).map((r) => ({ ...r, __group: group })))
  const dTbCf = colFilter<Row>(colF, 'd:trial', dTbFlat, [
    { key: 'group', get: (r) => r.__group },
    { key: 'ledger', get: (r) => r.name },
    { key: 'dr', get: (r) => (r.closing_dr > 0.004 ? formatINR(r.closing_dr) : ''), sort: 'num' },
    { key: 'cr', get: (r) => (r.closing_cr > 0.004 ? formatINR(r.closing_cr) : ''), sort: 'num' }
  ])
  const dTbIds = new Set(dTbCf.rows.map((r) => Number(r.id)))
  const dTbGroups = dTbCf.active
    ? tbGroups
        .map(([group, rows]) => [group, (rows as Row[]).filter((r) => dTbIds.has(Number(r.id)))] as [string, Row[]])
        .filter(([, rows]) => rows.length > 0)
    : tbGroups
  const dTbTot = (k: 'closing_dr' | 'closing_cr'): number =>
    dTbCf.active ? dTbCf.rows.reduce((t, r) => t + (Number(r[k]) || 0), 0) : Number(tb?.totals[k] || 0)
  const trialScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Trial Balance</span>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={tbFrom} to={tbTo} onRange={(f, t) => { setTbFrom(f); setTbTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={tbFrom} onChange={setTbFrom} max={tbTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={tbTo} onChange={setTbTo} min={tbFrom || undefined} /></div>
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#EAF0E9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">
                  <span className="inline-flex items-center gap-3">
                    {dTbCf.head('group', 'Group')} {dTbCf.head('ledger', 'Ledger')}
                  </span>
                </th>
                <th className="px-2 py-1.5 text-right">{dTbCf.head('dr', 'Debit', { align: 'end' })}</th>
                <th className="px-2 py-1.5 text-right">{dTbCf.head('cr', 'Credit', { align: 'end' })}</th>
              </tr>
            </thead>
            <tbody>
              {dTbGroups.map(([group, rows]) => (
                <Fragment key={group}>
                  <tr className="bg-amber-50/70">
                    <td className="px-4 py-1 text-[11px] font-bold uppercase tracking-wide text-[#0B3D2E]" colSpan={3}>{group}</td>
                  </tr>
                  {rows.map((r) => (
                    <tr
                      key={String(r.id)}
                      className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                      style={{ borderColor: '#DCE7DB' }}
                      onClick={() => { setLedgerId(Number(r.id)); setScreen('ledger'); setLgBack('trial') }}
                    >
                      <td className="px-6 py-1.5">{r.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.closing_dr > 0.004 ? formatINR(r.closing_dr) : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.closing_cr > 0.004 ? formatINR(r.closing_cr) : ''}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-bold" style={{ borderColor: '#0B3D2E' }}>
                <td className="px-4 py-2">
                  Grand total
                  {tb && Math.abs(Number(tb.totals.closing_dr) - Number(tb.totals.closing_cr)) < 0.02 && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Books balanced</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatINR(dTbTot('closing_dr'))}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatINR(dTbTot('closing_cr'))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )

  // THE MODULE'S MODALS, lifted out of the frame that used to hold them.
  // A dialog belongs to the module, not to one of its two shells — left
  // inside the desktop return they would simply not exist on the website.
  const dialogs = (
    <>
    {/* Tag a purchase to an LC / bill discounting facility */}
    <Dialog open={!!tagForm} onOpenChange={(o) => !o && setTagForm(null)}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={escToClose()}>
        <DialogHeader><DialogTitle>Tag {tagForm?.invoice_no} to an LC</DialogTitle></DialogHeader>
        {tagForm && (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              {tagForm.supplier_name} · this draws a bill under the chosen LC against this purchase, eating into its limit.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label>LC *</Label>
              <Select value={tagForm.lc_id ? String(tagForm.lc_id) : ''} onValueChange={(v) => setTagForm({ ...tagForm, lc_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select the LC funding this purchase" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {lcList.filter((l) => String(l.status) !== 'closed').map((l) => (
                    <SelectItem key={String(l.id)} value={String(l.id)}>
                      {l.lc_no} · {l.bank} · {formatINR(l.available)} free
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label>Amount (₹) *</Label><Input type="number" value={tagForm.amount ?? ''} onChange={(e) => setTagForm({ ...tagForm, amount: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Bill no</Label><Input value={tagForm.bill_no ?? ''} onChange={(e) => setTagForm({ ...tagForm, bill_no: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Issue date</Label><DatePicker value={String(tagForm.issue_date || '')} onChange={(v) => setTagForm({ ...tagForm, issue_date: v })} /></div>
              <div className="flex flex-col gap-1.5">
                <Label>Due date</Label>
                <DatePicker value={String(tagForm.due_date || '')} onChange={(v) => setTagForm({ ...tagForm, due_date: v })} />
                <span className="text-[10px] text-muted-foreground">blank = issue date + the LC's usance</span>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setTagForm(null)}>Cancel</Button>
          <Button onClick={() => void saveTag()}>Tag purchase</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>


    {/* Read-only view of an auto-posted voucher */}
    <Dialog open={!!tfWaive && !__WEB__} onOpenChange={(o) => { if (!o) { setTfWaive(null); setTfWaiveReason('') } }}>
      <DialogContent onEscapeKeyDown={escToClose(!!tfWaiveReason.trim())}>
        <DialogHeader>
          <DialogTitle>Write off the oil shortage</DialogTitle>
        </DialogHeader>
        {tfWaive && (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-[13px]">
              <div className="font-medium">{String(tfWaive.transporter_name || '')}</div>
              <div className="text-[12px] text-muted-foreground">
                {String(tfWaive.doc_no || '')} · {formatINR(Math.abs(Number(tfWaive.amount) || 0))} ·{' '}
                {String(tfWaive.note || '')}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Why is this not the transporter&apos;s? *</Label>
              <Input
                autoFocus
                value={tfWaiveReason}
                onChange={(e) => setTfWaiveReason(e.target.value)}
                placeholder="e.g. tanker overturned on NH-8, FIR filed"
              />
              <span className="text-[10.5px] text-muted-foreground">
                Recorded against your name and shown on the register. Required — a waived claim with no reason
                cannot be reviewed later.
              </span>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900">
              The transporter will bill <b>in full</b>, and{' '}
              <b>{formatINR(Math.abs(Number(tfWaive.amount) || 0))}</b> posts as{' '}
              <b>Dr OIL SHORTAGE LOSS A/C</b> against the{' '}
              {tfSide === 'purchase' ? 'purchase' : 'sale'} account it was bought as — naming the loss rather than
              leaving it inside material cost.
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setTfWaive(null); setTfWaiveReason('') }}>Cancel</Button>
          <Button onClick={() => void tfDoWaive()} disabled={tfNoting != null || !tfWaiveReason.trim()}>
            {tfNoting != null ? 'Saving…' : 'Write it off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {tallyOpen && (
      <TallyLedgers
        companyName={String(company?.name || '')}
        onClose={() => setTallyOpen(false)}
        onChanged={() => {
          loadAccounts()
          void loadGroups()
        }}
      />
    )}

    {/* LEAVING A VOUCHER HALF-WRITTEN.
        Both ways out of it used to be silent: an open alter carried its lines
        into the new tab, a new voucher had them wiped. Asked now, with the
        two answers named for what they do rather than Yes and No. */}
    <Dialog open={pendingLeave} onOpenChange={(o) => !o && setPendingLeave(false)}>
      <DialogContent onEscapeKeyDown={escToClose()}>
        <DialogHeader><DialogTitle>Discard this voucher draft?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Your unsaved entries will be lost. Stay here to finish or save the voucher.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingLeave(false)}>Keep editing</Button>
          <Button disabled={saving} onClick={() => { setPendingLeave(false); backFromVoucher() }}>Discard draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={pendingType != null} onOpenChange={(o) => !o && setPendingType(null)}>
      {/* Wide enough for all four answers on one line — with Move added, a
          narrow dialog stacked them and the choice read as a list. */}
      <DialogContent className="sm:max-w-2xl" onEscapeKeyDown={escToClose()}>
        <DialogHeader>
          <DialogTitle>
            {editingId != null || noteEditId != null
              ? `Leave ${vchNo ? `voucher ${vchNo}` : 'this voucher'}?`
              : 'Start a new voucher?'}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[13px] font-semibold leading-[1.55] text-[#33473E] [text-wrap:pretty]">
          {editingId != null || noteEditId != null
            ? `You are altering a ${String(vchType).toLowerCase()}. Switching to ${String(
                pendingType || ''
              ).toLowerCase()} starts a fresh voucher, and anything changed here goes with it.`
            : `This ${String(vchType).toLowerCase()} has something in it. Move it to a ${String(
                pendingType || ''
              ).toLowerCase()} to carry the date, narration and lines across, or start the ${String(
                pendingType || ''
              ).toLowerCase()} fresh.`}
        </p>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => setPendingType(null)} disabled={saving}>
            Stay here
          </Button>
          <span className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="border-[#F0D6D4] bg-[#FDF3F2] font-bold text-[#B3261E] hover:bg-[#FBE9E7]"
              disabled={saving}
              onClick={() => {
                const t = pendingType
                setPendingType(null)
                if (t) applyType(t)
              }}
            >
              Discard and switch
            </Button>
            {pendingType != null && canMoveTo(pendingType) && (
              <Button
                variant="outline"
                className="border-[#C3D2C6] font-bold text-[#0B3D2E] hover:bg-[#F1F5EF]"
                disabled={saving}
                title="Carry the date, narration and every line into the new voucher, unsaved"
                onClick={() => {
                  const t = pendingType
                  setPendingType(null)
                  if (t) moveToType(t)
                }}
              >
                Move to {VCH_TYPES.find((x) => x.key === pendingType)?.label || 'voucher'}
              </Button>
            )}
            <Button
              className="bg-[#0B3D2E] font-bold text-white hover:bg-[#0B6D4A]"
              disabled={saving}
              onClick={() => {
                const t = pendingType
                // Only switch if it actually went in — switching after a save
                // the server refused would throw away the work this button
                // offered to keep.
                void saveVoucher().then((ok) => {
                  if (!ok) return
                  setPendingType(null)
                  if (t) applyType(t)
                })
              }}
            >
              {saving ? 'Saving…' : 'Save, then switch'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!viewRow} onOpenChange={(o) => !o && setViewRow(null)}>
      <DialogContent className="max-w-lg" readOnly>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee className="h-4 w-4" /> {viewRow?.vch_type} — {viewRow?.vch_no || 'no number'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {viewRow?.manual ? (
              <>Entered by hand ({formatDate(viewRow?.entry_date)}). Your access lets you read this voucher type, not alter it.</>
            ) : (
              <>
                Posted automatically from its source document ({formatDate(viewRow?.entry_date)}). To change it, edit the
                purchase, sale or payment it came from — the voucher follows.
              </>
            )}
          </p>
          <table className="w-full text-[13px]">
            <tbody>
              {orderVoucherLines((viewRow?.lines as Row[]) || [], (l) => ({
                account: String(l.account),
                dr: Number(l.dr) > 0,
                tax: isTaxLine(String(l.account), String(l.acc_group || '')),
                amount: Number(l.dr) || Number(l.cr) || 0
              })).map((l) => (
                <tr key={String(l.id)} className="border-b border-dotted">
                  <td className="py-1 pr-2 font-medium">{Number(l.dr) > 0 ? 'Dr' : 'Cr'}</td>
                  <td className="py-1">{l.account}</td>
                  <td className="py-1 text-right tabular-nums">{formatINR(Number(l.dr) > 0 ? l.dr : l.cr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {viewRow?.narration && <p className="text-xs text-muted-foreground">{viewRow.narration}</p>}
          {/* THE DESK'S OWN WORD FOR THIS VOUCHER.
              A voucher posted from a document cannot be edited here — but why
              it is worth a second look is not the document's business, and a
              label is the one thing that can be put on it from this screen. */}
          {!!viewRow?.id && (
            <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Tags</span>
              <TagPicker
                entity="voucher"
                refId={Number(viewRow.id)}
                tags={vchTags.tagsOf(Number(viewRow.id))}
                onChanged={(next) => vchTags.setFor(Number(viewRow.id), next)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          {canAlterOwned(viewRow) && (
            <Button onClick={() => viewRow && void startAlterOwned(viewRow)}>Alter</Button>
          )}
          <Button variant="outline" onClick={() => setViewRow(null)}>Close (Esc)</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* ALTER A DOCUMENT'S VOUCHER — the BD repayment / payment-in form. */}
    <Dialog open={!!alterDlg} onOpenChange={(o) => !o && !alterBusy && setAlterDlg(null)}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={escToClose(!!alterDlg && JSON.stringify(alterDlg.values) !== alterDlg.initial)}>
        <DialogHeader>
          <DialogTitle>Alter · {String(alterDlg?.info.label || 'voucher')}</DialogTitle>
        </DialogHeader>
        {alterDlg && (() => {
          const form = String(alterDlg.info.form)
          const v = alterDlg.values
          const set = (patch: Row): void => setAlterDlg((p) => (p ? { ...p, values: { ...p.values, ...patch } } : p))
          const shared: Row[] = Array.isArray(alterDlg.info.shared) ? (alterDlg.info.shared as Row[]) : []
          const banks = accounts.filter((a) => String(a.acc_group) === 'Bank Accounts').map((a) => String(a.name))
          const bankPick = (value: string, onChange: (x: string) => void): React.JSX.Element => (
            <Select value={value || '__none'} onValueChange={(x) => onChange(x === '__none' ? '' : x)}>
              <SelectTrigger><SelectValue placeholder="The bill's own bank" /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="__none">The bill&rsquo;s own bank</SelectItem>
                {Array.from(new Set([...(value ? [value] : []), ...banks])).map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
          return (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                The old entry is reversed and this one recorded in its place, in one step — the bill&rsquo;s dues, the
                facility and the ledgers follow. If a figure is refused, nothing changes.
              </p>
              {form === 'bd_repayment' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Repayment date</Label>
                    <DatePicker value={String(v.repay_date || '')} onChange={(x) => set({ repay_date: x || '' })} max={todayISO()} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Principal on BD {String(alterDlg.info.row?.bd_no || '')}</Label>
                    <Input type="number" value={v.amount ?? ''} disabled={shared.length > 0} onChange={(e) => set({ amount: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Comm. charges</Label>
                    <Input type="number" value={v.comm_charges ?? ''} onChange={(e) => set({ comm_charges: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Bank charges</Label>
                    <Input type="number" value={v.bank_charges ?? ''} onChange={(e) => set({ bank_charges: e.target.value })} />
                  </div>
                  {String(alterDlg.info.row?.settle_via || 'bank') !== 'party' && (
                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <Label>Bank the money left from</Label>
                      {bankPick(String(v.bank_account || ''), (x) => set({ bank_account: x }))}
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>Reference</Label>
                    <Input value={v.ref ?? ''} onChange={(e) => set({ ref: e.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Note</Label>
                    <Input value={v.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
                  </div>
                  {shared.length > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 sm:col-span-2">
                      One bank debit that also settled{' '}
                      {shared.map((s) => `BD ${s.bd_no} ${formatINR(s.amount)}`).join(', ')}. Each bill keeps the share it
                      took; the date, bank, charges and reference can change.
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Date received</Label>
                    <DatePicker value={String(v.date || '')} onChange={(x) => set({ date: x || '' })} max={todayISO()} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Amount received</Label>
                    <Input type="number" value={v.amount ?? ''} onChange={(e) => set({ amount: e.target.value })} />
                  </div>
                  {form === 'bd_payment_in' && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label>Method</Label>
                        <Select value={String(v.method || '') || '__none'} onValueChange={(x) => set({ method: x === '__none' ? '' : x })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none">—</SelectItem>
                            {['RTGS', 'NEFT', 'IMPS', 'UPI', 'Cheque', 'Cash', 'Adjustment', 'Other'].map((m) => (
                              <SelectItem key={m} value={m}>{m}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Reference</Label>
                        <Input value={v.ref ?? ''} onChange={(e) => set({ ref: e.target.value })} />
                      </div>
                      <div className="flex flex-col gap-1.5 sm:col-span-2">
                        <Label>Bank it landed in</Label>
                        {bankPick(String(v.account || ''), (x) => set({ account: x }))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })()}
        <DialogFooter>
          <Button variant="outline" disabled={alterBusy} onClick={() => setAlterDlg(null)}>Cancel</Button>
          <Button disabled={alterBusy} onClick={() => void saveAlterOwned()}>
            {alterBusy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Create ledger */}
    <Dialog open={!!newLedger} onOpenChange={(o) => !o && setNewLedger(null)}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={escToClose(!!String(newLedger?.name || '').trim())}>
        <DialogHeader><DialogTitle>Create ledger</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label>Name</Label>
            <Input
              value={newLedger?.name || ''}
              onChange={(e) => setNewLedger((p) => (p ? { ...p, name: e.target.value } : p))}
              className="uppercase"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Under group</Label>
            <Select
              value={newLedger?.group || ''}
              onValueChange={(v) => setNewLedger((p) => (p ? { ...p, group: v } : p))}
            >
              <SelectTrigger><SelectValue placeholder="Pick a Tally group" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {(
                  // Creating the money-side ledger for a Payment/Receipt, or
                  // either side of a Contra, must land in a cash/bank group —
                  // anything else would fail the same check a moment later.
                  newLedger?.target === 'payAccount' || (newLedger?.forLine != null && vchType === 'CONTRA')
                    ? groupNames.filter((g) => CASH_BANK_GROUPS.includes(g.name))
                    : groupNames
                ).map((g) => (
                  <SelectItem key={String(g.name)} value={String(g.name)}>
                    {' '.repeat(Number(g.depth) * 3)}
                    {String(g.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewLedger(null)}>Cancel</Button>
          <Button className="bg-[#0B3D2E] hover:bg-[#0A3327]" onClick={() => void createLedger()}>
            <ArrowLeftRight className="h-4 w-4" /> Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* MASTERS — CREATE A GROUP, OR A LEDGER UNDER ONE. */}
    <Dialog open={!!mNew} onOpenChange={(o) => !o && setMNew(null)}>
      <DialogContent className="max-w-md" onEscapeKeyDown={escToClose(!!String(mNew?.name || '').trim())}>
        <DialogHeader>
          <DialogTitle>{mNew?.kind === 'group' ? 'Create group' : 'Create ledger'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label>Name</Label>
            {mNew?.kind === 'group' ? (
              <input
                autoFocus
                className={PLAIN_INPUT}
                value={mNew.name}
                onChange={(e) => setMNew((x) => (x ? { ...x, name: e.target.value } : x))}
                placeholder="e.g. Term Loans"
              />
            ) : (
              <Input
                autoFocus
                value={mNew?.name || ''}
                onChange={(e) => setMNew((x) => (x ? { ...x, name: e.target.value } : x))}
                className="uppercase"
                placeholder="e.g. HDFC TERM LOAN A/C"
              />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Under</Label>
            <Select
              value={mNew?.under || (mNew?.kind === 'group' ? '__top__' : 'General')}
              onValueChange={(v) => setMNew((x) => (x ? { ...x, under: v === '__top__' ? '' : v } : x))}
            >
              <SelectTrigger><SelectValue placeholder="Pick a group" /></SelectTrigger>
              <SelectContent className="max-h-80">
                {mNew?.kind === 'group' && (
                  <SelectItem value="__top__">&mdash; Top level (a primary group) &mdash;</SelectItem>
                )}
                {groupNames.map((g) => (
                  <SelectItem key={String(g.name)} value={String(g.name)}>
                    {'\u00A0'.repeat(Number(g.depth) * 3)}
                    {String(g.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mNew?.kind === 'group' && !mNew.under && (
            <div className="flex flex-col gap-1.5">
              <Label>Side of the books</Label>
              <Select value={mNew.nature} onValueChange={(v) => setMNew((x) => (x ? { ...x, nature: v } : x))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="asset">Asset</SelectItem>
                  <SelectItem value="liability">Liability</SelectItem>
                  <SelectItem value="income">Income</SelectItem>
                  <SelectItem value="expense">Expense</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[10.5px] leading-snug text-muted-foreground">
                A primary group has nothing above it to inherit from, so it has to say which side it falls on. Putting
                it under an existing group instead &mdash; which is nearly always what is meant &mdash; decides this for
                it.
              </span>
            </div>
          )}
          {mNew?.kind === 'ledger' && (
            <span className="text-[10.5px] leading-snug text-muted-foreground">
              A ledger&apos;s name is how postings find it, so choose it as it should stay &mdash; it can be moved
              between groups afterwards, but not renamed here.
            </span>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setMNew(null)}>Cancel</Button>
          <Button
            className="bg-[#0B3D2E] hover:bg-[#0A3327]"
            disabled={mBusy || !mNew?.name.trim()}
            onClick={() => void masterCreate()}
          >
            {mBusy ? 'Saving\u2026' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* MASTERS — RENAME A GROUP, OR MOVE EITHER A GROUP OR A LEDGER. */}
    <Dialog open={!!mEdit} onOpenChange={(o) => !o && setMEdit(null)}>
      <DialogContent className="max-w-md" onEscapeKeyDown={escToClose()}>
        <DialogHeader>
          <DialogTitle>
            {mEdit?.act === 'rename' ? 'Rename group' : mEdit?.kind === 'group' ? 'Move group' : 'Move ledger'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {mEdit?.act === 'rename' ? (
            <div className="flex flex-col gap-1.5">
              <Label>Name</Label>
              <input
                autoFocus
                className={PLAIN_INPUT}
                value={mEdit.name}
                onChange={(e) => setMEdit((x) => (x ? { ...x, name: e.target.value } : x))}
              />
              <span className="text-[10.5px] leading-snug text-muted-foreground">
                {mEdit.kind === 'ledger'
                  ? 'Everything already posted follows the ledger — a statement points at the row, not at the word. And the app\u2019s own postings are redirected, so the next purchase or receipt addressed to the old name lands here rather than opening a second ledger under it.'
                  : 'Every ledger under it is carried across with it, so nothing is left pointing at the old name.'}
              </span>
            </div>
          ) : (
            <>
              <div className="rounded-[4px] border px-3 py-2" style={{ borderColor: '#E4ECE3', background: '#F7FAF6' }}>
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Moving</div>
                <div className="text-[13px] font-extrabold text-[#0A1F17]">{mEdit?.name}</div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Under</Label>
                <Select
                  value={mEdit?.under || '__top__'}
                  onValueChange={(v) => setMEdit((x) => (x ? { ...x, under: v === '__top__' ? '' : v } : x))}
                >
                  <SelectTrigger><SelectValue placeholder="Pick a group" /></SelectTrigger>
                  <SelectContent className="max-h-80">
                    {mEdit?.kind === 'group' && (
                      <SelectItem value="__top__">&mdash; Top level (a primary group) &mdash;</SelectItem>
                    )}
                    {/* A group cannot be put inside itself, so its own branch is
                        not on the list at all — refusing it after the fact is a
                        worse answer than never offering it. */}
                    {groupNames
                      .filter((g) => !(mEdit?.kind === 'group' && String(g.path || '').startsWith(String(mEdit?.name))))
                      .map((g) => (
                        <SelectItem key={String(g.name)} value={String(g.name)}>
                          {'\u00A0'.repeat(Number(g.depth) * 3)}
                          {String(g.name)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <span className="text-[10.5px] leading-snug text-muted-foreground">
                  {mEdit?.kind === 'group'
                    ? 'It takes its new parent\u2019s side of the books, and so does everything under it.'
                    : 'Which group this ledger prints under, and which side of the trial balance it falls on. No posting changes.'}
                </span>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setMEdit(null)}>Cancel</Button>
          <Button
            className="bg-[#0B3D2E] hover:bg-[#0A3327]"
            disabled={
              mBusy ||
              (mEdit?.act === 'rename' && !mEdit.name.trim()) ||
              (mEdit?.act === 'move' && mEdit.kind === 'ledger' && !mEdit.under)
            }
            onClick={() => void masterSaveEdit()}
          >
            {mBusy ? 'Saving\u2026' : mEdit?.act === 'rename' ? 'Rename' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )

  // THE BOTTOM KEY BAR, CONTEXTUAL LIKE TALLY'S.
  //
  // On a statement F5 to F7 are the views, because that is what they do while
  // one is open; anywhere else they are the vouchers. Binding both at once
  // would give one key two meanings on a single screen, which is the one thing
  // a keyboard-driven module cannot afford.
  const keyBar = (screen === 'ledger'
    ? [
        { k: 'F1', label: 'Vouchers', on: lgView === 'vouchers', go: () => setLgView('vouchers') },
        { k: 'F7', label: 'Monthly', on: lgView === 'monthly', go: () => setLgView('monthly') },
        { k: 'F5', label: 'Bill-wise', on: lgView === 'billwise', go: () => setLgView('billwise') },
        { k: 'Alt F5', label: 'Columnar', on: lgView === 'columnar', go: () => setLgView('columnar') },
        // Bill-wise's own two, only while it is the view open.
        ...(lgView === 'billwise'
          ? [
              {
                k: 'Alt F1',
                label: bwDetailed ? 'Condensed' : 'Detailed',
                on: false,
                go: () => {
                  setBwDetailed((d) => !d)
                  setBwFlip(new Set())
                }
              },
              {
                k: 'Shift ↵',
                label: bwDetailed ? 'Fold bill' : 'Open bill',
                on: false,
                go: () => {
                  const keys = bwNav.current.keys
                  if (!keys.length) return
                  const at = bwSel >= 0 && bwSel < keys.length ? bwSel : 0
                  setBwSel(at)
                  toggleBw(keys[at])
                }
              }
            ]
          : []),
        { k: 'D', label: 'Day Book', on: false, go: () => setScreen('daybook'), hide: !mayScreen('daybook') },
        { k: 'T', label: 'Trial Balance', on: false, go: () => setScreen('trial'), hide: !mayScreen('trial') },
        { k: 'P', label: 'Purchases', on: false, go: () => setScreen('purchreg'), hide: !mayScreen('purchreg') },
        { k: 'S', label: 'Sales', on: false, go: () => setScreen('salesreg'), hide: !mayScreen('salesreg') },
        { k: 'V', label: 'Vouchers entry', on: false, go: () => openVoucher(firstVch() || 'PAYMENT'), hide: !firstVch() },
        { k: 'B', label: 'Openings', on: false, go: () => setScreen('openings'), hide: !mayScreen('openings') },
        {
          k: 'Esc',
          label: lgBack === 'masters' ? 'Masters' : lgBack === 'openings' ? 'Openings' : lgBack === 'trial' ? 'Trial Balance' : 'Gateway',
          on: false,
          go: leaveLedger
        }
      ]
    : [
        ...VCH_TYPES.slice(0, 4).filter((v) => mayEnter(v.key)).map((v) => ({
          k: v.fkey,
          label: v.label,
          on: screen === 'voucher' && !viewOnly && vchType === v.key,
          go: () => (screen === 'voucher' ? switchType(v.key) : openVoucher(v.key))
        })),
        { k: 'D', label: 'Day Book', on: screen === 'daybook', go: () => setScreen('daybook'), hide: !mayScreen('daybook') },
        { k: 'L', label: 'Ledgers', on: false, go: () => setScreen('ledger'), hide: !mayScreen('ledger') },
        { k: 'T', label: 'Trial Balance', on: screen === 'trial', go: () => setScreen('trial'), hide: !mayScreen('trial') },
        { k: 'P', label: 'Purchases', on: screen === 'purchreg', go: () => setScreen('purchreg'), hide: !mayScreen('purchreg') },
        { k: 'S', label: 'Sales', on: screen === 'salesreg', go: () => setScreen('salesreg'), hide: !mayScreen('salesreg') },
        { k: 'N', label: 'Debit Notes', on: screen === 'notesreg' && noteKindFilter === 'debit', go: () => { setNoteKindFilter('debit'); setScreen('notesreg') }, hide: !mayScreen('notesreg') },
        { k: 'C', label: 'Credit Notes', on: screen === 'notesreg' && noteKindFilter === 'credit', go: () => { setNoteKindFilter('credit'); setScreen('notesreg') }, hide: !mayScreen('notesreg') },
        { k: 'R', label: 'Fr. Inward', on: screen === 'tfpur', go: () => setScreen('tfpur'), hide: !mayScreen('tfpur') },
        { k: 'O', label: 'Fr. Outward', on: screen === 'tfsal', go: () => setScreen('tfsal'), hide: !mayScreen('tfsal') },
        { k: 'B', label: 'Openings', on: screen === 'openings', go: () => setScreen('openings'), hide: !mayScreen('openings') },
        { k: 'M', label: 'Masters', on: screen === 'masters', go: () => setScreen('masters'), hide: !mayScreen('masters') },
        { k: 'U', label: 'Tally', on: screen === 'tallyimport', go: () => setScreen('tallyimport'), hide: !__WEB__ || !mayScreen('tallyimport') },
        { k: 'F', label: 'Cashflow', on: screen === 'cashflow', go: () => setScreen('cashflow'), hide: !mayScreen('cashflow') },
        { k: 'Y', label: 'Pay / Receipt', on: screen === 'payreg', go: () => setScreen('payreg'), hide: !mayScreen('payreg') },
        {
          k: 'Esc',
          label: screen === 'gateway' ? 'Companies' : 'Gateway',
          on: false,
          go: () => {
            if (screen === 'gateway') setCompany(null)
            else {
              setEditingId(null)
              setScreen('gateway')
            }
          }
        }
      ]).filter((x) => !('hide' in x && x.hide))

  if (__WEB__ && isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#0B3D2E] px-7 text-center text-white">
        {/* Slow drifting glows behind the card, so the screen is alive without
            being busy — this is an apology, not a party. */}
        <style>{`
          @keyframes acctFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-10px) } }
          @keyframes acctPulse { 0%,100% { transform: scale(1); opacity:.5 } 50% { transform: scale(1.12); opacity:.8 } }
          @keyframes acctFade { from { opacity:0; transform: translateY(12px) } to { opacity:1; transform: translateY(0) } }
          @keyframes acctSweep { 0% { transform: translateX(-120%) } 100% { transform: translateX(120%) } }
          @media (prefers-reduced-motion: reduce) {
            .acct-anim, .acct-anim * { animation: none !important }
          }
        `}</style>
        <div className="acct-anim pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-16 top-1/4 h-56 w-56 rounded-full bg-[#12855A]/30 blur-3xl" style={{ animation: 'acctPulse 7s ease-in-out infinite' }} />
          <div className="absolute -right-16 bottom-1/4 h-64 w-64 rounded-full bg-[#C7F03F]/15 blur-3xl" style={{ animation: 'acctPulse 9s ease-in-out infinite 1s' }} />
        </div>

        <div className="acct-anim relative flex flex-col items-center" style={{ animation: 'acctFade .5s ease-out both' }}>
          <div
            className="relative mb-7 flex h-24 w-24 items-center justify-center rounded-[22px] bg-white/10 ring-1 ring-white/15"
            style={{ animation: 'acctFloat 4s ease-in-out infinite' }}
          >
            <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[22px]">
              <span className="absolute inset-y-0 -left-1/3 w-1/3 skew-x-[-20deg] bg-white/20 blur-md" style={{ animation: 'acctSweep 3.5s ease-in-out infinite' }} />
            </span>
            <Monitor className="h-11 w-11 text-[#C7F03F]" strokeWidth={1.5} />
          </div>

          <div className="text-[11px] font-extrabold uppercase tracking-[.2em] text-[#8FBFA8]" style={{ animation: 'acctFade .5s ease-out .1s both' }}>
            Accounting
          </div>
          <h1 className="mt-2 text-[24px] font-extrabold leading-[1.2] tracking-[-0.02em]" style={{ animation: 'acctFade .5s ease-out .18s both' }}>
            Best viewed on desktop
          </h1>
          <p className="mt-3 max-w-[300px] text-[13.5px] font-medium leading-[1.6] text-[#CFE3D6] [text-wrap:pretty]" style={{ animation: 'acctFade .5s ease-out .26s both' }}>
            Sorry for the inconvenience — the Accounting books are wide,
            Tally-style ledgers that need a bigger screen to read properly.
            Please open this page on a desktop for the best experience.
          </p>

          <div
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-[12px] font-bold text-[#C7F03F] ring-1 ring-white/10"
            style={{ animation: 'acctFade .5s ease-out .34s both' }}
          >
            <Monitor className="h-4 w-4" />
            Open on a computer to continue
          </div>

          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="mt-8 inline-flex items-center gap-1.5 text-[13px] font-extrabold text-white/70 transition-colors hover:text-white"
              style={{ animation: 'acctFade .5s ease-out .42s both' }}
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
          )}
        </div>
      </div>
    )
  }

  if (__WEB__) {
    // The voucher is laid out on its own canvas — cards on a pale ground, with
    // the voucher types in the header — so it takes the body whole rather than
    // sitting on the paper panel the registers use.
    const onVoucher = !!company && screen === 'voucher'
    const onLedger = !!company && screen === 'ledger'
    const onGateway = !!company && screen === 'gateway'
    const onBooks = !!company && (screen === 'masters' || screen === 'openings')
    const onTf = !!company && (screen === 'tfpur' || screen === 'tfsal')
    const onDaybook = !!company && screen === 'daybook'
    const onTally = !!company && screen === 'tallyimport'
    const onCashflow = !!company && screen === 'cashflow'
    const onPayreg = !!company && screen === 'payreg'
    const chip: React.CSSProperties = {
      height: 34,
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      padding: '0 12px',
      borderRadius: 6,
      background: 'rgba(255,255,255,.07)',
      border: '1px solid rgba(255,255,255,.12)',
      color: '#fff'
    }
    const chipKey: React.CSSProperties = {
      fontFamily: MONO,
      fontVariantNumeric: FIGS,
      fontSize: 9.5,
      fontWeight: 600,
      color: A.inkSky,
      border: '1px solid rgba(143,191,168,.35)',
      borderRadius: 3,
      padding: '1px 5px'
    }
    return (
      <div
        className="acct-web fixed inset-0 z-50 flex flex-col overflow-hidden"
        style={{ background: onVoucher || onLedger || onGateway || onBooks || onTf ? '#EEF3EC' : A.frame, fontFamily: SANS, color: A.ink }}
      >
        {/* The frame: what is true of every screen — the module, the screen,
            the company, the period — and, on the voucher, its types. */}
        <div
          className="relative z-[2] flex-none"
          style={{
            background: 'linear-gradient(180deg,#11503C 0%,#0B3D2E 55%,#093324 100%)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.08),0 6px 18px -8px rgba(7,43,32,.6)',
            padding: '0 22px'
          }}
        >
        <div className="flex h-[54px] items-center gap-3.5 text-white">
          <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px]"
            style={{
              background: 'linear-gradient(145deg,#D7F76A,#A9D62A)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.55),0 2px 8px rgba(0,0,0,.25)'
            }}
          >
            {onLedger ? (
              <BookOpen className="h-[19px] w-[19px]" style={{ color: A.frame }} />
            ) : onTf ? (
              <Truck className="h-[19px] w-[19px]" style={{ color: A.frame }} />
            ) : onBooks ? (
              <FolderTree className="h-[19px] w-[19px]" style={{ color: A.frame }} />
            ) : (
              <Wallet className="h-[19px] w-[19px]" style={{ color: A.frame }} />
            )}
          </div>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em' }}>Accounting</span>
            <ChevronRight className="h-[15px] w-[15px] flex-none self-center" style={{ color: '#6E9484' }} />
            <span
              className="truncate"
              style={{
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: '.16em',
                textTransform: 'uppercase',
                color: A.inkSky
              }}
            >
              {company
                ? screen === 'voucher'
                  ? 'Vouchers'
                  : screen === 'ledger'
                    ? 'Ledgers'
                    : screen === 'masters'
                      ? 'Masters'
                      : screen === 'openings'
                        ? 'Opening balances'
                        : screen === 'notesreg'
                          ? noteKindFilter === 'credit'
                            ? 'Credit notes'
                            : 'Debit notes'
                          : SCREEN_TITLE[screen] || ''
                : 'Select company'}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!!company && (
              <button
                type="button"
                title="Change company"
                onClick={() => {
                  setScreen('gateway')
                  setCompany(null)
                }}
                className="transition-colors hover:bg-white/10"
                style={chip}
              >
                <Building2 className="h-4 w-4 flex-none" style={{ color: A.accent }} />
                <span className="max-w-[220px] truncate" style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.02em' }}>
                  {String(company.name)}
                </span>
                <span style={chipKey}>{fKeyLabel('F3')}</span>
              </button>
            )}
            {!!company && (
              <div className="relative">
                <button
                  type="button"
                  title="Set the period every report here answers for"
                  onClick={() => setPeriodOpen((o) => !o)}
                  className="transition-colors hover:bg-white/10"
                  style={chip}
                >
                  <CalendarRange className="h-4 w-4 flex-none" style={{ color: A.accent }} />
                  <span style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 11.5, fontWeight: 600 }}>{periodLabel}</span>
                  <span style={chipKey}>{chordLabel('Alt F2')}</span>
                </button>
                {periodOpen && (
                  <div
                    className="absolute right-0 z-50 mt-1.5 w-[286px] rounded-[4px] p-3 shadow-xl"
                    style={{ background: A.paper, border: `1px solid ${A.edge}`, color: A.ink }}
                  >
                    <div
                      style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: A.muted }}
                    >
                      Period
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="date"
                        value={dbFrom}
                        onChange={(e) => applyPeriod(e.target.value, dbTo)}
                        className="h-8 min-w-0 flex-1 rounded-[3px] px-2 outline-none"
                        style={{ border: `1px solid ${A.none}`, background: '#fff', fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 11.5 }}
                      />
                      <span style={{ fontSize: 11, color: A.muted }}>to</span>
                      <input
                        type="date"
                        value={dbTo}
                        onChange={(e) => applyPeriod(dbFrom, e.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-[3px] px-2 outline-none"
                        style={{ border: `1px solid ${A.none}`, background: '#fff', fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 11.5 }}
                      />
                    </div>
                    <p className="mt-2" style={{ fontSize: 10.5, fontWeight: 600, color: A.muted, lineHeight: 1.45 }}>
                      Every report in this module answers for these dates — the day book, each statement, the
                      registers and the trial balance.
                    </p>
                    <div className="mt-2.5 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          applyPeriod('', todayISO())
                          setPeriodOpen(false)
                        }}
                        className="h-8 flex-1 rounded-[3px]"
                        style={{ border: `1px solid ${A.none}`, fontSize: 11, fontWeight: 700, color: A.ink }}
                      >
                        All dates
                      </button>
                      <button
                        type="button"
                        onClick={() => setPeriodOpen(false)}
                        className="h-8 flex-1 rounded-[3px]"
                        style={{ background: A.frame, color: '#fff', fontSize: 11, fontWeight: 800 }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* NO STATUS PILL, NO BELL.
                This header carries what is true of the SCREEN — the module,
                the company, the period — and Accounting takes the whole window
                with the app's own rail behind it, so the connection light and
                the bell were a second header's worth of chrome competing with
                the one figure the screen is about. Both live on every other
                page, which is where somebody goes looking for them; the update
                badge stays because a stale bundle is worth interrupting for. */}
            {(onLedger || onDaybook) && (
              <button
                type="button"
                onClick={() => openVoucher(vchType)}
                className="flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-[6px] px-[13px]"
                style={{
                  background: 'linear-gradient(180deg,#DDF97A,#B9E534)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.6)',
                  color: A.frame,
                  fontSize: 12,
                  fontWeight: 800
                }}
              >
                <Plus className="h-[17px] w-[17px]" />
                New voucher
              </button>
            )}
            {(onBooks || onDaybook) && (
              <button
                type="button"
                onClick={() => setScreen('ledger')}
                title="Open the ledgers"
                className="flex-none whitespace-nowrap transition-colors hover:bg-white/10"
                style={{ ...chip, gap: 7, fontSize: 12, fontWeight: 800 }}
              >
                <BookOpen className="h-4 w-4 flex-none" style={{ color: A.accent }} />
                Ledgers
              </button>
            )}
            <span className="flex items-center gap-2">
              <UpdateBadge />
            </span>
          </div>
        </div>

        {onLedger && ledgerWeb.strip}
        {onBooks && booksWeb.strip}
        {onTf && tfWeb.strip}
        {onDaybook && daybookWeb.strip}

        {onVoucher && (
          <div className="sc flex h-[50px] items-center gap-1.5 overflow-x-auto">
            {VCH_TYPES.filter((v) => mayEnter(v.key) || v.key === vchType).map((v) => {
              // A voucher being viewed is not one being keyed, so no type is lit.
              const on = !viewOnly && vchType === v.key
              const dot = v.key === 'DEBIT NOTE' ? '#F0AFAA' : v.key === 'CREDIT NOTE' ? '#9FE3BF' : A.inkSky
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => switchType(v.key)}
                  className="flex h-9 flex-none items-center gap-[9px] whitespace-nowrap rounded-[7px] px-3.5 transition-colors"
                  style={{
                    background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
                    border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
                    boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.6),0 6px 16px -6px rgba(199,240,63,.55)' : 'none',
                    color: on ? A.frame : '#DCEFE4',
                    fontSize: 12,
                    fontWeight: 800
                  }}
                >
                  <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: on ? A.frame : dot }} />
                  {v.label}
                  <span
                    style={{
                      fontFamily: MONO,
                      fontVariantNumeric: FIGS,
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: on ? A.frame : A.inkSky,
                      background: on ? 'rgba(11,61,46,.12)' : 'rgba(255,255,255,.07)',
                      borderRadius: 3,
                      padding: '2px 5px'
                    }}
                  >
                    {chordLabel(v.fkey)}
                  </span>
                </button>
              )
            })}
            <div className="flex-1" />
            {vw >= 1320 && (
              <div className="flex flex-none items-center gap-[7px] whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: A.inkSky }}>
                <KeyboardIcon className="h-[15px] w-[15px]" />
                {chordLabel('F4')}–{chordLabel('F7')} · {chordLabel('Alt F5')} / {chordLabel('F6')} switch type · Ctrl A accepts
              </div>
            )}
          </div>
        )}
        </div>

        {onVoucher ? (
          voucherWeb
        ) : onLedger ? (
          ledgerWeb.body
        ) : onGateway ? (
          gatewayWeb
        ) : onBooks ? (
          booksWeb.body
        ) : onTf ? (
          tfWeb.body
        ) : onDaybook ? (
          daybookWeb.body
        ) : onPayreg ? (
          <PayReceiptRegister
            companyId={company ? Number(company.id) : undefined}
            companyName={String(company?.name || '')}
            onOpen={(v) => openRowSource(v, null)}
          />
        ) : onCashflow ? (
          <CashflowRegister
            companyId={company ? Number(company.id) : undefined}
            companyName={String(company?.name || '')}
            // Opens where the entry was made — the purchase, sale, LC or bill
            // when there is one, else the voucher — and Back comes here.
            onOpen={(v) => openRowSource(v, null)}
          />
        ) : onTally ? (
          <TallyNotesImport
            companyName={String(company?.name || '')}
            companyId={company ? Number(company.id) : undefined}
            accounts={accounts}
            groupNames={groupNames}
            // An invoice opens where it is kept — the sale on the Sales page,
            // the way a ledger's Bill-wise line does, with Back returning to
            // this screen in this company. One with no sale behind it (booked
            // from Tally, keyed by hand) opens its voucher; Esc comes back.
            onOpenVoucher={(id, saleId, orderId) => {
              if (saleId && onOpenRecord) onOpenRecord('sales', saleId, { screen, ledgerId: null, companyId: cid })
              // A purchase likewise opens on the Purchases page, Back returning here.
              else if (orderId && onOpenRecord) onOpenRecord('orders', orderId, { screen, ledgerId: null, companyId: cid })
              else void openForAlter({ id })
            }}
            onChanged={() => {
              loadAccounts()
              void loadGroups()
            }}
          />
        ) : (
        <div className="flex min-h-0 flex-1" style={{ padding: '8px 8px 8px' }}>
          <div
            className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[4px]"
            style={{ background: A.paper, border: `1px solid ${A.edge}` }}
          >
            {!company ? (
              <div className="sc min-h-0 flex-1 overflow-y-auto p-4">
                <div
                  style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: A.muted }}
                >
                  Select company
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                  {companies.map((cm, i) => (
                    <button
                      key={String(cm.id)}
                      type="button"
                      onClick={() => setCompany(cm)}
                      onMouseEnter={() => setCoIndex(i)}
                      className="flex items-center gap-2.5 rounded-[3px] px-3 py-2.5 text-left"
                      style={{
                        background: i === coIndex ? A.select : '#fff',
                        border: `1px solid ${A.edgeSoft}`,
                        borderLeft: `3px solid ${A.frame}`
                      }}
                    >
                      <span style={{ fontFamily: MONO, fontVariantNumeric: FIGS, fontSize: 12, fontWeight: 800, color: A.key }}>{i + 1}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{String(cm.name)}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-3" style={{ fontSize: 10.5, fontWeight: 600, color: A.muted, lineHeight: 1.5 }}>
                  Every ledger, day book and trial balance opened here is for this company&rsquo;s books only. F3
                  switches company from anywhere; Esc leaves accounting.
                </p>
              </div>
            ) : (
              <>
                {(screen === 'purchreg' || screen === 'salesreg' || screen === 'notesreg') && registerWeb}
                {screen === 'trial' && trialWeb}
              </>
            )}
          </div>
        </div>
        )}

        {!!company && (
          <KeyBarScroller>
            {keyBar.map((f) => (
              <AcctKey key={f.k + f.label} k={chordLabel(f.k)} label={f.label} on={f.on} onClick={f.go} />
            ))}
          </KeyBarScroller>
        )}

        {dialogs}
      </div>
    )
  }


  return (
    <div className={cn('fixed inset-0 z-50 flex flex-col overflow-auto', T.frame)}>
      <div className="flex shrink-0 items-center gap-3 px-4 pb-1 pt-2">
        <span className="text-[13px] font-bold uppercase tracking-widest text-amber-300">Rishabh Oil — Accounting</span>
        {company && (
          <button
            type="button"
            title="Change company (F3)"
            onClick={() => { setScreen('gateway'); setCompany(null) }}
            className="cursor-pointer rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/20"
          >
            {company.name} <span className="ml-1 text-amber-300">F3</span>
          </button>
        )}
        <span className="text-[11px] text-white/60">
          F4 Contra · F5 Payment · F6 Receipt · F7 Journal · Ctrl+A accept · Esc back / exit · the highlighted letter jumps to any
          section
        </span>
        {/* This page draws its own header rather than using PageHeader, so it
            has to place the bell itself — see HeaderExtrasProvider. */}
        <span className="ml-auto flex items-center gap-2"><UpdateBadge /><DbStatus />{headerBell}</span>
      </div>
      <div className="flex-1 px-2 pb-2">
        {!company ? (
          <div className="flex h-full items-start justify-center pt-16">
            <div className={cn('w-[380px] rounded-md border shadow-lg', T.paperEdge, T.paper)}>
              <div className={cn('rounded-t-md px-4 py-2 text-center text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
                Select Company
              </div>
              <div className="px-2 py-3">
                {companies.map((cm, i) => (
                  <button
                    key={String(cm.id)}
                    type="button"
                    onClick={() => setCompany(cm)}
                    onMouseEnter={() => setCoIndex(i)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded px-3 py-2.5 text-left text-[14px] transition-colors',
                      i === coIndex ? T.select : 'hover:bg-amber-100/60'
                    )}
                  >
                    <span className={cn('font-bold', T.key)}>{i + 1}</span>
                    <span className="font-medium">{cm.name}</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
                <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">
                  Every ledger, day book and trial balance you open is for this company's books only — press F3
                  anywhere to switch. Esc leaves accounting.
                </p>
              </div>
            </div>
          </div>
        ) : (
        <div className="flex min-h-full">
          <div className="flex min-w-0 flex-1 flex-col">
            {screen === 'gateway' && gateway}
            {screen === 'voucher' && voucherScreen}
            {screen === 'purchreg' && purchaseRegisterScreen}
            {screen === 'salesreg' && salesRegisterScreen}
            {screen === 'daybook' && daybookScreen}
            {screen === 'payreg' && (
              <PayReceiptRegister
                companyId={company ? Number(company.id) : undefined}
                companyName={String(company?.name || '')}
                onOpen={(v) => openRowSource(v, null)}
              />
            )}
            {screen === 'cashflow' && (
              <CashflowRegister
                companyId={company ? Number(company.id) : undefined}
                companyName={String(company?.name || '')}
                onOpen={(v) => openRowSource(v, null)}
              />
            )}
            {screen === 'notesreg' && notesRegisterScreen}
            {(screen === 'tfpur' || screen === 'tfsal') && tFreightScreen}
            {screen === 'ledger' && ledgerScreen}
            {screen === 'trial' && trialScreen}
            {screen === 'openings' && openingsScreen}
          </div>
          {rightBar}
        </div>
        )}
      </div>

      {dialogs}
    </div>
  )
}
