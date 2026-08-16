import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  Landmark,
  List,
  Paperclip,
  Pencil,
  Percent,
  Plus,
  RotateCcw,
  Trash2,
  Users
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { exportLcRegister } from '@/lib/lcExcel'
import { BillDiscounting } from './BillDiscounting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

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
  { key: 'month', label: 'Monthly', maxDays: 30 },
  { key: 'quarter', label: 'Quarterly', maxDays: 90 }
]

// Countdown chip: red overdue, amber close, muted otherwise.
function DueBadge({ date }: { date: unknown }): React.JSX.Element | null {
  const d = daysTo(date)
  if (d == null) return null
  const label = d < 0 ? `${-d}d overdue` : d === 0 ? 'due today' : `${d}d left`
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
function StageBadge({ stage }: { stage: string }): React.JSX.Element {
  const tone =
    stage === 'payment_received'
      ? 'bg-emerald-100 text-emerald-800'
      : stage === 'open'
        ? 'bg-sky-100 text-sky-800'
        : 'bg-amber-100 text-amber-800'
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', tone)}>
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
const STAGE_ROW_TONE: Record<string, { row: string; hover: string }> = {
  application: { row: "border-l-4 border-l-amber-400 bg-amber-50/50 [border-left-style:solid]", hover: 'hover:bg-amber-100/60' },
  open: { row: "border-l-4 border-l-sky-400 bg-sky-50/50 [border-left-style:solid]", hover: 'hover:bg-sky-100/60' },
  payment_received: { row: "border-l-4 border-l-emerald-400 bg-emerald-50/50 [border-left-style:solid]", hover: 'hover:bg-emerald-100/60' }
}

interface Props {
  onCompanyChange: (id: string) => void
}

export function Treasury({ onCompanyChange }: Props): React.JSX.Element {
  const [tab, setTab] = useState('lc')
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
  const [lcDetailId, setLcDetailId] = useState<number | null>(null)
  const [lcView, setLcView] = useState<'cards' | 'table'>('table')
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null)
  // T+1 / this week / fortnight / monthly / quarterly, by whichever is nearer:
  // an outstanding bill's due date, or (no outstanding bill) the LC's expiry.
  const [lcDuePeriod, setLcDuePeriod] = useState('all')
  const [lcStageFilter, setLcStageFilter] = useState<string | null>(null)
  // Every LC bill and discounted bill in one due-date-sorted list, regardless
  // of urgency — the alerts above only surface what's already close.
  const [tracker, setTracker] = useState<Row[]>([])
  const [trackerShowSettled, setTrackerShowSettled] = useState(false)
  const [activeCompany, setActiveCompany] = useState(0)
  const [companies, setCompanies] = useState<Row[]>([])
  const [lcLimit, setLcLimit] = useState<Row | null>(null)

  const load = useCallback(async () => {
    const [l, b, a, sup, cust, sl, od, deals, tr, act, comps, lim] = await Promise.all([
      window.api.lc.list(),
      window.api.billDiscounts.list(),
      window.api.treasury.alerts(),
      window.api.data.list('suppliers'),
      window.api.data.list('customers'),
      window.api.sales.list(),
      window.api.orders.list(),
      window.api.trading.list(),
      window.api.treasury.paymentTracker(),
      window.api.company.getActive(),
      window.api.company.list(),
      window.api.lc.getLimit()
    ])
    setLcs(l.filter((x) => String(x.facility_type || 'lc') === 'lc'))
    setBills(b.filter((x) => String(x.medium || '') === 'bill_discounting' || x.rate_pct != null))
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
  }, [])

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
            interest_upfront: !!l.interest_upfront
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
    setLcLimitForm({
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
    const prematureInterest = round2((openAmount * n(l.interest_pct) * pendingDays) / (100 * 365))
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
    const interest = round2((openAmount * n(precloseRow.interest_pct) * days) / (100 * 365))
    const charges = round2(n(precloseRow.charges))
    // Pending days: what's left of the ORIGINAL term (preclose date ->
    // maturity) that will never actually happen — an extra cost on top of
    // (not instead of) the interest above, which only covers days actually
    // elapsed.
    const expiryDate = String(precloseRow.expiry_date || '').slice(0, 10)
    const pendingDays = expiryDate
      ? Math.max(0, Math.round((new Date(`${expiryDate}T00:00:00`).getTime() - new Date(`${precloseDate}T00:00:00`).getTime()) / 86400000))
      : 0
    const prematureInterest = round2((openAmount * n(precloseRow.interest_pct) * pendingDays) / (100 * 365))
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
    const interest = days != null ? round2((amount * interestPct * days) / (100 * 365)) : 0
    const upfront = !!stageForm.interest_upfront
    const netAvailable = upfront ? amount : round2(amount - interest - charges)
    // Margin is the security deposit the bank asks for on the LC's own open
    // amount — a straight percentage of the credit limit itself, not of
    // whichever invoices happen to be linked to it.
    const margin = round2((amount * n(stageForm.margin_pct)) / 100)
    return { amount, days, interest, charges, margin, netAvailable, upfront }
  }, [stageRow, stageForm.payment_received_date, stageForm.expiry_date, stageForm.margin_pct, stageForm.interest_pct, stageForm.charges, stageForm.interest_upfront])

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
      if (lcForm.id) await window.api.lc.update(Number(lcForm.id), payload)
      else await window.api.lc.create(payload)
      toast.success(`LC ${lcForm.lc_no} saved — margin, interest & charges posted to the books`)
      setLcForm(null)
      load()
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
  // the customer — so it's struck against the whole deal, one pick, not a
  // bare purchase invoice. Only deals for this supplier that are still open
  // (no LC of their own yet, or already this very LC's) are offered.
  const lcFormDeals = useMemo(() => {
    if (!lcForm || String(lcForm.purpose || '') !== 'trading') return []
    return tradingDeals.filter(
      (d) =>
        (!lcForm.party_id || Number(d.supplier_id) === Number(lcForm.party_id)) &&
        (!d.lc_id || (lcForm.id && Number(d.lc_id) === Number(lcForm.id)))
    )
  }, [lcForm, tradingDeals])

  // Suppliers who actually deal in the selected purpose — the Suppliers
  // master itself records this (Trading or Manufacturing), so a Trading LC
  // only offers the handful of parties actually set up as trading accounts.
  const purposeSuppliers = useMemo(() => {
    if (!lcForm?.purpose) return []
    const wantTrading = String(lcForm.purpose) === 'trading'
    return suppliers.filter((s) => (String(s.business_type || 'Manufacturing') === 'Trading') === wantTrading)
  }, [lcForm?.purpose, suppliers])

  // Banks already on record — from LCs — so the field can offer a pick-list
  // while still taking a bank that isn't in it yet.
  const bankOptions = useMemo(() => {
    const set = new Set<string>()
    for (const l of lcs) if (l.bank) set.add(String(l.bank).trim())
    return Array.from(set).sort()
  }, [lcs])
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
    if (r.path) setRepayForm({ ...repayForm, document_path: r.path })
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

  // ---------------- LC Payment IN (last leg — customer pays for the resale) ----------------
  // Only a Trading LC's own round trip closes this way, and only once the
  // bank side is already repaid — Application -> Open -> Payment received ->
  // Preclose/Repayment -> Payment IN. A deal's sale side can come in across
  // more than one receipt, so "fully paid" (and so "closed") is computed live
  // from the linked deal(s) rather than a one-shot flag on the LC itself.
  function tradingDealsFor(lcId: number): Row[] {
    return tradingDeals.filter((d) => Number(d.lc_id) === Number(lcId))
  }
  function isLcPaymentInDone(l: Row): boolean {
    const deals = tradingDealsFor(Number(l.id))
    return deals.length > 0 && deals.every((d) => d.sale_fully_paid)
  }
  function canMarkPaymentIn(l: Row): boolean {
    return String(l.purpose || '') === 'trading' && !!l.preclosed_date && !isLcPaymentInDone(l)
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
    setPaymentInForm({ ...paymentInForm, selected_keys: next, amount: String(total) })
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

  // ---------------- bill discounting ----------------
  const [bdForm, setBdForm] = useState<Row | null>(null)

  // Sale invoices grouped, for the picker: one entry per invoice with its net.
  const saleInvoices = useMemo(() => {
    const by = new Map<string, { group: string; invoice_no: string; customer: string; customer_id: number | null; net: number; date: string }>()
    for (const s of sales) {
      const g = String(s.invoice_group || `L-${s.id}`)
      const cur = by.get(g) || {
        group: g,
        invoice_no: String(s.invoice_no || ''),
        customer: String(s.customer || ''),
        customer_id: s.customer_id ? Number(s.customer_id) : null,
        net: 0,
        date: String(s.sale_date)
      }
      cur.net += n(s.amount) + n(s.gst_amount) + n(s.round_off)
      by.set(g, cur)
    }
    return Array.from(by.values())
      .filter((x) => x.invoice_no)
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [sales])

  const bdPreview = useMemo(() => {
    if (!bdForm) return null
    const amount = n(bdForm.amount)
    const from = String(bdForm.open_date || todayISO())
    const due = String(bdForm.maturity_date || '')
    const days = due ? Math.max(0, daysTo(due)! - daysTo(from)!) : n(bdForm.tenor_days)
    const interest = Math.round(((amount * n(bdForm.rate_pct) * days) / 36500) * 100) / 100
    const net = Math.round((amount - interest - n(bdForm.charges)) * 100) / 100
    return { days, interest, net }
  }, [bdForm])

  async function saveBd(): Promise<void> {
    if (!bdForm) return
    setBusy(true)
    try {
      await window.api.treasury.discount({
        party_name: bdForm.party_name || null,
        customer_id: bdForm.customer_id ? Number(bdForm.customer_id) : null,
        invoice_group: bdForm.invoice_group || null,
        bill_nos: bdForm.bill_nos || null,
        disc_bank: bdForm.disc_bank,
        amount: Number(bdForm.amount),
        open_date: bdForm.open_date || todayISO(),
        maturity_date: bdForm.maturity_date || undefined,
        tenor_days: bdForm.tenor_days ? Number(bdForm.tenor_days) : undefined,
        rate_pct: Number(bdForm.rate_pct) || 0,
        charges: Number(bdForm.charges) || 0,
        note: bdForm.note || null
      })
      toast.success('Bill discounted — bank credit and charges are in the books')
      setBdForm(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Each LC's nearest due date (an outstanding bill, else the LC's own expiry)
  // and which due-period bucket that falls into, for the dashboard filter.
  const lcsWithDue: Row[] = useMemo(
    () =>
      lcs.map((l) => {
        const dueDate = l.next_due_date || l.expiry_date
        const daysLeft = daysTo(dueDate)
        const row: Row = { ...l, due_date_effective: dueDate, days_left_effective: daysLeft }
        return row
      }),
    [lcs]
  )
  const lcsFiltered = useMemo(() => {
    let rows = lcsWithDue
    if (lcStageFilter) rows = rows.filter((l) => String(l.stage || 'application') === lcStageFilter)
    if (lcDuePeriod === 'all') return rows
    const maxDays = DUE_PERIODS.find((p) => p.key === lcDuePeriod)?.maxDays
    if (maxDays == null) return rows
    // Cumulative: overdue and everything due sooner counts too, not just the
    // slice of days that falls exactly in this bucket.
    return rows.filter((l) => l.days_left_effective != null && l.days_left_effective <= maxDays)
  }, [lcsWithDue, lcDuePeriod, lcStageFilter])

  const [lcExporting, setLcExporting] = useState(false)
  async function downloadLcRegister(): Promise<void> {
    setLcExporting(true)
    try {
      await exportLcRegister(lcsFiltered, `lc-register-${lcDuePeriod === 'all' ? todayISO() : `${lcDuePeriod}-${todayISO()}`}`)
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
                    <td className="font-medium">{b.bill_no || b.invoice_no || '—'}</td>
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

  const alertItems: { tone: string; icon: typeof AlertTriangle; label: string; items: string[] }[] = []
  if (alerts) {
    const exp = (alerts.lcExpiring as Row[]) || []
    const lcDue = (alerts.lcBillsDue as Row[]) || []
    const bdDue = (alerts.billsDue as Row[]) || []
    if (exp.length)
      alertItems.push({
        tone: 'border-amber-300 bg-amber-50 text-amber-900',
        icon: CalendarClock,
        label: `${exp.length} LC${exp.length > 1 ? 's' : ''} expiring`,
        items: exp.slice(0, 4).map((l) => `${l.lc_no} · ${l.bank} — ${l.days_left < 0 ? 'expired' : `${l.days_left}d left`}, ${formatINR(n(l.amount) - n(l.utilized))} unused`)
      })
    if (lcDue.length)
      alertItems.push({
        tone: lcDue.some((b) => b.days_left < 0) ? 'border-red-300 bg-red-50 text-red-800' : 'border-sky-300 bg-sky-50 text-sky-900',
        icon: Landmark,
        label: `${lcDue.length} LC bill${lcDue.length > 1 ? 's' : ''} maturing`,
        items: lcDue.slice(0, 4).map((b) => `${b.lc_no} ${b.bill_no || b.invoice_no || ''} — ${formatINR(b.amount)} ${b.days_left < 0 ? `${-b.days_left}d OVERDUE` : `due in ${b.days_left}d`}`)
      })
    if (bdDue.length)
      alertItems.push({
        tone: bdDue.some((b) => b.days_left < 0) ? 'border-red-300 bg-red-50 text-red-800' : 'border-indigo-300 bg-indigo-50 text-indigo-900',
        icon: Banknote,
        label: `${bdDue.length} discounted bill${bdDue.length > 1 ? 's' : ''} maturing`,
        items: bdDue.slice(0, 4).map((b) => `${b.bill_nos || ''} ${b.party_name || ''} — ${formatINR(b.amount)} ${b.days_left < 0 ? `${-b.days_left}d OVERDUE` : `due in ${b.days_left}d`}`)
      })
  }

  return (
    <>
      <PageHeader
        title="Treasury"
        hint="LCs carry interest days: every bill issued under one gets a maturity date, and settling it pays the supplier through the books against the original invoice. Discounting a sale bill brings the bank money in now (interest and charges to expenses) and clears the customer when the bill is realized. Everything shows in the Day Book, ledgers and Trial Balance."
        actions={
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="h-8 w-56 text-xs font-semibold uppercase tracking-wide">
              <SelectValue placeholder="Select a view" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lc">Letters of Credit ({lcs.length})</SelectItem>
              <SelectItem value="bd">Bill Discounting ({bills.length})</SelectItem>
              <SelectItem value="tracker">Payment Tracker ({tracker.filter((x) => !x.settled).length})</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <div className="space-y-4 px-4 py-4">
        <Tabs value={tab} onValueChange={setTab}>
          {alertItems.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {alertItems.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => setExpandedAlert(expandedAlert === a.label ? null : a.label)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold uppercase tracking-wide transition-colors',
                      a.tone,
                      expandedAlert === a.label && 'ring-2 ring-offset-1'
                    )}
                  >
                    <a.icon className="h-3.5 w-3.5" /> {a.label}
                  </button>
                ))}
              </div>
              {alertItems
                .filter((a) => a.label === expandedAlert)
                .map((a) => (
                  <Card key={a.label} className={cn('border p-3', a.tone)}>
                    {a.items.map((x) => (
                      <div key={x} className="truncate text-[12px]" title={x}>{x}</div>
                    ))}
                  </Card>
                ))}
            </div>
          )}

          <TabsContent value="tracker" className="mt-4">
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex flex-wrap items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/50"><CalendarClock className="h-3.5 w-3.5" /></span>
                <span className="text-[13px] font-bold uppercase tracking-widest">Payment Tracker</span>
                <span className="text-[11px] text-[#1a2c56]/70">every LC bill and discounted bill, one due-date list</span>
                <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <input type="checkbox" className="h-3.5 w-3.5" checked={trackerShowSettled} onChange={(e) => setTrackerShowSettled(e.target.checked)} />
                  Show settled
                </label>
              </div>
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="bg-[#f1ecd9] hover:bg-[#f1ecd9]">
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
                      <TableRow key={`${r.kind}-${r.ref}-${r.due_date}-${r.amount}`} className="border-b border-dotted border-[#e5dfc8]">
                        <TableCell>
                          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', r.kind === 'lc_bill' ? 'bg-sky-100 text-sky-800' : 'bg-indigo-100 text-indigo-800')}>
                            {r.kind_label}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold">{r.ref} {r.party ? `· ${r.party}` : ''}</div>
                          {r.detail && <div className="text-[11px] text-muted-foreground">{r.detail}</div>}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatINR(r.amount)}</TableCell>
                        <TableCell>
                          <div className="tabular-nums">{r.due_date ? formatDate(r.due_date) : '—'}</div>
                          {!r.settled && r.days_left != null && (
                            <div className={cn('text-[10px]', r.overdue ? 'font-semibold text-red-600' : 'text-muted-foreground')}>
                              {r.overdue ? `${Math.abs(r.days_left)}d overdue` : `${r.days_left}d left`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={r.settled ? 'success' : r.overdue ? 'destructive' : 'warning'} className="uppercase">
                            {r.settled ? 'settled' : r.overdue ? 'overdue' : 'outstanding'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  })()}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="lc" className="mt-4 space-y-3">
            {lcLimit && (
              <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
                <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/50"><Landmark className="h-3.5 w-3.5" /></span>
                  <span className="text-[13px] font-bold uppercase tracking-widest">LC Facility Limit</span>
                  <Button size="sm" variant="outline" className="ml-auto h-7 bg-white px-2 text-xs" onClick={openLcLimit}>
                    Edit limit
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-px bg-[#e5dfc8] p-px sm:grid-cols-3 lg:grid-cols-6">
                  <div className="bg-[#fffdf4] px-3 py-2.5 text-center">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Fixed</div>
                    <div className="text-[15px] font-bold tabular-nums text-[#1a2c56]">{formatINR(lcLimit.fixed_limit)}</div>
                  </div>
                  <div className="bg-[#fffdf4] px-3 py-2.5 text-center">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Convertible {!lcLimit.convertible_enabled && <span className="text-muted-foreground/60">(off)</span>}
                    </div>
                    <div className={cn('text-[15px] font-bold tabular-nums', lcLimit.convertible_enabled ? 'text-[#1a2c56]' : 'text-muted-foreground/50 line-through')}>
                      {formatINR(lcLimit.convertible_limit)}
                    </div>
                  </div>
                  <div className="bg-[#1a2c56] px-3 py-2.5 text-center">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-white/70">Total LC Limit</div>
                    <div className="text-[15px] font-bold tabular-nums text-white">{formatINR(lcLimit.total_limit)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'application' ? null : 'application')}
                    title="Click to filter the list below to Application-stage LCs"
                    className={cn(
                      'bg-amber-50 px-3 py-2.5 text-center transition-colors hover:bg-amber-100',
                      lcStageFilter === 'application' && 'ring-2 ring-inset ring-amber-600'
                    )}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Application</div>
                    <div className="text-[15px] font-bold tabular-nums text-amber-900">{formatINR(lcLimit.application)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'open' ? null : 'open')}
                    title="Click to filter the list below to Open-stage LCs"
                    className={cn(
                      'bg-sky-50 px-3 py-2.5 text-center transition-colors hover:bg-sky-100',
                      lcStageFilter === 'open' && 'ring-2 ring-inset ring-sky-600'
                    )}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-800">Open</div>
                    <div className="text-[15px] font-bold tabular-nums text-sky-900">{formatINR(lcLimit.open)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLcStageFilter(lcStageFilter === 'payment_received' ? null : 'payment_received')}
                    title="Click to filter the list below to Payment received-stage LCs"
                    className={cn(
                      'bg-emerald-50 px-3 py-2.5 text-center transition-colors hover:bg-emerald-100',
                      lcStageFilter === 'payment_received' && 'ring-2 ring-inset ring-emerald-600'
                    )}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800">Payment received</div>
                    <div className="text-[15px] font-bold tabular-nums text-emerald-900">{formatINR(lcLimit.payment_received)}</div>
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-dashed border-[#e5dfc8] px-4 py-2.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Utilised {formatINR(lcLimit.utilized)} of {formatINR(lcLimit.total_limit)}
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
            <div className="flex flex-wrap items-center gap-2">
              {DUE_PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setLcDuePeriod(p.key)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                    lcDuePeriod === p.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50'
                  )}
                >
                  {p.label}
                </button>
              ))}
              <div className="ml-auto flex gap-1 rounded-md border border-[#d9d2b8] bg-white p-0.5">
                <Button size="icon" variant={lcView === 'cards' ? 'default' : 'ghost'} className="h-7 w-7" title="Card view" onClick={() => setLcView('cards')}>
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant={lcView === 'table' ? 'default' : 'ghost'} className="h-7 w-7" title="Table view" onClick={() => setLcView('table')}>
                  <List className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {lcView === 'cards' ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Card className="flex items-center justify-center border-dashed p-6">
                  <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setLcForm({ open_date: todayISO(), usance_days: '', margin_pct: '', interest_pct: '', charges: '', purpose: 'manufacturing', workflow_status: 'in_progress', stage: 'application' })}>
                    <Plus className="h-4 w-4" /> Open new LC
                  </Button>
                </Card>
                {lcsFiltered.length === 0 ? (
                  <Card className="p-6 text-center text-sm text-muted-foreground md:col-span-2 xl:col-span-2">Nothing in this due-period bucket.</Card>
                ) : (
                  lcsFiltered.map((l) => {
                    const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                    const barTone = pct >= 95 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-sky-600'
                    const tone = STAGE_ROW_TONE[String(l.stage || 'application')] || STAGE_ROW_TONE.application
                    return (
                      <Card
                        key={String(l.id)}
                        className={cn('flex flex-col gap-3 overflow-hidden border-l-4 p-0 [border-left-style:solid]', tone.row)}
                      >
                        <div className="flex flex-col gap-3 p-4 pb-0">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className={cn('text-[15px] font-bold', !l.lc_no && 'italic text-muted-foreground')}>{l.lc_no || 'Pending LC no'}</span>
                                <StageBadge stage={String(l.stage || 'application')} />
                                {l.preclosed_date && <Badge variant="muted">Preclosed {formatDate(l.preclosed_date)}</Badge>}
                                {isLcPaymentInDone(l) && <Badge variant="success">Payment IN</Badge>}
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
                          <div className="rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm">
                            <div className="text-[10px] font-semibold uppercase tracking-widest text-white/60">LC amount</div>
                            <div className="text-2xl font-bold tabular-nums text-white">{formatINR(l.amount)}</div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <div className="rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5">
                              <div className="text-muted-foreground">Utilised</div>
                              <div className="font-semibold tabular-nums text-[#1a2c56]">{formatINR(l.utilized)}</div>
                            </div>
                            <div className={cn('rounded-md border px-2.5 py-1.5', n(l.available) <= 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50')}>
                              <div className="text-muted-foreground">Available</div>
                              <div className={cn('font-semibold tabular-nums', n(l.available) <= 0 ? 'text-rose-600' : 'text-emerald-700')}>{formatINR(l.available)}</div>
                            </div>
                            <div className={cn('rounded-md border px-2.5 py-1.5', n(l.repaid) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-[#e5dfc8] bg-white')}>
                              <div className="text-muted-foreground">Repaid</div>
                              <div className={cn('font-semibold tabular-nums', n(l.repaid) > 0 ? 'text-emerald-700' : 'text-[#1a2c56]')}>{formatINR(l.repaid)}</div>
                            </div>
                            <div className={cn('rounded-md border px-2.5 py-1.5', n(l.outstanding) > 0 ? 'border-amber-200 bg-amber-50' : 'border-[#e5dfc8] bg-white')}>
                              <div className="text-muted-foreground">Outstanding</div>
                              <div className={cn('font-semibold tabular-nums', n(l.outstanding) > 0 ? 'text-amber-800' : 'text-[#1a2c56]')}>{formatINR(l.outstanding)}</div>
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
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1.5"><CalendarRange className="h-3 w-3 shrink-0" /> {formatDate(l.open_date)} → {formatDate(l.expiry_date)}</span>
                            <DueBadge date={l.due_date_effective} />
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] px-4 py-3">
                          {(() => {
                            const next = nextLcStage(String(l.stage || 'application'))
                            if (!next) return null
                            return (
                              <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openStageAdvance(l)}>
                                Mark {STAGE_LABEL[next]}
                              </Button>
                            )
                          })()}
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void openLcDetail(Number(l.id))}>
                            <ChevronRight className="h-3.5 w-3.5" /> Details
                          </Button>
                          {!l.preclosed_date && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              title={isLcPastMaturity(l) ? 'Repay this LC now that it has matured' : 'Wind this LC up before its natural maturity'}
                              onClick={() => openPreclose(l)}
                            >
                              {isLcPastMaturity(l) ? 'Repay' : 'Preclose'}
                            </Button>
                          )}
                          {canMarkPaymentIn(l) && (
                            <Button
                              size="sm"
                              className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700"
                              title="Record the customer's payment for the resale, closing this LC"
                              onClick={() => void openPaymentIn(l)}
                            >
                              Mark Payment IN
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit LC" onClick={() => setLcForm({ ...l })}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete LC (reverses its vouchers)" onClick={() => requestDeleteLc(l)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </Card>
                    )
                  })
                )}
              </div>
            ) : (
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/50"><Banknote className="h-3.5 w-3.5" /></span>
                <span className="text-[13px] font-bold uppercase tracking-widest">Letters of Credit</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto gap-1.5 bg-white"
                  disabled={lcExporting || lcsFiltered.length === 0}
                  onClick={() => void downloadLcRegister()}
                >
                  <FileSpreadsheet className="h-4 w-4" /> {lcExporting ? 'Preparing…' : 'Download Excel'}
                </Button>
                <Button size="sm" className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setLcForm({ open_date: todayISO(), usance_days: '', margin_pct: '', interest_pct: '', charges: '', purpose: 'manufacturing', workflow_status: 'in_progress', stage: 'application' })}>
                  <Plus className="h-4 w-4" /> Open new LC
                </Button>
              </div>
              <div className="overflow-x-auto">
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="border-b-2 border-[#1a2c56]/20 bg-[#dce6f5] hover:bg-[#dce6f5]">
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">LC no · bank</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Supplier</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Validity</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Days left</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Int. days</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Limit</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Available</TableHead>
                    <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lcsFiltered.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No letters of credit in this bucket.</TableCell></TableRow>
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
                              'bg-white'
                            )}
                            onClick={() => void openLcDetail(Number(l.id))}
                          >
                            <TableCell className="whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span className={cn('font-semibold', !l.lc_no && 'italic text-muted-foreground')}>{l.lc_no || 'Pending LC no'}</span>
                                    <StageBadge stage={String(l.stage || 'application')} />
                                    {l.preclosed_date && <Badge variant="muted">Preclosed</Badge>}
                                    {isLcPaymentInDone(l) && <Badge variant="success">Payment IN</Badge>}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">{l.bank}{n(l.margin_pct) ? ` · margin ${l.margin_pct}%` : ''}</div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap">{l.supplier_name || '—'}</TableCell>
                            <TableCell className="whitespace-nowrap tabular-nums">
                              <div>O - {formatDate(l.open_date)}</div>
                              <div>M - {formatDate(l.expiry_date)}</div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {l.expiry_date ? <DueBadge date={l.expiry_date} /> : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                              {n(l.usance_days) > 0 ? n(l.usance_days) : '—'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">{formatINR(l.amount)}</TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <div className={cn('font-semibold tabular-nums', n(l.available) <= 0 ? 'text-rose-600' : 'text-emerald-700')}>
                                {formatINR(l.available)}
                              </div>
                              <div className={cn('text-[10px] tabular-nums', pct >= 95 ? 'text-rose-600' : 'text-muted-foreground')}>
                                {pct.toFixed(0)}% used
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex justify-end gap-1">
                                {(() => {
                                  const next = nextLcStage(String(l.stage || 'application'))
                                  if (!next) return null
                                  return (
                                    <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openStageAdvance(l)}>
                                      Mark {STAGE_LABEL[next]}
                                    </Button>
                                  )
                                })()}
                                {!l.preclosed_date && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 px-2 text-xs"
                                    title={isLcPastMaturity(l) ? 'Repay this LC now that it has matured' : 'Wind this LC up before its natural maturity'}
                                    onClick={() => openPreclose(l)}
                                  >
                                    {isLcPastMaturity(l) ? 'Repay' : 'Preclose'}
                                  </Button>
                                )}
                                {canMarkPaymentIn(l) && (
                                  <Button
                                    size="sm"
                                    className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700"
                                    title="Record the customer's payment for the resale, closing this LC"
                                    onClick={() => void openPaymentIn(l)}
                                  >
                                    Mark Payment IN
                                  </Button>
                                )}
                                <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit LC" onClick={() => setLcForm({ ...l })}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete LC (reverses its vouchers)" onClick={() => requestDeleteLc(l)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
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
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/50"><FileText className="h-3.5 w-3.5" /></span>
                <span className="text-[13px] font-bold uppercase tracking-widest">Bill Discounting</span>
                <Button size="sm" className="ml-auto bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setBdForm({ open_date: todayISO(), rate_pct: '9', tenor_days: '60', charges: '' })}>
                  <Plus className="h-4 w-4" /> Discount a bill
                </Button>
              </div>
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="bg-[#f1ecd9] hover:bg-[#f1ecd9]">
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bill · party</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bank</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bill amount</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Interest + charges</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Net received</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Maturity</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Status</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bills.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No discounted bills yet.</TableCell></TableRow>
                  ) : (
                    bills.map((b) => (
                      <TableRow key={String(b.id)} className="border-b border-dotted border-[#e5dfc8] transition-colors hover:bg-amber-100/70">
                        <TableCell>
                          <div className="font-semibold">{b.bill_nos || '—'}</div>
                          <div className="text-[11px] text-muted-foreground">{b.party_name || '—'}</div>
                        </TableCell>
                        <TableCell>{b.disc_bank || b.medium || '—'}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatINR(b.amount)}</TableCell>
                        <TableCell className="text-right tabular-nums text-rose-700">
                          {formatINR(n(b.interest_amount) + n(b.charges))}
                          {n(b.rate_pct) > 0 && <div className="text-[10px] text-muted-foreground">@ {b.rate_pct}%</div>}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-emerald-700">{n(b.net_received) ? formatINR(b.net_received) : '—'}</TableCell>
                        <TableCell>
                          <span className="mr-1.5 tabular-nums">{formatDate(b.maturity_date)}</span>
                          {String(b.status) !== 'realized' && <DueBadge date={b.maturity_date} />}
                        </TableCell>
                        <TableCell>
                          {String(b.status) === 'realized'
                            ? <Badge variant="success">Realized {formatDate(b.payment_received_date)}</Badge>
                            : <Badge variant="warning">Discounted</Badge>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {String(b.status) === 'realized' ? (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={async () => { await window.api.treasury.unrealize(Number(b.id)); load() }}>
                                <RotateCcw className="h-3 w-3" /> Undo
                              </Button>
                            ) : (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-emerald-700" onClick={async () => { try { await window.api.treasury.realize(Number(b.id)); toast.success('Realized — customer cleared against the invoice'); load() } catch (e) { toast.error((e as Error).message) } }}>
                                <Check className="h-3 w-3" /> Realize
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={async () => { if (confirm('Delete this discounted bill? Its vouchers reverse too.')) { await window.api.treasury.deleteDiscount(Number(b.id)); load() } }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="my-4 border-t border-dashed" />
            <BillDiscounting />
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
      <Dialog open={lcLimitOpen} onOpenChange={(o) => !o && setLcLimitOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>LC facility limit</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Fixed limit (₹) *</Label>
              <Input type="number" value={lcLimitForm.fixed_limit ?? ''} onChange={(e) => setLcLimitForm({ ...lcLimitForm, fixed_limit: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <Label>Convertible limit</Label>
                <p className="text-[10px] text-muted-foreground">When on, this adds to the Fixed limit to make the total.</p>
              </div>
              <Switch
                checked={!!lcLimitForm.convertible_enabled}
                onCheckedChange={(v) => setLcLimitForm({ ...lcLimitForm, convertible_enabled: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Convertible limit (₹)</Label>
              <Input
                type="number"
                disabled={!lcLimitForm.convertible_enabled}
                value={lcLimitForm.convertible_limit ?? ''}
                onChange={(e) => setLcLimitForm({ ...lcLimitForm, convertible_limit: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total LC limit</span>
              <span className="text-[15px] font-bold tabular-nums">
                {formatINR(n(lcLimitForm.fixed_limit) + (lcLimitForm.convertible_enabled ? n(lcLimitForm.convertible_limit) : 0))}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLcLimitOpen(false)} disabled={lcLimitSaving}>Cancel</Button>
            <Button onClick={() => void saveLcLimitForm()} disabled={lcLimitSaving}>{lcLimitSaving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preclose an LC — wind it up before its natural maturity */}
      <Dialog open={!!precloseRow} onOpenChange={(o) => !o && setPrecloseRow(null)}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100">
          <div className="flex items-center gap-3 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-[16px] font-bold text-white">
                {precloseRow && isLcPastMaturity(precloseRow) ? 'Repay' : 'Preclose'} LC {precloseRow?.lc_no || '(pending no.)'}
              </DialogTitle>
              <p className="text-[12px] text-white/70">
                {precloseRow && isLcPastMaturity(precloseRow)
                  ? 'Repay this LC now that it has matured.'
                  : "Wind this LC up before its natural maturity."}
              </p>
            </div>
          </div>
          <div className="grid gap-4 p-6">
            <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
              <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><CalendarClock className="h-3 w-3 text-[#1a2c56]" /></span>
                Pre-closure date
              </h3>
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label>Date <span className="text-red-600">*</span></Label>
                <DatePicker
                  value={String(precloseForm.preclose_date || '')}
                  onChange={(v) => setPrecloseForm({ ...precloseForm, preclose_date: v })}
                  min={precloseRow?.open_date || undefined}
                />
              </div>
            </section>

            {preclosePreview && (
              <div className="rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900">
                  <Banknote className="h-3.5 w-3.5" /> Recalculated over the actual period
                  <InfoTip text="This corrects the margin/interest/charges voucher already posted for this LC to the shorter period actually used — a separate entry from the repayment below." />
                  <span className="ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white">
                    <CalendarClock className="h-3 w-3" /> {preclosePreview.days} interest days
                  </span>
                </h3>
                <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">LC Open Amount</div>
                    <div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(preclosePreview.openAmount)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Interest</div>
                    <div className="text-[15px] font-semibold tabular-nums text-rose-700">{formatINR(preclosePreview.interest)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Charges</div>
                    <div className="text-[15px] font-semibold tabular-nums text-rose-700">{formatINR(preclosePreview.charges)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-sky-700">Margin</div>
                    <div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(preclosePreview.margin)}</div>
                  </div>
                </div>
              </div>
            )}

            {preclosePreview && preclosePreview.pendingDays > 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-emerald-900">
                  <AlertTriangle className="h-3.5 w-3.5" /> Premature closure — interest rebate
                  <InfoTip text="Interest for the pending days was already deducted from what the supplier was paid, over the full planned term. Since those days won't actually happen, this comes back as a rebate — either to your own account, or passed on to the supplier." />
                  <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white">
                    <CalendarClock className="h-3 w-3" /> {preclosePreview.pendingDays} pending days
                  </span>
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex flex-wrap items-center gap-1.5">
                      Premature interest (₹)
                      <button
                        type="button"
                        className="text-[10px] font-medium text-teal-700 underline-offset-2 hover:underline"
                        onClick={() => setPrecloseForm({ ...precloseForm, premature_interest: String(preclosePreview.prematureInterest) })}
                      >
                        Use calculated ({formatINR(preclosePreview.prematureInterest)})
                      </button>
                    </Label>
                    <Input
                      type="number"
                      value={precloseForm.premature_interest ?? ''}
                      onChange={(e) => setPrecloseForm({ ...precloseForm, premature_interest: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Rebate goes to</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPrecloseForm({ ...precloseForm, premature_interest_direction: 'credit_to_us' })}
                        className={cn(
                          'rounded-md border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                          precloseForm.premature_interest_direction !== 'pay_to_party'
                            ? 'border-emerald-500 bg-emerald-100 text-emerald-900'
                            : 'border-[#e5dfc8] text-muted-foreground hover:bg-muted/40'
                        )}
                      >
                        Credit to us
                      </button>
                      <button
                        type="button"
                        onClick={() => setPrecloseForm({ ...precloseForm, premature_interest_direction: 'pay_to_party' })}
                        className={cn(
                          'rounded-md border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                          precloseForm.premature_interest_direction === 'pay_to_party'
                            ? 'border-amber-500 bg-amber-50 text-amber-800'
                            : 'border-[#e5dfc8] text-muted-foreground hover:bg-muted/40'
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

            <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
              <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                Repayment to bank
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground">
                Preclosing is a repayment, just like Log Repayment — the bank still wants its full open amount back.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
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
                  <Input type="number" value={precloseForm.amount ?? ''} onChange={(e) => setPrecloseForm({ ...precloseForm, amount: e.target.value })} />
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
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="flex flex-col gap-1.5">
                            <Label>Comm. charges (₹)</Label>
                            <Input
                              type="number"
                              value={precloseForm.comm_charges ?? ''}
                              onChange={(e) => setPrecloseForm({ ...precloseForm, comm_charges: e.target.value })}
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label>Bank charges (₹)</Label>
                            <Input
                              type="number"
                              value={precloseForm.bank_charges ?? ''}
                              onChange={(e) => setPrecloseForm({ ...precloseForm, bank_charges: e.target.value })}
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
                    onChange={(e) => setPrecloseForm({ ...precloseForm, release_margin: e.target.checked })}
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
          <DialogFooter className="px-6 pb-6">
            <Button variant="outline" onClick={() => setPrecloseRow(null)} disabled={precloseSaving}>Cancel</Button>
            <Button onClick={() => void savePreclose()} disabled={precloseSaving}>
              {precloseSaving ? 'Saving…' : precloseRow && isLcPastMaturity(precloseRow) ? 'Repay LC' : 'Preclose LC'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Guided stage advance — asks only for that stage's own date(s) */}
      <Dialog open={!!stageRow} onOpenChange={(o) => !o && setStageRow(null)}>
        <DialogContent
          className={cn(
            'overflow-hidden p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100',
            // The Payment Received step carries the 4-column back-calculated
            // panel plus the upfront-interest toggle's explanatory paragraph —
            // both need real width, or the figures/text wrap badly.
            nextLcStage(String(stageRow?.stage || 'application')) === 'payment_received' ? 'max-w-5xl' : 'max-w-lg'
          )}
        >
          <div className="flex items-center gap-3 bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-[16px] font-bold text-white">
                Mark {stageRow?.lc_no || 'this application'} {STAGE_LABEL[nextLcStage(String(stageRow?.stage || 'application')) || '']}
              </DialogTitle>
              <p className="text-[12px] text-white/70">
                {nextLcStage(String(stageRow?.stage || 'application')) === 'payment_received'
                  ? "Confirm receipt and settle this LC's bill(s) through the books."
                  : 'Record the LC number and the date the bank actually opened it.'}
              </p>
            </div>
          </div>
          {stageRow && (() => {
            const next = nextLcStage(String(stageRow.stage || 'application'))
            return (
              <div className="grid gap-4 p-6">
                {next === 'open' && (
                  <section className="grid gap-3 rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label>LC no <span className="text-red-600">*</span></Label>
                      <Input value={stageForm.lc_no ?? ''} onChange={(e) => setStageForm({ ...stageForm, lc_no: e.target.value })} />
                      <span className="text-[10px] text-muted-foreground">Issued by the bank now that the LC is actually open.</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Open date <span className="text-red-600">*</span></Label>
                      <DatePicker
                        value={String(stageForm.opened_date || '')}
                        onChange={(v) => setStageForm({ ...stageForm, opened_date: v })}
                        min={String(stageRow?.open_date || '') || undefined}
                      />
                    </div>
                  </section>
                )}
                {next === 'payment_received' && (
                  <>
                    <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                      <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><CalendarClock className="h-3 w-3 text-[#1a2c56]" /></span>
                        Dates
                      </h3>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1.5">
                          <Label>Payment received date <span className="text-red-600">*</span></Label>
                          <DatePicker
                            value={String(stageForm.payment_received_date || '')}
                            onChange={(v) => setStageForm({ ...stageForm, payment_received_date: v })}
                            min={String(stageRow?.opened_date || '') || undefined}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Maturity date <span className="text-red-600">*</span></Label>
                          <DatePicker
                            value={String(stageForm.expiry_date || '')}
                            onChange={(v) => setStageForm({ ...stageForm, expiry_date: v })}
                            min={String(stageForm.payment_received_date || '') || undefined}
                          />
                        </div>
                      </div>
                    </section>
                    <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                      <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                        Margin, interest & charges
                      </h3>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="flex flex-col gap-1.5">
                          <Label>Margin %</Label>
                          <Input type="number" value={stageForm.margin_pct ?? ''} onChange={(e) => setStageForm({ ...stageForm, margin_pct: e.target.value })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Interest % p.a. (ROI)</Label>
                          <Input type="number" value={stageForm.interest_pct ?? ''} onChange={(e) => setStageForm({ ...stageForm, interest_pct: e.target.value })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>LC charges (₹)</Label>
                          <Input type="number" value={stageForm.charges ?? ''} onChange={(e) => setStageForm({ ...stageForm, charges: e.target.value })} />
                        </div>
                      </div>
                      <div className="mt-3 flex items-center gap-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5">
                        <Switch checked={!!stageForm.interest_upfront} onCheckedChange={(v) => setStageForm({ ...stageForm, interest_upfront: v })} />
                        <div className="text-[12px] font-semibold">Interest & charges paid upfront</div>
                      </div>
                    </section>
                    {stagePreview && (
                      <div className="rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm">
                        <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900">
                          <Banknote className="h-3.5 w-3.5" /> Back-calculated from the open amount
                          <span className="ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white">
                            <CalendarClock className="h-3 w-3" /> {stagePreview.days ?? 0} interest days
                          </span>
                        </h3>
                        <div className="grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-sky-700">Open amount</div>
                            <div className="text-[16px] font-semibold tabular-nums text-sky-950">{formatINR(stagePreview.amount)}</div>
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
                        <div className="mt-3 flex items-center justify-between rounded-lg bg-white/70 px-4 py-2.5">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-sky-800">
                            {stagePreview.upfront ? 'Net available = open amount (interest & charges paid upfront)' : 'Net available = open amount − interest − charges'}
                          </span>
                          <span className="text-xl font-bold tabular-nums text-[#1a2c56]">{formatINR(stagePreview.netAvailable)}</span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Marking this Payment Received also issues (if not already) and settles this LC's bill(s) through the books.
                    </div>
                  </>
                )}
                {stageError && <p className="text-sm text-destructive">{stageError}</p>}
              </div>
            )
          })()}
          <DialogFooter className="px-6 pb-6">
            <Button variant="outline" onClick={() => setStageRow(null)} disabled={stageSaving}>Cancel</Button>
            <Button onClick={() => void saveStageAdvance()} disabled={stageSaving}>{stageSaving ? 'Saving…' : 'Confirm'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New / edit LC */}
      <Dialog open={!!lcForm} onOpenChange={(o) => !o && setLcForm(null)}>
        <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto p-0 shadow-2xl [&>button]:text-white [&>button]:opacity-90 [&>button:hover]:opacity-100">
          <div className="flex items-center gap-3 rounded-t-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-[16px] font-bold text-white">
                {lcForm?.id ? `Alter LC ${lcForm.lc_no || '(pending no.)'}` : 'Open a letter of credit'}
              </DialogTitle>
              <p className="text-[12px] text-white/70">Track the LC from application through to payment received.</p>
            </div>
            {!!activeCompany && (
              <Select value={String(activeCompany)} onValueChange={onCompanyChange}>
                <SelectTrigger
                  title="Switch company"
                  className="ml-auto mr-8 h-auto w-auto shrink-0 gap-1.5 rounded-full border-0 bg-white/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white/90 shadow-none hover:bg-white/25 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-80"
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
          {lcForm && (
            <div className="grid gap-4 p-6 lg:grid-cols-2">
              <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Landmark className="h-3 w-3 text-[#1a2c56]" /></span>
                  LC & stage
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>LC no {String(lcForm.stage || 'application') !== 'application' && <span className="text-red-600">*</span>}</Label>
                    <Input value={lcForm.lc_no ?? ''} onChange={(e) => setLcForm({ ...lcForm, lc_no: e.target.value })} placeholder={String(lcForm.stage || 'application') === 'application' ? 'Obtained once the LC is Open' : ''} />
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
                        <div className="flex gap-1.5">
                          <Input
                            autoFocus={addingNewBank}
                            value={bank}
                            onChange={(e) => setLcForm({ ...lcForm, bank: e.target.value })}
                            placeholder="Type the new bank's name"
                          />
                          {bankOptions.length > 0 && (
                            <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Pick from the list instead" onClick={() => { setAddingNewBank(false); setLcForm({ ...lcForm, bank: '' }) }}>
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
                              setLcForm({ ...lcForm, bank: v })
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
                    <Input value={lcForm.fd_no ?? ''} onChange={(e) => setLcForm({ ...lcForm, fd_no: e.target.value })} placeholder="e.g. FD/2026/045" />
                    <span className="text-[10px] text-muted-foreground">Fixed deposit lodged as security</span>
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label>Stage</Label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['application', 'open', 'payment_received'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setLcForm({ ...lcForm, stage: s })}
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

              <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Users className="h-3 w-3 text-[#1a2c56]" /></span>
                  Party & purpose
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Purpose <span className="text-red-600">*</span></Label>
                    <Select
                      value={String(lcForm.purpose || '')}
                      onValueChange={(v) =>
                        setLcForm({ ...lcForm, purpose: v, party_id: '', linked_order_ids: [], linked_deal_ids: [], amount_manual: false })
                      }
                    >
                      <SelectTrigger><SelectValue placeholder="Select purpose" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="trading">Trading</SelectItem>
                        <SelectItem value="manufacturing">Manufacturing</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Supplier (beneficiary) <span className="text-red-600">*</span></Label>
                    <Select
                      disabled={!lcForm.purpose}
                      value={lcForm.party_id ? String(lcForm.party_id) : ''}
                      onValueChange={(v) => setLcForm({ ...lcForm, party_id: v })}
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
                    <Label>Trading deals with this supplier <span className="text-[10px] font-normal text-muted-foreground">(select the deal(s) this LC finances — purchase and resale travel together)</span></Label>
                    {lcFormDeals.length === 0 ? (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">No open Trading deals with this supplier yet.</p>
                    ) : (
                      <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-md border bg-white p-1.5">
                        {lcFormDeals.map((d) => {
                          const dealIds: number[] = Array.isArray(lcForm.linked_deal_ids) ? lcForm.linked_deal_ids : []
                          const checked = dealIds.map(String).includes(String(d.id))
                          return (
                            <label key={String(d.id)} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px]', checked ? 'bg-teal-100' : 'hover:bg-muted/40')}>
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5"
                                checked={checked}
                                onChange={(e) => {
                                  const nextDealIds = e.target.checked
                                    ? [...dealIds, Number(d.id)]
                                    : dealIds.filter((x) => String(x) !== String(d.id))
                                  const pickedDeals = lcFormDeals.filter((x) => nextDealIds.map(String).includes(String(x.id)))
                                  // A deal's purchase side can span more than one invoice
                                  // (multi-invoice deals) — every one of them counts
                                  // toward what the LC covers, same as picking each
                                  // invoice individually would.
                                  const orderIds = pickedDeals.flatMap((x) =>
                                    (Array.isArray(x.purchase_lines) ? x.purchase_lines : []).map((l: Row) => Number(l.order_id))
                                  )
                                  const total = round2(pickedDeals.reduce((s, x) => s + n(x.purchase_net), 0))
                                  setLcForm({
                                    ...lcForm,
                                    linked_deal_ids: nextDealIds,
                                    linked_order_ids: orderIds,
                                    amount: lcForm.amount_manual ? lcForm.amount : String(total),
                                    // The customer this deal will resell to is who the
                                    // repayment is expected from — pre-filled, not forced.
                                    receivable_party_id: lcForm.receivable_party_id || (e.target.checked ? d.customer_id : lcForm.receivable_party_id)
                                  })
                                }}
                              />
                              <span className="flex-1">
                                {d.purchase_invoice_no || `Deal #${d.id}`} · {formatDate(d.deal_date)}
                                <span className="ml-1.5 text-muted-foreground">→ {d.customer_name || 'no customer yet'}</span>
                              </span>
                              <span className="font-medium tabular-nums">{formatINR(d.purchase_net)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                    {(() => {
                      const dealIds: number[] = Array.isArray(lcForm.linked_deal_ids) ? lcForm.linked_deal_ids : []
                      if (!dealIds.length) return null
                      const total = round2(
                        lcFormDeals
                          .filter((d) => dealIds.map(String).includes(String(d.id)))
                          .reduce((s, d) => s + n(d.purchase_net), 0)
                      )
                      const over = n(lcForm.amount) - total
                      return (
                        <div className={cn('mt-1.5 flex items-center justify-between text-[11px]', over > 0.005 ? 'font-medium text-rose-700' : 'text-teal-800')}>
                          <span>Selected deals' purchase total</span>
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
                                  setLcForm({ ...lcForm, linked_order_ids: next, amount: lcForm.amount_manual ? lcForm.amount : String(total) })
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
                        onValueChange={(v) => setLcForm({ ...lcForm, receivable_party_id: v })}
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

              <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><CalendarRange className="h-3 w-3 text-[#1a2c56]" /></span>
                  Amount & validity
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(() => {
                    const linkedIds: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                    const hasInvoices = linkedIds.length > 0
                    const total = round2(
                      orders
                        .filter((o) => linkedIds.map(String).includes(String(o.id)))
                        .reduce((s, o) => s + n(o.net_amount), 0)
                    )
                    return (
                      <div className="flex flex-col gap-1.5 sm:col-span-2">
                        <Label className="flex items-center gap-1.5">
                          Open amount (₹) <span className="text-red-600">*</span>
                          {hasInvoices && (
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {lcForm.amount_manual ? '(manual)' : '(auto — sum of selected invoices)'}
                            </span>
                          )}
                          {hasInvoices && lcForm.amount_manual && (
                            <button
                              type="button"
                              className="text-[10px] font-medium text-teal-700 underline-offset-2 hover:underline"
                              onClick={() => setLcForm({ ...lcForm, amount: String(total), amount_manual: false })}
                            >
                              Reset to sum
                            </button>
                          )}
                        </Label>
                        <Input
                          type="number"
                          value={lcForm.amount ?? ''}
                          onChange={(e) => setLcForm({ ...lcForm, amount: e.target.value, amount_manual: e.target.value !== '' })}
                        />
                        {hasInvoices && (
                          <span className="text-[10px] text-muted-foreground">Suggested from the selected invoices — edit freely, but it can't exceed their total.</span>
                        )}
                      </div>
                    )
                  })()}
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
                          <DatePicker value={String(lcForm.open_date || '')} onChange={(v) => setLcForm({ ...lcForm, open_date: v })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Open date</Label>
                          <DatePicker
                            value={String(lcForm.opened_date || '')}
                            onChange={(v) => setLcForm({ ...lcForm, opened_date: v })}
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
                              setLcForm({ ...lcForm, payment_received_date: v, usance_days: usanceDays })
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
                              setLcForm({ ...lcForm, expiry_date: v, usance_days: usanceDays })
                            }}
                            disabled={stage !== 'payment_received'}
                            min={String(lcForm.payment_received_date || '') || undefined}
                          />
                          {stage !== 'payment_received' && <span className="text-[10px] text-muted-foreground">Set together with payment received</span>}
                        </div>
                        <div className="flex flex-col gap-1.5 sm:col-span-2">
                          <Label>Interest days</Label>
                          {days != null ? (
                            <div className="flex h-11 items-center justify-between rounded-md border border-sky-300 bg-sky-50 px-3">
                              <span className="text-lg font-bold tabular-nums text-sky-950">{days} days</span>
                              <span className="rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Auto</span>
                            </div>
                          ) : (
                            <div className="flex h-11 items-center rounded-md border border-dashed bg-muted/20 px-3 text-[12px] italic text-muted-foreground">
                              Calculated once maturity date &amp; payment received date are set
                            </div>
                          )}
                        </div>
                      </>
                    )
                  })()}
                </div>
              </section>

              <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Percent className="h-3 w-3 text-[#1a2c56]" /></span>
                  Margin, interest & charges
                </h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5"><Label>Margin %</Label><Input type="number" value={lcForm.margin_pct ?? ''} onChange={(e) => setLcForm({ ...lcForm, margin_pct: e.target.value })} /></div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Interest % p.a. (ROI) {String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.interest_pct ?? ''} onChange={(e) => setLcForm({ ...lcForm, interest_pct: e.target.value })} disabled={String(lcForm.stage) !== 'payment_received'} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>LC charges (₹) {String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.charges ?? ''} onChange={(e) => setLcForm({ ...lcForm, charges: e.target.value })} disabled={String(lcForm.stage) !== 'payment_received'} />
                  </div>
                </div>
                <span className="mt-1 block text-[10px] text-muted-foreground">ROI and LC charges are obtained once payment is received; interest is charged over the interest days (maturity date − payment received date).</span>
                <div className="mt-3 flex items-center gap-2 rounded-md border border-[#e5dfc8] bg-muted/30 px-3 py-2.5">
                  <Switch checked={!!lcForm.interest_upfront} onCheckedChange={(v) => setLcForm({ ...lcForm, interest_upfront: v })} />
                  <div className="text-[12px] font-semibold">Interest & charges paid upfront</div>
                </div>
              </section>

              {n(lcForm.amount) > 0 && (n(lcForm.margin_pct) > 0 || n(lcForm.interest_pct) > 0 || n(lcForm.charges) > 0) && (() => {
                const openAmount = n(lcForm.amount)
                // Margin is the security deposit the bank asks for on the LC's
                // own open amount — a straight percentage of the credit limit
                // itself, not of whichever invoices happen to be linked to it.
                const margin = round2((openAmount * n(lcForm.margin_pct)) / 100)
                const interest = round2((openAmount * n(lcForm.interest_pct) * n(lcForm.usance_days)) / (100 * 365))
                const charges = round2(n(lcForm.charges))
                const upfront = !!lcForm.interest_upfront
                // Back-calculation: the open amount is the limit as struck with
                // the bank — interest and charges come OUT of it, not on top —
                // unless both are being paid upfront from the bank instead.
                const netAvailable = upfront ? openAmount : round2(openAmount - interest - charges)
                return (
                  <div className="rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm lg:col-span-2">
                    <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900">
                      <Banknote className="h-3.5 w-3.5" /> Back-calculated from the open amount
                      <span className="ml-auto flex items-center gap-1 rounded-full bg-sky-700 px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal text-white">
                        <CalendarClock className="h-3 w-3" /> {n(lcForm.usance_days) || 0} interest days
                      </span>
                    </h3>
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
                    <div className="mt-3 flex items-center justify-between rounded-lg bg-white/70 px-4 py-2.5">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-sky-800">
                        {upfront ? 'Net available = open amount (interest & charges paid upfront)' : 'Net available = open amount − interest − charges'}
                      </span>
                      <span className="text-xl font-bold tabular-nums text-[#1a2c56]">{formatINR(netAvailable)}</span>
                    </div>
                  </div>
                )
              })()}

              <div className="flex flex-col gap-1.5 lg:col-span-2"><Label>Note</Label><Input value={lcForm.note ?? ''} onChange={(e) => setLcForm({ ...lcForm, note: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter className="border-t border-[#e5dfc8] bg-muted/20 px-6 py-4">
            <Button variant="outline" onClick={() => setLcForm(null)}>Cancel</Button>
            <Button disabled={busy} className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void saveLc()}>{busy ? 'Saving…' : 'Save LC'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LC detail — a proper modal instead of expanding the row in place */}
      <Dialog open={lcDetailId != null} onOpenChange={(o) => !o && setLcDetailId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {(() => {
            const dRow = lcDetailId != null ? lcs.find((x) => Number(x.id) === lcDetailId) : null
            if (!dRow) return null
            const pct = n(dRow.amount) > 0 ? Math.min(100, (n(dRow.utilized) / n(dRow.amount)) * 100) : 0
            const barTone = pct >= 95 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-sky-600'
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex flex-wrap items-center gap-1.5 pr-6">
                    <span className={cn(!dRow.lc_no && 'italic text-muted-foreground')}>{dRow.lc_no || 'Pending LC no'}</span>
                    <StageBadge stage={String(dRow.stage || 'application')} />
                    {dRow.preclosed_date && <Badge variant="muted">Preclosed {formatDate(dRow.preclosed_date)}</Badge>}
                    {isLcPaymentInDone(dRow) && <Badge variant="success">Payment IN</Badge>}
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
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                    <span className="flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5 shrink-0" /> {dRow.bank}</span>
                    <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5 shrink-0" /> {dRow.supplier_name || '—'}</span>
                    {dRow.fd_no && <span>FD {dRow.fd_no}</span>}
                  </div>
                  <div className="rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-white/60">LC amount</div>
                    <div className="text-2xl font-bold tabular-nums text-white">{formatINR(dRow.amount)}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                    <div className="rounded-md border border-[#e5dfc8] bg-white px-2.5 py-1.5">
                      <div className="text-muted-foreground">Utilised</div>
                      <div className="font-semibold tabular-nums text-[#1a2c56]">{formatINR(dRow.utilized)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.available) <= 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50')}>
                      <div className="text-muted-foreground">Available</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.available) <= 0 ? 'text-rose-600' : 'text-emerald-700')}>{formatINR(dRow.available)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.repaid) > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-[#e5dfc8] bg-white')}>
                      <div className="text-muted-foreground">Repaid</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.repaid) > 0 ? 'text-emerald-700' : 'text-[#1a2c56]')}>{formatINR(dRow.repaid)}</div>
                    </div>
                    <div className={cn('rounded-md border px-2.5 py-1.5', n(dRow.outstanding) > 0 ? 'border-amber-200 bg-amber-50' : 'border-[#e5dfc8] bg-white')}>
                      <div className="text-muted-foreground">Outstanding</div>
                      <div className={cn('font-semibold tabular-nums', n(dRow.outstanding) > 0 ? 'text-amber-800' : 'text-[#1a2c56]')}>{formatINR(dRow.outstanding)}</div>
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
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-[#e5dfc8] bg-white p-3 text-[11px] sm:grid-cols-4">
                    <div><div className="text-muted-foreground">Application</div><div className="font-medium tabular-nums">{formatDate(dRow.open_date)}</div></div>
                    <div><div className="text-muted-foreground">Open</div><div className="font-medium tabular-nums">{formatDate(dRow.opened_date)}</div></div>
                    <div><div className="text-muted-foreground">Payment received</div><div className="font-medium tabular-nums">{formatDate(dRow.payment_received_date)}</div></div>
                    <div><div className="text-muted-foreground">Maturity</div><div className="font-medium tabular-nums">{formatDate(dRow.expiry_date)}</div></div>
                    <div><div className="text-muted-foreground">Margin</div><div className="font-medium tabular-nums">{n(dRow.margin_pct)}%</div></div>
                    <div><div className="text-muted-foreground">Interest</div><div className="font-medium tabular-nums">{n(dRow.interest_pct)}%{dRow.interest_upfront ? ' upfront' : ''}</div></div>
                    <div><div className="text-muted-foreground">Charges</div><div className="font-medium tabular-nums">{formatINR(dRow.charges)}</div></div>
                    <div><div className="text-muted-foreground">Int. days</div><div className="font-medium tabular-nums">{n(dRow.usance_days) > 0 ? n(dRow.usance_days) : '—'}</div></div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] pt-3">
                    {(() => {
                      const next = nextLcStage(String(dRow.stage || 'application'))
                      if (!next) return null
                      return (
                        <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => { setLcDetailId(null); openStageAdvance(dRow) }}>
                          Mark {STAGE_LABEL[next]}
                        </Button>
                      )
                    })()}
                    {!dRow.preclosed_date && (
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
                    {canMarkPaymentIn(dRow) && (
                      <Button
                        size="sm"
                        className="h-7 bg-emerald-600 px-2 text-xs hover:bg-emerald-700"
                        title="Record the customer's payment for the resale, closing this LC"
                        onClick={() => { setLcDetailId(null); void openPaymentIn(dRow) }}
                      >
                        Mark Payment IN
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setLcDetailId(null); setLcForm({ ...dRow }) }}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive" onClick={() => { setLcDetailId(null); requestDeleteLc(dRow) }}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                  <div className="border-t border-[#e5dfc8] pt-1 [&>div]:px-0 [&>div]:sm:px-0">{lcExpanded(dRow)}</div>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Log / post an LC repayment */}
      <Dialog open={!!repayForm} onOpenChange={(o) => !o && setRepayForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Alter repayment</DialogTitle></DialogHeader>
          {repayForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Related party <span className="text-[10px] font-normal text-muted-foreground">(optional — for reference only, not posted)</span></Label>
                <Select value={repayForm.party_id ? String(repayForm.party_id) : ''} onValueChange={(v) => setRepayForm({ ...repayForm, party_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {customers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Open amount (LC)</Label>
                <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
                  {formatINR(n(repayForm.open_amount))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Repayment amount (₹) *</Label>
                <Input type="number" value={repayForm.amount ?? ''} onChange={(e) => setRepayForm({ ...repayForm, amount: e.target.value })} />
                {n(repayForm.amount) > 0 && n(repayForm.amount) < n(repayForm.open_amount) - 0.005 && (
                  <span className="text-[10px] font-medium text-rose-600">Cannot be less than the open amount</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5"><Label>Date</Label><DatePicker value={String(repayForm.repay_date || '')} onChange={(v) => setRepayForm({ ...repayForm, repay_date: v })} /></div>
              {(() => {
                const excess = round2(n(repayForm.amount) - n(repayForm.open_amount))
                if (excess <= 0.005) return null
                const splitTotal = round2(n(repayForm.comm_charges) + n(repayForm.bank_charges))
                const splitOff = Math.abs(splitTotal - excess) > 0.005
                return (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 sm:col-span-2">
                    <p className="mb-2 text-[11px] font-medium text-amber-900">
                      This repayment is {formatINR(excess)} over the open amount — split that excess between commission and bank charges below.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Comm. charges (₹)</Label>
                        <Input type="number" value={repayForm.comm_charges ?? ''} onChange={(e) => setRepayForm({ ...repayForm, comm_charges: e.target.value })} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Bank charges (₹)</Label>
                        <Input type="number" value={repayForm.bank_charges ?? ''} onChange={(e) => setRepayForm({ ...repayForm, bank_charges: e.target.value })} />
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
              {n(repayForm.amount) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label>Total debited from bank</Label>
                  <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
                    {formatINR(n(repayForm.amount))}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Bank document / payment letter <span className="text-[10px] font-normal text-muted-foreground">(optional)</span></Label>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void pickRepaymentDocument()}>
                    <Paperclip className="h-3.5 w-3.5" /> Attach file
                  </Button>
                  {repayForm.document_path ? (
                    <span className="truncate text-[11px] text-muted-foreground" title={String(repayForm.document_path)}>
                      {String(repayForm.document_path).split(/[\\/]/).pop()}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">No file attached — you can save without one</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={repayForm.note ?? ''} onChange={(e) => setRepayForm({ ...repayForm, note: e.target.value })} /></div>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={!!repayForm.posted}
                  onChange={(e) => setRepayForm({ ...repayForm, posted: e.target.checked })}
                />
                Post to the books now — Dr LC Repayment (+ Maturity charges) / Cr Bank
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveRepayment()}>{busy ? 'Saving…' : repayForm?.posted ? 'Save & post' : 'Save as draft'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* LC Payment IN — the customer's payment for the resale, closing a Trading LC's round trip */}
      <Dialog open={!!paymentInForm} onOpenChange={(o) => !o && setPaymentInForm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark {paymentInForm?.lc_no || 'this LC'} Payment IN</DialogTitle>
          </DialogHeader>
          {paymentInForm && (
            <div className="grid gap-3">
              <p className="text-[12px] text-muted-foreground">
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
                          <span className="flex-1">{inv.invoice_no || inv.key} · {formatDate(inv.sale_date)}</span>
                          <span className="font-medium tabular-nums">{formatINR(inv.due)}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Date</Label>
                <DatePicker value={String(paymentInForm.date || '')} onChange={(v) => setPaymentInForm({ ...paymentInForm, date: v })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Amount received (₹) *</Label>
                <Input
                  type="number"
                  value={paymentInForm.amount ?? ''}
                  onChange={(e) => setPaymentInForm({ ...paymentInForm, amount: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentInForm(null)}>Cancel</Button>
            <Button disabled={busy} className="bg-emerald-600 hover:bg-emerald-700" onClick={() => void savePaymentIn()}>
              {busy ? 'Posting…' : 'Post Payment IN'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discount a bill */}
      <Dialog open={!!bdForm} onOpenChange={(o) => !o && setBdForm(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Discount a sale bill</DialogTitle></DialogHeader>
          {bdForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Sale invoice</Label>
                <Select
                  value={bdForm.invoice_group ? String(bdForm.invoice_group) : ''}
                  onValueChange={(v) => {
                    const inv = saleInvoices.find((x) => x.group === v)
                    if (inv) setBdForm({ ...bdForm, invoice_group: v, bill_nos: inv.invoice_no, party_name: inv.customer, customer_id: inv.customer_id, amount: String(Math.round(inv.net)) })
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="Pick the invoice being discounted" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {saleInvoices.map((x) => (
                      <SelectItem key={x.group} value={x.group}>
                        {x.invoice_no} · {x.customer || 'CASH'} · {formatINR(x.net)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5"><Label>Discounting bank *</Label><Input value={bdForm.disc_bank ?? ''} onChange={(e) => setBdForm({ ...bdForm, disc_bank: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Bill amount (₹) *</Label><Input type="number" value={bdForm.amount ?? ''} onChange={(e) => setBdForm({ ...bdForm, amount: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Discount date</Label><DatePicker value={String(bdForm.open_date || '')} onChange={(v) => setBdForm({ ...bdForm, open_date: v })} /></div>
              <div className="flex flex-col gap-1.5">
                <Label>Maturity date</Label>
                <DatePicker value={String(bdForm.maturity_date || '')} onChange={(v) => setBdForm({ ...bdForm, maturity_date: v })} />
                <span className="text-[10px] text-muted-foreground">or leave blank and give tenor days</span>
              </div>
              <div className="flex flex-col gap-1.5"><Label>Tenor (days)</Label><Input type="number" value={bdForm.tenor_days ?? ''} onChange={(e) => setBdForm({ ...bdForm, tenor_days: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Rate % p.a. *</Label><Input type="number" value={bdForm.rate_pct ?? ''} onChange={(e) => setBdForm({ ...bdForm, rate_pct: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Bank charges (₹)</Label><Input type="number" value={bdForm.charges ?? ''} onChange={(e) => setBdForm({ ...bdForm, charges: e.target.value })} /></div>
              {bdPreview && n(bdForm.amount) > 0 && (
                <div className="sm:col-span-2 grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-2.5 text-center">
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{bdPreview.days} days interest</div><div className="text-[13px] font-semibold tabular-nums text-rose-700">{formatINR(bdPreview.interest)}</div></div>
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Charges</div><div className="text-[13px] font-semibold tabular-nums text-rose-700">{formatINR(n(bdForm.charges))}</div></div>
                  <div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bank credits now</div><div className="text-[13px] font-bold tabular-nums text-emerald-700">{formatINR(bdPreview.net)}</div></div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBdForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveBd()}>{busy ? 'Saving…' : 'Discount bill'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
