import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Card } from '@/components/ui/card'
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
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TYPE_LABEL: Record<string, string> = {
  opening: 'Opening balance',
  payable: 'Purchase / payable',
  payment: 'Payment',
  advance: 'Advance',
  adjustment: 'Adjustment',
  manual: 'Entry',
  general: 'General voucher',
  dr_note: 'Debit note',
  cr_note: 'Credit note',
  interest: 'Interest',
  freight: 'Freight',
  shortage_penalty: 'Shortage penalty'
}

// Tally voucher type shown per entry.
const VOUCHER_TYPE: Record<string, string> = {
  opening: 'General Voucher',
  payable: 'Purchase',
  payment: 'General Voucher',
  advance: 'General Voucher',
  adjustment: 'General Voucher',
  manual: 'General Voucher',
  general: 'General Voucher',
  interest: 'Dr Note',
  freight: 'Purchase',
  shortage_penalty: 'Cr Note',
  dr_note: 'Dr Note',
  cr_note: 'Cr Note',
  sale: 'Sale'
}

const MANUAL_TYPES = ['opening', 'advance', 'adjustment', 'manual', 'general', 'dr_note', 'cr_note']

// Credit (we owe the party) is positive; debit (we paid / they owe us) is negative.
function drCr(amount: number): string {
  const a = Math.abs(amount)
  return `${formatINR(a)} ${amount >= 0 ? 'Cr' : 'Dr'}`
}

function PartyLedger({
  partyType
}: {
  partyType: 'supplier' | 'transporter' | 'customer'
}): React.JSX.Element {
  const nameKey =
    partyType === 'supplier'
      ? 'supplier_name'
      : partyType === 'transporter'
        ? 'transporter_name'
        : 'customer_name'
  const idKey =
    partyType === 'supplier'
      ? 'supplier_id'
      : partyType === 'transporter'
        ? 'transporter_id'
        : 'customer_id'
  const label =
    partyType === 'supplier' ? 'Supplier' : partyType === 'transporter' ? 'Transporter' : 'Customer'
  const isCustomer = partyType === 'customer'

  const [entries, setEntries] = useState<Row[]>([])
  const [parties, setParties] = useState<Row[]>([])
  const [partyId, setPartyId] = useState('all')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const table =
      partyType === 'supplier' ? 'suppliers' : partyType === 'transporter' ? 'transporters' : 'customers'
    const ledgerCall =
      partyType === 'supplier'
        ? window.api.ledger.suppliers()
        : partyType === 'transporter'
          ? window.api.ledger.transporters()
          : window.api.ledger.customers()
    const [e, p] = await Promise.all([ledgerCall, window.api.data.list(table)])
    setEntries(e)
    setParties(p.filter((x) => x.active))
  }, [partyType])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const statement = useMemo(() => {
    if (partyId === 'all') return []
    const list = entries.filter((e) => String(e[idKey]) === partyId)
    list.sort((a, b) => {
      const ao = a.entry_type === 'opening' ? 0 : 1
      const bo = b.entry_type === 'opening' ? 0 : 1
      if (ao !== bo) return ao - bo
      const ad = String(a.entry_date || '')
      const bd = String(b.entry_date || '')
      if (ad !== bd) return ad < bd ? -1 : 1
      return (a.id as number) - (b.id as number)
    })
    let bal = 0
    return list.map((e): Row => {
      bal += Number(e.amount) || 0
      return { ...e, _bal: bal }
    })
  }, [entries, partyId, idKey])

  const closing = statement.length ? Number(statement[statement.length - 1]._bal) : 0
  const totalDr = statement.reduce((s, e) => s + (Number(e.amount) < 0 ? -Number(e.amount) : 0), 0)
  const totalCr = statement.reduce((s, e) => s + (Number(e.amount) > 0 ? Number(e.amount) : 0), 0)
  const selectedName = parties.find((p) => String(p.id) === partyId)?.name

  const summary = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of entries) {
      const name = (e[nameKey] as string) ?? '—'
      map.set(name, (map.get(name) ?? 0) + (Number(e.amount) || 0))
    }
    return Array.from(map.entries()).map(([name, bal]) => ({ name, bal }))
  }, [entries, nameKey])

  function openAdd(): void {
    setForm({
      party_id: partyId !== 'all' ? partyId : '',
      entry_date: todayISO(),
      entry_type: 'opening',
      side: 'cr',
      amount: '',
      note: ''
    })
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((p) => {
      const next = { ...p, [key]: value }
      // sensible default side per voucher type
      if (key === 'entry_type') {
        next.side = value === 'advance' || value === 'dr_note' ? 'dr' : 'cr'
      }
      return next
    })
  }

  async function save(): Promise<void> {
    if (!form.party_id) {
      toast.error(`Select a ${label.toLowerCase()}`)
      return
    }
    if (!form.amount || Number(form.amount) <= 0) {
      toast.error('Enter an amount')
      return
    }
    setSaving(true)
    try {
      const amt = Number(form.amount)
      await window.api.ledger.addEntry({
        party_type: partyType,
        party_id: Number(form.party_id),
        entry_date: form.entry_date,
        entry_type: form.entry_type,
        dr: form.side === 'dr' ? amt : 0,
        cr: form.side === 'cr' ? amt : 0,
        note: form.note || TYPE_LABEL[form.entry_type]
      })
      toast.success('Entry added')
      setOpen(false)
      if (partyId === 'all') setPartyId(String(form.party_id))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function delEntry(row: Row): Promise<void> {
    if (!window.confirm('Delete this manual entry?')) return
    try {
      await window.api.ledger.deleteEntry(partyType, row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <div className="w-72">
          <Select value={partyId} onValueChange={setPartyId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All {label.toLowerCase()}s — balances</SelectItem>
              {parties.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" />
          Add entry
        </Button>
      </div>

      {partyId === 'all' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summary.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries yet.</p>
          ) : (
            summary.map((s) => (
              <Card key={s.name} className="p-4">
                <div className="text-sm text-muted-foreground">{s.name}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{drCr(s.bal)}</div>
                <div className="text-xs text-muted-foreground">
                  {isCustomer
                    ? s.bal > 0
                      ? 'excess held (we owe)'
                      : s.bal < 0
                        ? 'receivable (they owe)'
                        : 'settled'
                    : s.bal >= 0
                      ? 'we owe'
                      : 'advance / they owe'}
                </div>
              </Card>
            ))
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">{selectedName || label}</div>
              <div className="text-xs text-muted-foreground">{statement.length} entries</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Closing balance</div>
              <div className="text-lg font-bold tabular-nums">{drCr(closing)}</div>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Voucher no</TableHead>
                <TableHead>Voucher type</TableHead>
                <TableHead className="text-right">Dr.</TableHead>
                <TableHead className="text-right">Cr.</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statement.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    No entries for this {label.toLowerCase()} yet.
                  </TableCell>
                </TableRow>
              ) : (
                statement.map((e) => {
                  const amt = Number(e.amount) || 0
                  return (
                    <TableRow key={e.id as number}>
                      <TableCell>{formatDate(e.entry_date)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{e[nameKey] || '—'}</div>
                        {(e.note || TYPE_LABEL[e.entry_type]) && (
                          <div className="text-xs text-muted-foreground">
                            {e.note || TYPE_LABEL[e.entry_type]}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{e.invoice_no || '—'}</TableCell>
                      <TableCell>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                          {VOUCHER_TYPE[e.entry_type] || 'General Voucher'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amt < 0 ? formatINR(-amt) : ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amt > 0 ? formatINR(amt) : ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{drCr(Number(e._bal))}</TableCell>
                      <TableCell className="text-right">
                        {MANUAL_TYPES.includes(e.entry_type) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            onClick={() => delEntry(e)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
          {statement.length > 0 && (
            <div className="flex items-center justify-end gap-6 border-t bg-muted/30 px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">
                Total Dr <span className="font-semibold tabular-nums text-foreground">{formatINR(totalDr)}</span>
              </span>
              <span className="text-muted-foreground">
                Total Cr <span className="font-semibold tabular-nums text-foreground">{formatINR(totalCr)}</span>
              </span>
              <span className="font-semibold">
                Closing <span className="tabular-nums">{drCr(closing)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add ledger entry</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>{label}</Label>
              <Select value={String(form.party_id ?? '')} onValueChange={(v) => setField('party_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {parties.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={form.entry_type} onValueChange={(v) => setField('entry_type', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opening">Opening balance</SelectItem>
                    <SelectItem value="general">General voucher</SelectItem>
                    <SelectItem value="dr_note">Debit note</SelectItem>
                    <SelectItem value="cr_note">Credit note</SelectItem>
                    <SelectItem value="advance">Advance / excess</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <DatePicker value={form.entry_date} onChange={(v) => setField('entry_date', v)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Side</Label>
                <Select value={form.side} onValueChange={(v) => setField('side', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cr">Credit (we owe)</SelectItem>
                    <SelectItem value="dr">Debit (advance / they owe)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Amount</Label>
                <Input type="number" value={form.amount ?? ''} onChange={(e) => setField('amount', e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Particulars</Label>
              <Input value={form.note ?? ''} onChange={(e) => setField('note', e.target.value)} placeholder="optional narration" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Add entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function Ledgers(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Ledgers" subtitle="Party statements with opening balance, advances and running balance" hint="Tally-style statements. Credit (we owe the party) is positive; debit is negative. Only manual entries (opening, advance, adjustment) can be deleted — order and payment entries are posted automatically." />
      <div className="p-8">
        <Tabs defaultValue="suppliers">
          <TabsList>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            <TabsTrigger value="transporters">Transporters</TabsTrigger>
          </TabsList>
          <TabsContent value="suppliers" className="mt-6">
            <PartyLedger partyType="supplier" />
          </TabsContent>
          <TabsContent value="customers" className="mt-6">
            <PartyLedger partyType="customer" />
          </TabsContent>
          <TabsContent value="transporters" className="mt-6">
            <PartyLedger partyType="transporter" />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
