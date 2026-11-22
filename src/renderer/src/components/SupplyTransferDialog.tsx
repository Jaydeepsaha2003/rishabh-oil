import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, Loader2, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { TagDraftPicker } from '@/components/Tags'
import { errText, formatDate, formatINR, formatNum } from '@/lib/format'

// THE TRANSFER BEHIND AN OUTSIDE SALE (supplyTransfer.ts): KR FINMARK sold to
// Surya oil bought from KR FOODS. Raised here — KR FOODS' sale to KR FINMARK,
// which books KR FINMARK's purchase and its TDS with it — tied to this sale and
// tagged (compulsory) on every side.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export function SupplyTransferDialog({ saleId, onClose, onDone }: { saleId: number | null; onClose: () => void; onDone?: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<Row | null>(null)
  const [from, setFrom] = useState('')
  const [invNo, setInvNo] = useState('')
  const [date, setDate] = useState('')
  const [lines, setLines] = useState<Record<number, { qty: string; rate: string }>>({})
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setInfo(null)
    if (!saleId) return
    let live = true
    window.api.sales
      .supplyInfo(saleId)
      .then((r) => {
        if (!live) return
        setInfo(r)
        setFrom(String((r.companies as Row[])[0]?.id || ''))
        setInvNo('')
        setDate(String(r.sale_date || ''))
        setTags([])
        setLines(Object.fromEntries((r.lines as Row[]).map((l) => [Number(l.id), { qty: String(l.qty), rate: String(l.rate) }])))
      })
      .catch((e) => {
        toast.error(errText(e))
        onClose()
      })
    return () => {
      live = false
    }
  }, [saleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const fromName = String(((info?.companies as Row[]) || []).find((c) => String(c.id) === from)?.name || 'the supplying company')
  const taxable = ((info?.lines as Row[]) || []).reduce((t, l) => t + (Number(lines[Number(l.id)]?.qty) || 0) * (Number(lines[Number(l.id)]?.rate) || 0), 0)
  const ready = !!info && !!from && !!invNo.trim() && tags.length > 0 && taxable > 0

  const raise = async (): Promise<void> => {
    if (!info || !ready) return
    setBusy(true)
    try {
      await window.api.sales.supplyRaise({
        sale_id: Number(info.sale_id),
        from_company_id: Number(from),
        invoice_no: invNo.trim(),
        date,
        lines: (info.lines as Row[]).map((l) => ({ id: Number(l.id), qty: Number(lines[Number(l.id)]?.qty) || 0, rate: Number(lines[Number(l.id)]?.rate) || 0 })),
        tags
      })
      toast.success(`${invNo.trim()} raised in ${fromName} — its purchase booked here, tied to ${String(info.invoice_no)}`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!info?.supply) return
    if (!window.confirm(`Remove the transfer ${String(info.supply.invoice_no)} behind ${String(info.invoice_no)}?\n\nIts sale in ${String(info.supply.company)}, the purchase here and its TDS are deleted.`)) return
    setBusy(true)
    try {
      await window.api.sales.supplyRemove(Number(info.sale_id))
      toast.success('Transfer removed')
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!saleId} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-[#1B4E82]" /> Inter-company transfer behind {String(info?.invoice_no || 'this sale')}
          </DialogTitle>
        </DialogHeader>
        {!info ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : info.supply ? (
          <div className="space-y-2 rounded-[6px] border border-[#C6DAF0] bg-[#F4F8FD] p-3 text-[12.5px]">
            <div className="font-extrabold text-[#1B4E82]">
              Bought from {String(info.supply.company)} — {String(info.supply.invoice_no)} of {formatDate(String(info.supply.sale_date))}
            </div>
            <div className="text-[#33473E]">
              {formatNum(Number(info.supply.qty))} MT · {formatINR(Number(info.supply.amount))} taxable — tied to {String(info.invoice_no)} to {String(info.customer)}.
            </div>
          </div>
        ) : !info.eligible ? (
          <p className="text-[12.5px] text-muted-foreground">Only a sale to an outside customer has a transfer behind it.</p>
        ) : (
          <div className="space-y-3 text-[12.5px]">
            <p className="text-[#5A6B62]">
              {String(info.invoice_no)} to <b>{String(info.customer)}</b> — the oil bought from our own company. This raises the supplier&rsquo;s sale to this company; the purchase here, its TDS and the tags follow it.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-[#33473E]">Bought from</span>
                <select value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-[12.5px] font-bold">
                  {(info.companies as Row[]).map((c) => (
                    <option key={String(c.id)} value={String(c.id)}>
                      {String(c.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-[#33473E]">
                  Their invoice no <span className="text-[#B3261E]">*</span>
                </span>
                <Input value={invNo} onChange={(e) => setInvNo(e.target.value.toUpperCase())} placeholder="e.g. KRFL/704" className="h-9 font-bold" autoFocus />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-bold text-[#33473E]">Date</span>
                <DatePicker value={date} onChange={(v) => setDate(v || '')} className="h-9" />
              </label>
            </div>
            <table className="w-full text-[12px]">
              <thead className="bg-[#EAF0E9] text-[10px] font-extrabold uppercase tracking-[.08em] text-[#33473E]">
                <tr>
                  <th className="px-2 py-1.5 text-left">Product</th>
                  <th className="px-2 py-1.5 text-right">Qty</th>
                  <th className="px-2 py-1.5 text-right">Transfer rate</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(info.lines as Row[]).map((l) => {
                  const v = lines[Number(l.id)] || { qty: '', rate: '' }
                  const set = (k: 'qty' | 'rate', x: string): void => setLines((p) => ({ ...p, [Number(l.id)]: { ...v, [k]: x.replace(/[^0-9.]/g, '') } }))
                  return (
                    <tr key={String(l.id)} className="border-t border-[#EEF3EC]">
                      <td className="px-2 py-1.5 font-bold">{String(l.product_name)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Input inputMode="decimal" value={v.qty} onChange={(e) => set('qty', e.target.value)} className="ml-auto h-8 w-24 text-right tabular-nums" />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input inputMode="decimal" value={v.rate} onChange={(e) => set('rate', e.target.value)} className="ml-auto h-8 w-32 text-right tabular-nums" title={`The sale's own rate is ${formatINR(Number(l.rate))}`} />
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold tabular-nums">{formatINR((Number(v.qty) || 0) * (Number(v.rate) || 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold text-[#33473E]">
                Tags <span className="text-[#B3261E]">*</span>
              </span>
              <TagDraftPicker value={tags} onChange={setTags} label="Tag this transfer" />
              {!tags.length && <span className="text-[11px] font-semibold text-[#B3261E]">compulsory</span>}
            </div>
            <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-3 py-2 text-[12px] font-semibold text-[#33473E]">
              {fromName} sells to this company <b className="tabular-nums">{formatINR(taxable)}</b> + GST under <b>{invNo.trim() || '…'}</b>; the same number is booked here as the purchase.
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          {info?.supply && (
            <Button variant="outline" className="mr-auto text-rose-600" onClick={() => void remove()} disabled={busy}>
              <Trash2 className="mr-1 h-4 w-4" /> Remove transfer
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {info && !info.supply && info.eligible && (
            <Button data-ctrl-a onClick={() => void raise()} disabled={busy || !ready}>
              {busy ? 'Raising…' : 'Raise transfer'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
