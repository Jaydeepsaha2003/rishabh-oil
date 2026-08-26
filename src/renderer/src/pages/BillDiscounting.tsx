import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Banknote,
  Building2,
  CalendarRange,
  ChevronRight,
  LayoutGrid,
  Landmark,
  List,
  Pencil,
  Plus,
  RotateCcw,
  FileSpreadsheet,
  Settings2,
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
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { RowActions } from '@/components/ui/row-actions'
import { formatDate, formatDateShort, formatINR, todayISO } from '@/lib/format'
import { isTradingParty } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { exportBdRegister } from '@/lib/bdExcel'

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

// Countdown chip: red overdue, amber close, muted otherwise.
function DueBadge({ date }: { date: unknown }): React.JSX.Element | null {
  const d = daysTo(date)
  if (d == null) return null
  const label = d < 0 ? `${-d}D overdue` : d === 0 ? 'due today' : `${d}D left`
  return (
    <Badge variant={d < 0 ? 'destructive' : d <= 7 ? 'warning' : 'muted'} className="tabular-nums">
      {label}
    </Badge>
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
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const NBFC_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'NBFC' },
  { key: 'finance_type', label: 'Provides' },
  { key: 'interest_pct', label: 'Int %', align: 'right' },
  { key: 'interest_days', label: 'Int days', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'days_year', label: 'Yr basis', align: 'right' },
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
function bdCalc(f: Row): {
  intDays: number
  marginAmount: number
  openAmount: number
  interestAmount: number
  tdsAmount: number
  netInterest: number
  receiptAmount: number
} {
  const amount = n(f.amount)
  const from = String(f.payment_received_date || '').slice(0, 10)
  const to = String(f.maturity_date || '').slice(0, 10)
  const intDays = from && to ? Math.max(0, (daysTo(to) ?? 0) - (daysTo(from) ?? 0)) : 0
  const marginAmount = round2((amount * n(f.margin_pct)) / 100)
  const openAmount = round2(amount - marginAmount)
  const daysYear = n(f.days_year) || 360
  const interestAmount = round2((openAmount * n(f.interest_pct) * intDays) / (100 * daysYear))
  const tdsAmount = round2((interestAmount * n(f.tds_pct)) / 100)
  const netInterest = round2(interestAmount - tdsAmount)
  const receiptAmount = f.interest_upfront ? openAmount : round2(openAmount - interestAmount)
  return { intDays, marginAmount, openAmount, interestAmount, tdsAmount, netInterest, receiptAmount }
}

// The company controls come from Treasury, which already holds them for the LC
// form. A discounted bill is booked into ONE company's books and draws on that
// company's invoices, so the company has to be settable without leaving the
// form — the same way opening an LC does it.
export function BillDiscounting({
  companies = [],
  activeCompany = 0,
  onCompanyChange,
  // The lender in view, chosen in the page header. A discounted bill is against
  // an NBFC, not a bank, which is what that picker names on this tab.
  nbfcFilter = '',
  onNbfcsLoaded
}: {
  companies?: Row[]
  activeCompany?: number
  onCompanyChange?: (id: string) => void
  nbfcFilter?: string
  onNbfcsLoaded?: (rows: Row[]) => void
} = {}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [nbfcs, setNbfcs] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])

  const [view, setView] = useState<'cards' | 'table'>('table')
  const [duePeriod, setDuePeriod] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'awaiting' | 'live' | 'repaid'>('all')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  const [form, setForm] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)
  const [nbfcOpen, setNbfcOpen] = useState(false)
  const [repayRow, setRepayRow] = useState<Row | null>(null)
  const [repayForm, setRepayForm] = useState<Row>({})
  const [repaySaving, setRepaySaving] = useState(false)
  // The parts already paid on the bill in the dialog, so it opens showing what
  // has gone back rather than only what is left.
  const [repayParts, setRepayParts] = useState<Row[]>([])
  // The bill whose receipt is being stamped, and the date being stamped on it.
  const [receiveRow, setReceiveRow] = useState<Row | null>(null)
  const [receiveDate, setReceiveDate] = useState('')
  const [receiveSaving, setReceiveSaving] = useState(false)

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
  const loadBills = useCallback(async () => {
    const list = await window.api.billDiscounting.list()
    setRows(list)
    // Handed back so a caller that has just posted something can pick its own
    // row out of the fresh list instead of reading the stale one it held.
    return list
  }, [])

  const loadMasters = useCallback(async () => {
    const [nb, sup, cust] = await Promise.all([
      window.api.data.list('nbfcs'),
      window.api.data.list('suppliers'),
      window.api.data.list('customers')
    ])
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
  }, [loadBills, loadMasters])
  useLiveRefresh(() => {
    void loadBills()
  })

  // The same figures bdKpis returned, off the rows already loaded -- exposure
  // counts only funded bills, since nothing is disbursed on one still awaiting
  // its payment, and those are reported separately.
  const kpis = useMemo(() => {
    const open = rows.filter((r) => String(r.status) !== 'repaid')
    const live = open.filter((r) => String(r.stage) === 'live')
    const awaiting = open.filter((r) => String(r.stage) === 'awaiting')
    const sum = (list: Row[], key: string): number => round2(list.reduce((t, r) => t + n(r[key]), 0))
    return {
      count: live.length,
      outstanding_total: sum(live, 'outstanding_amount'),
      margin_total: sum(live, 'marginAmount'),
      interest_total: sum(live, 'interestAmount'),
      tds_total: sum(live, 'tdsAmount'),
      receipt_total: sum(live, 'receiptAmount'),
      awaiting_count: awaiting.length,
      awaiting_total: sum(awaiting, 'amount')
    }
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows
    if (nbfcFilter) list = list.filter((r) => String(r.nbfc_id ?? '') === String(nbfcFilter))
    if (statusFilter !== 'all') list = list.filter((r) => String(r.stage) === statusFilter)
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
    return list
  }, [rows, nbfcFilter, statusFilter, typeFilter, duePeriod])

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
      amount: '',
      margin_pct: '',
      interest_pct: '',
      tds_pct: '',
      days_year: 360,
      interest_upfront: false
    })
  }

  function openEdit(r: Row): void {
    setForm({
      id: r.id,
      bd_no: r.bd_no || '',
      nbfc_id: r.nbfc_id ? String(r.nbfc_id) : '',
      finance_type: r.finance_type,
      party_type: r.party_type,
      party_id: r.party_id ? String(r.party_id) : '',
      purpose: r.purpose,
      invoice_amount: r.invoice_amount ?? '',
      amount: r.amount ?? '',
      // Not editable on this form any more — it is stamped by Mark payment
      // received — but carried through so saving other terms cannot clear it.
      payment_received_date: r.payment_received_date || '',
      maturity_date: r.maturity_date || '',
      margin_pct: r.margin_pct ?? '',
      interest_pct: r.interest_pct ?? '',
      tds_pct: r.tds_pct ?? '',
      days_year: r.days_year ?? 360,
      interest_upfront: !!r.interest_upfront,
      note: r.note || ''
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
      nbfc_id: ''
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

  const preview = useMemo(() => (form ? bdCalc(form) : null), [form])

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
        purpose: form.purpose,
        amount: Number(form.amount) || 0,
        invoice_amount: String(form.invoice_amount ?? '').trim() === '' ? null : Number(form.invoice_amount),
        payment_received_date: form.payment_received_date || null,
        maturity_date: form.maturity_date || null,
        margin_pct: Number(form.margin_pct) || 0,
        interest_pct: Number(form.interest_pct) || 0,
        tds_pct: Number(form.tds_pct) || 0,
        days_year: Number(form.days_year) || 360,
        interest_upfront: !!form.interest_upfront,
        note: form.note || null
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

  async function loadRepayParts(bdId: number): Promise<void> {
    try {
      setRepayParts(await window.api.billDiscounting.repayments(bdId))
    } catch {
      setRepayParts([])
    }
  }

  function openRepay(r: Row): void {
    setRepayRow(r)
    // Defaults to clearing the balance — the ordinary case — and is editable
    // down to whatever instalment is actually going back.
    setRepayForm({
      repay_date: todayISO(),
      settle_via: 'bank',
      ref: '',
      amount: String(dueOn(r)),
      release_margin: n(r.marginAmount) > 0
    })
    setRepayParts([])
    void loadRepayParts(Number(r.id))
  }

  async function saveRepay(): Promise<void> {
    if (!repayRow) return
    const due = dueOn(repayRow)
    const amount = round2(n(repayForm.amount))
    if (amount <= 0) {
      toast.error('Enter the amount being repaid')
      return
    }
    if (amount - due > 0.004) {
      toast.error(`Only ${formatINR(due)} is still outstanding on this bill`)
      return
    }
    setRepaySaving(true)
    try {
      const res = await window.api.billDiscounting.repay(Number(repayRow.id), {
        repay_date: repayForm.repay_date || undefined,
        settle_via: repayForm.settle_via === 'party' ? 'party' : 'bank',
        ref: repayForm.settle_via === 'party' && repayForm.ref ? String(repayForm.ref) : null,
        release_margin: !!repayForm.release_margin,
        amount
      })
      toast.success(
        res.closed
          ? 'Bill repaid in full — posted to the books'
          : `${formatINR(res.amount)} repaid — ${formatINR(res.outstanding)} still outstanding`
      )
      // Part payments keep the dialog open on the same bill so the next
      // instalment can go straight in; a full repayment closes it.
      const fresh = await load()
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
      await exportBdRegister(filtered, `bd-register-${todayISO()}`, parts)
      toast.success(`Downloaded ${filtered.length} bill${filtered.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  function openReceive(r: Row): void {
    setReceiveRow(r)
    setReceiveDate(String(r.payment_received_date || '').slice(0, 10) || todayISO())
  }

  async function saveReceive(): Promise<void> {
    if (!receiveRow) return
    if (!receiveDate) {
      toast.error('Pick the date the payment landed')
      return
    }
    setReceiveSaving(true)
    try {
      await window.api.billDiscounting.markReceived(Number(receiveRow.id), receiveDate)
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
      <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
        <div className="flex items-center gap-2 rounded-t-md bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-2 text-white shadow-sm">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15">
            <Banknote className="h-3.5 w-3.5" />
          </span>
          <span className="text-[13px] font-bold uppercase tracking-widest">Bill Discounting</span>
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums">
            {n(kpis.count)} open
          </span>
          {/* Awaiting bills are deliberately NOT in the money figures below —
              nothing has been disbursed on them — so they are counted here
              rather than being left invisible. */}
          {n(kpis.awaiting_count) > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilter('awaiting')}
              className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#1a2c56] transition-colors hover:bg-amber-300"
              title="Opened, waiting on the NBFC's payment — click to show only these"
            >
              {n(kpis.awaiting_count)} awaiting {formatINR(kpis.awaiting_total)}
            </button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white"
            disabled={exporting || filtered.length === 0}
            title={filtered.length === 0 ? 'Nothing in this filter to download' : 'Download this register as Excel'}
            onClick={() => void downloadRegister()}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> {exporting ? 'Preparing…' : 'Download Excel'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white"
            onClick={() => setNbfcOpen(true)}
          >
            <Settings2 className="h-3.5 w-3.5" /> Manage NBFCs
          </Button>
          {/* Primary action, amber against the navy so it stands out from the
              header it sits on. */}
          <Button size="sm" className="h-7 bg-amber-400 px-2 text-xs font-semibold text-[#1a2c56] shadow-sm hover:bg-amber-300" onClick={openNew}>
            <Plus className="h-4 w-4" /> Discount a bill
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-px bg-[#e5dfc8] p-px sm:grid-cols-3 lg:grid-cols-5">
          <div className="bg-[#1a2c56] px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/70">Outstanding</div>
            <div className="text-[15px] font-bold tabular-nums text-white">{formatINR(kpis.outstanding_total)}</div>
          </div>
          <div className="bg-[#fffdf4] px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Margin held</div>
            <div className="text-[15px] font-bold tabular-nums text-[#1a2c56]">{formatINR(kpis.margin_total)}</div>
          </div>
          <div className="bg-[#fffdf4] px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Interest</div>
            <div className="text-[15px] font-bold tabular-nums text-rose-700">{formatINR(kpis.interest_total)}</div>
          </div>
          <div className="bg-[#fffdf4] px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">TDS withheld</div>
            <div className="text-[15px] font-bold tabular-nums text-[#1a2c56]">{formatINR(kpis.tds_total)}</div>
          </div>
          <div className="bg-emerald-50 px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800">Received</div>
            <div className="text-[15px] font-bold tabular-nums text-emerald-900">{formatINR(kpis.receipt_total)}</div>
          </div>
        </div>
      </div>

      {/* Filter chips — mirroring the LC register's own row. */}
      <div className="flex flex-wrap items-center gap-2">
        {DUE_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setDuePeriod(p.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              duePeriod === p.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50'
            )}
          >
            {p.label}
          </button>
        ))}
        <div className="h-4 w-px bg-[#e5dfc8]" />
        {(['PID', 'SID'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTypeFilter(typeFilter === t ? null : t)}
            title={t === 'PID' ? 'Purchase Invoice Discounting' : 'Sales Invoice Discounting'}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              typeFilter === t ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50'
            )}
          >
            {t}
          </button>
        ))}
        <div className="h-4 w-px bg-[#e5dfc8]" />
        {(
          [
            { key: 'all', label: 'All bills' },
            { key: 'awaiting', label: 'Awaiting payment' },
            { key: 'live', label: 'Open' },
            { key: 'repaid', label: 'Repaid' }
          ] as const
        ).map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setStatusFilter(s.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              statusFilter === s.key ? 'border-[#1a2c56] bg-[#1a2c56] text-white' : 'border-[#d9d2b8] bg-white text-[#1a2c56] hover:bg-amber-50'
            )}
          >
            {s.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1 rounded-md border border-[#d9d2b8] bg-white p-0.5">
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
            filtered.map((r) => {
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
                          <Users className="h-3 w-3 shrink-0" /> {r.party_name || '—'}
                        </div>
                      </div>
                      <Badge variant="muted" className="capitalize">{r.purpose}</Badge>
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
                      <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openRepay(r)}>
                        Repay
                      </Button>
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
            <Table className="text-[13px]">
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="border-b-2 border-[#1a2c56]/20 bg-[#dce6f5] hover:bg-[#dce6f5]">
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">BD no · NBFC</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Party</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Validity</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Days left</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Int. days</TableHead>
                  <TableHead className="h-9 whitespace-nowrap border-l border-[#1a2c56]/15 text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                    Open amount
                  </TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Margin</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Interest</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">TDS</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Receipt</TableHead>
                  <TableHead className="h-9 whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* What the filters actually left, summed — the same idea the LC
                    register uses, so a bucket answers "how much" without
                    adding it up by eye. */}
                {filtered.length > 0 && (
                  <TableRow className="border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50">
                    <TableCell className="whitespace-nowrap font-semibold text-amber-900">
                      Total
                      <span className="ml-1.5 font-normal text-amber-800/70">
                        ({filtered.length} bill{filtered.length === 1 ? '' : 's'})
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
                        {formatINR(filtered.reduce((t, x) => t + n(x[k]), 0))}
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
                  filtered.map((r) => {
                    const repaid = String(r.status) === 'repaid'
                    const awaiting = String(r.stage) === 'awaiting'
                    const tone = STATUS_TONE[String(r.stage)] || STATUS_TONE.open
                    return (
                      <TableRow
                        key={String(r.id)}
                        className={cn('border-b border-dotted border-[#e5dfc8] bg-white transition-colors', tone.row, tone.hover)}
                      >
                        <TableCell className="whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className={cn('font-semibold', !r.bd_no && 'italic text-muted-foreground')}>{r.bd_no || 'No BD no'}</span>
                                <Badge variant="muted">{r.finance_type}</Badge>
                                {repaid && <Badge variant="success">Repaid</Badge>}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {r.nbfc_name || '—'}
                                {n(r.margin_pct) ? ` · margin ${r.margin_pct}%` : ''}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.party_name || '—'}
                          <div className="text-[11px] capitalize text-muted-foreground">{r.purpose}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
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
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
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
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{n(r.intDays)}</TableCell>
                        <TableCell className="whitespace-nowrap border-l border-[#1a2c56]/10 text-right font-medium tabular-nums">
                          {formatINR(r.amount)}
                          {n(r.repaid_total) > 0 && !repaid && (
                            <div className="text-[10px] font-normal text-muted-foreground">
                              −{formatINR(r.repaid_total)} · bal{' '}
                              <span className="font-semibold text-[#1a2c56]">{formatINR(r.outstanding_amount)}</span>
                            </div>
                          )}
                          {n(r.invoice_amount) > 0 && (
                            <div className="text-[10px] font-normal text-muted-foreground" title="Invoice this bill is drawn against">
                              inv {formatINR(r.invoice_amount)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatINR(r.marginAmount)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-rose-700">{formatINR(r.interestAmount)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatINR(r.tdsAmount)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums text-emerald-700">
                          {formatINR(r.receiptAmount)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <div className="flex justify-end gap-1">
                            {repaid ? (
                              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void reopen(r)}>
                                <RotateCcw className="h-3.5 w-3.5" /> Reopen
                              </Button>
                            ) : awaiting ? (
                              <Button
                                size="sm"
                                className="h-7 gap-1 whitespace-nowrap bg-amber-600 px-2 text-xs hover:bg-amber-700"
                                onClick={() => openReceive(r)}
                              >
                                <Banknote className="h-3.5 w-3.5" /> Mark received
                              </Button>
                            ) : (
                              <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openRepay(r)}>
                                Repay
                              </Button>
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
        <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-6xl overflow-y-auto border-[#d9d2b8] bg-[#fffdf4]">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
                {form?.id ? 'Alter discounted bill' : 'Discount a bill'}
              </DialogTitle>
              {!!activeCompany && !!onCompanyChange && companies.length > 1 && (
                <Select value={String(activeCompany)} onValueChange={onCompanyChange}>
                  <SelectTrigger
                    title="Switch company — the bill is booked into this company's books and draws on its invoices"
                    className="ml-auto mr-8 h-auto w-auto shrink-0 gap-1.5 rounded-full border border-[#1a2c56]/20 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#1a2c56] shadow-none hover:bg-[#eef3fb] [&>svg]:h-3 [&>svg]:w-3 [&>svg]:opacity-70"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
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
          </DialogHeader>
          {form && (
            <div className="grid gap-3">
              <section className="rounded border border-[#e5dfc8] bg-white p-4">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Facility
                </h3>
                <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Finance type *
                      <InfoTip text="PID — Purchase Invoice Discounting, drawn against a supplier. SID — Sales Invoice Discounting, drawn against a customer." />
                    </Label>
                    <Select value={String(form.finance_type || '')} onValueChange={chooseFinanceType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PID">PID — Purchase Invoice Discounting</SelectItem>
                        <SelectItem value="SID">SID — Sales Invoice Discounting</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>NBFC *</Label>
                    {/* The Select must be allowed to SHRINK. Without a
                        min-w-0 flex-1 box around it, it sizes to its content
                        and pushes the Manage button out of the cell — it landed
                        on top of the Purpose field beside it. */}
                    <div className="flex min-w-0 gap-1.5">
                      <div className="min-w-0 flex-1">
                        <Select value={String(form.nbfc_id || '')} onValueChange={chooseNbfc}>
                          <SelectTrigger><SelectValue placeholder={formNbfcs.length ? 'Select the NBFC' : 'No NBFC set up yet'} /></SelectTrigger>
                          <SelectContent>
                            {formNbfcs.map((nb) => (
                              <SelectItem key={String(nb.id)} value={String(nb.id)}>{nb.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button type="button" size="icon" variant="outline" className="shrink-0" title="Manage NBFCs" onClick={() => setNbfcOpen(true)}>
                        <Settings2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Purpose *</Label>
                    <Select
                      value={String(form.purpose || '')}
                      onValueChange={(v) => setForm((p) => ({ ...p, purpose: v, party_id: '' }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manufacturing">Manufacturing</SelectItem>
                        <SelectItem value="trading">Trading</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2 xl:col-span-1">
                    <Label>{String(form.finance_type) === 'SID' ? 'Customer *' : 'Supplier *'}</Label>
                    <Select value={String(form.party_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, party_id: v }))}>
                      <SelectTrigger>
                        <SelectValue placeholder={formParties.length ? 'Select the party' : `No ${form.purpose} party set up`} />
                      </SelectTrigger>
                      <SelectContent>
                        {formParties.map((p) => (
                          <SelectItem key={String(p.id)} value={String(p.id)}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      BD no *
                      <InfoTip text="Your own reference for this bill. Every voucher it posts is numbered with it — the disbursement, each repayment, the margin release — so it is how the bill is found in the ledger." />
                    </Label>
                    <Input value={form.bd_no ?? ''} placeholder="Your own reference" onChange={(e) => setForm((p) => ({ ...p, bd_no: e.target.value }))} />
                  </div>
                </div>
              </section>

              <section className="rounded border border-[#e5dfc8] bg-white p-4">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Bill &amp; terms
                </h3>
                <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
                  {/* The invoice behind the bill, and the part of it actually
                      being discounted. They are often not the same figure, and
                      only the second one is priced — the invoice value is kept
                      alongside it so the file records what was financed
                      against what. */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Invoice amount (₹)
                      <InfoTip text="The full value of the invoice this bill is drawn against. Optional, and nothing is priced off it — it is recorded so you can see how much of the invoice was financed." />
                    </Label>
                    <Input
                      type="number"
                      value={form.invoice_amount ?? ''}
                      onChange={(e) => setForm((p) => ({ ...p, invoice_amount: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Open amount (₹) *
                      <InfoTip text="What is being opened against the invoice — the amount the NBFC discounts, and the figure every term below is calculated on. Often less than the invoice itself." />
                    </Label>
                    <Input type="number" value={form.amount ?? ''} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} />
                    {n(form.invoice_amount) > 0 && n(form.amount) > 0 && (
                      <div
                        className={cn(
                          'text-[11px]',
                          n(form.amount) - n(form.invoice_amount) > 0.004 ? 'font-medium text-amber-700' : 'text-muted-foreground'
                        )}
                      >
                        {n(form.amount) - n(form.invoice_amount) > 0.004
                          ? `More than the ${formatINR(form.invoice_amount)} invoice — check the two figures`
                          : `${round2((n(form.amount) / n(form.invoice_amount)) * 100)}% of the ${formatINR(form.invoice_amount)} invoice`}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Maturity date *</Label>
                    <DatePicker
                      value={String(form.maturity_date || '')}
                      min={form.payment_received_date || undefined}
                      onChange={(v) => setForm((p) => ({ ...p, maturity_date: v }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      Margin %
                      <InfoTip text="What the NBFC holds back — on a ₹100 bill, 20% means ₹20 stays with them and ₹80 is released. It's a recoverable deposit, refunded when the bill is repaid." />
                    </Label>
                    <Input type="number" value={form.margin_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, margin_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Interest % p.a.</Label>
                    <Input type="number" value={form.interest_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, interest_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex items-center gap-1">
                      TDS % on interest
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
                  <div className="flex flex-col justify-end gap-1.5">
                    <label className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md border px-3">
                      <Switch checked={!!form.interest_upfront} onCheckedChange={(v) => setForm((p) => ({ ...p, interest_upfront: v }))} />
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">Interest upfront</span>
                        <InfoTip text="The interest is paid separately from the bank rather than deducted from the bill — the opening voucher then leaves it out, and it posts once the matching bank line is reconciled." />
                      </span>
                    </label>
                  </div>
                </div>
              </section>

              {/* Interest runs from the day the payment is received, and that
                  date is stamped later — so on a bill that has not been funded
                  yet the interest, TDS and payout are not knowable and are not
                  shown as zeroes. Margin is, since it is a straight percentage
                  of the open amount. */}
              {preview && n(form.amount) > 0 && !form.payment_received_date && (
                <div className="grid grid-cols-2 gap-px rounded-lg border border-[#e5dfc8] bg-[#e5dfc8] p-px sm:grid-cols-3">
                  <div className="bg-white px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Margin</div>
                    <div className="text-[13px] font-semibold tabular-nums text-[#1a2c56]">{formatINR(preview.marginAmount)}</div>
                  </div>
                  <div className="bg-white px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Funded (net margin)</div>
                    <div className="text-[13px] font-semibold tabular-nums text-[#1a2c56]">{formatINR(preview.openAmount)}</div>
                  </div>
                  <div className="bg-amber-50 px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-amber-800">Interest · TDS · payout</div>
                    <div className="text-[11px] font-medium text-amber-800">worked out on Mark payment received</div>
                  </div>
                </div>
              )}
              {preview && n(form.amount) > 0 && !!form.payment_received_date && (
                <div className="grid grid-cols-2 gap-px rounded-lg border border-[#e5dfc8] bg-[#e5dfc8] p-px sm:grid-cols-4 md:grid-cols-7">
                  {([
                    { label: 'Int. days', value: String(preview.intDays), tone: 'text-[#1a2c56]' },
                    { label: 'Margin', value: formatINR(preview.marginAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Funded (net margin)', value: formatINR(preview.openAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Interest', value: formatINR(preview.interestAmount), tone: 'text-rose-700' },
                    { label: 'TDS', value: formatINR(preview.tdsAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Net int.', value: formatINR(preview.netInterest), tone: 'text-[#1a2c56]' }
                  ] as const).map((c) => (
                    <div key={c.label} className="bg-white px-3 py-2 text-center">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
                      <div className={cn('text-[13px] font-semibold tabular-nums', c.tone)}>{c.value}</div>
                    </div>
                  ))}
                  <div className="bg-emerald-50 px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Net payout</div>
                    <div className="text-[13px] font-bold tabular-nums text-emerald-700">{formatINR(preview.receiptAmount)}</div>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label>Note</Label>
                <Input value={form.note ?? ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark payment received — the middle stage. One question only: the day
          the NBFC's money landed. That date starts the interest clock and posts
          the disbursement, so it is asked when it happens rather than guessed
          at when the bill is opened. */}
      <Dialog open={!!receiveRow} onOpenChange={(o) => !o && setReceiveRow(null)}>
        <DialogContent className="border-[#d9d2b8] bg-[#fffdf4] sm:max-w-md">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
            <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
              {receiveRow?.payment_received_date ? 'Change receipt date' : 'Mark payment received'}
              {receiveRow?.bd_no ? ` — ${receiveRow.bd_no}` : ''}
            </DialogTitle>
          </DialogHeader>
          {receiveRow && (
            <div className="grid gap-4">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                {receiveRow.nbfc_name} · {receiveRow.party_name}
                <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <div className="text-muted-foreground">Open amount</div>
                    <div className="font-semibold tabular-nums">{formatINR(receiveRow.amount)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Maturity</div>
                    <div className="font-semibold tabular-nums">{formatDate(receiveRow.maturity_date)}</div>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Payment received on
                  <InfoTip text="The day the NBFC's money actually landed. Interest runs from this date to maturity, and the disbursement — bank debited, margin held, interest taken — posts on it." />
                </Label>
                <DatePicker value={receiveDate} max={receiveRow.maturity_date || undefined} onChange={(v) => setReceiveDate(v)} />
              </div>
              {receiveDate && receiveRow.maturity_date && (
                <div className="text-[11px] text-muted-foreground">
                  Interest would run {Math.max(0, (daysTo(String(receiveRow.maturity_date).slice(0, 10)) ?? 0) - (daysTo(receiveDate) ?? 0))} days
                  to {formatDate(receiveRow.maturity_date)}.
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveRow(null)} disabled={receiveSaving}>
              Cancel
            </Button>
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void saveReceive()} disabled={receiveSaving}>
              {receiveSaving ? 'Saving…' : receiveRow?.payment_received_date ? 'Change date' : 'Mark received'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Repay dialog */}
      <Dialog open={!!repayRow} onOpenChange={(o) => !o && setRepayRow(null)}>
        <DialogContent className="border-[#d9d2b8] bg-[#fffdf4]">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
            <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
              Repay {repayRow?.bd_no || 'bill'}
            </DialogTitle>
          </DialogHeader>
          {repayRow && (
            <div className="grid gap-4">
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
              {/* A discounted bill is often taken back in instalments, so the
                  amount is asked for rather than assumed. It opens on the whole
                  balance — the ordinary case — and Full balance puts it back. */}
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Amount being repaid
                  <InfoTip text="Pay the bill off in one go, or a part of it. Anything less than the outstanding balance leaves the bill open for the rest, and each part posts its own dated voucher." />
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    className="tabular-nums"
                    value={repayForm.amount ?? ''}
                    onChange={(e) => setRepayForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 px-2 text-xs"
                    onClick={() => setRepayForm((p) => ({ ...p, amount: String(dueOn(repayRow)) }))}
                  >
                    Full balance
                  </Button>
                </div>
                {round2(n(repayForm.amount)) > 0 && round2(n(repayForm.amount)) < dueOn(repayRow) && (
                  <div className="text-[11px] text-muted-foreground">
                    Part payment — {formatINR(round2(dueOn(repayRow) - round2(n(repayForm.amount))))} would still be outstanding,
                    and the bill stays open for it.
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Repay date</Label>
                <DatePicker value={String(repayForm.repay_date || '')} onChange={(v) => setRepayForm((p) => ({ ...p, repay_date: v }))} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Settle through
                  <InfoTip text="Through the bank posts the payment straight out of your own account. Against the party settles it on their ledger instead — bill-wise if you name a bill reference, or On Account if you leave it blank." />
                </Label>
                <Select value={String(repayForm.settle_via || 'bank')} onValueChange={(v) => setRepayForm((p) => ({ ...p, settle_via: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">Our bank</SelectItem>
                    <SelectItem value="party">Against {repayRow.party_name || 'the party'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
                <label className="flex w-fit cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2">
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
              {/* What has already gone back, so the schedule is visible where
                  the next instalment is being entered — and correctable there
                  too, since a wrong figure is only found later. */}
              {repayParts.length > 0 && (
                <div className="rounded-lg border border-[#e5dfc8]">
                  <div className="border-b border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#1a2c56]">
                    Already repaid · {repayParts.length} {repayParts.length === 1 ? 'part' : 'parts'}
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    {repayParts.map((part) => (
                      <div key={String(part.id)} className="flex items-center justify-between gap-2 border-b border-dashed border-[#e5dfc8] px-3 py-1.5 text-xs last:border-b-0">
                        <span className="tabular-nums text-muted-foreground">{formatDate(part.repay_date)}</span>
                        <span className="font-semibold tabular-nums">{formatINR(part.amount)}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {String(part.settle_via) === 'party' ? `vs ${part.ref || 'On Account'}` : 'Bank'}
                        </span>
                        <span className="ml-auto tabular-nums text-muted-foreground">bal {formatINR(part.balance_after)}</span>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayRow(null)} disabled={repaySaving}>Cancel</Button>
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void saveRepay()} disabled={repaySaving}>
              {repaySaving
                ? 'Saving…'
                : repayRow && round2(n(repayForm.amount)) > 0 && round2(n(repayForm.amount)) < dueOn(repayRow)
                  ? `Repay ${formatINR(round2(n(repayForm.amount)))}`
                  : 'Repay in full'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* NBFC master — the same EntityManager the Banks page uses. */}
      <Dialog open={nbfcOpen} onOpenChange={(o) => { setNbfcOpen(o); if (!o) void load() }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage NBFCs</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Each NBFC carries its own default interest, interest days and TDS — filled in automatically when you pick it
            on a bill, and still fully editable there. &quot;Provides&quot; decides which finance types offer it.
          </p>
          <EntityManager table="nbfcs" title="NBFC" fields={NBFC_FIELDS} columns={NBFC_COLUMNS} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
