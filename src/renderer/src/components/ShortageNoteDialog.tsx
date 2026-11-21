import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileMinus, Link2, Plus, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { HelpTip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { errText, formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type ShortageAsk = {
  saleId: number
  invoiceNo: string
  customer: string
  due: number
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
  // Only notes still on the list count: a link to a note since deleted or changed
  // (no longer a credit note to this customer) is not shown, and saving drops it.
  const live = [...picked].filter((id) => notes.some((x) => Number(x.entry_id) === id))
  const stale = picked.size - live.length
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
      const r = await window.api.sales.shortageNotesSet(ask.saleId, live)
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
    if (!ask?.cn || busy) return
    // ONE shortage, ONE note: a credit note already naming this invoice is offered
    // to link instead — retrying a failed link must not post another.
    const same = notes.filter((x) => x.names_invoice && Math.abs(Number(x.amount) - after) < 1)
    if (
      same.length &&
      !window.confirm(
        `${same.map((x) => String(x.code || x.vch_no)).join(', ')} already credit${same.length === 1 ? 's' : ''} ${formatINR(after)} against ${ask.invoiceNo}.

Tick ${same.length === 1 ? 'it' : 'one'} in the list and Link instead. Create ANOTHER credit note anyway?`
      )
    )
      return
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
        narration: `Shortage on ${ask.invoiceNo} — ${ask.cn.detail}`
      })
      // The new note's voucher, found among the customer's notes, joins the links.
      const r = await window.api.sales.shortageNotes(ask.saleId)
      const hit = ((r.notes as Row[]) || []).find((x) => String(x.vch_no) === String(made.note_no))
      if (!hit) throw new Error(`Credit note ${made.note_no} was made but could not be found to link — link it from the list`)
      await window.api.sales.shortageNotesSet(ask.saleId, [...live, Number(hit.entry_id)])
      toast.success(`Credit note ${made.note_no} made and linked to the shortage on ${ask.invoiceNo}`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // GST both ways: the figure before GST is what is saved; after GST follows it,
  // and typing after GST works the before-GST figure back.
  const gstPct = Number(cnGst) || 0
  const before = Number(cnAmt) || 0
  const gstAmt = Math.round(before * gstPct) / 100
  const after = Math.round((before + gstAmt) * 100) / 100
  const [afterTyping, setAfterTyping] = useState<string | null>(null)
  const due = ask?.due || 0
  const gap = Math.round((total - due) * 100) / 100
  const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  const box = 'h-10 w-full rounded-[5px] border border-[#C9DCCF] bg-white px-3 text-[13px] font-semibold outline-none focus:border-[#0B6B45] focus:ring-2 focus:ring-[#0B6B45]/15'

  return (
    <Dialog open={!!ask && !!data} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[1040px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1040px,96vw)] [&>button]:!text-white">
        {/* HEADER — whose shortage, and how much. */}
        <div className="flex-none bg-[#0B3D2E] px-5 py-3.5 pr-12 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <FileMinus className="h-3.5 w-3.5" /> Shortage credit note
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <DialogTitle className="text-[17px] font-extrabold text-white">{ask?.invoiceNo}</DialogTitle>
            <span className="text-[12.5px] font-semibold text-white/75">{ask?.customer}</span>
            <HelpTip
              className="text-white/60 hover:text-white"
              text="The customer has no tolerance, so the whole shortage is credited. Tick the credit note(s) raised for it — made here or booked from Tally — and Link. Nothing is posted by linking; Create posts a value-only credit note (no stock moves), Agst Ref the invoice, and links it."
            />
            <span className="ml-auto text-right">
              <span className="block text-[9.5px] font-extrabold uppercase tracking-[.12em] text-white/60">Shortage</span>
              <span className="text-[18px] font-extrabold tabular-nums text-[#FFB4AB]">{due ? formatINR(due) : 'delivered short'}</span>
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#F7FAF6] px-5 py-4">
          {/* THE CREDIT NOTES THERE ARE — tick the ones for this shortage. */}
          <div className="overflow-hidden rounded-[8px] border border-[#DCE6DC] bg-white">
            <div className="flex items-center gap-2 border-b border-[#EEF3EE] px-4 py-2.5">
              <Link2 className="h-4 w-4 text-[#0B3D2E]" />
              <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">Credit notes to this customer</span>
              <span className="ml-auto rounded-full bg-[#EEF3EE] px-2 py-0.5 text-[10.5px] font-bold text-[#5A6B62]">{notes.length}</span>
            </div>
            {notes.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] font-semibold text-[#9AAFA2]">None yet in these books — create it below</div>
            ) : (
              <div className="max-h-[34vh] overflow-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-[#F5F8F4] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                    <tr>
                      <th className="w-10 px-3 py-2" />
                      <th className="px-2 py-2 text-left">Note</th>
                      <th className="px-2 py-2 text-left">Date</th>
                      <th className="px-2 py-2 text-left">Against / narration</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notes.map((x) => {
                      const id = Number(x.entry_id)
                      const on = picked.has(id)
                      const elsewhere = String(x.linked_to || '')
                        .split(', ')
                        .filter((k) => k && k !== String(data?.invoice_key || ''))
                      const flip = (): void => {
                        const next = new Set(picked)
                        if (on) next.delete(id)
                        else next.add(id)
                        setPicked(next)
                      }
                      return (
                        <tr key={id} onClick={(e) => !(e.target as HTMLElement).closest('input') && flip()} className={cn('cursor-pointer border-t border-[#F1F5F0] hover:bg-[#FAFCF9]', on && '!bg-[#EEF8E4]')}>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={on} onChange={flip} aria-label={`Link ${String(x.code || x.vch_no || id)}`} />
                          </td>
                          <td className="px-2 py-2">
                            <span className="font-extrabold text-[#0A1F17]">{String(x.code || x.vch_no || `#${id}`)}</span>
                            {x.vch_no && x.code ? <span className="ml-1 text-[10.5px] text-[#7A8C82]">{String(x.vch_no)}</span> : null}
                            {x.names_invoice && <span className="ml-1.5 rounded-full bg-[#E9F5EE] px-1.5 py-[1px] text-[10px] font-extrabold text-[#0B6B45]">names this invoice</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatDate(String(x.entry_date))}</td>
                          <td className="max-w-[360px] truncate px-2 py-2 text-[#5A6B62]" title={String(x.narration || '')}>
                            {x.refs ? <span className="font-semibold text-[#1B4E82]">Agst {String(x.refs)} · </span> : ''}
                            {String(x.narration || '—')}
                            {elsewhere.length > 0 && <span className="ml-1 font-semibold text-[#8A5300]">· linked to another invoice too</span>}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right font-extrabold tabular-nums">{formatINR(Number(x.amount))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {/* LINK — what is ticked above against the shortage, and the button that links it. */}
            <div className="flex flex-wrap items-center gap-3 border-t border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
              <span className="text-[12px] font-semibold text-[#5A6B62]">
                Ticked <b className="tabular-nums text-[#0A1F17]">{formatINR(total)}</b>
                {due ? (
                  <>
                    {' '}
                    of <b className="tabular-nums text-[#0A1F17]">{formatINR(due)}</b>
                  </>
                ) : null}
              </span>
              {live.length > 0 && due > 0 && (
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-extrabold', Math.abs(gap) <= 1 ? 'bg-[#E9F5EE] text-[#0B6B45]' : gap > 0 ? 'bg-[#FFF4DC] text-[#7A4B00]' : 'bg-[#FDECEA] text-[#B3261E]')}>
                  {Math.abs(gap) <= 1 ? 'covers it' : gap > 0 ? `${formatINR(gap)} more` : `${formatINR(-gap)} short`}
                </span>
              )}
              {stale > 0 && (
                <span className="text-[11px] font-bold text-[#8A5300]" title="Linked before, but that voucher was deleted or is no longer a credit note to this customer">
                  {stale} old link{stale === 1 ? '' : 's'} to a removed note — dropped on save
                </span>
              )}
              <span className="flex-1" />
              <button
                type="button"
                data-ctrl-a
                onClick={() => void save()}
                disabled={busy || (notes.length === 0 && live.length === 0 && !stale)}
                className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
              >
                <Link2 className="h-4 w-4" />
                {busy ? 'Saving…' : live.length ? `Link ${live.length} note${live.length === 1 ? '' : 's'}` : 'Unlink'}
              </button>
            </div>
          </div>

          {/* RAISE IT HERE — value only, Agst Ref the invoice, linked in the same step. */}
          {ask?.cn && (
            <div className="overflow-hidden rounded-[8px] border border-[#F0C9C4] bg-white">
              <div className="flex flex-wrap items-center gap-2 border-b border-[#F7E1DE] bg-[#FDF5F4] px-4 py-2.5">
                <Plus className="h-4 w-4 text-[#B3261E]" />
                <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#8C2F26]">Create the credit note</span>
                <span className="ml-auto truncate text-[11.5px] font-semibold text-[#7A8C82]">{ask.cn.detail}</span>
              </div>
              <div className="space-y-3 px-4 py-3.5">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div>
                    <span className={lbl}>Before GST</span>
                    <input inputMode="decimal" value={cnAmt} onChange={(e) => setCnAmt(e.target.value.replace(/[^0-9.]/g, ''))} className={cn(box, 'text-right tabular-nums')} />
                  </div>
                  <div>
                    <span className={lbl}>GST %</span>
                    <input inputMode="decimal" value={cnGst} onChange={(e) => setCnGst(e.target.value.replace(/[^0-9.]/g, ''))} className={cn(box, 'text-right tabular-nums')} />
                  </div>
                  <div>
                    <span className={lbl}>GST amount</span>
                    <div className={cn(box, 'flex items-center justify-end bg-[#F7FAF6] tabular-nums text-[#5A6B62]')}>{formatINR(gstAmt)}</div>
                  </div>
                  <div>
                    <span className={lbl}>After GST</span>
                    <input
                      inputMode="decimal"
                      value={afterTyping ?? String(after)}
                      onFocus={() => setAfterTyping(String(after))}
                      onBlur={() => setAfterTyping(null)}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/g, '')
                        setAfterTyping(v)
                        setCnAmt(String(Math.round(((Number(v) || 0) / (1 + gstPct / 100)) * 100) / 100))
                      }}
                      className={cn(box, 'border-[#B3261E] text-right font-extrabold tabular-nums text-[#8C2F26]')}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
                  <div>
                    <span className={lbl}>Date</span>
                    <DatePicker value={cnDate} onChange={(v) => setCnDate(String(v || ''))} />
                  </div>
                  <div>
                    <span className={lbl}>Ledger (Dr)</span>
                    <input value={cnAgainst} onChange={(e) => setCnAgainst(e.target.value.toUpperCase())} className={box} />
                  </div>
                </div>
                {/* What will post. */}
                <div className="rounded-[6px] border border-[#EEF3EE] bg-[#FAFCF9] px-3 py-2 text-[12px]">
                  <div className="flex justify-between gap-3">
                    <span>
                      <b className="text-[#0B6B45]">Dr</b> {cnAgainst || 'ledger'}
                    </span>
                    <span className="tabular-nums">{formatINR(before)}</span>
                  </div>
                  {gstAmt > 0 && (
                    <div className="flex justify-between gap-3">
                      <span>
                        <b className="text-[#0B6B45]">Dr</b> GST {gstPct}%
                      </span>
                      <span className="tabular-nums">{formatINR(gstAmt)}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-3 border-t border-[#EEF3EE] pt-1">
                    <span>
                      <b className="text-[#B3261E]">Cr</b> {ask.customer} · Agst Ref {ask.invoiceNo}
                    </span>
                    <span className="font-extrabold tabular-nums">{formatINR(after)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3">
                  {due > 0 && Math.abs(after - due) > 1 && (
                    <span className="text-[11.5px] font-bold text-[#8A5300]">
                      {after > due ? `${formatINR(after - due)} more` : `${formatINR(due - after)} less`} than the shortage
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={busy || !(Number(cnAmt) > 0) || !cnDate || !cnAgainst.trim()}
                    onClick={() => void createCn()}
                    className="flex h-10 items-center gap-1.5 rounded-[5px] bg-[#B3261E] px-5 text-[12.5px] font-extrabold text-white hover:bg-[#8C2F26] disabled:opacity-50"
                  >
                    {busy ? 'Creating…' : `Create ${formatINR(after)} credit note & link`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {tLines.length > 0 && (
            <div className="overflow-hidden rounded-[8px] border border-[#E8C27A] bg-white">
              <div className="flex items-center gap-2 border-b border-[#F4E5C4] bg-[#FFF8EA] px-4 py-2.5">
                <Truck className="h-4 w-4 text-[#8A5300]" />
                <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#7A4B00]">Recover it from the transporter</span>
              </div>
              {tLines.map((l) => {
                const amt = Math.abs(Number(l.amount) || 0)
                const unreg = String(l.gst_registration) === 'unregistered'
                return (
                  <div key={String(l.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#F7EFDC] px-4 py-2.5 text-[12.5px] first:border-t-0">
                    <span className="font-extrabold">{String(l.transporter || 'Transporter')}</span>
                    <span className="text-[#7A8C82]">{String(l.note || '')}</span>
                    <span className="ml-auto font-extrabold tabular-nums">{formatINR(amt)}</span>
                    {l.note_id ? (
                      <span className="rounded-full bg-[#E9F5EE] px-2 py-0.5 text-[11px] font-extrabold text-[#0B6B45]">Debit note {String(l.note_no || '')} raised</span>
                    ) : l.waived_at ? (
                      <span className="text-[11px] font-semibold text-[#7A8C82]">Written off — not the transporter&apos;s</span>
                    ) : l.bill_id ? (
                      <span className="text-[11px] font-semibold text-[#7A8C82]">Netted into their freight bill</span>
                    ) : unreg ? (
                      <span className="text-[11px] font-semibold text-[#7A8C82]" title="Unregistered transporters get no debit note">
                        Unregistered — off their freight bill (with GST) when booked
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
        </div>

        {/* FOOTER — just Close; linking sits under the list it acts on. */}
        <div className="flex flex-none items-center justify-end border-t border-[#E4ECE3] bg-white px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]">
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
