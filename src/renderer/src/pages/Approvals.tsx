import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Clock, X } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, errText, todayISO } from '@/lib/format'
import { loadUser } from '@/lib/session'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Friendly names for the master tables.
const TABLE_LABEL: Record<string, string> = {
  oil_types: 'Oil type',
  products: 'Product',
  suppliers: 'Supplier',
  transporters: 'Transporter',
  customers: 'Customer',
  sources: 'Port',
  uoms: 'UOM',
  brokers: 'Broker',
  packagings: 'Packed SKU'
}
const labelFor = (t: string): string => TABLE_LABEL[t] || t

function statusBadge(status: string): React.JSX.Element {
  if (status === 'approved') return <Badge variant="success">Approved</Badge>
  if (status === 'rejected') return <Badge variant="destructive">Rejected</Badge>
  return <Badge variant="warning">On hold</Badge>
}

// Friendly labels for the master fields shown in an approval request.
const FIELD_LABEL: Record<string, string> = {
  name: 'Name', code: 'Code', company_type: 'Company type', supplier_type: 'Supplier type',
  gstin: 'GSTIN', state: 'State', gst_pct: 'GST %', tds_pct: 'TDS %', tds_threshold: 'TDS threshold',
  tds_pct_above: 'TDS % above', tds_above_only: 'TDS above only', credit_period_days: 'Credit days',
  adds_interest: 'Adds interest', interest_pct: 'Interest %', interest_days: 'Interest days',
  opening_purchase_amount: 'Opening purchase', opening_purchase_date: 'Opening date',
  transit_days: 'Transit days', brokerage_pct: 'Brokerage %', contact_person: 'Contact person',
  phone: 'Phone', contact: 'Contact', address: 'Address', note: 'Note',
  box_label: 'Case label', pouch_label: 'Pack type', pouches_per_box: 'Per case',
  unit_size: 'Unit size', unit_uom: 'Unit UOM', base_per_pouch: 'Base / unit', base_uom: 'Base unit',
  default_rate_per_ton: 'Default rate/ton', category: 'Category'
}
function humanizeKey(k: string): string {
  return FIELD_LABEL[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Meaningful entered fields (drops empty/zero/false and internal flags), nicely
// labelled — so an admin can read exactly what was submitted at a glance.
function detailEntries(payload: string): [string, string][] {
  try {
    const o = JSON.parse(payload) as Row
    return Object.entries(o)
      .filter(([k, v]) => k !== 'active' && k !== 'name' && k !== 'code' && v !== '' && v != null && v !== false && Number(v) !== 0)
      .map(([k, v]) => [humanizeKey(k), String(v)] as [string, string])
  } catch {
    return []
  }
}

// A wrapping set of labelled chips describing the submitted master.
function PayloadChips({ payload }: { payload: string }): React.JSX.Element | null {
  const entries = detailEntries(payload)
  if (entries.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {entries.map(([label, value]) => (
        <span key={label} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px]">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium text-foreground">{value}</span>
        </span>
      ))}
    </div>
  )
}

export function Approvals(): React.JSX.Element {
  const user = loadUser()
  const isAdmin = user?.role === 'admin'
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [rejectRow, setRejectRow] = useState<Row | null>(null)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(isAdmin ? await window.api.approvals.list() : await window.api.approvals.mine())
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  async function approve(row: Row): Promise<void> {
    setBusy(row.id)
    try {
      await window.api.approvals.approve(row.id)
      toast.success(`${labelFor(row.table_name)} “${row.label || ''}” approved`)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  async function doReject(): Promise<void> {
    if (!rejectRow) return
    if (!reason.trim()) return void toast.error('Enter a reason')
    setBusy(rejectRow.id)
    try {
      await window.api.approvals.reject(rejectRow.id, reason.trim())
      toast.success('Request rejected')
      setRejectRow(null)
      setReason('')
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const pending = rows.filter((r) => r.status === 'pending')
  const decided = rows.filter((r) => r.status !== 'pending')

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={isAdmin ? 'Review master-list creations submitted by users' : 'Your submitted master-list creations and their status'}
        hint={isAdmin
          ? 'When a non-admin adds a master (Products, Customers, Suppliers, Ports, etc.) it is held here until you approve (adds it to the database) or reject with a reason (shown back to the user).'
          : 'Masters you add are held for admin approval. Approved items appear in their normal list; rejected ones show the reason here.'}
        actions={
          <ExcelButton
            filename={`approvals-${todayISO()}`}
            sheetName="Approvals"
            title="Approval requests"
            columns={[
              { header: 'Type', key: 'table_name', value: (r) => labelFor(r.table_name) },
              { header: 'Item', key: 'label', value: (r) => r.label || '' },
              { header: 'Requested by', key: 'requested_by_name', value: (r) => r.requested_by_name || '' },
              { header: 'Requested at', key: 'requested_at', value: (r) => formatDateTime(r.requested_at) },
              { header: 'Status', key: 'status', value: (r) => r.status || '' },
              { header: 'Decided by', key: 'decided_by_name', value: (r) => r.decided_by_name || '' },
              { header: 'Decided at', key: 'decided_at', value: (r) => (r.decided_at ? formatDateTime(r.decided_at) : '') },
              { header: 'Reason', key: 'reason', value: (r) => r.reason || '' }
            ]}
            rows={rows}
          />
        }
      />
      <div className="w-full space-y-4 p-5">
        {/* Pending */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">On hold</h3>
            <Badge variant={pending.length ? 'warning' : 'muted'}>{pending.length}</Badge>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table className="min-w-[640px] text-[13px] [&_td]:py-2 [&_th]:h-9">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Type</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="w-[150px]">Requested by</TableHead>
                  <TableHead className="w-[110px]">When</TableHead>
                  {isAdmin && <TableHead className="w-[110px] text-right">Decision</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={isAdmin ? 5 : 4} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : pending.length === 0 ? (
                  <TableRow><TableCell colSpan={isAdmin ? 5 : 4} className="py-10 text-center text-muted-foreground">Nothing waiting for approval.</TableCell></TableRow>
                ) : (
                  pending.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell><Badge variant="secondary">{labelFor(row.table_name)}</Badge></TableCell>
                      <TableCell>
                        <div className="font-medium">{row.label || '—'}</div>
                        <PayloadChips payload={row.payload} />
                      </TableCell>
                      <TableCell>{row.requested_by_name || '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.requested_at)}</TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-600 hover:bg-emerald-50" title="Approve" disabled={busy === row.id} onClick={() => approve(row)}>
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:bg-red-50" title="Reject" disabled={busy === row.id} onClick={() => { setRejectRow(row); setReason('') }}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        {/* Decided history */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Recently decided</h3>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table className="min-w-[640px] text-[13px] [&_td]:py-2 [&_th]:h-9">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Type</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                  <TableHead>Reason (if rejected)</TableHead>
                  {isAdmin && <TableHead className="w-[150px]">Requested by</TableHead>}
                  <TableHead className="w-[110px]">Decided</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {decided.length === 0 ? (
                  <TableRow><TableCell colSpan={isAdmin ? 6 : 5} className="py-8 text-center text-muted-foreground">No decisions yet.</TableCell></TableRow>
                ) : (
                  decided.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell><Badge variant="secondary">{labelFor(row.table_name)}</Badge></TableCell>
                      <TableCell className="font-medium">{row.label || '—'}</TableCell>
                      <TableCell>{statusBadge(row.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.status === 'rejected' ? (row.reason || '—') : '—'}</TableCell>
                      {isAdmin && <TableCell>{row.requested_by_name || '—'}</TableCell>}
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.decided_at)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>

      {/* Reject reason */}
      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) { setRejectRow(null); setReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectRow ? labelFor(rejectRow.table_name) : ''} “{rejectRow?.label || ''}”</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>Reason *</Label>
            <textarea
              className="min-h-[90px] rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              placeholder="Why is this being rejected? The requester will see this."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectRow(null); setReason('') }}>Cancel</Button>
            <Button variant="destructive" onClick={doReject} disabled={busy === rejectRow?.id}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
