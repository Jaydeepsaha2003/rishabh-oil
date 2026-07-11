import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const SOURCES = ['Bank', 'Credit Card', 'Bill Discounting', 'Letter of Credit']
const METHODS = [
  { v: 'on_account', l: 'On account' },
  { v: 'fifo', l: 'FIFO (oldest first)' },
  { v: 'specific', l: 'Specific invoice' }
]

function daysBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null
  const d = (new Date(a).getTime() - new Date(b).getTime()) / 86400000
  return Number.isFinite(d) ? Math.round(d) : null
}

// ---------------- Payments tab ----------------

function PaymentsTab(): React.JSX.Element {
  const [payments, setPayments] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const [outstanding, setOutstanding] = useState<Row[]>([])
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Row>({})

  const load = useCallback(async () => {
    const [p, s, t, cu] = await Promise.all([
      window.api.payments.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('transporters'),
      window.api.data.list('customers')
    ])
    setPayments(p)
    setSuppliers(s.filter((x) => x.active))
    setTransporters(t.filter((x) => x.active))
    setCustomers(cu.filter((x) => x.active))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const parties =
    form.party_type === 'transporter'
      ? transporters
      : form.party_type === 'customer'
        ? customers
        : suppliers
  const isReceipt = form.party_type === 'customer'

  function openAdd(): void {
    setForm({
      party_type: 'supplier',
      party_id: '',
      payment_date: todayISO(),
      amount: '',
      source: 'Bank',
      is_advance: false,
      method: 'on_account',
      reference: '',
      note: ''
    })
    setOutstanding([])
    setAlloc({})
    setRecording(true)
  }

  async function refreshOutstanding(partyType: string, partyId: string): Promise<void> {
    if (!partyId) {
      setOutstanding([])
      return
    }
    setOutstanding(await window.api.payments.outstanding(partyType, Number(partyId)))
  }

  function setField(key: string, value: unknown): void {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'party_type') {
        next.party_id = ''
        setOutstanding([])
        setAlloc({})
      }
      return next
    })
    if (key === 'party_id') refreshOutstanding(form.party_type, String(value))
  }

  async function save(): Promise<void> {
    if (!form.party_id) {
      toast.error('Select a party')
      return
    }
    if (!form.amount || Number(form.amount) <= 0) {
      toast.error('Enter an amount')
      return
    }
    setSaving(true)
    try {
      const allocations =
        !form.is_advance && form.method === 'specific'
          ? outstanding
              .map((o) => ({ order_id: o.id, amount: Number(alloc[o.id] || 0) }))
              .filter((a) => a.amount > 0)
          : []
      await window.api.payments.record({
        party_type: form.party_type,
        party_id: Number(form.party_id),
        payment_date: form.payment_date,
        amount: Number(form.amount),
        source: form.source,
        method: form.method,
        is_advance: !!form.is_advance,
        reference: form.reference,
        note: form.note,
        allocations
      })
      toast.success(isReceipt ? 'Receipt recorded' : 'Payment recorded')
      setRecording(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm('Delete this payment? Its allocations and ledger entries are removed too.'))
      return
    try {
      await window.api.payments.remove(row.id as number)
      toast.success('Payment deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const allocEditable = !form.is_advance && form.method === 'specific'
  const showInvoices = !!form.party_id
  const totalOutstanding = outstanding.reduce((sum, o) => sum + Number(o.outstanding || 0), 0)
  const allocatedSpecific = outstanding.reduce((sum, o) => sum + Number(alloc[o.id] || 0), 0)
  const payAmount = Number(form.amount) || 0
  // How much of this payment would be left over as excess (kept on the party account).
  const excess = form.is_advance
    ? payAmount
    : form.method === 'specific'
      ? Math.max(0, payAmount - allocatedSpecific)
      : form.method === 'fifo'
        ? Math.max(0, payAmount - totalOutstanding)
        : payAmount // on account — nothing applied to invoices

  if (!recording) {
    return (
      <div>
        <div className="mb-4 flex justify-end">
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Record payment / receipt
          </Button>
        </div>

        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[60px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No payments yet.
                  </TableCell>
                </TableRow>
              ) : (
                payments.map((p) => (
                  <TableRow key={p.id as number}>
                    <TableCell>{formatDate(p.payment_date)}</TableCell>
                    <TableCell>{p.party_name ?? '—'}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{p.party_type}</TableCell>
                    <TableCell>{p.source ?? '—'}</TableCell>
                    <TableCell>
                      {p.is_advance ? (
                        <Badge variant="warning">Excess</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {METHODS.find((m) => m.v === p.method)?.l ?? p.method}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatINR(p.amount)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => del(p)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    )
  }

  const partyName = parties.find((x) => String(x.id) === String(form.party_id))?.name
  const applied = Math.max(0, payAmount - excess)

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setRecording(false)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <h3 className="text-lg font-semibold">{isReceipt ? 'Record receipt' : 'Record payment'}</h3>
        <Badge variant={isReceipt ? 'success' : 'warning'}>
          {isReceipt ? 'Money in' : 'Money out'}
        </Badge>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        {/* form */}
        <div className="space-y-5">
          <section className="rounded-xl border bg-card p-5 shadow-sm">
            <h4 className="mb-4 text-sm font-semibold text-muted-foreground">Party</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Debtor / creditor</Label>
                <Select value={form.party_type} onValueChange={(v) => setField('party_type', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supplier">Supplier (creditor — pay)</SelectItem>
                    <SelectItem value="transporter">Transporter (creditor — pay)</SelectItem>
                    <SelectItem value="customer">Customer (debtor — receive)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>{form.party_type === 'transporter' ? 'Transporter' : isReceipt ? 'Customer' : 'Supplier'} *</Label>
                <Select value={String(form.party_id)} onValueChange={(v) => setField('party_id', v)}>
                  <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                  <SelectContent>
                    {parties.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-card p-5 shadow-sm">
            <h4 className="mb-4 text-sm font-semibold text-muted-foreground">
              {isReceipt ? 'Receipt' : 'Payment'} details
            </h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <DatePicker value={form.payment_date ?? ''} onChange={(v) => setField('payment_date', v)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Amount *</Label>
                <Input type="number" value={form.amount ?? ''} onChange={(e) => setField('amount', e.target.value)} placeholder="0.00" />
              </div>
              <div className="grid gap-1.5">
                <Label>Source</Label>
                <Select value={form.source} onValueChange={(v) => setField('source', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Allocation</Label>
                <Select value={form.method} onValueChange={(v) => setField('method', v)} disabled={!!form.is_advance}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => <SelectItem key={m.v} value={m.v}>{m.l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <span className="text-sm font-medium">Excess amount (on account)</span>
                <p className="text-[11px] text-muted-foreground">Kept as a credit on the party account, not applied to any invoice.</p>
              </div>
              <Switch checked={!!form.is_advance} onCheckedChange={(v) => setField('is_advance', v)} />
            </div>

            <div className="mt-4 grid gap-1.5">
              <Label>Reference / note</Label>
              <Input value={form.note ?? ''} onChange={(e) => setField('note', e.target.value)} placeholder="cheque no, UTR, remark…" />
            </div>
          </section>

          {showInvoices && (
            <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5">
                <h4 className="text-sm font-semibold">{isReceipt ? 'Sales' : 'Purchase'} invoices outstanding</h4>
                <Badge variant="secondary">{outstanding.length}</Badge>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y">
                {outstanding.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">No open invoices for this party.</p>
                ) : (
                  outstanding.map((o) => (
                    <div key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{o.invoice_no || '—'}</div>
                        <div className="text-xs text-muted-foreground">{formatDate(o.order_date)} · due {formatINR(o.outstanding)}</div>
                      </div>
                      {allocEditable ? (
                        <Input
                          type="number"
                          className="h-8 w-32"
                          placeholder="0"
                          value={alloc[o.id] ?? ''}
                          onChange={(e) => setAlloc((p) => ({ ...p, [o.id]: e.target.value }))}
                        />
                      ) : (
                        <span className="text-sm tabular-nums text-muted-foreground">{formatINR(o.outstanding)}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
              {!allocEditable && outstanding.length > 0 && (
                <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
                  {form.is_advance
                    ? 'Excess — kept on the party account, not applied to invoices.'
                    : form.method === 'fifo'
                      ? 'FIFO will apply to the oldest invoices automatically.'
                      : 'On account — not applied to specific invoices.'}
                </div>
              )}
            </section>
          )}
        </div>

        {/* summary */}
        <aside className={cn('h-fit rounded-xl border border-t-4 bg-card p-5 shadow-sm xl:sticky xl:top-6', isReceipt ? 'border-t-emerald-400' : 'border-t-amber-400')}>
          <h4 className="text-sm font-semibold text-muted-foreground">{isReceipt ? 'Receipt' : 'Payment'} summary</h4>
          <div className="mt-3">
            <div className="text-xs text-muted-foreground">{isReceipt ? 'Receiving from' : 'Paying'}</div>
            <div className="truncate text-base font-semibold">{partyName || '—'}</div>
          </div>
          <div className={cn('mt-4 rounded-lg p-3', isReceipt ? 'bg-emerald-50' : 'bg-amber-50')}>
            <div className="text-xs text-muted-foreground">{isReceipt ? 'Amount received' : 'Amount paid'}</div>
            <div className={cn('text-2xl font-bold tabular-nums', isReceipt ? 'text-emerald-700' : 'text-amber-700')}>
              {formatINR(payAmount)}
            </div>
          </div>
          <div className="mt-4 space-y-0.5">
            <MoneyRowLine label="Total outstanding" value={formatINR(totalOutstanding)} />
            <MoneyRowLine label="Applied to invoices" value={formatINR(applied)} />
            <MoneyRowLine label="Excess on account" value={formatINR(excess)} strong={excess > 0.005} />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setRecording(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : isReceipt ? 'Receive' : 'Pay'}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function MoneyRowLine({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold tabular-nums text-amber-700' : 'tabular-nums'}>{value}</span>
    </div>
  )
}

// ---------------- Bill discounting tab ----------------

function emptyBd(): Row {
  return {
    supplier_id: '',
    medium: '',
    lc_open_amount: '',
    open_date: '',
    maturity_date: '',
    payment_received_date: '',
    disc_bank: '',
    bill_nos: '',
    amount: '',
    status: 'pending',
    note: ''
  }
}

function BillDiscountTab(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyBd())
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [b, s] = await Promise.all([
      window.api.billDiscounts.list(),
      window.api.data.list('suppliers')
    ])
    setRows(b)
    setSuppliers(s.filter((x) => x.active))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function openAdd(): void {
    setEditing(null)
    setForm(emptyBd())
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      supplier_id: String(row.supplier_id ?? ''),
      medium: row.medium ?? '',
      lc_open_amount: row.lc_open_amount ?? '',
      open_date: row.open_date ?? '',
      maturity_date: row.maturity_date ?? '',
      payment_received_date: row.payment_received_date ?? '',
      disc_bank: row.disc_bank ?? '',
      bill_nos: row.bill_nos ?? '',
      amount: row.amount ?? '',
      status: row.status ?? 'pending',
      note: row.note ?? ''
    })
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function save(): Promise<void> {
    if (!form.supplier_id) {
      toast.error('Select a party')
      return
    }
    setSaving(true)
    try {
      const payload = { ...form, supplier_id: Number(form.supplier_id) }
      if (editing) await window.api.billDiscounts.update(editing.id as number, payload)
      else await window.api.billDiscounts.create(payload)
      toast.success('Bill discount saved')
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm('Delete this bill discount record?')) return
    try {
      await window.api.billDiscounts.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" />
          New bill discount
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Party</TableHead>
              <TableHead>Medium</TableHead>
              <TableHead className="text-right">LC amount</TableHead>
              <TableHead>Open</TableHead>
              <TableHead>Maturity</TableHead>
              <TableHead>Pay received</TableHead>
              <TableHead className="text-right">Days</TableHead>
              <TableHead>Disc. bank / NBFC</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[80px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  No bill discounts yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const days = daysBetween(r.maturity_date, r.payment_received_date)
                return (
                  <TableRow key={r.id as number}>
                    <TableCell>{r.supplier_name ?? r.party_name ?? '—'}</TableCell>
                    <TableCell>{r.medium ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(r.lc_open_amount)}</TableCell>
                    <TableCell>{formatDate(r.open_date)}</TableCell>
                    <TableCell>{formatDate(r.maturity_date)}</TableCell>
                    <TableCell>{formatDate(r.payment_received_date)}</TableCell>
                    <TableCell className="text-right tabular-nums">{days ?? '—'}</TableCell>
                    <TableCell>{r.disc_bank ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === 'paid' ? 'success' : 'warning'}>
                        {r.status === 'paid' ? 'Paid' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => del(r)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit bill discount' : 'New bill discount'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Party (supplier)</Label>
              <Select value={String(form.supplier_id)} onValueChange={(v) => setField('supplier_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Medium</Label>
              <Input value={form.medium} onChange={(e) => setField('medium', e.target.value)} placeholder="Entry / Direct" />
            </div>
            <div className="grid gap-1.5">
              <Label>LC open amount</Label>
              <Input type="number" value={form.lc_open_amount} onChange={(e) => setField('lc_open_amount', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Discounting bank / NBFC</Label>
              <Input value={form.disc_bank} onChange={(e) => setField('disc_bank', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Open date</Label>
              <DatePicker value={form.open_date} onChange={(v) => setField('open_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Maturity date</Label>
              <DatePicker value={form.maturity_date} onChange={(v) => setField('maturity_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Payment received date</Label>
              <DatePicker
                value={form.payment_received_date}
                onChange={(v) => setField('payment_received_date', v)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Bill no(s)</Label>
              <Input value={form.bill_nos} onChange={(e) => setField('bill_nos', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Amount</Label>
              <Input type="number" value={form.amount} onChange={(e) => setField('amount', e.target.value)} />
            </div>
          </div>
          {form.maturity_date && form.payment_received_date && (
            <p className="text-xs text-muted-foreground">
              Days (maturity − payment received): {daysBetween(form.maturity_date, form.payment_received_date)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Letters of credit / facilities tab ----------------

function emptyLc(): Row {
  return {
    lc_no: '',
    facility_type: 'lc',
    bank: '',
    party_type: 'supplier',
    party_id: '',
    amount: '',
    open_date: todayISO(),
    expiry_date: '',
    interest_pct: '',
    charges: '',
    status: 'open',
    note: ''
  }
}

function LcTab(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [orders, setOrders] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyLc())
  const [saving, setSaving] = useState(false)
  const [issueFor, setIssueFor] = useState<Row | null>(null)
  const [issueForm, setIssueForm] = useState<Row>({})
  const [viewFor, setViewFor] = useState<Row | null>(null)
  const [issuances, setIssuances] = useState<Row[]>([])

  const load = useCallback(async () => {
    const [l, s, o] = await Promise.all([
      window.api.lc.list(),
      window.api.data.list('suppliers'),
      window.api.orders.list()
    ])
    setRows(l)
    setSuppliers(s.filter((x) => x.active))
    setOrders(o)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function setField(key: string, value: unknown): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function openAdd(): void {
    setEditing(null)
    setForm(emptyLc())
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      lc_no: row.lc_no ?? '',
      facility_type: row.facility_type ?? 'lc',
      bank: row.bank ?? '',
      party_type: row.party_type ?? 'supplier',
      party_id: row.party_id ? String(row.party_id) : '',
      amount: row.amount ?? '',
      open_date: row.open_date ?? '',
      expiry_date: row.expiry_date ?? '',
      interest_pct: row.interest_pct ?? '',
      charges: row.charges ?? '',
      status: row.status ?? 'open',
      note: row.note ?? ''
    })
    setOpen(true)
  }

  async function save(): Promise<void> {
    if (!form.lc_no || !form.bank) {
      toast.error('LC number and bank are required')
      return
    }
    setSaving(true)
    try {
      const payload = { ...form, party_id: form.party_id ? Number(form.party_id) : null }
      if (editing) await window.api.lc.update(editing.id as number, payload)
      else await window.api.lc.create(payload)
      toast.success('LC saved')
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete LC ${row.lc_no} and its issuances?`)) return
    try {
      await window.api.lc.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openIssue(row: Row): void {
    setIssueFor(row)
    setIssueForm({ issue_date: todayISO(), amount: '', order_id: '', bill_no: '', note: '' })
  }

  async function saveIssue(): Promise<void> {
    if (!issueFor) return
    try {
      await window.api.lc.issue({
        ...issueForm,
        lc_id: issueFor.id,
        amount: Number(issueForm.amount) || 0,
        order_id: issueForm.order_id ? Number(issueForm.order_id) : null
      })
      toast.success('Issued against LC')
      setIssueFor(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function openView(row: Row): Promise<void> {
    setViewFor(row)
    setIssuances(await window.api.lc.issuances(row.id as number))
  }

  async function delIssuance(id: number): Promise<void> {
    try {
      await window.api.lc.removeIssuance(id)
      if (viewFor) setIssuances(await window.api.lc.issuances(viewFor.id as number))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Open LC / facility
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>LC / facility no</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Bank</TableHead>
              <TableHead>Beneficiary</TableHead>
              <TableHead className="text-right">Sanctioned</TableHead>
              <TableHead className="text-right">Utilized</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[140px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  No LCs or facilities opened yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id as number}>
                  <TableCell className="font-medium">{r.lc_no}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{r.facility_type === 'bill_discounting' ? 'Bill disc.' : 'LC'}</Badge>
                  </TableCell>
                  <TableCell>{r.bank}</TableCell>
                  <TableCell>{r.supplier_name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(r.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(r.utilized)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatINR(r.available)}</TableCell>
                  <TableCell>{formatDate(r.expiry_date)}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === 'open' ? 'success' : r.status === 'closed' ? 'muted' : 'warning'}>
                      {r.status === 'open' ? 'Open' : r.status === 'closed' ? 'Closed' : 'Utilized'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" onClick={() => openIssue(r)} disabled={Number(r.available) <= 0.005}>Issue</Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openView(r)} title="Issuances"><FileText className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(r)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Open / edit LC */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit LC / facility' : 'Open LC / facility'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>LC / facility no *</Label>
              <Input value={form.lc_no} onChange={(e) => setField('lc_no', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={form.facility_type} onValueChange={(v) => setField('facility_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lc">Letter of credit</SelectItem>
                  <SelectItem value="bill_discounting">Bill discounting</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Bank *</Label>
              <Input value={form.bank} onChange={(e) => setField('bank', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Beneficiary (supplier)</Label>
              <Select value={String(form.party_id)} onValueChange={(v) => setField('party_id', v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Sanctioned amount</Label>
              <Input type="number" value={form.amount} onChange={(e) => setField('amount', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setField('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="utilized">Utilized</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Open date</Label>
              <DatePicker value={form.open_date} onChange={(v) => setField('open_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Expiry date</Label>
              <DatePicker value={form.expiry_date} onChange={(v) => setField('expiry_date', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Interest %</Label>
              <Input type="number" value={form.interest_pct} onChange={(e) => setField('interest_pct', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Charges</Label>
              <Input type="number" value={form.charges} onChange={(e) => setField('charges', e.target.value)} />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label>Note</Label>
              <Input value={form.note} onChange={(e) => setField('note', e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Issue against LC */}
      <Dialog open={!!issueFor} onOpenChange={(o) => !o && setIssueFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue against {issueFor?.lc_no}</DialogTitle>
          </DialogHeader>
          {issueFor && (
            <div className="grid gap-3">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                {issueFor.bank} · Available {formatINR(issueFor.available)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5"><Label>Issue date</Label><DatePicker value={issueForm.issue_date || ''} onChange={(v) => setIssueForm((p) => ({ ...p, issue_date: v }))} /></div>
                <div className="grid gap-1.5"><Label>Amount *</Label><Input type="number" value={issueForm.amount || ''} onChange={(e) => setIssueForm((p) => ({ ...p, amount: e.target.value }))} /></div>
              </div>
              <div className="grid gap-1.5">
                <Label>Against purchase invoice (optional)</Label>
                <Select value={String(issueForm.order_id || '')} onValueChange={(v) => setIssueForm((p) => ({ ...p, order_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select invoice" /></SelectTrigger>
                  <SelectContent>
                    {orders.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.invoice_no} · {o.supplier_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5"><Label>Bill no</Label><Input value={issueForm.bill_no || ''} onChange={(e) => setIssueForm((p) => ({ ...p, bill_no: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>Note</Label><Input value={issueForm.note || ''} onChange={(e) => setIssueForm((p) => ({ ...p, note: e.target.value }))} /></div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueFor(null)}>Cancel</Button>
            <Button onClick={saveIssue}>Issue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View issuances */}
      <Dialog open={!!viewFor} onOpenChange={(o) => !o && setViewFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issuances · {viewFor?.lc_no}</DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Invoice / bill</TableHead>
                <TableHead className="text-right">Amount</TableHead><TableHead className="w-[40px]" />
              </TableRow></TableHeader>
              <TableBody>
                {issuances.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No issuances yet.</TableCell></TableRow>
                ) : (
                  issuances.map((i) => (
                    <TableRow key={i.id as number}>
                      <TableCell>{formatDate(i.issue_date)}</TableCell>
                      <TableCell>{i.invoice_no || i.bill_no || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatINR(i.amount)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => delIssuance(i.id as number)}><Trash2 className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function Payments(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Payments" subtitle="Pay suppliers and transporters; LC, bill discounting and excess on account" hint="Pick a party to see its open invoices, then pay against them (FIFO or specific) or keep an Excess amount on account. Open Letters of Credit / discounting facilities with a bank and issue against them; utilization is tracked automatically. Sources: Bank, Credit Card, Bill Discounting, Letter of Credit." />
      <div className="p-8">
        <Tabs defaultValue="payments">
          <TabsList>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="lc">Letters of credit</TabsTrigger>
            <TabsTrigger value="bill_discount">Bill discounting</TabsTrigger>
          </TabsList>
          <TabsContent value="payments" className="mt-6">
            <PaymentsTab />
          </TabsContent>
          <TabsContent value="lc" className="mt-6">
            <LcTab />
          </TabsContent>
          <TabsContent value="bill_discount" className="mt-6">
            <BillDiscountTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
