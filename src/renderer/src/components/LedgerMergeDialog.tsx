import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Merge, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errText, formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// MERGE ONE LEDGER INTO ANOTHER (ledgerMerge.ts). Pick the ledger to keep, see
// what moves company by company, choose the name the one ledger carries — the
// Tally name, the software's, or a new one — and merge. Every voucher keeps its
// number; the old names become redirects.
export function LedgerMergeDialog({
  from,
  ledgers,
  onClose,
  onDone
}: {
  from: { id: number; name: string } | null
  ledgers: Row[]
  onClose: () => void
  onDone?: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [into, setInto] = useState<Row | null>(null)
  const [pv, setPv] = useState<Row | null>(null)
  const [keep, setKeep] = useState<'into' | 'from' | 'custom'>('into')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  // Tally copies marked as real, separate entries (kept through the merge).
  const [kept, setKept] = useState<Set<number>>(new Set())
  const [rev, setRev] = useState(0)

  useEffect(() => {
    setQ(from ? String(from.name).split(/[\s,&(]+/)[0] || '' : '')
    setInto(null)
    setPv(null)
    setKeep('into')
    setCustom('')
  }, [from])

  useEffect(() => {
    setPv(null)
    setKept(new Set())
    if (!from || !into) return
    let live = true
    window.api.journal
      .mergePreview(from.id, Number(into.id))
      .then((r) => live && setPv(r))
      .catch((e) => toast.error(errText(e)))
    return () => {
      live = false
    }
  }, [from, into, rev])

  const matches = useMemo(() => {
    const k = q.trim().toUpperCase()
    if (!k || !from) return []
    return ledgers.filter((l) => Number(l.id) !== from.id && String(l.name).toUpperCase().includes(k)).slice(0, 12)
  }, [q, ledgers, from])

  const keepName = keep === 'into' ? String(into?.name || '') : keep === 'from' ? String(from?.name || '') : custom.trim()
  const copies = ((pv?.copies as Row[]) || []) as Row[]
  const unresolved = copies.filter((x) => !kept.has(Number(x.copy_id))).length
  // Delete the Tally copy (an ordinary voucher delete) and look again.
  const dropCopy = async (x: Row): Promise<void> => {
    const no = String(x.copy_on === String(from?.name) ? x.from_code || x.from_no : x.into_code || x.into_no)
    if (!window.confirm(`Delete the Tally copy ${no}? The app's own entry stays. This removes the voucher.`)) return
    setBusy(true)
    try {
      await window.api.vouchers.remove(Number(x.copy_id))
      toast.success(`${no} deleted`)
      setRev((r) => r + 1)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const merge = async (): Promise<void> => {
    if (!from || !into || !pv || pv.blocked) return
    const lines = ((pv.companies as Row[]) || []).reduce((t, x) => t + Number(x.lines || 0), 0)
    if (
      !window.confirm(
        `Merge ${from.name} into ${String(into.name)}?\n\n${lines} voucher line(s) move, its opening balances are added in, and ${from.name} becomes a redirect to the kept ledger, which will be named ${keepName.toUpperCase()}.\n\nVouchers keep their numbers. It is logged, but there is no one-click undo — take a database snapshot first if you want one.`
      )
    )
      return
    setBusy(true)
    try {
      const r = await window.api.journal.mergeLedgers(from.id, Number(into.id), keepName, [...kept])
      toast.success(`Merged — ${r.lines} line(s) now on ${r.name}`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const bal = (dr: number, cr: number): string => {
    const v = (Number(dr) || 0) - (Number(cr) || 0)
    return Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`
  }

  return (
    <Dialog open={!!from} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-4 w-4 text-[#0B3D2E]" />
            Merge {from?.name} into another ledger
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-[12.5px]">
          <div className="grid gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">The ledger to keep</span>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ledgers" className="pl-8" autoFocus />
            </div>
            {!into && matches.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border">
                {matches.map((l) => (
                  <button
                    key={String(l.id)}
                    type="button"
                    onClick={() => setInto(l)}
                    className="flex w-full items-center justify-between gap-3 border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-[#F1F8EC]"
                  >
                    <span className="min-w-0 truncate font-semibold">{String(l.name)}</span>
                    <span className="flex-none text-[11px] text-muted-foreground">{String(l.acc_group || '')}</span>
                  </button>
                ))}
              </div>
            )}
            {into && (
              <div className="flex items-center justify-between rounded-md border border-[#BFE3CB] bg-[#E9F5EE] px-3 py-2">
                <span>
                  <span className="font-bold">{String(into.name)}</span>{' '}
                  <span className="text-[11px] text-muted-foreground">{String(into.acc_group || '')}</span>
                </span>
                <button type="button" className="text-[11.5px] font-semibold underline" onClick={() => setInto(null)}>
                  change
                </button>
              </div>
            )}
          </div>

          {into && !pv && <p className="text-muted-foreground">Reading what would move…</p>}
          {pv && (
            <>
              {pv.blocked ? (
                <p className="rounded-md bg-rose-50 px-3 py-2 font-medium text-rose-800">{String(pv.blocked)}</p>
              ) : (
                <div className="rounded-md border">
                  <div className="border-b bg-[#F4F7F3] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    Moves from {from?.name}
                  </div>
                  <table className="w-full text-[12px]">
                    <tbody>
                      {((pv.companies as Row[]) || []).map((x) => (
                        <tr key={String(x.company_id)} className="border-b last:border-b-0">
                          <td className="px-3 py-1.5 font-semibold">{String(x.company || `Company ${x.company_id}`)}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {Number(x.vouchers)} voucher{Number(x.vouchers) === 1 ? '' : 's'}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">Dr {formatINR(Number(x.dr))}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">Cr {formatINR(Number(x.cr))}</td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{bal(x.dr, x.cr)}</td>
                        </tr>
                      ))}
                      {((pv.openings as Row[]) || []).map((o) => (
                        <tr key={`o${String(o.company_id)}`} className="border-b last:border-b-0">
                          <td className="px-3 py-1.5 font-semibold">{String(o.company || `Company ${o.company_id}`)}</td>
                          <td className="px-3 py-1.5 text-muted-foreground" colSpan={3}>
                            opening balance, added to the kept ledger's
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{bal(o.dr, o.cr)}</td>
                        </tr>
                      ))}
                      {!((pv.companies as Row[]) || []).length && !((pv.openings as Row[]) || []).length && (
                        <tr>
                          <td className="px-3 py-2 text-muted-foreground">Nothing posted to it — only its name moves.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {(((pv.redirects as string[]) || []).length > 0 || pv.groups_differ) && (
                    <div className="border-t px-3 py-1.5 text-[11.5px] text-muted-foreground">
                      {((pv.redirects as string[]) || []).length > 0 && (
                        <div>Redirects that follow it: {(pv.redirects as string[]).join(', ')}</div>
                      )}
                      {pv.groups_differ && (
                        <div className="text-amber-800">
                          Different groups ({String((pv.from as Row).acc_group)} → {String((pv.into as Row).acc_group)}) — the kept ledger's group stays.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {copies.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  <div className="font-bold">
                    The same money on both ledgers? {unresolved ? `${unresolved} to resolve before merging` : 'all resolved'}
                  </div>
                  <div className="mb-1.5 text-[11px]">
                    A Tally import on one ledger matches an entry the app posted on the other — merged as they are, the party would carry both.
                  </div>
                  {copies.map((x) => {
                    const id = Number(x.copy_id)
                    const fromIsCopy = x.copy_on === String(from?.name)
                    const one = (side: 'from' | 'into'): string =>
                      `${String(side === 'from' ? x.from_code || x.from_no : x.into_code || x.into_no)} ${String(side === 'from' ? x.from_type : x.into_type).toLowerCase()} ${formatDate(String(side === 'from' ? x.from_date : x.into_date))}`
                    const amt = Number(x.dr) || Number(x.cr)
                    const isKept = kept.has(id)
                    return (
                      <div key={`${id}-${String(x.twin_id)}`} className={cn('mb-1 rounded border bg-white px-2 py-1.5', isKept ? 'border-[#DCE7DB] opacity-70' : 'border-amber-300')}>
                        <div>
                          <b>Tally copy:</b> {one(fromIsCopy ? 'from' : 'into')} · {formatINR(amt)} {Number(x.dr) > 0 ? 'Dr' : 'Cr'}
                        </div>
                        <div className="text-[11px]">
                          <b>App entry:</b> {one(fromIsCopy ? 'into' : 'from')} · {formatINR(Number(x.twin_dr) || Number(x.twin_cr))}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void dropCopy(x)}
                            className="rounded-[4px] bg-[#8C2F26] px-2 py-1 text-[11px] font-bold text-white disabled:opacity-40"
                          >
                            Delete the Tally copy
                          </button>
                          <label className="flex items-center gap-1 text-[11px] font-semibold">
                            <input
                              type="checkbox"
                              checked={isKept}
                              onChange={(e) =>
                                setKept((s) => {
                                  const next = new Set(s)
                                  if (e.target.checked) next.add(id)
                                  else next.delete(id)
                                  return next
                                })
                              }
                            />
                            Not the same — keep both
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {!pv.blocked && (
                <div className="grid gap-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">The one ledger is named</span>
                  {(
                    [
                      ['into', String(into?.name || '')],
                      ['from', String(from?.name || '')]
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="radio" checked={keep === k} onChange={() => setKeep(k)} />
                      <span className="font-semibold">{label}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={keep === 'custom'} onChange={() => setKeep('custom')} />
                    <Input
                      value={custom}
                      onFocus={() => setKeep('custom')}
                      onChange={(e) => setCustom(e.target.value)}
                      placeholder="Another name, e.g. as it is in Tally"
                      className="h-8"
                    />
                  </label>
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void merge()} disabled={busy || !pv || !!pv.blocked || !keepName || unresolved > 0} title={unresolved ? 'Resolve the same-money pairs first' : undefined}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
