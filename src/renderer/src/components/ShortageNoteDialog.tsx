import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errText, formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type ShortageAsk = {
  saleId: number
  invoiceNo: string
  customer: string
  due: number
  // Short inside the tolerance, credited for the whole shortage anyway.
  whole?: boolean
  // What a credit note raised from here needs; absent, only linking is offered.
  cn?: { customerId: number; companyId: number; date: string; gstPct: number; detail: string }
}

// WHICH CREDIT NOTE SETTLED THIS TANKER'S SHORTAGE. The customer's credit notes
// in the invoice's book — made here or booked from Tally — are listed, the ones
// naming this invoice first; the ticked ones are linked to its shortage, and
// the Sales list then shows the shortage as answered by them. Nothing is posted.
export function ShortageNoteDialog({
  ask,
  onClose,
  onDone
}: {
  ask: ShortageAsk | null
  onClose: () => void
  onDone?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  // RAISE THE CREDIT NOTE HERE. Value-only (no quantity, so no stock moves),
  // Agst Ref the invoice, then linked to its shortage in the same step.
  const [cnAmt, setCnAmt] = useState('')
  const [cnGst, setCnGst] = useState('')
  const [cnDate, setCnDate] = useState('')
  const [cnAgainst, setCnAgainst] = useState('')

  useEffect(() => {
    setData(null)
    if (!ask) return
    setCnAmt(String(Math.round((ask.due || 0) * 100) / 100))
    setCnGst(String(ask.cn?.gstPct ?? 0))
    setCnDate(ask.cn?.date || '')
    let live = true
    window.api.sales
      .shortageNotes(ask.saleId)
      .then((r) => {
        if (!live) return
        setData(r)
        setPicked(new Set(((r.linked as Row[]) || []).map((l) => Number(l.entry_id))))
        setCnAgainst(String(r.sale_account || 'SALES RETURN A/C'))
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
  const tLines = ((data?.transporter_lines as Row[]) || []) as Row[]
  const reload = async (): Promise<void> => {
    if (ask) setData(await window.api.sales.shortageNotes(ask.saleId))
  }
  const raiseDn = async (l: Row): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.transporterFreight.raiseShortageNote(Number(l.id), cnDate || undefined, Number(l.company_id) || undefined)
      toast.success(`Debit note ${r.note_no} raised on ${String(l.transporter)}`)
      await reload()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
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

  const createCn = async (): Promise<void> => {
    if (!ask?.cn) return
    setBusy(true)
    try {
      const made = await window.api.notes.create({
        note_type: 'credit',
        party_type: 'customer',
        party_id: ask.cn.customerId,
        company_id: ask.cn.companyId || undefined,
        note_date: cnDate,
        base_amount: Number(cnAmt),
        gst_pct: Number(cnGst) || 0,
        against_account: cnAgainst,
        against_invoice: ask.invoiceNo,
        narration: `Shortage on ${ask.invoiceNo}${ask.whole ? '' : ' beyond tolerance'} — ${ask.cn.detail}`
      })
      // The new note's voucher, found among the customer's notes, joins the links.
      const r = await window.api.sales.shortageNotes(ask.saleId)
      const hit = ((r.notes as Row[]) || []).find((x) => String(x.vch_no) === String(made.note_no))
      if (!hit) throw new Error(`Credit note ${made.note_no} was made but could not be found to link — link it from the list`)
      await window.api.sales.shortageNotesSet(ask.saleId, [...picked, Number(hit.entry_id)])
      toast.success(`Credit note ${made.note_no} made and linked to the shortage on ${ask.invoiceNo}`)
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
          {ask?.customer} · {ask?.whole ? 'short within tolerance — whole shortage' : 'shortage beyond tolerance'}{' '}
          <span className="font-semibold text-rose-700">{formatINR(ask?.due || 0)}</span>. Tick the credit note(s) raised for it —
          made here or booked from Tally. Nothing is posted; this only records which note settled it.
        </p>
        {notes.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-[12.5px] text-muted-foreground">
            No credit note to this customer in these books yet. Create it below, or raise it in Accounting → Credit Note / book it from Tally and link it here.
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
        {ask?.cn && (
          <div className="grid gap-2 rounded-md border border-rose-200 bg-rose-50/40 p-3">
            <div className="text-[12.5px] font-semibold text-rose-800">Create the credit note from here</div>
            <p className="text-[11.5px] text-muted-foreground">{ask.cn.detail}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="grid gap-1">
                <Label className="text-[11px]">Amount (before GST)</Label>
                <Input inputMode="decimal" value={cnAmt} onChange={(e) => setCnAmt(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-[11px]">GST %</Label>
                <Input inputMode="decimal" value={cnGst} onChange={(e) => setCnGst(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-[11px]">Date</Label>
                <DatePicker value={cnDate} onChange={(v) => setCnDate(String(v || ''))} />
              </div>
              <div className="grid gap-1">
                <Label className="text-[11px]">Ledger (Dr)</Label>
                <Input value={cnAgainst} onChange={(e) => setCnAgainst(e.target.value.toUpperCase())} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Dr {cnAgainst || 'ledger'} {formatINR(Number(cnAmt) || 0)}
              {Number(cnGst) > 0 ? ` + GST ${cnGst}%` : ''} / Cr {ask.customer}, Agst Ref {ask.invoiceNo}. No stock moves.
            </p>
            <div className="flex justify-end">
              <Button
                className="bg-rose-700 hover:bg-rose-800"
                disabled={busy || !(Number(cnAmt) > 0) || !cnDate || !cnAgainst.trim()}
                onClick={() => void createCn()}
              >
                {busy ? 'Creating…' : 'Create credit note & link'}
              </Button>
            </div>
          </div>
        )}
        {tLines.length > 0 && (
          <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50/40 p-3">
            <div className="text-[12.5px] font-semibold text-amber-900">Recover it from the transporter</div>
            {tLines.map((l) => {
              const amt = Math.abs(Number(l.amount) || 0)
              const unreg = String(l.gst_registration) === 'unregistered'
              return (
                <div key={String(l.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  <span className="font-semibold">{String(l.transporter || 'Transporter')}</span>
                  <span className="text-muted-foreground">{String(l.note || '')}</span>
                  <span className="ml-auto font-semibold tabular-nums">{formatINR(amt)}</span>
                  {l.note_id ? (
                    <span className="rounded-[3px] bg-emerald-50 px-1.5 text-[11px] font-bold text-emerald-700">Debit note {String(l.note_no || '')} raised</span>
                  ) : l.waived_at ? (
                    <span className="text-[11px] font-semibold text-muted-foreground">Written off — not the transporter&apos;s</span>
                  ) : l.bill_id ? (
                    <span className="text-[11px] font-semibold text-muted-foreground">Netted into their freight bill</span>
                  ) : unreg ? (
                    <span className="text-[11px] font-semibold text-muted-foreground" title="Unregistered transporters get no debit note">
                      Unregistered — comes off their freight bill (with GST) when it is booked
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void raiseDn(l)}>
                      Raise debit note
                    </Button>
                  )}
                </div>
              )
            })}
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
