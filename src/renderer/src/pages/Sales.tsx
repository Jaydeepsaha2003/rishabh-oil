import { Fragment, useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Ban, Building2, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock, DoorOpen, Download, History, LogIn, LogOut, Maximize2, Pencil, Plus, Receipt, RotateCcw, Search, SlidersHorizontal, Tag, Tags, Trash2, Truck, Undo2, Upload, X, ListChecks, Info, type LucideIcon} from 'lucide-react'
import { HelpTip, InfoTip } from '@/components/ui/tooltip'
import { moduleScope } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { loadUser } from '@/lib/session'
import { MobileBar } from '@/components/MobileBar'
import { useIsMobile } from '@/lib/useIsMobile'
import { SalesMobile } from './SalesMobile'

// The unloading desk: a user granted the 'unload' scope on Sales reaches this
// page to record one thing — what a delivery actually weighed in at. The rows
// and columns it never gets are filtered in the main process (see
// listSalesForUnloadDesk), so this flag shapes the page to match what the data
// already is rather than being the restriction itself.
const UNLOAD_DESK = (): boolean => moduleScope(loadUser(), 'sales') === 'unload'
import { cn, inkOn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnFilter } from '@/components/ui/column-filter'
import { RowActions } from '@/components/ui/row-actions'
import { GateEntriesDialog } from '@/components/GateEntriesDialog'
import { HistoryDialog, useHistoryDialog } from '@/components/HistoryDialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/PageHeader'
import { FyPicker } from '@/components/FyPicker'
import { UomSelect } from '@/components/UomSelect'
import { DatePicker } from '@/components/ui/date-picker'
import { convertQty, errText, formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { downloadSkuRateExcel, parseSkuRateExcel, caseMT } from '@/lib/skuRateExcel'
import { BASIS_LABEL, saleShortage } from '@/lib/saleShortage'
import { ShortageWorkings, type ShortageLine } from '@/components/ShortageWorkings'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { isManufacturingParty } from '@/lib/constants'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A rate contract past its expiry date. Still a real open bargain — it is
// offered and labelled rather than hidden.
// The first day a contract struck on `date` may expire — the day after it. A
// contract cannot expire on the day it was struck, so same-day is out too.
function dayAfter(date: unknown): string | undefined {
  const v = String(date || '').slice(0, 10)
  if (!v) return undefined
  const d = new Date(`${v}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const rateExpired = (b: Row): boolean => !!b.rate_expiry_date && String(b.rate_expiry_date) < todayISO()

// Dispatch lifecycle: a sale is a pending commitment until the tanker is
// loaded, then tracked in transit and finally unloaded at the customer. Any
// dispatched stage means the finished stock has left the factory.
const DISPATCH_STAGES = [
  { value: 'pending', label: 'Pending', badge: 'warning' as const },
  { value: 'loaded', label: 'Loaded', badge: 'default' as const },
  { value: 'transit', label: 'In transit', badge: 'default' as const },
  { value: 'unloaded', label: 'Unloaded', badge: 'success' as const }
]
function stageInfo(row: Row): (typeof DISPATCH_STAGES)[number] {
  const s = String(row.dispatch_stage || (row.status === 'done' ? 'unloaded' : 'pending'))
  return DISPATCH_STAGES.find((x) => x.value === s) || DISPATCH_STAGES[0]
}

// Sale-bargain type classification (mirrors the purchase-bargain type tabs).
// The five below are the codes already stored on existing bargains, so they stay
// as the base list whatever the master says; the Category master decides which
// of them are OFFERED, and can add its own on top.
const SALE_CATS_BASE: { v: string; label: string }[] = [
  { v: 'FINISHED_OIL', label: 'Finished Oil' },
  { v: 'FATTY', label: 'Fatty' },
  { v: 'SCRAP', label: 'Scrap' },
  { v: 'SPENT_EARTH', label: 'Spent Earth' },
  { v: 'MISC', label: 'Misc' }
]
// A category's master NAME does not always spell its stored code: MISC is
// filed as MISCELLANEOUS. Normalising both ends lets the master switch the
// right option off without renaming anything.
const catKey = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/^MISCELLANEOUS$/, 'MISC')
// Products default to a category the master spells OIL, while the sales side's
// built-in list calls the same thing FINISHED_OIL. They are one category — a
// refined oil is filed under one name in the product register and offered under
// the other on a bargain — so anything matching a product to a sale category
// has to fold them together or the Finished Oil bargains find no products.
const catAlias = (v: unknown): string => {
  const k = catKey(v)
  return k === 'OIL' ? 'FINISHED_OIL' : k
}
const saleCatLabel = (v: unknown): string => {
  const hit = SALE_CATS_BASE.find((c) => c.v === String(v))
  if (hit) return hit.label
  const raw = String(v ?? '').trim()
  if (!raw) return 'Finished Oil'
  // A master-added category: title-case its own name back out of the code.
  return raw
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

// The sale categories to OFFER: the master's active sales-side rows, plus
// whatever is already stored on a record so an old bargain never becomes
// unreadable. `rows` is the Category master.
// `always` holds the categories of products flagged "Used for both" on the
// Products page. A purchase-only category — OIL, HUSK — is offered here when a
// product inside it is flagged, or the flag could not survive the cascade.
function saleCatsFrom(rows: Row[], stored: unknown[], always: unknown[] = []): { v: string; label: string }[] {
  const forced = new Set(always.map((x) => catAlias(x)).filter(Boolean))
  const live = new Set<string>()
  let sawMaster = false
  for (const r of rows) {
    const side = String(r.applies_to || 'both').toLowerCase()
    const key = catKey(r.name)
    if (side !== 'both' && side !== 'sales' && !forced.has(catAlias(key))) continue
    sawMaster = true
    if (Number(r.active) === 0) continue
    live.add(key)
  }
  // No master rows for this side at all (first run, or it failed to load) —
  // fall back to the built-in list rather than emptying the dropdown.
  const out = SALE_CATS_BASE.filter((c) => !sawMaster || live.has(c.v))
  const have = new Set(out.map((c) => c.v))
  for (const extra of [...live, ...stored.map((x) => catKey(x))]) {
    if (extra && !have.has(extra)) {
      have.add(extra)
      out.push({ v: extra, label: saleCatLabel(extra) })
    }
  }
  return out
}

// First day of the current month, YYYY-MM-DD.
function monthStartISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// SUM() over many dispatch/adjustment rows can carry floating-point residue
// past a real zero (e.g. 0.00002) — round every register figure to 3 decimals
// so `inRegister`'s zero-balance check actually lands on exact zero, same fix
// already applied to adjustSalesBargainQty's balance_qty rounding.
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

// Period register figures for a bargain, relative to [from,to].
// opening (b/f) + addition (created in period) + adjusted (manual add/remove
// in period) − dispatch (in period) = closing. `futureAdjusted` is any
// adjustment dated after `to` — excluded from the period math (it hasn't
// happened yet as of `to`) but surfaced separately so it isn't just dropped.
function bargainRegister(r: Row, from: string, to: string): { opening: number; addition: number; adjusted: number; dispatch: number; ret: number; closing: number; futureAdjusted: number } {
  const qty = Number(r.qty) || 0
  const before = Number(r.disp_before) || 0
  const inP = Number(r.disp_period) || 0
  const adjBefore = Number(r.adj_before) || 0
  const adjIn = Number(r.adj_in) || 0
  const adjAfter = Number(r.adj_after) || 0
  // Goods that came back on a customer credit note. Dated by the note, so a
  // return sits in the month it was raised — and the opening balance carries
  // whatever came back before the period, the same way dispatches do.
  const retBefore = Number(r.ret_before) || 0
  const retIn = Number(r.ret_in) || 0
  const bdate = String(r.bargain_date || '').slice(0, 10)
  const createdInRange = bdate >= from && bdate <= to
  const createdBefore = bdate < from
  // Original booked qty minus every dated top-up (top-ups get their own
  // Adjusted figure in the month they were made, not folded into Opening or
  // blended into Addition).
  const baseQty = qty - adjBefore - adjIn - adjAfter
  const opening = round3(createdBefore ? Math.max(0, baseQty + adjBefore - before + retBefore) : 0)
  const addition = round3(createdInRange ? baseQty : 0)
  const adjusted = round3(adjIn)
  const dispatch = round3(inP)
  const ret = round3(retIn)
  const closing = round3(opening + addition + adjusted - dispatch + ret)
  return { opening, addition, adjusted, dispatch, ret, closing, futureAdjusted: round3(adjAfter) }
}

// A titled card of form fields in the bargain drawer. Two columns, because
// every field in it is short — a full-width column of 46px boxes reads as a
// much longer form than it is. Anything that needs the width says so with
// col-span-2 on its own wrapper.
function BargainSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]">{title}</div>
      <div className="grid grid-cols-2 gap-3.5 rounded-[4px] border border-[#D6E2D6] bg-white p-4 [&_[data-slot=date-picker]]:!h-10 [&_[data-slot=select-trigger]]:!h-10 [&_input]:!h-10 [&_label]:!text-[11.5px] [&_label]:!font-extrabold [&_label]:!text-[#33473E]">
        {children}
      </div>
    </div>
  )
}

// Column-group tints for the sales-bargain register on the website. Opening /
// Addition / Adjusted are one thought (what was contracted) and Dispatch /
// Return are another (what moved), so each set gets a faint ground and hairline
// edges. Twelve identically-painted columns make the eye count across to work
// out which figure belongs to which idea.
const SB_G = '!bg-[#FBFDFA]'
const SB_GL = '!bg-[#FBFDFA] !border-l !border-l-[#EAF0E9]'
const SB_GR = '!bg-[#FBFDFA] !border-r !border-r-[#EAF0E9]'
// The register has two jobs and they want opposite things. Collapsed it is a
// summary of eight customers and has to fit a 13" screen, so the columns are
// pinned and anything longer than its column is cut. Expanded the reader is
// looking at one bargain and its number is the thing they came for — a number
// ending in "..." is no use — so the widths come off the content instead and
// the table slides sideways if it needs to.
const SB_FIT = '!table-fixed [&_td]:!truncate'
const SB_CELLS =
  '!min-w-[1074px] [&_td]:!whitespace-nowrap [&_td]:!px-2 [&_th]:!whitespace-nowrap [&_th]:!px-2'

const SB_BAL = '!bg-[#EFF5EC]'
const SB_HG = '!bg-white/[0.04]'
const SB_HGL = '!bg-white/[0.04] !border-l !border-l-[#C7F03F]/20'
const SB_HGR = '!bg-white/[0.04] !border-r !border-r-[#C7F03F]/20'

// How far a contract has been drawn down, for the bar under the Balance cell.
// Amber from 95%: a contract that is nearly drawn is the one worth spotting
// before someone promises the rest of it to a customer.
function sbBar(opening: number, addition: number, adjusted: number, dispatch: number, ret: number): { pct: number; color: string } {
  const contracted = opening + addition + adjusted
  const net = dispatch - ret
  const pct = contracted > 0 ? Math.min(100, Math.max(0, (net / contracted) * 100)) : 0
  return { pct, color: pct >= 95 ? '#C2700A' : pct > 0 ? '#12855A' : '#DCE7DB' }
}

// Whether a bargain belongs in the register for [from,to]: created on/before the
// period, and either still open at period end OR finished within the period.
// A bargain shows in the register when it still has an open balance, or when
// `showZero` is on — in which case the settled ones come too, regardless of
// which period is selected.
function inRegister(r: Row, from: string, to: string, showZero = false): boolean {
  const bdate = String(r.bargain_date || '').slice(0, 10)
  if (bdate > to) return false
  const reg = bargainRegister(r, from, to)
  if (reg.closing > 1e-6) return true
  // Settled. Shown whenever the switch is on, whatever the period.
  //
  // This used to require the bargain to have been created, finished, or had
  // activity inside [from, to] — which reads sensibly and behaves terribly.
  // Turn the switch on with a month selected and nothing happens: the settled
  // bargains were all finished in some earlier month, so none of them
  // qualified, and the control looked broken. The only way to see them was to
  // widen the range, which is not what "Show settled" says it does.
  //
  // The period still governs what the COLUMNS say — the figures come from
  // bargainRegister(from, to) either way — and a bargain dated after the
  // period end is still out, above. This decides membership only.
  return showZero
}

// ---------------- Sales tab ----------------

function SalesTab({
  focusId,
  onFocusHandled,
  onRegister,
  onBack,
  backLabel
}: {
  focusId?: number | null
  onFocusHandled?: () => void
  onRegister?: (a: { open: () => void; canAdd: boolean; formOpen: boolean }) => void
  onBack?: () => void
  backLabel?: string
}): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('sales')
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [packagings, setPackagings] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [stock, setStock] = useState<Record<number, Row>>({})
  // The mill-wide shortage tolerance, the last fallback for a delivered sale
  // that names no allowance of its own. Same setting the purchase side reads,
  // so a tanker is judged by one rule whichever way it is travelling.
  const [defaultShortagePct, setDefaultShortagePct] = useState('0.2')
  const [loading, setLoading] = useState(true)

  // The invoice form is a full-screen page (room for many line items + freight/GST).
  const [formPage, setFormPage] = useState(false)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [header, setHeader] = useState<Row>({})
  const [items, setItems] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // Which invoice-form line items are unfolded (website form only). Absent =
  // open, so a freshly added item shows its fields without a click.
  const [openItems, setOpenItems] = useState<Record<number, boolean>>({})
  // Has anything been typed since the form opened? Drives the "Unsaved
  // changes" chip in the form's own header — set by the field setters, and
  // cleared whenever a form is opened or a save lands.
  const [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState('')
  // The desk opens with no lower bound: a load that went out last month and is
  // still not unloaded has to be on the list, not behind a date change.
  const [dateFrom, setDateFrom] = useState(UNLOAD_DESK() ? '' : monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  // Empty = every product type.
  const [productType, setProductType] = useState<string[]>([])
  // Which numbers the invoice series has skipped. A number nobody used is a
  // number somebody has to account for — a cancelled bill, a spoiled form, or
  // one written and never keyed — so it is worth being able to ask.
  // The prefix this company's invoices carry, read from the series it already
  // uses. Handed to the field so it cannot be mistyped — the "KRFL./490" that
  // read as a missing bill was a stray full stop, and no amount of care stops
  // that happening again while the prefix is typed by hand.
  const [series, setSeries] = useState<Row | null>(null)
  useEffect(() => {
    window.api.sales
      .series()
      .then(setSeries)
      .catch(() => {})
  }, [rows.length])

  const [gapsOpen, setGapsOpen] = useState(false)
  const [gaps, setGaps] = useState<Row | null>(null)
  const [gapsBusy, setGapsBusy] = useState(false)

  // Book the missing number: close the report and open a fresh invoice with the
  // number already in it. No navigation involved — this report lives on the
  // Sales page, so the form it wants is the one right behind it.
  function bookGap(prefix: string, num: number): void {
    setGapsOpen(false)
    setEditingGroup(null)
    setHeader({ ...blankHeader(), invoice_no: `${prefix}/${num}` })
    setItems([blankItem()])
    setDirty(false)
    setFormPage(true)
  }

  // Void the number instead. A spoiled form or a cancelled bill is a complete
  // answer to a gap, and recording it is what stops the report growing a tail of
  // questions nobody can close.
  const [voidTarget, setVoidTarget] = useState<{ prefix: string; number: number } | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)

  async function confirmVoid(): Promise<void> {
    if (!voidTarget) return
    setVoidBusy(true)
    try {
      await window.api.sales.cancelInvoiceNo({ ...voidTarget, reason: voidReason })
      toast.success(`${voidTarget.prefix}/${voidTarget.number} recorded as cancelled`)
      setVoidTarget(null)
      setVoidReason('')
      await loadGaps()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setVoidBusy(false)
    }
  }

  async function undoVoid(prefix: string, num: number): Promise<void> {
    try {
      await window.api.sales.uncancelInvoiceNo({ prefix, number: num })
      toast.success(`${prefix}/${num} back in the missing list`)
      await loadGaps()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  async function loadGaps(): Promise<void> {
    setGapsBusy(true)
    try {
      setGaps(await window.api.sales.invoiceGaps(undefined, dateFrom || undefined, dateTo || undefined))
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setGapsBusy(false)
    }
  }
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'sales')) { setDateFrom(globalRange.from); setDateTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
    // The desk needs the deliveries and nothing else. Sales bargains carry
    // contract rates and the masters are of no use without the invoice form, so
    // they are not even fetched — the thin row set is the whole point.
    if (UNLOAD_DESK()) {
      const [ds, dcfg] = await Promise.all([window.api.sales.list(), window.api.settings.all()])
      setRows(ds)
      setDefaultShortagePct(String(dcfg.allowed_shortage_pct ?? '0.2'))
      setLoading(false)
      return
    }
    const [s, pr, sb, st, cu, pk, tr, cfg] = await Promise.all([
      window.api.sales.list(),
      window.api.data.list('products'),
      window.api.salesBargains.list(undefined, undefined, undefined, 'sales'),
      window.api.stock.list(),
      window.api.data.list('customers'),
      window.api.data.list('packagings'),
      window.api.data.list('transporters'),
      window.api.settings.all()
    ])
    setRows(s)
    setDefaultShortagePct(String(cfg.allowed_shortage_pct ?? '0.2'))
    // Finished is what a mill sells. `use_both` adds back a product traded
    // rather than made — a raw oil sold on, which the sub-category gate alone
    // would never offer here.
    setProducts(pr.filter((x) => x.active && (x.category === 'finished' || Number(x.use_both) === 1)))
    setBargains(sb)
    setCustomers(cu.filter((x) => x.active))
    setPackagings(pk.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    const sm: Record<number, Row> = {}
    for (const l of st) sm[l.id as number] = l
    setStock(sm)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Trading customers are left out — a pass-through deal is booked on the
  // Trading screen, not here. The invoice's own customer always stays listed,
  // so an invoice already raised on one still opens and edits normally.
  const invoiceCustomers = useMemo(
    () =>
      customers.filter(
        (c) => isManufacturingParty(c) || String(c.id) === String(header.customer_id || '')
      ),
    [customers, header.customer_id]
  )

  // Who did what to one invoice. An invoice is a GROUP of line rows, so its
  // history is keyed by the group string rather than a row id. Events written
  // before that key existed carry only their summary line, so those are matched
  // on it as a fallback -- which is why an older invoice still shows who raised
  // it even though nothing pointed at it at the time.
  const hist = useHistoryDialog()
  const openHistory = (inv: { first: Row; lines: Row[] }): void => {
    const first = inv.first
    hist.open({
      entity: 'Sale',
      key: String(first.invoice_group || `LEGACY-${first.id}`),
      detail: first.invoice_no ? `Inv ${first.invoice_no}` : null,
      title: String(first.invoice_no || 'this invoice'),
      subtitle: `${first.customer || '—'} · ${formatDate(first.sale_date)} · ${inv.lines.length} line${inv.lines.length === 1 ? '' : 's'}`
    })
  }

  // Sales grouped into invoices (line items sharing an invoice_group).
  const unloadOnly = UNLOAD_DESK()
  // Columns rendered + the Actions column, for the empty/loading colSpan.
  const colCount = unloadOnly ? 4 : 8
  const invoices = useMemo(() => {
    const m = new Map<string, Row[]>()
    // The unloading desk is FOR-only, and only what is still out. The main
    // process already hands back nothing else (listSalesForUnloadDesk), but the
    // page decides its own layout from the cached grant while the data is
    // scoped by the signed-in session — so if those two ever disagree (a
    // session not yet registered, say) this makes sure an Ex sale or an
    // already-unloaded one still cannot appear on the desk.
    const deskRows = !unloadOnly
      ? rows
      : rows.filter(
          (r) =>
            String(r.freight_term || 'FREIGHT_ON_GOODS') === 'DLD' &&
            String(r.dispatch_stage || (r.status === 'done' ? 'unloaded' : 'pending')) !== 'unloaded' &&
            !r.rejected_at &&
            Number(r.is_trading) !== 1
        )
    for (const r of deskRows) {
      const g = String(r.invoice_group || `LEGACY-${r.id}`)
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(r)
    }
    return Array.from(m.entries())
      .map(([group, lines]) => {
        const first = lines[0]
        const amount = lines.reduce((s, r) => s + (Number(r.amount) || 0), 0)
        // Freight moves the invoice total: recovered adds it, deducted takes it
        // off. Same rule the sale voucher's customer leg is posted on.
        const freight = lines.reduce((s, r) => s + (Number(r.transport_amount) || 0), 0)
        const net =
          lines.reduce((s, r) => s + (Number(r.amount) || 0) + (Number(r.gst_amount) || 0) + (Number(r.round_off) || 0), 0) -
          (Number(first.deduct_freight) === 1 ? freight : 0)
        const qty = lines.reduce((s, r) => s + (Number(r.qty) || 0), 0)
        // The same figure split by the unit each line is actually in. A
        // carton is not a tonne, so an invoice carrying both has no single
        // quantity — `qty` stays for the places that want one number, and the
        // register column reads this instead, which is what lets it print the
        // unit beside the figure rather than leaving the reader to assume MT.
        const qtyByUom = new Map<string, number>()
        for (const r of lines) {
          const u = String(r.uom || 'MT').toUpperCase()
          qtyByUom.set(u, (qtyByUom.get(u) || 0) + (Number(r.qty) || 0))
        }
        return { group, lines, first, amount, net, qty, qtyByUom }
      })
      .sort((a, b) => Number(b.first.id) - Number(a.first.id))
  }, [rows, unloadOnly])

  // Invoice list filtered by the sale date range and a free-text search over
  // invoice no, customer and product names.
  // Product types present across the dispatched lines, for the filter beside the
  // date range. An invoice matches when any of its lines is of that type.
  const productTypes = useMemo(
    () =>
      Array.from(
        new Set(
          invoices.flatMap((inv) => inv.lines.map((r) => String(r.product_category || '')).filter(Boolean))
        )
      ).sort(),
    [invoices]
  )
  // Rejected invoices (the customer refused the consignment) stay right in
  // the main list — they're still sales, just flagged with a badge. Narrowing
  // by dispatch state is done from the "Dispatch" column's own header filter,
  // which lists exactly the states the column actually shows (including
  // "Done" and "Cancelled") — so there's no separate Status dropdown.
  // Excel-style per-column filters on the invoice register. Empty = that
  // column isn't filtering. Keyed by column so one state object covers them all.
  const [invCols, setInvCols] = useState<Record<string, string[]>>({})

  // Everything the date/type/status/search rules allow — the pool the column
  // filters then narrow, and the pool their dropdowns are built from.
  const invBaseRows = useMemo(() => {
    const f = dateFrom || '0000-01-01'
    const t = dateTo || '9999-12-31'
    const q = search.trim().toLowerCase()
    return invoices.filter((inv) => {
      // Trading is a pass-through deal booked and tracked on its own page — it
      // never touches this customer's regular sales relationship, so it does
      // not belong in this register. Same rule the Purchases register uses.
      if (Number(inv.first.is_trading) === 1) return false
      const d = String(inv.first.sale_date || '').slice(0, 10)
      if (d < f || d > t) return false
      if (productType.length && !inv.lines.some((r) => productType.includes(String(r.product_category || '')))) {
        return false
      }
      if (!q) return true
      const hay = [
        inv.first.invoice_no,
        inv.first.customer,
        ...inv.lines.map((r) => r.product_name)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [invoices, dateFrom, dateTo, search, productType])

  // The invoice-register columns that carry a header filter, and how each one
  // reads its value off a grouped invoice. Money/qty format the same way the
  // cell does, so the dropdown lists exactly what's on screen.

  const INV_COLUMNS: { key: string; label: string; of: (inv: Row) => string }[] = useMemo(() => {
    const all: { key: string; label: string; of: (inv: Row) => string }[] = [
      { key: 'invoice_no', label: 'Date / Invoice', of: (inv) => String(inv.first.invoice_no || '') },
      { key: 'customer', label: 'Customer', of: (inv) => String(inv.first.customer || '') },
      {
        key: 'items',
        label: 'Items',
        of: (inv) =>
          Array.from(new Set((inv.lines as Row[]).map((r) => String(r.product_name || '')).filter(Boolean)))
            .sort()
            .join(', ')
      },
      {
        key: 'qty',
        label: 'Qty',
        // Units here too — a column of bare numbers taken off this screen is
        // read away from it, where the unit cannot be guessed back.
        of: (inv) =>
          [...(inv.qtyByUom as Map<string, number>).entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([u, q]) => `${formatNum(q)} ${u}`)
            .join(' · ') || formatNum(0)
      },
      { key: 'net', label: 'Invoice total', of: (inv) => formatINR(inv.net) },
      {
        // Filters on the TERM (the dropdown then lists exactly FOR and Ex)
        // while the cell also shows what the freight came to, so the column
        // answers both "which ones do we carry?" and "how much?".
        key: 'freight',
        label: 'Freight',
        of: (inv) => (String(inv.first.freight_term || 'FREIGHT_ON_GOODS') === 'DLD' ? 'FOR' : 'Ex')
      },
      {
        key: 'dispatch',
        label: 'Dispatch',
        // Must match exactly what the Dispatch cell RENDERS, or the dropdown
        // offers values the column never shows. An ex-term invoice (customer
        // lifts, so there is no dispatch to track) displays "Done" rather than
        // a stage — filtering on its underlying stage instead was hiding rows
        // that visibly said Done.
        of: (inv) => {
          // Must read the same as the cell — see the note there.
          if (inv.first.rejected_at) return 'Rejected'
          if (String(inv.first.freight_term || 'FREIGHT_ON_GOODS') !== 'DLD') return 'Done'
          return String(stageInfo(inv.first).label || '')
        }
      }
    ]
    // The desk gets Date/Invoice, Customer, Item and Dispatch status — nothing
    // else. Qty, invoice value and the freight term are not its business.
    return all.filter((c) => !unloadOnly || ['invoice_no', 'customer', 'items', 'dispatch'].includes(c.key))
  }, [unloadOnly])

  // Rows that pass every filter EXCEPT this column's own — so each dropdown
  // lists the values still reachable given the other filters, the way Excel
  // narrows its lists, instead of always offering the whole table.
  function invColOptions(key: string): { value: string; label: string; count: number }[] {
    const col = INV_COLUMNS.find((c) => c.key === key)
    if (!col) return []
    // Counted, not just collected — the filter panel shows how many rows sit
    // behind each value, and this walk already visits every one of them.
    const seen = new Map<string, number>()
    for (const inv of invBaseRows) {
      let ok = true
      for (const other of INV_COLUMNS) {
        if (other.key === key) continue
        const sel = invCols[other.key]
        if (sel?.length && !sel.includes(other.of(inv))) { ok = false; break }
      }
      if (ok) {
        const v = col.of(inv)
        seen.set(v, (seen.get(v) || 0) + 1)
      }
    }
    return Array.from(seen.keys())
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((v) => ({ value: v, label: v || '(blank)', count: seen.get(v) || 0 }))
  }

  const filteredInvoices = useMemo(
    () =>
      invBaseRows.filter((inv) =>
        INV_COLUMNS.every((c) => {
          const sel = invCols[c.key]
          return !sel?.length || sel.includes(c.of(inv))
        })
      ),
    [invBaseRows, invCols, INV_COLUMNS]
  )

  // Ten invoices to a page. The register runs to a hundred and more in a
  // period, and every row can expand into a panel — a single scroll of that
  // length is unusable, and it makes the browser lay out work nobody is
  // looking at.
  //
  // The TOTALS above the table stay whole-period on purpose: they answer "what
  // did we sell", which a page of ten cannot.
  const INV_PAGE = 10
  const [invPage, setInvPage] = useState(1)
  const invPageCount = Math.max(1, Math.ceil(filteredInvoices.length / INV_PAGE))
  // Any change to what is being listed puts the reader back on page one —
  // otherwise a filter that leaves three invoices shows an empty page four.
  useEffect(() => {
    setInvPage(1)
  }, [invBaseRows, invCols])
  const pagedInvoices = useMemo(() => {
    const start = (Math.min(invPage, invPageCount) - 1) * INV_PAGE
    return filteredInvoices.slice(start, start + INV_PAGE)
  }, [filteredInvoices, invPage, invPageCount])

  function blankHeader(): Row {
    return {
      sale_date: todayISO(),
      invoice_no: '',
      customer: '',
      customer_id: '',
      freight_term: 'FREIGHT_ON_GOODS',
      transporter_id: '',
      transport_rate: '',
      allowed_shortage_pct: '',
      dispatch_stage: 'pending',
      loaded_date: '',
      transit_date: '',
      unloaded_date: '',
      round_off: '',
      round_off_manual: false,
      tds_pct: ''
    }
  }
  function blankItem(): Row {
    return { product_id: '', sales_bargain_id: '', sale_type: 'LOOSE', packaging_id: '', boxes: '', pouches: '', qty: '', rate: '', gst_pct: '', gst_type: 'CGST_SGST' }
  }

  function openAdd(): void {
    setEditingGroup(null)
    setHeader(blankHeader())
    setItems([blankItem()])
    setDirty(false)
    setFormPage(true)
  }
  useEffect(() => {
    onRegister?.({ open: openAdd, canAdd: products.length > 0 && !unloadOnly, formOpen: formPage })
  }, [products.length, formPage]) // eslint-disable-line react-hooks/exhaustive-deps

  function openEditInvoice(inv: { group: string; lines: Row[]; first: Row }): void {
    setEditingGroup(inv.group)
    const f = inv.first
    setHeader({
      sale_date: f.sale_date ?? todayISO(),
      invoice_no: f.invoice_no ?? '',
      customer: f.customer ?? '',
      customer_id: f.customer_id ? String(f.customer_id) : '',
      freight_term: f.freight_term ?? 'FREIGHT_ON_GOODS',
      transporter_id: f.transporter_id ? String(f.transporter_id) : '',
      transport_rate: f.transport_rate ?? '',
      allowed_shortage_pct: f.allowed_shortage_pct ?? '',
      deduct_freight: !!f.deduct_freight,
      is_trading: !!f.is_trading,
      dispatch_stage: f.dispatch_stage ?? (f.status === 'done' ? 'unloaded' : 'pending'),
      loaded_date: f.loaded_date ?? '',
      transit_date: f.transit_date ?? '',
      unloaded_date: f.unloaded_date ?? '',
      // Round off lives on the first line of the group; sum is safe either way.
      round_off: inv.lines.reduce((s, r) => s + (Number(r.round_off) || 0), 0) || '',
      // Whether it was typed by hand is RECORDED on the invoice, not guessed
      // from "the value isn't zero" — that old guess froze a figure correct
      // for the OLD totals the moment anything else was edited, so the total
      // stopped landing on a whole rupee. Auto now keeps itself right, and a
      // real manual override is both respected and visibly flagged.
      round_off_manual: !!inv.lines.some((r) => Number(r.round_off_manual) === 1),
      tds_pct: f.tds_pct ?? ''
    })
    setItems(inv.lines.map((r) => ({
      product_id: String(r.product_id ?? ''),
      sales_bargain_id: r.sales_bargain_id ? String(r.sales_bargain_id) : '',
      sale_type: r.sale_type ?? 'LOOSE',
      packaging_id: r.packaging_id ? String(r.packaging_id) : '',
      boxes: r.boxes ?? '',
      pouches: r.pouches ?? '',
      qty: r.qty ?? '',
      rate: r.rate ?? '',
      // The per-case rate the line was billed on, so reopening an invoice shows
      // and re-saves the same figure rather than deriving one back through the
      // MT conversion.
      rate_case: r.rate_per_case == null ? '' : String(r.rate_per_case),
      gst_pct: r.gst_pct ?? '',
      gst_type: r.gst_type ?? 'CGST_SGST'
    })))
    setDirty(false)
    setFormPage(true)
  }

  // Deep-link from Ledgers: open the invoice containing the given sale line.
  useEffect(() => {
    if (!focusId) return
    const inv = invoices.find((v) => v.lines.some((r) => Number(r.id) === Number(focusId)))
    if (!inv) return
    openEditInvoice(inv)
    onFocusHandled?.()
  }, [focusId, invoices]) // eslint-disable-line react-hooks/exhaustive-deps

  function setHeaderField(key: string, value: unknown): void {
    setDirty(true)
    setHeader((p) => ({ ...p, [key]: value }))
  }
  function setItem(idx: number, patch: Row): void {
    setDirty(true)
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }
  function addItem(): void {
    setDirty(true)
    setItems((prev) => [...prev, blankItem()])
  }
  function removeItem(idx: number): void {
    setDirty(true)
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  // Customer bargain matching (by master id, else name).
  const custId = String(header.customer_id || '')
  const custName = String(header.customer || '').trim().toLowerCase()
  const matchesCustomer = (b: Row): boolean => {
    if (!custId && !custName) return true
    if (custId && b.customer_id != null && String(b.customer_id) !== '') return String(b.customer_id) === custId
    return String(b.customer || '').trim().toLowerCase() === custName
  }
  // As-of date for rate validity: the invoice's own date. A bargain that
  // lapsed on 27-07 was still live for an invoice dated 16-07, so a back-dated
  // entry must not be told its rate has expired.
  const asOfDate = String(header.sale_date || '').slice(0, 10) || todayISO()
  const notExpired = (b: Row): boolean => !b.rate_expiry_date || String(b.rate_expiry_date) >= asOfDate
  // A contract whose rate date has passed is still a real open bargain — the
  // office decides whether to sell against it. Hiding it just left the picker
  // saying "no bargain" with no reason, so it is offered and labelled instead,
  // with the live ones first.
  const bargainsFor = (item: Row): Row[] =>
    bargains
      .filter(
        (b) =>
          String(b.id) === String(item.sales_bargain_id) ||
          (String(b.product_id) === String(item.product_id) && matchesCustomer(b) && Number(b.balance_qty) > 0)
      )
      .sort((a, b) => Number(notExpired(b)) - Number(notExpired(a)))

  // How much of the sale unit one case holds — the bridge between a case
  // rate and the per-unit rate the invoice actually charges on.
  // NOT rounded. This factor divides the per-case rate to get the per-MT rate
  // that is actually stored, so any rounding here lands straight on the money.
  // A 13.395 KG case is 0.013395 MT — six decimals — and rounding to five gave
  // 0.0134, a 0.037% error that understated a ₹20 lakh line by ₹760. A 15 KG
  // case (0.015 MT) survived it, which is why only some lines looked wrong.
  function mtPerCase(c: { selPack: Row | undefined; packBaseUom: string; saleUom: string }): number {
    if (!c.selPack) return 0
    const perCase = (Number(c.selPack.pouches_per_box) || 0) * (Number(c.selPack.base_per_pouch) || 0)
    return convertQty(perCase, c.packBaseUom, c.saleUom)
  }

  // The unit a line is quoted, billed and stocked in. This MUST follow the
  // same order the main process uses when it stamps the saved row
  // (resolveSaleQty): the bargain, then anything the line already carries,
  // then THE PRODUCT'S OWN unit, and only then MT.
  //
  // The screen stopped at the bargain, so a loose sale of a KG product with no
  // bargain behind it asked for "Qty (MT)" and "Rate /MT" while the row it
  // saved was stamped KG — the field asked for one unit and the book recorded
  // another. The main process already resolved this correctly; only the labels
  // and the on-screen conversions were reading off the wrong unit.
  function saleUomOf(item: Row, b: Row | undefined): string {
    const fromBargain = String(b?.uom || '').trim()
    if (fromBargain) return fromBargain
    const own = String(item.uom || '').trim()
    if (own) return own
    const p = products.find((x) => String(x.id) === String(item.product_id))
    return String(p?.uom || '').trim() || 'MT'
  }

  // Per-item computed quantity (packaging → sale unit), amount and GST.
  function calc(item: Row): {
    isPacked: boolean; selPack: Row | undefined; saleUom: string; packBaseUom: string
    packBaseQty: number; effQty: number; amount: number; gstPct: number; gstAmt: number; net: number
  } {
    const isPacked = item.sale_type === 'PACKED'
    const selPack = isPacked && item.packaging_id ? packagings.find((p) => String(p.id) === String(item.packaging_id)) : undefined
    const b = bargains.find((x) => String(x.id) === String(item.sales_bargain_id))
    const saleUom = saleUomOf(item, b)
    const packBaseUom = selPack ? String(selPack.base_uom || 'KG') : saleUom
    const packBaseQty = selPack
      ? (Number(item.boxes) || 0) * (Number(selPack.pouches_per_box) || 0) * (Number(selPack.base_per_pouch) || 0) +
        (Number(item.pouches) || 0) * (Number(selPack.base_per_pouch) || 0)
      : 0
    const packQty = selPack ? convertQty(packBaseQty, packBaseUom, saleUom) : 0
    const effQty = isPacked ? packQty : Number(item.qty) || 0
    // Packed: cases x rate-per-case, the figure the deal was struck on. Loose:
    // rate x quantity. Converting a case weight to MT is not always exact, so
    // the money must never be taken through that conversion.
    const perCaseBase = selPack
      ? (Number(selPack.pouches_per_box) || 0) * (Number(selPack.base_per_pouch) || 0)
      : 0
    const casesEq = selPack && perCaseBase > 0 ? packBaseQty / perCaseBase : 0
    // The per-case rate is STATED — off the bargain's rate card, or typed. It is
    // never worked back out of the per-MT rate, because that derivation moves
    // with the conversion factor. A line with none (saved before the per-case
    // rate was stored) keeps its original rate x quantity value, exactly as the
    // main process values it.
    const statedCase = Number(item.rate_case)
    const perCaseRate = isPacked && Number.isFinite(statedCase) && statedCase > 0 ? statedCase : 0
    const amount =
      isPacked && perCaseRate > 0 && casesEq > 0
        ? Math.round(casesEq * perCaseRate * 100) / 100
        : effQty * (Number(item.rate) || 0)
    const gstPct = Number(item.gst_pct) || 0
    const gstAmt = Math.round(amount * (gstPct / 100) * 100) / 100
    return { isPacked, selPack, saleUom, packBaseUom, packBaseQty, effQty, amount, gstPct, gstAmt, net: amount + gstAmt }
  }

  const isDld = header.freight_term === 'DLD'
  // What the rate contract behind these lines allows, if it says anything —
  // shown as the placeholder so the invoice's blank field states what leaving
  // it blank will actually mean, rather than just looking unanswered.
  const bargainShortagePct = useMemo(() => {
    for (const it of items) {
      const b = bargains.find((x) => Number(x.id) === Number(it.sales_bargain_id))
      if (b && b.allowed_shortage_pct != null && b.allowed_shortage_pct !== '') return Number(b.allowed_shortage_pct)
    }
    return null
  }, [items, bargains])
  const totals = items.reduce(
    (acc, it) => {
      const c = calc(it)
      acc.amount += c.amount
      acc.gst += c.gstAmt
      acc.qty += c.effQty
      acc.byUom.set(c.saleUom, (acc.byUom.get(c.saleUom) || 0) + c.effQty)
      return acc
    },
    { amount: 0, gst: 0, qty: 0, byUom: new Map<string, number>() }
  )

  // Quantities only add up inside one unit. The strip said "MT" over the sum of
  // every line, which was true only while every line was in MT — an invoice
  // carrying a KG item read its kilos as tonnes. One unit prints as one figure;
  // a mixed invoice prints each unit's own total rather than a meaningless sum.
  const totalQtyLabel =
    [...totals.byUom].map(([u, q]) => `${formatNum(q)} ${u}`).join(' · ') || `${formatNum(0)} MT`

  // Auto round-off to the nearest rupee, same idiom as the purchase form. The
  // base (taxable + GST) does not depend on the round off, so this cannot
  // loop. A manual edit overrides it; clearing the field brings auto back.
  // Rounded to PAISA first. GST can carry a third decimal (5% of an odd
  // taxable value lands on .xx5), and deriving the round off from that
  // un-rounded figure leaves a half-paisa tail — which then surfaced as an
  // invoice total one paisa off a whole rupee.
  const invoiceRawTotal = Math.round((totals.amount + totals.gst) * 100) / 100
  useEffect(() => {
    if (header.round_off_manual) return
    if (!Number.isFinite(invoiceRawTotal) || invoiceRawTotal <= 0) return
    const auto = Math.round(invoiceRawTotal) - invoiceRawTotal
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(header.round_off ?? '') !== val) setHeaderField('round_off', val)
  }, [invoiceRawTotal, header.round_off_manual, header.round_off])

  // TDS preview, on the customer master's own terms — the same slab the main
  // process applies on save. Below the FY threshold nothing is withheld when
  // the master says "no TDS below the slab"; above it the invoice's rate runs.
  // Freight on this invoice, on the same basis the main process uses: the rate
  // per case for a packed line, per MT for a loose one.
  const freightPreview = !isDld
    ? 0
    : Math.round(
        items.reduce((t, it) => {
          const c = calc(it)
          const rate = Number(header.transport_rate) || 0
          if (rate <= 0) return t
          const units = c.isPacked ? Number(it.boxes) || 0 : c.effQty
          return t + units * rate
        }, 0) * 100
      ) / 100
  // Only the deduction moves the invoice: it comes off what the customer owes,
  // because they settle the transporter directly. Left unticked the freight is
  // ours to carry and the customer's bill is the goods alone, exactly as before.
  const freightOnInvoice =
    freightPreview <= 0 || !header.transporter_id || !header.deduct_freight ? 0 : -freightPreview
  const invoiceTotal =
    Math.round((totals.amount + totals.gst + (Number(header.round_off) || 0) + freightOnInvoice) * 100) / 100
  // Withheld on the TAXABLE value of the goods — see saleTds in sales.ts for
  // why GST and the round-off are outside the base. This preview has to strike
  // it on the same figure the save does, or the form quotes one net receivable
  // and the ledger books another.
  const tdsBase = Math.round(totals.amount * 100) / 100
  const tds = useMemo(() => {
    const pct = Number(header.tds_pct) || 0
    const cust = customers.find((c) => String(c.id) === String(header.customer_id || ''))
    if (!cust || pct <= 0 || tdsBase <= 0) return { amount: 0, threshold: 0, belowSlab: false }
    const threshold = Number(cust.tds_threshold) || 0
    const basePct = cust.tds_above_only ? 0 : pct
    if (threshold <= 0) return { amount: (tdsBase * pct) / 100, threshold: 0, belowSlab: false }
    // What this customer has already been billed this financial year, taken
    // from the invoices on screen (this invoice itself excluded when editing).
    const d = new Date(String(header.sale_date || todayISO()))
    const startY = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
    const fyStart = `${startY}-04-01`
    const upto = String(header.sale_date || todayISO()).slice(0, 10)
    const prior = rows
      .filter(
        (r) =>
          String(r.customer_id ?? '') === String(header.customer_id) &&
          String(r.sale_date ?? '').slice(0, 10) >= fyStart &&
          String(r.sale_date ?? '').slice(0, 10) <= upto &&
          (!editingGroup || String(r.invoice_group ?? '') !== String(editingGroup))
      )
      .reduce((s, r) => s + (Number(r.amount) || 0), 0)
    const below = Math.max(0, Math.min(threshold - prior, tdsBase))
    const above = tdsBase - below
    return {
      amount: (below * basePct) / 100 + (above * pct) / 100,
      threshold,
      belowSlab: !!cust.tds_above_only && above <= 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.tds_pct, header.customer_id, header.sale_date, tdsBase, customers, rows, editingGroup])

  // Rate cards for the bargains used on this invoice, keyed by bargain id then
  // packaging id. Loaded when a line names a bargain; the rate it yields is
  // offered, never forced — the line stays editable.
  const [cards, setCards] = useState<Record<string, Record<string, Row>>>({})
  const loadCard = useCallback(async (bargainId: string): Promise<Record<string, Row>> => {
    if (cards[bargainId]) return cards[bargainId]
    try {
      const rows = await window.api.skuRates.list(Number(bargainId))
      const byPack: Record<string, Row> = {}
      for (const r of rows) {
        if (r.rate_per_case != null || r.rate_per_mt != null) byPack[String(r.packaging_id)] = r
      }
      setCards((p) => ({ ...p, [bargainId]: byPack }))
      return byPack
    } catch {
      return {}
    }
  }, [cards])

  // The card is fetched when a bargain is PICKED — which meant opening an
  // existing invoice never fetched it, and the caption then told the user the
  // bargain had no rate card when it plainly did. Load whatever the lines on
  // the form actually reference, however they got there.
  const itemBargainKey = items
    .map((it) => String(it.sales_bargain_id || ''))
    .filter(Boolean)
    .sort()
    .join(',')
  useEffect(() => {
    for (const id of new Set(itemBargainKey.split(',').filter(Boolean))) {
      if (!cards[id]) void loadCard(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemBargainKey])

  // A card row turned into the rate THIS line is priced in. The line always
  // charges rate x quantity in the bargain's unit (MT/KG/L) — even a packed
  // line, whose cases are converted to that unit first.
  //
  // Packed deals are negotiated per case, so the per-case figure is the one to
  // trust: it is derived through the exact same MT-per-case conversion the
  // Rate/Case box itself uses, so it can never disagree with what a person
  // reads off the card. The card's independently-typed per-MT column is only a
  // convenience for whoever filled the sheet — a typo there (dividing by the
  // wrong case size, a slipped decimal) would otherwise bill silently wrong,
  // with nothing on this screen able to catch it.
  function cardRateInUnit(hit: Row, saleUom: string, mtPerCaseValue: number): number | null {
    if (hit.rate_per_case != null && mtPerCaseValue > 0) {
      // Six decimals for the same reason the Rate/Case box uses them: the
      // amount is qty x this rate, so paise-level rounding here cannot
      // reproduce cases x rate-per-case on a fractional case weight.
      return Math.round((Number(hit.rate_per_case) / mtPerCaseValue) * 1e6) / 1e6
    }
    const perMt = hit.rate_per_mt == null ? null : Number(hit.rate_per_mt)
    if (perMt == null) return null
    const u = String(saleUom || 'MT').toUpperCase()
    // KG and L are thousandths of the per-MT rate (1 L counted as 1 KG here).
    return u === 'KG' || u === 'L' ? Math.round((perMt / 1000) * 100) / 100 : perMt
  }

  // The card rate for a line, in the unit the line is priced in.
  function cardRateFor(it: Row): number | null {
    const card = cards[String(it.sales_bargain_id || '')]
    const hit = card?.[String(it.packaging_id || '')]
    if (!hit) return null
    const c = calc(it)
    return cardRateInUnit(hit, c.saleUom, mtPerCase(c))
  }

  function selectItemBargain(idx: number, v: string): void {
    if (v === 'none') { setItem(idx, { sales_bargain_id: '' }); return }
    const b = bargains.find((x) => String(x.id) === v)
    const it = items[idx]
    // Pull the bargain's SKU rate card. The lookup must use the packaging and
    // sale type the line is ABOUT to have (the bargain often brings both) —
    // reading items[idx] inside the .then sees the stale pre-bargain line and
    // the card lookup misses, which is exactly how fed rates failed to appear.
    const nextPack = b?.packaging_id ? String(b.packaging_id) : String(it.packaging_id || '')
    void loadCard(v).then((card) => {
      const hit = card[nextPack]
      if (!hit) return
      const nc = calc({ ...it, sales_bargain_id: v, packaging_id: nextPack, sale_type: b?.sale_type || it.sale_type || 'LOOSE' })
      const rate = cardRateInUnit(hit, nc.saleUom, mtPerCase(nc))
      // Rate/Case is a STATED figure, never a computed one: it comes off the
      // card when the card carries it, otherwise from what the user types. The
      // per-MT rate beside it is the derived one, kept only for reporting.
      if (rate != null) {
        setItem(idx, {
          rate: String(rate),
          rate_case: hit.rate_per_case != null ? String(hit.rate_per_case) : '',
          rate_from_card: true
        })
      }
    })
    setItem(idx, {
      sales_bargain_id: v,
      rate: it.rate || b?.rate || '',
      gst_pct: it.gst_pct || (b && Number(b.gst_pct) > 0 ? b.gst_pct : it.gst_pct),
      gst_type: b?.gst_type || it.gst_type || 'CGST_SGST',
      sale_type: b?.sale_type || it.sale_type || 'LOOSE',
      packaging_id: b?.packaging_id ? String(b.packaging_id) : it.packaging_id,
      product_id: it.product_id || (b ? String(b.product_id) : '')
    })
  }

  function chooseCustomer(v: string): void {
    const cust = customers.find((c) => String(c.id) === v)
    setHeader((p) => ({
      ...p,
      customer_id: v,
      customer: cust?.name ?? p.customer,
      // TDS comes off the customer master, like GST does — still editable.
      tds_pct: cust && Number(cust.tds_pct) > 0 ? cust.tds_pct : ''
    }))
    // Drop item bargains that belong to another customer.
    setItems((prev) => prev.map((it) => {
      const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
      const keep = b && (b.customer_id != null && String(b.customer_id) !== '' ? String(b.customer_id) === v : true)
      return keep ? it : { ...it, sales_bargain_id: '' }
    }))
  }

  // Selling more than the bargain has left. Mirrors the purchase loading query:
  // the excess is booked as a new bargain, moved onto the next open bargain, or
  // added to this one. `idx` is the line it came from.
  const [excess, setExcess] = useState<{
    idx: number
    qty: number
    balance: number
    uom: string
    mode: 'new' | 'existing' | 'expand'
    diffRate: boolean
    rate: string
    targetBargainId: string
  } | null>(null)
  const [excessBusy, setExcessBusy] = useState(false)

  // How much of a bargain this invoice may still draw: the register balance, plus
  // back whatever the invoice being edited already books on it (those lines are
  // about to be replaced), less what the invoice's OTHER lines take from it.
  function bargainRoom(bargainId: string, exceptIdx: number, lines: Row[]): number {
    const b = bargains.find((x) => String(x.id) === String(bargainId))
    if (!b) return Infinity
    let room = Number(b.balance_qty) || 0
    if (editingGroup) {
      for (const r of rows) {
        if (String(r.invoice_group || `LEGACY-${r.id}`) !== editingGroup) continue
        if (String(r.sales_bargain_id || '') === String(bargainId)) room += Number(r.qty) || 0
      }
    }
    lines.forEach((it, i) => {
      if (i === exceptIdx) return
      if (String(it.sales_bargain_id || '') === String(bargainId)) room -= calc(it).effQty
    })
    return Math.round(room * 1000) / 1000
  }

  // Split a line so `keepQty` stays on its bargain and the rest moves to another.
  // A packed line splits on a pouch boundary — the smallest saleable unit — so no
  // case is ever broken in half.
  function splitLine(it: Row, keepQty: number): [Row, Row] {
    const c = calc(it)
    if (!c.isPacked) {
      const keep = Math.max(0, Math.round(keepQty * 1000) / 1000)
      const rest = Math.round((c.effQty - keep) * 1000) / 1000
      return [{ ...it, qty: String(keep) }, { ...it, qty: String(rest) }]
    }
    const ppb = Number(c.selPack?.pouches_per_box) || 1
    const perPouch = convertQty(Number(c.selPack?.base_per_pouch) || 0, c.packBaseUom, c.saleUom)
    const total = (Number(it.boxes) || 0) * ppb + (Number(it.pouches) || 0)
    const keepPouches = perPouch > 0 ? Math.min(total, Math.floor(keepQty / perPouch + 1e-9)) : 0
    const asPack = (n: number): Row => ({
      boxes: Math.floor(n / ppb) ? String(Math.floor(n / ppb)) : '',
      pouches: n % ppb ? String(n % ppb) : ''
    })
    return [{ ...it, ...asPack(keepPouches) }, { ...it, ...asPack(total - keepPouches) }]
  }

  // Carry out the chosen resolution, then save the invoice.
  async function resolveExcess(): Promise<void> {
    if (!excess) return
    const it = items[excess.idx]
    if (!it) return void setExcess(null)
    const label = String(header.invoice_no || '').trim() || '(no number)'
    const date = String(header.sale_date || todayISO())
    setExcessBusy(true)
    try {
      // (a) Grow this bargain and leave the invoice as typed.
      if (excess.mode === 'expand') {
        const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
        await window.api.salesBargains.adjust(
          Number(it.sales_bargain_id),
          excess.qty,
          `Top-up for invoice ${label}`,
          date
        )
        toast.success(`${b?.bargain_no || 'Bargain'} increased by ${formatNum(excess.qty)} ${excess.uom}`)
        setExcess(null)
        await save(items, true)
        return
      }

      // (b) and (c) both split the line, so work out the halves first — the
      // packed split lands on a pouch boundary and can differ slightly from the
      // raw excess, and the new bargain must cover what actually moves.
      const [keep, extra] = splitLine(it, excess.balance)
      const moveQty = calc(extra).effQty
      if (moveQty <= 1e-9) {
        toast.error('Nothing to move — check the quantity')
        return
      }

      let targetId = excess.targetBargainId
      let extraRate = String(it.rate || '')
      if (excess.mode === 'new') {
        const rate = excess.diffRate && Number(excess.rate) > 0 ? Number(excess.rate) : Number(it.rate) || 0
        if (rate <= 0) {
          toast.error('Enter a rate for the new bargain')
          return
        }
        const made = await window.api.salesBargains.create({
          bargain_date: date,
          customer: String(header.customer || ''),
          customer_id: header.customer_id ? Number(header.customer_id) : null,
          product_id: Number(it.product_id),
          qty: moveQty,
          uom: excess.uom,
          rate,
          sale_type: it.sale_type,
          packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
          gst_pct: Number(it.gst_pct) || 0,
          gst_type: it.gst_type,
          freight_term: header.freight_term,
          note: `Excess of ${formatNum(moveQty)} ${excess.uom} on invoice ${label}`
        })
        targetId = String(made.id)
        extraRate = String(rate)
        toast.success(`New bargain ${made.bargain_no} created for ${formatNum(moveQty)} ${excess.uom}`)
      } else {
        if (!targetId) {
          toast.error('Select the bargain the extra quantity goes to')
          return
        }
        const room = bargainRoom(targetId, -1, items)
        if (moveQty > room + 1e-6) {
          const t = bargains.find((x) => String(x.id) === String(targetId))
          toast.error(`${t?.bargain_no || 'That bargain'} has only ${formatNum(room)} ${excess.uom} free`)
          return
        }
        toast.success(`${formatNum(moveQty)} ${excess.uom} moved to the selected bargain`)
      }

      const moved: Row = { ...extra, sales_bargain_id: targetId, rate: extraRate, rate_from_card: false }
      const next = [...items]
      // Nothing fits on the original bargain (its balance is already used up), so
      // the whole line moves rather than leaving an empty one behind.
      if (calc(keep).effQty <= 1e-9) next[excess.idx] = moved
      else next.splice(excess.idx, 1, keep, moved)
      setItems(next)
      setExcess(null)
      await save(next, true)
    } catch (e) {
      toast.error(errText(e))
      await load()
    } finally {
      setExcessBusy(false)
    }
  }

  // Tally's accept shortcut, on the invoice form only.
  useEffect(() => {
    if (!formPage) return
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        if (!saving) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, saving, header, items])

  // Loaded, then in transit, then unloaded — the three dates can only run
  // forwards, and the same day is fine. Returns the complaint or null. The
  // main process refuses an out-of-order set as well and has to, being the
  // only side a second window cannot go around; this exists so the answer
  // arrives under the field rather than as a thrown error after the save.
  function stageDateProblem(
    loaded: unknown,
    transit: unknown,
    unloaded: unknown
  ): string | null {
    const d = (x: unknown): string => String(x || '').slice(0, 10)
    const pairs: [string, string, string, string][] = [
      ['loaded', d(loaded), 'In-transit', d(transit)],
      ['in-transit', d(transit), 'Unloaded', d(unloaded)],
      ['loaded', d(loaded), 'Unloaded', d(unloaded)]
    ]
    for (const [aName, a, bName, b] of pairs) {
      if (!a || !b || a <= b) continue
      return `${bName} date (${formatDate(b)}) cannot be before the ${aName} date (${formatDate(a)}).`
    }
    return null
  }

  async function save(overrideItems?: Row[], excessResolved = false): Promise<void> {
    const lines = overrideItems ?? items
    if (!String(header.invoice_no || '').trim()) return void toast.error('Invoice number is required')
    {
      // The main process refuses this too, and has to — it is the only side a
      // script or a second window cannot go around. Said here so the message
      // names the invoice instead of arriving as a thrown error.
      const want = String(header.invoice_no).trim().toUpperCase()
      const hit = rows.find(
        (r) =>
          String(r.invoice_no || '').trim().toUpperCase() === want &&
          String(r.invoice_group || `row:${r.id}`) !== String(editingGroup || '')
      )
      if (hit) {
        return void toast.error(
          `Invoice ${String(header.invoice_no).trim()} is already used — ${String(hit.customer || 'another customer')}` +
            `${hit.sale_date ? `, ${formatDate(hit.sale_date)}` : ''}. Give this one a number of its own.`
        )
      }
    }
    if (!lines.length) return void toast.error('Add at least one item')
    for (const [i, it] of lines.entries()) {
      if (!it.product_id) return void toast.error(`Item ${i + 1}: select a product`)
      const c = calc(it)
      if (c.isPacked && !it.packaging_id) return void toast.error(`Item ${i + 1}: select a packaging`)
      if (c.effQty <= 0) return void toast.error(`Item ${i + 1}: enter quantity`)
      if ((Number(it.rate) || 0) < 0) return void toast.error(`Item ${i + 1}: rate cannot be negative`)
    }
    if (isDld && !header.transporter_id) return void toast.error('Select a transporter for the FOR delivery')
    {
      const bad = stageDateProblem(header.loaded_date, header.transit_date, header.unloaded_date)
      if (bad) return void toast.error(bad)
    }

    // More on a line than its bargain has left: stop and ask where the extra goes
    // instead of failing the save. The server checks the balance as well, so this
    // is the query, not the guard.
    if (!excessResolved) {
      for (const [i, it] of lines.entries()) {
        if (!it.sales_bargain_id) continue
        const c = calc(it)
        const room = bargainRoom(String(it.sales_bargain_id), i, lines)
        const over = Math.round((c.effQty - room) * 1000) / 1000
        if (over > 1e-6) {
          const b = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
          setExcess({
            idx: i,
            qty: over,
            balance: Math.max(room, 0),
            uom: c.saleUom,
            mode: 'new',
            diffRate: false,
            rate: String(it.rate || b?.rate || ''),
            targetBargainId: ''
          })
          return
        }
      }
    }

    const payload: Row = {
      ...header,
      customer_id: header.customer_id ? Number(header.customer_id) : null,
      transporter_id: header.transporter_id ? Number(header.transporter_id) : null,
      round_off: Number(header.round_off) || 0,
      round_off_manual: header.round_off_manual ? 1 : 0,
      tds_pct: Number(header.tds_pct) || 0,
      items: lines.map((it) => ({
        product_id: Number(it.product_id),
        sales_bargain_id: it.sales_bargain_id ? Number(it.sales_bargain_id) : null,
        sale_type: it.sale_type,
        packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
        boxes: it.boxes,
        pouches: it.pouches,
        qty: it.qty,
        rate: it.rate,
        // A packed line is billed on this, not on rate x MT — the case weight
        // does not always convert exactly and the error lands on the money.
        // Only a STATED rate is stored. Never fabricate one for a line that
        // never had it — the main process then values that line the way it
        // always did, rather than on a figure nobody agreed.
        rate_per_case:
          it.sale_type === 'PACKED' && Number.isFinite(Number(it.rate_case)) && Number(it.rate_case) > 0
            ? Number(it.rate_case)
            : null,
        gst_pct: it.gst_pct,
        gst_type: it.gst_type
      }))
    }
    const submit = async (force: boolean): Promise<void> => {
      const p = force ? { ...payload, force_no_stock: true } : payload
      if (editingGroup) await window.api.sales.updateInvoice(editingGroup, p)
      else await window.api.sales.createInvoice(p)
    }

    setSaving(true)
    try {
      try {
        await submit(false)
      } catch (e) {
        const msg = errText(e)
        if (/stock/i.test(msg)) {
          const go = window.confirm(`${msg}\n\nDispatch anyway (off-stock)? The finished-goods stock will still be reduced by this dispatch and may go negative — this only skips the "enough stock" check.`)
          if (!go) { setSaving(false); return }
          await submit(true)
        } else {
          throw e
        }
      }
      toast.success('Invoice saved')
      setDirty(false)
      setFormPage(false)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  // Marking an invoice Unloaded is the moment the transporter's delivered
  // weight is known, so that is where it gets asked for — one figure per line,
  // since an invoice can carry several products.
  const [unloadInv, setUnloadInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [unloadDate, setUnloadDate] = useState(todayISO())
  const [unloadQty, setUnloadQty] = useState<Record<string, string>>({})
  const [unloadSaving, setUnloadSaving] = useState(false)

  function openUnload(inv: { group: string; first: Row; lines: Row[] }): void {
    setUnloadInv(inv)
    setUnloadDate(String(inv.first.unloaded_date || todayISO()).slice(0, 10))
    // Deliberately blank. A pre-filled dispatched figure is quicker to accept
    // than to retype, which is exactly the problem — it invites confirming a
    // number nobody weighed. Whatever was recorded before is kept, so a re-open
    // is an edit rather than a fresh ask.
    setUnloadQty(
      Object.fromEntries(inv.lines.map((l) => [String(l.id), l.received_qty != null ? String(l.received_qty) : '']))
    )
  }

  async function confirmUnload(): Promise<void> {
    if (!unloadInv) return
    {
      // Only the unloaded date is being set here, but it still has to land on
      // or after the two the invoice already carries.
      const bad = stageDateProblem(unloadInv.first.loaded_date, unloadInv.first.transit_date, unloadDate)
      if (bad) return void toast.error(bad)
    }
    const received: Record<string, number | null> = {}
    for (const l of unloadInv.lines) {
      const raw = unloadQty[String(l.id)]
      if (raw === '' || raw == null) {
        return void toast.error(`Enter the received qty for ${l.product_name} — it is required to unload`)
      }
      const q = Number(raw)
      if (!Number.isFinite(q) || q < 0) return void toast.error(`Enter a valid received qty for ${l.product_name}`)
      received[String(l.id)] = q
    }
    setUnloadSaving(true)
    try {
      await changeInvoiceStage(unloadInv.group, 'unloaded', unloadDate, received)
      setUnloadInv(null)
    } finally {
      setUnloadSaving(false)
    }
  }

  async function changeInvoiceStage(
    group: string,
    stage: string,
    dateIn?: string,
    received?: Record<string, number | null>
  ): Promise<void> {
    const label = DISPATCH_STAGES.find((x) => x.value === stage)?.label || stage
    const today = dateIn || todayISO()
    try {
      await window.api.sales.setInvoiceStage(group, stage, false, today, received)
      toast.success(`Invoice marked ${label}`)
      await load()
    } catch (e) {
      const msg = errText(e)
      if (/stock/i.test(msg)) {
        const go = window.confirm(`${msg}\n\nDispatch anyway (off-stock)? The finished-goods stock will still be reduced by this invoice and may go negative — this only skips the "enough stock" check.`)
        if (!go) return
        try {
          await window.api.sales.setInvoiceStage(group, stage, true, today, received)
          toast.success(`Invoice marked ${label} — off-stock (stock still reduced)`)
          await load()
        } catch (e2) {
          toast.error(errText(e2))
        }
        return
      }
      toast.error(msg)
    }
  }

  async function delInvoice(inv: { group: string; first: Row; lines: Row[] }): Promise<void> {
    if (!window.confirm(`Delete invoice ${inv.first.invoice_no || ''} (${inv.lines.length} item${inv.lines.length > 1 ? 's' : ''})?`)) return
    try {
      await window.api.sales.removeInvoice(inv.group)
      toast.success('Invoice deleted')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // Reject: the customer refused the consignment before it was ever fully
  // delivered — the invoice stays on record (its Credit Note is a separate,
  // manual step) but drops out of the Gate Out picker and the "Produce more"
  // demand calc. Doesn't touch stock or the journal.
  const [rejectInv, setRejectInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  // The invoice whose barrier events are being read. A sale reaches its gate
  // entries three ways — the entry names the sale, the vehicle carried several
  // invoices out, or the two share an invoice_group — so every line's id AND
  // the group go across, and the main process ORs them.
  const [gateInv, setGateInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  async function saveReject(): Promise<void> {
    if (!rejectInv) return
    if (!rejectReason.trim()) return void toast.error('Enter a reason')
    setRejecting(true)
    try {
      await window.api.sales.rejectInvoice(rejectInv.group, rejectReason.trim())
      toast.success('Invoice marked Rejected')
      setRejectInv(null)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRejecting(false)
    }
  }
  // Cancel delivery: the customer calls it off while the load is on the road.
  // Nothing is ever unloaded, so there is no weighed-in quantity — but the
  // transporter carried it and still has to be paid, so the freight is struck on
  // an assumed quantity, pre-filled with what was dispatched and editable.
  const [cancelInv, setCancelInv] = useState<{ group: string; first: Row; lines: Row[] } | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelQty, setCancelQty] = useState<Record<string, string>>({})
  const [cancelling, setCancelling] = useState(false)
  const cancelFreightQty = (cancelInv?.lines || []).reduce(
    (t, l) => t + (Number(cancelQty[String(l.id)]) || 0),
    0
  )

  function openCancel(inv: { group: string; first: Row; lines: Row[] }): void {
    setCancelInv(inv)
    setCancelReason('')
    // Pre-filled with the dispatched figure: the whole load travelled unless the
    // user says otherwise. Unlike unloading, a number here is an assumption we
    // are making on the transporter's behalf, not a weighbridge reading, so it
    // is offered rather than demanded blank.
    setCancelQty(Object.fromEntries(inv.lines.map((l) => [String(l.id), String(Number(l.qty) || 0)])))
  }

  async function confirmCancel(): Promise<void> {
    if (!cancelInv) return
    if (!cancelReason.trim()) return void toast.error('Enter why the delivery was cancelled')
    const freightQty: Record<string, number | null> = {}
    for (const l of cancelInv.lines) {
      const raw = cancelQty[String(l.id)]
      const q = Number(raw)
      if (raw === '' || raw == null || !Number.isFinite(q) || q < 0) {
        return void toast.error(`Enter a valid freight qty for ${l.product_name}`)
      }
      freightQty[String(l.id)] = q
    }
    setCancelling(true)
    try {
      await window.api.sales.cancelDelivery(cancelInv.group, cancelReason.trim(), freightQty)
      toast.success(`Delivery cancelled — freight kept on ${formatNum(cancelFreightQty)} ${cancelInv.first.uom || 'MT'}`)
      setCancelInv(null)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setCancelling(false)
    }
  }

  // ---- Full-invoice drawer (website only) --------------------------------
  // Read-only: it shows what the register already holds, plus the real audit
  // trail behind the invoice — nothing here writes.
  type DrawerInv = { group: string; first: Row; lines: Row[]; qty: number; net: number }
  const [drawer, setDrawer] = useState<DrawerInv | null>(null)
  const [activity, setActivity] = useState<{ what: string; when: string; kind: 'created' | 'in' | 'out' | 'edit' }[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityOpen, setActivityOpen] = useState(true)

  function openDrawer(inv: DrawerInv): void {
    setDrawer(inv)
    setActivity([])
    setActivityLoading(true)
    void (async () => {
      try {
        // Two real sources: the audit trail keyed by this invoice's group
        // (created / edited / cancelled …) and the gate register's own in and
        // out entries for it. Merged into one timeline, oldest first.
        const api = window.api as unknown as Record<string, any>
        const [hist, gate] = await Promise.all([
          api.access?.entityHistory?.('Sale', { key: inv.group, limit: 100 }).catch(() => []) ?? [],
          api.gate?.forRecord?.({ invoiceGroup: inv.group }).catch(() => ({ rows: [] })) ?? { rows: [] }
        ])
        const events: { what: string; when: string; kind: 'created' | 'in' | 'out' | 'edit' }[] = []
        for (const h of (hist || []) as Row[]) {
          const action = String(h.action || '')
          events.push({
            what: `${action}${h.username ? ` by ${h.username}` : ''}`,
            when: String(h.created_at || ''),
            kind: /^created/i.test(action) ? 'created' : 'edit'
          })
        }
        for (const g of ((gate?.rows || []) as Row[])) {
          const dir = String(g.direction || 'in') === 'out' ? 'out' : 'in'
          const stamp = [String(g.entry_date || ''), String(g.entry_time || '')].filter(Boolean).join(' ')
          events.push({
            what: `Tanker gate ${dir}${g.tanker_no ? ` — ${g.tanker_no}` : ''}${g.gate_entry_no ? ` (${g.gate_entry_no})` : ''}`,
            when: stamp,
            kind: dir
          })
        }
        events.sort((a, b) => String(a.when).localeCompare(String(b.when)))
        setActivity(events)
      } finally {
        setActivityLoading(false)
      }
    })()
  }

  async function restoreInvoice(inv: { group: string; first: Row }): Promise<void> {
    try {
      await window.api.sales.unrejectInvoice(inv.group)
      toast.success('Invoice restored')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // Website table re-skin: same forest/lime theme as SalesMobile.tsx's design
  // tokens (T.forest / T.lime), applied to the desktop-width table only on the
  // web build. __WEB__ is compiled out on desktop, so the app there keeps its
  // existing navy/amber look untouched.
  const tableHeaderClass = __WEB__
    ? 'bg-[#0B3D2E] [&_th]:h-[52px] [&_th]:text-[14px] [&_th]:font-extrabold [&_th]:text-white'
    : 'bg-[#1a2c56] [&_th]:text-white'
  const tableHeaderRowClass = __WEB__ ? 'border-0' : 'border-b-2 border-[#1a2c56]/30'
  const totalRowClass = __WEB__
    ? 'border-b-2 border-[#C7F03F] bg-[#F1F5EF] hover:bg-[#F1F5EF] [&_td]:h-[50px]'
    : 'border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50'
  const totalTextClass = __WEB__ ? 'text-[#0A1F17]' : 'text-amber-900'
  const totalMutedTextClass = __WEB__ ? 'text-[#5A6B62]' : 'text-amber-800/70'
  const tableCardClass = __WEB__
    ? 'overflow-x-auto rounded-l-[4px] border-y border-l border-[#D6E2D6] bg-white'
    : 'overflow-x-auto rounded-lg border bg-card'

  return (
    <div>
      {!formPage && (
      <>
      <div
        className={cn(
          'mb-4 flex flex-wrap items-center gap-3',
          // Sales Desktop handoff: white filter bar, 14px gap, taller controls.
          __WEB__ && 'gap-2.5 rounded-l-[4px] border-y border-l border-[#D6E2D6] bg-white px-4 py-2.5'
        )}
      >
        <div className={cn('relative w-full sm:w-72', __WEB__ && 'min-w-[190px] max-w-[340px] flex-1 sm:w-auto')}>
          <Search className={cn('pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2', __WEB__ ? 'text-[#8AA096]' : 'text-muted-foreground')} />
          <Input
            type="search"
            className={cn('h-9 pl-8', __WEB__ && 'h-9 rounded-[4px] border-[#C3D2C6] pl-9 text-[13px]')}
            placeholder="Search invoice no, customer, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              'shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70',
              __WEB__ && 'text-[10.5px] font-extrabold tracking-[.13em] text-[#5A6B62]'
            )}
          >
            Date
          </span>
          <DatePicker value={dateFrom} onChange={(v) => setDateFrom(v || '')} max={dateTo || undefined} className={cn('h-8 w-[9.5rem] shrink-0 text-[11px]', __WEB__ && 'h-9 w-[8.25rem] rounded-[4px] border-[#C3D2C6] text-[12.5px]')} />
          <span className={cn('shrink-0 text-[10px] text-muted-foreground', __WEB__ && 'text-[12.5px] font-semibold text-[#5A6B62]')}>to</span>
          <DatePicker value={dateTo} onChange={(v) => setDateTo(v || '')} min={dateFrom || undefined} className={cn('h-8 w-[9.5rem] shrink-0 text-[11px]', __WEB__ && 'h-9 w-[8.25rem] rounded-[4px] border-[#C3D2C6] text-[12.5px]')} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              'shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70',
              __WEB__ && 'text-[10.5px] font-extrabold tracking-[.13em] text-[#5A6B62]'
            )}
          >
            Product type
          </span>
          <MultiSelectFilter
            options={productTypes.map((t) => ({ value: t, label: t.toUpperCase() }))}
            value={productType}
            onApply={setProductType}
            allLabel="All product types"
            className={cn('h-9 w-[11.5rem] text-[12px]', __WEB__ && 'h-9 w-auto min-w-[150px] max-w-[230px] flex-1 rounded-[4px] border-[#C3D2C6] text-[12.5px] font-bold')}
          />
        </div>
        {!unloadOnly && (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-9 shrink-0 text-[12px]',
              // Alert red from the handoff's token table — the one control on
              // the bar that reports something wrong with the numbering.
              __WEB__ && 'h-9 rounded-[4px] border-transparent bg-[#D7263D] px-3 text-[12.5px] font-bold text-white hover:bg-[#bb1f33] hover:text-white'
            )}
            title="Which numbers the KRFL / KRFIN series has skipped, between the lowest and highest actually used"
            onClick={() => {
              setGapsOpen(true)
              void loadGaps()
            }}
          >
            <ListChecks className="h-3.5 w-3.5" /> Missing invoice nos
          </Button>
        )}
        {unloadOnly && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] font-medium text-sky-900">
            <Truck className="h-3.5 w-3.5 shrink-0" />
            Deliveries still out — record what was received on unloading
          </span>
        )}
        {!unloadOnly && (
        <ExcelButton
          className="ml-auto"
          filename={`sales-invoices-${todayISO()}`}
          sheetName="Sales invoices"
          title="Sales invoices"
          columns={[
            { header: 'Date', key: 'date', value: (r) => formatDate(r.first.sale_date) },
            { header: 'Invoice no', key: 'inv', value: (r) => r.first.invoice_no || '' },
            { header: 'Customer', key: 'cust', value: (r) => r.first.customer || '' },
            { header: 'Items', key: 'items', value: (r) => r.lines.map((l: Row) => l.product_name).join(', ') },
            { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
            { header: 'Invoice total', key: 'net', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.net) || 0 },
            { header: 'Stage', key: 'stage', value: (r) => stageInfo(r.first).label }
          ]}
          rows={filteredInvoices}
        />
        )}
      </div>
      <div className={tableCardClass}>
        <Table className={unloadOnly ? 'min-w-[720px]' : 'min-w-[1040px]'}>
          {/* The dark fill belongs on the THEAD, not the row: TableHeader
              carries [&_tr:hover]:bg-transparent (so a header never lights up
              like a data row), and that descendant selector out-specifies any
              hover: class on the row itself — which made the row go
              transparent on hover and show the white card through it. */}
          <TableHeader className={tableHeaderClass}>
            <TableRow className={tableHeaderRowClass}>
              {INV_COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    c.key === 'invoice_no' && 'w-[150px]',
                    c.key === 'qty' && 'w-[110px] text-right',
                    c.key === 'net' && 'w-[140px] text-right',
                    c.key === 'freight' && 'w-[130px]',
                    // Capped so a long item list wraps inside its own column
                    // instead of stretching the row past one screen.
                    __WEB__ && c.key === 'items' && 'w-[260px]',
                    // The desk has four columns and no Actions, so Dispatch
                    // carries the only control and is pulled to the right —
                    // otherwise Items stretches and leaves a lane of white
                    // space between the item and the button that acts on it.
                    c.key === 'dispatch' && (unloadOnly ? 'w-[240px] text-right' : 'w-[220px]'),
                    unloadOnly && c.key === 'customer' && 'w-[260px]',
                    unloadOnly && c.key === 'items' && 'w-auto'
                  )}
                >
                  <ColumnFilter
                    label={c.label}
                    options={invColOptions(c.key)}
                    value={invCols[c.key] ?? []}
                    onDark
                    onApply={(v) => setInvCols((p) => ({ ...p, [c.key]: v }))}
                    align={
                      c.key === 'qty' || c.key === 'net' || (unloadOnly && c.key === 'dispatch') ? 'end' : 'start'
                    }
                  />
                </TableHead>
              ))}
              {!unloadOnly && <TableHead className="w-[84px] text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Totals for exactly the rows the filters left — sits under the
                header so the figure is read before scrolling, not after. */}
            {!loading && !unloadOnly && filteredInvoices.length > 0 && (
              <TableRow className={totalRowClass}>
                <TableCell className={cn('font-semibold', totalTextClass)}>
                  Total
                  <span className={cn('ml-1.5 font-normal', totalMutedTextClass)}>
                    ({filteredInvoices.length} invoice{filteredInvoices.length === 1 ? '' : 's'})
                  </span>
                </TableCell>
                <TableCell />
                <TableCell />
                {/* Summed BY UNIT, off the lines rather than the invoices.
                    A carton is not a tonne, and adding the two gave a
                    tonnage that was 162 too high the moment one PCS item was
                    invoiced. Reads as one figure while the book is all MT,
                    which is nearly always. */}
                <TableCell className={cn('text-right font-semibold tabular-nums', totalTextClass, __WEB__ && 'text-[14.5px] font-bold')}>
                  {(() => {
                    const by = new Map<string, number>()
                    for (const inv of filteredInvoices)
                      for (const r of inv.lines) {
                        const u = String(r.uom || 'MT').toUpperCase()
                        by.set(u, (by.get(u) || 0) + (Number(r.qty) || 0))
                      }
                    const parts = [...by.entries()].sort((a, b) => b[1] - a[1])
                    if (!parts.length) return formatNum(0)
                    return parts.map(([u, q]) => (
                      <span key={u} className="ml-2 whitespace-nowrap first:ml-0">
                        {formatNum(q)}
                        <span className="ml-1 text-[10.5px] font-semibold opacity-70">{u}</span>
                      </span>
                    ))
                  })()}
                </TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums', totalTextClass, __WEB__ && 'text-[15px] font-bold tracking-[-0.02em]')}>
                  {formatINR(filteredInvoices.reduce((t, inv) => t + (Number(inv.net) || 0), 0))}
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell />
              </TableRow>
            )}
            {loading ? (
              <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : filteredInvoices.length === 0 ? (
              <TableRow><TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                {unloadOnly
                  ? 'Nothing waiting to be received — every delivery in this period has been unloaded.'
                  : invoices.length === 0 ? 'No sales yet.' : 'No sales in this period / search.'}
              </TableCell></TableRow>
            ) : (
              pagedInvoices.map((inv) => {
                const stg = stageInfo(inv.first)
                const exTerm = String(inv.first.freight_term || 'FREIGHT_ON_GOODS') !== 'DLD'
                const idx = DISPATCH_STAGES.findIndex((x) => x.value === stg.value)
                const prevStage = idx > 0 ? DISPATCH_STAGES[idx - 1] : null
                const nextStage = idx < DISPATCH_STAGES.length - 1 ? DISPATCH_STAGES[idx + 1] : null
                const untracked = Number(inv.first.track_stock) === 0
                const isOpen = !!expanded[inv.group]
                // Every unloaded line of this invoice that has something to
                // say about its delivery. It hangs off the FOR tag — one place
                // to look, rather than a figure on the invoice row repeated on
                // each line beneath it.
                const shortLines: ShortageLine[] = inv.lines
                  .map((r) => ({
                    product: String(r.product_name || 'Item'),
                    uom: String(r.uom || ''),
                    s: saleShortage(r, defaultShortagePct)
                  }))
                  .filter((l) => l.s.applies && l.s.shortage > 0.0000005)
                const invDue = shortLines.reduce((t, l) => t + (l.s.within ? 0 : l.s.deductible), 0)
                return (
                  <Fragment key={inv.group}>
                    <TableRow
                      className={unloadOnly ? undefined : 'cursor-pointer'}
                      onClick={unloadOnly ? undefined : () => setExpanded((p) => ({ ...p, [inv.group]: !p[inv.group] }))}
                    >
                      <TableCell className="align-top">
                        <div className="flex items-center gap-1.5">
                          {unloadOnly ? null : isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          <div>
                            <div className={cn('flex items-center gap-1.5 whitespace-nowrap', __WEB__ && 'text-[14px] font-semibold')}>
                              {formatDate(inv.first.sale_date)}
                              {inv.first.rejected_at && (
                                <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
                                  <Ban className="h-2.5 w-2.5" /> Rejected
                                </Badge>
                              )}
                            </div>
                            <div className={cn('truncate text-xs text-muted-foreground', __WEB__ && 'text-[12.5px] text-[#7C9188]')}>{inv.first.invoice_no || '—'}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className={cn('truncate font-medium', __WEB__ && 'text-[14.5px] font-bold tracking-[-0.015em]')} title={inv.first.customer || ''}>{inv.first.customer || '—'}</div>
                        {inv.first.rejected_at && (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-rose-700" title={inv.first.rejected_reason || ''}>
                            <Ban className="h-3 w-3 shrink-0" /> <span className="truncate">{inv.first.rejected_reason}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-sm">{inv.lines.length} item{inv.lines.length > 1 ? 's' : ''}</div>
                        <div className={cn('text-xs text-muted-foreground', __WEB__ ? 'whitespace-normal break-words' : 'truncate')} title={inv.lines.map((r) => r.product_name).join(', ')}>
                          {inv.lines.map((r) => r.product_name).join(', ')}
                        </div>
                      </TableCell>
                      {!unloadOnly && (
                        <>
                      {/* The unit beside every figure, not only on the total
                          row. Read down this column and 33.475 against 162 is
                          two tonnes and a carton count — identical as bare
                          numbers, and the one thing that tells them apart was
                          missing from every row. */}
                      <TableCell className={cn('align-top text-right tabular-nums', __WEB__ && 'text-[14px] font-semibold')}>
                        {[...inv.qtyByUom.entries()]
                          .sort((a, b) => b[1] - a[1])
                          .map(([u, q]) => (
                            <span key={u} className="ml-2 whitespace-nowrap first:ml-0">
                              {formatNum(q)}
                              <span className="ml-1 text-[10.5px] font-semibold opacity-70">{u}</span>
                            </span>
                          ))}
                        {inv.qtyByUom.size === 0 ? formatNum(0) : null}
                      </TableCell>
                      <TableCell className={cn('align-top text-right tabular-nums', __WEB__ && 'text-[14.5px] font-bold tracking-[-0.02em]')}>{formatINR(inv.net)}</TableCell>
                      <TableCell className="align-top">
                        {(() => {
                          // The tag itself, in three states: an Ex sale, a
                          // delivered one with nothing to answer for, and a
                          // delivered one carrying a claim. The last is tinted
                          // and marked, but it stays a tag — the amount lives
                          // behind it rather than beside it, so the column does
                          // not grow a second line and wrap.
                          const tag = (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                exTerm
                                  ? 'bg-slate-200 text-slate-700'
                                  : invDue > 0
                                    ? 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-300'
                                    : 'bg-sky-100 text-sky-800',
                                !exTerm && shortLines.length > 0 && 'underline decoration-dotted underline-offset-2'
                              )}
                            >
                              {exTerm ? 'Ex' : 'FOR'}
                              {invDue > 0 && <AlertTriangle className="h-2.5 w-2.5" />}
                            </span>
                          )
                          if (exTerm || !shortLines.length) {
                            return (
                              <span
                                title={
                                  exTerm
                                    ? 'Ex — the customer lifts, no freight of ours'
                                    : 'FOR — we deliver and pay the transporter'
                                }
                              >
                                {tag}
                              </span>
                            )
                          }
                          return (
                            <ShortageWorkings lines={shortLines}>
                              <span
                                title={
                                  invDue > 0
                                    ? `Short beyond the agreed tolerance — ${formatINR(invDue)} deductible. Hover or click for the workings.`
                                    : 'Delivered short but within tolerance — hover or click for the workings'
                                }
                              >
                                {tag}
                              </span>
                            </ShortageWorkings>
                          )
                        })()}
                      </TableCell>
                        </>
                      )}
                      <TableCell className="align-top" onClick={(e) => e.stopPropagation()}>
                        {/* A refused consignment has no next stage.
                            The stepper was still offered on one — In transit,
                            then Unloaded — so a load the customer had sent
                            back could be walked forward to "delivered", and
                            the register would then hold an invoice that was
                            both Rejected and Unloaded. Whatever stage it had
                            reached when it was refused is where it stops; the
                            way out is Restore, on the row menu, which is
                            deliberate rather than one tap away. */}
                        {inv.first.rejected_at ? (
                          <div className="flex items-center justify-end gap-2">
                            <Badge
                              variant="destructive"
                              className={cn('min-w-[76px] justify-center gap-1', __WEB__ && '!rounded-[3px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-2 !py-1 !text-[11px] !font-extrabold !text-[#B3261E]')}
                              title={String(inv.first.rejected_reason || 'Rejected by the customer')}
                            >
                              <Ban className="h-3 w-3" /> Rejected
                            </Badge>
                            {/* Where it had got to when it was refused — the
                                fact does not stop being true, it just stops
                                moving. */}
                            {!exTerm && stg.value !== 'pending' ? (
                              <span className="whitespace-nowrap text-[11px] font-semibold text-[#8FA79B]">
                                stopped at {stg.label.toLowerCase()}
                              </span>
                            ) : null}
                          </div>
                        ) : unloadOnly ? (
                          // One action, and only once the load has actually left:
                          // an invoice still Pending has not been dispatched, so
                          // there is nothing to receive against it yet.
                          <div className="flex items-center justify-end gap-2">
                            <Badge variant={stg.badge} className="min-w-[76px] justify-center">{stg.label}</Badge>
                            {stg.value === 'pending' ? (
                              <span className="text-[11px] text-muted-foreground">Not dispatched yet</span>
                            ) : (
                              <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openUnload(inv)}>
                                <Truck className="h-3.5 w-3.5" /> Record received
                              </Button>
                            )}
                          </div>
                        ) : exTerm ? (
                          <span className="flex h-7 items-center gap-1 text-xs font-medium text-emerald-600" title="Customer lifts — no dispatch tracking">
                            <Check className="h-3.5 w-3.5" /> Done
                          </span>
                        ) : (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={!prevStage}
                            onClick={() => prevStage && changeInvoiceStage(inv.group, prevStage.value)}
                            title={prevStage ? `Back to ${prevStage.label}` : 'At the first stage'}
                            className="flex h-7 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <Badge variant={stg.badge} className="min-w-[76px] justify-center">{stg.label}</Badge>
                          {nextStage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 gap-1 px-2 text-xs"
                              title={`Mark ${nextStage.label}`}
                              onClick={() =>
                                nextStage.value === 'unloaded'
                                  ? openUnload(inv)
                                  : void changeInvoiceStage(inv.group, nextStage.value)
                              }
                            >
                              {nextStage.label}<ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="flex items-center gap-0.5 pl-1 text-xs font-medium text-emerald-600" title="Delivered"><Check className="h-3.5 w-3.5" /> Done</span>
                          )}
                        </div>
                        )}
                        {untracked && !unloadOnly && <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-orange-600">Off-stock</div>}
                      </TableCell>
                      {!unloadOnly && (
                      <TableCell className="align-top text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          {__WEB__ && (
                            <button
                              type="button"
                              title="Open full invoice"
                              onClick={() => openDrawer(inv)}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] border border-[#D6E2D6] text-[#33473E] transition-colors hover:bg-[#EAF0E9]"
                            >
                              <Maximize2 className="h-4 w-4" />
                            </button>
                          )}
                          <RowActions
                            actions={[
                              ...(inv.first.rejected_at
                                ? [
                                    {
                                      label: 'Restore — back to the active list',
                                      icon: RotateCcw,
                                      onClick: () => void restoreInvoice(inv)
                                    }
                                  ]
                                : stg.value !== 'unloaded'
                                  ? [
                                      // Only a FOR delivery has a journey to
                                      // call off; an Ex sale leaves with the
                                      // customer at invoicing.
                                      ...(exTerm
                                        ? []
                                        : [
                                            {
                                              label: 'Cancel delivery — called off in transit',
                                              icon: Truck,
                                              onClick: () => openCancel(inv)
                                            }
                                          ]),
                                      {
                                        label: 'Reject — customer refused it',
                                        icon: Ban,
                                        onClick: () => { setRejectInv(inv); setRejectReason('') }
                                      }
                                    ]
                                  : []),
                              // Only on a delivered load that has actually left:
                              // there is nothing weighed in at the far end of an
                              // Ex sale, and nothing at all on one still pending.
                              ...(!exTerm && stg.value !== 'pending'
                                ? [
                                    {
                                      label:
                                        stg.value === 'unloaded'
                                          ? 'Received qty — correct what was weighed in'
                                          : 'Record received — mark it unloaded',
                                      icon: Truck,
                                      onClick: () => openUnload(inv)
                                    }
                                  ]
                                : []),
                              { label: 'Gate entries — what left the barrier', icon: DoorOpen, onClick: () => setGateInv(inv) },
                              { label: 'Edit invoice', icon: Pencil, onClick: () => openEditInvoice(inv) },
                              { label: 'History — who did what', icon: History, onClick: () => openHistory(inv) },
                              { label: 'Delete invoice', icon: Trash2, danger: true, onClick: () => delInvoice(inv) }
                            ]}
                          />
                        </div>
                      </TableCell>
                      )}
                    </TableRow>
                    {/* Website: the handoff's expanded panel — one full-width
                        row holding a line-items card and a side column, rather
                        than the desktop app's line-per-row breakdown (which
                        stays exactly as it was, below). */}
                    {__WEB__ && !unloadOnly && isOpen && (() => {
                      return (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={colCount} className="border-b border-[#E4ECE3] bg-[#F7FAF6] p-0">
                            <div className="flex flex-wrap gap-5 px-8 py-4">
                              <div className="min-w-[320px] flex-1">
                                <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]">
                                  Line items
                                </div>
                                <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                                  <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_100px_130px_150px] items-center bg-[#EAF0E9] text-[11px] font-extrabold uppercase tracking-[.08em] text-[#33473E]">
                                    <div className="px-3 py-2.5">Product</div>
                                    <div className="px-3 py-2.5">Bargain no</div>
                                    <div className="px-3 py-2.5 text-right">Qty</div>
                                    <div className="px-3 py-2.5 text-right">Rate</div>
                                    <div className="px-3 py-2.5 text-right">Amount</div>
                                  </div>
                                  {inv.lines.map((r) => (
                                    <div
                                      key={r.id as number}
                                      className={cn('grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_100px_130px_150px] items-center border-b border-[#EAF0E9] text-[13.5px] last:border-0')}
                                    >
                                      <div className="truncate px-3 py-2.5 font-bold" title={String(r.packaging_name || r.product_name || '')}>
                                        {String(r.packaging_name || r.product_name || '—')}
                                      </div>
                                      {/* Long enough to run past its column on
                                          most bargains, so it truncates and
                                          carries the whole thing on hover. */}
                                      <div
                                        className={cn('truncate px-3 py-2.5 font-semibold', !r.sales_bargain_no && 'text-[#A8B8AE]')}
                                        title={String(r.sales_bargain_no || '')}
                                      >
                                        {String(r.sales_bargain_no || '—')}
                                      </div>
                                      <div className="px-3 py-2.5 text-right tabular-nums">{formatNum(r.qty)}</div>
                                      <div className="px-3 py-2.5 text-right tabular-nums text-[#5A6B62]">{formatINR(r.rate)}</div>
                                      <div className="px-3 py-2.5 text-right font-bold tabular-nums">
                                        {formatINR(Number(r.amount) + Number(r.gst_amount || 0))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* All that is left of the side column: the
                                  bargain went into the table beside the line
                                  it belongs to, and the off-stock note only
                                  repeated the tag on the row above. */}
                              <div className="flex w-[300px] flex-none flex-col">
                                {/* An empty copy of the "Line items" caption,
                                    so the button starts level with the top of
                                    the table rather than with the caption above
                                    it — and stays level if the caption ever
                                    changes size. */}
                                <div
                                  aria-hidden
                                  className="mb-2 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-transparent"
                                >
                                  &nbsp;
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openDrawer(inv)
                                  }}
                                  className="flex h-[42px] items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13px] font-extrabold tracking-[.03em] text-[#C7F03F] transition-colors hover:bg-[#0f4f3b]"
                                >
                                  <Maximize2 className="h-[18px] w-[18px]" />
                                  OPEN FULL INVOICE
                                </button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })()}

                    {!__WEB__ && !unloadOnly && isOpen && inv.lines.map((r) => {
                      const inStock = stock[r.product_id as number]?.stock ?? 0
                      const sh = saleShortage(r, defaultShortagePct)
                      return (
                        <TableRow key={r.id as number} className="bg-muted/30">
                          <TableCell />
                          <TableCell className="align-top text-xs text-muted-foreground">{r.sales_bargain_no || 'No bargain'}</TableCell>
                          <TableCell className="align-top">
                            <div className="text-sm font-medium">{r.product_name}</div>
                            <div className="text-xs text-muted-foreground">{r.sale_type === 'PACKED' ? (r.packaging_name || 'Packed') : 'Loose'}</div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            <div>{formatNum(r.qty)} {r.uom}</div>
                            {r.received_qty != null ? (
                              // Just the weighbridge figures. The judgement on
                              // them — tolerance, excess, what it is worth —
                              // lives behind the FOR tag on the invoice row,
                              // because a numeric column is no place for a
                              // sentence and this one was wrapping four deep.
                              <div
                                className={cn(
                                  'whitespace-nowrap text-[11px]',
                                  sh.applies && !sh.within
                                    ? 'font-medium text-rose-600'
                                    : Number(r.qty) - Number(r.received_qty) > 0.0005
                                      ? 'text-rose-600'
                                      : 'text-emerald-700'
                                )}
                                title={
                                  sh.applies && sh.shortage > 0.0000005
                                    ? `Weighed in at the customer's end. ${
                                        sh.within
                                          ? 'Within the agreed tolerance.'
                                          : `${formatNum(sh.excessQty)} ${r.uom} beyond tolerance.`
                                      } See the FOR tag above for the workings.`
                                    : "Weighed in by the transporter at the customer's end"
                                }
                              >
                                rec {formatNum(r.received_qty)}
                                {Number(r.qty) - Number(r.received_qty) > 0.0005 && (
                                  <> · short {formatNum(Number(r.qty) - Number(r.received_qty))}</>
                                )}
                              </div>
                            ) : null}
                            <div className="text-[11px] text-muted-foreground" title="Finished stock in hand">stk {formatNum(inStock)}</div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums">
                            <div>{formatINR(Number(r.amount) + Number(r.gst_amount || 0))}</div>
                            <div className="text-[11px] text-muted-foreground">@ {formatINR(r.rate)}/{r.uom}</div>
                          </TableCell>
                          <TableCell className="align-top text-[11px] text-muted-foreground" colSpan={2}>
                            GST {formatNum(r.gst_pct)}% ({r.gst_type === 'IGST' ? 'IGST' : 'CGST+SGST'}) · {formatINR(r.gst_amount)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      {/* Only when there is more than one page — a pager under eleven invoices
          is a control that can do nothing. */}
      {!loading && invPageCount > 1 && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 border-t px-4 py-3',
            __WEB__ ? '!border-t-[#E4ECE3] !bg-[#F7FAF6]' : 'border-t-[#e5dfc8]'
          )}
        >
          <span className={cn('text-[12px] text-muted-foreground', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>
            Showing{' '}
            <b className={cn(__WEB__ && '!font-bold !text-[#0A1F17]')}>
              {(Math.min(invPage, invPageCount) - 1) * INV_PAGE + 1}–
              {Math.min(invPage * INV_PAGE, filteredInvoices.length)}
            </b>{' '}
            of <b className={cn(__WEB__ && '!font-bold !text-[#0A1F17]')}>{filteredInvoices.length}</b> invoices
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={invPage <= 1}
              onClick={() => setInvPage((v) => Math.max(1, v - 1))}
              title="Previous page"
              aria-label="Previous page"
              className={cn(__WEB__ && '!h-[34px] !w-[34px] !rounded-[4px] !border-[#C3D2C6] !bg-white !p-0 !text-[#0A1F17] hover:!bg-[#F7FAF6]')}
            >
              {__WEB__ ? <ChevronLeft className="h-[18px] w-[18px]" /> : 'Previous'}
            </Button>
            {/* Up to seven page buttons, always including the first, the last
                and the ones either side of where the reader is — a register of
                two hundred invoices must not put twenty buttons on the bar. */}
            {(() => {
              const cur = Math.min(invPage, invPageCount)
              const want = new Set([1, invPageCount, cur, cur - 1, cur + 1])
              const pages = [...want].filter((x) => x >= 1 && x <= invPageCount).sort((a, b) => a - b)
              const out: React.ReactNode[] = []
              pages.forEach((n, i) => {
                if (i > 0 && n - pages[i - 1] > 1) {
                  out.push(
                    <span key={`gap-${n}`} className="px-1 text-[12px] font-bold text-[#A8B8AE]">
                      …
                    </span>
                  )
                }
                out.push(
                  <button
                    key={n}
                    type="button"
                    onClick={() => setInvPage(n)}
                    className={cn(
                      'h-[34px] min-w-[34px] rounded-[4px] border px-2 text-[12.5px] font-bold tabular-nums transition-colors',
                      n === cur
                        ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                        : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                    )}
                  >
                    {n}
                  </button>
                )
              })
              return out
            })()}
            <Button
              size="sm"
              variant="outline"
              disabled={invPage >= invPageCount}
              onClick={() => setInvPage((v) => Math.min(invPageCount, v + 1))}
              title="Next page"
              aria-label="Next page"
              className={cn(__WEB__ && '!h-[34px] !w-[34px] !rounded-[4px] !border-[#C3D2C6] !bg-white !p-0 !text-[#0A1F17] hover:!bg-[#F7FAF6]')}
            >
              {__WEB__ ? <ChevronRight className="h-[18px] w-[18px]" /> : 'Next'}
            </Button>
          </div>
        </div>
      )}
      </>
      )}

      {formPage && (
      <div
        className={cn(
          'w-full',
          // Website: the "Sales Invoice Edit" handoff — a plain white sheet on
          // the forest/lime palette. The desktop app keeps its Tally-styled
          // cream form exactly as it was.
          __WEB__
            ? 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white'
            : 'rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg'
        )}
      >
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2',
            __WEB__ ? 'h-[52px] bg-[#0B3D2E] px-6 text-white' : 'rounded-t-md bg-[#dce6f5] text-[#1a2c56]'
          )}
        >
          <button
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline',
              __WEB__ && 'text-[13.5px] font-bold'
            )}
            onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}
          >
            <ArrowLeft className={cn('h-3.5 w-3.5', __WEB__ && 'h-5 w-5')} /> {onBack ? `Back to ${backLabel || 'previous page'}` : 'Back'}
          </button>
          <div className={cn('h-4 border-l', __WEB__ ? 'h-[22px] border-white/25' : 'border-[#1a2c56]/30')} />
          <h2 className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && 'text-[14px] font-extrabold tracking-[.1em]')}>
            {editingGroup ? 'Alter sales invoice' : 'Sales invoice'}
          </h2>
          <span className={cn('ml-auto text-[11px] font-medium', __WEB__ && 'text-[13px] font-medium text-[#8FBFA8]')}>
            {header.invoice_no ? `No ${header.invoice_no}` : 'No: not yet given'} · {formatDate(header.sale_date)}
          </span>
          {__WEB__ && dirty && (
            <span className="flex items-center gap-1.5 rounded-[3px] border border-[#C7F03F]/35 bg-[#C7F03F]/[.14] px-2.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[.05em] text-[#C7F03F]">
              <Pencil className="h-4 w-4" />
              Unsaved changes
            </span>
          )}
        </div>

        {/* Invoice header. The field sizing is set here on the container
            rather than on each control — the handoff's 48px fields and small-
            caps labels are a uniform rule, and applying it as one descendant
            selector keeps every field's own logic untouched. */}
        <div
          className={cn(
            __WEB__
              ? 'border-b border-[#D6E2D6] bg-white px-6 py-[18px] [&_input]:!h-12 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:bg-white [&_input]:text-[15px] [&_[data-slot=select-trigger]]:!h-12 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:bg-white [&_[data-slot=select-trigger]]:text-[14.5px] [&_[data-slot=select-trigger]]:font-bold [&_[data-slot=date-picker]]:!h-12 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:bg-white [&_[data-slot=date-picker]]:text-[15px]'
              : 'border-b border-dashed border-[#d9d2b8] px-4 py-3 [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white'
          )}
        >
          <div
            className={cn(
              'grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 [&>div]:min-w-0 [&>div]:gap-1',
              __WEB__
                ? 'gap-x-[18px] gap-y-3 [&_label]:text-[9.5px] [&_label]:font-extrabold [&_label]:uppercase [&_label]:tracking-[.13em] [&_label]:text-[#5A6B62]'
                : '[&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground'
            )}
          >
            <div className="flex flex-col gap-1.5">
              <Label>Date</Label>
              <DatePicker min={minDate} value={header.sale_date} onChange={(v) => setHeaderField('sale_date', v)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Invoice no</Label>
              {(() => {
                const prefix = String(series?.prefix || '')
                const current = String(header.invoice_no ?? '')
                if (!prefix) {
                  // No series to go on — a first invoice, or a company whose
                  // numbers have never followed one. Left free rather than
                  // inventing a prefix nobody asked for.
                  return (
                    <Input value={current} onChange={(e) => setHeaderField('invoice_no', e.target.value)} />
                  )
                }
                // What is stored is the whole reference; the field edits only
                // the number, so the prefix is a fact of the form rather than
                // something to be retyped correctly each time.
                const bare = current.replace(new RegExp(`^${prefix}[/\\-]?`, 'i'), '')
                // An invoice is identified by its GROUP, which is what editingGroup
                // holds. The old test compared header.id — a field the header never
                // carries — so it was NaN against every row and editing any invoice
                // warned that its own number was taken.
                const clash =
                  bare.trim() !== '' &&
                  rows.some(
                    (r) =>
                      String(r.invoice_no || '').trim().toUpperCase() === `${prefix}/${bare}`.toUpperCase() &&
                      String(r.invoice_group || `row:${r.id}`) !== String(editingGroup || '')
                  )
                return (
                  <>
                    {/* Hand-built composite, so it needs the form's height
                        given to it explicitly — the container rules size
                        inputs and selects, and this is neither. */}
                    <div
                      className={cn(
                        'flex h-9 items-stretch overflow-hidden rounded-md border bg-background',
                        __WEB__ && 'h-12 rounded-[4px] border-[#C3D2C6]',
                        clash && 'border-rose-400'
                      )}
                    >
                      <span
                        className={cn(
                          'doc-ref flex select-none items-center border-r bg-muted px-2.5 text-[13px] font-semibold text-muted-foreground',
                          __WEB__ && 'border-[#C3D2C6] bg-[#EAF0E9] px-3 text-[13.5px] font-bold text-[#33473E]'
                        )}
                      >
                        {prefix}/
                      </span>
                      <input
                        className={cn(
                          'doc-ref w-full bg-transparent px-2 text-[13px] tabular-nums outline-none',
                          // Not h-12 here: the wrapper owns the height and the
                          // input stretches to it, so forcing one would fight
                          // the container's own !h-12 rule and mis-centre the
                          // text — which is exactly what looked wrong.
                          __WEB__ && '!h-auto px-3 text-[15px] font-semibold'
                        )}
                        inputMode="numeric"
                        placeholder={String(series?.next ?? '')}
                        value={bare}
                        onChange={(e) => {
                          // Digits only. Everything the gap report could not
                          // account for — a stray stop, a party name typed in
                          // here — arrived through this field accepting it.
                          const digits = e.target.value.replace(/[^0-9]/g, '')
                          setHeaderField('invoice_no', digits ? `${prefix}/${digits}` : '')
                        }}
                      />
                      {!bare && Number(series?.next) > 0 && (
                        <button
                          type="button"
                          className="shrink-0 border-l px-2 text-[11px] font-medium text-sky-700 hover:bg-sky-50"
                          title={`Highest used is ${series?.highest}`}
                          onClick={() => setHeaderField('invoice_no', `${prefix}/${series?.next}`)}
                        >
                          next {String(series?.next)}
                        </button>
                      )}
                    </div>
                    {clash && (
                      <span className="text-[11px] font-medium text-rose-600">
                        {prefix}/{bare} is already used on another invoice
                      </span>
                    )}
                  </>
                )
              })()}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Customer</Label>
              <Select value={header.customer_id ? String(header.customer_id) : ''} onValueChange={chooseCustomer}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {invoiceCustomers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* No trading tick here: a trading sale is booked on the Trading
                page, which sets the flag itself on both sides of the deal. The
                header still CARRIES is_trading when an existing invoice is
                loaded (see openEditInvoice), so editing one cannot silently
                turn it into an ordinary sale. */}
            <div className="flex flex-col gap-1.5">
              <Label>Freight term</Label>
              <Select value={header.freight_term || 'FREIGHT_ON_GOODS'} onValueChange={(v) => setHeaderField('freight_term', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT_ON_GOODS">Ex — customer lifts</SelectItem>
                  <SelectItem value="DLD">FOR — we deliver</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Dispatch stage</Label>
              {isDld ? (
                <Select value={header.dispatch_stage || 'pending'} onValueChange={(v) => setHeaderField('dispatch_stage', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DISPATCH_STAGES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <div
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-emerald-50 px-2.5 text-[12px] font-medium text-emerald-700"
                  title="Ex sale — the goods leave with the customer, so the dispatch is complete on invoicing"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Done — customer lifts</span>
                </div>
              )}
            </div>
          </div>

          {isDld && (
            <div
              className={cn(
                'mt-4 grid grid-cols-2 gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 sm:grid-cols-3',
                // A subordinate panel, so it runs tighter than the invoice's
                // own header: four columns on a wide screen so it is one row
                // rather than three, 40px controls, and captions that don't
                // each claim a line of their own. Every control still shares
                // one height — the important flags are what make that hold
                // across a Select, an Input and a DatePicker.
                // The sky tint also goes: it predates the forest palette.
                __WEB__ &&
                  // items-start plus a fixed caption slot is what actually
                  // lines the row up: every cell is label / 36px control /
                  // caption at the same heights, so the controls share one
                  // baseline instead of each cell centring its own contents.
                  'mt-3 items-start gap-x-3 gap-y-2 rounded-[4px] border-[#DCE7DB] bg-[#F7FAF6] p-3 sm:grid-cols-2 lg:grid-cols-4 [&_input]:!h-9 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[13.5px] [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!text-[13.5px] [&>div]:!gap-1 [&_label]:!mb-0 [&_label]:!text-[11px] [&_label]:!font-semibold [&_label]:!leading-[14px] [&_label]:!text-[#33473E] [&_p]:!text-[#5A6B62]'
              )}
            >
              <div className="flex flex-col gap-1.5">
                <Label>Transporter *</Label>
                <Select value={header.transporter_id ? String(header.transporter_id) : ''} onValueChange={(v) => setHeaderField('transporter_id', v)}>
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{transporters.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                {/* Blank label and blank caption: this cell carries neither,
                    but it needs both slots so its control lands on the same
                    baseline as the fields beside it. */}
                <Label>&nbsp;</Label>
                <label
                  className={cn(
                    'flex h-9 items-center gap-2 rounded-md border border-sky-200 bg-white px-2.5 text-[12px] font-medium text-sky-900',
                    __WEB__ && '!h-9 rounded-[4px] border-[#C3D2C6] px-3 text-[12px] font-semibold text-[#33473E]'
                  )}
                >
                  <input
                    type="checkbox"
                    className={cn('h-4 w-4', __WEB__ && '!h-4 !w-4 shrink-0 accent-[#0B3D2E]')}
                    checked={!!header.deduct_freight}
                    onChange={(e) => setHeaderField('deduct_freight', e.target.checked)}
                  />
                  {__WEB__ ? 'Deduct freight' : 'Deduct freight from invoice total'}
                  {__WEB__ && (
                    <InfoTip
                      className="ml-auto"
                      text={
                        header.deduct_freight
                          ? 'Deducted: the freight comes OFF the invoice total (rate × cases, or rate × MT if loose) because the customer settles the transporter directly — so it is not booked as ours to pay and will not appear on Fr. Outward Working.'
                          : 'Not deducted: the invoice total is the goods alone. The freight is ours to carry, posted to the transporter ledger, and shows on Fr. Outward Working until their bill is booked.'
                      }
                    />
                  )}
                </label>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>
                  Freight rate / unit
                  {__WEB__ && <InfoTip className="ml-1 align-middle" text="Per case for a packed item, per MT for a loose one." />}
                </Label>
                <Input type="number" className="bg-white" value={header.transport_rate ?? ''} onChange={(e) => setHeaderField('transport_rate', e.target.value)} />
                {!__WEB__ && <span className="text-[10px] text-muted-foreground">per case for a packed item, per MT for a loose one</span>}
              </div>
              {/* The tolerance this delivery is judged by when it is weighed in
                  at the other end. Left blank it falls back to the sales
                  bargain, and then to the mill-wide default — so it only needs
                  answering when this particular customer was promised
                  something different. */}
              <div className="flex flex-col gap-1.5">
                <Label>
                  Shortage allowed %
                  {__WEB__ && (
                    <InfoTip
                      className="ml-1 align-middle"
                      text={
                        header.allowed_shortage_pct === '' || header.allowed_shortage_pct == null
                          ? bargainShortagePct != null
                            ? `Blank — using ${bargainShortagePct}% from the sales bargain. Anything short beyond the tolerance is deductible from the transporter.`
                            : `Blank — using the mill default of ${defaultShortagePct}%. Anything short beyond the tolerance is deductible from the transporter.`
                          : 'Anything short beyond this is deductible from the transporter.'
                      }
                    />
                  )}
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  className="bg-white"
                  placeholder={`default ${bargainShortagePct ?? defaultShortagePct}`}
                  value={header.allowed_shortage_pct ?? ''}
                  onChange={(e) => setHeaderField('allowed_shortage_pct', e.target.value)}
                />
                {!__WEB__ && (
                  <span className="text-[10px] text-muted-foreground">
                    {header.allowed_shortage_pct === '' || header.allowed_shortage_pct == null
                      ? bargainShortagePct != null
                        ? `Blank — using ${bargainShortagePct}% from the sales bargain`
                        : `Blank — using the mill default of ${defaultShortagePct}%`
                      : 'Anything short beyond this is deductible from the transporter'}
                  </span>
                )}
              </div>
              {/* What the checkbox does to the books. On the website this
                  moved into the ? beside the checkbox itself — as a paragraph
                  it was the tallest thing in a panel meant to be glanced at. */}
              {!__WEB__ && (
                <p className="col-span-full text-[11px] text-sky-800">
                  {header.deduct_freight
                    ? 'Deducted: the freight comes OFF the invoice total (rate × cases, or rate × MT if loose) because the customer settles the transporter directly — so it is not booked as ours to pay and will not appear on Fr. Outward Working.'
                    : 'Not deducted: the invoice total is the goods alone. The freight is ours to carry, posted to the transporter ledger, and shows on Fr. Outward Working until their bill is booked.'}
                </p>
              )}
            </div>
          )}

          {isDld && header.dispatch_stage && header.dispatch_stage !== 'pending' && (
            <div
              className={cn(
                'mt-4 grid grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-3',
                // Runs at the same tighter scale, and aligned the same way, as
                // the freight panel above.
                __WEB__ &&
                  'mt-3 items-start gap-x-3 gap-y-2 rounded-[4px] border-[#DCE7DB] bg-[#F7FAF6] p-3 sm:grid-cols-2 lg:grid-cols-4 [&_input]:!h-9 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[13.5px] [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!text-[13.5px] [&>div]:!gap-1 [&_label]:!mb-0 [&_label]:!text-[11px] [&_label]:!font-semibold [&_label]:!leading-[14px] [&_label]:!text-[#33473E] [&_p]:!text-[10.5px] [&_p]:!leading-snug [&_p]:!text-[#5A6B62]'
              )}
            >
              <div className="flex flex-col gap-1.5">
                <Label>Loaded date</Label>
                <DatePicker value={header.loaded_date ?? ''} onChange={(v) => setHeaderField('loaded_date', v)} />
              </div>
              {(header.dispatch_stage === 'transit' || header.dispatch_stage === 'unloaded') && (
                <div className="flex flex-col gap-1.5"><Label>In-transit date</Label><DatePicker value={header.transit_date ?? ''} onChange={(v) => setHeaderField('transit_date', v)} /></div>
              )}
              {header.dispatch_stage === 'unloaded' && (
                <div className="flex flex-col gap-1.5"><Label>Unloaded date</Label><DatePicker value={header.unloaded_date ?? ''} onChange={(v) => setHeaderField('unloaded_date', v)} /></div>
              )}
              <p className="text-[11px] text-muted-foreground sm:col-span-3">Blank stages are stamped with today&apos;s date. Dispatching draws finished stock (checked against availability).</p>
            </div>
          )}
        </div>

        {/* Line items */}
        <div className={cn('px-4 py-3', __WEB__ && 'px-6 py-[18px]')}>
          {__WEB__ ? (
            <div className="flex h-11 items-center justify-between rounded-t-[4px] bg-[#0B3D2E] px-4 text-white">
              <span className="text-[11.5px] font-extrabold uppercase tracking-[.14em]">Particulars</span>
              <span className="flex items-center gap-3.5">
                <span className="text-[12.5px] font-semibold text-[#8FBFA8]">
                  {items.length} item{items.length === 1 ? '' : 's'} · {totalQtyLabel}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const allOpen = items.every((_, i) => openItems[i] !== false)
                    const next: Record<number, boolean> = {}
                    items.forEach((_, i) => (next[i] = !allOpen))
                    setOpenItems(next)
                  }}
                  className="flex items-center gap-1.5 text-[11.5px] font-extrabold uppercase tracking-[.04em] text-[#C7F03F]"
                >
                  <ChevronDown className={cn('h-4 w-4 transition-transform', items.every((_, i) => openItems[i] !== false) && 'rotate-180')} />
                  {items.every((_, i) => openItems[i] !== false) ? 'Collapse all' : 'Expand all'}
                </button>
              </span>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-2 rounded bg-[#f1ecd9] px-3 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Particulars</span>
              <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {items.length} item{items.length === 1 ? '' : 's'} · {totalQtyLabel}
              </span>
            </div>
          )}
          <div className={cn('space-y-2', __WEB__ && 'space-y-3 pt-3')}>
          {items.map((item, i) => {
            const c = calc(item)
            const prodBargains = bargainsFor(item)
            // Selling against a bargain whose rate expired before this
            // invoice's date — the handoff marks the whole line for it.
            // notExpired (not rateExpired) is the right test: it judges the
            // rate against THIS invoice's date, which is what the warning
            // under the bargain field already says.
            const itemBargain = bargains.find((b) => String(b.id) === String(item.sales_bargain_id))
            const itemExpired = !!itemBargain && !notExpired(itemBargain)
            // A rate typed over the bargain's own card rate.
            const rateOverridden = cardRateFor(item) != null && !item.rate_from_card
            return (
              <div
                key={i}
                className={cn(
                  __WEB__
                    ? 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white [&_label]:text-[9.5px] [&_label]:font-extrabold [&_label]:uppercase [&_label]:tracking-[.13em] [&_label]:text-[#5A6B62] [&_input]:!h-10 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:bg-white [&_input]:text-[13.5px] [&_input]:font-semibold [&_[data-slot=select-trigger]]:!h-10 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:bg-white [&_[data-slot=select-trigger]]:text-[13px] [&_[data-slot=select-trigger]]:font-bold [&_[data-slot=date-picker]]:!h-10 [&_[data-slot=date-picker]]:!text-[13.5px] [&_[data-slot=date-picker]]:bg-white'
                    : 'rounded border border-[#e5dfc8] bg-white p-3 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground [&_input]:h-8 [&_input]:bg-white [&_input]:text-[13px] [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:bg-white [&_button[role=combobox]]:text-[12px] [&_[data-slot=date-picker]]:h-8 [&_[data-slot=date-picker]]:bg-white'
                )}
                // The left edge carries the line's state at a glance: amber
                // when it sells against a bargain whose rate has expired,
                // green otherwise.
                style={__WEB__ ? { borderLeft: `4px solid ${itemExpired ? '#C2700A' : '#12855A'}` } : undefined}
              >
                {__WEB__ ? (
                  <div
                    onClick={() => setOpenItems((p) => ({ ...p, [i]: p[i] === false }))}
                    className={cn(
                      'flex h-[52px] cursor-pointer items-center justify-between gap-4 px-4',
                      openItems[i] !== false ? 'border-b border-[#DCE7DB] bg-[#F7FAF6]' : 'bg-white'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <ChevronRight className={cn('h-5 w-5 shrink-0 text-[#8AA096] transition-transform', openItems[i] !== false && 'rotate-90')} />
                      <span className="shrink-0 text-[12px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">Item {i + 1}</span>
                      <span className="truncate text-[14px] font-bold">
                        {String(products.find((p) => String(p.id) === String(item.product_id))?.name || '—')}
                      </span>
                      <span className="shrink-0 rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[11px] font-extrabold tracking-[.05em] text-[#33473E]">
                        {String(item.sale_type) === 'PACKED' ? 'PACKED' : 'LOOSE'}
                      </span>
                      {itemExpired && (
                        <span className="flex shrink-0 items-center gap-1 rounded-[2px] bg-[#FFEDD0] px-2 py-1 text-[10.5px] font-extrabold tracking-[.05em] text-[#8A5300]">
                          <AlertTriangle className="h-3.5 w-3.5" /> EXPIRED RATE
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      {/* c.saleUom, not item.uom: a line being entered has no
                          unit stamped on it yet, so item.uom read MT for a
                          product sold in KG. */}
                      <span className="text-[11.5px] font-semibold text-[#7C9188]">{formatNum(c.effQty)} {c.saleUom}</span>
                      <span className="text-[15.5px] font-bold tracking-[-0.02em] tabular-nums">{formatINR(c.net)}</span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeItem(i)
                          }}
                          className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-[#B3261E]"
                        >
                          <Trash2 className="h-4 w-4" /> Remove
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mb-2 flex items-center justify-between border-b border-dotted border-[#e5dfc8] pb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">Item {i + 1}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{formatINR(c.net)}</span>
                      {items.length > 1 && (
                        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-destructive" onClick={() => removeItem(i)}>
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      )}
                    </span>
                  </div>
                )}
                {/* Body — hidden when this item is collapsed on the website. */}
                <div className={cn(__WEB__ && 'p-4', __WEB__ && openItems[i] === false && 'hidden')}>
                {/* Product / bargain / sale type. The website uses the
                    handoff's own column template; the desktop app keeps its
                    responsive one. */}
                <div
                  className={cn(
                    'grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:gap-1',
                    __WEB__ && 'gap-4 sm:grid-cols-2 lg:grid-cols-[340px_minmax(0,1fr)_300px]'
                  )}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label>Product *</Label>
                    <Select value={String(item.product_id)} onValueChange={(v) => setItem(i, { product_id: v, sales_bargain_id: '' })}>
                      <SelectTrigger><SelectValue placeholder="Finished product" /></SelectTrigger>
                      <SelectContent>{products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                    </Select>
                    {/* A fixed-height caption slot, empty here — Sales bargain's
                        expiry note is the only one of these three that ever has
                        text, so without this the row would tilt toward it. */}
                    <span className="block h-[15px]" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Sales bargain (optional)</Label>
                    <Select value={item.sales_bargain_id ? String(item.sales_bargain_id) : 'none'} onValueChange={(v) => selectItemBargain(i, v)} disabled={!item.product_id}>
                      {/* Amber rim when the chosen bargain's rate had already
                          expired by this invoice's date — the same signal the
                          card's left edge and its warning line carry. */}
                      <SelectTrigger className={cn(__WEB__ && itemExpired && '!border-[#E3C58C]')}>
                        {/* The list carries the detail; the closed field shows
                            the bargain number and a short balance, so it never
                            outgrows its box. */}
                        <SelectValue placeholder="No bargain">
                          {(() => {
                            const b = bargains.find((x) => String(x.id) === String(item.sales_bargain_id))
                            if (!b) return 'No bargain'
                            return (
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-medium normal-case">{b.bargain_no}</span>
                                <span className="shrink-0 text-[11px] normal-case text-muted-foreground">
                                  bal {formatNum(b.balance_qty)}
                                </span>
                                {!notExpired(b) && (
                                  <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-bold uppercase text-amber-800">
                                    expired
                                  </span>
                                )}
                              </span>
                            )
                          })()}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No bargain</SelectItem>
                        {prodBargains.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            <span className="font-medium">{b.bargain_no}</span>
                            <span className="text-muted-foreground"> · Bal {formatNum(b.balance_qty)} · {formatINR(b.rate)}</span>
                            {!notExpired(b) && (
                              <span className="font-medium text-amber-700"> · rate expired {formatDate(b.rate_expiry_date)}</span>
                            )}
                            {notExpired(b) && rateExpired(b) && (
                              <span className="text-emerald-700"> · valid on {formatDate(asOfDate)}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {__WEB__ ? (
                      <span className="flex min-h-[17px] items-center gap-1.5 text-[12.5px] font-semibold leading-[17px] text-[#8A5300]">
                        {itemExpired && itemBargain && (
                          <>
                            <AlertTriangle className="h-4 w-4 shrink-0 text-[#C2700A]" />
                            Rate expired {formatDate(itemBargain.rate_expiry_date)}, before this invoice&apos;s date (
                            {formatDate(asOfDate)}) — selling against it anyway
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="block min-h-[15px] text-[10px] font-medium leading-[15px] text-amber-700">
                        {(() => {
                          const chosen = bargains.find((b) => String(b.id) === String(item.sales_bargain_id))
                          return chosen && !notExpired(chosen)
                            ? `Rate expired ${formatDate(chosen.rate_expiry_date)}, before this invoice's date (${formatDate(asOfDate)}) — selling against it anyway`
                            : ''
                        })()}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Sale type</Label>
                    <Select value={item.sale_type || 'LOOSE'} onValueChange={(v) => setItem(i, { sale_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                        <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="block h-[15px]" />
                  </div>
                </div>

                {c.isPacked && (
                  <div className="mt-2 grid grid-cols-2 items-start gap-x-3 gap-y-2 rounded-md border border-violet-200 bg-violet-50/60 p-2.5 sm:grid-cols-3 [&>div]:min-w-0 [&>div]:gap-1">
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <Label>Packed SKU *</Label>
                      <Select value={item.packaging_id ? String(item.packaging_id) : ''} onValueChange={(v) => {
                        setItem(i, { packaging_id: v })
                        // Changing the SKU re-prices from the bargain's rate card.
                        const bid = String(items[i]?.sales_bargain_id || '')
                        if (bid) {
                          void loadCard(bid).then((card) => {
                            const hit = card[v]
                            if (!hit) return
                            const nc = calc({ ...items[i], packaging_id: v })
                            const rate = cardRateInUnit(hit, nc.saleUom, mtPerCase(nc))
                            if (rate != null) {
                              setItem(i, {
                                rate: String(rate),
                                rate_case: hit.rate_per_case != null ? String(hit.rate_per_case) : '',
                                rate_from_card: true
                              })
                            }
                          })
                        }
                      }}>
                        <SelectTrigger className="bg-white"><SelectValue placeholder="Select packaging" /></SelectTrigger>
                        <SelectContent>{packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
                      </Select>
                      {/* A fixed-height caption slot — present or not, every
                          column in this row reserves the same space below its
                          box, so the boxes above line up instead of drifting
                          up/down with however much hint text each one has. */}
                      <span className="block h-[15px] text-[11px] leading-[15px] text-muted-foreground">
                        {c.selPack &&
                          `1 ${c.selPack.box_label} = ${formatNum(c.selPack.pouches_per_box)} ${c.selPack.pouch_label} = ${formatNum(Number(c.selPack.pouches_per_box) * Number(c.selPack.base_per_pouch))} ${c.selPack.base_uom}`}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>{c.selPack?.box_label || 'Cases'}</Label>
                      <Input type="number" className="bg-white" value={item.boxes ?? ''} onChange={(e) => setItem(i, { boxes: e.target.value })} />
                      <span className="block h-[15px]" />
                    </div>
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 items-start gap-x-3 gap-y-2 sm:grid-cols-4 [&>div]:min-w-0 [&>div]:gap-1">
                  <div className="flex flex-col gap-1.5">
                    <Label>Qty ({c.saleUom})</Label>
                    {c.isPacked ? (
                      <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">{formatNum(c.effQty)}</div>
                    ) : (
                      <Input type="number" value={item.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value })} />
                    )}
                    {/* A fixed-height caption slot — present or not, every column
                        in this row reserves the same space below its box, so
                        the boxes above stay level instead of drifting up/down
                        with however much hint text each one has. */}
                    <span className="block h-[15px] text-[11px] leading-[15px] text-muted-foreground">
                      {c.isPacked && c.selPack && c.packBaseUom !== c.saleUom ? `= ${formatNum(c.packBaseQty)} ${c.packBaseUom}` : ''}
                    </span>
                  </div>
                  {/* Packed goods are quoted per case — that is the only rate
                      box a packed line needs. The per-MT figure it implies is
                      still computed and billed (see calc/cardRateInUnit), it is
                      just never shown: a second, read-only, unchangeable box
                      next to the one the user actually fills in had nothing to
                      offer but clutter. Loose sales have no case to price by,
                      so they get the per-unit rate box instead. */}
                  {c.isPacked ? (
                    <div className="flex flex-col gap-1.5">
                      <Label>Rate / {c.selPack?.box_label || 'case'}</Label>
                      <Input
                        type="number"
                        placeholder="0.00"
                        // Amber rim when the rate typed here departs from the
                        // bargain's own card rate — the note below says so too.
                        className={cn(__WEB__ && rateOverridden && '!border-[#E3C58C]')}
                        // Only what the card gave or the user typed. It used to
                        // fall back to rate/MT x MT-per-case, which is a DERIVED
                        // figure — and one that changed with the conversion
                        // factor, so the same saved line could read 1979.78 on
                        // one build and 1980.52 on another.
                        value={item.rate_case ?? ''}
                        onChange={(e) => {
                          const per = mtPerCase(c)
                          const v = e.target.value
                          setItem(i, {
                            rate_case: v,
                            // Six decimals, not two: the amount is qty(MT) x this
                            // rate, so a rate rounded to paise cannot reproduce
                            // cases x rate-per-case on a fractional case weight.
                            rate: per > 0 && v !== '' ? String(Math.round((Number(v) / per) * 1e6) / 1e6) : item.rate,
                            rate_from_card: false
                          })
                        }}
                      />
                      <span className="block min-h-[15px] text-[10px] leading-[15px]">
                        {(() => {
                          const card = cards[String(item.sales_bargain_id || '')]
                          const hit = card?.[String(item.packaging_id || '')]
                          const cardRate = cardRateFor(item)
                          if (cardRate != null) {
                            return (
                              <span className={cn(item.rate_from_card ? 'font-medium text-emerald-700' : 'text-amber-700')}>
                                {item.rate_from_card ? 'from the bargain rate card' : `card rate ${formatINR(hit?.rate_per_case ?? cardRate)} — overridden`}
                              </span>
                            )
                          }
                          // An older line carries no stated per-case rate, so the
                          // box is empty. Show what it was actually billed at so
                          // the figure is not simply missing — labelled as
                          // history, not offered as the agreed rate.
                          if (!item.rate_case && mtPerCase(c) > 0 && Number(item.rate) > 0) {
                            return (
                              <span className="text-muted-foreground">
                                billed at {formatINR(Math.round(Number(item.rate) * mtPerCase(c) * 100) / 100)}/
                                {c.selPack?.box_label || 'case'} — retype to restate it
                              </span>
                            )
                          }
                          // Say why nothing was filled: no card at all, or this
                          // SKU is not on it. Silence here is what looked like a bug.
                          if (item.sales_bargain_id && item.packaging_id) {
                            const hasCard = card && Object.keys(card).length > 0
                            return (
                              <span className="text-muted-foreground">
                                {hasCard
                                  ? 'this SKU is not priced on the bargain’s rate card'
                                  : 'no rate card on this bargain — add one from the Sales Bargain page'}
                              </span>
                            )
                          }
                          return mtPerCase(c) > 0 ? (
                            <span className="text-muted-foreground">
                              1 {c.selPack?.box_label || 'case'} = {formatNum(mtPerCase(c))} {c.saleUom}
                            </span>
                          ) : null
                        })()}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label>Rate /{c.saleUom}</Label>
                      <Input
                        type="number"
                        value={item.rate ?? ''}
                        onChange={(e) => setItem(i, { rate: e.target.value, rate_from_card: false })}
                      />
                      <span className="block h-[15px]" />
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={item.gst_pct ?? ''} onChange={(e) => setItem(i, { gst_pct: e.target.value })} />
                    <span className="block h-[15px]" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST type</Label>
                    <Select value={item.gst_type || 'CGST_SGST'} onValueChange={(v) => setItem(i, { gst_type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                        <SelectItem value="IGST">IGST</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="block h-[15px]" />
                  </div>
                </div>
                <div
                  className={cn(
                    'mt-2 text-right text-xs text-muted-foreground',
                    __WEB__ && 'mt-3.5 border-t border-[#EAF0E9] pt-3 text-[13px] font-medium text-[#5A6B62]'
                  )}
                >
                  Line: taxable {formatINR(c.amount)} ·{' '}
                  {String(item.gst_type || 'CGST_SGST') === 'IGST' ? (
                    <>IGST{c.gstPct ? ` @ ${c.gstPct}%` : ''} {formatINR(c.gstAmt)}</>
                  ) : (
                    <>
                      CGST{c.gstPct ? ` @ ${c.gstPct / 2}%` : ''} {formatINR(c.gstAmt / 2)} · SGST
                      {c.gstPct ? ` @ ${c.gstPct / 2}%` : ''} {formatINR(c.gstAmt / 2)}
                    </>
                  )}{' '}
                  · <span className={cn('font-semibold text-foreground', __WEB__ && 'text-[15.5px] font-bold tracking-[-0.02em]')}>{formatINR(c.net)}</span>
                </div>
                </div>
              </div>
            )
          })}
          </div>
          {__WEB__ ? (
            <button
              type="button"
              onClick={addItem}
              className="mt-4 flex h-12 items-center gap-2 rounded-[4px] border-[1.5px] border-dashed border-[#A8C0B2] bg-white px-[18px] text-[14px] font-extrabold tracking-[.02em] text-[#0B3D2E] transition-colors hover:bg-[#F7FAF6]"
            >
              <Plus className="h-5 w-5" /> Add item
            </button>
          ) : (
            <Button variant="outline" size="sm" className="mt-2 bg-white" onClick={addItem}><Plus className="h-4 w-4" /> Add item</Button>
          )}
        </div>

        {/* Invoice summary */}
        <div className={cn('ml-auto w-full max-w-md px-4 pb-4 text-sm', __WEB__ && 'max-w-[520px] px-6 pb-6')}>
          <div
            className={cn(
              'rounded border border-[#d9d2b8] bg-[#f7f2e2] p-3',
              __WEB__ &&
                // One rhythm down the whole card: every row the same 34px
                // regardless of whether it holds text or an input, and the
                // inputs kept at 32px so they can't inflate their own row —
                // which is what made Round off and TDS % sit taller than the
                // lines around them. Labels and figures get one weight each.
                cn(
                  'overflow-hidden rounded-[4px] border-[#D6E2D6] bg-white p-0 pb-1.5 [&>div]:!min-h-[34px] [&>div]:!items-center [&>div]:!py-0 [&>div]:px-[18px] [&>div:not(.tot-emph)>span:first-child]:!text-[13.5px] [&>div:not(.tot-emph)>span:first-child]:!font-semibold [&>div:not(.tot-emph)>span:first-child]:!text-[#33473E] [&>div:not(.tot-emph)>span:last-child]:!text-[14.5px] [&>div:not(.tot-emph)>span:last-child]:!font-semibold [&>div:not(.tot-emph)>span:last-child]:!text-[#0A1F17] [&_input]:!h-8 [&_input]:!w-[130px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:bg-white [&_input]:text-right [&_input]:!text-[14px]',
                  // Reads as a calculation rather than a flat list: the GST
                  // heads are indented and lightened as components, Total GST
                  // closes them off above a hairline, and Round off starts the
                  // next group. Without this every line looked equally
                  // important and the total appeared out of nowhere.
                  '[&>div.tot-sub>span:first-child]:!font-medium [&>div.tot-sub>span:first-child]:!text-[#7C9188] [&>div.tot-sub>span:last-child]:!font-medium [&>div.tot-sub>span:last-child]:!text-[#5A6B62] [&>div.tot-mid]:!mt-2 [&>div.tot-mid]:!border-t [&>div.tot-mid]:!border-[#EAF0E9] [&>div.tot-mid>span:first-child]:!font-bold [&>div.tot-mid>span:last-child]:!font-bold [&>div.tot-rule]:!mt-2 [&>div.tot-rule]:!border-t [&>div.tot-rule]:!border-[#EAF0E9]'
                )
            )}
          >
          <div className="flex items-center justify-between py-0.5"><span className="text-muted-foreground">Taxable value</span><span className="tabular-nums">{formatINR(totals.amount)}</span></div>
          {/* GST split by head, the way it must appear on the invoice: an
              intra-state line is half CGST and half SGST, inter-state is IGST.
              An invoice may legitimately mix the two, so both are summed. */}
          {(() => {
            let cgst = 0
            let igst = 0
            for (const it of items) {
              const g = calc(it).gstAmt
              if (String(it.gst_type || 'CGST_SGST') === 'IGST') igst += g
              else cgst += g / 2
            }
            const round2 = (v: number): number => Math.round(v * 100) / 100
            // The rate to name in brackets. Only when every line carries the
            // same one — an invoice may legitimately mix 5% and 12%, and a
            // single number against a mixed total would be a lie.
            const rates = new Set(items.map((it) => calc(it).gstPct).filter((p) => p > 0))
            const pct = rates.size === 1 ? [...rates][0] : null
            const half = pct == null ? null : Math.round((pct / 2) * 100) / 100
            const rate = (v: number | null): string => (v == null ? '' : ` (${v}%)`)
            return (
              <>
                {cgst > 0.004 && (
                  <>
                    <div className={cn("flex items-center justify-between py-0.5", __WEB__ && "tot-sub")}>
                      <span className="text-muted-foreground">CGST{rate(half)}</span>
                      <span className="tabular-nums">{formatINR(round2(cgst))}</span>
                    </div>
                    <div className={cn("flex items-center justify-between py-0.5", __WEB__ && "tot-sub")}>
                      <span className="text-muted-foreground">SGST{rate(half)}</span>
                      <span className="tabular-nums">{formatINR(round2(cgst))}</span>
                    </div>
                  </>
                )}
                {igst > 0.004 && (
                  <div className={cn("flex items-center justify-between py-0.5", __WEB__ && "tot-sub")}>
                    <span className="text-muted-foreground">IGST{rate(pct)}</span>
                    <span className="tabular-nums">{formatINR(round2(igst))}</span>
                  </div>
                )}
                <div className={cn("flex items-center justify-between py-0.5", __WEB__ && "tot-mid")}>
                  <span className="text-muted-foreground">Total GST{rate(pct)}</span>
                  <span className="tabular-nums">{formatINR(totals.gst)}</span>
                </div>
              </>
            )
          })()}
          <div className={cn('flex items-center justify-between py-0.5', __WEB__ && 'tot-rule')}>
            <span className="text-muted-foreground">
              Round off {header.round_off_manual ? '(manual)' : '(auto)'}
            </span>
            <span className="flex items-center gap-1.5">
              {header.round_off_manual ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  title="Go back to rounding the invoice total to the nearest rupee automatically"
                  onClick={() => setHeader((p) => ({ ...p, round_off_manual: false }))}
                >
                  Auto
                </Button>
              ) : null}
              <Input
                type="number"
                step="0.01"
                className="h-7 w-24 bg-white text-right"
                placeholder="0.00"
                value={header.round_off ?? ''}
                onChange={(e) =>
                  setHeader((p) => ({ ...p, round_off: e.target.value, round_off_manual: e.target.value !== '' }))
                }
              />
            </span>
          </div>
          {freightOnInvoice !== 0 && (
            <div className="flex items-center justify-between py-0.5">
              <span className="text-muted-foreground">
                Less freight
                <span className="ml-1 text-[10px] uppercase tracking-wide">(customer pays the transporter)</span>
              </span>
              <span className="tabular-nums text-rose-700">−{formatINR(Math.abs(freightOnInvoice))}</span>
            </div>
          )}
          <div
            className={cn(
              'mt-1 flex items-center justify-between border-t-2 border-[#1a2c56] pt-1.5 text-[15px] font-bold text-[#1a2c56]',
              // The handoff's lime band — the one figure the eye should land
              // on, spanning the full width of the card. tot-emph opts it out
              // of the card's uniform row type, which would otherwise flatten
              // its 22px figure to the same size as every other line.
              // Equal air above and below. It had mt-3 and nothing under it,
              // so the band hung off the round-off row and sat flush against
              // TDS — which is the lopsidedness that showed.
              __WEB__ && 'tot-emph !mx-0 !my-2 items-baseline border-0 bg-[#C7F03F] !px-[18px] !py-3.5 text-[#12280B]'
            )}
          >
            <span className={cn(__WEB__ && 'text-[11px] font-extrabold uppercase tracking-[.1em] text-[#2E4A0B]')}>Invoice total</span>
            <span className={cn('tabular-nums', __WEB__ && 'text-[22px] font-bold tracking-[-0.03em]')}>{formatINR(invoiceTotal)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5">
            <span className="text-muted-foreground">TDS %</span>
            <Input
              type="number"
              step="0.01"
              className="h-7 w-24 bg-white text-right"
              placeholder="0"
              title="Withheld by the customer on the invoice total. Filled in from the customer master; the slab on that master decides how much actually applies."
              value={header.tds_pct ?? ''}
              onChange={(e) => setHeaderField('tds_pct', e.target.value)}
            />
          </div>
          {Number(header.tds_pct) > 0 && (
            <>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-muted-foreground">
                  TDS{Number(header.tds_pct) > 0 ? ` (${Number(header.tds_pct)}%)` : ""}
                  {/* Naming the base on the line itself: it is the goods value,
                      not the invoice total, so the figure reconciles for anyone
                      checking it by hand. */}
                  {/* On the website this moves to a ? — as inline text it made
                      the TDS label twice as wide as every other one and pushed
                      the column out of line. */}
                  {__WEB__ ? (
                    <InfoTip
                      className="ml-1 align-middle"
                      text={
                        tds.belowSlab
                          ? `Under the ₹${formatNum(tds.threshold)} slab — nothing withheld.`
                          : `Withheld on the taxable value of ${formatINR(tdsBase)} — the goods, not the invoice total.`
                      }
                    />
                  ) : tds.belowSlab ? (
                    <span className="ml-1 text-[11px]">— under the ₹{formatNum(tds.threshold)} slab, nothing withheld</span>
                  ) : (
                    <span className="ml-1 text-[11px]">on taxable {formatINR(tdsBase)}</span>
                  )}
                </span>
                <span className="tabular-nums">{formatINR(tds.amount)}</span>
              </div>
              <div
                className={cn(
                  'flex items-center justify-between border-t pt-1 font-semibold text-[#1a2c56]',
                  __WEB__ && 'tot-emph mt-1.5 items-baseline border-t-2 border-[#0B3D2E] !pb-1.5 !pt-3 text-[#0A1F17]'
                )}
              >
                <span className={cn(__WEB__ && 'text-[15px] font-extrabold')}>Net receivable</span>
                <span className={cn('tabular-nums', __WEB__ && 'text-[19px] font-bold tracking-[-0.02em]')}>
                  {formatINR(invoiceTotal - tds.amount)}
                </span>
              </div>
            </>
          )}
          </div>
        </div>

        <Dialog open={!!excess} onOpenChange={(o) => !o && setExcess(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="text-amber-900">More than the bargain has left</DialogTitle>
            </DialogHeader>
            {excess && (() => {
              const it = items[excess.idx] || {}
              const cur = bargains.find((x) => String(x.id) === String(it.sales_bargain_id))
              // Other open bargains of the same customer + product that can take it.
              const nextBargains = bargains.filter(
                (b) =>
                  String(b.id) !== String(it.sales_bargain_id) &&
                  String(b.product_id) === String(it.product_id) &&
                  matchesCustomer(b) &&
                  notExpired(b) &&
                  bargainRoom(String(b.id), -1, items) >= excess.qty - 1e-6
              )
              return (
                <div className="space-y-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  <p>
                    Item {excess.idx + 1} sells <b>{formatNum(calc(it).effQty)} {excess.uom}</b> but{' '}
                    <b>{cur?.bargain_no || 'this bargain'}</b> has only{' '}
                    <b>{formatNum(excess.balance)} {excess.uom}</b> left. Choose where the extra{' '}
                    <b>{formatNum(excess.qty)} {excess.uom}</b> should go:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'new' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'new' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Book as a new bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'existing' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'existing' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Use the next available bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'expand' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'expand' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Add to this bargain
                    </button>
                  </div>

                  {excess.mode === 'expand' ? (
                    <p className="text-[11px]">
                      {cur?.bargain_no || 'This bargain'} will be increased by{' '}
                      <b>{formatNum(excess.qty)} {excess.uom}</b> (at its own rate) so the whole item stays on it. The
                      top-up is logged as an Addition on the bargain register.
                    </p>
                  ) : excess.mode === 'new' ? (
                    <>
                      <p className="text-[11px]">
                        The item is split in two: <b>{formatNum(excess.balance)} {excess.uom}</b> stays on{' '}
                        {cur?.bargain_no || 'this bargain'} and a new bargain is created for{' '}
                        {String(header.customer || 'the customer')} carrying the extra{' '}
                        <b>{formatNum(excess.qty)} {excess.uom}</b>.
                      </p>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={excess.diffRate}
                          onCheckedChange={(v) => setExcess((p) => (p ? { ...p, diffRate: v } : p))}
                        />
                        <span>A different rate applies to the extra quantity</span>
                      </div>
                      {excess.diffRate && (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-amber-900">Rate for the extra qty (per {excess.uom})</Label>
                          <Input
                            type="number"
                            className="bg-white"
                            value={excess.rate}
                            onChange={(e) => setExcess((p) => (p ? { ...p, rate: e.target.value } : p))}
                          />
                          <p className="text-[11px]">The new line is invoiced at this rate.</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-amber-900">Next bargain for the extra qty</Label>
                      {nextBargains.length === 0 ? (
                        <p className="text-[11px]">
                          No other open bargain for {String(header.customer || 'this customer')} has{' '}
                          {formatNum(excess.qty)} {excess.uom} free — book it as a new bargain, or add it to this one.
                        </p>
                      ) : (
                        <>
                          <Select
                            value={excess.targetBargainId}
                            onValueChange={(v) => setExcess((p) => (p ? { ...p, targetBargainId: v } : p))}
                          >
                            <SelectTrigger className="bg-white"><SelectValue placeholder="Select bargain" /></SelectTrigger>
                            <SelectContent>
                              {nextBargains
                                .slice()
                                .sort((a, b) => String(a.bargain_date || '').localeCompare(String(b.bargain_date || '')))
                                .map((b) => (
                                  <SelectItem key={b.id} value={String(b.id)}>
                                    {b.bargain_no} · BAL {formatNum(bargainRoom(String(b.id), -1, items))} · {formatINR(b.rate)}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[11px]">
                            The item is split in two and the extra line keeps the rate you typed — the chosen bargain&apos;s
                            own rate is not applied, so change it on the line if it should differ.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            <DialogFooter>
              <Button variant="outline" onClick={() => setExcess(null)} disabled={excessBusy}>Cancel</Button>
              <Button onClick={() => void resolveExcess()} disabled={excessBusy}>
                {excessBusy
                  ? 'Saving…'
                  : excess?.mode === 'expand'
                    ? 'Top up & save'
                    : excess?.mode === 'existing'
                      ? 'Allocate & save'
                      : 'Add bargain & save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div
          className={cn(
            'flex items-center justify-end gap-2 border-t px-4 py-2.5',
            __WEB__ ? 'border-[#D6E2D6] bg-white px-6 py-3.5' : 'rounded-b-md border-[#d9d2b8] bg-[#f1ecd9]'
          )}
        >
          {__WEB__ ? (
            <span className="mr-auto flex items-center gap-2 text-[12.5px] font-semibold text-[#5A6B62]">
              <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-1 text-[11.5px] font-bold text-[#33473E]">Ctrl+A</span>
              accepts, like Tally — or use the button.
            </span>
          ) : (
            <span className="mr-auto text-[11px] text-muted-foreground">
              Ctrl+A accepts, like Tally — or use the button.
            </span>
          )}
          <Button
            variant="outline"
            className={cn('bg-white', __WEB__ && 'h-12 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-6 text-[14px] font-extrabold tracking-[.03em] text-[#33473E]')}
            onClick={() => (onBack ? onBack() : setFormPage(false))}
            disabled={saving}
          >
            {__WEB__ ? 'CANCEL' : 'Cancel'}
          </Button>
          <Button
            className={cn(
              'bg-[#1a2c56] hover:bg-[#24407e]',
              __WEB__ && 'h-12 rounded-[4px] bg-[#0B3D2E] px-7 text-[14px] font-extrabold tracking-[.03em] text-[#C7F03F] hover:bg-[#0f4f3b]'
            )}
            onClick={() => void save()}
            disabled={saving}
          >
            {__WEB__ && !saving && <Check className="h-5 w-5" />}
            {saving ? 'Saving…' : editingGroup ? (__WEB__ ? 'SAVE CHANGES' : 'Save changes') : (__WEB__ ? 'ACCEPT INVOICE' : 'Accept invoice')}
          </Button>
        </div>
      </div>
      )}

      <HistoryDialog target={hist.target} onClose={hist.close} />

      {/* Reject — the customer refused the consignment before it was fully delivered */}
      {/* Marking Unloaded: capture what the transporter actually delivered. */}
      <Dialog open={gapsOpen} onOpenChange={setGapsOpen}>
        <DialogContent
          // Capped to the window and scrolled INSIDE, because this list is as
          // long as the books are wrong — 38 numbers across two series here.
          // Uncapped, the panel grew taller than the screen; being centred, it
          // overflowed equally off the top and the bottom, which carried the
          // ✕ (pinned to the panel's own top corner) clean off the display.
          // There was nothing to scroll either: the panel WAS the overflow.
          //
          // dvh, not vh, so a phone's address bar shrinking the viewport
          // doesn't leave the last row under it.
          className="flex max-h-[88dvh] w-[min(96vw,46rem)] max-w-none flex-col gap-0 p-0"
          // Escape and click-outside close this one. The shared dialog refuses
          // both to stop a half-filled form being thrown away by accident —
          // sound for a form, wrong for a report, where there is nothing to
          // lose and every instinct for getting out of a window is disabled.
          onEscapeKeyDown={() => {}}
          onInteractOutside={() => {}}
        >
          {/* Fixed head. pr-14 keeps the title clear of the ✕ sitting in the
              corner, which the old padding had it running under. */}
          <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14">
            <DialogTitle>Missing invoice numbers</DialogTitle>
            <p className="text-[11.5px] leading-snug text-muted-foreground">
              Numbers with no invoice against them, counted from the lowest to the highest you have actually used.
              {(dateFrom || dateTo) && ' Limited to the dates set on the register.'}
            </p>
          </DialogHeader>

          {/* min-h-0 is what makes the scroll work: without it a flex child
              refuses to shrink below its content and the cap does nothing. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {gapsBusy && <div className="py-8 text-center text-muted-foreground">Checking…</div>}

            {!gapsBusy &&
              ((gaps?.series as Row[]) || []).map((sr) => (
                <div key={String(sr.prefix)} className="overflow-hidden rounded-lg border">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/40 px-3.5 py-2.5">
                    <span className="doc-ref text-[13.5px] font-bold">{String(sr.prefix)}</span>
                    <span className="text-[11.5px] tabular-nums text-muted-foreground">
                      {String(sr.used)} used · {String(sr.from)}–{String(sr.to)}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {Number(sr.cancelled_count) > 0 && (
                        <span className="rounded px-2 py-0.5 text-[11.5px] font-semibold tabular-nums text-amber-900 bg-amber-100">
                          {String(sr.cancelled_count)} cancelled
                        </span>
                      )}
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 text-[11.5px] font-semibold tabular-nums',
                          Number(sr.missing_count) ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                        )}
                      >
                        {Number(sr.missing_count) ? `${sr.missing_count} missing` : 'none missing'}
                      </span>
                    </span>
                  </div>

                  {Number(sr.missing_count) > 0 && (
                    <>
                      {/* One row per NUMBER.
                          
                          These get read out, ticked off against a bill book and
                          copied into a note to the auditor, and every one of
                          those jobs works down a list one number at a time. A
                          collapsed range reads well but has to be expanded by
                          hand before it can be used.
                          
                          With one number per row the count column is always 1,
                          so it is gone — and so is the wording that used to
                          explain the grouping. */}
                      <table className="w-full text-[12px]">
                        <thead className="bg-muted/60 text-[10px] uppercase tracking-widest text-muted-foreground">
                          <tr>
                            <th className="w-10 px-3 py-2 text-right font-semibold">Sl.</th>
                            <th className="px-3 py-2 text-left font-semibold">Invoice no</th>
                            <th className="w-[230px] px-3 py-2 text-right font-semibold">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((sr.missing as number[]) || [])
                            .slice()
                            .sort((a, b) => a - b)
                            .map((num, i) => (
                              <tr key={num} className="border-t transition-colors hover:bg-muted/30">
                                <td className="px-3 py-1.5 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}</td>
                                <td className="doc-ref px-3 py-1.5 font-semibold tabular-nums text-rose-800">
                                  {String(sr.prefix)}/{num}
                                </td>
                                {/* The two things anybody does about a gap: book
                                    the bill that belongs to it, or record that the
                                    number was voided. Both stay on one line —
                                    wrapped labels made the list twice as tall
                                    and much harder to read down. */}
                                <td className="px-3 py-1.5">
                                  <div className="flex justify-end gap-1.5">
                                    <button
                                      type="button"
                                      className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-[11px] font-semibold text-emerald-800 transition-colors hover:bg-emerald-100"
                                      title={`Open a new invoice numbered ${sr.prefix}/${num}`}
                                      onClick={() => bookGap(String(sr.prefix), num)}
                                    >
                                      <Plus className="h-3.5 w-3.5 shrink-0" />
                                      Book
                                    </button>
                                    <button
                                      type="button"
                                      className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-200 bg-amber-50 px-2.5 text-[11px] font-semibold text-amber-900 transition-colors hover:bg-amber-100"
                                      title={`Record ${sr.prefix}/${num} as cancelled, so it stops reading as missing`}
                                      onClick={() => {
                                        setVoidTarget({ prefix: String(sr.prefix), number: num })
                                        setVoidReason('')
                                      }}
                                    >
                                      <Ban className="h-3.5 w-3.5 shrink-0" />
                                      Cancelled
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  {/* Voided numbers, kept in view. Leaving them out entirely
                      would answer the auditor's question by hiding it. */}
                  {((sr.cancelled as Row[]) || []).length > 0 && (
                    <div className="border-t bg-muted/30 px-3 py-2">
                      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        Cancelled — accounted for, not missing
                      </div>
                      <div className="space-y-1">
                        {((sr.cancelled as Row[]) || []).map((cv) => (
                          <div key={String(cv.number)} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                            <span className="doc-ref font-medium tabular-nums line-through decoration-muted-foreground/50">
                              {String(sr.prefix)}/{String(cv.number)}
                            </span>
                            <span className="text-muted-foreground">{String(cv.reason || 'no reason recorded')}</span>
                            {cv.cancelled_on && (
                              <span className="text-muted-foreground/70">· {formatDate(String(cv.cancelled_on))}</span>
                            )}
                            <button
                              type="button"
                              className="text-[11px] font-medium text-sky-700 hover:underline"
                              onClick={() => void undoVoid(String(sr.prefix), Number(cv.number))}
                            >
                              Undo
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* A number keyed under a misspelt prefix is a typo, not a
                      lost bill. It would otherwise read as missing from one
                      series and invisible in another. */}
                  {((sr.strays as Row[]) || []).length > 0 && (
                    <div className="border-t bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900">
                      <b>Not missing</b> — these were keyed with the prefix spelt differently:{' '}
                      {((sr.strays as Row[]) || []).map((x) => String(x.as)).join(', ')}. Worth correcting the invoice
                      number itself.
                    </div>
                  )}
                </div>
              ))}

            {!gapsBusy && ((gaps?.unparsed as string[]) || []).length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900">
                <b>No number in these invoice fields</b>, so they count towards no series:{' '}
                {((gaps?.unparsed as string[]) || []).join(' · ')}
              </div>
            )}

            {!gapsBusy && !((gaps?.series as Row[]) || []).length && (
              <div className="py-8 text-center text-muted-foreground">No numbered invoices in this range.</div>
            )}
          </div>

          {/* A named way out, not only the ✕. The corner glyph is faint, and on
              a panel that had overflowed the screen it was not there at all —
              so a button that says what it does earns its row. */}
          <DialogFooter className="shrink-0 border-t px-5 py-3">
            <Button variant="outline" onClick={() => setGapsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Voiding a number asks why, because that reason is the whole value of the
          record: "spoiled in the printer" closes the question, a blank does not.
          Kept as its own small dialog rather than a prompt, so the number being
          voided is visible while the reason is typed. */}
      <Dialog open={!!voidTarget} onOpenChange={(o) => !o && !voidBusy && setVoidTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Cancel {voidTarget ? `${voidTarget.prefix}/${voidTarget.number}` : 'invoice number'}
            </DialogTitle>
          </DialogHeader>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            This records the number as deliberately voided — a spoiled form, a bill cancelled before
            it went out. It stops reading as missing and starts reading as accounted for. Nothing is
            posted: no stock moves and no ledger entry is made, because no invoice ever existed.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason</Label>
            <Input
              autoFocus
              placeholder="e.g. spoiled in the printer"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && voidReason.trim()) void confirmVoid()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidTarget(null)} disabled={voidBusy}>
              Keep it
            </Button>
            <Button onClick={confirmVoid} disabled={voidBusy || !voidReason.trim()}>
              {voidBusy ? 'Recording…' : 'Record as cancelled'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelInv} onOpenChange={(o) => !o && !cancelling && setCancelInv(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cancel delivery {cancelInv?.first.invoice_no || ''}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            The customer called this load off before it was unloaded, so there is no received quantity to record and
            the invoice is marked <b>Cancelled</b> rather than delivered. The transporter still carried it, so the
            freight is charged on the quantity below — the dispatched figure, which you can change if only part of the
            load actually travelled. Stock, the journal and the credit note are untouched, exactly as with a rejection.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Reason</Label>
            <Input
              autoFocus
              placeholder="e.g. customer cancelled the order while in transit"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_84px_96px] items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Product</span>
              <span className="text-right">Dispatched</span>
              <span className="text-right">Freight on</span>
            </div>
            {(cancelInv?.lines || []).map((l) => (
              <div key={String(l.id)} className="grid grid-cols-[minmax(0,1fr)_84px_96px] items-center gap-2 border-b px-3 py-1.5 last:border-0">
                <span className="min-w-0 truncate text-[13px]">{l.product_name}</span>
                <span className="text-right text-[12px] tabular-nums text-muted-foreground">{formatNum(l.qty)}</span>
                <Input
                  type="number"
                  className="h-8 text-right tabular-nums"
                  value={cancelQty[String(l.id)] ?? ''}
                  onChange={(e) => setCancelQty((p) => ({ ...p, [String(l.id)]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Freight will be billed on <b>{formatNum(cancelFreightQty)} {cancelInv?.first.uom || 'MT'}</b> in total.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelInv(null)} disabled={cancelling}>Keep the delivery</Button>
            <Button variant="destructive" onClick={() => void confirmCancel()} disabled={cancelling || !cancelReason.trim()}>
              {cancelling ? 'Cancelling…' : 'Cancel delivery'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!unloadInv} onOpenChange={(o) => !o && !unloadSaving && setUnloadInv(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {String(unloadInv?.first.dispatch_stage) === 'unloaded' ? 'Received qty — ' : 'Unload '}
              {unloadInv?.first.invoice_no || 'this invoice'}
            </DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            Enter the quantity the transporter actually delivered. It is recorded against the invoice, shown in its details,
            feeds the dispatch register, and prices the freight — so every line has to be filled in.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Unloaded date</Label>
            <div className="w-44"><DatePicker value={unloadDate} onChange={(v) => setUnloadDate(v || todayISO())} /></div>
          </div>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_78px_92px_72px_72px] items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Product</span>
              <span className="text-right">Dispatched</span>
              <span className="text-right">Received</span>
              <span className="text-right">Shortage</span>
              <span className="text-right">Allowed</span>
            </div>
            {(unloadInv?.lines || []).map((l) => {
              const raw = unloadQty[String(l.id)]
              const short = raw === '' || raw == null ? null : Number(l.qty) - Number(raw)
              // Judged as it is typed, so the desk knows at the keyboard whether
              // the delivery it is recording is a normal one or one somebody
              // will have to make a claim about. Quantities only — this desk is
              // shown no rates and no values, and that does not change here.
              const sh = saleShortage({ ...l, received_qty: raw === '' || raw == null ? null : Number(raw) }, defaultShortagePct)
              return (
                <div key={String(l.id)} className="grid grid-cols-[minmax(0,1fr)_78px_92px_72px_72px] items-center gap-2 border-b px-3 py-1.5 last:border-0">
                  <span className="min-w-0 truncate text-[13px]">{l.product_name}</span>
                  <span className="text-right text-[12px] tabular-nums text-muted-foreground">{formatNum(l.qty)}</span>
                  <Input
                    type="number"
                    className={cn('h-8 text-right tabular-nums', (raw ?? '') === '' && 'border-rose-400')}
                    placeholder="Required"
                    value={raw ?? ''}
                    onChange={(e) => setUnloadQty((p) => ({ ...p, [String(l.id)]: e.target.value }))}
                  />
                  <span
                    className={cn(
                      'text-right text-[12px] tabular-nums',
                      short != null && short > 0.0005 ? 'text-rose-600' : 'text-muted-foreground'
                    )}
                  >
                    {short == null ? '—' : formatNum(short)}
                  </span>
                  <span
                    className="text-right text-[11px] tabular-nums"
                    title={`${sh.pct}% of ${formatNum(l.qty)} — ${BASIS_LABEL[sh.basis]}`}
                  >
                    {!sh.applies || short == null ? (
                      <span className="text-muted-foreground">{formatNum(sh.allowedQty)}</span>
                    ) : sh.within ? (
                      <span className="font-medium text-emerald-700">within</span>
                    ) : (
                      <span className="font-semibold text-rose-700">+{formatNum(sh.excessQty)}</span>
                    )}
                  </span>
                </div>
              )
            })}
            <div className="border-t bg-muted/40 px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
              <span className="font-medium">Allowed</span> is the transit loss agreed for this delivery. A figure inside it
              reads <span className="font-medium text-emerald-700">within</span>; beyond it, the excess is shown and becomes
              deductible.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnloadInv(null)} disabled={unloadSaving}>Cancel</Button>
            <Button
              onClick={() => void confirmUnload()}
              disabled={unloadSaving || (unloadInv?.lines || []).some((l) => (unloadQty[String(l.id)] ?? '') === '')}
              title={
                (unloadInv?.lines || []).some((l) => (unloadQty[String(l.id)] ?? '') === '')
                  ? 'Fill in the received qty on every line first'
                  : undefined
              }
            >
              {unloadSaving ? 'Saving…' : 'Mark unloaded'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GateEntriesDialog
        open={!!gateInv}
        onClose={() => setGateInv(null)}
        heading={`Invoice ${String(gateInv?.first?.invoice_no || '')}`}
        subheading={String(gateInv?.first?.customer_name || gateInv?.first?.customer || '') || undefined}
        query={{
          saleIds: (gateInv?.lines || []).map((l) => Number(l.id)).filter((x) => x > 0),
          invoiceGroup: String(gateInv?.first?.invoice_group || '') || undefined
        }}
      />

      <Dialog open={!!rejectInv} onOpenChange={(o) => !o && !rejecting && setRejectInv(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject {rejectInv?.first.invoice_no || 'this invoice'}</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground">
            Marks this invoice Rejected — it drops out of the Gate Out picker and the "Produce more" demand calc but
            stays on record. This does not touch stock or the journal; if it needs correcting (e.g. a Credit Note),
            do that separately.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Reason <span className="text-red-600">*</span></Label>
            <textarea
              className="min-h-[5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="e.g. Customer refused the consignment — diverted to another party"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectInv(null)} disabled={rejecting}>Cancel</Button>
            <Button className="bg-rose-600 hover:bg-rose-700" onClick={() => void saveReject()} disabled={rejecting}>
              {rejecting ? 'Saving…' : 'Reject invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-invoice drawer — the design handoff's right-side panel. Website
          only; read-only, so nothing in here can change the invoice. */}
      {__WEB__ && drawer && (
        <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(10,31,23,.42)]" onClick={() => setDrawer(null)}>
          <div
            className="flex h-full w-[560px] max-w-full flex-col bg-[#F1F5EF] shadow-[-16px_0_40px_rgba(10,31,23,.22)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-none bg-[#0B3D2E] px-6 py-4 text-white">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2.5">
                    <div className="text-2xl font-bold tracking-[-0.02em]">{String(drawer.first.invoice_no || '—')}</div>
                    <span className="inline-flex items-center gap-1 rounded-[3px] bg-[#C7F03F] px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-[.05em] text-[#12280B]">
                      <Truck className="h-3.5 w-3.5" />
                      {stageInfo(drawer.first).label}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[13.5px] font-semibold text-[#8FBFA8]">
                    {formatDate(drawer.first.sale_date)} · {String(drawer.first.customer || '—')}
                  </div>
                </div>
                <button
                  onClick={() => setDrawer(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] bg-white/10 hover:bg-white/20"
                  title="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-3 gap-2.5">
                {[
                  { k: 'Qty', v: formatNum(drawer.qty) },
                  { k: 'Freight', v: String(drawer.first.freight_term || 'FREIGHT_ON_GOODS') !== 'DLD' ? 'EX' : 'DLD' },
                  { k: 'Items', v: `${drawer.lines.length} item${drawer.lines.length > 1 ? 's' : ''}` }
                ].map((st) => (
                  <div key={st.k} className="rounded-[4px] border border-[#D6E2D6] bg-white p-3">
                    <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7C9188]">{st.k}</div>
                    <div className="mt-1 text-[19px] font-bold">{st.v}</div>
                  </div>
                ))}
              </div>

              <div className="mb-2 mt-5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]">Line items</div>
              <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                {drawer.lines.map((l, i) => (
                  <div key={i} className="flex justify-between gap-3 border-b border-[#EAF0E9] p-3 last:border-0">
                    <div className="min-w-0">
                      {/* A packed line is sold as its SKU, not as the bulk oil
                          behind it — name it that way when there is one. */}
                      <div className="text-[13.5px] font-bold">{String(l.packaging_name || l.product_name || '—')}</div>
                      <div className="mt-0.5 text-[11.5px] text-[#5A6B62]">
                        {formatNum(l.qty)} × {formatINR(l.rate)}
                      </div>
                    </div>
                    <div className="flex-none text-[14px] font-bold">
                      {formatINR(Number(l.amount) || Number(l.qty) * Number(l.rate))}
                    </div>
                  </div>
                ))}
                <div className="flex items-baseline justify-between bg-[#C7F03F] px-3 py-3.5">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.08em] text-[#2E4A0B]">Invoice total</span>
                  <span className="text-[19px] font-bold tracking-[-0.02em] text-[#12280B]">{formatINR(drawer.net)}</span>
                </div>
              </div>

              {/* Where the dispatch has got to, above the audit trail. The
                  trail records the gate movements as they happen; this says
                  the three dates in the order they occur, so "when did it
                  leave and when did it land" needs no reading of events. A
                  stage with no date yet is shown greyed rather than hidden —
                  the gap IS the answer to where it has got to. */}
              {(() => {
                const f = drawer.first
                const stage = String(f.dispatch_stage || (f.status === 'done' ? 'unloaded' : 'pending'))
                const rank = { pending: 0, loaded: 1, transit: 2, unloaded: 3 }[stage] ?? 0
                const steps = [
                  { key: 'Loaded', date: f.loaded_date, at: 1 },
                  { key: 'In transit', date: f.transit_date, at: 2 },
                  { key: 'Unloaded', date: f.unloaded_date, at: 3 }
                ]
                if (rank === 0 && !steps.some((x) => x.date)) return null
                return (
                  <>
                    <div className="mb-2 mt-5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]">
                      Dispatch
                    </div>
                    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-[#E4ECE3]">
                      {steps.map((x) => {
                        const done = rank >= x.at
                        return (
                          <div key={x.key} className={cn('bg-white px-3 py-2.5', done && 'bg-[#F4FBF6]')}>
                            <div
                              className={cn(
                                'flex items-center gap-1.5 text-[9px] font-extrabold uppercase tracking-[.12em]',
                                done ? 'text-[#0B6B45]' : 'text-[#A8B8AE]'
                              )}
                            >
                              {done && <Check className="h-3 w-3 shrink-0" />}
                              {x.key}
                            </div>
                            <div
                              className={cn(
                                'doc-ref mt-1 whitespace-nowrap text-[13px] font-bold tabular-nums',
                                x.date ? 'text-[#0A1F17]' : 'text-[#C3D2C6]'
                              )}
                            >
                              {x.date ? formatDate(x.date) : '—'}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}

              {/* Collapsible — the trail grows with every edit and gate
                  movement, and a long one pushes the invoice out of view. */}
              <button
                type="button"
                onClick={() => setActivityOpen((v) => !v)}
                className="mb-2 mt-5 flex w-full items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]"
              >
                Activity
                {activity.length > 0 && (
                  <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[9.5px] font-extrabold text-[#7C9188]">
                    {activity.length}
                  </span>
                )}
                <ChevronRight className={cn('ml-auto h-4 w-4 transition-transform', activityOpen && 'rotate-90')} />
              </button>
              {activityOpen && (
              <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-1.5">
                {activityLoading ? (
                  <div className="py-6 text-center text-[12.5px] text-[#7C9188]">Loading…</div>
                ) : activity.length === 0 ? (
                  <div className="py-6 text-center text-[12.5px] text-[#7C9188]">Nothing recorded against this invoice yet.</div>
                ) : (
                  activity.map((a, i) => {
                    const Ico = a.kind === 'created' ? CheckCircle2 : a.kind === 'in' ? LogIn : a.kind === 'out' ? LogOut : Pencil
                    return (
                      <div key={i} className="flex gap-3 border-b border-[#EAF0E9] py-2.5 last:border-0">
                        <Ico className="mt-0.5 h-[19px] w-[19px] shrink-0 text-[#12855A]" />
                        <div className="min-w-0">
                          <div className="text-[13px] font-bold">{a.what}</div>
                          <div className="mt-0.5 text-[11.5px] font-semibold text-[#7C9188]">{a.when || '—'}</div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- Sales bargains tab ----------------

// What has been drawn against one sales bargain, as one dated list.
// -----------------------------------------------------------------------------
// Lifted out of the desktop expand row so the phone can build the same thing.
// Four parts, each of which is easy to get subtly wrong:
//
//   ONE ROW PER INVOICE, not per line. A split invoice draws the bargain down
//   over several sale rows; showing each was showing the same invoice three
//   times. Qty and amount sum across the invoice's lines and the rate is the
//   QTY-WEIGHTED average (taxable / qty), never the first line's rate.
//
//   RETURNS ARE NEGATIVE LINES in the same list. A credit note is the same
//   story told backwards, so it belongs in date order beside the dispatch it
//   reverses rather than in a table of its own.
//
//   AMOUNTS INCLUDE GST on both sides, because the desktop column already
//   states them that way and two columns of the same name meaning different
//   things is worse than either choice.
//
//   THE TOTAL IS NET — what the bargain actually kept, not the gross it
//   shipped.
//
// The desktop still carries its own inline copy; the two are checked against
// each other on real data rather than assumed equal. Converging the desktop
// onto this is worth doing and is deliberately not done here, because the ask
// was that the desktop stay as it is.
export type BargainDrawLine = {
  key: string
  id: number
  kind: 'out' | 'ret'
  label: string
  sub: string
  date: string
  qty: number
  rate: number
  amount: number
  uom: string
  company: string
  companyColour: string
  companyId: number
}

export function salesBargainDraws(
  row: Row,
  disp: Row[],
  retLines: Row[],
  coNameOf: (id: unknown) => string,
  coColourOf: (id: unknown) => string
): { lines: BargainDrawLine[]; net: { qty: number; amount: number; out: number; ret: number } } {
  const byInvoice = new Map<
    string,
    { id: number; invoice_no: string; sale_date: string; sample: Row; qty: number; taxable: number; total: number }
  >()
  for (const d of disp) {
    const key = String(d.invoice_group || d.invoice_no || d.id)
    if (!byInvoice.has(key)) {
      byInvoice.set(key, {
        id: Number(d.id),
        invoice_no: d.invoice_no,
        sale_date: d.sale_date,
        sample: d,
        qty: 0,
        taxable: 0,
        total: 0
      })
    }
    const g = byInvoice.get(key)!
    g.qty += Number(d.qty) || 0
    g.taxable += Number(d.amount) || 0
    g.total += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
  }

  const lines: BargainDrawLine[] = [
    ...Array.from(byInvoice.values()).map((g): BargainDrawLine => ({
      key: `d${g.id}`,
      id: g.id,
      kind: 'out',
      label: String(g.invoice_no || '—'),
      sub: stageInfo(g.sample).label,
      date: String(g.sale_date || ''),
      qty: g.qty,
      rate: g.qty > 0 ? g.taxable / g.qty : 0,
      amount: g.total,
      uom: String(g.sample.uom || row.uom || 'MT'),
      company: coNameOf(g.sample.company_id),
      companyColour: coColourOf(g.sample.company_id),
      companyId: Number(g.sample.company_id) || 0
    })),
    ...retLines.map((rl, ri): BargainDrawLine => ({
      key: `r${rl.note_id}-${ri}`,
      id: 0,
      kind: 'ret',
      label: String(rl.note_no || 'CN'),
      sub: rl.explicit_bargain_id
        ? 'Return · named on the note'
        : `Return vs ${String(rl.against_ref || '—')}`,
      date: String(rl.note_date || ''),
      qty: -(Number(rl.qty) || 0),
      rate: Number(rl.rate) || 0,
      amount: -(Number(rl.amount_incl ?? rl.amount) || 0),
      uom: String(row.uom || 'MT'),
      company: coNameOf(rl.company_id),
      companyColour: coColourOf(rl.company_id),
      companyId: Number(rl.company_id) || 0
    }))
  ].sort((x, y) => x.date.localeCompare(y.date) || x.key.localeCompare(y.key))

  const net = lines.reduce(
    (acc, l) => {
      acc.qty += l.qty
      acc.amount += l.amount
      if (l.kind === 'ret') acc.ret += -l.qty
      else acc.out += l.qty
      return acc
    },
    { qty: 0, amount: 0, out: 0, ret: 0 }
  )
  return { lines, net }
}

function SalesBargainsTab({ onOpenSale }: { onOpenSale?: (id: number, companyId?: number) => void } = {}): React.JSX.Element {
  const isMobile = useIsMobile()
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('salesBargains')
  const [rows, setRows] = useState<Row[]>([])
  const [sales, setSales] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [packagings, setPackagings] = useState<Row[]>([])
  // Type classification tab (Finished Oil / Fatty / …), Loose / Packed section,
  // and whether to also show fully-settled (0-balance) bargains.
  const [sectionCategory, setSectionCategory] = useState<string>('ALL')
  const [sectionType, setSectionType] = useState<'LOOSE' | 'PACKED'>('LOOSE')
  const [showZero, setShowZero] = useState(false)
  const [search, setSearch] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  // Summary tiles start closed: the register underneath carries the same
  // figures per customer, so these are a glance, not the page.
  const [kpiOpen, setKpiOpen] = useState(false)
  const [expandedBg, setExpandedBg] = useState<Set<number>>(new Set())
  // Period register range — defaults to the current month. Opening / Addition /
  // Dispatch / Balance are computed relative to this range.
  const [dateFrom, setDateFrom] = useState(monthStartISO())
  const [dateTo, setDateTo] = useState(todayISO())
  const F = dateFrom || '0000-01-01'
  const T = dateTo || todayISO()
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'salesBargains')) { setDateFrom(globalRange.from); setDateTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // add/remove balance qty
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{ mode: 'add' | 'remove'; amount: string; note: string; date: string }>({
    mode: 'add',
    amount: '',
    note: '',
    date: todayISO()
  })
  const [adjustSaving, setAdjustSaving] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  // Sales bargains are general: the balance already counts every company's
  // dispatch, so the register reads as ONE book by default (empty = all) and
  // the invoice list underneath has to span the same companies. Picking one
  // narrows both together.
  const [companies, setCompanies] = useState<Row[]>([])
  // A bargain is general — either company can dispatch against it — so the
  // line is where the company is actually decided, not the bargain.
  const coNameOf = (id: unknown): string =>
    String(companies.find((c) => Number(c.id) === Number(id))?.name || '')
  // And the colour it was given, so the two companies' dispatches read apart
  // in a bargain that both have drawn on.
  const coColourOf = (id: unknown): string =>
    String(companies.find((c) => Number(c.id) === Number(id))?.colour || '')
  const [coIds, setCoIds] = useState<number[]>([])
  // The credit-note lines behind each bargain's Return figure.
  const [returns, setReturns] = useState<Row[]>([])
  // The Category master, so an inactive category drops out of these dropdowns.
  const { rows: catRows } = useCategories([], 'sales')
  const saleCats = useMemo(
    () =>
      saleCatsFrom(
        catRows,
        rows.map((r) => r.sale_category),
        products.filter((p) => Number(p.use_both) === 1).map((p) => p.material_type)
      ),
    // `products` belongs here: it arrives asynchronously, so without it the
    // list is computed once against an empty catalogue and a both-flagged
    // product's category never makes it into the dropdown.
    [catRows, rows, products]
  )
  // listSales defaults to the ACTIVE company when given nothing, so "all" has
  // to be spelled out as every id. Known only after the first load; until then
  // the active company's invoices show, and the list fills in on the refresh.
  // Keyed off a string, not the array — every load hands back a fresh array,
  // and a fresh identity in load's deps would re-trigger load forever.
  const companyKey = companies
    .map((c) => Number(c.id))
    .sort((a, b) => a - b)
    .join(',')
  const companyAll = useMemo(
    () => (companyKey ? companyKey.split(',').map(Number) : []),
    [companyKey]
  )

  const load = useCallback(async () => {
    const sel = coIds.length ? coIds : undefined
    const [b, s, pr, cu, pk, cos, ret] = await Promise.all([
      window.api.salesBargains.list(F, T, sel),
      window.api.sales.list(sel ?? companyAll),
      window.api.data.list('products'),
      window.api.data.list('customers'),
      window.api.data.list('packagings'),
      window.api.company.list().catch(() => [] as Row[]),
      window.api.salesBargains.returns(sel).catch(() => [] as Row[])
    ])
    setRows(b)
    setSales(s)
    setCompanies(cos)
    setReturns(ret)
    // All active products (not just finished) so byproducts — fatty, scrap,
    // spent earth, misc — can be sold under their sale-type bargains too.
    setProducts(pr.filter((x) => x.active))
    setCustomers(cu.filter((x) => x.active))
    setPackagings(pk.filter((x) => x.active))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [F, T, coIds, companyKey])

  // Same rule as the Sales invoice form: a bargain is a manufacturing rate
  // contract, so Trading customers are left out — but the bargain's own
  // customer stays listed so an existing one still opens and edits.
  const bargainCustomers = useMemo(
    () =>
      customers.filter(
        (c) => isManufacturingParty(c) || String(c.id) === String(form.customer_id || '')
      ),
    [customers, form.customer_id]
  )

  const returnsByBargain = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const r of returns) {
      const id = Number(r.bargain_id)
      if (!id) continue
      if (!m.has(id)) m.set(id, [])
      m.get(id)!.push(r)
    }
    return m
  }, [returns])

  // Dispatches (sales) grouped by the bargain they drew down, for the expand row.
  const dispatchesByBargain = useMemo(() => {
    const m = new Map<number, Row[]>()
    for (const s of sales) {
      const bid = Number(s.sales_bargain_id)
      if (!bid) continue
      if (!m.has(bid)) m.set(bid, [])
      m.get(bid)!.push(s)
    }
    for (const arr of m.values()) arr.sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)))
    return m
  }, [sales])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  function toggleGroup(name: string): void {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleBg(id: number): void {
    setExpandedBg((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const q = search.trim().toLowerCase()
  // Everything except the settled switch, so the number on the switch is
  // counted from the same rows the register draws.
  const matchedRows = rows.filter(
    (r) =>
      (sectionCategory === 'ALL' || String(r.sale_category || 'FINISHED_OIL') === sectionCategory) &&
      (String(r.sale_type || 'LOOSE') === 'PACKED' ? 'PACKED' : 'LOOSE') === sectionType &&
      (!q ||
        [r.bargain_no, r.customer, r.product_name, r.note].some((f) =>
          String(f || '').toLowerCase().includes(q)
        ))
  )
  const visibleRows = matchedRows.filter((r) => inRegister(r, F, T, showZero))
  const settledCount = matchedRows.filter(
    (r) => inRegister(r, F, T, true) && !inRegister(r, F, T, false)
  ).length
  const sortedRows = useMemo(
    () =>
      [...visibleRows].sort(
        (a, b) =>
          String(a.customer || '').localeCompare(String(b.customer || '')) ||
          String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
      ),
    [visibleRows]
  )

  const groupStats = useMemo(() => {
    const m = new Map<string, { count: number; opening: number; addition: number; adjusted: number; dispatch: number; ret: number; closing: number; uom: string }>()
    for (const r of visibleRows) {
      const k = String(r.customer || '—')
      if (!m.has(k)) m.set(k, { count: 0, opening: 0, addition: 0, adjusted: 0, dispatch: 0, ret: 0, closing: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      const reg = bargainRegister(r, F, T)
      g.count += 1
      g.opening += reg.opening
      g.addition += reg.addition
      g.adjusted += reg.adjusted
      g.dispatch += reg.dispatch
      g.ret += reg.ret
      g.closing += reg.closing
    }
    return m
  }, [visibleRows, F, T])

  const grand = useMemo(() => {
    let count = 0, opening = 0, addition = 0, adjusted = 0, dispatch = 0, ret = 0, closing = 0
    for (const g of groupStats.values()) {
      count += g.count
      opening += g.opening
      addition += g.addition
      adjusted += g.adjusted
      dispatch += g.dispatch
      ret += g.ret
      closing += g.closing
    }
    return { count, opening, addition, adjusted, dispatch, ret, closing }
  }, [groupStats])

  function blank(): Row {
    return {
      bargain_date: todayISO(),
      customer: '',
      customer_id: '',
      product_id: '',
      qty: '',
      uom: 'MT',
      rate: '',
      gst_pct: '',
      gst_type: 'CGST_SGST',
      rate_expiry_date: '',
      note: '',
      sale_type: 'LOOSE',
      sale_category: sectionCategory === 'ALL' ? 'FINISHED_OIL' : sectionCategory,
      packaging_id: '',
      freight_term: 'FREIGHT_ON_GOODS',
      allowed_shortage_pct: '',
      manual_bargain_no: ''
    }
  }
  function openAdd(): void {
    setEditing(null)
    setForm(blank())
    setError(null)
    setOpen(true)
  }
  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      bargain_date: row.bargain_date ?? todayISO(),
      customer: row.customer ?? '',
      customer_id: row.customer_id ? String(row.customer_id) : '',
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      uom: row.uom ?? 'MT',
      rate: row.rate ?? '',
      gst_pct: row.gst_pct ?? '',
      gst_type: row.gst_type ?? 'CGST_SGST',
      rate_expiry_date: row.rate_expiry_date ?? '',
      note: row.note ?? '',
      sale_type: row.sale_type ?? 'LOOSE',
      sale_category: row.sale_category ?? 'FINISHED_OIL',
      packaging_id: row.packaging_id ? String(row.packaging_id) : '',
      freight_term: row.freight_term ?? 'FREIGHT_ON_GOODS',
      allowed_shortage_pct: row.allowed_shortage_pct ?? '',
      manual_bargain_no: row.manual_bargain_no ?? ''
    })
    setError(null)
    setOpen(true)
  }
  // The products belonging to the chosen category. A sale category's code is
  // the Category master's own name normalised, and a product carries that same
  // name in material_type, so the two match once OIL / FINISHED_OIL are folded
  // together (see catAlias).
  const formProducts = useMemo(
    () => products.filter((p) => catAlias(p.material_type || 'OIL') === catAlias(form.sale_category || 'FINISHED_OIL')),
    [products, form.sale_category]
  )

  function setField(key: string, value: unknown): void {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Changing the category drops a product that does not belong to it, so a
      // bargain can never be saved against a product from another category.
      if (key === 'sale_category') {
        const want = catAlias(value)
        const fits = products.some(
          (p) => String(p.id) === String(prev.product_id) && catAlias(p.material_type || 'OIL') === want
        )
        if (!fits) next.product_id = ''
      }
      return next
    })
  }

  // How much of the bargain being edited is already sold — locks customer/product
  // and floors the quantity.
  const editSold = editing ? Math.max(0, (Number(editing.qty) || 0) - (Number(editing.balance_qty) || 0)) : 0
  const editLocked = editSold > 1e-4

  // Shown the moment the pair stops making sense — which happens when the
  // bargain date is moved past an expiry already set, not only when the expiry
  // itself is picked.
  const expiryProblem = ((): string | null => {
    const struck = String(form.bargain_date || '').slice(0, 10)
    const expires = String(form.rate_expiry_date || '').slice(0, 10)
    if (!struck || !expires || expires > struck) return null
    return expires === struck
      ? 'Expiry cannot be the same day as the bargain'
      : `Expiry is before the bargain date (${formatDate(struck)})`
  })()

  async function save(): Promise<void> {
    if (!form.customer || !String(form.customer).trim()) return setError('Customer is required')
    if (!form.product_id) return setError('Select a product')
    if (!form.qty || Number(form.qty) <= 0) return setError('Quantity must be greater than 0')
    if (!form.rate || Number(form.rate) <= 0) return setError('Rate must be greater than 0')
    if (expiryProblem) return setError(`Rate expiry must be after the bargain date — ${expiryProblem.toLowerCase()}`)
    if (editLocked && Number(form.qty) < editSold - 1e-4) {
      return setError(`Quantity cannot be below the ${formatNum(editSold)} already sold`)
    }
    setSaving(true)
    setError(null)
    try {
      const payload = { ...form, product_id: Number(form.product_id) }
      if (editing) await window.api.salesBargains.update(editing.id as number, payload)
      else await window.api.salesBargains.create(payload)
      toast.success('Sales bargain saved')
      setOpen(false)
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete sales bargain ${row.bargain_no}?`)) return
    try {
      await window.api.salesBargains.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  // Flatten the expandable second level for Excel: each bargain followed by the
  // dispatches booked against it. Bargains with none still get their row.
  function dispatchDetailRows(): Row[] {
    const out: Row[] = []
    for (const b of sortedRows) {
      const reg = bargainRegister(b, F, T)
      out.push({
        bargain_no: b.bargain_no || '',
        bargain_date: formatDate(b.bargain_date),
        customer: b.customer || '',
        product: b.product_name || '',
        rate: Number(b.rate) || 0,
        // The parent row states the bargain's period register, so the grouped
        // sheet reads on its own without cross-checking the summary tab.
        opening: reg.opening,
        addition: reg.addition,
        adjusted: reg.adjusted,
        balance: reg.closing,
        qty: reg.dispatch,
        ret: reg.ret
      })
      // One row per invoice, same as the on-screen drilldown — a split
      // invoice's lines are summed rather than listed separately, with a
      // qty-weighted average sale rate.
      const byInvoice = new Map<string, { invoice_no: string; sale_date: string; sample: Row; qty: number; taxable: number; total: number }>()
      for (const d of dispatchesByBargain.get(Number(b.id)) || []) {
        const key = String(d.invoice_group || d.invoice_no || d.id)
        if (!byInvoice.has(key)) {
          byInvoice.set(key, { invoice_no: d.invoice_no, sale_date: d.sale_date, sample: d, qty: 0, taxable: 0, total: 0 })
        }
        const g = byInvoice.get(key)!
        g.qty += Number(d.qty) || 0
        g.taxable += Number(d.amount) || 0
        g.total += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
      }
      for (const rl of returnsByBargain.get(Number(b.id)) || []) {
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          customer: '',
          product: String(rl.product_name || ''),
          rate: Number(rl.rate) || 0,
          invoice_no: `${String(rl.note_no || 'CN')} (return)`,
          company_name: String(rl.company_name || ''),
          sale_date: formatDate(rl.note_date),
          stage: rl.explicit_bargain_id ? 'return — named on note' : `return vs ${String(rl.against_ref || '—')}`,
          ret: Number(rl.qty) || 0,
          sale_rate: Number(rl.rate) || 0,
          amount: -(Number(rl.amount_incl ?? rl.amount) || 0)
        })
      }
      for (const g of byInvoice.values()) {
        out.push({
          bargain_no: b.bargain_no || '',
          bargain_date: '',
          customer: '',
          product: '',
          rate: Number(b.rate) || 0,
          invoice_no: g.invoice_no || '—',
          company_name: String(g.sample.company_name || ''),
          sale_date: formatDate(g.sale_date),
          stage: String(g.sample.stage || g.sample.status || ''),
          qty: g.qty,
          sale_rate: g.qty > 0 ? g.taxable / g.qty : 0,
          amount: g.total
        })
      }
    }
    return out
  }

  // --- SKU rate card for one sales bargain ----------------------------------
  const [rateRow, setRateRow] = useState<Row | null>(null)
  const [rateRows, setRateRows] = useState<Row[]>([])
  const [rateBusy, setRateBusy] = useState(false)
  // Website-only view state over the already-loaded SKU list — a search and an
  // "unpriced only" filter. Neither changes what is stored or saved.
  const [rateQuery, setRateQuery] = useState('')
  const [rateUnpricedOnly, setRateUnpricedOnly] = useState(false)
  // Rates typed straight into the card, keyed by packaging_id. Held here until
  // Save, so a half-typed number never reaches the database and one Save is one
  // write — the same shape the uploaded card already sends.
  const [rateEdits, setRateEdits] = useState<Record<number, string>>({})
  const rateFile = useRef<HTMLInputElement | null>(null)
  const rateDirty = Object.values(rateEdits).some((v) => v.trim() !== '')

  function closeRateCard(): void {
    if (rateDirty && !window.confirm('Discard the rates you typed?')) return
    setRateRow(null)
    setRateQuery('')
    setRateUnpricedOnly(false)
    setRateEdits({})
  }

  // The per-MT rate a typed per-case rate implies. Deliberately the same
  // formula and the same 2-decimal rounding parseSkuRateExcel uses, so a rate
  // typed here and the same rate uploaded on the card land identically.
  function derivedPerMt(r: Row, perCase: number): number | null {
    const mt = caseMT(r)
    return mt > 0 ? Math.round((perCase / mt) * 100) / 100 : null
  }

  async function saveInlineRates(): Promise<void> {
    if (!rateRow) return
    const payload: { packaging_id: number; rate_per_case: number; rate_per_mt: number | null }[] = []
    for (const r of rateRows) {
      const pid = Number(r.packaging_id)
      const raw = String(rateEdits[pid] ?? '').trim().replace(/,/g, '')
      if (!raw) continue
      const perCase = Number(raw)
      if (!Number.isFinite(perCase) || perCase <= 0) {
        toast.error(`${String(r.name || 'SKU')}: enter a rate greater than zero`)
        return
      }
      payload.push({ packaging_id: pid, rate_per_case: perCase, rate_per_mt: derivedPerMt(r, perCase) })
    }
    if (!payload.length) return
    setRateBusy(true)
    try {
      const res = await window.api.skuRates.save(Number(rateRow.id), payload)
      setRateRows(await window.api.skuRates.list(Number(rateRow.id)))
      setRateEdits({})
      toast.success(`${res.saved} SKU rate${res.saved === 1 ? '' : 's'} saved`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRateBusy(false)
    }
  }

  async function openRates(row: Row): Promise<void> {
    setRateRow(row)
    setRateRows([])
    // Never carry a typed rate from one bargain onto the next.
    setRateEdits({})
    try {
      setRateRows(await window.api.skuRates.list(Number(row.id)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function downloadRateCard(): Promise<void> {
    if (!rateRow) return
    try {
      await downloadSkuRateExcel(rateRows, {
        bargainNo: String(rateRow.bargain_no || ''),
        qty: Number(rateRow.qty) || 0,
        uom: String(rateRow.uom || 'MT'),
        customer: String(rateRow.customer || '')
      })
      toast.success('Rate card downloaded — only the rate columns are editable')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function uploadRateCard(file: File): Promise<void> {
    if (!rateRow) return
    setRateBusy(true)
    try {
      const parsed = await parseSkuRateExcel(file)
      if (!parsed.rows.length) {
        toast.error('No SKU rows found — use the downloaded rate card')
        return
      }
      // The card carries the bargain it was generated for, so one bargain's
      // rates cannot be uploaded onto another by mistake.
      const want = String(rateRow.bargain_no || '').trim()
      if (parsed.bargainNo && want && parsed.bargainNo !== want) {
        toast.error(`That card belongs to bargain ${parsed.bargainNo}, not ${want}`)
        return
      }
      const res = await window.api.skuRates.save(Number(rateRow.id), parsed.rows)
      setRateRows(await window.api.skuRates.list(Number(rateRow.id)))
      toast.success(
        `${res.saved} SKU rate${res.saved === 1 ? '' : 's'} saved` +
          (res.cleared ? `, ${res.cleared} cleared` : '')
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRateBusy(false)
      if (rateFile.current) rateFile.current.value = ''
    }
  }

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    setAdjustForm({ mode: 'add', amount: '', note: '', date: todayISO() })
    setAdjustError(null)
  }
  async function saveAdjust(): Promise<void> {
    if (!adjustRow) return
    const amt = Number(adjustForm.amount)
    if (!amt || amt <= 0) {
      setAdjustError('Enter a quantity greater than zero')
      return
    }
    const delta = adjustForm.mode === 'add' ? amt : -amt
    setAdjustSaving(true)
    setAdjustError(null)
    try {
      await window.api.salesBargains.adjust(Number(adjustRow.id), delta, adjustForm.note || undefined, adjustForm.date || undefined)
      toast.success(
        adjustForm.mode === 'add'
          ? `Added ${amt} ${adjustRow.uom || 'MT'} to ${adjustRow.bargain_no}`
          : `Removed ${amt} ${adjustRow.uom || 'MT'} from ${adjustRow.bargain_no}`
      )
      setAdjustRow(null)
      await load()
    } catch (e) {
      setAdjustError(errText(e))
    } finally {
      setAdjustSaving(false)
    }
  }

  // Display-only helpers for the website's rate card. None of these touch what
  // is stored — the rates still arrive the one way they always have, by
  // downloading the card and uploading it filled in.
  const ratePriced = rateRows.filter((r) => r.rate_per_case != null || r.rate_per_mt != null)
  const ratePct = rateRows.length ? Math.round((ratePriced.length / rateRows.length) * 100) : 0
  // A pack priced far off its siblings on rate per MT is nearly always a rate
  // per case typed against the wrong pack size. Advisory only, and measured
  // against the median so one bad row cannot drag the yardstick to itself.
  const rateMedianMt = (() => {
    const v = ratePriced.map((r) => Number(r.rate_per_mt) || 0).filter((n) => n > 1000).sort((a, b) => a - b)
    return v.length ? v[Math.floor(v.length / 2)] : 0
  })()
  const rateIsOff = (r: Row): boolean => {
    const mt = Number(r.rate_per_mt) || 0
    const priced = r.rate_per_case != null || r.rate_per_mt != null
    return priced && rateMedianMt > 0 && mt > 0 && Math.abs(mt - rateMedianMt) / rateMedianMt > 0.5
  }
  const rateFlagged = rateRows.filter(rateIsOff).length
  const shownRateRows = (() => {
    const rq = rateQuery.trim().toLowerCase()
    return rateRows
      .filter((r) => !rateUnpricedOnly || (r.rate_per_case == null && r.rate_per_mt == null))
      .filter((r) => !rq || String(r.name || '').toLowerCase().includes(rq))
  })()
  const rateScopeNote = rateRows.some((r) => Number(r.party_linked) === 1)
    ? 'All SKUs linked to this party'
    : rateRows.length && rateRows.every((r) => Number(r.free) === 1)
      ? 'Free SKUs — not claimed by any party'
      : "Every SKU for this bargain's product"

  const rateCard = __WEB__ ? (
    <Dialog open={!!rateRow} onOpenChange={(o) => { if (!o) closeRateCard() }}>
      <DialogContent className="grid !max-w-[1020px] !grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 h-[88vh] w-[calc(100vw-3rem)] [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100">
        <DialogHeader className="!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-4 !text-left">
          <div className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">SKU rate card</div>
          <DialogTitle className="!mt-1.5 !truncate !text-[19px] !font-bold !tracking-[-0.02em] !text-white">
            {rateRow?.bargain_no}
          </DialogTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-[2px] bg-white/10 px-2.5 py-1 text-[11.5px] font-bold text-white">
              <Building2 className="h-3.5 w-3.5 text-[#8FBFA8]" />
              {String(rateRow?.customer || '—')}
            </span>
            {/* Why these SKUs and not others — a party with its own linked SKUs
                gets those, one with none gets the unclaimed FREE packs rather
                than somebody else's exclusives. Saying so stops a shorter list
                looking like SKUs have gone missing. */}
            <span className="flex items-center gap-1.5 rounded-[2px] bg-white/10 px-2.5 py-1 text-[11.5px] font-bold text-white">
              <ListChecks className="h-3.5 w-3.5 text-[#8FBFA8]" />
              {rateScopeNote}
            </span>
          </div>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-4 border-b border-[#D6E2D6] bg-white px-[22px] py-3.5">
          <div className="min-w-[240px] flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-extrabold">{ratePriced.length} of {rateRows.length} SKUs priced</span>
              <div className="flex items-center gap-2">
                {rateRows.length > ratePriced.length && (
                  <span className="rounded-[2px] bg-[#FFEDD0] px-2 py-1 text-[11.5px] font-extrabold text-[#8A5300]">
                    {rateRows.length - ratePriced.length} missing
                  </span>
                )}
                {rateFlagged > 0 && (
                  <span className="flex items-center gap-1.5 rounded-[2px] bg-[#FDF3F2] px-2 py-1 text-[11.5px] font-extrabold text-[#B3261E]">
                    <AlertTriangle className="h-3.5 w-3.5" /> {rateFlagged} to check
                  </span>
                )}
                <span className="text-[12.5px] font-bold tabular-nums text-[#5A6B62]">{ratePct}%</span>
              </div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
              <div className="h-full" style={{ width: `${ratePct}%`, background: ratePct === 100 ? '#12855A' : '#C2700A' }} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <input
              ref={rateFile}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadRateCard(f)
              }}
            />
            <button
              type="button"
              onClick={downloadRateCard}
              disabled={!rateRows.length}
              className="flex h-10 items-center gap-2 rounded-[4px] border-[1.5px] border-[#0B3D2E] px-3.5 text-[13px] font-extrabold tracking-[.02em] text-[#0B3D2E] transition-colors hover:bg-[#EAF0E9] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-[18px] w-[18px]" /> Download card
            </button>
            <button
              type="button"
              onClick={() => rateFile.current?.click()}
              disabled={rateBusy}
              className="flex h-10 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-3.5 text-[13px] font-extrabold tracking-[.02em] text-[#C7F03F] transition-colors hover:bg-[#0F4A38] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Upload className="h-[18px] w-[18px]" /> {rateBusy ? 'Uploading…' : 'Upload filled card'}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-b border-[#D6E2D6] bg-white px-[22px] py-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8AA096]" />
            <input
              value={rateQuery}
              onChange={(e) => setRateQuery(e.target.value)}
              placeholder="Search SKU"
              className="h-10 w-full rounded-[4px] border border-[#C3D2C6] pl-9 pr-3 text-[13px] font-medium text-[#0A1F17] outline-none placeholder:text-[#8AA096] focus:border-[#0B3D2E]"
            />
          </div>
          <button
            type="button"
            onClick={() => setRateUnpricedOnly((v) => !v)}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-[4px] border px-3.5 text-[12.5px] font-extrabold transition-colors',
              rateUnpricedOnly ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
            )}
          >
            <SlidersHorizontal className="h-4 w-4" /> Unpriced only
          </button>
        </div>

        <div className="flex min-h-0 flex-col px-[22px] pt-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div
              className="grid h-10 shrink-0 items-center bg-[#0B3D2E] text-[11px] font-extrabold uppercase tracking-[.1em] text-white"
              style={{ gridTemplateColumns: 'minmax(280px,1.6fr) 140px 160px 170px 44px' }}
            >
              <div className="px-3.5">SKU</div>
              <div className="px-3 text-right">MT / case</div>
              <div className="px-3 text-right">Rate / case</div>
              <div className="px-3 text-right">Rate / MT</div>
              <div />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rateRows.length === 0 ? (
                <div className="px-4 py-12 text-center text-[13px] font-semibold text-[#7C9188]">
                  No packed SKUs for this bargain&apos;s product. Add them under Masters → Packed SKU.
                </div>
              ) : shownRateRows.length === 0 ? (
                <div className="px-4 py-12 text-center text-[13px] font-semibold text-[#7C9188]">No SKU matches.</div>
              ) : (
                shownRateRows.map((r) => {
                  const priced = r.rate_per_case != null || r.rate_per_mt != null
                  const off = rateIsOff(r)
                  return (
                    <div
                      key={String(r.packaging_id)}
                      className={cn(
                        'grid min-h-[50px] items-center border-b border-[#EAF0E9] border-l-[3px]',
                        priced ? 'bg-white' : 'bg-[#FFFBF2]',
                        off ? 'border-l-[#B3261E]' : priced ? 'border-l-transparent' : 'border-l-[#C2700A]'
                      )}
                      style={{ gridTemplateColumns: 'minmax(280px,1.6fr) 140px 160px 170px 44px' }}
                    >
                      <div className="flex min-w-0 items-center gap-2 px-3.5">
                        <span className="truncate text-[13.5px] font-bold tracking-[-0.01em]" title={String(r.name || '')}>{String(r.name || '')}</span>
                        {Number(r.party_linked) === 1 ? (
                          <span className="shrink-0 rounded-[2px] bg-[#E9F5EE] px-1.5 py-[3px] text-[10px] font-extrabold uppercase tracking-[.05em] text-[#0B6B45]">Linked</span>
                        ) : Number(r.free) === 1 ? (
                          <span className="shrink-0 rounded-[2px] bg-[#EAF0E9] px-1.5 py-[3px] text-[10px] font-extrabold uppercase tracking-[.05em] text-[#5A6B62]">Free</span>
                        ) : (
                          <span
                            className="shrink-0 rounded-[2px] bg-[#FFEDD0] px-1.5 py-[3px] text-[10px] font-extrabold uppercase tracking-[.05em] text-[#8A5300]"
                            title={`Claimed by ${Number(r.claimed_by)} other part${Number(r.claimed_by) === 1 ? 'y' : 'ies'}`}
                          >
                            Other party
                          </span>
                        )}
                      </div>
                      <div className="px-3 text-right text-[13px] font-medium tabular-nums text-[#5A6B62]">{caseMT(r).toFixed(5)}</div>
                      {priced ? (
                        <>
                          <div className={cn('px-3 text-right text-[14px] font-bold tabular-nums', off && 'text-[#B3261E]')}>
                            {r.rate_per_case != null ? formatINR(r.rate_per_case) : '—'}
                          </div>
                          <div className={cn('px-3 text-right text-[14px] font-bold tabular-nums', off && 'text-[#B3261E]')}>
                            {r.rate_per_mt != null ? formatINR(r.rate_per_mt) : '—'}
                          </div>
                        </>
                      ) : (
                        (() => {
                          // Typed straight into the card. Only unpriced rows
                          // take an input — an existing rate is changed on the
                          // downloaded card, where the change is reviewable
                          // before it lands, rather than by a stray click here.
                          const pid = Number(r.packaging_id)
                          const typed = String(rateEdits[pid] ?? '')
                          const n = Number(typed.trim().replace(/,/g, ''))
                          const preview = typed.trim() && Number.isFinite(n) && n > 0 ? derivedPerMt(r, n) : null
                          return (
                            <>
                              <div className="flex justify-end px-3">
                                <input
                                  value={typed}
                                  inputMode="decimal"
                                  placeholder="Not set"
                                  onChange={(e) => setRateEdits((p) => ({ ...p, [pid]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveInlineRates() } }}
                                  className={cn(
                                    'h-8 w-[110px] rounded-[3px] border bg-white px-2.5 text-right text-[13px] font-bold tabular-nums text-[#0A1F17] outline-none placeholder:font-semibold placeholder:text-[#A8B8AE]',
                                    typed.trim() ? 'border-[#0B3D2E] ring-1 ring-[#0B3D2E]/20' : 'border-[#E3C58C] focus:border-[#0B3D2E]'
                                  )}
                                />
                              </div>
                              <div className={cn('px-3 text-right text-[11.5px] font-bold', preview != null ? 'text-[#0B6B45] tabular-nums' : 'text-[#8A5300]')}>
                                {preview != null ? formatINR(preview) : 'from MT / case'}
                              </div>
                            </>
                          )
                        })()
                      )}
                      <div className="flex items-center justify-center">
                        {off && <span title="Rate per MT is far off the other SKUs"><AlertTriangle className="h-[18px] w-[18px] text-[#B3261E]" /></span>}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
          {/* Both notes are one line with the long form behind a "?" — a panel
              this dense should not spend six lines on prose the reader has
              already understood by the third time they open it. */}
          {rateFlagged > 0 && (
            <div className="mt-2.5 flex shrink-0 items-center gap-2 rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#B3261E]" />
              <span className="text-[12px] font-bold text-[#8C2F26]">
                {rateFlagged} SKU{rateFlagged === 1 ? '' : 's'} priced far off the others
              </span>
              <HelpTip
                className="!text-[#B3261E]/70 hover:!text-[#B3261E]"
                text="Rate per MT is more than 50% away from the median of the other priced SKUs — usually a rate per case entered against the wrong pack size. Check it before this card is used on a sale line."
              />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2 py-2.5">
            <span className="text-[12px] font-semibold text-[#5A6B62]">Leave a rate blank and it is worked out from MT per case.</span>
            <HelpTip text="Download the card, fill the rate per case or per MT for each SKU, and upload it back. Whichever rate you leave blank is worked out from MT per case. These rates are then offered on a sale line booked against this bargain. Link more SKUs under Masters → Packed SKU." />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
          <div className="text-[12.5px] font-semibold text-[#5A6B62]">
            Showing <b className="font-extrabold text-[#0A1F17]">{shownRateRows.length}</b> SKU{shownRateRows.length === 1 ? '' : 's'} ·{' '}
            {ratePriced.length} of {rateRows.length} priced
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={closeRateCard}
              className="h-10 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#F7FAF6]"
            >
              Close
            </button>
            {/* Only there once something is typed — a Save that is always
                present invites a click that does nothing. */}
            {rateDirty && (
              <button
                type="button"
                onClick={() => void saveInlineRates()}
                disabled={rateBusy}
                className="flex h-10 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] transition-colors hover:bg-[#0F4A38] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check className="h-5 w-5" /> {rateBusy ? 'Saving…' : 'Save rates'}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  ) : (
    <Dialog open={!!rateRow} onOpenChange={(o) => !o && setRateRow(null)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>SKU rates — {rateRow?.bargain_no}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Download the card, fill the rate per case or per MT for each SKU, and upload it back. Whichever rate you
            leave blank is worked out from MT per case. These rates are then offered on a sale line booked against this
            bargain.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={rateFile}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadRateCard(f)
              }}
            />
            <Button variant="outline" size="sm" onClick={downloadRateCard} disabled={!rateRows.length}>
              <Download className="h-4 w-4" /> Download rate card
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => rateFile.current?.click()}
              disabled={rateBusy}
            >
              <Upload className="h-4 w-4" /> {rateBusy ? 'Uploading…' : 'Upload filled card'}
            </Button>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {rateRows.filter((r) => r.rate_per_case != null || r.rate_per_mt != null).length} of {rateRows.length}{' '}
              SKUs priced
            </span>
          </div>
          {/* Why these SKUs and not others. A party with its own linked SKUs
              gets those; a party with none gets the FREE ones — the SKUs no
              party has claimed — rather than being offered somebody else's
              exclusive packs. Saying so stops the shorter list looking like
              SKUs have gone missing. */}
          <div className="text-[11px] text-muted-foreground">
            {rateRows.some((r) => Number(r.party_linked) === 1) ? (
              <>
                Showing the SKUs linked to this party.{' '}
                <span className="text-muted-foreground/70">Link more under Masters → Packed SKU.</span>
              </>
            ) : rateRows.length && rateRows.every((r) => Number(r.free) === 1) ? (
              <>
                No SKU is linked to this party yet, so these are the{' '}
                <b className="font-semibold text-emerald-700">free SKUs</b> — not claimed by any party, so anyone can
                be sold them.
              </>
            ) : (
              <>Every SKU for this bargain&apos;s product.</>
            )}
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-muted/70">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-semibold">SKU</th>
                  <th className="px-3 py-1.5 font-semibold">Party</th>
                  <th className="px-3 py-1.5 text-right font-semibold">MT / case</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Rate / case</th>
                  <th className="px-3 py-1.5 text-right font-semibold">Rate / MT</th>
                </tr>
              </thead>
              <tbody>
                {rateRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                      No packed SKUs for this bargain&apos;s product. Add them under Masters → Packed SKU.
                    </td>
                  </tr>
                ) : (
                  rateRows.map((r, i) => {
                    const priced = r.rate_per_case != null || r.rate_per_mt != null
                    return (
                      <tr
                        key={String(r.packaging_id)}
                        className={cn('border-b last:border-0', i % 2 === 1 && 'bg-muted/30', priced && 'bg-emerald-50/60')}
                      >
                        <td className="px-3 py-1.5 font-medium">{r.name}</td>
                        <td className="px-3 py-1.5">
                          {Number(r.party_linked) === 1 ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Linked
                            </span>
                          ) : Number(r.free) === 1 ? (
                            <span className="text-[11px] text-muted-foreground">Free</span>
                          ) : (
                            <span
                              className="text-[11px] text-amber-700"
                              title={`Claimed by ${Number(r.claimed_by)} other part${Number(r.claimed_by) === 1 ? 'y' : 'ies'}`}
                            >
                              Other party
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {caseMT(r).toFixed(5)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                          {r.rate_per_case != null ? formatINR(r.rate_per_case) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {r.rate_per_mt != null ? formatINR(r.rate_per_mt) : '—'}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRateRow(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )


  // ------------------------------------------------------------ the phone --
  // The register is eight numeric columns grouped by customer. On a phone it
  // becomes two levels of card: a customer band that opens into its bargains,
  // and a bargain that opens into the invoices drawn against it. Same figures,
  // same grouping, collapsed by default — a phone reading of the page.
  //
  // Built as a value rather than an early return so the dialogs below stay
  // mounted for both: New bargain, Adjust and the SKU rate card all work here.
  const mobileBody = ((): React.JSX.Element => {
    const contracted = grand.opening + grand.addition + grand.adjusted
    const kpis = [
      { k: 'Bargains', v: String(grand.count), unit: '' },
      { k: 'Contracted', v: formatNum(contracted), unit: 'MT' },
      { k: 'Net drawn', v: formatNum(grand.dispatch - grand.ret), unit: 'MT' },
      { k: 'Balance', v: formatNum(grand.closing), unit: 'MT' }
    ]
    const parties = [...groupStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const bar = (drawn: number, total: number): { pct: string; label: string; colour: string } => {
      const pc = total > 0 ? Math.min(100, Math.max(0, (drawn / total) * 100)) : 0
      return {
        pct: `${pc}%`,
        label: `${Math.round(pc)}%`,
        colour: pc >= 99.5 ? '#12855A' : pc > 0 ? '#C2700A' : '#C3D2C6'
      }
    }

    return (
      <div className="-mx-4 -my-4 flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
        <div className="flex-none bg-[#0B3D2E] px-4 pb-3.5 pt-2.5 text-white">
          <MobileBar onRefresh={() => load()} />
          <div className="min-w-0">
            <div className="text-[19px] font-extrabold tracking-[-0.02em]">Sales Bargain</div>
            <div className="mt-[3px] text-[11.5px] font-bold text-[#8FBFA8]">
              {grand.count} {grand.count === 1 ? 'bargain' : 'bargains'} · {parties.length}{' '}
              {parties.length === 1 ? 'customer' : 'customers'} · {formatDate(F)} to {formatDate(T)}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setKpiOpen((v) => !v)}
            className="mt-2.5 flex min-h-11 w-full items-center gap-2 rounded-[4px] bg-white/10 px-[11px]"
          >
            <ChevronDown
              className="h-[19px] w-[19px] flex-none text-[#C7F03F] transition-transform"
              style={{ transform: kpiOpen ? 'none' : 'rotate(-90deg)' }}
            />
            <span className="min-w-0 flex-1 text-left text-[10.5px] font-extrabold uppercase tracking-[.11em] text-[#8FBFA8]">
              Summary
            </span>
            <span className="doc-ref whitespace-nowrap text-[11.5px] font-extrabold text-[#C7F03F]">
              {formatNum(grand.closing)} MT open
            </span>
          </button>
          {kpiOpen && (
            <div className="mt-[9px] grid grid-cols-2 gap-2">
              {kpis.map((k) => (
                <div key={k.k} className="min-w-0 rounded-[4px] bg-white/10 px-[11px] py-[9px]">
                  <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{k.k}</div>
                  <div className="doc-ref mt-[5px] text-[14px] font-bold tracking-[-0.02em] text-white">
                    {k.v}
                    {k.unit && <span className="text-[10px] text-[#8FBFA8]"> {k.unit}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-none flex-col gap-[9px] border-b border-b-[#D6E2D6] bg-white px-4 py-2.5">
          <div className="flex h-11 items-center gap-[9px] rounded-[4px] border border-[#C3D2C6] px-3">
            <Search className="h-[19px] w-[19px] flex-none text-[#5A6B62]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Bargain, customer or product"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium outline-none"
            />
          </div>
          {/* Loose and Packed are not a filter, they are two different
              registers — a packed bargain is priced per SKU. So they stay a
              hard switch here as on the desktop, with the category chips
              beside them. */}
          <div className="flex gap-[7px] overflow-x-auto pb-0.5">
            {(['LOOSE', 'PACKED'] as const).map((t) => {
              const on = sectionType === t
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSectionType(t)}
                  className="flex h-11 flex-none items-center whitespace-nowrap rounded-[4px] border border-[#DCE7DB] px-[15px] text-[12.5px] font-extrabold"
                  style={on ? { background: '#0B3D2E', color: '#fff' } : { background: '#fff', color: '#33473E' }}
                >
                  {t === 'LOOSE' ? 'Loose' : 'Packed'}
                </button>
              )
            })}
            {[{ v: 'ALL', label: 'All' }, ...saleCats].map((t) => {
              const on = sectionCategory === t.v
              return (
                <button
                  key={t.v}
                  type="button"
                  onClick={() => setSectionCategory(t.v)}
                  className="flex h-11 flex-none items-center whitespace-nowrap rounded-[4px] border border-[#DCE7DB] px-[15px] text-[12.5px] font-extrabold"
                  style={on ? { background: '#EFF5EC', color: '#0B3D2E', borderColor: '#0B3D2E' } : { background: '#fff', color: '#5A6B62' }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => setShowZero((v) => !v)}
            className="flex min-h-11 items-center gap-[9px] text-left"
          >
            <span
              className="flex h-[26px] w-11 flex-none rounded-[3px] p-[3px]"
              style={{ background: showZero ? '#0B3D2E' : '#C3D2C6', justifyContent: showZero ? 'flex-end' : 'flex-start' }}
            >
              <span className="h-5 w-5 rounded-[2px] bg-white" />
            </span>
            <span className="inline-flex flex-wrap items-center gap-[7px] text-[12px] font-bold text-[#33473E]">
              Show settled <span className="text-[#5A6B62]">(0 balance)</span>
              <span
                className="doc-ref rounded-[9px] px-2 py-[2px] text-[11px] font-extrabold"
                style={showZero ? { background: '#0B3D2E', color: '#C7F03F' } : { background: '#EAF0E9', color: '#33473E' }}
              >
                {settledCount}
              </span>
            </span>
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-[96px] pt-3">
          {parties.map(([party, g]) => {
            const open2 = openGroups.has(party)
            const gContracted = g.opening + g.addition + g.adjusted
            const gNet = g.dispatch - g.ret
            const gb = bar(gNet, gContracted)
            const gRows = sortedRows.filter((r) => String(r.customer || '—') === party)
            return (
              <div key={party} className="flex flex-none flex-col gap-[9px]">
                <button
                  type="button"
                  onClick={() => toggleGroup(party)}
                  className="flex-none rounded-[4px] border border-[#D6E2D6] bg-white px-[13px] py-3 text-left"
                  style={{ borderLeft: `3px solid ${g.closing > 0.0005 ? '#12855A' : '#C3D2C6'}` }}
                >
                  <div className="flex items-start gap-[9px]">
                    <ChevronRight
                      className="mt-0.5 h-[19px] w-[19px] flex-none text-[#5A6B62] transition-transform"
                      style={{ transform: open2 ? 'rotate(90deg)' : 'none' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-extrabold leading-[1.35] tracking-[-0.01em]">{party}</div>
                      <div className="mt-1 text-[11px] font-bold text-[#5A6B62]">
                        {g.count} {g.count === 1 ? 'bargain' : 'bargains'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-[11px] grid grid-cols-3 gap-[9px]">
                    <div>
                      <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Contracted</div>
                      <div className="doc-ref mt-1 text-[12.5px] font-bold">{formatNum(gContracted)}</div>
                      {Math.abs(g.adjusted) > 0.0005 && (
                        <div className="doc-ref mt-[3px] whitespace-nowrap text-[10px] font-bold text-[#8A5300]">
                          {g.adjusted > 0 ? '+' : ''}
                          {formatNum(g.adjusted)} adj
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Net drawn</div>
                      <div className="doc-ref mt-1 text-[12.5px] font-bold">{gNet ? formatNum(gNet) : '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Balance</div>
                      <div className="doc-ref mt-1 text-[12.5px] font-bold">{formatNum(g.closing)}</div>
                    </div>
                  </div>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                    <div className="h-full" style={{ width: gb.pct, background: gb.colour }} />
                  </div>
                </button>

                {open2 &&
                  gRows.map((row) => {
                    const reg = bargainRegister(row, F, T)
                    const rowOpen = expandedBg.has(Number(row.id))
                    const rContracted = reg.opening + reg.addition + reg.adjusted
                    const rNet = reg.dispatch - reg.ret
                    const rb = bar(rNet, rContracted)
                    const disp = dispatchesByBargain.get(Number(row.id)) || []
                    const retLines = returnsByBargain.get(Number(row.id)) || []
                    const { lines, net } = salesBargainDraws(row, disp, retLines, coNameOf, coColourOf)
                    const rate = Number(row.rate_per_uom) || 0
                    const packed = String(row.sale_type || 'LOOSE') === 'PACKED'
                    return (
                      <div
                        key={String(row.id)}
                        className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white"
                        style={{ borderLeft: `3px solid ${reg.closing > 0.0005 ? '#12855A' : '#C3D2C6'}` }}
                      >
                        <div className="flex flex-col gap-[9px] px-[13px] py-3">
                          <div className="flex items-start gap-[9px]">
                            <div className="min-w-0 flex-1">
                              <div className="doc-ref text-[12px] font-bold leading-[1.35] tracking-[-0.01em] [overflow-wrap:anywhere]">
                                {String(row.bargain_no || '—')}
                              </div>
                              <div className="mt-[5px] text-[12px] font-bold leading-[1.4] text-[#33473E]">
                                {String(row.product_name || '—')}
                              </div>
                            </div>
                            <div className="flex-none text-right">
                              <div className="doc-ref whitespace-nowrap text-[11.5px] font-semibold text-[#5A6B62]">
                                {formatDate(row.bargain_date)}
                              </div>
                              <div className="doc-ref mt-[5px] whitespace-nowrap text-[12.5px] font-bold">
                                {/* A packed bargain is priced per SKU, so there
                                    is no single rate to print here. */}
                                {packed ? 'per SKU' : `${formatINR(rate)}/${String(row.uom || 'MT')}`}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-[9px] rounded-[4px] border border-[#EAF0E9] bg-[#F7FAF6] px-[11px] py-2.5">
                            <div>
                              <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Contracted</div>
                              <div className="doc-ref mt-1 text-[13px] font-bold">{formatNum(rContracted)}</div>
                              {Math.abs(reg.adjusted) > 0.0005 && (
                                <div className="doc-ref mt-[3px] whitespace-nowrap text-[10px] font-bold text-[#8A5300]">
                                  {reg.adjusted > 0 ? '+' : ''}
                                  {formatNum(reg.adjusted)} adj
                                </div>
                              )}
                            </div>
                            <div>
                              <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Net drawn</div>
                              <div className="doc-ref mt-1 text-[13px] font-bold">{rNet ? formatNum(rNet) : '—'}</div>
                            </div>
                            <div>
                              <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">Balance</div>
                              <div
                                className="doc-ref mt-1 text-[13px] font-bold"
                                style={{ color: reg.closing > 0.0005 ? '#0B6B45' : '#5A6B62' }}
                              >
                                {formatNum(reg.closing)}
                              </div>
                            </div>
                          </div>

                          {/* A top-up dated AFTER the period. It is contracted
                              quantity that this period's balance cannot show,
                              and leaving it silent made the balance look wrong
                              against the bargain's own total. */}
                          {Math.abs(reg.futureAdjusted) > 0.0005 && (
                            <div className="flex items-start gap-[9px] rounded-[4px] border border-[#F0E4CB] bg-[#FFF4E0] px-[11px] py-2.5">
                              <Clock className="h-[17px] w-[17px] flex-none text-[#C2700A]" />
                              <div className="min-w-0">
                                <div className="doc-ref text-[12px] font-extrabold text-[#8A5300]">
                                  {reg.futureAdjusted > 0 ? '+' : ''}
                                  {formatNum(reg.futureAdjusted)} {String(row.uom || 'MT')} later
                                </div>
                                <div className="mt-[3px] text-[11px] font-semibold leading-[1.45] text-[#8A5300]">
                                  Adjusted after {formatDate(T)}, so it is not in this period&rsquo;s balance.
                                </div>
                              </div>
                            </div>
                          )}

                          {reg.ret > 0.0005 && (
                            <div className="flex items-center gap-[9px] rounded-[4px] border border-[#BFE3CB] bg-[#F4FBF6] px-[11px] py-2.5">
                              <Undo2 className="h-[17px] w-[17px] flex-none text-[#0B6B45]" />
                              <span className="min-w-0 flex-1 text-[11.5px] font-bold text-[#0B6B45]">
                                Dispatched {formatNum(reg.dispatch)} · returned {formatNum(reg.ret)}
                              </span>
                            </div>
                          )}

                          <div>
                            <div className="h-1.5 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                              <div className="h-full" style={{ width: rb.pct, background: rb.colour }} />
                            </div>
                            <div className="mt-[7px] flex items-center justify-between gap-2.5">
                              <span className="text-[11px] font-bold text-[#5A6B62]">{rb.label} drawn</span>
                              <span className="doc-ref whitespace-nowrap text-[11.5px] font-bold text-[#33473E]">
                                {formatINR(net.amount)}
                              </span>
                            </div>
                          </div>

                          {!!row.note && (
                            <div className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
                              {String(row.note)}
                            </div>
                          )}

                          {/* On the desktop the rate card is a row action. It
                              only exists for a packed bargain, so it lives on
                              the card here rather than in the header — a header
                              button would have had no bargain to open. */}
                          {packed && (
                            <button
                              type="button"
                              onClick={() => void openRates(row)}
                              className="flex h-11 items-center justify-center gap-2 rounded-[4px] border border-[#C3D2C6] text-[12px] font-extrabold text-[#33473E]"
                            >
                              <Tag className="h-4 w-4" />
                              SKU rate card
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => toggleBg(Number(row.id))}
                          className="flex min-h-12 w-full items-center gap-[9px] border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-[13px] py-2.5 text-left"
                        >
                          <Receipt className="h-[18px] w-[18px] flex-none text-[#33473E]" />
                          <span className="min-w-0 flex-1 text-[11.5px] font-extrabold text-[#33473E]">
                            {lines.length
                              ? `${lines.length} ${lines.length === 1 ? 'draw' : 'draws'} · ${formatNum(net.qty)} net`
                              : 'Nothing drawn yet'}
                          </span>
                          <ChevronRight
                            className="h-[19px] w-[19px] flex-none text-[#5A6B62] transition-transform"
                            style={{ transform: rowOpen ? 'rotate(90deg)' : 'none' }}
                          />
                        </button>

                        {rowOpen &&
                          (lines.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 border-t border-t-[#EAF0E9] px-[13px] py-5">
                              <Receipt className="h-[26px] w-[26px] text-[#C3D2C6]" />
                              <span className="text-center text-[11.5px] font-semibold leading-[1.45] text-[#5A6B62]">
                                Nothing drawn yet — the full {formatNum(reg.closing)} {String(row.uom || 'MT')} is still
                                open.
                              </span>
                            </div>
                          ) : (
                            <>
                              {lines.map((l) => {
                                const ret = l.kind === 'ret'
                                return (
                                  <button
                                    key={l.key}
                                    type="button"
                                    disabled={ret || !onOpenSale}
                                    onClick={() => onOpenSale?.(l.id, l.companyId || undefined)}
                                    className="w-full border-t border-t-[#EAF0E9] px-[13px] py-2.5 text-left"
                                    style={{
                                      background: ret ? '#F4FBF6' : '#fff',
                                      borderLeft: `3px solid ${ret ? '#0B6B45' : '#C3D2C6'}`
                                    }}
                                  >
                                    <div className="flex items-center gap-[9px]">
                                      <span className="doc-ref min-w-0 flex-1 truncate text-[12px] font-bold">
                                        {l.label}
                                      </span>
                                      <span
                                        className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap rounded-[2px] px-[7px] py-[3px] text-[9.5px] font-extrabold"
                                        style={
                                          ret
                                            ? { background: '#E9F5EE', color: '#0B6B45' }
                                            : { background: '#EAF0E9', color: '#33473E' }
                                        }
                                      >
                                        {ret ? <Undo2 className="h-3 w-3" /> : <Receipt className="h-3 w-3" />}
                                        {l.sub}
                                      </span>
                                    </div>
                                    <div className="mt-[9px] flex items-center gap-2.5">
                                      <div className="min-w-0 flex-1">
                                        <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">
                                          Qty @ rate
                                        </div>
                                        <div
                                          className="doc-ref mt-1 text-[12.5px] font-bold"
                                          style={{ color: ret ? '#0B6B45' : '#0A1F17' }}
                                        >
                                          {formatNum(l.qty)} @ {formatINR(l.rate)}
                                        </div>
                                      </div>
                                      <div className="flex-none text-right">
                                        <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">
                                          Value
                                        </div>
                                        <div
                                          className="doc-ref mt-1 whitespace-nowrap text-[12.5px] font-bold"
                                          style={{ color: ret ? '#0B6B45' : '#0A1F17' }}
                                        >
                                          {formatINR(l.amount)}
                                        </div>
                                      </div>
                                    </div>
                                    <div className="doc-ref mt-[7px] text-[10.5px] font-semibold text-[#5A6B62]">
                                      {formatDate(l.date)}
                                      {l.company ? ` · ${l.company}` : ''}
                                    </div>
                                  </button>
                                )
                              })}
                              <div className="flex flex-col gap-2 bg-[#C7F03F] px-[13px] py-3">
                                <div className="flex items-center gap-[9px]">
                                  <span className="min-w-0 flex-1 text-[10px] font-extrabold uppercase tracking-[.09em] text-[#2E4A0B]">
                                    Net drawn
                                  </span>
                                  <span className="doc-ref whitespace-nowrap text-[13px] font-bold text-[#12280B]">
                                    {formatNum(net.qty)} {String(row.uom || 'MT')}
                                  </span>
                                </div>
                                {net.ret > 0.0005 && (
                                  <div className="text-[11px] font-bold leading-[1.45] text-[#2E4A0B]">
                                    {formatNum(net.out)} dispatched less {formatNum(net.ret)} returned — the net is what
                                    the bargain kept.
                                  </div>
                                )}
                              </div>
                            </>
                          ))}
                      </div>
                    )
                  })}
              </div>
            )
          })}

          {parties.length === 0 && (
            <div className="flex flex-none flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-10">
              <Receipt className="h-7 w-7 text-[#C3D2C6]" />
              <span className="text-center text-[12.5px] font-bold text-[#5A6B62]">
                No {sectionType === 'PACKED' ? 'packed' : 'loose'} bargain in this period.
              </span>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 flex flex-none gap-2.5 border-t border-t-[#D6E2D6] bg-white px-4 pb-6 pt-[11px]">
          <button
            type="button"
            onClick={openAdd}
            className="flex h-[50px] flex-1 items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13.5px] font-extrabold text-[#C7F03F]"
          >
            <Plus className="h-5 w-5" />
            New bargain
          </button>
        </div>
      </div>
    )
  })()

  return (
    <div>
      {rateCard}
      {/* THE DESKTOP BODY IS UNTOUCHED — not one line of it is edited. It is
          only given a mounting condition, so the phone can put its own body
          in its place while every dialog below stays shared: the bargain
          drawer, the adjust dialog and the SKU rate card are mounted once
          for both. Forking the whole return would have meant a second copy
          of four hundred lines of dialog, or a New bargain button that set
          state nothing was listening to. */}
      {!(__WEB__ && isMobile) && (
        <>
      <div className={cn('mb-2 flex flex-wrap items-center gap-x-2 gap-y-2', __WEB__ && '!mb-3 !gap-x-3')}>
      <div className={cn('inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1', __WEB__ && '!gap-0.5 !rounded-[4px] !border-[#DCE7DB] !bg-[#F1F5EF] !p-[3px]')}>
        {[{ v: 'ALL', label: 'All' }, ...saleCats].map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => setSectionCategory(t.v)}
            className={cn(
              'whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
              sectionCategory === t.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              __WEB__ && '!h-8 !rounded-[2px] !px-3 !text-[12.5px]',
              __WEB__ && (sectionCategory === t.v ? '!bg-white !font-extrabold !text-[#0A1F17] !shadow-none' : '!font-semibold !text-[#5A6B62] hover:!text-[#0A1F17]')
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
        {/* Loose vs Packed is a different kind of switch from the category
            chips beside it — it changes which register you are in, not which
            slice of one. The forest ground says so without a label. */}
        <div className={cn('inline-flex rounded-lg border p-0.5', __WEB__ && '!gap-0.5 !rounded-[4px] !border-0 !bg-[#0B3D2E] !p-[3px]')}>
          {(['LOOSE', 'PACKED'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSectionType(t)}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                sectionType === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                __WEB__ && '!h-8 !rounded-[2px] !px-4 !text-[12.5px] !font-extrabold',
                __WEB__ && (sectionType === t ? '!bg-[#C7F03F] !text-[#12280B]' : '!bg-transparent !text-[#8FBFA8] hover:!text-white')
              )}
            >
              {t === 'LOOSE' ? 'Loose' : 'Packed'}
            </button>
          ))}
        </div>
        <label className={cn('ml-auto flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] text-muted-foreground', __WEB__ && '!h-[38px] !gap-2.5 !rounded-[4px] !border !border-[#C3D2C6] !bg-white !px-3 !text-[12.5px] !font-bold !text-[#33473E] hover:!bg-[#F7FAF6]')}>
          <Switch checked={showZero} onCheckedChange={setShowZero} />
          Show settled {__WEB__ ? <span className="font-semibold text-[#7C9188]">(0 balance)</span> : '(0 balance)'}
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums',
              settledCount === 0 ? 'bg-muted text-muted-foreground' : 'bg-[#EAF0E9] text-[#33473E]'
            )}
          >
            {settledCount}
          </span>
        </label>
      </div>
      <div
        className={cn(
          'mb-4 flex flex-wrap items-center gap-x-2 gap-y-2',
          // The handoff's filter row: one white card, one height for every
          // control on it. The Switch above is outside this block, so no
          // :not() guard is needed here.
          __WEB__ &&
            '!mb-3.5 !gap-x-2.5 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3.5 !py-3 [&_input]:!h-9 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[12.5px] [&_button]:!h-9 [&_button]:!rounded-[4px] [&_button]:!text-[12.5px] [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!text-[12.5px]'
        )}
      >
        <div className="relative min-w-[180px] flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className={cn('h-8 pl-8 text-[12px]', __WEB__ && '!text-[12.5px] !font-semibold')}
            placeholder="Search bargain no, customer, product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className={cn('flex items-center gap-1.5 text-[12px]', __WEB__ && '!gap-2')}>
          <span className={cn('shrink-0 text-muted-foreground', __WEB__ && '!text-[10.5px] !font-extrabold !uppercase !tracking-[.13em] !text-[#5A6B62]')}>Date</span>
          <FyPicker
            from={dateFrom}
            to={dateTo}
            onRange={(f, t) => { setDateFrom(f); setDateTo(t) }}
            className={cn('h-8 w-36 shrink-0 text-[11px]', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}
          />
          <DatePicker
            value={dateFrom}
            onChange={(v) => setDateFrom(v || '')}
            max={dateTo || undefined}
            className={cn('h-8 w-40 shrink-0 text-[11px]', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}
          />
          <span className={cn('shrink-0 text-muted-foreground', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>to</span>
          <DatePicker
            value={dateTo}
            onChange={(v) => setDateTo(v || '')}
            min={dateFrom || undefined}
            className={cn('h-8 w-40 shrink-0 text-[11px]', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}
          />
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-8 text-muted-foreground', __WEB__ && '!px-2.5 !font-extrabold !uppercase !tracking-[.05em] !text-[#0B6B45]')}
              onClick={() => { setDateFrom(''); setDateTo('') }}
            >
              Clear
            </Button>
          )}
        </div>
        {companies.length > 1 && (
          <Select
            value={coIds.length === 1 ? String(coIds[0]) : 'all'}
            onValueChange={(v) => setCoIds(v === 'all' ? [] : [Number(v)])}
          >
            <SelectTrigger className={cn('h-8 w-[12rem] shrink-0 text-[12px]', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all" className="text-[12px]">All companies</SelectItem>
              {companies.map((c) => (
                <SelectItem key={String(c.id)} value={String(c.id)} className="text-[12px]">
                  {String(c.name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ExcelButton
            filename={`sales-bargains-${todayISO()}`}
            sheetName="Sales bargains"
            title="Sales bargains"
            columns={[
              { header: 'Bargain no', key: 'bargain_no', value: (r) => r.bargain_no || '' },
              { header: 'Manual no', key: 'manual_bargain_no', value: (r) => r.manual_bargain_no || '' },
              { header: 'Date', key: 'date', value: (r) => formatDate(r.bargain_date) },
              { header: 'Type', key: 'sale_category', value: (r) => saleCatLabel(r.sale_category) },
              { header: 'Customer', key: 'customer', value: (r) => r.customer || '' },
              { header: 'Product', key: 'product', value: (r) => r.product_name || '' },
              ...(companies.length > 1
                ? [{ header: 'Company', key: 'company_name', value: (r: Row) => String(r.company_name || '') }]
                : []),
              { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).opening },
              { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).addition },
              { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).adjusted },
              { header: 'Rate', key: 'rate', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.rate) || 0 },
              { header: 'Dispatch', key: 'dispatch', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).dispatch },
              { header: 'Return', key: 'ret', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).ret },
              { header: 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000', value: (r) => bargainRegister(r, F, T).closing }
            ]}
            rows={sortedRows}
            extraSheets={[
              {
                sheetName: 'Dispatches',
                title: 'Sales bargains — dispatch detail',
                columns: [
                  { header: 'Bargain no', key: 'bargain_no' },
                  { header: 'BG date', key: 'bargain_date' },
                  { header: 'Customer', key: 'customer' },
                  { header: 'Product', key: 'product' },
                  { header: 'BG rate', key: 'rate', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Addition', key: 'addition', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Adjusted', key: 'adjusted', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Invoice', key: 'invoice_no' },
                  { header: 'Company', key: 'company_name' },
                  { header: 'Dispatched on', key: 'sale_date' },
                  { header: 'Stage', key: 'stage' },
                  { header: 'Dis qty', key: 'qty', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Return', key: 'ret', align: 'right', numFmt: '#,##0.000' },
                  { header: 'Sale rate', key: 'sale_rate', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Value incl. GST', key: 'amount', align: 'right', numFmt: '#,##0.00' },
                  { header: 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000' }
                ],
                rows: dispatchDetailRows(),
                isGroup: (r) => !r.invoice_no,
                outlineDetail: true
              }
            ]}
          />
          <Button size="sm" onClick={openAdd} disabled={products.length === 0}>
            <Plus className="h-4 w-4" /> New sales bargain
          </Button>
        </div>
      </div>

      {/* Summary tiles. Every figure comes off `grand`, which is the sum of
          the same groupStats the rows below are drawn from — so a tile can
          never state something the table contradicts. */}
      {__WEB__ && sortedRows.length > 0 && (
        <div className="mb-3.5 overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
          <button
            type="button"
            aria-expanded={kpiOpen}
            onClick={() => setKpiOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3.5 py-2 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62] transition-colors hover:bg-[#F7FAF6]"
          >
            <ChevronDown className={cn('h-4 w-4 shrink-0 text-[#12855A] transition-transform', !kpiOpen && '-rotate-90')} />
            Summary
            <span className="ml-1 rounded-[2px] bg-[#EAF0E9] px-1.5 py-[2px] text-[11px] font-extrabold tracking-normal tabular-nums text-[#33473E]">
              {formatNum(grand.closing)} MT open
            </span>
          </button>
          {kpiOpen && (
        <div className="grid gap-2.5 px-3.5 pb-3.5 pt-1 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              k: 'Bargains open',
              v: String(grand.count),
              unit: '',
              sub: `across ${groupStats.size} customer${groupStats.size === 1 ? '' : 's'}`,
              accent: '#0B3D2E'
            },
            {
              k: 'Contracted',
              v: formatNum(grand.opening + grand.addition),
              unit: 'MT',
              sub: grand.adjusted ? `${formatNum(grand.adjusted)} MT adjusted` : 'no adjustments in range',
              accent: '#12855A'
            },
            {
              k: 'Net drawn',
              v: formatNum(grand.dispatch - grand.ret),
              unit: 'MT',
              sub: grand.ret > 0.0005
                ? `${formatNum(grand.dispatch)} dispatched · ${formatNum(grand.ret)} returned`
                : `${formatNum(grand.dispatch)} dispatched`,
              accent: '#C2700A'
            },
            {
              k: 'Balance remaining',
              v: formatNum(grand.closing),
              unit: 'MT',
              sub: (() => {
                const contracted = grand.opening + grand.addition + grand.adjusted
                if (contracted <= 0) return 'nothing contracted in range'
                return `${Math.round((grand.closing / contracted) * 100)}% of ${formatNum(contracted)} MT still open`
              })(),
              accent: '#C7F03F'
            }
          ].map((k) => (
            <div
              key={k.k}
              className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-3.5"
              style={{ borderTop: `3px solid ${k.accent}` }}
            >
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-[24px] font-bold leading-none tracking-[-0.035em] tabular-nums">{k.v}</span>
                {k.unit && <span className="text-[11.5px] font-bold text-[#7C9188]">{k.unit}</span>}
              </div>
              <div className="mt-1 text-[12px] font-semibold text-[#7C9188]">{k.sub}</div>
            </div>
          ))}
        </div>
          )}
        </div>
      )}

      {/* Same twelve columns the team reads every day — the website restyles
          them, it does not re-cut them. Anything the handoff folded together
          (Opening+Addition, Dispatch/Return) stays as its own column here. */}
      <div className={cn('rounded-lg border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
        {/* Nothing wraps: a bargain number broken over three lines and a date
            stacked day/month/year are unreadable, and they made every row in
            the register three times as tall. The wrapper already scrolls, so
            the table slides sideways instead when it does not fit. */}
        <Table
          wrapperClassName={cn('rounded-lg', __WEB__ && '!rounded-[4px]')}
          className={cn(
            'min-w-[1180px] text-[13px]',
            __WEB__ && cn(SB_CELLS, !q && openGroups.size === 0 && SB_FIT)
          )}
        >
          {/* Fixed widths, because table-fixed reads the first row and this
              header's first row is the band, whose cells span several columns
              at a time — so a colgroup is the only place they can live. They
              add to 1074, the table's floor, so a 13" screen fits without
              zooming out and anything narrower slides. */}
          {__WEB__ && !q && openGroups.size === 0 && (
            <colgroup>
              {[110, 80, 96, 116, 78, 80, 80, 104, 84, 76, 96, 74].map((w, i) => (
                <col key={i} style={{ width: `${w}px` }} />
              ))}
            </colgroup>
          )}
          <TableHeader className={cn(__WEB__ && '!bg-[#0B3D2E] [&_th]:!h-10 [&_th]:!text-[10.5px] [&_th]:!font-semibold [&_th]:!uppercase [&_th]:!tracking-[.04em] [&_th]:!text-[#DCEFE4]')}>
            {/* A band naming what the column sets below mean, so Opening /
                Addition / Adjusted read as one idea and Dispatch / Return as
                another — without renaming or merging any column. */}
            {__WEB__ && (
              <TableRow className="!border-b-0 !bg-[#072B20] hover:!bg-[#072B20] [&>th]:!h-[30px] [&>th]:!text-[9.5px] [&>th]:!tracking-[.16em] [&>th]:!text-white">
                <TableHead colSpan={4} />
                <TableHead colSpan={3} className={cn('!text-center', SB_HGL, '!border-r !border-r-[#C7F03F]/20')}>Contracted qty</TableHead>
                <TableHead />
                <TableHead colSpan={2} className={cn('!text-center', SB_HGL, '!border-r !border-r-[#C7F03F]/20')}>Movement</TableHead>
                <TableHead className="!bg-[#C7F03F]/10 !text-center !text-[#C7F03F]">Open</TableHead>
                <TableHead />
              </TableRow>
            )}
            <TableRow className={cn(__WEB__ && '!border-b-0 hover:!bg-[#0B3D2E]')}>
              <TableHead>Bargain no</TableHead>
              <TableHead>Manual no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SB_HGL)}>Opening</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SB_HG)}>Addition</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SB_HGR)}>Adjusted</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SB_HGL)}>Dispatch</TableHead>
              <TableHead className={cn('text-right', __WEB__ && SB_HGR)}>Return</TableHead>
              <TableHead className={cn('text-right', __WEB__ && '!bg-[#C7F03F]/10 !text-[#C7F03F]')}>Balance</TableHead>
              <TableHead className={cn('w-[110px] text-right', __WEB__ && '!w-auto')}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="py-10 text-center text-muted-foreground">
                  {rows.length === 0 ? 'No sales bargains yet.' : 'No sales bargains in this period.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                <TableRow
                  className={cn(
                    'border-y-2 border-amber-500 bg-amber-100 hover:bg-amber-100',
                    __WEB__ && '!border-y-0 !border-b-2 !border-b-[#0B3D2E] !bg-[#EDF7D4] hover:!bg-[#EDF7D4] [&>td]:!h-[42px] [&>td]:!text-[13px] [&>td]:!text-[#2E4A0B]'
                  )}
                >
                  <TableCell colSpan={4} className={cn('py-2 text-xs font-bold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[11px] !font-extrabold !tracking-[.1em] !text-[#2E4A0B]')}>
                    Grand total
                    <span className={cn('ml-1 font-medium normal-case tracking-normal text-amber-700', __WEB__ && '!ml-1.5 !font-semibold !text-[12px] !text-[#5B7226]')}>
                      · {grand.count} bargain{grand.count === 1 ? '' : 's'}
                    </span>
                  </TableCell>
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-l !border-l-[#CBE0A0] !text-[13px] !text-[#7E9450]')}>{formatNum(grand.opening)}</TableCell>
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !text-[13.5px] !text-[#2E4A0B]')}>{formatNum(grand.addition)}</TableCell>
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-r !border-r-[#CBE0A0] !text-[13.5px]', __WEB__ && (grand.adjusted ? '!text-[#8A5300]' : '!text-[#7E9450]'))}>{formatNum(grand.adjusted)}</TableCell>
                  <TableCell className="py-2" />
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#E4F2C3] !border-l !border-l-[#CBE0A0] !text-[13.5px] !text-[#2E4A0B]')}>{formatNum(grand.dispatch)}</TableCell>
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-emerald-800', __WEB__ && '!bg-[#E4F2C3] !border-r !border-r-[#CBE0A0] !text-[13.5px]', __WEB__ && (grand.ret > 0.0005 ? '!text-[#8A5300]' : '!text-[#7E9450]'))}>
                    {grand.ret > 0.0005 ? formatNum(grand.ret) : '0'}
                  </TableCell>
                  <TableCell className={cn('py-2 text-right text-xs font-bold tabular-nums text-amber-900', __WEB__ && '!bg-[#C7F03F] !text-[14.5px] !tracking-[-0.02em] !text-[#12280B]')}>
                    {formatNum(grand.closing)} {__WEB__ ? <span className="text-[10.5px] font-semibold text-[#5A6B62]">MT</span> : 'MT'}
                  </TableCell>
                  <TableCell className="py-2" />
                </TableRow>
                {sortedRows.map((row, i) => {
                  const grp = String(row.customer || '—')
                  const newGroup = i === 0 || grp !== String(sortedRows[i - 1].customer || '—')
                  const isCollapsed = !q && !openGroups.has(grp)
                  const g = groupStats.get(grp)
                  // Serial number within the customer group (1-based).
                  const seq = sortedRows.slice(0, i + 1).filter((r) => String(r.customer || '—') === grp).length
                  const bgOpen = expandedBg.has(Number(row.id))
                  return (
                    <Fragment key={row.id as number}>
                      {newGroup && (
                        <TableRow
                          className={cn(
                            'cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70',
                            // A customer band, not a second header: a forest
                            // left edge when open marks which rows below
                            // belong to it, the way the group cards on
                            // Purchases do.
                            __WEB__ && '!border-y-0 !border-b !border-b-[#DCE7DB] !border-l-[3px] [&>td]:!h-[42px]',
                            __WEB__ && (isCollapsed ? '!border-l-transparent !bg-[#F7FAF6] hover:!bg-[#F1F5EF]' : '!border-l-[#0B3D2E] !bg-[#F1F5EF] hover:!bg-[#F1F5EF]')
                          )}
                          onClick={() => toggleGroup(grp)}
                        >
                          <TableCell colSpan={4} className="py-1.5">
                            <span className={cn('inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700', __WEB__ && '!gap-2.5 !text-[13px] !font-extrabold !normal-case !tracking-[-0.01em] !text-[#0A1F17]')}>
                              {isCollapsed ? <ChevronRight className={cn('h-3.5 w-3.5', __WEB__ && '!h-[18px] !w-[18px] !text-[#7C9188]')} /> : <ChevronDown className={cn('h-3.5 w-3.5', __WEB__ && '!h-[18px] !w-[18px] !text-[#7C9188]')} />}
                              {grp}
                              <span className={cn('font-medium normal-case tracking-normal text-slate-500', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>
                                · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-l !border-l-[#DCE7DB] !text-[12.5px] !text-[#8AA096]')}>{formatNum(g?.opening ?? 0)}</TableCell>
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!text-[13px] !text-[#0A1F17]')}>{formatNum(g?.addition ?? 0)}</TableCell>
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-r !border-r-[#DCE7DB] !text-[13px]', __WEB__ && ((g?.adjusted ?? 0) ? '!text-[#8A5300]' : '!text-[#8AA096]'))}>{formatNum(g?.adjusted ?? 0)}</TableCell>
                          <TableCell className="py-1.5" />
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && '!border-l !border-l-[#DCE7DB] !text-[13px] !text-[#0A1F17]')}>{formatNum(g?.dispatch ?? 0)}</TableCell>
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-emerald-800', __WEB__ && '!border-r !border-r-[#DCE7DB] !text-[13px]', __WEB__ && ((g?.ret ?? 0) > 0.0005 ? '!text-[#8A5300]' : '!text-[#8AA096]'))}>
                            {(g?.ret ?? 0) > 0.0005 ? formatNum(g?.ret ?? 0) : '0'}
                          </TableCell>
                          <TableCell className={cn('py-1.5 text-right text-xs font-bold tabular-nums text-slate-700', __WEB__ && SB_BAL, __WEB__ && '!text-[13.5px] !text-[#0A1F17]')}>
                            {__WEB__ ? (
                              <div>{formatNum(g?.closing ?? 0)} <span className="text-[10.5px] font-semibold text-[#5A6B62]">{g?.uom || 'MT'}</span></div>
                            ) : <>{formatNum(g?.closing ?? 0)} {g?.uom || 'MT'}</>}
                          </TableCell>
                          <TableCell className="py-1.5" />
                        </TableRow>
                      )}
                      {!isCollapsed && (() => {
                        const reg = bargainRegister(row, F, T)
                        return (
                        <TableRow
                          className={cn(
                            'cursor-pointer',
                            bgOpen && 'bg-slate-100 hover:bg-slate-100',
                            __WEB__ && '!border-b-[#EAF0E9] [&>td]:!py-2.5',
                            __WEB__ && (bgOpen ? '!bg-[#F7FAF6] hover:!bg-[#F7FAF6]' : 'hover:!bg-[#F7FAF6]')
                          )}
                          onClick={() => toggleBg(Number(row.id))}
                        >
                          <TableCell className={cn('font-medium', __WEB__ && '!min-w-[300px] !text-[13.5px] !font-bold')}>
                            <span className="inline-flex items-center gap-1.5">
                              {bgOpen ? <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground', __WEB__ && '!h-4 !w-4 !text-[#A8B8AE]')} /> : <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground', __WEB__ && '!h-4 !w-4 !text-[#A8B8AE]')} />}
                              <span className={cn('tabular-nums text-muted-foreground', __WEB__ && '!text-[11.5px] !font-bold !text-[#A8B8AE]')}>{seq}.</span>
                              {row.bargain_no}
                              {rateExpired(row) && Number(row.balance_qty) > 0 && (
                                <span
                                  className={cn(
                                    'rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800',
                                    __WEB__ && '!rounded-[2px] !bg-[#FFEDD0] !px-1.5 !py-[3px] !text-[10.5px] !font-extrabold !tracking-[.05em] !text-[#8A5300]'
                                  )}
                                  title={`The rate expired on ${formatDate(row.rate_expiry_date)} — it is still offered on a sale, marked as expired`}
                                >
                                  Rate expired
                                </span>
                              )}
                              {/* How far this contract is drawn, only once it
                                  is close — a percentage on every row is noise,
                                  on the nearly-finished ones it is the point. */}
                              {__WEB__ && (() => {
                                const b = sbBar(reg.opening, reg.addition, reg.adjusted, reg.dispatch, reg.ret)
                                if (b.pct < 90 || reg.closing <= 1e-9) return null
                                return (
                                  <span
                                    className="shrink-0 rounded-[2px] bg-[#FFEDD0] px-1.5 py-[3px] text-[9.5px] font-extrabold tracking-[.05em] text-[#8A5300]"
                                    title="Nearly drawn"
                                  >
                                    {Math.round(b.pct)}%
                                  </span>
                                )
                              })()}
                            </span>
                          </TableCell>
                          <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-inherit')}>
                            {__WEB__ && row.manual_bargain_no ? (
                              <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[12px] font-bold tabular-nums text-[#33473E]">
                                {String(row.manual_bargain_no)}
                              </span>
                            ) : (row.manual_bargain_no || '—')}
                          </TableCell>
                          <TableCell className={cn(__WEB__ && '!text-[12.5px] !font-semibold !tabular-nums')}>{formatDate(row.bargain_date)}</TableCell>
                          <TableCell>
                            {__WEB__ ? (
                              <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-1 text-[11px] font-extrabold tracking-[.05em] text-[#33473E]">
                                {row.product_name || '—'}
                              </span>
                            ) : (row.product_name || '—')}
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && SB_GL, __WEB__ && (reg.opening ? '!text-[13px] !font-bold !text-[#0A1F17]' : '!text-[13px] !font-medium !text-[#C3D2C6]'))}>{reg.opening ? formatNum(reg.opening) : '—'}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && SB_G, __WEB__ && '!text-[13.5px] !font-bold')}>{reg.addition ? formatNum(reg.addition) : '—'}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && SB_GR, __WEB__ && (reg.adjusted ? '!text-[13px] !font-bold' : '!text-[13px] !font-medium !text-[#C3D2C6]'))}>
                            <span className={cn(reg.adjusted < -1e-9 ? 'text-red-600' : reg.adjusted > 0 ? 'text-emerald-700' : '', __WEB__ && reg.adjusted !== 0 && '!text-[#8A5300]')}>
                              {reg.adjusted ? formatNum(reg.adjusted) : '—'}
                            </span>
                            {Math.abs(reg.futureAdjusted) > 1e-9 && (
                              <span
                                className="ml-1 text-[10px] font-medium text-amber-600"
                                title={`Adjustment of ${formatNum(reg.futureAdjusted)} dated after ${formatDate(T)} — widen the date range to include it`}
                              >
                                ({reg.futureAdjusted > 0 ? '+' : ''}{formatNum(reg.futureAdjusted)} later)
                              </span>
                            )}
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[13px] !font-bold')}>{formatINR(row.rate)}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', reg.dispatch && 'font-bold text-red-600', __WEB__ && SB_GL, __WEB__ && (reg.dispatch ? '!text-[13.5px] !font-bold !text-[#0A1F17]' : '!text-[13px] !font-medium !text-[#C3D2C6]'))}>{reg.dispatch ? formatNum(reg.dispatch) : '—'}</TableCell>
                          <TableCell
                            className={cn('text-right tabular-nums', reg.ret && 'font-bold text-emerald-700', __WEB__ && SB_GR, __WEB__ && (reg.ret ? '!text-[13px] !font-bold !text-[#8A5300]' : '!text-[13px] !font-medium !text-[#C3D2C6]'))}
                            title={reg.ret ? 'Came back on a customer credit note — added back to the balance' : undefined}
                          >
                            {reg.ret ? formatNum(reg.ret) : '—'}
                          </TableCell>
                          <TableCell className={cn('text-right font-medium tabular-nums', __WEB__ && SB_BAL)}>
                            {__WEB__ ? (() => {
                              const b = sbBar(reg.opening, reg.addition, reg.adjusted, reg.dispatch, reg.ret)
                              return (
                                <>
                                  <div className={cn('text-[14px] font-bold tracking-[-0.01em]', reg.closing < -1e-9 ? 'text-[#B3261E]' : b.pct >= 90 ? 'text-[#8A5300]' : 'text-[#0A1F17]')}>
                                    {formatNum(reg.closing)}
                                  </div>
                                </>
                              )
                            })() : <span className={reg.closing < -1e-9 ? 'text-red-600' : ''}>{formatNum(reg.closing)}</span>}
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end">
                              <RowActions
                                actions={[
                                  { label: 'SKU rate card', icon: Tags, onClick: () => void openRates(row) },
                                  { label: 'Add / remove balance qty', icon: SlidersHorizontal, onClick: () => openAdjust(row) },
                                  { label: 'Edit bargain', icon: Pencil, onClick: () => openEdit(row) },
                                  { label: 'Delete bargain', icon: Trash2, danger: true, onClick: () => del(row) }
                                ]}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                        )
                      })()}
                      {!isCollapsed && bgOpen && (
                        <TableRow className="bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={12} className="p-0">
                            {(() => {
                              const disp = dispatchesByBargain.get(Number(row.id)) || []
                              const tot = disp.reduce(
                                (s, d) => {
                                  s.qty += Number(d.qty) || 0
                                  s.amount += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
                                  return s
                                },
                                { qty: 0, amount: 0 }
                              )
                              // One row per invoice — a split invoice draws the
                              // bargain down over several lines, which used to
                              // show as that many rows here. Qty and amount sum
                              // across the invoice's lines; rate is the
                              // qty-weighted average (taxable amount / qty), not
                              // just the first line's rate.
                              const byInvoice = new Map<string, { id: number; invoice_no: string; sale_date: string; sample: Row; qty: number; taxable: number; total: number }>()
                              for (const d of disp) {
                                const key = String(d.invoice_group || d.invoice_no || d.id)
                                if (!byInvoice.has(key)) {
                                  byInvoice.set(key, { id: Number(d.id), invoice_no: d.invoice_no, sale_date: d.sale_date, sample: d, qty: 0, taxable: 0, total: 0 })
                                }
                                const g = byInvoice.get(key)!
                                g.qty += Number(d.qty) || 0
                                g.taxable += Number(d.amount) || 0
                                g.total += (Number(d.amount) || 0) + (Number(d.gst_amount) || 0)
                              }
                              const retLines = returnsByBargain.get(Number(row.id)) || []
                              // Dispatches and returns are the same story told in
                              // date order, so they share one table: a return is a
                              // negative line, and the total is what the bargain
                              // actually kept rather than the gross it shipped.
                              type Line = {
                                key: string
                                id: number
                                kind: 'out' | 'ret'
                                label: string
                                sub: string
                                date: string
                                qty: number
                                rate: number
                                amount: number
                                uom: string
                                company: string
                                companyColour: string
                                companyId: number
                              }
                              const lines: Line[] = [
                                ...Array.from(byInvoice.values()).map((g): Line => ({
                                  key: `d${g.id}`,
                                  id: g.id,
                                  kind: 'out',
                                  label: String(g.invoice_no || '—'),
                                  sub: stageInfo(g.sample).label,
                                  date: String(g.sale_date || ''),
                                  qty: g.qty,
                                  rate: g.qty > 0 ? g.taxable / g.qty : 0,
                                  amount: g.total,
                                  uom: String(g.sample.uom || row.uom || 'MT'),
                                  company: coNameOf(g.sample.company_id),
                                  companyColour: coColourOf(g.sample.company_id),
                                  companyId: Number(g.sample.company_id) || 0
                                })),
                                ...retLines.map((rl, ri): Line => ({
                                  key: `r${rl.note_id}-${ri}`,
                                  id: 0,
                                  kind: 'ret',
                                  label: String(rl.note_no || 'CN'),
                                  sub: rl.explicit_bargain_id
                                    ? 'Return · named on the note'
                                    : `Return vs ${String(rl.against_ref || '—')}`,
                                  date: String(rl.note_date || ''),
                                  qty: -(Number(rl.qty) || 0),
                                  rate: Number(rl.rate) || 0,
                                  // Inclusive of GST, matching the dispatch rows
                                  // this column already states that way.
                                  amount: -(Number(rl.amount_incl ?? rl.amount) || 0),
                                  uom: String(row.uom || 'MT'),
                                  company: coNameOf(rl.company_id),
                                  companyColour: coColourOf(rl.company_id),
                                  companyId: Number(rl.company_id) || 0
                                }))
                              ].sort((x, y) => x.date.localeCompare(y.date) || x.key.localeCompare(y.key))
                              const net = lines.reduce(
                                (acc, l) => {
                                  acc.qty += l.qty
                                  acc.amount += l.amount
                                  if (l.kind === 'ret') acc.ret += -l.qty
                                  else acc.out += l.qty
                                  return acc
                                },
                                { qty: 0, amount: 0, out: 0, ret: 0 }
                              )
                              return (
                                <div className={cn('bg-muted/20 px-6 py-3', __WEB__ && '!border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !py-3.5 !pl-10 !pr-4')}>
                                  {row.note && <p className={cn('pb-2 text-xs text-muted-foreground', __WEB__ && '!pb-2.5 !text-[12.5px] !font-semibold !text-[#5A6B62]')}><span className={cn('font-semibold', __WEB__ && '!font-extrabold !text-[#33473E]')}>Note:</span> {row.note}</p>}
                                  {lines.length === 0 ? (
                                    <p className={cn('text-xs text-muted-foreground', __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-4 !py-5 !text-center !text-[13px] !font-semibold !text-[#7C9188]')}>No dispatches on this bargain yet.</p>
                                  ) : (
                                    <div className={cn(__WEB__ && 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white')}>
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className={cn('border-b text-left text-muted-foreground', __WEB__ && '!border-b-[#D6E2D6] !bg-[#EAF0E9] [&>th]:!h-[34px] [&>th]:!py-0 [&>th]:!text-[10px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-[#33473E]')}>
                                          <th className={cn('w-8 py-1.5 pr-3 font-semibold', __WEB__ && '!pl-3')}>#</th>
                                          <th className="py-1.5 pr-3 font-semibold">Invoice / Note</th>
                                          <th className="py-1.5 pr-3 font-semibold">Date</th>
                                          <th className="py-1.5 pr-3 font-semibold">Stage</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Qty</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                                          <th className={cn('py-1.5 text-right font-semibold', __WEB__ && '!pr-3')}>Amount</th>
                                          <th className={cn('py-1.5 pr-3 font-semibold', __WEB__ && '!pr-3')}>Company</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {lines.map((l, di) => {
                                          const isRet = l.kind === 'ret'
                                          return (
                                            <tr
                                              key={l.key}
                                              className={cn(
                                                'border-b last:border-0',
                                                isRet && 'bg-emerald-50/60',
                                                !isRet && onOpenSale && 'cursor-pointer hover:bg-muted/40',
                                                __WEB__ && '!border-b-[#EAF0E9] [&>td]:!h-[42px] [&>td]:!py-0',
                                                __WEB__ && (isRet ? '!bg-[#E9F5EE]/50' : onOpenSale && 'hover:!bg-[#F7FAF6]')
                                              )}
                                              title={isRet ? 'Returned on a credit note — added back to the balance' : onOpenSale ? 'Open this sale invoice' : undefined}
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                if (!isRet) onOpenSale?.(l.id, l.companyId || undefined)
                                              }}
                                            >
                                              <td className={cn('py-1.5 pr-3 tabular-nums text-muted-foreground', __WEB__ && '!pl-3 !text-[10px] !font-bold !text-[#A8B8AE]')}>{di + 1}</td>
                                              <td className={cn('py-1.5 pr-3 font-medium', __WEB__ && '!text-[13px] !font-bold')}>
                                                <span className="inline-flex items-center gap-1.5">
                                                  {l.label}
                                                  {isRet && (
                                                    <span className={cn('rounded bg-emerald-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-800', __WEB__ && '!rounded-[2px] !bg-[#BFE3CB] !px-1.5 !py-[2px] !text-[9.5px] !font-extrabold !tracking-[.05em] !text-[#0B6B45]')}>
                                                      return
                                                    </span>
                                                  )}
                                                </span>
                                              </td>
                                              <td className={cn('whitespace-nowrap py-1.5 pr-3', __WEB__ && '!text-[12px] !font-medium !tabular-nums !text-[#5A6B62]')}>{formatDate(l.date)}</td>
                                              <td className={cn('py-1.5 pr-3', isRet && 'text-emerald-800')}>
                                                {__WEB__ ? (
                                                  <span
                                                    className={cn(
                                                      'inline-block rounded-[2px] px-2 py-1 text-[10.5px] font-extrabold tracking-[.04em]',
                                                      isRet ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#FFEDD0] text-[#8A5300]'
                                                    )}
                                                  >
                                                    {l.sub}
                                                  </span>
                                                ) : l.sub}
                                              </td>
                                              <td
                                                className={cn(
                                                  'py-1.5 pr-3 text-right font-medium tabular-nums',
                                                  isRet ? 'text-emerald-700' : 'text-red-600',
                                                  __WEB__ && '!text-[13px] !font-bold',
                                                  __WEB__ && (isRet ? '!text-[#0B6B45]' : '!text-[#0A1F17]')
                                                )}
                                              >
                                                {isRet ? '+' : ''}{formatNum(Math.abs(l.qty))}{' '}
                                                <span className={cn(__WEB__ && '!text-[10.5px] !font-semibold !text-[#7C9188]')}>{l.uom}</span>
                                              </td>
                                              <td className={cn('py-1.5 pr-3 text-right tabular-nums', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>{formatINR(l.rate)}</td>
                                              <td className={cn('py-1.5 pr-3 text-right tabular-nums', isRet && 'text-emerald-700', __WEB__ && '!text-[13px] !font-bold', __WEB__ && isRet && '!text-[#0B6B45]')}>
                                                {isRet ? '−' : ''}{formatINR(Math.abs(l.amount))}
                                              </td>
                                              {/* Whose book this dispatch landed in. A blank means
                                                  the line predates multi-company, not that nobody
                                                  owns it. */}
                                              <td className={cn('py-1.5 pr-3 whitespace-nowrap', __WEB__ && '!text-[12px] !font-bold !text-[#33473E]')}>
                                                {!l.company ? (
                                                  <span className={cn(__WEB__ && '!font-semibold !text-[#A8B8AE]')}>—</span>
                                                ) : __WEB__ && l.companyColour ? (
                                                  // Filled chip, see Bargains for why the colour is
                                                  // the ground and not the ink.
                                                  <span
                                                    className="inline-block whitespace-nowrap rounded-[2px] px-2 py-[3px] text-[11px] font-bold"
                                                    style={{ background: l.companyColour, color: inkOn(l.companyColour) }}
                                                  >
                                                    {l.company}
                                                  </span>
                                                ) : (
                                                  l.company
                                                )}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                        {/* The lime band the handoff closes this table with: what the
                                            bargain actually kept, not the gross it shipped. */}
                                        <tr className={cn('border-t-2 font-semibold', __WEB__ && '!border-t-0 !bg-[#C7F03F] [&>td]:!h-[44px] [&>td]:!py-0 [&>td]:!text-[#12280B]')}>
                                          <td className={cn('py-1.5 pr-3', __WEB__ && '!pl-3 !text-[10.5px] !font-extrabold !uppercase !tracking-[.09em] !text-[#2E4A0B]')} colSpan={4}>
                                            Net drawn
                                            {net.ret > 0.0005 && (
                                              <span className={cn('ml-1.5 font-normal text-muted-foreground', __WEB__ && '!ml-2 !font-bold !normal-case !tracking-normal !text-[11px] !text-[#3F5C13]')}>
                                                · {formatNum(net.out)} dispatched less {formatNum(net.ret)} returned
                                              </span>
                                            )}
                                          </td>
                                          <td className={cn('py-1.5 pr-3 text-right tabular-nums text-red-600', __WEB__ && '!text-[14px] !font-bold !text-[#12280B]')}>
                                            {formatNum(net.qty)} <span className={cn(__WEB__ && '!text-[10.5px]')}>{row.uom}</span>
                                          </td>
                                          <td className="py-1.5" />
                                          <td className={cn('py-1.5 pr-3 text-right tabular-nums', __WEB__ && '!text-[14.5px] !font-bold !tracking-[-0.02em] !text-[#12280B]')}>{formatINR(net.amount)}</td>
                                          <td className="py-1.5 pr-3" />
                                        </tr>
                                      </tbody>
                                    </table>
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </>
            )}
          </TableBody>
        </Table>
        {/* Footer strip: what the register adds up to, and one control for the
            carets. Expand all writes the same openGroups set the caret clicks
            already write — no second piece of state to fall out of step. */}
        {__WEB__ && sortedRows.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-[#EAF0E9] px-4 py-3">
            <div className="text-[12px] font-semibold text-[#5A6B62]">
              {grand.count} bargain{grand.count === 1 ? '' : 's'} · {formatNum(grand.opening + grand.addition + grand.adjusted)} MT contracted ·{' '}
              {formatNum(grand.closing)} MT balance
            </div>
            {(() => {
              const parties = Array.from(new Set(sortedRows.map((r) => String(r.customer || '—'))))
              const allOpen = parties.length > 0 && parties.every((p) => openGroups.has(p))
              return (
                <button
                  type="button"
                  onClick={() => setOpenGroups(allOpen ? new Set<string>() : new Set(parties))}
                  className="flex items-center gap-1.5 text-[11.5px] font-extrabold uppercase tracking-[.05em] text-[#0B6B45] transition-colors hover:text-[#0B3D2E]"
                >
                  <ChevronDown className={cn('h-[18px] w-[18px] transition-transform', allOpen && 'rotate-180')} />
                  {allOpen ? 'Collapse all' : 'Expand all'}
                </button>
              )
            })()}
          </div>
        )}
      </div>
        </>
      )}
      {__WEB__ && isMobile && mobileBody}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            'max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto',
            // A right-hand drawer on the website: four section cards read
            // better in a tall column than as a wide box over the register,
            // and the footer can then stay in view while the form scrolls.
            __WEB__ &&
              '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[620px] !max-w-[95vw] !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Sales bargain</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1.5 !text-[20px] !font-extrabold !tracking-[-0.02em] !text-white')}>
              {editing ? `Edit ${editing.bargain_no}` : 'New sales bargain'}
            </DialogTitle>
          </DialogHeader>
          {editLocked && !__WEB__ && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {formatNum(editSold)} {editing?.uom || 'MT'} is already sold on this bargain — customer and product are locked, and the quantity can&apos;t go below {formatNum(editSold)}.
            </div>
          )}
          {/* One field tree, two layouts. Each field is built once below and
              then placed either in the desktop's flat two-column grid or in
              the website's section cards — so the two can never drift on
              which fields exist, what they are bound to, or when they show. */}
          {(() => {
          const fDate = (
            <div className="flex flex-col gap-1.5">
              <Label>Date</Label>
              <DatePicker min={minDate} value={form.bargain_date} onChange={(v) => setField('bargain_date', v)} />
            </div>
          )
          const fCustomer = (
            <div className="flex flex-col gap-1.5">
              <Label>Customer *</Label>
              <Select
                value={form.customer_id ? String(form.customer_id) : (form.customer ? 'legacy' : '')}
                onValueChange={(v) => {
                  if (v === 'legacy') return
                  const cust = customers.find((c) => String(c.id) === v)
                  setForm((p) => ({
                    ...p,
                    customer_id: v,
                    customer: cust?.name ?? p.customer,
                    gst_pct: p.gst_pct || (cust && Number(cust.gst_pct) > 0 ? cust.gst_pct : p.gst_pct)
                  }))
                }}
                disabled={editLocked}
              >
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {!form.customer_id && form.customer && (
                    <SelectItem value="legacy">{String(form.customer)} (unlinked — re-select to link)</SelectItem>
                  )}
                  {bargainCustomers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )
          const fType = (
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select value={form.sale_category || 'FINISHED_OIL'} onValueChange={(v) => setField('sale_category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {saleCats.map((c) => <SelectItem key={c.v} value={c.v}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )
          const fProduct = (
            <div className="flex flex-col gap-1.5">
              <Label>Product *</Label>
              <Select value={String(form.product_id)} onValueChange={(v) => setField('product_id', v)} disabled={editLocked}>
                <SelectTrigger><SelectValue placeholder="Product" /></SelectTrigger>
                <SelectContent>
                  {/* Says why the list is empty rather than opening a blank
                      panel that reads as the dropdown being broken. */}
                  {formProducts.length === 0 ? (
                    <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                      No product in {saleCatLabel(form.sale_category || 'FINISHED_OIL')}. Add one under Masters → Products.
                    </div>
                  ) : (
                    formProducts.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)
                  )}
                </SelectContent>
              </Select>
            </div>
          )
          const fQty = (
            <div className="flex flex-col gap-1.5">
              <Label>Qty *</Label>
              <Input type="number" min={editLocked ? editSold : 0} value={form.qty ?? ''} onChange={(e) => setField('qty', e.target.value)} />
              {editLocked && Number(form.qty) < editSold - 1e-4 && (
                <span className="text-[11px] text-red-600">Cannot be below {formatNum(editSold)} already sold.</span>
              )}
            </div>
          )
          const fUom = (
            <div className="flex flex-col gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom || 'MT'} onChange={(v) => setField('uom', v)} allowAdd={false} />
            </div>
          )
          const fRate = (
            <div className="flex flex-col gap-1.5">
              <Label>Rate *</Label>
              <Input type="number" value={form.rate ?? ''} onChange={(e) => setField('rate', e.target.value)} />
            </div>
          )
          const fGstPct = (
            <div className="flex flex-col gap-1.5">
              <Label>GST %</Label>
              <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setField('gst_pct', e.target.value)} />
            </div>
          )
          const fGstType = (
            <div className="flex flex-col gap-1.5">
              <Label>GST type</Label>
              <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setField('gst_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                  <SelectItem value="IGST">IGST</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
          const fExpiry = (
            <div className="flex flex-col gap-1.5">
              <Label>Rate expiry</Label>
              {/* Nothing on or before the bargain date is selectable, and an
                  expiry already set that a later change to the bargain date has
                  invalidated is called out rather than silently discarded. */}
              <DatePicker
                value={form.rate_expiry_date ?? ''}
                min={dayAfter(form.bargain_date)}
                onChange={(v) => setField('rate_expiry_date', v)}
              />
              {expiryProblem && <div className="text-[11px] font-medium text-destructive">{expiryProblem}</div>}
            </div>
          )
          const fManual = (
            <div className="flex flex-col gap-1.5">
              <Label>Manual bargain no <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                value={form.manual_bargain_no ?? ''}
                onChange={(e) => setField('manual_bargain_no', e.target.value)}
                placeholder="e.g. the party's own reference"
              />
            </div>
          )
          const fSaleType = (
            <div className="flex flex-col gap-1.5">
              <Label>Sale type</Label>
              <Select value={form.sale_type || 'LOOSE'} onValueChange={(v) => setField('sale_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOOSE">Loose (bulk)</SelectItem>
                  <SelectItem value="PACKED">Packed (box / pouch)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
          const fFreight = (
            <div className="flex flex-col gap-1.5">
              <Label>Freight term</Label>
              <Select value={form.freight_term || 'FREIGHT_ON_GOODS'} onValueChange={(v) => setField('freight_term', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREIGHT_ON_GOODS">Ex (customer lifts)</SelectItem>
                  <SelectItem value="DLD">FOR (we deliver)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
          {/* Agreed once here rather than retyped on every invoice drawn
              against the contract. Only a delivered sale is weighed again at
              the far end, so only FOR has anything to allow. */}
          const fShortage = form.freight_term === 'DLD' ? (
            <div className="flex flex-col gap-1.5">
              <Label>Shortage allowed %</Label>
              <Input
                type="number"
                step="0.01"
                value={form.allowed_shortage_pct ?? ''}
                onChange={(e) => setField('allowed_shortage_pct', e.target.value)}
                placeholder="blank — use the mill default"
              />
              <span className="text-[10px] text-muted-foreground">
                Transit loss this customer accepts. Anything short beyond it is deductible.
              </span>
            </div>
          ) : null
          const fPackaging = form.sale_type === 'PACKED' ? (
            <div className={cn('flex flex-col gap-1.5', !__WEB__ && 'sm:col-span-2', __WEB__ && 'col-span-2')}>
              <Label>Default packaging</Label>
              <Select value={form.packaging_id ? String(form.packaging_id) : ''} onValueChange={(v) => setField('packaging_id', v)}>
                <SelectTrigger><SelectValue placeholder="Select packaging" /></SelectTrigger>
                <SelectContent>
                  {packagings.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null
          const fNote = (
            <div className={cn('flex flex-col gap-1.5', !__WEB__ && 'sm:col-span-2')}>
              <Label>Note</Label>
              <Input value={form.note ?? ''} onChange={(e) => setField('note', e.target.value)} />
            </div>
          )
          const termsHint = (
            <p className="text-[11px] text-muted-foreground">Sale type and freight term default onto each dispatch under this bargain — you can still override them per sale.</p>
          )

          if (!__WEB__) {
            return (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {fDate}{fCustomer}{fType}{fProduct}{fQty}{fUom}{fRate}{fGstPct}{fGstType}{fExpiry}
                  {fManual}{fSaleType}{fFreight}{fShortage}{fPackaging}{fNote}
                </div>
                {termsHint}
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                  <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                </DialogFooter>
              </>
            )
          }

          // What the contract is worth as typed. Display only — nothing here is
          // saved; the bargain stores qty, rate and GST% and every invoice
          // recomputes its own value from them.
          const cQty = Number(form.qty) || 0
          const cRate = Number(form.rate) || 0
          const cGst = Number(form.gst_pct) || 0
          const cTaxable = cQty * cRate
          const cGstAmt = (cTaxable * cGst) / 100
          const missing = [
            !form.customer_id && !form.customer ? 'customer' : '',
            !form.product_id ? 'product' : '',
            cQty > 0 ? '' : 'qty',
            cRate > 0 ? '' : 'rate'
          ].filter(Boolean)

          return (
            <>
              <div className="min-h-0 overflow-y-auto px-[22px] py-5">
                <div className="flex flex-col gap-[18px]">
                  {editLocked && (
                    <div className="rounded-[4px] border border-[#F0D9AE] bg-[#FFFBF2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8A5300]">
                      {formatNum(editSold)} {editing?.uom || 'MT'} is already sold on this bargain — customer and product are locked, and the quantity can&apos;t go below {formatNum(editSold)}.
                    </div>
                  )}
                  <BargainSection title="Who and what">
                    {fDate}{fCustomer}{fType}{fProduct}
                  </BargainSection>
                  <BargainSection title="Quantity and rate">
                    {fQty}{fUom}{fRate}{fGstPct}{fGstType}{fExpiry}
                    <div className={cn('col-span-2 rounded-[4px] border border-[#DCE7DB] px-3.5 py-3', cTaxable > 0 ? 'bg-[#F4FBF6]' : 'bg-[#F7FAF6]')}>
                      <div className="text-[11.5px] font-bold tabular-nums text-[#5A6B62]">
                        {cQty > 0 && cRate > 0
                          ? `${formatNum(cQty)} ${String(form.uom || 'MT')} × ${formatINR(cRate)}`
                          : 'Enter qty and rate to value this bargain'}
                      </div>
                      {cTaxable > 0 && (
                        <>
                          <div className="mt-2 flex items-baseline justify-between gap-3">
                            <span className="text-[12.5px] font-semibold text-[#33473E]">Taxable</span>
                            <span className="text-[14px] font-bold tabular-nums">{formatINR(cTaxable)}</span>
                          </div>
                          <div className="mt-2 flex items-baseline justify-between gap-3">
                            <span className="text-[12.5px] font-semibold text-[#33473E]">
                              GST {cGst > 0 ? `(${formatNum(cGst)}%)` : ''}
                            </span>
                            <span className="text-[14px] font-bold tabular-nums">{formatINR(cGstAmt)}</span>
                          </div>
                          <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t-2 border-t-[#0B3D2E] pt-2.5">
                            <span className="text-[11px] font-extrabold uppercase tracking-[.09em] text-[#2E4A0B]">Bargain value</span>
                            <span className="text-[18px] font-bold tracking-[-0.025em] tabular-nums">{formatINR(cTaxable + cGstAmt)}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </BargainSection>
                  <BargainSection title="Terms carried to each dispatch">
                    {fSaleType}{fFreight}{fShortage}{fPackaging}
                    <div className="col-span-2 flex items-start gap-2 rounded-[3px] border border-[#DCE7DB] bg-[#F7FAF6] px-3 py-2.5">
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#8AA096]" />
                      <span className="text-[12px] font-semibold leading-relaxed text-[#5A6B62]">
                        Sale type and freight term default onto each dispatch under this bargain — you can still override them per sale.
                      </span>
                    </div>
                  </BargainSection>
                  <BargainSection title="Reference">
                    <div className="col-span-2">{fManual}</div>
                    <div className="col-span-2">{fNote}</div>
                  </BargainSection>
                  {error && (
                    <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                      {error}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
                {/* What is still needed, named — a disabled Save that will not
                    say why is the commonest way a form wastes someone's time.
                    Save itself stays enabled: the real validation lives in
                    save(), and this is a hint, not a gate. */}
                <div className="min-w-0 text-[12px] font-bold">
                  {missing.length ? (
                    <span className="flex items-center gap-1.5 text-[#8A5300]">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-[#C2700A]" />
                      Still needed: {missing.join(', ')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[#0B6B45]">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-[#12855A]" /> Ready to save
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    disabled={saving}
                    className="h-10 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#F7FAF6] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className={cn(
                      'flex h-10 items-center gap-2 rounded-[4px] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] transition-colors disabled:opacity-60',
                      missing.length ? 'bg-[#33473E] text-white hover:bg-[#0B3D2E]' : 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0F4A38]'
                    )}
                  >
                    <Check className="h-5 w-5" /> {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </>
          )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!adjustRow} onOpenChange={(o) => !o && setAdjustRow(null)}>
        <DialogContent
          className={cn(
            'max-w-md',
            // A right-hand drawer on the website, wide enough for the before /
            // after pair to sit side by side — the whole point of this panel is
            // seeing what the balance becomes before you commit to it.
            __WEB__ &&
              '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[560px] !max-w-[95vw] !translate-x-0 !translate-y-0 !grid !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Adjust balance</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1.5 !break-all !text-[15px] !font-bold !leading-[1.35] !tracking-[-0.01em] !text-white')}>
              {__WEB__ ? adjustRow?.bargain_no : `Adjust balance — ${adjustRow?.bargain_no}`}
            </DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const qty = Number(adjustRow.qty) || 0
            // Rounded to the 3 decimals MT is tracked at — balance_qty is a
            // running total that can carry float residue past that (0.0019996
            // reading as "0.002"), which made squaring off to what the screen
            // already shows as the full balance look like an over-removal.
            const bal = Math.round((Number(adjustRow.balance_qty) || 0) * 1000) / 1000
            const sold = qty - bal
            const amt = Number(adjustForm.amount) || 0
            const delta = adjustForm.mode === 'add' ? amt : -amt
            const newBal = bal + delta
            const uom = adjustRow.uom || 'MT'
            if (__WEB__) {
              // Display only — every figure below is the same arithmetic the
              // desktop panel shows, drawn as before / after instead of on one
              // line. Nothing new is computed and nothing new is saved.
              const entered = amt > 0
              const over = adjustForm.mode === 'remove' && entered && newBal < -1e-9
              const newQty = qty + delta
              const pct = (v: number, of: number): number => (of > 0 ? Math.min(100, Math.max(0, (v / of) * 100)) : 0)
              const drawnOld = pct(sold, qty)
              const drawnNew = pct(sold, newQty)
              return (
                <>
                  <div className="min-h-0 overflow-y-auto px-[22px] py-4">
                    <div className="flex flex-col gap-4">
                      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                        <div className="grid grid-cols-3">
                          {[
                            { k: 'Bargain qty', v: formatNum(qty) },
                            { k: 'Sold', v: formatNum(sold) },
                            { k: 'Balance', v: formatNum(bal) }
                          ].map((st, i) => (
                            <div key={st.k} className={cn('px-3.5 py-3', i < 2 && 'border-r border-[#EAF0E9]')}>
                              <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{st.k}</div>
                              <div className="mt-1 flex items-baseline gap-1">
                                <span className="text-[19px] font-bold tracking-[-0.02em] tabular-nums">{st.v}</span>
                                <span className="text-[10.5px] font-bold text-[#5A6B62]">{uom}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="px-3.5 pb-3.5">
                          <div className="h-[7px] overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                            <div className="h-full bg-[#12855A]" style={{ width: `${drawnOld}%` }} />
                          </div>
                          <div className="mt-1.5 text-[11px] font-bold text-[#5A6B62]">
                            {Math.round(drawnOld)}% drawn · {formatNum(bal)} {uom} open today
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        {([
                          { m: 'add' as const, label: '+ Add to balance', on: 'border-[#12855A] bg-[#E9F5EE] text-[#0B6B45]' },
                          { m: 'remove' as const, label: '− Remove from balance', on: 'border-[#C2700A] bg-[#FFEDD0] text-[#8A5300]' }
                        ]).map((b) => (
                          <button
                            key={b.m}
                            type="button"
                            onClick={() => setAdjustForm((prev) => ({ ...prev, mode: b.m }))}
                            className={cn(
                              'flex h-[50px] items-center justify-center gap-1.5 rounded-[4px] border-[1.5px] text-[13px] transition-colors',
                              adjustForm.mode === b.m
                                ? `${b.on} font-extrabold`
                                : 'border-[#C3D2C6] bg-white font-bold text-[#5A6B62] hover:bg-[#F7FAF6]'
                            )}
                          >
                            {b.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex flex-col gap-4 rounded-[4px] border border-[#D6E2D6] bg-white p-4">
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">
                            Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})
                          </div>
                          <Input
                            type="number"
                            autoFocus
                            value={adjustForm.amount}
                            onChange={(e) => setAdjustForm((prev) => ({ ...prev, amount: e.target.value }))}
                            className={cn(
                              '!h-[50px] !rounded-[4px] !text-[17px] !font-bold !tabular-nums',
                              over ? '!border-[#B3261E]' : entered ? '!border-[#C3D2C6]' : '!border-[#E3C58C]'
                            )}
                          />
                        </div>
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">Date</div>
                          <DatePicker
                            value={adjustForm.date}
                            onChange={(v) => setAdjustForm((prev) => ({ ...prev, date: v || '' }))}
                            className="!h-[50px] !rounded-[4px]"
                          />
                          <p className="mt-1.5 text-[12px] font-semibold text-[#5A6B62]">
                            Shown under &ldquo;Addition&rdquo; for this date&rsquo;s month in the register.
                          </p>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[12px] font-extrabold text-[#33473E]">
                            Note <span className="font-semibold text-[#5A6B62]">(optional)</span>
                          </div>
                          <Input
                            value={adjustForm.note}
                            onChange={(e) => setAdjustForm((prev) => ({ ...prev, note: e.target.value }))}
                            placeholder="Reason for the adjustment"
                            className="!h-[50px] !rounded-[4px] !text-[13.5px]"
                          />
                        </div>
                      </div>

                      {over && (
                        <div className="flex gap-2.5 rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-3">
                          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#B3261E]" />
                          <div className="text-[12.5px] font-semibold leading-relaxed text-[#8C2F26]">
                            Only {formatNum(bal)} {uom} is left on this bargain. Removing {formatNum(amt)} {uom} would take the balance below zero.
                          </div>
                        </div>
                      )}

                      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                        <div className="flex items-center justify-between gap-2.5 border-b border-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
                          <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">After this adjustment</span>
                          {entered && !over && (
                            <span className={cn('text-[12.5px] font-extrabold tabular-nums', delta >= 0 ? 'text-[#0B6B45]' : 'text-[#8A5300]')}>
                              {delta >= 0 ? '+' : '−'}{formatNum(Math.abs(delta))} {uom}
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3 p-3.5">
                          <div>
                            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Bargain qty</div>
                            <div className="mt-1 text-[18px] font-bold tabular-nums">
                              {over ? '—' : formatNum(entered ? newQty : qty)}{' '}
                              <span className="text-[11px] font-semibold text-[#5A6B62]">{uom}</span>
                            </div>
                          </div>
                          <div>
                            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">New balance</div>
                            <div className={cn('mt-1 text-[18px] font-bold tabular-nums', !over && entered && newBal < -1e-9 && 'text-[#B3261E]')}>
                              {over ? '—' : formatNum(entered ? newBal : bal)}{' '}
                              <span className="text-[11px] font-semibold text-[#5A6B62]">{uom}</span>
                            </div>
                          </div>
                        </div>
                        <div className="px-3.5 pb-3.5">
                          <div className="h-[7px] overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                            <div
                              className="h-full"
                              style={{
                                width: `${over ? 0 : entered ? drawnNew : drawnOld}%`,
                                background: drawnNew >= 95 ? '#C2700A' : '#12855A'
                              }}
                            />
                          </div>
                          {!entered && !over && (
                            <div className="mt-2 text-[12px] font-semibold text-[#5A6B62]">Enter a quantity to see the new balance.</div>
                          )}
                          {over && (
                            <div className="mt-2 text-[12px] font-semibold text-[#5A6B62]">Reduce the quantity to see the new balance.</div>
                          )}
                        </div>
                      </div>

                      {adjustError && (
                        <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                          {adjustError}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
                    <button
                      type="button"
                      onClick={() => setAdjustRow(null)}
                      disabled={adjustSaving}
                      className="h-12 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-6 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#F7FAF6] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveAdjust}
                      disabled={adjustSaving}
                      className={cn(
                        'flex h-12 items-center gap-2 rounded-[4px] px-7 text-[13.5px] font-extrabold uppercase tracking-[.03em] transition-colors disabled:opacity-60',
                        entered && !over ? 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0F4A38]' : 'bg-[#33473E] text-white hover:bg-[#0B3D2E]'
                      )}
                    >
                      <Check className="h-5 w-5" /> {adjustSaving ? 'Saving…' : 'Apply'}
                    </button>
                  </div>
                </>
              )
            }
            return (
              <div className="grid gap-4">
                <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-3 text-center text-sm">
                  <div><div className="text-[11px] text-muted-foreground">Bargain qty</div><div className="font-semibold tabular-nums">{formatNum(qty)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Sold</div><div className="font-semibold tabular-nums">{formatNum(sold)}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Balance</div><div className="font-semibold tabular-nums">{formatNum(bal)} {uom}</div></div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40')}>+ Add to balance</button>
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40')}>− Remove from balance</button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity to {adjustForm.mode === 'add' ? 'add' : 'remove'} ({uom})</Label>
                  <Input type="number" autoFocus value={adjustForm.amount} onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={adjustForm.date} onChange={(v) => setAdjustForm((p) => ({ ...p, date: v || '' }))} />
                  <p className="text-xs text-muted-foreground">Shown under "Addition" for this date's month in the register.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Note (optional)</Label>
                  <Input value={adjustForm.note} onChange={(e) => setAdjustForm((p) => ({ ...p, note: e.target.value }))} placeholder="Reason for the adjustment" />
                </div>
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  New balance:{' '}
                  <span className={cn('font-semibold tabular-nums', newBal < -1e-9 && 'text-red-600')}>{formatNum(newBal)} {uom}</span>
                  {amt > 0 && adjustForm.mode === 'remove' && newBal < -1e-9 && (
                    <span className="ml-2 text-red-600">— more than the available balance</span>
                  )}
                </div>
                {adjustError && <p className="text-sm text-destructive">{adjustError}</p>}
              </div>
            )
          })()}
          {/* The website's drawer draws its own pinned footer inside the body
              above, so this one is desktop's alone. */}
          {!__WEB__ && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={adjustSaving}>Cancel</Button>
              <Button onClick={saveAdjust} disabled={adjustSaving}>{adjustSaving ? 'Saving…' : 'Apply'}</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- page ----------------

export function Sales({ focusId, onFocusHandled, onBack, backLabel }: { focusId?: number | null; onFocusHandled?: () => void; onBack?: () => void; backLabel?: string } = {}): React.JSX.Element {
  const isMobile = useIsMobile()
  const [needs, setNeeds] = useState<Row[]>([])
  const [needsOpen, setNeedsOpen] = useState(false)
  const [salesAdd, setSalesAdd] = useState<{ open: () => void; canAdd: boolean; formOpen: boolean } | null>(null)
  const loadNeeds = useCallback(async () => {
    // Hidden for the unloading desk, so it is not fetched either.
    if (UNLOAD_DESK()) return
    setNeeds(await window.api.stock.needs())
  }, [])
  useEffect(() => {
    loadNeeds()
  }, [loadNeeds])
  useLiveRefresh(loadNeeds)

  const rawShort = needs.filter((n) => n.raw_short).length
  const totalProduce = needs.reduce((s, n) => s + (Number(n.shortfall) || 0), 0)
  const unloadOnly = UNLOAD_DESK()

  // Website, phone width, the normal Sales role — the design_handoff_erp_sales_mobile
  // build. False on the desktop app (__WEB__ is a build-time constant, compiled
  // out entirely there — see electron.vite.config.ts) and on the restricted
  // unloading desk, which keeps its own simplified view.
  if (__WEB__ && isMobile && !unloadOnly) return <SalesMobile />

  return (
    <>
      <PageHeader
        title={unloadOnly ? 'Unloading desk' : 'Sales'}
        subtitle={unloadOnly ? 'FOR deliveries still out — record the quantity received' : undefined}
        hint={
          unloadOnly
            ? 'Each delivery listed here has left the factory and is not yet unloaded. Open one, enter what the transporter actually delivered on every line, and it is marked unloaded.'
            : 'Each dispatch draws down a sales bargain and reduces finished-goods stock. Short stock can be produced on the spot. Book the rate contracts under Sales Bargain.'
        }
        actions={
          salesAdd?.formOpen || unloadOnly ? undefined : (
            <>
              {/* Production needs is off the website's header — the desk asked
                  for it gone from both widths there. The desktop app keeps it. */}
              {!__WEB__ && (
                <Button
                  size="sm"
                  variant={needs.length === 0 ? 'outline' : rawShort > 0 ? 'destructive' : 'default'}
                  onClick={() => setNeedsOpen(true)}
                  className={cn(needs.length > 0 && rawShort > 0 && 'animate-pulse')}
                >
                  <AlertTriangle className="h-4 w-4" />
                  Production needs
                  {needs.length > 0 && (
                    <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs font-bold">
                      {needs.length}
                    </span>
                  )}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => salesAdd?.open()}
                disabled={!salesAdd?.canAdd}
                // The default button is near-black, same as the forest header
                // it'd sit on — no contrast. Lime is the theme's own accent
                // for the one action that matters most (see SalesMobile).
                className={cn(__WEB__ && !unloadOnly && 'bg-[#C7F03F] text-[#12280B] hover:bg-[#b3d936]')}
              >
                <Plus className="h-4 w-4" /> New sale
              </Button>
            </>
          )
        }
      />
      {/* Website runs the register full-bleed — no side gutter, so the table
          gets the whole width. The desktop app keeps its padded page. */}
      <div className={__WEB__ ? 'py-4 pl-4' : 'px-4 py-4'}>
        <SalesTab focusId={focusId} onFocusHandled={onFocusHandled} onRegister={setSalesAdd} onBack={onBack} backLabel={backLabel} />
      </div>

      <Dialog open={needsOpen} onOpenChange={setNeedsOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Production needs — demand vs stock
            </DialogTitle>
          </DialogHeader>

          {needs.length === 0 ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 py-10 text-center text-sm font-medium text-emerald-800">
              All committed sales are covered by current finished-goods stock. Nothing to produce.
            </div>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-3 gap-3">
                <div className="rounded-lg border bg-card p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Products short</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">{needs.length}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total to produce</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">{formatNum(totalProduce)}</div>
                </div>
                <div className={cn('rounded-lg border p-3 text-center', rawShort > 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50')}>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Raw short</div>
                  <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', rawShort > 0 ? 'text-red-600' : 'text-emerald-700')}>{rawShort}</div>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border">
                <Table className="text-[13px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Committed</TableHead>
                      <TableHead className="text-right">In stock</TableHead>
                      <TableHead className="text-right">To produce</TableHead>
                      <TableHead className="text-right">Raw material</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {needs.map((nd) => (
                      <TableRow key={nd.id as number}>
                        <TableCell className="font-medium">{nd.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(nd.demand)}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', Number(nd.stock) < -1e-9 ? 'text-red-600' : 'text-muted-foreground')}>
                          {formatNum(nd.stock)}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-700">{formatNum(nd.shortfall)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={nd.raw_short ? 'destructive' : 'warning'}>
                            {nd.raw_short ? 'Raw short — buy raw' : 'Raw available'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Committed = pending dispatches + remaining sales-bargain quantity. To produce = committed − stock. &ldquo;Raw
                short&rdquo; means even producing the shortfall, some formula input is below stock — buy raw first.
              </p>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function SalesBargains({ onOpenSale }: { onOpenSale?: (id: number, companyId?: number) => void } = {}): React.JSX.Element {
  return (
    <>
      <PageHeader title="Sales Bargain" subtitle="Rate contracts with customers — drawn down as sales are dispatched" hint="Each sales bargain locks a rate and quantity with a customer; dispatches under Sales draw it down. The bargain number is FGCODE/DD-MM/CUSTOMER/SERIAL, resetting monthly." />
      <div className="px-4 py-4">
        <SalesBargainsTab onOpenSale={onOpenSale} />
      </div>
    </>
  )
}

