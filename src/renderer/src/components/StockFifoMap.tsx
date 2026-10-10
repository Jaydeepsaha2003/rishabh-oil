import { useEffect, useState } from 'react'
import { Factory, Loader2, Truck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The day before an ISO date — the opening of a period is the stock as that
// day closed.
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// STOCK MAPPING — a product's balance read back to the entries it came from,
// first in first out: the newest tanker's whole quantity, then the one
// before, until the balance is covered (the last one reached only partly).
// The Opening of the period or its Closing, whichever is picked.
export function StockFifoMap({
  product,
  range,
  companyIds,
  onClose
}: {
  product: Row | null
  range: { from: string; to: string }
  companyIds: number[]
  onClose: () => void
}): React.JSX.Element {
  const canOpening = !!range.from
  const [which, setWhich] = useState<'opening' | 'closing'>('opening')
  const [data, setData] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const openingQty = n(product?.opening) + n(product?.opening_adj)
  const closingQty = n(product?.stock)
  const qty = which === 'opening' ? openingQty : closingQty
  const asOf = which === 'opening' ? (range.from ? dayBefore(range.from) : '') : range.to || todayISO()

  useEffect(() => {
    if (product) setWhich(canOpening && Math.abs(openingQty) > 1e-9 ? 'opening' : 'closing')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id])

  useEffect(() => {
    if (!product) return
    setData(null)
    setErr(null)
    setPicked(new Set())
    if (qty <= 1e-9) return
    setBusy(true)
    window.api.stock
      .fifoMap({ productId: Number(product.id), companyIds, asOf, qty })
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, which, qty, asOf, companyIds.join(',')])

  const lines = (data?.lines as Row[]) || []
  const keyOf = (l: Row): string => `${l.kind}-${l.id}-${l.tanker_id ?? ''}`
  const toggle = (k: string): void =>
    setPicked((s) => {
      const next = new Set(s)
      if (!next.delete(k)) next.add(k)
      return next
    })
  const chosen = lines.filter((l) => picked.has(keyOf(l)))
  const chosenQty = chosen.reduce((s, l) => s + n(l.taken), 0)
  const chosenValue = chosen.reduce((s, l) => s + n(l.value), 0)
  const chosenValuedQty = chosen.reduce((s, l) => s + (n(l.value) > 0 ? n(l.taken) : 0), 0)
  const allPicked = lines.length > 0 && chosen.length === lines.length
  const lbl = 'text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  const th = 'px-2 py-2 text-left text-[10px] font-extrabold uppercase tracking-[.08em] text-[#33473E] whitespace-nowrap'
  const td = 'px-2 py-2 text-[12px] align-top'
  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] !w-[min(94vw,1120px)] !max-w-[min(94vw,1120px)] overflow-y-auto border-[#D6E2D6] bg-[#F2F6F1] p-0">
        <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Stock mapping · FIFO</div>
          <DialogTitle className="mt-1 text-[18px] font-bold text-white">{String(product?.name || '')}</DialogTitle>
          <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
            First in, first out: what is left in the tanks is what came in last. The balance is read back from the newest entry down until it is covered.
          </p>
        </DialogHeader>
        <div className="grid gap-3.5 p-4">
          {/* Which balance */}
          <div className="grid grid-cols-2 gap-1 rounded-[5px] border border-[#D6E2D6] bg-white p-1">
            {[
              { k: 'opening' as const, t: 'Opening', s: range.from ? `as ${formatDate(dayBefore(range.from))} closed` : 'pick a From date', v: openingQty, off: !canOpening },
              { k: 'closing' as const, t: 'Closing', s: `as on ${formatDate(range.to || todayISO())}`, v: closingQty, off: false }
            ].map((o) => (
              <button
                key={o.k}
                type="button"
                disabled={o.off}
                onClick={() => setWhich(o.k)}
                className={cn(
                  'rounded-[4px] px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  which === o.k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F7FAF6]'
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-extrabold uppercase tracking-[.06em]">{o.t}</span>
                  <span className="text-[14px] font-bold tabular-nums">{formatNum(o.v)} MT</span>
                </div>
                <div className={cn('text-[11px] font-semibold', which === o.k ? 'text-[#8FBFA8]' : 'text-[#5A6B62]')}>{o.s}</div>
              </button>
            ))}
          </div>

          {qty <= 1e-9 ? (
            <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-6 text-center text-[13px] font-semibold text-[#5A6B62]">
              {qty < -1e-9
                ? 'This balance is below nil — there is nothing in the tanks to trace back.'
                : 'Nothing in stock here to trace back.'}
            </div>
          ) : busy ? (
            <div className="flex items-center justify-center gap-2 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-8 text-[13px] font-semibold text-[#5A6B62]">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the entries…
            </div>
          ) : err ? (
            <div className="rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-bold text-[#B3261E]">{err}</div>
          ) : data ? (
            <>
              <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
                <div className="grid grid-cols-2 divide-x divide-y divide-[#E4ECE3] sm:grid-cols-5 sm:divide-y-0">
                  {[
                    { k: 'Balance to trace', v: `${formatNum(n(data.qty))} MT` },
                    { k: `Covered by ${lines.length} ${lines.length === 1 ? 'entry' : 'entries'}`, v: `${formatNum(n(data.covered))} MT`, tone: 'text-[#0B6B45]' },
                    {
                      k: 'Older than the books',
                      v: n(data.from_opening) > 0.0005 ? `${formatNum(n(data.from_opening))} MT` : '—',
                      tone: n(data.from_opening) > 0.0005 ? 'text-[#8A5300]' : 'text-[#8CA396]'
                    },
                    { k: 'Avg purchase rate', v: data.avg_rate != null ? `${formatINR(n(data.avg_rate))}/MT` : '—' },
                    { k: 'Value at those rates', v: n(data.value) > 0 ? formatINR(n(data.value)) : '—' }
                  ].map((c) => (
                    <div key={c.k} className="min-w-0 px-3.5 py-2.5">
                      <div className={cn(lbl, 'truncate')}>{c.k}</div>
                      <div className={cn('mt-1 truncate text-[14.5px] font-bold tabular-nums', c.tone || 'text-[#0A1F17]')}>{c.v}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] border-collapse lg:min-w-0">
                    <thead className="border-b border-[#E4ECE3] bg-[#F7FAF6]">
                      <tr>
                        <th className={cn(th, 'w-8')}>
                          <input
                            type="checkbox"
                            aria-label="Select all tankers"
                            checked={allPicked}
                            onChange={() => setPicked(allPicked ? new Set() : new Set(lines.map(keyOf)))}
                            className="h-4 w-4 cursor-pointer accent-[#12855A]"
                          />
                        </th>
                        <th className={th}>#</th>
                        <th className={th}>Received</th>
                        <th className={th}>Tanker no</th>
                        <th className={th}>Invoice no</th>
                        <th className={th}>Supplier</th>
                        <th className={cn(th, 'text-right')}>Rate /MT</th>
                        <th className={cn(th, 'text-right')}>Entry qty</th>
                        <th className={cn(th, 'text-right')}>In this stock</th>
                        <th className={cn(th, 'text-right')}>Cumulative</th>
                        <th className={cn(th, 'text-right')}>Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#EEF3ED]">
                      {lines.map((l, i) => {
                        const bought = l.kind === 'purchase'
                        return (
                          <tr
                            key={keyOf(l)}
                            onClick={() => toggle(keyOf(l))}
                            className={cn('cursor-pointer', picked.has(keyOf(l)) ? 'bg-[#E8F3EC]' : l.partly && 'bg-[#FFFBF2]')}
                          >
                            <td className={td}>
                              <input
                                type="checkbox"
                                aria-label={`Select ${String(l.tanker_no || `entry ${i + 1}`)}`}
                                checked={picked.has(keyOf(l))}
                                onChange={() => toggle(keyOf(l))}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 cursor-pointer accent-[#12855A]"
                              />
                            </td>
                            <td className={cn(td, 'font-bold text-[#5A6B62]')}>{i + 1}</td>
                            <td className={cn(td, 'whitespace-nowrap tabular-nums')}>
                              {formatDate(String(l.date))}
                              {bought && l.invoice_date && l.invoice_date !== l.date && (
                                <div className="text-[10.5px] font-semibold text-[#5A6B62]">inv {formatDate(String(l.invoice_date))}</div>
                              )}
                            </td>
                            <td className={cn(td, 'min-w-[120px] max-w-[190px] font-semibold')}>
                              {bought ? (
                                <span className="inline-flex items-start gap-1">
                                  <Truck className="mt-0.5 h-3.5 w-3.5 flex-none text-[#5A6B62]" />
                                  {String(l.tanker_no || (l.consignment ? 'Consignment' : '—'))}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[#1B4E82]">
                                  <Factory className="h-3.5 w-3.5" /> {l.kind === 'by-product' ? 'By-product' : 'Produced'} #{l.id}
                                </span>
                              )}
                            </td>
                            <td className={cn(td, 'doc-ref min-w-[110px] max-w-[170px] font-bold')}>
                              {bought ? String(l.invoice_no || '—') : '—'}
                              {bought && l.bargain_no && <div className="break-all text-[10.5px] font-semibold text-[#5A6B62]">{String(l.bargain_no)}</div>}
                            </td>
                            <td className={cn(td, 'max-w-[200px]')}>
                              <div className="truncate font-semibold" title={String(l.party || '')}>{bought ? String(l.party || '—') : 'Production'}</div>
                              {l.company && <div className="truncate text-[10.5px] font-semibold text-[#5A6B62]">{String(l.company)}</div>}
                            </td>
                            <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>{l.rate != null && n(l.rate) > 0 ? formatINR(n(l.rate)) : '—'}</td>
                            <td className={cn(td, 'whitespace-nowrap text-right tabular-nums text-[#5A6B62]')}>{formatNum(n(l.qty))}</td>
                            <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums')}>
                              {formatNum(n(l.taken))}
                              {l.partly && <div className="text-[10.5px] font-semibold text-[#8A5300]">part of it</div>}
                            </td>
                            <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums text-[#0B6B45]')}>{formatNum(n(l.cumulative))}</td>
                            <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>{l.value != null && n(l.value) > 0 ? formatINR(n(l.value)) : '—'}</td>
                          </tr>
                        )
                      })}
                      {n(data.from_opening) > 0.0005 && (
                        <tr className="bg-[#FFF8E9]">
                          <td className={td} />
                          <td className={td} />
                          <td colSpan={6} className={cn(td, 'font-semibold text-[#8A5300]')}>
                            Older than every entry on the books — carried in by the opening count
                          </td>
                          <td className={cn(td, 'text-right font-bold tabular-nums text-[#8A5300]')}>{formatNum(n(data.from_opening))}</td>
                          <td className={cn(td, 'text-right font-bold tabular-nums text-[#0B6B45]')}>{formatNum(n(data.qty))}</td>
                          <td className={td} />
                        </tr>
                      )}
                      {!lines.length && n(data.from_opening) <= 0.0005 && (
                        <tr>
                          <td colSpan={11} className="px-4 py-6 text-center text-[13px] font-semibold text-[#5A6B62]">No entry found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
              {chosen.length > 0 && (
                <section className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[6px] border border-[#BFD9C8] bg-[#E8F3EC] px-4 py-2.5 text-[12.5px] font-bold text-[#0A1F17]">
                  <span>
                    {chosen.length} {chosen.length === 1 ? 'tanker' : 'tankers'} selected
                  </span>
                  <span className="tabular-nums">{formatNum(chosenQty)} MT</span>
                  <span className="tabular-nums">{chosenValue > 0 ? formatINR(chosenValue) : '—'}</span>
                  <span className="tabular-nums text-[#33473E]">
                    avg {chosenValuedQty > 0 ? `${formatINR(chosenValue / chosenValuedQty)}/MT` : '—'}
                  </span>
                  <button type="button" onClick={() => setPicked(new Set())} className="ml-auto text-[12px] font-bold text-[#0B6B45] hover:underline">
                    Clear
                  </button>
                </section>
              )}
              <p className="text-[11.5px] font-semibold leading-relaxed text-[#5A6B62]">
                Counted from receipts into stock (dated the day the tanker was emptied) and production, up to {formatDate(asOf)}, across the selected factory&rsquo;s companies. One row per tanker — an invoice&rsquo;s quantity is shared over its tankers. The row shaded amber is the oldest one reached — only part of it is still in stock. Tick rows to total them.
              </p>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
