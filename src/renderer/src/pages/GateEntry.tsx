import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Scale, Trash2, Truck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const blankArrival = (): Row => ({
  gate_entry_no: '',
  entry_date: todayISO(),
  tanker_id: '',
  tanker_no: '',
  dispatch_qty: '',
  uom: 'MT'
})

export function GateEntry(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [arrival, setArrival] = useState<Row>(blankArrival())
  const [savingArrival, setSavingArrival] = useState(false)
  // per-pending-entry weight inputs
  const [weights, setWeights] = useState<Record<number, string>>({})
  const [editRow, setEditRow] = useState<Row | null>(null)
  const [editForm, setEditForm] = useState<Row>({})

  const load = useCallback(async () => {
    setLoading(true)
    const [g, pt, nextNo] = await Promise.all([
      window.api.gate.list(),
      window.api.tankers.list(),
      window.api.gate.nextNo().catch(() => '')
    ])
    setRows(g)
    setTankers(pt)
    setArrival((p) => (p.gate_entry_no ? p : { ...p, gate_entry_no: nextNo }))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  const pending = rows.filter((r) => r.status === 'pending')
  const completed = rows.filter((r) => r.status !== 'pending')

  // Tankers that can still arrive: not emptied yet and no gate entry so far.
  const arrivable = useMemo(() => {
    const withEntry = new Set(rows.map((r) => Number(r.tanker_id)).filter((x) => x > 0))
    return tankers.filter((t) => t.status !== 'empty' && !withEntry.has(Number(t.id)))
  }, [tankers, rows])

  function chooseTanker(id: string): void {
    const t = tankers.find((x) => String(x.id) === id)
    setArrival((p) => ({
      ...p,
      tanker_id: id,
      tanker_no: t?.tanker_no || p.tanker_no,
      oil_type_id: t ? String(t.oil_type_id) : '',
      uom: t?.uom || 'MT',
      dispatch_qty: t?.loaded_qty ? String(t.loaded_qty) : p.dispatch_qty
    }))
  }

  // Step 1 — the guard records the tanker coming in; weight comes later.
  async function recordArrival(): Promise<void> {
    if (!String(arrival.tanker_no || '').trim()) {
      toast.error('Select the tanker (or type its number)')
      return
    }
    setSavingArrival(true)
    try {
      await window.api.gate.create({
        ...arrival,
        tanker_id: arrival.tanker_id ? Number(arrival.tanker_id) : null,
        oil_type_id: arrival.oil_type_id ? Number(arrival.oil_type_id) : null,
        dispatch_qty: Number(arrival.dispatch_qty) || 0,
        received_qty: 0,
        status: 'pending'
      })
      toast.success(`Tanker ${arrival.tanker_no} received — waiting for weight`)
      setArrival(blankArrival())
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingArrival(false)
    }
  }

  // Step 2 — weight arrives from the weighbridge; entry is completed.
  async function saveWeight(row: Row): Promise<void> {
    const qty = Number(weights[row.id] || 0)
    if (qty <= 0) {
      toast.error('Enter the weight first')
      return
    }
    try {
      await window.api.gate.complete(row.id, qty)
      toast.success(`Tanker ${row.tanker_no} completed — ${formatNum(qty)} ${row.uom}`)
      setWeights((p) => ({ ...p, [row.id]: '' }))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openEdit(row: Row): void {
    setEditRow(row)
    setEditForm({
      gate_entry_no: row.gate_entry_no,
      entry_date: row.entry_date,
      tanker_id: row.tanker_id ? String(row.tanker_id) : '',
      tanker_no: row.tanker_no || '',
      oil_type_id: row.oil_type_id ? String(row.oil_type_id) : '',
      dispatch_qty: row.dispatch_qty ?? '',
      received_qty: row.received_qty ?? '',
      uom: row.uom || 'MT',
      note: row.note || ''
    })
  }

  async function saveEdit(): Promise<void> {
    if (!editRow) return
    try {
      await window.api.gate.update(editRow.id, {
        ...editForm,
        tanker_id: editForm.tanker_id ? Number(editForm.tanker_id) : null,
        oil_type_id: editForm.oil_type_id ? Number(editForm.oil_type_id) : null,
        dispatch_qty: Number(editForm.dispatch_qty) || 0,
        received_qty: Number(editForm.received_qty) || 0
      })
      toast.success('Gate entry updated')
      setEditRow(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove(row: Row): Promise<void> {
    if (!window.confirm(`Delete gate entry ${row.gate_entry_no}?`)) return
    try {
      await window.api.gate.remove(row.id)
      toast.success('Gate entry deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title="Gate Entry"
        subtitle="Step 1: record the tanker coming in · Step 2: enter the weight to complete"
        hint="Made for the gate: record the arrival the moment a tanker comes in (no weight needed). It waits under 'Waiting for weighment' until the weighbridge figure is entered, which completes the entry. The Empty step in Purchases checks against this weight."
      />
      <div className="w-full space-y-4 p-6">
        {/* Step 1 — arrival */}
        <section className="rounded-xl border border-emerald-200 bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
              <Truck className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">1 · Tanker arrived at gate</h3>
              <p className="text-xs text-muted-foreground">Pick the tanker and press the green button. Weight comes later.</p>
            </div>
          </div>
          <div className="grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="grid min-w-0 gap-1.5">
              <Label>Tanker *</Label>
              <Select value={String(arrival.tanker_id || '')} onValueChange={chooseTanker}>
                <SelectTrigger><SelectValue placeholder="Select arriving tanker" /></SelectTrigger>
                <SelectContent>
                  {arrivable.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.tanker_no} · {t.supplier_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Tanker number *</Label>
              <Input value={arrival.tanker_no || ''} onChange={(e) => setArrival((p) => ({ ...p, tanker_no: e.target.value }))} />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Gate entry no</Label>
              <Input value={arrival.gate_entry_no || ''} onChange={(e) => setArrival((p) => ({ ...p, gate_entry_no: e.target.value }))} />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>Date</Label>
              <DatePicker value={arrival.entry_date || ''} onChange={(v) => setArrival((p) => ({ ...p, entry_date: v }))} />
            </div>
            <Button
              className="h-9 bg-emerald-600 px-5 font-semibold hover:bg-emerald-700"
              onClick={recordArrival}
              disabled={savingArrival}
            >
              <Truck className="h-4 w-4" />
              {savingArrival ? 'Saving…' : 'Tanker received'}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Not in the list? Type the tanker number manually and press the button.
          </p>
        </section>

        {/* Step 2 — waiting for weighment */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-100 text-amber-700">
              <Scale className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">2 · Waiting for weighment</h3>
              <p className="text-xs text-muted-foreground">Enter the weighbridge figure to complete the entry.</p>
            </div>
            <Badge variant={pending.length ? 'warning' : 'muted'} className="ml-1">{pending.length}</Badge>
          </div>
          {pending.length === 0 ? (
            <div className="rounded-xl border border-dashed py-5 text-center text-sm text-muted-foreground">
              No tankers waiting for weight.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {pending.map((row) => (
                <div key={row.id} className="rounded-lg border border-amber-200 bg-card p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{row.tanker_no}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {row.supplier_name || '—'}{row.bargain_no ? ` · ${row.bargain_no}` : ''}
                      </div>
                    </div>
                    <Badge variant="warning">Pending</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {row.gate_entry_no} · arrived {formatDate(row.entry_date)}
                    {Number(row.dispatch_qty) > 0 && <> · dispatch {formatNum(row.dispatch_qty)} {row.uom}</>}
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <Input
                      type="number"
                      className="flex-1"
                      placeholder={`Weight (${row.uom})`}
                      value={weights[row.id] ?? ''}
                      onChange={(e) => setWeights((p) => ({ ...p, [row.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && saveWeight(row)}
                    />
                    <Button size="sm" className="h-9" onClick={() => saveWeight(row)}>
                      <Scale className="h-4 w-4" /> Save
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* History */}
        <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold">Gate register</div>
          <Table className="text-[13px]">
            <TableHeader><TableRow>
              <TableHead>Gate entry no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Tanker</TableHead>
              <TableHead className="text-right">Dispatch qty</TableHead>
              <TableHead className="text-right">Received qty</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No gate entries yet.</TableCell></TableRow>
              ) : (
                rows.map((row) => {
                  const done = row.status !== 'pending'
                  const diff = Number(row.dispatch_qty || 0) - Number(row.received_qty || 0)
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.gate_entry_no}</TableCell>
                      <TableCell>{formatDate(row.entry_date)}</TableCell>
                      <TableCell>
                        <div>{row.tanker_no}</div>
                        {row.supplier_name && <div className="text-xs text-muted-foreground">{row.supplier_name}{row.bargain_no ? ` · ${row.bargain_no}` : ''}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNum(row.dispatch_qty)} {row.uom}</TableCell>
                      <TableCell className="text-right tabular-nums">{done ? <>{formatNum(row.received_qty)} {row.uom}</> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {!done ? <span className="text-muted-foreground">—</span> : Math.abs(diff) < 0.0005 ? <Badge variant="muted">0</Badge> : <span className={diff > 0 ? 'text-amber-700' : 'text-emerald-700'}>{formatNum(diff)} {row.uom}</span>}
                      </TableCell>
                      <TableCell>{done ? <Badge variant="success">Completed</Badge> : <Badge variant="warning">Pending weight</Badge>}</TableCell>
                      <TableCell><div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => remove(row)}><Trash2 className="h-4 w-4" /></Button>
                      </div></TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </section>
      </div>

      {/* Correction dialog (office use) */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit {editRow?.gate_entry_no}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Gate entry no *</Label><Input value={editForm.gate_entry_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, gate_entry_no: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Date *</Label><DatePicker value={editForm.entry_date || ''} onChange={(v) => setEditForm((p) => ({ ...p, entry_date: v }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Tanker no *</Label><Input value={editForm.tanker_no || ''} onChange={(e) => setEditForm((p) => ({ ...p, tanker_no: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>UOM</Label><Input value={editForm.uom || ''} onChange={(e) => setEditForm((p) => ({ ...p, uom: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Dispatch qty</Label><Input type="number" value={editForm.dispatch_qty ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, dispatch_qty: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Received qty</Label><Input type="number" value={editForm.received_qty ?? ''} onChange={(e) => setEditForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            <div className="grid gap-1.5"><Label>Note</Label><Input value={editForm.note || ''} onChange={(e) => setEditForm((p) => ({ ...p, note: e.target.value }))} /></div>
            <p className="text-xs text-muted-foreground">Leaving Received qty empty keeps the entry pending; entering it completes the entry.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
