import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Percent } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errText, formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const LAST_LEDGER = 'sales.tdsLedger'
const lastLedger = (): string => {
  try {
    return localStorage.getItem(LAST_LEDGER) || ''
  } catch {
    return ''
  }
}

// DID THE CUSTOMER DEDUCT TDS? Asked after an invoice is saved, and from the
// invoice's ⋮ menu. A sale posts no TDS of its own; when the customer withholds
// it, Yes posts a Journal — Dr the TDS ledger picked here, Cr the customer —
// Agst Ref the invoice, so Bill-wise shows the bill settled by it. The amount
// is offered off the customer master's TDS terms and can be changed.
export function SaleTdsDialog({
  saleId,
  afterSave,
  onClose,
  onDone
}: {
  saleId: number | null
  /** Opened straight after a save: "No" reads as "not deducted", not "cancel". */
  afterSave?: boolean
  onClose: () => void
  onDone?: () => void
}): React.JSX.Element {
  const [info, setInfo] = useState<Row | null>(null)
  const [amount, setAmount] = useState('')
  const [ledger, setLedger] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setInfo(null)
    if (!saleId) return
    let live = true
    window.api.sales
      .tdsPreview(saleId)
      .then((r) => {
        if (!live) return
        setInfo(r)
        const ex = r.existing as Row | null
        setAmount(String(ex ? ex.amount : r.amount || ''))
        const names = (r.ledgers as Row[]).map((l) => String(l.name))
        const remembered = lastLedger()
        setLedger(ex ? String(ex.ledger) : names.includes(remembered) ? remembered : String(r.suggested_ledger || ''))
        setDate(String(ex ? ex.date : r.date).slice(0, 10))
      })
      .catch((e) => {
        toast.error(errText(e))
        onClose()
      })
    return () => {
      live = false
    }
  }, [saleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const ex = (info?.existing as Row | null) || null
  const post = async (): Promise<void> => {
    if (!info) return
    setBusy(true)
    try {
      await window.api.sales.tdsPost({ sale_id: Number(info.sale_id), amount: Number(amount), ledger, date })
      try {
        localStorage.setItem(LAST_LEDGER, ledger)
      } catch {
        /* a convenience only */
      }
      toast.success(`TDS ${formatINR(Number(amount))} posted against ${info.invoice_no}`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!info || !window.confirm(`Remove the TDS journal on ${info.invoice_no}?`)) return
    setBusy(true)
    try {
      await window.api.sales.tdsRemove(Number(info.sale_id))
      toast.success('TDS journal removed')
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const pct = Number(info?.pct) || 0
  return (
    <Dialog open={!!saleId} onOpenChange={(o) => !o && !busy && onClose()}>
      {/* Above the window it is opened from (the trading deal is a dialog too). */}
      <DialogContent className="z-[60] max-w-lg" overlayClassName="z-[60]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Percent className="h-4 w-4 text-[#C2700A]" />
            {afterSave && !ex ? 'Does the customer deduct TDS?' : 'TDS deducted by the customer'}
          </DialogTitle>
        </DialogHeader>
        {!info ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid gap-3">
            <div className="rounded-md border border-[#E3E9E2] bg-[#F7FAF6] px-3 py-2 text-[12.5px]">
              <div className="flex justify-between gap-2">
                <span className="font-semibold text-[#0B3D2E]">{info.invoice_no}</span>
                <span className="text-muted-foreground">{formatDate(info.date)}</span>
              </div>
              <div className="truncate text-[#33473E]">{info.customer}</div>
              <div className="mt-1 flex justify-between text-[11.5px] text-muted-foreground">
                <span>Taxable {formatINR(info.base)}</span>
                <span>Earlier this FY {formatINR(info.prior)}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                {pct > 0
                  ? `Customer master: ${pct}%${Number(info.threshold) > 0 ? ` past ${formatINR(info.threshold)}` : ''}${info.above_only ? ', on the amount above only' : ''}`
                  : 'No TDS rate on the customer master — enter the amount they deducted.'}
              </div>
            </div>
            {ex && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                Posted already: Journal {ex.vch_no || ''} of {formatINR(ex.amount)} on {formatDate(ex.date)}. Saving
                again replaces it.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
              <div className="grid gap-1.5">
                <Label>TDS amount</Label>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <DatePicker value={date} min={String(info.date)} onChange={(v) => setDate(String(v || ''))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>TDS ledger (Dr)</Label>
              <Select value={ledger} onValueChange={setLedger}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick the TDS ledger" />
                </SelectTrigger>
                <SelectContent>
                  {(info.ledgers as Row[]).map((l) => (
                    <SelectItem key={String(l.name)} value={String(l.name)}>
                      {String(l.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Journal: Dr {ledger || 'TDS ledger'} / Cr {info.customer}, Agst Ref {info.invoice_no}.
              </p>
            </div>
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:space-x-0">
          {ex && (
            <Button variant="outline" className="mr-auto text-rose-600" onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          )}
          {/* Not known yet: the invoice keeps its No TDS tag, which opens this again. */}
          {afterSave && !ex && (
            <Button
              variant="outline"
              className="mr-auto"
              disabled={busy}
              onClick={() => {
                toast.info(`TDS on ${info?.invoice_no || 'this invoice'} left for later — click its No TDS tag on Sales to enter it`)
                onClose()
              }}
            >
              Mark TDS later
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {afterSave && !ex ? 'No, not deducted' : 'Close'}
          </Button>
          <Button onClick={() => void post()} disabled={busy || !info || !ledger || !(Number(amount) > 0)}>
            {busy ? 'Posting…' : ex ? 'Update journal' : 'Yes, post journal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
