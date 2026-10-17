import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, History, Undo2 } from 'lucide-react'
import { formatINR } from '@/lib/format'
import { draftTime } from '@/components/TallySalesCheck'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// WHAT HAS BEEN BOOKED FROM TALLY HERE — each booking one line: when, by whom,
// from which file, how many vouchers and for how much. A booking made from a
// wrong file is taken back whole: its vouchers, and nothing else. One a
// receipt or payment has since been set against stays, and says why.

export function TallyBatches({
  companyId,
  kind,
  scope,
  refresh = 0,
  onUndone
}: {
  companyId?: number
  kind?: string
  scope?: string
  /** Bumped after a booking, so the list reads again. */
  refresh?: number
  onUndone?: () => void | Promise<void>
}): React.JSX.Element | null {
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!companyId) return
    try {
      setRows(await window.api.tallyNotes.batches({ company_id: companyId, kind, scope }))
    } catch {
      setRows([])
    }
  }, [companyId, kind, scope])
  useEffect(() => {
    void load()
  }, [load, refresh])

  async function undo(id: number): Promise<void> {
    setBusy(true)
    try {
      const r = await window.api.tallyNotes.undoBatch({ company_id: companyId, id })
      if (r.removed) toast.success(`${r.removed} voucher${r.removed === 1 ? '' : 's'} taken back`)
      for (const k of r.kept.slice(0, 3)) toast.error(`Kept one: ${k.reason}`)
      if (r.kept.length > 3) toast.error(`${r.kept.length - 3} more kept`)
      setAsk(null)
      await load()
      await onUndone?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!rows.length) return null
  const live = rows.filter((r) => !r.undone_at && r.live > 0)
  return (
    <section className="shrink-0 overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-[#F7FAF6]">
        <ChevronRight className="h-3.5 w-3.5 text-[#8CA396]" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
        <History className="h-4 w-4 text-[#5A6B62]" />
        <span className="text-[12px] font-extrabold text-[#0A1F17]">Booked from Tally</span>
        <span className="text-[11.5px] font-semibold text-[#5A6B62]">
          {live.length} booking{live.length === 1 ? '' : 's'} that can be taken back · {rows.length} in all
        </span>
      </button>
      {open && (
        <div className="divide-y divide-[#EEF3ED] border-t border-[#E4ECE3]">
          {rows.map((r) => {
            const gone = !!r.undone_at || r.live === 0
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2" style={{ opacity: gone ? 0.6 : 1 }}>
                <span className="w-[92px] text-[11.5px] font-bold tabular-nums text-[#33473E]">{draftTime(String(r.created_at))}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#0A1F17]" title={String(r.file_name || '')}>
                  {String(r.file_name || 'Tally file')}
                  <span className="ml-2 text-[11px] font-semibold text-[#5A6B62]">by {String(r.created_by || '—')}</span>
                </span>
                <span className="text-[11.5px] font-semibold tabular-nums text-[#33473E]">
                  {r.live} of {r.count} voucher{r.count === 1 ? '' : 's'} · {formatINR(Number(r.amount) || 0)}
                </span>
                {gone ? (
                  <span className="text-[10px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">
                    {r.undone_at ? `Taken back · ${draftTime(String(r.undone_at))}` : 'Nothing left'}
                  </span>
                ) : ask === r.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-[11.5px] font-bold text-[#8C2F26]">Delete its {r.live} voucher{r.live === 1 ? '' : 's'}?</span>
                    <button type="button" onClick={() => setAsk(null)} className="h-7 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#33473E]">
                      Keep
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void undo(Number(r.id))}
                      className="h-7 rounded-[4px] bg-[#B3261E] px-2.5 text-[11px] font-extrabold text-white disabled:opacity-60"
                    >
                      {busy ? 'Taking back…' : 'Take back'}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAsk(Number(r.id))}
                    className="flex h-7 items-center gap-1 rounded-[4px] border border-[#F0D6D4] bg-white px-2.5 text-[11px] font-extrabold text-[#B3261E] hover:bg-[#FDF3F2]"
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Take back
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
