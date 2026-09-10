// Where a recipe's FFA % comes from, when it comes from the loads themselves.
// -----------------------------------------------------------------------------
// The field it feeds is typed in by hand, and the number being typed is
// somebody's recollection of what has been arriving — a figure the mill has
// already measured, load by load, and filed against the tanker as a technical
// parameter. This panel hands that history back: tick the loads this recipe is
// actually being run on, and the average of their readings goes into the field.
//
// Ticking rather than picking one, because a batch is rarely one tanker. Two
// loads at 22.4 and 24.8 blend to something in between, and the whole point of
// the panel is that the blend is arithmetic nobody should be doing in their
// head.
//
// Website only — the desktop app's Formulation editor is untouched, so the
// styling here can commit to the web palette rather than branching on every
// class.
import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FlaskConical, Inbox, Loader2, Search, Weight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const rowKey = (r: Row): string => `${String(r.kind)}:${String(r.id)}`
const round2 = (v: number): number => Math.round(v * 100) / 100

export function FfaPicker({
  open,
  onClose,
  productId,
  productName,
  current,
  onUse
}: {
  open: boolean
  onClose: () => void
  productId: string
  productName: string
  current?: string | number | null
  onUse: (value: number) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  // Which loads to offer. Opens on this oil — the recipe line names one, and
  // that is nearly always the question — with the wider list one click away for
  // a recipe whose input has no purchase history of its own yet.
  const [scope, setScope] = useState<'product' | 'all'>('product')
  // A plain mean treats a 5-tonne load and a 30-tonne one as equal voices,
  // which for a blend they are not. Off by default because the plain average is
  // what was asked for and what people expect to see; one tap when the loads
  // are lopsided enough for it to matter.
  const [weighted, setWeighted] = useState(false)

  useEffect(() => {
    if (!open) return
    setScope(productId ? 'product' : 'all')
    setSel(new Set())
    setSearch('')
    setWeighted(false)
  }, [open, productId])

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setFailed('')
    window.api.tankers
      .ffaHistory(scope === 'product' ? Number(productId) || 0 : 0, 80)
      .then((r) => {
        if (live) setRows(Array.isArray(r) ? r : [])
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
  }, [open, scope, productId])

  // Whether the loads on offer came in on more than one company's books.
  const multiCompany = useMemo(
    () => new Set(rows.map((r) => String(r.company || '')).filter(Boolean)).size > 1,
    [rows]
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.party, r.ref, r.product, r.invoice_no, r.ffa, r.company].some((v) =>
        String(v ?? '').toLowerCase().includes(q)
      )
    )
  }, [rows, search])

  const picked = useMemo(() => rows.filter((r) => sel.has(rowKey(r))), [rows, sel])

  // What the ticked loads come to. Both figures are computed whichever is
  // showing, so the switch is instant and the one not in use can still be named
  // in the line underneath.
  const stat = useMemo(() => {
    if (!picked.length) return null
    const vals = picked.map((r) => Number(r.ffa_num) || 0)
    const plain = vals.reduce((t, v) => t + v, 0) / vals.length
    const wSum = picked.reduce((t, r) => t + (Number(r.qty) || 0), 0)
    const wAvg = wSum > 0 ? picked.reduce((t, r) => t + (Number(r.ffa_num) || 0) * (Number(r.qty) || 0), 0) / wSum : plain
    return {
      plain: round2(plain),
      weighted: round2(wAvg),
      // Whether weighting is even available to offer: with no quantities
      // recorded it would silently be the plain mean wearing another name.
      canWeigh: wSum > 0,
      lo: round2(Math.min(...vals)),
      hi: round2(Math.max(...vals))
    }
  }, [picked])

  const value = stat ? (weighted && stat.canWeigh ? stat.weighted : stat.plain) : 0

  function toggle(r: Row): void {
    setSel((p) => {
      const next = new Set(p)
      const k = rowKey(r)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  // The commonest ask, in one tap: the most recent few loads of this oil. The
  // list is already newest-first, so "latest 3" is the top three of whatever is
  // currently in view.
  function takeLatest(n: number): void {
    setSel(new Set(visible.slice(0, n).map(rowKey)))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[88dvh] w-[min(96vw,54rem)] max-w-none flex-col gap-0 overflow-hidden !rounded-[4px] !border-0 p-0 [&>button]:top-5 [&>button]:text-white [&>button]:opacity-70 [&>button]:hover:opacity-100"
      >
        <DialogHeader className="shrink-0 space-y-0 !bg-[#0B3D2E] px-5 py-4 pr-14 text-left">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] bg-white/15">
              <FlaskConical className="h-4 w-4 text-white" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Technical parameters
              </div>
              <DialogTitle className="!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] text-white">
                FFA from the loads received
              </DialogTitle>
              <p className="mt-1.5 text-[11.5px] font-semibold leading-relaxed text-[#8FBFA8]">
                Tick the loads this recipe is being run on. Their average FFA goes into the field —
                {productName ? ` currently showing ${productName}` : ' all oils'}
                {current !== '' && current != null ? `, which reads ${formatNum(Number(current))}% now.` : '.'}
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Scope, search and the two quick picks. One strip, so the list below
            gets the height. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#D6E2D6] bg-white px-3 py-2.5">
          <div className="flex shrink-0 overflow-hidden rounded-[4px] border-[1.5px] border-[#C3D2C6]">
            {(
              [
                ['product', productName || 'This oil'],
                ['all', 'Any oil']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                disabled={k === 'product' && !productId}
                onClick={() => setScope(k)}
                className={cn(
                  'h-9 px-3 text-[11.5px] font-extrabold uppercase tracking-[.04em] transition-colors disabled:opacity-40',
                  scope === k ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-white text-[#33473E] hover:bg-[#EFF5EC]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8FA79B]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a party, tanker or invoice…"
              className="h-9 w-full rounded-[4px] border border-[#C3D2C6] bg-white pl-8 pr-2.5 text-[12.5px] font-semibold outline-none focus:border-[#0B3D2E] focus:ring-2 focus:ring-[#0B3D2E]/15"
            />
          </div>
          {[3, 5].map((n) => (
            <Button
              key={n}
              variant="outline"
              onClick={() => takeLatest(n)}
              disabled={visible.length === 0}
              className="!h-9 !shrink-0 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-2.5 !text-[11.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E] hover:!bg-[#EFF5EC]"
            >
              Latest {n}
            </Button>
          ))}
          <Button
            variant="ghost"
            onClick={() => setSel(new Set())}
            disabled={sel.size === 0}
            className="!h-9 !shrink-0 !rounded-[4px] !px-2.5 !text-[11.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#5A6B62] hover:!bg-[#EFF5EC]"
          >
            Clear
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#F1F5EF] px-3 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] font-bold text-[#5A6B62]">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the lab register…
            </div>
          ) : failed ? (
            <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
              {failed}
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-[4px] border border-[#C3D2C6] bg-white px-4 py-12 text-center">
              <Inbox className="mx-auto h-6 w-6 text-[#C3D2C6]" />
              <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">
                {search ? 'Nothing matches that.' : 'No FFA readings recorded yet.'}
              </p>
              <p className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">
                {search
                  ? 'Try a shorter search, or widen the list to any oil.'
                  : scope === 'product'
                    ? 'Nothing has been tested for this oil. Try “Any oil”, or record the readings on the tanker first.'
                    : 'Readings are entered on Purchases → Purchase entries, under the flask beside Status.'}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-[4px] border border-[#C3D2C6] bg-white">
              <div className="grid grid-cols-[34px_88px_minmax(0,1fr)_minmax(0,130px)_92px_74px] items-center gap-x-2 border-b-2 border-[#0B3D2E] bg-[#EFF5EC] px-2.5 py-2 text-[10.5px] font-extrabold uppercase tracking-[.09em] text-[#0B3D2E]">
                <span />
                <span>Received</span>
                <span>Party</span>
                <span>Tanker</span>
                <span className="text-right">Qty</span>
                <span className="text-right">FFA %</span>
              </div>
              {visible.map((r) => {
                const on = sel.has(rowKey(r))
                return (
                  <div
                    key={rowKey(r)}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggle(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggle(r)
                      }
                    }}
                    className={cn(
                      'grid cursor-pointer grid-cols-[34px_88px_minmax(0,1fr)_minmax(0,130px)_92px_74px] items-center gap-x-2 border-b border-[#E4ECE3] px-2.5 py-2 transition-colors last:border-b-0',
                      on ? 'bg-[#F1FAF4]' : 'hover:bg-[#F7FAF6]'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(r)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-[17px] w-[17px] shrink-0 accent-[#0B6B45]"
                    />
                    <span className="doc-ref text-[12px] font-bold text-[#0A1F17]">{formatDate(r.received_date)}</span>
                    <span className="truncate text-[12.5px] font-bold text-[#0A1F17]" title={String(r.party || '')}>
                      {String(r.party || '—')}
                      {/* Which oil, once the list is showing more than one. */}
                      {scope === 'all' && r.product ? (
                        <span className="ml-1.5 text-[11px] font-semibold text-[#5A6B62]">{String(r.product)}</span>
                      ) : null}
                    </span>
                    <span className="truncate text-[11.5px] font-semibold text-[#33473E]" title={String(r.ref || '')}>
                      {String(r.ref || '—')}
                      {r.kind === 'consignment' ? (
                        <span className="ml-1.5 text-[10.5px] font-extrabold uppercase tracking-[.04em] text-[#8FA79B]">
                          consignment
                        </span>
                      ) : null}
                      {/* Only where there is more than one book at this site to
                          tell apart — on a single-company site it would be the
                          same name on every row. */}
                      {multiCompany && r.company ? (
                        <span className="ml-1.5 text-[10.5px] font-semibold text-[#8FA79B]">
                          {String(r.company)}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-right text-[12px] font-semibold tabular-nums text-[#33473E]">
                      {Number(r.qty) > 0 ? `${formatNum(r.qty)} ${String(r.uom || '')}` : '—'}
                    </span>
                    <span className="text-right text-[13px] font-extrabold tabular-nums tracking-[-0.02em] text-[#0B3D2E]">
                      {formatNum(Number(r.ffa_num))}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 !justify-between gap-2 border-t border-[#D6E2D6] bg-white px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            {stat ? (
              <>
                <span className="text-[12.5px] font-bold text-[#0A1F17]">
                  {picked.length} load{picked.length === 1 ? '' : 's'} ticked
                </span>
                {/* The spread, because two loads averaging 23 can be 22 and 24
                    or 5 and 41, and only one of those is a number worth
                    putting in a recipe. */}
                {stat.lo !== stat.hi ? (
                  <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                    ranging {formatNum(stat.lo)}% – {formatNum(stat.hi)}%
                  </span>
                ) : null}
                {stat.canWeigh ? (
                  <button
                    type="button"
                    onClick={() => setWeighted((v) => !v)}
                    title="Weight each reading by how much of that load actually arrived"
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[4px] border-[1.5px] px-2.5 text-[11px] font-extrabold uppercase tracking-[.03em] transition-colors',
                      weighted
                        ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]'
                        : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#EFF5EC]'
                    )}
                  >
                    <Weight className="h-3.5 w-3.5" /> By quantity
                  </button>
                ) : null}
              </>
            ) : (
              <span className="text-[12px] font-semibold text-[#5A6B62]">
                Tick one or more loads to average their FFA.
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="!h-10 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-4 !text-[12px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]"
            >
              Cancel
            </Button>
            <Button
              disabled={!stat}
              onClick={() => {
                onUse(value)
                onClose()
              }}
              className="!h-10 !gap-1.5 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] hover:!bg-[#0F4A38]"
            >
              <CheckCircle2 className="h-4 w-4" />
              {stat ? `Use ${formatNum(value)}%` : 'Use average'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
