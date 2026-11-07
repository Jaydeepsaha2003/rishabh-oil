import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// MAKE AN OLD NAME ITS OWN LEDGER AGAIN (ledgerMap.ts releaseOldName): the ←
// chip on a renamed ledger. Says what moves — the chosen books' openings — and
// what does not (vouchers), before anything is done.
export function LedgerReleaseDialog({ mapId, onClose, onDone }: { mapId: number | null; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [p, setP] = useState<Row | null>(null)
  const [pick, setPick] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setP(null)
    setPick([])
    if (!mapId) return
    window.api.journal
      .releasePreview(mapId)
      .then((r) => {
        setP(r)
        // Pre-tick the books that keep only an opening on it — those are the ones that can move.
        setPick(((r.companies as Row[]) || []).filter((c) => !Number(c.postings) && (Number(c.opening_dr) || Number(c.opening_cr))).map((c) => Number(c.company_id)))
      })
      .catch((e) => {
        toast.error((e as Error).message)
        onClose()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId])
  const cos = ((p?.companies as Row[]) || []) as Row[]
  const bal = (c: Row): string => {
    const d = Number(c.opening_dr) || 0
    const k = Number(c.opening_cr) || 0
    return d || k ? `${formatINR(Math.abs(d - k))} ${d >= k ? 'Dr' : 'Cr'}` : 'no opening'
  }
  async function apply(): Promise<void> {
    if (!mapId) return
    setBusy(true)
    try {
      const r = await window.api.journal.releaseOldName(mapId, pick)
      toast.success(`${r.name} is its own ledger again${r.moved.length ? ' — opening moved' : ''}`)
      onDone()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!mapId} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="bg-[#0B3D2E] px-5 py-3.5 pr-12 text-white">
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">Old name</div>
          <DialogTitle className="text-[15px] font-extrabold text-white">Make it its own ledger again</DialogTitle>
        </div>
        {!p ? (
          <div className="px-5 py-6 text-[12.5px] text-[#5A6B62]">Reading…</div>
        ) : (
          <div className="space-y-3 px-5 py-4 text-[12.5px] text-[#33473E]">
            <p className="leading-[1.6]">
              <b>{String(p.old_name)}</b> now reaches <b>{String(p.ledger.name)}</b> (renamed). Releasing it opens{' '}
              <b>{String(p.old_name)}</b> as a separate ledger under <b>{String(p.ledger.acc_group)}</b>; anything posted to that name from now on goes to it.
            </p>
            {p.exists ? (
              <p className="font-semibold text-[#B3261E]">A ledger with that name already exists — nothing to release.</p>
            ) : (
              <>
                <div className="text-[10.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Which books move to the new ledger</div>
                <div className="overflow-hidden rounded-[4px] border border-[#E4ECE3]">
                  {cos.length === 0 && <div className="px-3 py-2 text-[#5A6B62]">No book has anything on {String(p.ledger.name)}.</div>}
                  {cos.map((c) => {
                    const id = Number(c.company_id)
                    const locked = Number(c.postings) > 0
                    return (
                      <label key={id} className="flex items-start gap-2.5 border-b border-[#EFF3EE] px-3 py-2 last:border-b-0">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={locked}
                          checked={pick.includes(id)}
                          onChange={(e) => setPick((x) => (e.target.checked ? [...x, id] : x.filter((y) => y !== id)))}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-extrabold text-[#0A1F17]">{String(c.name)}</span>
                          <span className="block text-[11.5px] font-semibold text-[#5A6B62]">
                            opening {bal(c)}
                            {locked ? ` · ${Number(c.postings)} voucher line(s) — stays on ${String(p.ledger.name)}` : ' · its opening moves'}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
                <p className="text-[11px] font-semibold text-[#5A6B62]">
                  Vouchers are not moved. A book left unticked keeps everything on {String(p.ledger.name)}.
                </p>
              </>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-[#E4ECE3] px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !p || !!p.exists}>
            {busy ? 'Releasing…' : 'Make it its own ledger'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
