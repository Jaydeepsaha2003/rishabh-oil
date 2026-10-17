import { useEffect, useMemo, useState } from 'react'
import { Factory, Loader2, Search, Truck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate, formatINR, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

// The day before an ISO date — the opening of a period is the stock as that
// day closed.
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// STOCK MAPPING — which receipts a product's opening balance stands for.
//
// EVERY receipt up to the opening is listed, newest first, one row per tanker
// — a Bunge consignment draw as each of its tankers, with that tanker's own
// received date and quantity — with a running total down the list. FIFO's own
// answer (the newest tankers until the balance is covered) comes ticked, and
// the desk is free to tick and untick by hand, the same way loads are picked
// for a batch's FFA. The footer says what the ticked tankers come to against
// the balance, and at what average rate.
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
  const [data, setData] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  const openingQty = n(product?.opening) + n(product?.opening_adj)
  // Without a From date there is no opening to trace.
  const qty = canOpening ? openingQty : 0
  const asOf = canOpening ? dayBefore(range.from) : ''

  const keyOf = (l: Row): string => `${l.kind}-${l.id}-${l.tanker_id ?? ''}`
  useEffect(() => {
    if (!product) return
    setData(null)
    setErr(null)
    setPicked(new Set())
    setQ('')
    if (qty <= 1e-9) return
    setBusy(true)
    window.api.stock
      .fifoMap({ productId: Number(product.id), companyIds, asOf, qty, all: true })
      .then((d) => {
        setData(d)
        // FIFO's answer, ticked to start with.
        setPicked(new Set(((d?.lines as Row[]) || []).filter((l) => l.fifo).map(keyOf)))
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, qty, asOf, companyIds.join(',')])

  const lines = useMemo(() => (data?.lines as Row[]) || [], [data])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return lines
    return lines.filter((l) =>
      [l.party, l.tanker_no, l.invoice_no, l.bargain_no, l.company].some((x) => String(x || '').toLowerCase().includes(s))
    )
  }, [lines, q])
  const toggle = (k: string): void =>
    setPicked((s) => {
      const next = new Set(s)
      if (!next.delete(k)) next.add(k)
      return next
    })
  const latest = (k: number): void => setPicked(new Set(lines.slice(0, k).map(keyOf)))
  const fifoKeys = lines.filter((l) => l.fifo).map(keyOf)

  // What the ticked tankers come to: each at its full quantity, the way a
  // tanker is counted into stock — against the balance being traced.
  const chosen = lines.filter((l) => picked.has(keyOf(l)))
  const chosenQty = r3(chosen.reduce((s, l) => s + n(l.qty), 0))
  const chosenValue = chosen.reduce((s, l) => s + (n(l.rate) > 0 ? n(l.qty) * n(l.rate) : 0), 0)
  const chosenValuedQty = chosen.reduce((s, l) => s + (n(l.rate) > 0 ? n(l.qty) : 0), 0)
  const gap = r3(chosenQty - n(data?.qty))
  const allShownPicked = shown.length > 0 && shown.every((l) => picked.has(keyOf(l)))

  const th = 'px-2 py-2 text-left text-[10px] font-extrabold uppercase tracking-[.08em] text-[#33473E] whitespace-nowrap'
  const td = 'px-2 py-2 text-[12px] align-top'
  const quick = 'h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11.5px] font-extrabold uppercase tracking-[.04em] text-[#33473E] hover:bg-[#F7FAF6]'
  return (
    <Dialog open={!!product} onOpenChange={(o) => !o && onClose()}>
      <DialogContent readOnly className="max-h-[90vh] !w-[min(94vw,1180px)] !max-w-[min(94vw,1180px)] overflow-y-auto border-[#D6E2D6] bg-[#F2F6F1] p-0">
        <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Stock mapping</div>
          <DialogTitle className="mt-1 text-[18px] font-bold text-white">{String(product?.name || '')}</DialogTitle>
          <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
            Every receipt up to the opening, newest first, one row per tanker. FIFO&rsquo;s tankers come ticked — tick and untick to say which receipts the
            opening stands for.
          </p>
        </DialogHeader>
        <div className="grid gap-3.5 p-4">
          <div className="rounded-[5px] bg-[#0B3D2E] px-4 py-2.5 text-white">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-extrabold uppercase tracking-[.06em]">Opening</span>
              <span className="text-[14px] font-bold tabular-nums">{formatNum(openingQty)} MT</span>
            </div>
            <div className="text-[11px] font-semibold text-[#8FBFA8]">{canOpening ? `as ${formatDate(asOf)} closed` : 'pick a From date'}</div>
          </div>

          {qty <= 1e-9 ? (
            <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-6 text-center text-[13px] font-semibold text-[#5A6B62]">
              {!canOpening
                ? 'Pick a From date to trace the opening stock.'
                : qty < -1e-9
                  ? 'This balance is below nil — there is nothing in the tanks to trace back.'
                  : 'Nothing in stock here to trace back.'}
            </div>
          ) : busy ? (
            <div className="flex items-center justify-center gap-2 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-8 text-[13px] font-semibold text-[#5A6B62]">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the receipts…
            </div>
          ) : err ? (
            <div className="rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-bold text-[#B3261E]">{err}</div>
          ) : data ? (
            <>
              {/* Search and the quick picks, as on the FFA loads picker. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8CA396]" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search a party, tanker or invoice…"
                    className="h-8 w-full rounded-[4px] border border-[#D6E2D6] bg-white pl-8 pr-2 text-[12.5px] font-semibold outline-none focus:border-[#0B3D2E]"
                  />
                </div>
                <button type="button" className={quick} onClick={() => setPicked(new Set(fifoKeys))} title="The newest tankers until the opening is covered">
                  FIFO · {fifoKeys.length}
                </button>
                <button type="button" className={quick} onClick={() => latest(3)}>
                  Latest 3
                </button>
                <button type="button" className={quick} onClick={() => latest(5)}>
                  Latest 5
                </button>
                <button type="button" className={quick} onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              </div>

              <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
                <div className="max-h-[52vh] overflow-auto">
                  <table className="w-full min-w-[920px] border-collapse lg:min-w-0">
                    <thead className="sticky top-0 z-[1] border-b border-[#E4ECE3] bg-[#F7FAF6]">
                      <tr>
                        <th className={cn(th, 'w-8')}>
                          <input
                            type="checkbox"
                            aria-label="Tick every row shown"
                            checked={allShownPicked}
                            onChange={() =>
                              setPicked((s) => {
                                const next = new Set(s)
                                for (const l of shown) {
                                  if (allShownPicked) next.delete(keyOf(l))
                                  else next.add(keyOf(l))
                                }
                                return next
                              })
                            }
                            className="h-4 w-4 cursor-pointer accent-[#12855A]"
                          />
                        </th>
                        <th className={th}>R. Date</th>
                        <th className={th}>Party</th>
                        <th className={th}>Tanker</th>
                        <th className={th}>Invoice no</th>
                        <th className={cn(th, 'text-right')}>Rate /MT</th>
                        <th className={cn(th, 'text-right')}>R. Qty</th>
                        <th className={cn(th, 'text-right')}>Cumulative</th>
                        <th className={cn(th, 'text-right')}>FIFO</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#EEF3ED]">
                      {shown.map((l) => {
                        const bought = l.kind === 'purchase'
                        const on = picked.has(keyOf(l))
                        return (
                          <tr key={keyOf(l)} onClick={() => toggle(keyOf(l))} className={cn('cursor-pointer', on ? 'bg-[#E8F3EC]' : 'hover:bg-[#FBFCFA]')}>
                            <td className={td}>
                              <input
                                type="checkbox"
                                aria-label={`Tick ${String(l.tanker_no || l.invoice_no || 'this receipt')}`}
                                checked={on}
                                onChange={() => toggle(keyOf(l))}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 cursor-pointer accent-[#12855A]"
                              />
                            </td>
                            <td className={cn(td, 'whitespace-nowrap tabular-nums')}>
                              {formatDate(String(l.r_date || l.date))}
                              {bought && l.invoice_date && l.invoice_date !== (l.r_date || l.date) && (
                                <div className="text-[10.5px] font-semibold text-[#5A6B62]">inv {formatDate(String(l.invoice_date))}</div>
                              )}
                            </td>
                            <td className={cn(td, 'max-w-[220px]')}>
                              <div className="truncate font-semibold" title={String(l.party || '')}>
                                {bought ? String(l.party || '—') : 'Production'}
                              </div>
                              {l.company && <div className="truncate text-[10.5px] font-semibold text-[#5A6B62]">{String(l.company)}</div>}
                            </td>
                            <td className={cn(td, 'min-w-[120px] max-w-[190px] font-semibold')}>
                              {bought ? (
                                <span className="inline-flex items-start gap-1">
                                  <Truck className="mt-0.5 h-3.5 w-3.5 flex-none text-[#5A6B62]" />
                                  <span>
                                    {String(l.tanker_no || (l.consignment ? 'Consignment' : '—'))}
                                    {l.consignment && l.tanker_no && <span className="block text-[10px] font-bold uppercase text-[#8A5300]">consignment</span>}
                                  </span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[#1B4E82]">
                                  <Factory className="h-3.5 w-3.5" /> {l.kind === 'by-product' ? 'By-product' : 'Produced'} #{l.id}
                                </span>
                              )}
                            </td>
                            <td className={cn(td, 'doc-ref min-w-[110px] max-w-[170px] font-bold')}>
                              {bought ? (l.uninvoiced ? <span className="text-[11px] font-extrabold uppercase text-[#8A5300]">Not invoiced</span> : String(l.invoice_no || '—')) : '—'}
                              {l.invoiced_later && (
                                <div className="text-[10px] font-extrabold uppercase text-[#8A5300]">invoiced after the opening</div>
                              )}
                              {bought && l.bargain_no && <div className="break-all text-[10.5px] font-semibold text-[#5A6B62]">{String(l.bargain_no)}</div>}
                            </td>
                            <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>{n(l.rate) > 0 ? formatINR(n(l.rate)) : '—'}</td>
                            <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums')}>{formatNum(n(l.r_qty ?? l.qty))} MT</td>
                            <td className={cn(td, 'whitespace-nowrap text-right tabular-nums text-[#0B6B45]')}>{formatNum(n(l.running))} MT</td>
                            <td className={cn(td, 'whitespace-nowrap text-right text-[11px] font-bold')}>
                              {l.fifo ? (
                                <span className={l.partly ? 'text-[#8A5300]' : 'text-[#0B6B45]'}>{l.partly ? `${formatNum(n(l.taken))} of it` : 'in it'}</span>
                              ) : l.uninvoiced || l.invoiced_later ? (
                                <span className="text-[10px] font-extrabold uppercase text-[#8A5300]" title="Not in our stock at the opening — the stock count takes a consignment in on its invoice">
                                  not ours yet
                                </span>
                              ) : (
                                <span className="text-[#C3D2C6]">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                      {!shown.length && (
                        <tr>
                          <td colSpan={9} className="px-4 py-6 text-center text-[13px] font-semibold text-[#5A6B62]">
                            {lines.length ? 'No receipt matches the search.' : 'No receipt on the books up to the opening.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* What the ticked tankers come to, against the balance. */}
              <section className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[6px] border border-[#BFD9C8] bg-[#E8F3EC] px-4 py-2.5 text-[12.5px] font-bold text-[#0A1F17]">
                <span>
                  {chosen.length} {chosen.length === 1 ? 'tanker' : 'tankers'} ticked
                </span>
                <span className="tabular-nums">Σ {formatNum(chosenQty)} MT</span>
                <span className={cn('tabular-nums', Math.abs(gap) < 0.0005 ? 'text-[#0B6B45]' : gap > 0 ? 'text-[#8A5300]' : 'text-[#B3261E]')}>
                  {Math.abs(gap) < 0.0005 ? 'equals the opening' : gap > 0 ? `${formatNum(gap)} MT more than the opening` : `${formatNum(-gap)} MT short of the opening`}
                </span>
                <span className="tabular-nums text-[#33473E]">avg {chosenValuedQty > 0 ? `${formatINR(chosenValue / chosenValuedQty)}/MT` : '—'}</span>
                <span className="tabular-nums text-[#33473E]">value {chosenValue > 0 ? formatINR(chosenValue) : '—'}</span>
              </section>
              {n(data.from_opening) > 0.0005 && (
                <p className="text-[11.5px] font-semibold text-[#8A5300]">
                  The receipts on the books come to less than the opening — {formatNum(n(data.from_opening))} MT of it is older than every entry here, carried in by the opening count.
                </p>
              )}
              <p className="text-[11.5px] font-semibold leading-relaxed text-[#5A6B62]">
                R. Date is the day the tanker was emptied (deposited, for consignment — every consignment tanker is listed from that day, invoiced or not); R. Qty what it brought. Cumulative adds every receipt up from the newest.
                Counted up to {formatDate(asOf)} across the selected factory&rsquo;s companies.
              </p>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
