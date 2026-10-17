import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRight, Check, Info, Loader2, Search, Shuffle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { errText, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// MOVE A BARGAIN'S OPEN BALANCE TO ANOTHER PRODUCT.
//
// A bargain's product is locked once anything is drawn on it. What is left can
// still be struck again under another product: this panel does both halves in
// one save — a new bargain for the quantity, and the same quantity off this
// one — see moveBargainBalance / moveSalesBargainBalance.
export function BargainMoveBalanceDialog({
  kind,
  bargain,
  products,
  onClose,
  onDone
}: {
  kind: 'purchase' | 'sales'
  // id, bargain_no, uom, rate, productId, productName, party, balance
  bargain: Row | null
  // What the page's own New bargain form offers, so this offers the same.
  products: Row[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [to, setTo] = useState<number | null>(null)
  const [find, setFind] = useState('')
  const [qty, setQty] = useState('')
  const [rate, setRate] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const id = Number(bargain?.id) || 0
  const uom = String(bargain?.uom || 'MT')
  const open = Math.round((Number(bargain?.balance) || 0) * 1000) / 1000
  const oldRate = Number(bargain?.rate) || 0

  // A fresh panel for each bargain, starting at its whole balance and rate.
  useEffect(() => {
    if (!id) return
    setTo(null)
    setFind('')
    setQty(open > 0 ? String(open) : '')
    setRate(oldRate ? String(oldRate) : '')
    setDate(todayISO())
    setNote('')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const options = useMemo(() => {
    const f = find.trim().toLowerCase()
    return products
      .filter((p) => Number(p.id) !== Number(bargain?.productId))
      .filter((p) => !f || String(p.name || '').toLowerCase().includes(f) || String(p.code || '').toLowerCase().includes(f))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }, [products, find, bargain?.productId])

  const q = Math.round((Number(qty) || 0) * 1000) / 1000
  const r = Number(rate) || 0
  const target = products.find((p) => Number(p.id) === to)
  const need: string[] = []
  if (!to) need.push('the product to move it to')
  if (q <= 0) need.push('a quantity')
  else if (q > open + 1e-6) need.push(`a quantity no more than the ${formatNum(open)} ${uom} open`)
  if (r <= 0) need.push('a rate')
  const ready = !need.length && !busy

  async function save(): Promise<void> {
    if (!ready || !to) return
    setBusy(true)
    setError(null)
    try {
      const values = { qty: q, rate: r, date, note, ...(kind === 'purchase' ? { oil_type_id: to } : { product_id: to }) }
      const made =
        kind === 'purchase'
          ? await window.api.bargains.moveBalance(id, values)
          : await window.api.salesBargains.moveBalance(id, values)
      toast.success(`Moved ${formatNum(made.moved)} ${uom} to ${made.bargain_no}`)
      onDone()
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const label = (t: string): React.JSX.Element => (
    <div className="mb-1.5 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{t}</div>
  )

  return (
    <Dialog open={!!bargain} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          '!grid !max-h-[90vh] !w-[560px] !max-w-[95vw] !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !bg-[#F1F5EF] !p-0 [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100',
          __WEB__ &&
            '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !translate-x-0 !translate-y-0 !rounded-none !border-0 max-sm:!max-w-full sm:!rounded-none'
        )}
      >
        <DialogHeader className="!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
            {kind === 'purchase' ? 'Purchase bargain' : 'Sales bargain'} · move balance
          </div>
          <DialogTitle className="!mt-1.5 !text-[19px] !font-extrabold !tracking-[-0.02em] !text-white">
            Move the balance to another product
          </DialogTitle>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="doc-ref break-all text-[12.5px] font-bold text-[#D9EFE2]">{String(bargain?.bargain_no || '')}</span>
            {!!bargain?.party && <span className="text-[12px] font-semibold text-[#A9CDBB]">{String(bargain.party)}</span>}
          </div>
          <p className="mt-2.5 text-[11.5px] font-semibold leading-[1.6] text-[#A9CDBB] [text-wrap:pretty]">
            A new bargain is struck for the chosen product and the same quantity comes off this one, in one save.
            What is already {kind === 'purchase' ? 'received' : 'dispatched'} stays on this bargain.
          </p>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-[22px] py-4">
          <div className="flex flex-col gap-4">
            {/* WHAT IS OPEN */}
            <div className="flex items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Open on this bargain</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-[22px] font-bold tabular-nums tracking-[-0.02em] text-[#0A1F17]">{formatNum(open)}</span>
                  <span className="text-[11px] font-bold text-[#5A6B62]">{uom}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Product</div>
                <div className="mt-1 text-[13px] font-extrabold text-[#0A1F17]">{String(bargain?.productName || '—')}</div>
                <div className="doc-ref text-[11px] font-semibold text-[#5A6B62]">
                  {formatINR(oldRate)}/{uom}
                </div>
              </div>
            </div>

            {open <= 0 && (
              <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                Nothing is open on this bargain, so there is nothing to move.
              </div>
            )}

            {/* 1 · THE PRODUCT */}
            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div className="flex items-center gap-2 border-b border-[#E4ECE3] px-4 py-2.5">
                <span className="text-[12px] font-extrabold text-[#33473E]">
                  <span className="mr-1.5 text-[#5A6B62]">1</span> Move to
                </span>
                <span className="ml-auto min-w-0 truncate text-[12px] font-extrabold text-[#0B6B45]">{String(target?.name || '')}</span>
              </div>
              <div className="border-b border-[#EFF3EE] p-2.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5A6B62]" />
                  <Input
                    autoFocus
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    placeholder="Find a product"
                    className="!h-10 !rounded-[4px] !pl-9 !text-[13px]"
                  />
                </div>
              </div>
              <div className="max-h-[220px] overflow-y-auto p-1.5">
                {options.map((p) => {
                  const on = Number(p.id) === to
                  return (
                    <button
                      key={String(p.id)}
                      type="button"
                      onClick={() => setTo(Number(p.id))}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-[4px] border px-2.5 py-2 text-left transition-colors',
                        on ? 'border-[#CDE89A] bg-[#F3FBE2]' : 'border-transparent hover:bg-[#F7FAF6]'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px]',
                          on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white'
                        )}
                      >
                        {on && <Check className="h-[11px] w-[11px]" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#0A1F17]">{String(p.name)}</span>
                      {!!p.material_type && (
                        <span className="flex-none text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#8CA396]">
                          {String(p.material_type)}
                        </span>
                      )}
                    </button>
                  )
                })}
                {!options.length && <div className="px-2.5 py-4 text-[12px] font-semibold text-[#5A6B62]">No product matches.</div>}
              </div>
            </div>

            {/* 2 · HOW MUCH, AT WHAT, WHEN */}
            <div className="grid grid-cols-2 gap-3 rounded-[4px] border border-[#D6E2D6] bg-white p-4">
              <div>
                {label(`Quantity (${uom})`)}
                <div className="flex gap-1.5">
                  <Input
                    inputMode="decimal"
                    value={qty}
                    onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                    className="!h-10 !min-w-0 !flex-1 !rounded-[4px] !text-[14px] !font-bold !tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => setQty(String(open))}
                    title="The whole open balance"
                    className="h-10 flex-none rounded-[4px] border border-[#C3D2C6] px-2.5 text-[11px] font-extrabold uppercase text-[#33473E] hover:bg-[#F7FAF6]"
                  >
                    All
                  </button>
                </div>
              </div>
              <div>
                {label(`Rate (₹/${uom})`)}
                <Input
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
                  className="!h-10 !rounded-[4px] !text-[14px] !font-bold !tabular-nums"
                />
              </div>
              <div>
                {label('New bargain dated')}
                <DatePicker value={date} onChange={(v) => setDate(v || todayISO())} className="!h-10 !rounded-[4px]" />
              </div>
              <div>
                {label('Note (optional)')}
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it moved" className="!h-10 !rounded-[4px] !text-[13px]" />
              </div>
            </div>

            {/* AFTER THE MOVE */}
            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div className="border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">
                After the move
              </div>
              <div className="flex items-stretch gap-2 p-3.5">
                <div className="min-w-0 flex-1 rounded-[4px] border border-[#EAF0E9] px-3 py-2.5">
                  <div className="truncate text-[11px] font-bold text-[#5A6B62]">{String(bargain?.productName || 'This bargain')}</div>
                  <div className="mt-1 text-[16px] font-bold tabular-nums text-[#0A1F17]">
                    {formatNum(Math.max(0, open - (q > 0 ? q : 0)))} <span className="text-[11px] font-semibold text-[#5A6B62]">{uom} open</span>
                  </div>
                  <div className="text-[11px] font-semibold text-[#8A5300]">−{formatNum(q > 0 ? q : 0)} adjusted</div>
                </div>
                <ArrowRight className="h-5 w-5 flex-none self-center text-[#8CA396]" />
                <div className={cn('min-w-0 flex-1 rounded-[4px] border px-3 py-2.5', target ? 'border-[#CDE89A] bg-[#F7FCEB]' : 'border-dashed border-[#DCE7DB]')}>
                  <div className="truncate text-[11px] font-bold text-[#0B6B45]">{target ? `New · ${String(target.name)}` : 'New bargain'}</div>
                  <div className="mt-1 text-[16px] font-bold tabular-nums text-[#0A1F17]">
                    {formatNum(q > 0 ? q : 0)} <span className="text-[11px] font-semibold text-[#5A6B62]">{uom}</span>
                  </div>
                  <div className="doc-ref text-[11px] font-semibold text-[#5A6B62]">{formatINR((q > 0 ? q : 0) * r)}</div>
                </div>
              </div>
              <div className="flex items-start gap-2 border-t border-[#EFF3EE] px-4 py-2.5">
                <Info className="mt-px h-4 w-4 flex-none text-[#8CA396]" />
                <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                  The new bargain keeps this one&apos;s {kind === 'purchase' ? 'supplier, broker, EX/FOR terms' : 'customer, freight and GST terms'},
                  company and shortage allowance, and each bargain&apos;s history names the other. Edit the new bargain afterwards if a
                  term differs for the new product.
                </span>
              </div>
            </div>

            {error && (
              <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
          <span className={cn('min-w-0 flex-1 text-[12px] font-bold', need.length ? 'text-[#8A5300]' : 'text-[#0B6B45]')}>
            {busy ? 'Moving…' : need.length ? `Needs ${need.join(' and ')}.` : 'Ready to move.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 rounded-[4px] border-[1.5px] border-[#C3D2C6] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E] hover:bg-[#F7FAF6] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!ready}
            className="flex h-11 items-center gap-2 rounded-[4px] bg-[#0B6B45] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-white hover:bg-[#095A3A] disabled:cursor-not-allowed disabled:bg-[#9DB8A9]"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
            Move {q > 0 ? `${formatNum(q)} ${uom}` : ''}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
