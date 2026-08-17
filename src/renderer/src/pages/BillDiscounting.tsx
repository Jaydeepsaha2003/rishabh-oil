import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Banknote, Check, PiggyBank, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function BillDiscounting(): React.JSX.Element {
  const [parties, setParties] = useState<Row[]>([])
  const [entries, setEntries] = useState<Row[]>([])
  const [fundFlow, setFundFlow] = useState<Row | null>(null)
  const [activePartyId, setActivePartyId] = useState<number | null>(null)
  // Empty = every status.
  const [statusFilter, setStatusFilter] = useState<string[]>([])

  const [partyForm, setPartyForm] = useState<Row | null>(null)
  const [partySaving, setPartySaving] = useState(false)

  const [entryForm, setEntryForm] = useState<Row | null>(null)
  const [entrySaving, setEntrySaving] = useState(false)

  const [interestEntry, setInterestEntry] = useState<Row | null>(null)
  const [interestForm, setInterestForm] = useState<Row>({})

  const load = useCallback(async () => {
    const [p, ff] = await Promise.all([window.api.billDiscounting.parties(), window.api.billDiscounting.fundFlow()])
    setParties(p)
    setFundFlow(ff)
  }, [])

  const loadEntries = useCallback(async () => {
    const filter: Row = {}
    if (activePartyId) filter.bd_party_id = activePartyId
    if (statusFilter.length) filter.status = statusFilter
    setEntries(await window.api.billDiscounting.entries(filter))
  }, [activePartyId, statusFilter])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadEntries()
  }, [loadEntries])
  useLiveRefresh(load)

  function openNewParty(): void {
    setPartyForm({ finance_type: 'PID', purpose: 'either', rate_pct: '', sanctioned_limit: '', security_given: false, interest_bearing: false })
  }

  async function saveParty(): Promise<void> {
    if (!partyForm) return
    setPartySaving(true)
    try {
      const payload = { ...partyForm, security_given: !!partyForm.security_given, interest_bearing: !!partyForm.interest_bearing }
      if (partyForm.id) await window.api.billDiscounting.updateParty(Number(partyForm.id), payload)
      else await window.api.billDiscounting.createParty(payload)
      toast.success('Saved')
      setPartyForm(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPartySaving(false)
    }
  }

  async function removeParty(p: Row): Promise<void> {
    if (!window.confirm(`Delete ${p.party_name}?`)) return
    try {
      await window.api.billDiscounting.deleteParty(Number(p.id))
      if (activePartyId === Number(p.id)) setActivePartyId(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openNewEntry(partyId?: number): void {
    setEntryForm({ bd_party_id: partyId ? String(partyId) : activePartyId ? String(activePartyId) : '', submitted_date: todayISO() })
  }

  async function saveEntry(): Promise<void> {
    if (!entryForm) return
    setEntrySaving(true)
    try {
      await window.api.billDiscounting.createEntry({ ...entryForm, bd_party_id: Number(entryForm.bd_party_id), amount: Number(entryForm.amount) })
      toast.success('Bill submitted')
      setEntryForm(null)
      await Promise.all([load(), loadEntries()])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEntrySaving(false)
    }
  }

  async function markPaid(e: Row): Promise<void> {
    await window.api.billDiscounting.markPaid(Number(e.id))
    toast.success('Marked paid per the discounter\'s advice')
    await loadEntries()
  }

  async function markRepaid(e: Row): Promise<void> {
    await window.api.billDiscounting.markRepaid(Number(e.id))
    toast.success('Marked repaid — headroom freed up')
    await Promise.all([load(), loadEntries()])
  }

  async function removeEntry(e: Row): Promise<void> {
    if (!window.confirm('Delete this entry?')) return
    await window.api.billDiscounting.deleteEntry(Number(e.id))
    await Promise.all([load(), loadEntries()])
  }

  function openInterest(e: Row): void {
    setInterestEntry(e)
    setInterestForm({ interest_amount: e.interest_amount || '', interest_received_date: e.interest_received_date || '' })
  }

  async function saveInterest(): Promise<void> {
    if (!interestEntry) return
    await window.api.billDiscounting.recordInterest(Number(interestEntry.id), interestForm)
    toast.success('Interest updated')
    setInterestEntry(null)
    await Promise.all([load(), loadEntries()])
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">Trade finance (PID/SID)</span> — no stages like an LC; submit
          an invoice, the discounter pays out on its own advice. Each party carries its own rate, finance type,
          security/interest terms and a sanctioned limit entries draw against. Actual bank postings still go through
          Payments/Journal Voucher.
        </span>
      </div>

      {fundFlow && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: 'Sanctioned', value: fundFlow.sanctioned_total },
            { label: 'Outstanding', value: fundFlow.outstanding_total },
            { label: 'Available', value: fundFlow.available_total },
            { label: 'Interest pending', value: fundFlow.interest_pending_total },
            { label: 'Interest received', value: fundFlow.interest_received_total }
          ].map((s) => (
            <Card key={s.label} className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{formatINR(s.value)}</div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold uppercase tracking-widest">Parties</span>
        <Button size="sm" className="ml-auto gap-1.5" onClick={openNewParty}>
          <Plus className="h-3.5 w-3.5" /> Add party
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {parties.map((p) => (
          <Card
            key={String(p.id)}
            className={`cursor-pointer p-4 ${activePartyId === Number(p.id) ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setActivePartyId(Number(p.id) === activePartyId ? null : Number(p.id))}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{p.party_name}</div>
                <div className="text-[11px] text-muted-foreground">{p.discounter || '—'} · {p.finance_type} · {n(p.rate_pct)}%</div>
              </div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); setPartyForm({ ...p }) }}>
                  <Banknote className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={(e) => { e.stopPropagation(); void removeParty(p) }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div><span className="text-muted-foreground">Sanctioned</span><div className="font-medium tabular-nums">{formatINR(p.sanctioned_limit)}</div></div>
              <div><span className="text-muted-foreground">Available</span><div className="font-medium tabular-nums">{formatINR(p.available)}</div></div>
              <div><span className="text-muted-foreground">Outstanding</span><div className="font-medium tabular-nums">{formatINR(p.outstanding)}</div></div>
              <div><span className="text-muted-foreground">Interest pending</span><div className="font-medium tabular-nums">{formatINR(p.interest_pending)}</div></div>
            </div>
            <div className="mt-2 flex gap-1.5">
              {p.security_given ? <Badge variant="outline">Secured</Badge> : null}
              {p.interest_bearing ? <Badge variant="outline">Interest-bearing</Badge> : null}
              {!p.active ? <Badge variant="muted">Inactive</Badge> : null}
            </div>
            <Button size="sm" variant="outline" className="mt-3 w-full gap-1.5" onClick={(e) => { e.stopPropagation(); openNewEntry(Number(p.id)) }}>
              <Plus className="h-3.5 w-3.5" /> Submit a bill
            </Button>
          </Card>
        ))}
        {parties.length === 0 && (
          <p className="col-span-full text-sm text-muted-foreground">No discounting parties set up yet.</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold uppercase tracking-widest">Entries {activePartyId ? `— ${parties.find((p) => Number(p.id) === activePartyId)?.party_name || ''}` : ''}</span>
        <MultiSelectFilter
          options={[
            { value: 'submitted', label: 'Submitted' },
            { value: 'paid', label: 'Paid' },
            { value: 'repaid', label: 'Repaid' }
          ]}
          value={statusFilter}
          onApply={setStatusFilter}
          allLabel="All"
          className="ml-auto w-36"
        />
        {activePartyId && <Button size="sm" variant="ghost" onClick={() => setActivePartyId(null)}>Clear</Button>}
      </div>

      <Card className="overflow-auto p-0">
        {entries.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">No entries yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Party</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Interest</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={String(e.id)}>
                  <TableCell className="font-medium">{e.party_name}</TableCell>
                  <TableCell>{e.invoice_no || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(e.amount)}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(e.submitted_date)}</TableCell>
                  <TableCell className="tabular-nums">{e.payment_date ? formatDate(e.payment_date) : '—'}</TableCell>
                  <TableCell>
                    {e.status === 'repaid' ? <Badge variant="success">Repaid</Badge> : e.status === 'paid' ? <Badge variant="outline">Paid</Badge> : <Badge variant="muted">Submitted</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => openInterest(e)}>
                      {n(e.interest_amount) > 0 ? formatINR(e.interest_amount) : 'Set'}
                      {e.interest_received_date ? <Check className="ml-1 h-3 w-3 text-emerald-600" /> : null}
                    </Button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {e.status === 'submitted' && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void markPaid(e)}>Mark paid</Button>
                      )}
                      {e.status === 'paid' && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void markRepaid(e)}>Mark repaid</Button>
                      )}
                      {e.status === 'repaid' && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Reopen" onClick={() => void markPaid(e)}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void removeEntry(e)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Party CRUD */}
      <Dialog open={!!partyForm} onOpenChange={(o) => !o && setPartyForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{partyForm?.id ? 'Alter party' : 'Add a discounting party'}</DialogTitle></DialogHeader>
          {partyForm && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Party *</Label>
                <Input value={partyForm.party_name ?? ''} onChange={(e) => setPartyForm({ ...partyForm, party_name: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Discounter (bank/NBFC)</Label>
                <Input value={partyForm.discounter ?? ''} onChange={(e) => setPartyForm({ ...partyForm, discounter: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Rate % *</Label>
                <Input type="number" value={partyForm.rate_pct ?? ''} onChange={(e) => setPartyForm({ ...partyForm, rate_pct: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Finance type</Label>
                <Select value={partyForm.finance_type || 'PID'} onValueChange={(v) => setPartyForm({ ...partyForm, finance_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PID">PID</SelectItem>
                    <SelectItem value="SID">SID</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Purpose</Label>
                <Select value={partyForm.purpose || 'either'} onValueChange={(v) => setPartyForm({ ...partyForm, purpose: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="either">Either</SelectItem>
                    <SelectItem value="manufacturing">Manufacturing</SelectItem>
                    <SelectItem value="trading">Trading</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Sanctioned limit (₹)</Label>
                <Input type="number" value={partyForm.sanctioned_limit ?? ''} onChange={(e) => setPartyForm({ ...partyForm, sanctioned_limit: e.target.value })} />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" className="h-4 w-4" checked={!!partyForm.security_given} onChange={(e) => setPartyForm({ ...partyForm, security_given: e.target.checked })} />
                Security given
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" className="h-4 w-4" checked={!!partyForm.interest_bearing} onChange={(e) => setPartyForm({ ...partyForm, interest_bearing: e.target.checked })} />
                Interest-bearing
              </label>
              {partyForm.interest_bearing && (
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Interest payment schedule</Label>
                  <Input value={partyForm.interest_payment_schedule ?? ''} onChange={(e) => setPartyForm({ ...partyForm, interest_payment_schedule: e.target.value })} placeholder="e.g. monthly, on maturity" />
                </div>
              )}
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label>Note</Label>
                <Input value={partyForm.note ?? ''} onChange={(e) => setPartyForm({ ...partyForm, note: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPartyForm(null)}>Cancel</Button>
            <Button disabled={partySaving} onClick={() => void saveParty()}>{partySaving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Submit a bill */}
      <Dialog open={!!entryForm} onOpenChange={(o) => !o && setEntryForm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Submit a bill for discounting</DialogTitle></DialogHeader>
          {entryForm && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Party *</Label>
                <Select value={entryForm.bd_party_id ? String(entryForm.bd_party_id) : ''} onValueChange={(v) => setEntryForm({ ...entryForm, bd_party_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                  <SelectContent>
                    {parties.map((p) => <SelectItem key={String(p.id)} value={String(p.id)}>{p.party_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5"><Label>Invoice no.</Label><Input value={entryForm.invoice_no ?? ''} onChange={(e) => setEntryForm({ ...entryForm, invoice_no: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Amount (₹) *</Label><Input type="number" value={entryForm.amount ?? ''} onChange={(e) => setEntryForm({ ...entryForm, amount: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label>Submitted date</Label><DatePicker value={String(entryForm.submitted_date || '')} onChange={(v) => setEntryForm({ ...entryForm, submitted_date: v })} /></div>
              <div className="flex flex-col gap-1.5 sm:col-span-2"><Label>Note</Label><Input value={entryForm.note ?? ''} onChange={(e) => setEntryForm({ ...entryForm, note: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryForm(null)}>Cancel</Button>
            <Button disabled={entrySaving} onClick={() => void saveEntry()}>{entrySaving ? 'Saving…' : 'Submit'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Interest receipt */}
      <Dialog open={!!interestEntry} onOpenChange={(o) => !o && setInterestEntry(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Interest on this bill</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5"><Label>Interest amount (₹)</Label><Input type="number" value={interestForm.interest_amount ?? ''} onChange={(e) => setInterestForm({ ...interestForm, interest_amount: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5">
              <Label>Received date</Label>
              <DatePicker value={String(interestForm.interest_received_date || '')} onChange={(v) => setInterestForm({ ...interestForm, interest_received_date: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInterestEntry(null)}>Cancel</Button>
            <Button onClick={() => void saveInterest()}><PiggyBank className="h-3.5 w-3.5" /> Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
