import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link2, Loader2, Undo2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

type Row = Record<string, unknown>
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const today = (): string => new Date().toISOString().slice(0, 10)

// REFUND RECEIVED — the bank gives back what a repayment paid over the balance.
//
// Either the refund is already in the books (booked from Tally or by hand,
// credited to a holding ledger) and is LINKED — its credit moves onto the
// lender's refund-due ledger — or it is RECORDED here as a receipt. Each can be
// taken back.
export function RefundReceived({
  kind,
  id,
  open,
  onClose,
  onChanged
}: {
  kind: 'bd' | 'lc'
  id: number | null
  open: boolean
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const api = kind === 'bd' ? window.api.billDiscounting : window.api.lc
  const [info, setInfo] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  const [form, setForm] = useState({ date: today(), amount: '', bank: '' })

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await api.refundInfo(id)
      setInfo(r)
      const cands = (r.candidates as Row[]) || []
      setPick(cands.find((c) => c.exact) ? n(cands.find((c) => c.exact)!.id) : null)
      setForm({ date: today(), amount: n(r.due) > 0 ? String(n(r.due)) : '', bank: String(r.bank || '') })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [api, id])
  useEffect(() => {
    if (open) void load()
    else setInfo(null)
  }, [open, load])

  async function run(work: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true)
    try {
      await work()
      toast.success(ok)
      onChanged?.()
      await load()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const cands = ((info?.candidates as Row[]) || [])
  const done = ((info?.refunds as Row[]) || [])
  const due = n(info?.due)
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Refund received{info ? ` — ${kind === 'bd' ? 'bill' : 'LC'} ${String(info.label || '')}` : ''}</DialogTitle>
          <DialogDescription>
            The repayment paid {String(info?.lender || 'the bank')} more than was owed. That excess sits on{' '}
            <b>{String(info?.ledger || 'its refund-due ledger')}</b> until the refund comes back.
          </DialogDescription>
        </DialogHeader>
        {!info ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ['Paid over', n(info.booked)],
                ['Refunded', n(info.refunded)],
                ['Still due', due]
              ].map(([k, v]) => (
                <div key={String(k)} className={cn('rounded-[4px] border px-3 py-2', k === 'Still due' && due > 0 ? 'border-[#F0D9AE] bg-[#FFFBF2]' : 'border-[#D6E2D6] bg-[#F7FAF6]')}>
                  <div className="text-[10.5px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">{String(k)}</div>
                  <div className="text-[15px] font-extrabold tabular-nums">{formatINR(Number(v))}</div>
                </div>
              ))}
            </div>

            {done.length > 0 && (
              <div className="grid gap-1.5">
                <Label className="text-[11px]">Refunds so far</Label>
                {done.map((r) => (
                  <div key={String(r.id)} className="flex items-center gap-3 rounded-[4px] border border-[#D6E2D6] px-3 py-2 text-[12.5px]">
                    <span className="font-bold">{String(r.code || '—')}</span>
                    <span className="text-muted-foreground">{formatDate(String(r.date))}</span>
                    <span className="text-muted-foreground">{String(r.how) === 'linked' ? 'linked receipt' : 'recorded here'}</span>
                    <span className="ml-auto font-bold tabular-nums">{formatINR(n(r.amount))}</span>
                    <button
                      type="button"
                      disabled={busy}
                      title={String(r.how) === 'linked' ? 'Unlink — the receipt goes back to the ledger it was on' : 'Remove this refund receipt'}
                      onClick={() => void run(() => api.refundUndo(n(r.id)), 'Refund taken back')}
                      className="flex h-7 items-center gap-1 rounded px-2 text-[11.5px] font-bold text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                  </div>
                ))}
              </div>
            )}

            {due > 0.004 && (
              <>
                <div className="grid gap-1.5">
                  <Label className="text-[11px]">Already in the books? Pick the bank receipt that is the refund</Label>
                  {cands.length === 0 ? (
                    <p className="rounded-[4px] border border-dashed px-3 py-3 text-[12px] text-muted-foreground">
                      No receipt into a bank since {formatDate(String(info.since))} for {formatINR(due)} or less. Record it below instead.
                    </p>
                  ) : (
                    <div className="max-h-[220px] overflow-auto rounded-[4px] border border-[#D6E2D6]">
                      {cands.map((c) => (
                        <label
                          key={String(c.id)}
                          className={cn('flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-[12.5px] last:border-b-0', pick === n(c.id) && 'bg-[#F4FBF6]')}
                        >
                          <input type="radio" name="refund-pick" checked={pick === n(c.id)} onChange={() => setPick(n(c.id))} />
                          <span className="w-[86px] font-bold">{String(c.code || '—')}</span>
                          <span className="w-[80px] text-muted-foreground">{formatDate(String(c.date))}</span>
                          <span className="min-w-0 flex-1 truncate" title={String(c.narration || '')}>
                            into {String(c.bank)} · from {String(c.from_ledger)}
                          </span>
                          <span className={cn('font-bold tabular-nums', !!c.exact && 'text-[#0B6B45]')}>{formatINR(n(c.amount))}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <Button className="w-fit gap-1.5" disabled={busy || !pick} onClick={() => void run(() => api.refundLink(id!, pick!), 'Receipt linked as the refund')}>
                    <Link2 className="h-4 w-4" /> Link this receipt
                  </Button>
                </div>

                <div className="grid gap-1.5 border-t pt-3">
                  <Label className="text-[11px]">Not in the books yet? Record the refund</Label>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="grid gap-1">
                      <span className="text-[10.5px] font-bold text-muted-foreground">Date</span>
                      <Input type="date" className="h-9 w-[150px]" value={form.date} min={String(info.since || '')} max={today()} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} />
                    </div>
                    <div className="grid min-w-[240px] flex-1 gap-1">
                      <span className="text-[10.5px] font-bold text-muted-foreground">Into bank</span>
                      <Select value={form.bank} onValueChange={(v) => setForm((p) => ({ ...p, bank: v }))}>
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Pick the bank" />
                        </SelectTrigger>
                        <SelectContent>
                          {((info.banks as string[]) || []).map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1">
                      <span className="text-[10.5px] font-bold text-muted-foreground">Amount</span>
                      <Input
                        inputMode="decimal"
                        className="h-9 w-[130px] text-right tabular-nums"
                        value={form.amount}
                        onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, '') }))}
                      />
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy || !(n(form.amount) > 0) || !form.bank}
                      onClick={() => void run(() => api.refundRecord(id!, { date: form.date, amount: n(form.amount), bank: form.bank }), 'Refund recorded')}
                    >
                      Record refund
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
