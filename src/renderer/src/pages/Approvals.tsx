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
import { Pagination, usePaged } from '@/components/Pagination'

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
  packagings: 'Packed SKU',
  // Three that were brought under approval later — without these the queue
  // would print the raw table name at the desk of whoever has to decide it.
  categories: 'Category',
  banks: 'Bank account',
  nbfcs: 'NBFC'
}
const labelFor = (t: string): string => TABLE_LABEL[t] || t

/**
 * HOW LONG SOMEBODY HAS BEEN WAITING.
 *
 * A queue of five is not the same as a queue of five where one has sat since
 * Tuesday, and the difference is the whole reason to look at the page today.
 * Said in days, because that is the unit that matters: an hour old is fine,
 * three days old is somebody blocked.
 */
function waitedFor(at: unknown): { days: number; text: string } {
  const t = Date.parse(String(at || '').replace(' ', 'T'))
  if (!Number.isFinite(t)) return { days: 0, text: '' }
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days <= 0) return { days: 0, text: 'today' }
  if (days === 1) return { days, text: 'since yesterday' }
  return { days, text: `${days} days waiting` }
}

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
  transit_days: 'Transit days', brokerage_pct: 'Brokerage %', brokerage_rate: 'Brokerage ₹ / MT',
  contact_person: 'Contact person',
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
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
  const pendingPaged = usePaged(pending)
  const decidedPaged = usePaged(decided)
  // WHAT THE QUEUE IS MADE OF.
  //
  // A flat list of fourteen is read one row at a time; the same fourteen
  // grouped is "four suppliers, two brokers, the rest products", which is a
  // thing an admin can clear in three decisions instead of fourteen.
  const byType = ((): { table: string; rows: Row[] }[] => {
    const m = new Map<string, Row[]>()
    for (const r of pendingPaged.pageRows) {
      const k = String(r.table_name)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    return [...m.entries()]
      .map(([table, list]) => ({ table, rows: list }))
      .sort((a, b) => b.rows.length - a.rows.length || labelFor(a.table).localeCompare(labelFor(b.table)))
  })()
  const oldest = pending.reduce((worst, r) => Math.max(worst, waitedFor(r.requested_at).days), 0)
  const approvedCount = decided.filter((r) => r.status === 'approved').length
  const rejectedCount = decided.filter((r) => r.status === 'rejected').length

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
        {/* WHAT THE PAGE AMOUNTS TO, BEFORE ANY OF THE ROWS.
            Four figures, and the one that decides whether to open this today is
            the fourth: a queue of five is not a queue of five where one has sat
            since Tuesday. */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[
            { k: 'Waiting on you', v: String(pending.length), fg: pending.length ? '#8A5300' : '#5A6B62', bg: pending.length ? '#FFF9EC' : '#F7FAF6', bd: pending.length ? '#F0E4CB' : '#DCE7DB' },
            { k: 'Longest wait', v: oldest > 0 ? `${oldest}d` : '—', fg: oldest >= 3 ? '#8C2F26' : '#5A6B62', bg: oldest >= 3 ? '#FDF3F2' : '#F7FAF6', bd: oldest >= 3 ? '#F0D6D4' : '#DCE7DB' },
            { k: 'Let through', v: String(approvedCount), fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB' },
            { k: 'Turned down', v: String(rejectedCount), fg: '#5A6B62', bg: '#F7FAF6', bd: '#DCE7DB' }
          ].map((c) => (
            <div key={c.k} className="rounded-[4px] border px-3.5 py-2.5" style={{ background: c.bg, borderColor: c.bd }}>
              <div className="text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">{c.k}</div>
              <div className="mt-0.5 text-[21px] font-extrabold tabular-nums" style={{ color: c.fg }}>{c.v}</div>
            </div>
          ))}
        </div>

        {/* Pending, grouped by what it is */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">Waiting</h3>
            <Badge variant={pending.length ? 'warning' : 'muted'}>{pending.length}</Badge>
            {byType.length > 1 && (
              <span className="text-[11.5px] font-medium text-muted-foreground">
                {byType.map((g) => `${g.rows.length} ${labelFor(g.table).toLowerCase()}`).join(' · ')}
              </span>
            )}
          </div>

          {loading ? (
            <div className="rounded-lg border bg-card py-10 text-center text-muted-foreground">Loading…</div>
          ) : pending.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card py-12 text-center">
              <div className="text-[13px] font-semibold text-[#0B6B45]">Nothing is waiting.</div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                A master added by anyone but an admin lands here, and stays off every list until it is let through.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {byType.map((g) => (
                <div key={g.table} className="overflow-hidden rounded-lg border bg-card">
                  {/* One heading a kind, so four suppliers read as four
                      suppliers rather than as four of fourteen rows. */}
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
                    <span className="text-[11px] font-extrabold uppercase tracking-[.09em] text-[#33473E]">
                      {labelFor(g.table)}
                    </span>
                    <Badge variant="secondary">{g.rows.length}</Badge>
                  </div>
                  {g.rows.map((row) => {
                    const waited = waitedFor(row.requested_at)
                    return (
                      <div
                        key={row.id}
                        className="flex flex-wrap items-start gap-3 border-b px-3 py-2.5 last:border-b-0"
                      >
                        <div className="min-w-[200px] flex-1">
                          <div className="text-[13px] font-semibold text-foreground">{row.label || '—'}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
                            <span>{row.requested_by_name || 'somebody'}</span>
                            <span>·</span>
                            <span>{formatDateTime(row.requested_at)}</span>
                            {/* Three days is where a wait stops being a wait
                                and starts being somebody blocked. */}
                            {waited.days >= 3 && (
                              <span className="rounded-[2px] bg-[#FDF3F2] px-1.5 py-[1px] text-[10.5px] font-extrabold text-[#8C2F26]">
                                {waited.text}
                              </span>
                            )}
                          </div>
                          <PayloadChips payload={row.payload} />
                        </div>
                        {isAdmin && (
                          <div className="flex flex-none items-center gap-1.5">
                            {/* Words, not bare icons. Turning somebody's work
                                down is not a thing to do by hitting an
                                unlabelled cross. */}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                              disabled={busy === row.id}
                              onClick={() => approve(row)}
                            >
                              <Check className="h-3.5 w-3.5" /> Let through
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-red-200 text-destructive hover:bg-red-50"
                              disabled={busy === row.id}
                              onClick={() => { setRejectRow(row); setReason('') }}
                            >
                              <X className="h-3.5 w-3.5" /> Turn down
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
              <Pagination {...pendingPaged} label="requests" className="px-1" />
            </div>
          )}
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
                  decidedPaged.pageRows.map((row) => (
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
            <Pagination {...decidedPaged} label="decisions" className="border-t px-3" />
          </div>
        </section>
      </div>

      {/* Reject reason */}
      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) { setRejectRow(null); setReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectRow ? labelFor(rejectRow.table_name) : ''} “{rejectRow?.label || ''}”</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
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
