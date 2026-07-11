import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
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

const empty = (): Row => ({ entry_date: todayISO(), dispatch_qty: '', received_qty: '', uom: 'ton' })

export function GateEntry(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [tankers, setTankers] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(empty())
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [g, pt] = await Promise.all([window.api.gate.list(), window.api.tankers.list()])
    setRows(g)
    setTankers(pt)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Tankers that are en route / arriving (not yet emptied) are the candidates.
  const openTankers = useMemo(
    () => tankers.filter((t) => t.status !== 'empty'),
    [tankers]
  )

  async function openNew(): Promise<void> {
    const next = await window.api.gate.nextNo().catch(() => '')
    setEditing(null)
    setForm({ ...empty(), gate_entry_no: next })
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      gate_entry_no: row.gate_entry_no,
      entry_date: row.entry_date,
      tanker_id: row.tanker_id ? String(row.tanker_id) : '',
      tanker_no: row.tanker_no || '',
      oil_type_id: row.oil_type_id ? String(row.oil_type_id) : '',
      dispatch_qty: row.dispatch_qty ?? '',
      received_qty: row.received_qty ?? '',
      uom: row.uom || 'ton',
      note: row.note || ''
    })
    setOpen(true)
  }

  function chooseTanker(id: string): void {
    const t = tankers.find((x) => String(x.id) === id)
    setForm((p) => ({
      ...p,
      tanker_id: id,
      tanker_no: t?.tanker_no || p.tanker_no,
      oil_type_id: t ? String(t.oil_type_id) : p.oil_type_id,
      uom: t?.uom || p.uom,
      dispatch_qty: p.dispatch_qty || (t?.loaded_qty ? String(t.loaded_qty) : '')
    }))
  }

  async function save(): Promise<void> {
    if (!String(form.gate_entry_no || '').trim()) {
      toast.error('Gate entry number is required')
      return
    }
    if (!String(form.tanker_no || '').trim()) {
      toast.error('Tanker number is required')
      return
    }
    if (Number(form.received_qty) <= 0) {
      toast.error('Enter the received quantity')
      return
    }
    setSaving(true)
    const payload: Row = {
      ...form,
      tanker_id: form.tanker_id ? Number(form.tanker_id) : null,
      oil_type_id: form.oil_type_id ? Number(form.oil_type_id) : null,
      dispatch_qty: Number(form.dispatch_qty) || 0,
      received_qty: Number(form.received_qty) || 0
    }
    try {
      if (editing) {
        await window.api.gate.update(editing.id, payload)
        toast.success('Gate entry updated')
      } else {
        await window.api.gate.create(payload)
        toast.success('Gate entry recorded')
      }
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
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
        subtitle="Receipt entry recorded at the factory gate for arriving tankers"
        hint="The gateman records each arriving tanker: gate entry no, tanker no, oil type, dispatch qty and received (weighed) qty. At the Empty stage the authorised person's received qty must match the gate received qty for that tanker."
        actions={<Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> New gate entry</Button>}
      />
      <div className="p-8">
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Gate entry no</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Tanker</TableHead>
              <TableHead>Oil type</TableHead>
              <TableHead className="text-right">Dispatch qty</TableHead>
              <TableHead className="text-right">Received qty</TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No gate entries yet.</TableCell></TableRow>
              ) : (
                rows.map((row) => {
                  const diff = Number(row.dispatch_qty || 0) - Number(row.received_qty || 0)
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.gate_entry_no}</TableCell>
                      <TableCell>{formatDate(row.entry_date)}</TableCell>
                      <TableCell>
                        <div>{row.tanker_no}</div>
                        {row.supplier_name && <div className="text-xs text-muted-foreground">{row.supplier_name}{row.bargain_no ? ` · ${row.bargain_no}` : ''}</div>}
                      </TableCell>
                      <TableCell>{row.oil_code || row.oil_name || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNum(row.dispatch_qty)} {row.uom}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNum(row.received_qty)} {row.uom}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Math.abs(diff) < 0.0005 ? <Badge variant="muted">0</Badge> : <span className={diff > 0 ? 'text-amber-700' : 'text-emerald-700'}>{formatNum(diff)} {row.uom}</span>}
                      </TableCell>
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
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? `Edit ${editing.gate_entry_no}` : 'New gate entry'}</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Gate entry no *</Label><Input value={form.gate_entry_no || ''} onChange={(e) => setForm((p) => ({ ...p, gate_entry_no: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Date *</Label><DatePicker value={form.entry_date || ''} onChange={(v) => setForm((p) => ({ ...p, entry_date: v }))} /></div>
            </div>
            <div className="grid gap-1.5">
              <Label>Tanker</Label>
              <Select value={String(form.tanker_id || '')} onValueChange={chooseTanker}>
                <SelectTrigger><SelectValue placeholder="Select arriving tanker" /></SelectTrigger>
                <SelectContent>
                  {openTankers.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.tanker_no} · {t.oil_code || t.oil_name} · {t.supplier_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Linking the tanker enables the empty-stage quantity check.</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Tanker no *</Label><Input value={form.tanker_no || ''} onChange={(e) => setForm((p) => ({ ...p, tanker_no: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>UOM</Label><Input value={form.uom || ''} onChange={(e) => setForm((p) => ({ ...p, uom: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label>Dispatch qty</Label><Input type="number" value={form.dispatch_qty ?? ''} onChange={(e) => setForm((p) => ({ ...p, dispatch_qty: e.target.value }))} /></div>
              <div className="grid gap-1.5"><Label>Received qty *</Label><Input type="number" value={form.received_qty ?? ''} onChange={(e) => setForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            <div className="grid gap-1.5"><Label>Note</Label><Input value={form.note || ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
