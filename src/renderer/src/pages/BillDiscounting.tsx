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

// Open = still owed to the NBFC (sky), Repaid = wound up (emerald) — the same
// left-border-plus-tint coding the LC register uses for its stages.
const STATUS_TONE: Record<string, { row: string; hover: string }> = {
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
  const [kpis, setKpis] = useState<Row>({})
  const [nbfcs, setNbfcs] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])

  const [view, setView] = useState<'cards' | 'table'>('table')
  const [duePeriod, setDuePeriod] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'repaid'>('all')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  const [form, setForm] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)
  const [nbfcOpen, setNbfcOpen] = useState(false)
  const [repayRow, setRepayRow] = useState<Row | null>(null)
  const [repayForm, setRepayForm] = useState<Row>({})
  const [repaySaving, setRepaySaving] = useState(false)

  const load = useCallback(async () => {
    const [list, k, nb, sup, cust] = await Promise.all([
      window.api.billDiscounting.list(),
      window.api.billDiscounting.kpis(),
      window.api.data.list('nbfcs'),
      window.api.data.list('suppliers'),
      window.api.data.list('customers')
    ])
    setRows(list)
    setKpis(k)
    onNbfcsLoaded?.(nb)
    setNbfcs(nb)
    setSuppliers(sup.filter((x) => x.active))
    setCustomers(cust.filter((x) => x.active))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  const filtered = useMemo(() => {
    let list = rows
    if (nbfcFilter) list = list.filter((r) => String(r.nbfc_id ?? '') === String(nbfcFilter))
    if (statusFilter !== 'all') list = list.filter((r) => String(r.status) === statusFilter)
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
      payment_received_date: todayISO(),
      maturity_date: '',
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
      amount: r.amount ?? '',
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

  // Picking an NBFC pulls its default terms in — each still fully editable.
  function chooseNbfc(v: string): void {
    const nb = nbfcs.find((x) => String(x.id) === v)
    setForm((p) => {
      const next: Row = { ...p, nbfc_id: v }
      if (nb) {
        if (!n(p?.interest_pct)) next.interest_pct = nb.interest_pct ?? ''
        if (!n(p?.tds_pct)) next.tds_pct = nb.tds_pct ?? ''
        if (n(nb.days_year) > 0) next.days_year = nb.days_year
        // A default tenor fills the maturity date forward from the receipt date.
        if (!p?.maturity_date && n(nb.interest_days) > 0 && p?.payment_received_date) {
          const d = new Date(`${String(p.payment_received_date).slice(0, 10)}T00:00:00`)
          d.setDate(d.getDate() + n(nb.interest_days))
          next.maturity_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
      return next
    })
  }

  const preview = useMemo(() => (form ? bdCalc(form) : null), [form])

  async function save(): Promise<void> {
    if (!form) return
    setSaving(true)
    try {
      const payload: Row = {
        bd_no: form.bd_no || null,
        nbfc_id: form.nbfc_id ? Number(form.nbfc_id) : null,
        finance_type: form.finance_type,
        party_type: form.party_type,
        party_id: form.party_id ? Number(form.party_id) : null,
        purpose: form.purpose,
        amount: Number(form.amount) || 0,
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

  function openRepay(r: Row): void {
    setRepayRow(r)
    setRepayForm({ repay_date: todayISO(), settle_via: 'bank', ref: '', release_margin: n(r.marginAmount) > 0 })
  }

  async function saveRepay(): Promise<void> {
    if (!repayRow) return
    setRepaySaving(true)
    try {
      await window.api.billDiscounting.repay(Number(repayRow.id), {
        repay_date: repayForm.repay_date || undefined,
        settle_via: repayForm.settle_via === 'party' ? 'party' : 'bank',
        ref: repayForm.settle_via === 'party' && repayForm.ref ? String(repayForm.ref) : null,
        release_margin: !!repayForm.release_margin
      })
      toast.success('Bill repaid — posted to the books')
      setRepayRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRepaySaving(false)
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
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1.5 border-white/30 bg-white/10 px-2 text-xs text-white hover:bg-white/20 hover:text-white"
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
            { key: 'open', label: 'Open' },
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
              const tone = STATUS_TONE[String(r.status)] || STATUS_TONE.open
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
                          {repaid ? <Badge variant="success">Repaid {formatDate(r.repaid_date)}</Badge> : <Badge variant="default">Open</Badge>}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Landmark className="h-3 w-3 shrink-0" /> {r.nbfc_name || '—'}
                          <span className="text-[#e5dfc8]">·</span>
                          <Users className="h-3 w-3 shrink-0" /> {r.party_name || '—'}
                        </div>
                      </div>
                      <Badge variant="muted" className="capitalize">{r.purpose}</Badge>
                    </div>
                    <div className="rounded-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-4 py-3 text-center shadow-sm">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-white/60">Bill amount</div>
                      <div className="text-2xl font-bold tabular-nums text-white">{formatINR(r.amount)}</div>
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
                        <CalendarRange className="h-3 w-3 shrink-0" /> {formatDate(r.payment_received_date)} → {formatDate(r.maturity_date)}
                      </span>
                      {!repaid && <DueBadge date={r.maturity_date} />}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 border-t border-dashed border-[#e5dfc8] px-4 py-3">
                    {repaid ? (
                      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void reopen(r)}>
                        <RotateCcw className="h-3.5 w-3.5" /> Reopen
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
                    Bill amount
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
                    const tone = STATUS_TONE[String(r.status)] || STATUS_TONE.open
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
                            {formatDateShort(r.payment_received_date)}
                          </div>
                          <div>
                            <span className="mr-1 text-[10px] font-semibold uppercase text-muted-foreground" title="Maturity">
                              Mat
                            </span>
                            {formatDateShort(r.maturity_date)}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {repaid ? <span className="text-muted-foreground">—</span> : <DueBadge date={r.maturity_date} />}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{n(r.intDays)}</TableCell>
                        <TableCell className="whitespace-nowrap border-l border-[#1a2c56]/10 text-right font-medium tabular-nums">
                          {formatINR(r.amount)}
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
                    <Label>BD no</Label>
                    <Input value={form.bd_no ?? ''} placeholder="Your own reference" onChange={(e) => setForm((p) => ({ ...p, bd_no: e.target.value }))} />
                  </div>
                </div>
              </section>

              <section className="rounded border border-[#e5dfc8] bg-white p-4">
                <h3 className="mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  Bill &amp; terms
                </h3>
                <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
                  <div className="flex flex-col gap-1.5">
                    <Label>Bill amount (₹) *</Label>
                    <Input type="number" value={form.amount ?? ''} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Payment received date *</Label>
                    <DatePicker
                      value={String(form.payment_received_date || '')}
                      max={form.maturity_date || undefined}
                      onChange={(v) => setForm((p) => ({ ...p, payment_received_date: v }))}
                    />
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

              {preview && n(form.amount) > 0 && (
                <div className="grid grid-cols-2 gap-px rounded-lg border border-[#e5dfc8] bg-[#e5dfc8] p-px sm:grid-cols-4 md:grid-cols-7">
                  {([
                    { label: 'Int. days', value: String(preview.intDays), tone: 'text-[#1a2c56]' },
                    { label: 'Margin', value: formatINR(preview.marginAmount), tone: 'text-[#1a2c56]' },
                    { label: 'Open amount', value: formatINR(preview.openAmount), tone: 'text-[#1a2c56]' },
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
                {repayRow.nbfc_name} · {repayRow.party_name} · bill <b>{formatINR(repayRow.amount)}</b>
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
                  <span className="text-sm font-medium">Release the {formatINR(repayRow.marginAmount)} margin back</span>
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayRow(null)} disabled={repaySaving}>Cancel</Button>
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void saveRepay()} disabled={repaySaving}>
              {repaySaving ? 'Saving…' : 'Repay'}
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
