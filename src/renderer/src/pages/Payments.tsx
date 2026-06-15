import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
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
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const SOURCES = ['Credit Card', 'Bank / CC', 'LC', 'Bill discount']
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
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const [outstanding, setOutstanding] = useState<Row[]>([])
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Row>({})

  const load = useCallback(async () => {
    const [p, s, t] = await Promise.all([
      window.api.payments.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('transporters')
    ])
    setPayments(p)
    setSuppliers(s.filter((x) => x.active))
    setTransporters(t.filter((x) => x.active))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const parties = form.party_type === 'transporter' ? transporters : suppliers

  function openAdd(): void {
    setForm({
      party_type: 'supplier',
      party_id: '',
      payment_date: todayISO(),
      amount: '',
      source: 'Bank / CC',
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
      toast.success('Payment recorded')
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

  if (!recording) {
    return (
      <div>
        <div className="mb-4 flex justify-end">
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Record payment
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
                        <Badge variant="warning">Advance</Badge>
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

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setRecording(false)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <h3 className="text-base font-medium">Record payment</h3>
      </div>
      <Card className="max-w-2xl p-6">
        <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Pay to</Label>
                <Select value={form.party_type} onValueChange={(v) => setField('party_type', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supplier">Supplier</SelectItem>
                    <SelectItem value="transporter">Transporter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>{form.party_type === 'transporter' ? 'Transporter' : 'Supplier'}</Label>
                <Select value={String(form.party_id)} onValueChange={(v) => setField('party_id', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {parties.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={form.payment_date ?? ''}
                  onChange={(e) => setField('payment_date', e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Amount</Label>
                <Input
                  type="number"
                  value={form.amount ?? ''}
                  onChange={(e) => setField('amount', e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Source</Label>
                <Select value={form.source} onValueChange={(v) => setField('source', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Allocation</Label>
                <Select
                  value={form.method}
                  onValueChange={(v) => setField('method', v)}
                  disabled={!!form.is_advance}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m.v} value={m.v}>
                        {m.l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-1.5">
              <span className="text-sm">Advance payment</span>
              <Switch
                checked={!!form.is_advance}
                onCheckedChange={(v) => setField('is_advance', v)}
              />
            </div>

            {showInvoices && (
              <div className="rounded-lg border">
                <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <span>Open invoices</span>
                  <span>{outstanding.length}</span>
                </div>
                <div className="max-h-44 overflow-y-auto p-2">
                  {outstanding.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      No open invoices for this party.
                    </p>
                  ) : (
                    outstanding.map((o) => (
                      <div key={o.id} className="flex items-center gap-2 px-1 py-1">
                        <div className="flex-1 text-sm">
                          <span className="font-medium">{o.invoice_no}</span>
                          <span className="text-muted-foreground">
                            {' '}
                            · {formatDate(o.order_date)} · due {formatINR(o.outstanding)}
                          </span>
                        </div>
                        {allocEditable ? (
                          <Input
                            type="number"
                            className="h-8 w-28"
                            placeholder="0"
                            value={alloc[o.id] ?? ''}
                            onChange={(e) => setAlloc((p) => ({ ...p, [o.id]: e.target.value }))}
                          />
                        ) : (
                          <span className="text-sm tabular-nums text-muted-foreground">
                            {formatINR(o.outstanding)}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
                {!allocEditable && outstanding.length > 0 && (
                  <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                    {form.is_advance
                      ? 'Advance — not applied to invoices.'
                      : form.method === 'fifo'
                        ? 'FIFO will apply to the oldest invoices automatically.'
                        : 'On account — not applied to specific invoices.'}
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-1.5">
              <Label>Reference / note</Label>
              <Input
                value={form.note ?? ''}
                onChange={(e) => setField('note', e.target.value)}
                placeholder="cheque no, UTR, remark…"
              />
            </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setRecording(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Record payment'}
          </Button>
        </div>
      </Card>
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
              <Input type="date" value={form.open_date} onChange={(e) => setField('open_date', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Maturity date</Label>
              <Input type="date" value={form.maturity_date} onChange={(e) => setField('maturity_date', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Payment received date</Label>
              <Input
                type="date"
                value={form.payment_received_date}
                onChange={(e) => setField('payment_received_date', e.target.value)}
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

export function Payments(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Payments" subtitle="Pay suppliers and transporters; track bill discounting" />
      <div className="p-8">
        <Tabs defaultValue="payments">
          <TabsList>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="bill_discount">Bill discounting</TabsTrigger>
          </TabsList>
          <TabsContent value="payments" className="mt-6">
            <PaymentsTab />
          </TabsContent>
          <TabsContent value="bill_discount" className="mt-6">
            <BillDiscountTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
