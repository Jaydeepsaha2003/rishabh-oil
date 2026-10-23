import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errText, formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// WHICH CREDIT NOTE SETTLED THIS TANKER'S SHORTAGE. The customer's credit notes
// in the invoice's book — made here or booked from Tally — are listed, the ones
// naming this invoice first; the ticked ones are linked to its shortage, and
// the Sales list then shows the shortage as answered by them. Nothing is posted.
export function ShortageNoteDialog({
  ask,
  onClose,
  onDone
}: {
  ask: { saleId: number; invoiceNo: string; customer: string; due: number } | null
  onClose: () => void
  onDone?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setData(null)
    if (!ask) return
    let live = true
    window.api.sales
      .shortageNotes(ask.saleId)
      .then((r) => {
        if (!live) return
        setData(r)
        setPicked(new Set(((r.linked as Row[]) || []).map((l) => Number(l.entry_id))))
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
  const total = notes.filter((x) => picked.has(Number(x.entry_id))).reduce((t, x) => t + (Number(x.amount) || 0), 0)
  const save = async (): Promise<void> => {
    if (!ask) return
    setBusy(true)
    try {
      const r = await window.api.sales.shortageNotesSet(ask.saleId, [...picked])
      toast.success(r.linked ? `Shortage on ${ask.invoiceNo} linked to ${r.linked} credit note${r.linked === 1 ? '' : 's'}` : `Shortage on ${ask.invoiceNo} unlinked`)
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileMinus className="h-4 w-4 text-rose-700" />
            Credit note for the shortage on {ask?.invoiceNo}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          {ask?.customer} · shortage beyond tolerance{' '}
          <span className="font-semibold text-rose-700">{formatINR(ask?.due || 0)}</span>. Tick the credit note(s) raised for it —
          made here or booked from Tally. Nothing is posted; this only records which note settled it.
        </p>
        {notes.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-[12.5px] text-muted-foreground">
            No credit note to this customer in these books yet. Raise it (Accounting → Credit Note, or book it from Tally), then link it here.
          </p>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-md border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[#F4F7F3] text-[10.5px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-1.5" />
                  <th className="px-2 py-1.5 text-left">Note</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Against / narration</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((x) => {
                  const id = Number(x.entry_id)
                  const on = picked.has(id)
                  const elsewhere = String(x.linked_to || '')
                    .split(', ')
                    .filter((k) => k && k !== String(data?.invoice_key || ''))
                  return (
                    <tr key={id} className="border-t">
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = new Set(picked)
                            if (on) next.delete(id)
                            else next.add(id)
                            setPicked(next)
                          }}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-semibold">
                        {String(x.code || x.vch_no || `#${id}`)}
                        {x.vch_no && x.code ? <span className="ml-1 text-[10.5px] font-normal text-muted-foreground">{String(x.vch_no)}</span> : null}
                        {x.names_invoice && (
                          <span className="ml-1.5 rounded-[3px] bg-emerald-50 px-1 text-[10px] font-bold text-emerald-700">names this invoice</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{formatDate(String(x.entry_date))}</td>
                      <td className="max-w-[260px] truncate px-2 py-1.5 text-muted-foreground" title={String(x.narration || '')}>
                        {x.refs ? `Agst ${String(x.refs)} · ` : ''}
                        {String(x.narration || '—')}
                        {elsewhere.length > 0 && <span className="ml-1 text-amber-700">· linked to another invoice too</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{formatINR(Number(x.amount))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[12px] text-muted-foreground">
          Ticked {formatINR(total)} against a shortage of {formatINR(ask?.due || 0)}
          {picked.size > 0 && Math.abs(total - (ask?.due || 0)) > 1 ? ` (${total > (ask?.due || 0) ? 'more' : 'less'} by ${formatINR(Math.abs(total - (ask?.due || 0)))})` : ''}
        </p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void save()} disabled={busy || (notes.length === 0 && picked.size === 0)}>
            {busy ? 'Saving…' : picked.size ? `Link ${picked.size} note${picked.size === 1 ? '' : 's'}` : 'Unlink'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
