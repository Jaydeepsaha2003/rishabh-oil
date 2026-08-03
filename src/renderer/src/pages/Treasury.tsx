import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Landmark,
  Plus,
  RotateCcw,
  Trash2
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

function daysTo(date: unknown): number | null {
  const s = String(date || '').slice(0, 10)
  if (!s) return null
  return Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

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

export function Treasury(): React.JSX.Element {
  const [tab, setTab] = useState('lc')
  const [lcs, setLcs] = useState<Row[]>([])
  const [bills, setBills] = useState<Row[]>([])
  const [alerts, setAlerts] = useState<Row | null>(null)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [sales, setSales] = useState<Row[]>([])
  const [orders, setOrders] = useState<Row[]>([])
  const [issuances, setIssuances] = useState<Record<number, Row[]>>({})
  const [openLc, setOpenLc] = useState<Set<number>>(new Set())
  const [facilities, setFacilities] = useState<Row[]>([])
  const [exposures, setExposures] = useState<Record<number, Row[]>>({})
  const [openFac, setOpenFac] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    const [l, b, a, sup, sl, od, fac] = await Promise.all([
      window.api.lc.list(),
      window.api.billDiscounts.list(),
      window.api.treasury.alerts(),
      window.api.data.list('suppliers'),
      window.api.sales.list(),
      window.api.orders.list(),
      window.api.facility.list()
    ])
    setLcs(l.filter((x) => String(x.facility_type || 'lc') === 'lc'))
    setBills(b.filter((x) => String(x.medium || '') === 'bill_discounting' || x.rate_pct != null))
    setAlerts(a)
    setSuppliers(sup.filter((x) => x.active))
    setSales(sl)
    setOrders(od)
    setFacilities(fac)
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
    const rows = await window.api.lc.issuances(id)
    setIssuances((p) => ({ ...p, [id]: rows }))
  }

  // ---------------- LC create / issue ----------------
  const [lcForm, setLcForm] = useState<Row | null>(null)
  const [issueForm, setIssueForm] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)

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
      toast.success(`LC ${lcForm.lc_no} saved — margin & charges posted to the books`)
      setLcForm(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
        hint="LCs carry usance days: every bill issued under one gets a maturity date, and settling it pays the supplier through the books against the original invoice. Discounting a sale bill brings the bank money in now (interest and charges to expenses) and clears the customer when the bill is realized. Everything shows in the Day Book, ledgers and Trial Balance."
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
          </TabsList>

          <TabsContent value="lc" className="mt-4">
            <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
              <div className="flex items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
                <span className="text-[13px] font-bold uppercase tracking-widest">Letters of Credit</span>
                <Button size="sm" className="ml-auto bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => setLcForm({ open_date: todayISO(), usance_days: '90', margin_pct: '', charges: '' })}>
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
                  {lcs.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No letters of credit yet.</TableCell></TableRow>
                  ) : (
                    lcs.map((l) => {
                      const isOpen = openLc.has(Number(l.id))
                      const pct = n(l.amount) > 0 ? Math.min(100, (n(l.utilized) / n(l.amount)) * 100) : 0
                      const kids = issuances[Number(l.id)] || []
                      return (
                        <Fragment key={String(l.id)}>
                          <TableRow className="cursor-pointer border-b border-dotted border-[#e5dfc8] transition-colors hover:bg-amber-100/70" onClick={() => void toggleLc(Number(l.id))}>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                <div>
                                  <div className="font-semibold">{l.lc_no}</div>
                                  <div className="text-[11px] text-muted-foreground">{l.bank} · usance {n(l.usance_days)}d{n(l.margin_pct) ? ` · margin ${l.margin_pct}%` : ''}</div>
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
                              <TableCell colSpan={7} className="p-0">
                                <div className="px-8 py-3">
                                  {kids.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">No bills issued under this LC yet.</p>
                                  ) : (
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
                                                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={async () => { await window.api.treasury.reopenLcBill(Number(b.id)); void toggleLc(Number(l.id)); setOpenLc((p) => new Set(p).add(Number(l.id))); load() }}>
                                                    <RotateCcw className="h-3 w-3" /> Reopen
                                                  </Button>
                                                ) : (
                                                  <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px] text-emerald-700" onClick={async () => { try { await window.api.treasury.settleLcBill(Number(b.id)); toast.success('Bill settled — supplier paid through the books'); void toggleLc(Number(l.id)); setOpenLc((p) => new Set(p).add(Number(l.id))); load() } catch (e) { toast.error((e as Error).message) } }}>
                                                    <Check className="h-3 w-3" /> Settle
                                                  </Button>
                                                )}
                                                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={async () => { if (confirm('Delete this bill?')) { await window.api.lc.removeIssuance(Number(b.id)); void toggleLc(Number(l.id)); setOpenLc((p) => new Set(p).add(Number(l.id))); load() } }}>
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

      {/* New / edit LC */}
      <Dialog open={!!lcForm} onOpenChange={(o) => !o && setLcForm(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{lcForm?.id ? `Alter LC ${lcForm.lc_no}` : 'Open a letter of credit'}</DialogTitle></DialogHeader>
          {lcForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label>LC no *</Label><Input value={lcForm.lc_no ?? ''} onChange={(e) => setLcForm({ ...lcForm, lc_no: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Bank *</Label><Input value={lcForm.bank ?? ''} onChange={(e) => setLcForm({ ...lcForm, bank: e.target.value })} /></div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Supplier (beneficiary)</Label>
                <Select value={lcForm.party_id ? String(lcForm.party_id) : ''} onValueChange={(v) => setLcForm({ ...lcForm, party_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {suppliers.map((x) => <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>Sanctioned facility <span className="text-[10px] font-normal text-muted-foreground">(optional — draws against its limit)</span></Label>
                <Select
                  value={lcForm.facility_id ? String(lcForm.facility_id) : 'none'}
                  onValueChange={(v) => setLcForm({ ...lcForm, facility_id: v === 'none' ? '' : v })}
                >
                  <SelectTrigger><SelectValue placeholder="Not tied to a sanctioned limit" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="none">Not tied to a sanctioned limit</SelectItem>
                    {facilities.filter((f) => Number(f.active) !== 0).map((f) => (
                      <SelectItem key={String(f.id)} value={String(f.id)}>
                        {f.name} · {f.bank} · {formatINR(f.available)} free
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(() => {
                  const f = facilities.find((x) => String(x.id) === String(lcForm.facility_id))
                  if (!f) return null
                  // Headroom excluding this LC's own current commitment, so
                  // editing an existing LC is judged against the others.
                  const mine = lcForm.id ? n(lcs.find((x) => String(x.id) === String(lcForm.id))?.amount) : 0
                  const free = n(f.available) + mine
                  const over = n(lcForm.amount) - free
                  return (
                    <span className={cn('text-[11px]', over > 0.005 ? 'font-medium text-rose-700' : 'text-muted-foreground')}>
                      {formatINR(free)} free of {formatINR(f.sanctioned_limit)} sanctioned
                      {over > 0.005 ? ` — this LC is ${formatINR(over)} over the limit` : ''}
                    </span>
                  )
                })()}
              </div>
              <div className="grid gap-1.5"><Label>Limit (₹) *</Label><Input type="number" value={lcForm.amount ?? ''} onChange={(e) => setLcForm({ ...lcForm, amount: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Usance days</Label><Input type="number" value={lcForm.usance_days ?? ''} onChange={(e) => setLcForm({ ...lcForm, usance_days: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Open date</Label><DatePicker value={String(lcForm.open_date || '')} onChange={(v) => setLcForm({ ...lcForm, open_date: v })} /></div>
              <div className="grid gap-1.5"><Label>Expiry date *</Label><DatePicker value={String(lcForm.expiry_date || '')} onChange={(v) => setLcForm({ ...lcForm, expiry_date: v })} /></div>
              <div className="grid gap-1.5"><Label>Margin %</Label><Input type="number" value={lcForm.margin_pct ?? ''} onChange={(e) => setLcForm({ ...lcForm, margin_pct: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label>Bank charges (₹)</Label><Input type="number" value={lcForm.charges ?? ''} onChange={(e) => setLcForm({ ...lcForm, charges: e.target.value })} /></div>
              <div className="grid gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={lcForm.note ?? ''} onChange={(e) => setLcForm({ ...lcForm, note: e.target.value })} /></div>
              {n(lcForm.amount) > 0 && n(lcForm.margin_pct) > 0 && (
                <p className="sm:col-span-2 rounded-md bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
                  Margin {formatINR((n(lcForm.amount) * n(lcForm.margin_pct)) / 100)} moves to LC MARGIN A/C when saved{n(lcForm.charges) > 0 ? `, plus ${formatINR(n(lcForm.charges))} bank charges` : ''}.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLcForm(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void saveLc()}>{busy ? 'Saving…' : 'Save LC'}</Button>
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
                  <span className="text-[10px] text-muted-foreground">blank = issue date + the LC's usance days</span>
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
