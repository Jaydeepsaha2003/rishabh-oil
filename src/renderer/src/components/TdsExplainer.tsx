// Why the TDS on this deal is the figure it is.
// -----------------------------------------------------------------------------
// A withholding figure is the one number on a trading deal nobody can check by
// eye: it is not the rate times the invoice, because the party's yearly slab
// decides how much of the invoice the rate even applies to, and that depends
// on what was billed to the same party earlier in the year — which is not on
// this screen, or any screen. So it gets asked about, and answered by somebody
// opening a ledger.
//
// This is that answer, written out: where the party stood before the deal, the
// slab, how each invoice split against it, and what that comes to — beside
// what was actually posted, so the two can be compared rather than trusted.
import React, { useEffect, useMemo, useState } from 'react'
import { Info, Loader2, TrendingDown, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatINR, formatNum } from '@/lib/format'
import { walkSlab } from '@/lib/tdsSlab'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// One party's side of the question: who, at what rate, on which invoices, and
// what the books say was withheld.
export type TdsParty = {
  partyId: number
  name: string
  pct: number
  // 'total' — goods + GST (+ the round-off, which rides the first invoice).
  // What a PURCHASE withholds on.
  // 'taxable' — the goods alone. Every SALE withholds on this: GST is the
  // government's money passing through, and withholding on it would be tax on
  // tax.
  on: 'total' | 'taxable'
  gstPct: number
  roundOff: number
  // The deal's own invoices to this party, oldest first.
  invoices: { id: number; label: string; taxable: number }[]
  // What the invoices actually carry.
  posted: number
  // The party master's slab.
  threshold: number
  aboveOnly: boolean
}

export function TdsExplainer({
  open,
  onClose,
  side,
  dealDate,
  parties
}: {
  open: boolean
  onClose: () => void
  side: 'purchase' | 'sale'
  dealDate: string
  parties: TdsParty[]
}): React.JSX.Element {
  // What each party had already been billed this financial year, BEFORE this
  // deal. Read from the same figures the main process strikes the tax on, so
  // the reconstruction lands where the saved number did.
  const [priors, setPriors] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setFailed('')
    const api = side === 'purchase' ? window.api.orders : window.api.sales
    void Promise.all(
      parties.map(async (p) => {
        if (!p.partyId) return [String(p.partyId), 0] as const
        // fyTaxable can exclude ONE invoice — this deal's first to that party.
        // The rest of the deal's own invoices are still inside the figure it
        // returns, so they come off here: "before this deal" has to mean
        // before all of it, or the walk starts partway up its own slab.
        const first = p.invoices[0]?.id || 0
        const ownRest = p.invoices.slice(1).reduce((a, i) => a + n(i.taxable), 0)
        const raw = await (api as unknown as {
          fyTaxable: (id: number, date: string, excludeId: number) => Promise<number>
        }).fyTaxable(p.partyId, String(dealDate || '').slice(0, 10), first)
        return [String(p.partyId), Math.max(0, round2(n(raw) - ownRest))] as const
      })
    )
      .then((pairs) => {
        if (!live) return
        const next: Record<string, number> = {}
        for (const [k, v] of pairs) next[k] = v
        setPriors(next)
      })
      .catch((e) => {
        if (live) setFailed((e as Error).message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side, dealDate, JSON.stringify(parties.map((p) => [p.partyId, p.invoices.map((i) => i.id)]))])

  const rose = side === 'purchase'

  const worked = useMemo(
    () =>
      parties.map((p) => {
        const prior = n(priors[String(p.partyId)])
        // The rate that applies BELOW the threshold. "No TDS below the slab"
        // on the party master makes it nil; otherwise the same rate runs
        // throughout and the slab makes no difference to the figure.
        const basePct = p.aboveOnly ? 0 : p.pct
        const walk = walkSlab(
          p.invoices.map((inv, i) => ({
            label: inv.label,
            taxable: n(inv.taxable),
            base:
              p.on === 'taxable'
                ? n(inv.taxable)
                : n(inv.taxable) + (n(inv.taxable) * n(p.gstPct)) / 100 + (i === 0 ? n(p.roundOff) : 0)
          })),
          prior,
          n(p.threshold),
          basePct,
          n(p.pct)
        )
        return { p, prior, basePct, walk, drift: round2(walk.total - n(p.posted)) }
      }),
    [parties, priors]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[86dvh] w-[min(96vw,50rem)] max-w-none flex-col gap-0 overflow-hidden !rounded-[4px] !border-0 p-0 [&>button]:top-5 [&>button]:text-white [&>button]:opacity-70 [&>button]:hover:opacity-100">
        <DialogHeader
          className={cn('shrink-0 space-y-0 px-5 py-4 pr-14 text-left', rose ? '!bg-[#6E211B]' : '!bg-[#0B3D2E]')}
        >
          <div className={cn('flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.14em]', rose ? 'text-[#FFC4BE]' : 'text-[#8FBFA8]')}>
            {rose ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
            {rose ? 'Purchase' : 'Sale'} · withholding
          </div>
          <DialogTitle className="!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] text-white">
            How this TDS is worked out
          </DialogTitle>
          <p className={cn('mt-1.5 text-[11.5px] font-semibold leading-relaxed', rose ? 'text-[#FFC4BE]' : 'text-[#8FBFA8]')}>
            The rate does not run on the whole invoice. Each party has a slab for the financial year,
            and only what falls above it is charged at the full rate — so where the party already
            stood decides the figure.
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#F1F5EF] p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] font-bold text-[#5A6B62]">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the year to date…
            </div>
          ) : failed ? (
            <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
              {failed}
            </div>
          ) : (
            worked.map(({ p, prior, basePct, walk, drift }) => (
              <div key={p.partyId} className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
                  <span className="min-w-0 truncate text-[12.5px] font-extrabold text-[#0A1F17]">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[10.5px] font-extrabold tabular-nums text-[#33473E]">
                      {formatNum(p.pct)}%
                    </span>
                    <span className="text-[13.5px] font-bold tabular-nums text-[#8A5300]">{formatINR(p.posted)}</span>
                  </span>
                </div>

                {/* The party's standing, before a rupee of this deal. */}
                <div className="grid gap-x-3 gap-y-2 px-3.5 py-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr))]">
                  {[
                    {
                      k: 'Yearly slab',
                      v: p.threshold > 0 ? formatINR(p.threshold) : 'none set',
                      s: p.threshold > 0 ? (p.aboveOnly ? 'nothing withheld below it' : `${formatNum(p.pct)}% below it too`) : 'the rate runs on everything'
                    },
                    {
                      k: 'Billed earlier this year',
                      v: formatINR(prior),
                      s: 'to this party, before this deal'
                    },
                    {
                      k: p.threshold > 0 ? 'Slab left when this deal began' : 'Withheld on',
                      v: p.threshold > 0 ? formatINR(Math.max(0, round2(p.threshold - prior))) : 'the whole value',
                      s: p.on === 'taxable' ? 'goods only — GST is not withheld on' : 'goods + GST'
                    }
                  ].map((f) => (
                    <div key={f.k} className="min-w-0">
                      <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{f.k}</div>
                      <div className="mt-1 text-[13px] font-bold tabular-nums text-[#0A1F17]">{f.v}</div>
                      <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">{f.s}</div>
                    </div>
                  ))}
                </div>

                {/* Invoice by invoice, in the order they were posted — each
                    one walks the party's year-to-date along, so the second
                    can be charged differently from the first. */}
                <div className="border-t border-t-[#E4ECE3]">
                  <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,110px))] gap-x-2 bg-[#EFF5EC] px-3.5 py-2 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#0B3D2E]">
                    <span>Invoice</span>
                    <span className="text-right">Struck on</span>
                    <span className="text-right">Inside slab</span>
                    <span className="text-right">Above slab</span>
                  </div>
                  {walk.steps.map((st, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,110px))] items-baseline gap-x-2 border-b border-b-[#EAF0E9] px-3.5 py-2"
                    >
                      <span className="min-w-0 truncate text-[12px] font-bold text-[#0A1F17]">{st.label}</span>
                      <span className="text-right text-[12px] font-semibold tabular-nums text-[#33473E]">
                        {formatINR(st.base)}
                      </span>
                      <span className="text-right text-[12px] font-semibold tabular-nums text-[#5A6B62]">
                        {p.threshold > 0 ? (
                          <>
                            {formatINR(st.below)}
                            <span className="ml-1 text-[10.5px]">@ {formatNum(basePct)}%</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </span>
                      <span className="text-right text-[12px] font-bold tabular-nums text-[#0A1F17]">
                        {formatINR(p.threshold > 0 ? st.above : st.base)}
                        <span className="ml-1 text-[10.5px] font-semibold text-[#5A6B62]">@ {formatNum(p.pct)}%</span>
                      </span>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-[#F7FAF6] px-3.5 py-2.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                      Comes to
                    </span>
                    <span className="text-[14px] font-bold tabular-nums text-[#0A1F17]">{formatINR(walk.total)}</span>
                    <span className="ml-auto text-[11px] font-semibold text-[#5A6B62]">
                      posted on the invoice{p.invoices.length === 1 ? '' : 's'}: {formatINR(p.posted)}
                    </span>
                  </div>
                  {/* A reconstruction that lands somewhere else is worth
                      saying out loud rather than papering over: the usual
                      reason is that the year-to-date has moved since — an
                      invoice to the same party was entered, corrected or
                      deleted after this one was struck. */}
                  {Math.abs(drift) > 1 && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-t-[#F0D9AE] bg-[#FFFBF2] px-3.5 py-2.5">
                      <Info className="h-4 w-4 shrink-0 text-[#C2700A]" />
                      <span className="text-[11.5px] font-bold text-[#8A5300]">
                        {formatINR(Math.abs(drift))} apart from what is posted — the figure was struck when this
                        party&rsquo;s year to date stood elsewhere. The posted amount is what the ledger carries.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="shrink-0 !justify-between gap-2 border-t border-[#D6E2D6] bg-white px-3 py-2.5">
          <span className="text-[11px] font-semibold text-[#5A6B62]">
            Slab and rate come from the party master · year to date is the financial year of{' '}
            {String(dealDate || '').slice(0, 10) || 'this deal'}
          </span>
          <Button
            variant="outline"
            onClick={onClose}
            className="!h-10 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-4 !text-[12px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
