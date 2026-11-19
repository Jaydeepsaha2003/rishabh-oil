import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileMinus, Link2, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { HelpTip } from '@/components/ui/tooltip'
import { errText, formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

export type PurchaseDnAsk = { orderId: number; invoiceNo: string; supplier: string; shortage?: number; quality?: number }

const KINDS = [
  { k: 'shortage', label: 'Shortage', cls: 'bg-[#B3261E]', soft: 'bg-[#FDECEA] text-[#B3261E] border-[#F0C9C4]' },
  { k: 'quality', label: 'Quality', cls: 'bg-[#1B4E82]', soft: 'bg-[#EAF0FA] text-[#1B4E82] border-[#C6DAF0]' }
] as const

// A PURCHASE'S DEBIT NOTES, AS SHORTAGE OR QUALITY (purchaseDebitNotes.ts): the
// supplier's debit notes in the purchase's book — made here or booked from
// Tally — each ticked under the kind it settles. Nothing is posted.
export function PurchaseDnDialog({ ask, onClose, onDone }: { ask: PurchaseDnAsk | null; onClose: () => void; onDone?: () => void }): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  // entry_id → kinds ticked
  const [picked, setPicked] = useState<Map<number, Set<string>>>(new Map())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setData(null)
    if (!ask) return
    let live = true
    window.api.orders
      .dnNotes(ask.orderId)
      .then((r) => {
        if (!live) return
        setData(r)
        const m = new Map<number, Set<string>>()
        for (const l of (r.linked as Row[]) || []) {
          const id = n(l.entry_id)
          if (!m.has(id)) m.set(id, new Set())
          m.get(id)!.add(String(l.kind))
        }
        setPicked(m)
      })
      .catch((e) => {
        toast.error(errText(e))
        onClose()
      })
    return () => {
      live = false
    }
  }, [ask]) // eslint-disable-line react-hooks/exhaustive-deps

  const notes = ((data?.notes as Row[]) || []) as Row[]
  const on = (id: number, k: string): boolean => !!picked.get(id)?.has(k)
  const flip = (id: number, k: string): void =>
    setPicked((p) => {
      const m = new Map(p)
      const s = new Set(m.get(id) || [])
      if (s.has(k)) s.delete(k)
      else s.add(k)
      m.set(id, s)
      return m
    })
  const totalOf = (k: string): number => notes.filter((x) => on(n(x.entry_id), k)).reduce((t, x) => t + n(x.amount), 0)
  const links = [...picked.entries()].flatMap(([id, ks]) => [...ks].map((k) => ({ entry_id: id, kind: k })))

  async function save(): Promise<void> {
    if (!ask) return
    setBusy(true)
    try {
      const r = await window.api.orders.dnNotesSet(ask.orderId, links)
      toast.success(r.linked ? `${ask.invoiceNo}: ${r.linked} debit note link${r.linked === 1 ? '' : 's'} saved` : `${ask.invoiceNo}: debit notes unlinked`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!ask && !!data} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[1000px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1000px,96vw)] [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 py-3.5 pr-12 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <FileMinus className="h-3.5 w-3.5" /> Debit notes on the purchase
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <DialogTitle className="text-[17px] font-extrabold text-white">{ask?.invoiceNo}</DialogTitle>
            <span className="text-[12.5px] font-semibold text-white/75">{ask?.supplier}</span>
            <HelpTip
              className="text-white/60 hover:text-white"
              text="Tick each debit note under the claim it settles — Shortage (less received than billed) or Quality (FFA, moisture…). The notes are the supplier's debit notes in this book, made in Accounting or booked from Tally; linking posts nothing."
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#F7FAF6] px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            {KINDS.map((k) => {
              const due = k.k === 'shortage' ? ask?.shortage : ask?.quality
              const t = totalOf(k.k)
              return (
                <div key={k.k} className="rounded-[8px] border border-[#DCE6DC] bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2.5 w-2.5 rounded-full', k.cls)} />
                    <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">{k.label} debit note</span>
                  </div>
                  <div className="mt-1 text-[20px] font-extrabold tabular-nums text-[#0A1F17]">{formatINR(t)}</div>
                  <div className="text-[11.5px] font-semibold text-[#7A8C82]">
                    {notes.filter((x) => on(n(x.entry_id), k.k)).length} linked{due ? ` · claim ${formatINR(due)}` : ''}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="overflow-hidden rounded-[8px] border border-[#DCE6DC] bg-white">
            {notes.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] font-semibold text-[#9AAFA2]">No debit note to this supplier in these books yet — raise it in Accounting → Debit Note</div>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#DCEFE4]">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Debit note</th>
                    <th className="px-2 py-2.5 text-left">Date</th>
                    <th className="px-2 py-2.5 text-left">Against / narration</th>
                    <th className="px-2 py-2.5 text-right">Amount</th>
                    {KINDS.map((k) => (
                      <th key={k.k} className="w-[96px] px-2 py-2.5 text-center">
                        {k.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notes.map((x) => {
                    const id = n(x.entry_id)
                    const any = KINDS.some((k) => on(id, k.k))
                    return (
                      <tr key={id} className={cn('border-t border-[#F1F5F0]', any && 'bg-[#F7FBF5]')}>
                        <td className="px-4 py-2">
                          <span className="font-extrabold text-[#0A1F17]">{String(x.code || x.vch_no || `#${id}`)}</span>
                          {x.dn_kind && (
                            <span className={cn('ml-1.5 rounded-full border px-1.5 py-[1px] text-[10px] font-extrabold uppercase', KINDS.find((k) => k.k === x.dn_kind)?.soft || 'border-[#D6E2D6] bg-[#EEF3EE] text-[#5A6B62]')}>
                              {String(x.dn_kind)}
                            </span>
                          )}
                          {x.names_invoice && <span className="ml-1.5 rounded-full bg-[#E9F5EE] px-1.5 py-[1px] text-[10px] font-extrabold text-[#0B6B45]">names this invoice</span>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatDate(String(x.entry_date))}</td>
                        <td className="max-w-[320px] truncate px-2 py-2 text-[#5A6B62]" title={String(x.narration || '')}>
                          {x.refs ? <span className="font-semibold text-[#1B4E82]">Agst {String(x.refs)} · </span> : ''}
                          {String(x.narration || '—')}
                          {x.linked_elsewhere && <span className="ml-1 font-semibold text-[#8A5300]">· also on {String(x.linked_elsewhere)}</span>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right font-extrabold tabular-nums">{formatINR(n(x.amount))}</td>
                        {KINDS.map((k) => (
                          <td key={k.k} className="px-2 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => flip(id, k.k)}
                              aria-pressed={on(id, k.k)}
                              aria-label={`${k.label} — ${String(x.code || x.vch_no || id)}`}
                              className={cn(
                                'inline-flex h-7 min-w-[74px] items-center justify-center rounded-full border px-2 text-[11px] font-extrabold',
                                on(id, k.k) ? cn(k.cls, 'border-transparent text-white') : 'border-[#D6E2D6] bg-white text-[#9AAFA2] hover:text-[#33473E]'
                              )}
                            >
                              {on(id, k.k) ? `✓ ${k.label}` : k.label}
                            </button>
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-[#E4ECE3] bg-white px-5 py-3">
          <span className="text-[12px] font-semibold text-[#5A6B62]">
            Shortage <b className="tabular-nums text-[#B3261E]">{formatINR(totalOf('shortage'))}</b> · Quality <b className="tabular-nums text-[#1B4E82]">{formatINR(totalOf('quality'))}</b>
          </span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]">
            Close
          </button>
          <button
            type="button"
            data-ctrl-a
            onClick={() => void save()}
            disabled={busy || (!notes.length && !links.length)}
            className="flex h-10 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Save links
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
