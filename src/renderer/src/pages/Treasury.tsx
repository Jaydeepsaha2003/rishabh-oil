import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Banknote,
  Building2,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  LayoutGrid,
  Landmark,
  List,
  Paperclip,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
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

export function Treasury(): React.JSX.Element {
  const [tab, setTab] = useState('lc')
  const [lcs, setLcs] = useState<Row[]>([])
  const [bills, setBills] = useState<Row[]>([])
  const [alerts, setAlerts] = useState<Row | null>(null)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [sales, setSales] = useState<Row[]>([])
  const [orders, setOrders] = useState<Row[]>([])
  const [issuances, setIssuances] = useState<Record<number, Row[]>>({})
  const [repayments, setRepayments] = useState<Record<number, Row[]>>({})
  const [openLc, setOpenLc] = useState<Set<number>>(new Set())
  const [lcView, setLcView] = useState<'cards' | 'table'>('cards')
  // T+1 / this week / fortnight / monthly / quarterly, by whichever is nearer:
  // an outstanding bill's due date, or (no outstanding bill) the LC's expiry.
  const [lcDuePeriod, setLcDuePeriod] = useState('all')
  const [facilities, setFacilities] = useState<Row[]>([])
  const [exposures, setExposures] = useState<Record<number, Row[]>>({})
  const [openFac, setOpenFac] = useState<Set<number>>(new Set())
  // Every LC bill and discounted bill in one due-date-sorted list, regardless
  // of urgency — the alerts above only surface what's already close.
  const [tracker, setTracker] = useState<Row[]>([])
  const [trackerShowSettled, setTrackerShowSettled] = useState(false)
  const [activeCompany, setActiveCompany] = useState(0)

  const load = useCallback(async () => {
    const [l, b, a, sup, cust, sl, od, fac, tr, act] = await Promise.all([
      window.api.lc.list(),
      window.api.billDiscounts.list(),
      window.api.treasury.alerts(),
      window.api.data.list('suppliers'),
      window.api.data.list('customers'),
      window.api.sales.list(),
      window.api.orders.list(),
      window.api.facility.list(),
      window.api.treasury.paymentTracker(),
      window.api.company.getActive()
    ])
    setLcs(l.filter((x) => String(x.facility_type || 'lc') === 'lc'))
    setBills(b.filter((x) => String(x.medium || '') === 'bill_discounting' || x.rate_pct != null))
    setAlerts(a)
    setSuppliers(sup.filter((x) => x.active))
    setCustomers(cust.filter((x) => x.active))
    setSales(sl)
    setOrders(od)
    setFacilities(fac)
    setTracker(tr)
    setActiveCompany(Number(act?.id) || 0)
  }, [])

  async function toggleFacility(id: number): Promise<void> {
    setOpenFac((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    const rows = await window.api.facility.exposures(id)
    setExposures((p) => ({ ...p, [id]: rows }))
  }
  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  async function toggleLc(id: number): Promise<void> {
    setOpenLc((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!issuances[id]) setIssuances((p) => ({ ...p })) // placeholder until fetch lands
    const [rows, reps] = await Promise.all([window.api.lc.issuances(id), window.api.lc.repayments(id)])
    setIssuances((p) => ({ ...p, [id]: rows }))
    setRepayments((p) => ({ ...p, [id]: reps }))
  }

  async function reloadLcDetail(id: number): Promise<void> {
    const [rows, reps] = await Promise.all([window.api.lc.issuances(id), window.api.lc.repayments(id)])
    setIssuances((p) => ({ ...p, [id]: rows }))
    setRepayments((p) => ({ ...p, [id]: reps }))
  }

  // ---------------- LC create / issue ----------------
  const [lcForm, setLcForm] = useState<Row | null>(null)
  const [issueForm, setIssueForm] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)

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
            interest_pct: l.interest_pct || '',
            charges: l.charges || ''
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
        ...stageForm
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

  // Live preview for the Payment Received step — same interest/charges math
  // lc.ts uses server-side to derive lc_net_available, so what's shown here
  // matches what actually gets stored.
  const stagePreview = useMemo(() => {
    if (!stageRow || nextLcStage(String(stageRow.stage || 'application')) !== 'payment_received') return null
    const amount = n(stageRow.amount)
    const from = daysTo(stageForm.payment_received_date)
    const to = daysTo(stageForm.expiry_date)
    const days = from != null && to != null ? to - from : null
    const interestPct = n(stageForm.interest_pct)
    const charges = n(stageForm.charges)
    const interest = days != null ? round2((amount * interestPct * days) / (100 * 365)) : 0
    const netAvailable = round2(amount - interest - charges)
    return { amount, days, interest, charges, netAvailable }
  }, [stageRow, stageForm.payment_received_date, stageForm.expiry_date, stageForm.interest_pct, stageForm.charges])

  // ---------------- Facilities and exposures ----------------
  const [facForm, setFacForm] = useState<Row | null>(null)
  const [expForm, setExpForm] = useState<Row | null>(null)

  async function saveFacility(): Promise<void> {
    if (!facForm) return
    setBusy(true)
    try {
      if (facForm.id) await window.api.facility.update(Number(facForm.id), facForm)
      else await window.api.facility.create(facForm)
      toast.success(`Facility ${facForm.name} saved`)
      setFacForm(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeFacility(f: Row): Promise<void> {
    if (!window.confirm(`Delete the facility "${f.name}"? This cannot be undone.`)) return
    try {
      await window.api.facility.remove(Number(f.id))
      toast.success('Facility deleted')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function saveExposure(): Promise<void> {
    if (!expForm) return
    setBusy(true)
    try {
      await window.api.facility.saveExposure(expForm)
      toast.success('Balance saved')
      const fid = Number(expForm.facility_id)
      setExpForm(null)
      setExposures((p) => ({ ...p, [fid]: [] }))
      const rows = await window.api.facility.exposures(fid)
      setExposures((p) => ({ ...p, [fid]: rows }))
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeExposure(e: Row): Promise<void> {
    if (!window.confirm(`Remove "${e.label}" from this facility's outstanding?`)) return
    try {
      await window.api.facility.removeExposure(Number(e.id))
      const fid = Number(e.facility_id)
      const rows = await window.api.facility.exposures(fid)
      setExposures((p) => ({ ...p, [fid]: rows }))
      load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }


  async function saveLc(): Promise<void> {
    if (!lcForm) return
    if (!String(lcForm.fd_no || '').trim()) return void toast.error('FD No is required')
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
  // into a different company's books.
  const lcFormOrders = useMemo(() => {
    if (!lcForm) return []
    return orders.filter(
      (o) =>
        (!lcForm.party_id || Number(o.supplier_id) === Number(lcForm.party_id)) &&
        Number(o.company_id) === Number(activeCompany)
    )
  }, [lcForm, orders, activeCompany])

  // Banks already on record — from LCs and sanctioned facilities — so the
  // field can offer a pick-list while still taking a bank that isn't in it yet.
  const bankOptions = useMemo(() => {
    const set = new Set<string>()
    for (const l of lcs) if (l.bank) set.add(String(l.bank).trim())
    for (const f of facilities) if (f.bank) set.add(String(f.bank).trim())
    return Array.from(set).sort()
  }, [lcs, facilities])
  const NEW_BANK = '__new_bank__'
  const [addingNewBank, setAddingNewBank] = useState(false)
  const lcFormOpen = !!lcForm
  useEffect(() => {
    if (lcFormOpen) setAddingNewBank(false)
  }, [lcFormOpen])

  const issueOrders = useMemo(() => {
    if (!issueForm) return []
    const lc = lcs.find((x) => Number(x.id) === Number(issueForm.lc_id))
    return orders.filter((o) => !lc?.party_id || Number(o.supplier_id) === Number(lc.party_id))
  }, [issueForm, orders, lcs])

  async function saveIssue(): Promise<void> {
    if (!issueForm) return
    setBusy(true)
    try {
      await window.api.lc.issue({
        lc_id: Number(issueForm.lc_id),
        issue_date: issueForm.issue_date || todayISO(),
        due_date: issueForm.due_date || undefined,
        amount: Number(issueForm.amount),
        order_id: issueForm.order_id ? Number(issueForm.order_id) : null,
        bill_no: issueForm.bill_no || null,
        note: issueForm.note || null
      })
      toast.success('Bill issued under the LC')
      const lcId = Number(issueForm.lc_id)
      setIssueForm(null)
      setIssuances((p) => ({ ...p, [lcId]: [] }))
      await toggleLc(lcId)
      setOpenLc((p) => new Set(p).add(lcId))
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ---------------- LC repayment ----------------
  const [repayForm, setRepayForm] = useState<Row | null>(null)

  async function pickRepaymentDocument(): Promise<void> {
    if (!repayForm) return
    const r = await window.api.files.pickDocument()
    if (r.path) setRepayForm({ ...repayForm, document_path: r.path })
  }

  async function saveRepayment(): Promise<void> {
    if (!repayForm) return
    setBusy(true)
    try {
      await window.api.lc.saveRepayment({
        ...repayForm,
        lc_id: Number(repayForm.lc_id),
        party_id: repayForm.party_id ? Number(repayForm.party_id) : null,
        amount: Number(repayForm.amount),
        maturity_charges: Number(repayForm.maturity_charges) || 0,
        posted: !!repayForm.posted
      })
      toast.success(repayForm.posted ? 'Repayment posted to the books' : 'Repayment logged')
      const lcId = Number(repayForm.lc_id)
      setRepayForm(null)
      await reloadLcDetail(lcId)
      setOpenLc((p) => new Set(p).add(lcId))
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
    if (lcDuePeriod === 'all') return lcsWithDue
    const maxDays = DUE_PERIODS.find((p) => p.key === lcDuePeriod)?.maxDays
    if (maxDays == null) return lcsWithDue
    // Cumulative: overdue and everything due sooner counts too, not just the
    // slice of days that falls exactly in this bucket.
    return lcsWithDue.filter((l) => l.days_left_effective != null && l.days_left_effective <= maxDays)
  }, [lcsWithDue, lcDuePeriod])

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
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 px-2 text-[11px] normal-case tracking-normal"
              onClick={() => setRepayForm({ lc_id: l.id, party_id: l.receivable_party_id ? String(l.receivable_party_id) : '', repay_date: todayISO(), posted: false })}
            >
              <Plus className="h-3 w-3" /> Log repayment
            </Button>
          </div>
          {reps.length === 0 ? (
            <p className="text-xs text-muted-foreground">No repayments logged against this LC yet.</p>
          ) : (
            <table className="w-full rounded-lg border bg-card text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5">
              <thead className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th>Date</th><th className="text-right">Repayment</th><th className="text-right">Maturity chgs</th><th className="text-right">Total debited</th><th>Posted</th><th>Document</th><th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reps.map((r) => (
                  <tr key={String(r.id)} className="border-b last:border-0">
                    <td className="tabular-nums">{formatDate(r.repay_date)}</td>
                    <td className="text-right font-medium tabular-nums">{formatINR(r.amount)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">{n(r.maturity_charges) > 0 ? formatINR(r.maturity_charges) : '—'}</td>
                    <td className="text-right font-medium tabular-nums">{formatINR(n(r.amount) + n(r.maturity_charges))}</td>
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
                        <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit" onClick={() => setRepayForm({ ...r })}>
                          <CalendarClock className="h-3 w-3" />
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
        subtitle="Letters of credit and bill discounting — tracked to the day, posted to the books"
        hint="LCs carry interest days: every bill issued under one gets a maturity date, and settling it pays the supplier through the books against the original invoice. Discounting a sale bill brings the bank money in now (interest and charges to expenses) and clears the customer when the bill is realized. Everything shows in the Day Book, ledgers and Trial Balance."
      />
      <div className="space-y-4 px-4 py-4">
        {alertItems.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-3">
            {alertItems.map((a) => (
              <Card key={a.label} className={cn('border p-3', a.tone)}>
                <div className="mb-1 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide">
                  <a.icon className="h-4 w-4" /> {a.label}
                </div>
                {a.items.map((x) => (
                  <div key={x} className="truncate text-[12px]" title={x}>{x}</div>
                ))}
              </Card>
            ))}
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="lc">Letters of Credit ({lcs.length})</TabsTrigger>
            <TabsTrigger value="bd">Bill Discounting ({bills.length})</TabsTrigger>
            <TabsTrigger value="limits">Sanctioned Limits ({facilities.length})</TabsTrigger>
            <TabsTrigger value="tracker">Payment Tracker ({tracker.filter((x) => !x.settled).length})</TabsTrigger>
          </TabsList>

          <TabsContent value="tracker" className="mt-4">
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex flex-wrap items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
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
                    const isOpen = openLc.has(Number(l.id))
                    const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                    return (
                      <Card key={String(l.id)} className="flex flex-col gap-2 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className={cn('font-semibold', !l.lc_no && 'italic text-muted-foreground')}>{l.lc_no || 'Pending LC no'}</span>
                              <StageBadge stage={String(l.stage || 'application')} />
                            </div>
                            <div className="text-[11px] text-muted-foreground">{l.bank} · {l.supplier_name || '—'}</div>
                            {l.fd_no && <div className="text-[10px] text-muted-foreground">FD {l.fd_no}</div>}
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
                        <div className="rounded-md bg-[#f1ecd9] px-3 py-2 text-center">
                          <div className="text-[10px] uppercase tracking-widest text-[#1a2c56]/70">LC amount</div>
                          <div className="text-xl font-bold tabular-nums text-[#1a2c56]">{formatINR(l.amount)}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div><div className="text-muted-foreground">Utilised</div><div className="font-medium tabular-nums">{formatINR(l.utilized)}</div></div>
                          <div><div className="text-muted-foreground">Available</div><div className={cn('font-medium tabular-nums', n(l.available) <= 0 ? 'text-rose-600' : 'text-emerald-700')}>{formatINR(l.available)}</div></div>
                          <div><div className="text-muted-foreground">Repaid</div><div className="font-medium tabular-nums">{formatINR(l.repaid)}</div></div>
                          <div><div className="text-muted-foreground">Outstanding</div><div className="font-medium tabular-nums">{formatINR(l.outstanding)}</div></div>
                        </div>
                        <div className="h-2 rounded-full bg-muted">
                          <div className={cn('h-2 rounded-full', pct >= 95 ? 'bg-rose-500' : 'bg-sky-600')} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{formatDate(l.open_date)} → {formatDate(l.expiry_date)}</span>
                          <DueBadge date={l.due_date_effective} />
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(() => {
                            const next = nextLcStage(String(l.stage || 'application'))
                            if (!next) return null
                            return (
                              <Button size="sm" className="h-7 bg-[#1a2c56] px-2 text-xs hover:bg-[#24407e]" onClick={() => openStageAdvance(l)}>
                                Mark {STAGE_LABEL[next]}
                              </Button>
                            )
                          })()}
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setIssueForm({ lc_id: l.id, issue_date: todayISO() })}>Issue bill</Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void toggleLc(Number(l.id))}>
                            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Details
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit LC" onClick={() => setLcForm({ ...l })}>
                            <CalendarClock className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete LC (reverses its vouchers)" onClick={async () => { if (confirm(`Delete LC ${l.lc_no}?`)) { await window.api.lc.remove(Number(l.id)); load() } }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {isOpen && <div className="-mx-4 -mb-4 mt-1 border-t bg-[#f7f2e2]">{lcExpanded(l)}</div>}
                      </Card>
                    )
                  })
                )}
              </div>
            ) : (
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="text-[13px] font-bold uppercase tracking-widest">Letters of Credit</span>
                <Button size="sm" className="ml-auto bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setLcForm({ open_date: todayISO(), usance_days: '', margin_pct: '', interest_pct: '', charges: '', purpose: 'manufacturing', workflow_status: 'in_progress', stage: 'application' })}>
                  <Plus className="h-4 w-4" /> Open new LC
                </Button>
              </div>
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="bg-[#f1ecd9] hover:bg-[#f1ecd9]">
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">LC no · bank</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Supplier</TableHead>
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Validity</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Limit</TableHead>
                    <TableHead className="h-8 w-44 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Utilisation</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Available</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lcsFiltered.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No letters of credit in this bucket.</TableCell></TableRow>
                  ) : (
                    lcsFiltered.map((l) => {
                      const isOpen = openLc.has(Number(l.id))
                      const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                      return (
                        <Fragment key={String(l.id)}>
                          <TableRow className="cursor-pointer border-b border-dotted border-[#e5dfc8] transition-colors hover:bg-amber-100/70" onClick={() => void toggleLc(Number(l.id))}>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span className={cn('font-semibold', !l.lc_no && 'italic text-muted-foreground')}>{l.lc_no || 'Pending LC no'}</span>
                                    <StageBadge stage={String(l.stage || 'application')} />
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">{l.bank} · {n(l.usance_days)} interest days{n(l.margin_pct) ? ` · margin ${l.margin_pct}%` : ''}</div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>{l.supplier_name || '—'}</TableCell>
                            <TableCell>
                              <div className="text-[12px] tabular-nums">{formatDate(l.open_date)} → {formatDate(l.expiry_date)}</div>
                              <DueBadge date={l.expiry_date} />
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">{formatINR(l.amount)}</TableCell>
                            <TableCell>
                              <div className="h-2 rounded-full bg-muted">
                                <div className={cn('h-2 rounded-full', pct >= 95 ? 'bg-rose-500' : 'bg-sky-600')} style={{ width: `${pct}%` }} />
                              </div>
                              <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{formatINR(l.utilized)} used · {pct.toFixed(0)}%</div>
                            </TableCell>
                            <TableCell className={cn('text-right font-semibold tabular-nums', n(l.available) <= 0 ? 'text-rose-600' : 'text-emerald-700')}>
                              {formatINR(l.available)}
                            </TableCell>
                            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
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
                                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setIssueForm({ lc_id: l.id, issue_date: todayISO() })}>
                                  Issue bill
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit LC" onClick={() => setLcForm({ ...l })}>
                                  <CalendarClock className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete LC (reverses its vouchers)" onClick={async () => { if (confirm(`Delete LC ${l.lc_no}?`)) { await window.api.lc.remove(Number(l.id)); load() } }}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {isOpen && (
                            <TableRow className="bg-[#f7f2e2] hover:bg-[#f7f2e2]">
                              <TableCell colSpan={7} className="p-0">{lcExpanded(l)}</TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            )}
          </TabsContent>

          <TabsContent value="bd" className="mt-4">
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
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

          {/* Sanctioned limits: what the bank allows, what is already committed
              against it, and what is genuinely left. Each facility opens to
              show the named balances that make up its outstanding, so the
              available figure is never an unexplained number. */}
          <TabsContent value="limits" className="mt-4 space-y-4">
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="text-[13px] font-bold uppercase tracking-widest">Sanctioned limits</span>
                <Button size="sm" className="ml-auto bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setFacForm({ facility_type: 'lc', active: 1 })}>
                  <Plus className="h-4 w-4" /> New facility
                </Button>
              </div>
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow className="bg-[#f1ecd9] hover:bg-[#f1ecd9]">
                    <TableHead className="h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Facility · bank</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Sanctioned</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">On LCs</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Other o/s</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Available</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Planned</TableHead>
                    <TableHead className="h-8 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {facilities.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                        No sanctioned facilities yet. Add one to track available limit across LCs and other outstanding.
                      </TableCell>
                    </TableRow>
                  ) : (
                    facilities.map((f) => {
                      const isOpen = openFac.has(Number(f.id))
                      const lines = exposures[Number(f.id)] || []
                      const pct = n(f.sanctioned_limit) > 0 ? Math.min(100, (n(f.total_outstanding) / n(f.sanctioned_limit)) * 100) : 0
                      return (
                        <Fragment key={String(f.id)}>
                          <TableRow
                            className={cn(
                              'cursor-pointer border-b border-dotted border-[#e5dfc8] transition-colors hover:bg-amber-100/70',
                              Number(f.active) === 0 && 'opacity-55'
                            )}
                            onClick={() => void toggleFacility(Number(f.id))}
                          >
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                <div>
                                  <div className="font-semibold">
                                    {f.name}
                                    {Number(f.active) === 0 && <span className="ml-1.5 text-[10px] font-normal uppercase text-muted-foreground">off</span>}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {f.bank}
                                    {f.review_date ? ` · review ${formatDate(f.review_date)}` : ''}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">{formatINR(f.sanctioned_limit)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{formatINR(f.lc_committed)}</TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{formatINR(f.other_outstanding)}</TableCell>
                            <TableCell className={cn('text-right font-semibold tabular-nums', n(f.available) < 0 ? 'text-rose-600' : 'text-emerald-700')}>
                              {formatINR(f.available)}
                              <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted">
                                <div className={cn('h-1.5 rounded-full', pct >= 95 ? 'bg-rose-500' : 'bg-sky-600')} style={{ width: `${pct}%` }} />
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {n(f.planned) ? (
                                <>
                                  {formatINR(f.planned)}
                                  <div className={cn('text-[10px]', n(f.available_after_planned) < 0 ? 'text-rose-600' : 'text-muted-foreground')}>
                                    {formatINR(f.available_after_planned)} after
                                  </div>
                                </>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setExpForm({ facility_id: f.id, kind: 'outstanding', as_of: todayISO() })}
                                >
                                  Add balance
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit facility" onClick={() => setFacForm({ ...f })}>
                                  <CalendarClock className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete facility" onClick={() => void removeFacility(f)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {isOpen && (
                            <TableRow className="bg-muted/20 hover:bg-muted/20">
                              <TableCell colSpan={7} className="p-0">
                                <div className="px-8 py-3">
                                  <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                                    What makes up this facility&apos;s outstanding
                                  </div>
                                  <table className="w-full text-xs">
                                    <tbody>
                                      {lcs.filter((l) => String(l.facility_id) === String(f.id)).map((l) => (
                                        <tr key={`lc${l.id}`} className="border-b border-dotted last:border-0">
                                          <td className="py-1.5 pr-3">
                                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">LC</span>{' '}
                                            {l.lc_no} · {l.supplier_name || '—'}
                                          </td>
                                          <td className="py-1.5 pr-3 text-muted-foreground">{formatDate(l.open_date)} → {formatDate(l.expiry_date)}</td>
                                          <td className="py-1.5 text-right tabular-nums">{formatINR(l.amount)}</td>
                                          <td className="w-16 py-1.5" />
                                        </tr>
                                      ))}
                                      {lines.map((x) => (
                                        <tr key={`ex${x.id}`} className="border-b border-dotted last:border-0">
                                          <td className="py-1.5 pr-3">
                                            <span
                                              className={cn(
                                                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                                                String(x.kind) === 'planned' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                                              )}
                                            >
                                              {String(x.kind) === 'planned' ? 'Planned' : 'O/s'}
                                            </span>{' '}
                                            {x.label}
                                          </td>
                                          <td className="py-1.5 pr-3 text-muted-foreground">{x.as_of ? formatDate(x.as_of) : ''}{x.note ? ` · ${x.note}` : ''}</td>
                                          <td className="py-1.5 text-right tabular-nums">{formatINR(x.amount)}</td>
                                          <td className="w-16 py-1.5 text-right">
                                            <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit" onClick={() => setExpForm({ ...x })}>
                                              <CalendarClock className="h-3 w-3" />
                                            </Button>
                                            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" title="Remove" onClick={() => void removeExposure(x)}>
                                              <Trash2 className="h-3 w-3" />
                                            </Button>
                                          </td>
                                        </tr>
                                      ))}
                                      {lines.length === 0 && lcs.filter((l) => String(l.facility_id) === String(f.id)).length === 0 && (
                                        <tr><td className="py-2 text-muted-foreground">Nothing committed against this facility yet.</td></tr>
                                      )}
                                      <tr className="border-t font-semibold">
                                        <td className="py-1.5" colSpan={2}>Total outstanding</td>
                                        <td className="py-1.5 text-right tabular-nums">{formatINR(f.total_outstanding)}</td>
                                        <td />
                                      </tr>
                                      <tr className="font-semibold">
                                        <td className="py-1.5" colSpan={2}>Available</td>
                                        <td className={cn('py-1.5 text-right tabular-nums', n(f.available) < 0 ? 'text-rose-600' : 'text-emerald-700')}>
                                          {formatINR(f.available)}
                                        </td>
                                        <td />
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>

          </TabsContent>
        </Tabs>
      </div>

      {/* New / edit facility */}
      <Dialog open={!!facForm} onOpenChange={(o) => !o && setFacForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{facForm?.id ? `Alter ${facForm.name}` : 'New sanctioned facility'}</DialogTitle></DialogHeader>
          {facForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label>Facility name *</Label><Input value={facForm.name ?? ''} onChange={(e) => setFacForm({ ...facForm, name: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Bank *</Label><Input value={facForm.bank ?? ''} onChange={(e) => setFacForm({ ...facForm, bank: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Sanctioned limit (₹) *</Label><Input type="number" value={facForm.sanctioned_limit ?? ''} onChange={(e) => setFacForm({ ...facForm, sanctioned_limit: e.target.value })} /></div>
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={String(facForm.facility_type || 'lc')} onValueChange={(v) => setFacForm({ ...facForm, facility_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lc">Letter of credit</SelectItem>
                    <SelectItem value="cc">Cash credit</SelectItem>
                    <SelectItem value="od">Overdraft</SelectItem>
                    <SelectItem value="bd">Bill discounting</SelectItem>
                    <SelectItem value="composite">Composite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5"><Label>Sanction date</Label><DatePicker value={String(facForm.sanction_date || '')} onChange={(v) => setFacForm({ ...facForm, sanction_date: v })} /></div>
              <div className="grid gap-1.5"><Label>Review / renewal date</Label><DatePicker value={String(facForm.review_date || '')} onChange={(v) => setFacForm({ ...facForm, review_date: v })} /></div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={facForm.note ?? ''} onChange={(e) => setFacForm({ ...facForm, note: e.target.value })} /></div>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={Number(facForm.active ?? 1) !== 0}
                  onChange={(e) => setFacForm({ ...facForm, active: e.target.checked ? 1 : 0 })}
                />
                Active — offered when opening an LC
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFacForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveFacility()}>{busy ? 'Saving…' : 'Save facility'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / edit an outstanding or planned balance under a facility */}
      <Dialog open={!!expForm} onOpenChange={(o) => !o && setExpForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{expForm?.id ? 'Alter balance' : 'Add a balance to this facility'}</DialogTitle></DialogHeader>
          {expForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>What is this balance? *</Label>
                <Input
                  placeholder="e.g. Legacy accounts (KREL/KRFL), DIL EXIM"
                  value={expForm.label ?? ''}
                  onChange={(e) => setExpForm({ ...expForm, label: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5"><Label>Amount (₹) *</Label><Input type="number" value={expForm.amount ?? ''} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} /></div>
              <div className="grid gap-1.5">
                <Label>Counts as</Label>
                <Select value={String(expForm.kind || 'outstanding')} onValueChange={(v) => setExpForm({ ...expForm, kind: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outstanding">Outstanding — reduces available now</SelectItem>
                    <SelectItem value="planned">Planned — shown separately, not yet drawn</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5"><Label>As of</Label><DatePicker value={String(expForm.as_of || '')} onChange={(v) => setExpForm({ ...expForm, as_of: v })} /></div>
              <div className="grid gap-1.5"><Label>Note</Label><Input value={expForm.note ?? ''} onChange={(e) => setExpForm({ ...expForm, note: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExpForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveExposure()}>{busy ? 'Saving…' : 'Save balance'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Guided stage advance — asks only for that stage's own date(s) */}
      <Dialog open={!!stageRow} onOpenChange={(o) => !o && setStageRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Mark {stageRow?.lc_no || 'this application'} {STAGE_LABEL[nextLcStage(String(stageRow?.stage || 'application')) || '']}
            </DialogTitle>
          </DialogHeader>
          {stageRow && (() => {
            const next = nextLcStage(String(stageRow.stage || 'application'))
            return (
              <div className="grid gap-3">
                {next === 'open' && (
                  <>
                    <div className="grid gap-1.5">
                      <Label>LC no *</Label>
                      <Input value={stageForm.lc_no ?? ''} onChange={(e) => setStageForm({ ...stageForm, lc_no: e.target.value })} />
                      <span className="text-[10px] text-muted-foreground">Issued by the bank now that the LC is actually open.</span>
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Open date *</Label>
                      <DatePicker value={String(stageForm.opened_date || '')} onChange={(v) => setStageForm({ ...stageForm, opened_date: v })} />
                    </div>
                  </>
                )}
                {next === 'payment_received' && (
                  <>
                    <div className="grid gap-1.5">
                      <Label>Payment received date *</Label>
                      <DatePicker value={String(stageForm.payment_received_date || '')} onChange={(v) => setStageForm({ ...stageForm, payment_received_date: v })} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Maturity date *</Label>
                      <DatePicker value={String(stageForm.expiry_date || '')} onChange={(v) => setStageForm({ ...stageForm, expiry_date: v })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label>Interest % p.a. (ROI)</Label>
                        <Input type="number" value={stageForm.interest_pct ?? ''} onChange={(e) => setStageForm({ ...stageForm, interest_pct: e.target.value })} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>LC charges (₹)</Label>
                        <Input type="number" value={stageForm.charges ?? ''} onChange={(e) => setStageForm({ ...stageForm, charges: e.target.value })} />
                      </div>
                    </div>
                    {stagePreview && (
                      <div className="rounded-md border border-[#d9d2b8] bg-[#f7f2e2] p-3 text-[12px]">
                        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">Back-calculated from the open amount</div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="text-muted-foreground">Open amount</span>
                          <span className="tabular-nums">{formatINR(stagePreview.amount)}</span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="text-muted-foreground">Interest days (maturity − payment received)</span>
                          <span className="tabular-nums">{stagePreview.days ?? '—'}</span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="text-muted-foreground">Interest</span>
                          <span className="tabular-nums">− {formatINR(stagePreview.interest)}</span>
                        </div>
                        <div className="flex items-center justify-between py-0.5">
                          <span className="text-muted-foreground">LC charges</span>
                          <span className="tabular-nums">− {formatINR(stagePreview.charges)}</span>
                        </div>
                        <div className="my-1.5 border-t-2 border-[#1a2c56]" />
                        <div className="flex items-center justify-between py-0.5 font-semibold text-[#1a2c56]">
                          <span>Net available</span>
                          <span className="tabular-nums">{formatINR(stagePreview.netAvailable)}</span>
                        </div>
                      </div>
                    )}
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                      Marking this Payment Received also issues (if not already) and settles this LC's bill(s) through the books.
                    </div>
                  </>
                )}
                {stageError && <p className="text-sm text-destructive">{stageError}</p>}
              </div>
            )
          })()}
          <DialogFooter>
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
          </div>
          {lcForm && (
            <div className="grid gap-4 p-6 lg:grid-cols-2">
              <section className="rounded-xl border border-[#e5dfc8] bg-white p-4 shadow-sm">
                <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1a2c56]/10"><Landmark className="h-3 w-3 text-[#1a2c56]" /></span>
                  LC & stage
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>LC no {String(lcForm.stage || 'application') !== 'application' && '*'}</Label>
                    <Input value={lcForm.lc_no ?? ''} onChange={(e) => setLcForm({ ...lcForm, lc_no: e.target.value })} placeholder={String(lcForm.stage || 'application') === 'application' ? 'Obtained once the LC is Open' : ''} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Bank / discounting bank *</Label>
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
                            if (v === NEW_BANK) { setAddingNewBank(true); setLcForm({ ...lcForm, bank: '' }) }
                            else setLcForm({ ...lcForm, bank: v })
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
                  <div className="grid gap-1.5">
                    <Label>FD No *</Label>
                    <Input value={lcForm.fd_no ?? ''} onChange={(e) => setLcForm({ ...lcForm, fd_no: e.target.value })} placeholder="e.g. FD/2026/045" />
                    <span className="text-[10px] text-muted-foreground">Fixed deposit lodged as security</span>
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
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
                  <div className="grid gap-1.5">
                    <Label>Supplier (beneficiary)</Label>
                    <Select value={lcForm.party_id ? String(lcForm.party_id) : ''} onValueChange={(v) => setLcForm({ ...lcForm, party_id: v })}>
                      <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {suppliers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Purpose</Label>
                    <Select value={String(lcForm.purpose || '')} onValueChange={(v) => setLcForm({ ...lcForm, purpose: v })}>
                      <SelectTrigger><SelectValue placeholder="Select purpose" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="trading">Trading</SelectItem>
                        <SelectItem value="manufacturing">Manufacturing</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {!!lcForm.party_id && (
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
                                  const total = orders
                                    .filter((x) => next.map(String).includes(String(x.id)))
                                    .reduce((s, x) => s + n(x.net_amount), 0)
                                  // Suggest the total, but never overwrite an amount
                                  // the user has already set below it by hand — only
                                  // pull it down if the shrinking selection would
                                  // otherwise put it over the new ceiling.
                                  setLcForm({ ...lcForm, linked_order_ids: next, amount: !n(lcForm.amount) || total < n(lcForm.amount) ? String(total) : lcForm.amount })
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
                      const total = orders
                        .filter((o) => ids.map(String).includes(String(o.id)))
                        .reduce((s, o) => s + n(o.net_amount), 0)
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
                {String(lcForm.purpose) === 'trading' && (
                  <div className="mt-3 grid gap-3 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
                    <div className="grid gap-1.5">
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
                    return (
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label>Open amount (₹) *</Label>
                        <Input
                          type="number"
                          value={lcForm.amount ?? ''}
                          onChange={(e) => setLcForm({ ...lcForm, amount: e.target.value })}
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
                        <div className="grid gap-1.5">
                          <Label>Application date</Label>
                          <DatePicker value={String(lcForm.open_date || '')} onChange={(v) => setLcForm({ ...lcForm, open_date: v })} />
                        </div>
                        <div className="grid gap-1.5">
                          <Label>Open date</Label>
                          <DatePicker
                            value={String(lcForm.opened_date || '')}
                            onChange={(v) => setLcForm({ ...lcForm, opened_date: v })}
                            disabled={stage === 'application'}
                          />
                          {stage === 'application' && <span className="text-[10px] text-muted-foreground">Set once the stage moves to Open</span>}
                        </div>
                        <div className="grid gap-1.5">
                          <Label>Payment received date</Label>
                          <DatePicker
                            value={String(lcForm.payment_received_date || '')}
                            onChange={(v) => {
                              const usanceDays = v && lcForm.expiry_date ? daysTo(lcForm.expiry_date)! - daysTo(v)! : lcForm.usance_days
                              setLcForm({ ...lcForm, payment_received_date: v, usance_days: usanceDays })
                            }}
                            disabled={stage !== 'payment_received'}
                          />
                          {stage !== 'payment_received' && <span className="text-[10px] text-muted-foreground">Set once payment is received</span>}
                        </div>
                        <div className="grid gap-1.5">
                          <Label>Maturity date</Label>
                          <DatePicker
                            value={String(lcForm.expiry_date || '')}
                            onChange={(v) => {
                              const usanceDays = v && lcForm.payment_received_date ? daysTo(v)! - daysTo(lcForm.payment_received_date)! : lcForm.usance_days
                              setLcForm({ ...lcForm, expiry_date: v, usance_days: usanceDays })
                            }}
                            disabled={stage !== 'payment_received'}
                          />
                          {stage !== 'payment_received' && <span className="text-[10px] text-muted-foreground">Set together with payment received</span>}
                        </div>
                        <div className="grid gap-1.5 sm:col-span-2">
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
                  <div className="grid gap-1.5"><Label>Margin %</Label><Input type="number" value={lcForm.margin_pct ?? ''} onChange={(e) => setLcForm({ ...lcForm, margin_pct: e.target.value })} /></div>
                  <div className="grid gap-1.5">
                    <Label>Interest % p.a. (ROI) {String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.interest_pct ?? ''} onChange={(e) => setLcForm({ ...lcForm, interest_pct: e.target.value })} disabled={String(lcForm.stage) !== 'payment_received'} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>LC charges (₹) {String(lcForm.stage) !== 'payment_received' && <span className="text-[10px] font-normal text-muted-foreground">(set with payment received)</span>}</Label>
                    <Input type="number" value={lcForm.charges ?? ''} onChange={(e) => setLcForm({ ...lcForm, charges: e.target.value })} disabled={String(lcForm.stage) !== 'payment_received'} />
                  </div>
                </div>
                <span className="mt-1 block text-[10px] text-muted-foreground">ROI and LC charges are obtained once payment is received; interest is charged over the interest days (maturity date − payment received date).</span>
              </section>

              {n(lcForm.amount) > 0 && (n(lcForm.margin_pct) > 0 || n(lcForm.interest_pct) > 0 || n(lcForm.charges) > 0) && (() => {
                const linkedIds: number[] = Array.isArray(lcForm.linked_order_ids) ? lcForm.linked_order_ids : []
                const linkedTotal = orders
                  .filter((o) => linkedIds.map(String).includes(String(o.id)))
                  .reduce((s, o) => s + n(o.net_amount), 0)
                const invoiceAmount = linkedTotal > 0 ? linkedTotal : n(lcForm.amount)
                const openAmount = n(lcForm.amount)
                const margin = round2((invoiceAmount * n(lcForm.margin_pct)) / 100)
                const interest = round2((openAmount * n(lcForm.interest_pct) * n(lcForm.usance_days)) / (100 * 365))
                const charges = round2(n(lcForm.charges))
                // Back-calculation: the open amount is the limit as struck with
                // the bank — interest and charges come OUT of it, not on top.
                const netAvailable = round2(openAmount - interest - charges)
                return (
                  <div className="rounded-xl border border-sky-200 bg-gradient-to-br from-sky-50 to-indigo-50 p-4 shadow-sm lg:col-span-2">
                    <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-sky-900">
                      <Banknote className="h-3.5 w-3.5" /> Back-calculated from the open amount
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                      <div><div className="text-[10px] uppercase tracking-wide text-sky-700">Open amount</div><div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(openAmount)}</div></div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-sky-700">− Interest ({n(lcForm.usance_days) || 0} interest days)</div>
                        <div className="text-[15px] font-semibold tabular-nums text-rose-700">{formatINR(interest)}</div>
                      </div>
                      <div><div className="text-[10px] uppercase tracking-wide text-sky-700">− Charges</div><div className="text-[15px] font-semibold tabular-nums text-rose-700">{formatINR(charges)}</div></div>
                      <div><div className="text-[10px] uppercase tracking-wide text-sky-700">Margin (upfront, info only)</div><div className="text-[15px] font-semibold tabular-nums text-sky-950">{formatINR(margin)}</div></div>
                    </div>
                    <div className="mt-3 flex items-center justify-between rounded-lg bg-white/70 px-4 py-2.5">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-sky-800">Net available = open amount − interest − charges</span>
                      <span className="text-xl font-bold tabular-nums text-[#1a2c56]">{formatINR(netAvailable)}</span>
                    </div>
                  </div>
                )
              })()}

              <div className="grid gap-1.5 lg:col-span-2"><Label>Note</Label><Input value={lcForm.note ?? ''} onChange={(e) => setLcForm({ ...lcForm, note: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter className="border-t border-[#e5dfc8] bg-muted/20 px-6 py-4">
            <Button variant="outline" onClick={() => setLcForm(null)}>Cancel</Button>
            <Button disabled={busy} className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void saveLc()}>{busy ? 'Saving…' : 'Save LC'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Issue a bill under an LC */}
      <Dialog open={!!issueForm} onOpenChange={(o) => !o && setIssueForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Issue a bill under {lcs.find((x) => Number(x.id) === Number(issueForm?.lc_id))?.lc_no}</DialogTitle></DialogHeader>
          {issueForm && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Purchase invoice (optional link)</Label>
                <Select
                  value={issueForm.order_id ? String(issueForm.order_id) : ''}
                  onValueChange={(v) => {
                    const o = orders.find((x) => String(x.id) === v)
                    setIssueForm({ ...issueForm, order_id: v, amount: issueForm.amount || String(n(o?.net_amount)), bill_no: issueForm.bill_no || String(o?.invoice_no || '') })
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="Pick the supplier's invoice" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {issueOrders.map((o) => (
                      <SelectItem key={String(o.id)} value={String(o.id)}>
                        {o.invoice_no} · {formatDate(o.order_date)} · {formatINR(o.net_amount)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5"><Label>Bill no</Label><Input value={issueForm.bill_no ?? ''} onChange={(e) => setIssueForm({ ...issueForm, bill_no: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label>Amount (₹) *</Label><Input type="number" value={issueForm.amount ?? ''} onChange={(e) => setIssueForm({ ...issueForm, amount: e.target.value })} /></div>
                <div className="grid gap-1.5"><Label>Issue date</Label><DatePicker value={String(issueForm.issue_date || '')} onChange={(v) => setIssueForm({ ...issueForm, issue_date: v })} /></div>
                <div className="grid gap-1.5">
                  <Label>Due date</Label>
                  <DatePicker value={String(issueForm.due_date || '')} onChange={(v) => setIssueForm({ ...issueForm, due_date: v })} />
                  <span className="text-[10px] text-muted-foreground">blank = issue date + the LC's interest days</span>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveIssue()}>{busy ? 'Saving…' : 'Issue bill'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log / post an LC repayment */}
      <Dialog open={!!repayForm} onOpenChange={(o) => !o && setRepayForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{repayForm?.id ? 'Alter repayment' : 'Log an LC repayment'}</DialogTitle></DialogHeader>
          {repayForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Related party <span className="text-[10px] font-normal text-muted-foreground">(optional — for reference only, not posted)</span></Label>
                <Select value={repayForm.party_id ? String(repayForm.party_id) : ''} onValueChange={(v) => setRepayForm({ ...repayForm, party_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {customers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5"><Label>Repayment amount (₹) *</Label><Input type="number" value={repayForm.amount ?? ''} onChange={(e) => setRepayForm({ ...repayForm, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Maturity charges (₹)</Label><Input type="number" value={repayForm.maturity_charges ?? ''} onChange={(e) => setRepayForm({ ...repayForm, maturity_charges: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Date</Label><DatePicker value={String(repayForm.repay_date || '')} onChange={(v) => setRepayForm({ ...repayForm, repay_date: v })} /></div>
              {(n(repayForm.amount) > 0 || n(repayForm.maturity_charges) > 0) && (
                <div className="grid gap-1.5">
                  <Label>Total debited from bank</Label>
                  <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
                    {formatINR(n(repayForm.amount) + n(repayForm.maturity_charges))}
                  </div>
                </div>
              )}
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Bank document / payment letter</Label>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void pickRepaymentDocument()}>
                    <Paperclip className="h-3.5 w-3.5" /> Attach file
                  </Button>
                  {repayForm.document_path ? (
                    <span className="truncate text-[11px] text-muted-foreground" title={String(repayForm.document_path)}>
                      {String(repayForm.document_path).split(/[\\/]/).pop()}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">No file attached</span>
                  )}
                </div>
              </div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={repayForm.note ?? ''} onChange={(e) => setRepayForm({ ...repayForm, note: e.target.value })} /></div>
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

      {/* Discount a bill */}
      <Dialog open={!!bdForm} onOpenChange={(o) => !o && setBdForm(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Discount a sale bill</DialogTitle></DialogHeader>
          {bdForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
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
              <div className="grid gap-1.5"><Label>Discounting bank *</Label><Input value={bdForm.disc_bank ?? ''} onChange={(e) => setBdForm({ ...bdForm, disc_bank: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Bill amount (₹) *</Label><Input type="number" value={bdForm.amount ?? ''} onChange={(e) => setBdForm({ ...bdForm, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Discount date</Label><DatePicker value={String(bdForm.open_date || '')} onChange={(v) => setBdForm({ ...bdForm, open_date: v })} /></div>
              <div className="grid gap-1.5">
                <Label>Maturity date</Label>
                <DatePicker value={String(bdForm.maturity_date || '')} onChange={(v) => setBdForm({ ...bdForm, maturity_date: v })} />
                <span className="text-[10px] text-muted-foreground">or leave blank and give tenor days</span>
              </div>
              <div className="grid gap-1.5"><Label>Tenor (days)</Label><Input type="number" value={bdForm.tenor_days ?? ''} onChange={(e) => setBdForm({ ...bdForm, tenor_days: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Rate % p.a. *</Label><Input type="number" value={bdForm.rate_pct ?? ''} onChange={(e) => setBdForm({ ...bdForm, rate_pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Bank charges (₹)</Label><Input type="number" value={bdForm.charges ?? ''} onChange={(e) => setBdForm({ ...bdForm, charges: e.target.value })} /></div>
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
