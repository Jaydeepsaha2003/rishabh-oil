import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// What the audit trail was asked for. `entity` may be several names because a
// module that later gained a friendly label has history under both spellings.
export type HistoryTarget = {
  entity: string | string[]
  id?: number | null
  key?: string | null
  // Only for rows written before the record key existed — see entityHistory.
  detail?: string | null
  // Shown in the dialog's title and subtitle.
  title: string
  subtitle?: string
}

// The trail stores whatever verb the channel had at the time, so older rows
// carry the raw channel word. Mapped here as well as at the point of writing,
// so history recorded before those words were named still reads as English.
const LABEL: Record<string, string> = {
  preclose: 'Preclosed',
  unpreclose: 'Undid preclosure',
  saveLimit: 'Changed the facility limit',
  upfrontInterest: 'Posted upfront interest',
  repay: 'Repaid',
  advance: 'Advanced a stage',
  issue: 'Issued a bill',
  deleteIssuance: 'Removed a bill',
  paymentIn: 'Logged a payment in',
  createInvoice: 'Created',
  updateInvoice: 'Updated',
  deleteInvoice: 'Deleted',
  rejectInvoice: 'Rejected',
  unrejectInvoice: 'Un-rejected',
  setInvoiceStage: 'Moved the dispatch stage',
  setStage: 'Moved the dispatch stage',
  markReceived: 'Marked payment received',
  unmarkReceived: 'Undid payment received',
  deleteRepayment: 'Removed a repayment',
  reopen: 'Reopened',
  cancelDelivery: 'Cancelled the delivery'
}

const TONE: Record<string, 'default' | 'muted' | 'success' | 'warning' | 'destructive'> = {
  Created: 'success',
  Updated: 'default',
  Deleted: 'destructive',
  Rejected: 'destructive',
  Repaid: 'success',
  Preclosed: 'warning',
  'Undid preclosure': 'warning',
  'Marked payment received': 'success',
  'Undid payment received': 'warning',
  'Cancelled the delivery': 'destructive'
}

function label(action: unknown): string {
  const a = String(action || '')
  return LABEL[a] || a || 'Changed'
}

// Timestamps are stored as 'YYYY-MM-DD HH:MM:SS'.
function when(ts: unknown): { date: string; time: string } {
  const s = String(ts || '')
  return { date: `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`, time: s.slice(11, 16) }
}

// Who did what to one record, straight off the audit trail — so it is the
// record of what happened rather than a second copy of it that could disagree.
// Oldest first, so the story reads forwards.
//
// One component for every module: the trail has the same shape whatever wrote
// it, and four near-identical dialogs would drift apart.
export function HistoryDialog({
  target,
  onClose
}: {
  target: HistoryTarget | null
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null)

  const load = useCallback(async (t: HistoryTarget) => {
    setRows(null)
    try {
      setRows(
        await window.api.access.entityHistory(t.entity, { id: t.id, key: t.key, detail: t.detail })
      )
    } catch (e) {
      toast.error((e as Error).message)
      setRows([])
    }
  }, [])

  useEffect(() => {
    if (target) void load(target)
  }, [target, load])

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto border-[#d9d2b8] bg-[#fffdf4]">
        <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
          <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
            History — {target?.title || 'record'}
          </DialogTitle>
        </DialogHeader>
        {target && (
          <div className="grid gap-3">
            {target.subtitle && (
              <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{target.subtitle}</div>
            )}
            {rows === null ? (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#d9d2b8] px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing recorded against this record yet. Changes made before the trail started keeping the
                record it belonged to will not appear here.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-[#e5dfc8]">
                <Table className="text-[13px]">
                  <TableHeader>
                    <TableRow className="bg-[#f7f4e8] hover:bg-[#f7f4e8]">
                      <TableHead className="h-8 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        When
                      </TableHead>
                      <TableHead className="h-8 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        Who
                      </TableHead>
                      <TableHead className="h-8 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        Did what
                      </TableHead>
                      <TableHead className="h-8 text-[10px] font-bold uppercase tracking-widest text-[#1a2c56]">
                        Details
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((h) => {
                      const t = when(h.created_at)
                      const verb = label(h.action)
                      return (
                        <TableRow key={String(h.id)} className="hover:bg-amber-50/60">
                          <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                            {t.date}
                            <span className="ml-1 text-[11px]">{t.time}</span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-medium">
                            {h.username || 'Unknown'}
                            {h.ip ? <div className="text-[10px] font-normal text-muted-foreground">{h.ip}</div> : null}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <Badge variant={TONE[verb] || 'muted'}>{verb}</Badge>
                          </TableCell>
                          <TableCell className="text-[12px] text-muted-foreground">{h.detail || '—'}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {!!rows?.length && (
              <div className="text-[11px] text-muted-foreground">
                {rows.length} event{rows.length === 1 ? '' : 's'}, oldest first.
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Saves every page repeating the same two pieces of state.
export function useHistoryDialog(): {
  target: HistoryTarget | null
  open: (t: HistoryTarget) => void
  close: () => void
} {
  const [target, setTarget] = useState<HistoryTarget | null>(null)
  return { target, open: setTarget, close: () => setTarget(null) }
}
