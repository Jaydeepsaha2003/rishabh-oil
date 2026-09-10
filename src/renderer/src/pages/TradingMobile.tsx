// Mobile Trading screen — website only (see the fork at the top of Trading.tsx).
//
// Built to the "Trading — mobile" screen of the handoff: a forest header
// carrying the three figures, a search-and-chips strip, one card per deal,
// and a full-screen detail behind a tap. Colours and type come from the same
// palette the desktop register uses, so the two read as one product; the
// handoff's Material Symbols are substituted with the lucide icons this
// codebase already uses everywhere.
//
// Data is the real register — api.trading.list(), the same channel the
// desktop page reads — grouped and filtered the same way, so a figure here
// and the same figure on a laptop cannot disagree.
//
// ONE DELIBERATE SCOPE CUT: no new deal, and no editing. A trading deal is
// two sides of invoices, a buyer split, and GST and TDS on each — it is an
// invoice grid, and a phone has no room for one. The button is still there
// and says where the work is done, rather than opening a form that can only
// post a wrong figure. Everything else the deal carries is readable here.
import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Inbox,
  Loader2,
  Plus,
  Receipt,
  Search,
  TrendingDown,
  TrendingUp,
  Users,
  X
} from 'lucide-react'
import { formatDate, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

const fmtINR = (v: number): string =>
  (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Lakhs and crores in the header, because a deal book runs to crores and the
// header's cards are 150px wide. The cards below always carry the full
// figure — this shortening is for the summary only.
const fmtShort = (v: number): string => {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`
  return `${sign}₹${Math.round(a).toLocaleString('en-IN')}`
}

const dealProduct = (d: Row): string => s(d.product_code || d.product_name).trim()

// The same three colours the desktop split bar uses, so a buyer keeps its
// colour when the same deal is opened on a laptop.
const BUYER_COLORS = ['#0B6B45', '#12855A', '#3EA372']

export function TradingMobile(): React.JSX.Element {
  const [deals, setDeals] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')
  const [prodFilter, setProdFilter] = useState('ALL')
  const [openId, setOpenId] = useState<number | null>(null)
  const [entryNote, setEntryNote] = useState(false)
  const globalRange = useGlobalDateRange()

  useEffect(() => {
    let live = true
    setLoading(true)
    window.api.trading
      .list()
      .then((r) => {
        if (live) setDeals(Array.isArray(r) ? r : [])
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
  }, [])

  // Matching, filtering and the chip counts are the desktop page's own rules,
  // repeated rather than shared only because that page keeps them inside its
  // component. Every invoice number and every buyer on a deal is searchable —
  // a deal split five ways has to be findable by any of the five.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const inRange = globalRangeAppliesTo(globalRange, 'trading')
    return (d: Row): boolean => {
      if (inRange) {
        const dd = s(d.deal_date).slice(0, 10)
        if (dd < globalRange.from || dd > globalRange.to) return false
      }
      if (!q) return true
      const invoiceNos = [
        ...(Array.isArray(d.purchase_lines) ? d.purchase_lines : []),
        ...(Array.isArray(d.sale_lines) ? d.sale_lines : [])
      ].map((l: Row) => l.invoice_no)
      const buyers = Array.isArray(d.customer_names) ? d.customer_names : [d.customer_name]
      return [d.product_code, d.product_name, d.supplier_name, ...buyers, ...invoiceNos].some((f) =>
        s(f).toLowerCase().includes(q)
      )
    }
  }, [query, globalRange])

  const pool = useMemo(() => deals.filter(matches), [deals, matches])
  const shown = useMemo(
    () => pool.filter((d) => prodFilter === 'ALL' || dealProduct(d) === prodFilter),
    [pool, prodFilter]
  )

  // Counts struck before the product filter, so picking one does not empty
  // the others out from under the thumb.
  const chips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of pool) {
      const k = dealProduct(d)
      if (k) counts.set(k, (counts.get(k) || 0) + 1)
    }
    return [
      { label: 'All', value: 'ALL', count: pool.length },
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ label: value, value, count }))
    ]
  }, [pool])

  // Both sides on TAXABLE value, so Sale − Purchase IS the margin — the same
  // reconciliation the desktop summary cards make.
  const totals = useMemo(
    () => ({
      margin: shown.reduce((a, d) => a + n(d.margin), 0),
      purchase: shown.reduce((a, d) => a + n(d.purchase_taxable), 0),
      sale: shown.reduce((a, d) => a + n(d.sale_amount), 0)
    }),
    [shown]
  )

  const open = openId == null ? null : deals.find((d) => n(d.id) === openId) || null
  if (open) return <DealScreen deal={open} onBack={() => setOpenId(null)} />

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      {/* Header. The three figures live in it rather than in cards below,
          because on a phone the list is the page and anything above it is
          scrolled past once and never seen again. */}
      <div className="shrink-0 bg-[#0B3D2E] px-4 pb-3.5 pt-3 text-white">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <div className="text-[19px] font-extrabold tracking-[-0.02em]">Trading</div>
            <div className="mt-0.5 text-[11.5px] font-bold text-[#8FBFA8]">
              {shown.length} deal{shown.length === 1 ? '' : 's'}
              {prodFilter !== 'ALL' ? ` · ${prodFilter}` : ''}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            { k: 'Bought in', v: fmtShort(totals.purchase), fg: 'text-white', span: '' },
            { k: 'Sold out', v: fmtShort(totals.sale), fg: 'text-white', span: '' },
            {
              k: totals.margin < 0 ? 'Loss on the book' : 'Margin on the book',
              v: fmtShort(totals.margin),
              fg: totals.margin < 0 ? 'text-[#FFC4BE]' : 'text-[#C7F03F]',
              span: 'col-span-2'
            }
          ].map((c) => (
            <div key={c.k} className={cn('min-w-0 rounded-[4px] bg-white/[0.08] px-3 py-2.5', c.span)}>
              <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{c.k}</div>
              <div className={cn('mt-1 text-[14px] font-bold tracking-[-0.02em] tabular-nums', c.fg)}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Search and the product chips. 44px controls throughout — a thumb
          target, not a pointer one. */}
      <div className="shrink-0 border-b border-[#D6E2D6] bg-white px-4 py-2.5">
        <div className="flex h-11 items-center gap-2 rounded-[4px] border border-[#C3D2C6] px-3">
          <Search className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Product, supplier or buyer"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} className="shrink-0 text-[#5A6B62]">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {chips.length > 1 ? (
          <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {chips.map((c) => {
              const on = prodFilter === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setProdFilter(c.value)}
                  className={cn(
                    'flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-[4px] border px-3.5 text-[12.5px] font-extrabold',
                    on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#DCE7DB] bg-white text-[#33473E]'
                  )}
                >
                  {c.label}
                  <span
                    className={cn(
                      'rounded-[2px] px-1.5 py-0.5 text-[10.5px] font-extrabold tabular-nums',
                      on ? 'bg-white/15 text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#5A6B62]'
                    )}
                  >
                    {c.count}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/* One card per deal: what it was, who from, who to, and how it went. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-24 pt-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] font-bold text-[#5A6B62]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the deal book…
          </div>
        ) : failed ? (
          <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
            {failed}
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
            <Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />
            <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">
              {query || prodFilter !== 'ALL' ? 'Nothing matches that.' : 'No trading deals yet.'}
            </p>
            <p className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">
              {query || prodFilter !== 'ALL'
                ? 'Try a shorter search, or clear the product filter.'
                : 'Deals recorded on a desktop appear here.'}
            </p>
          </div>
        ) : (
          shown.map((d) => {
            const loss = n(d.margin) < 0
            const buyers: string[] = Array.isArray(d.customer_names) ? d.customer_names : []
            const many = n(d.customer_count) > 1
            return (
              <button
                key={String(d.id)}
                type="button"
                onClick={() => setOpenId(n(d.id))}
                className={cn(
                  'w-full overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white text-left',
                  loss ? 'border-l-[#B3261E]' : 'border-l-[#12855A]'
                )}
              >
                <div className="flex flex-col gap-2.5 px-3.5 pb-2.5 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-bold tabular-nums text-[#5A6B62]">{formatDate(d.deal_date)}</span>
                    <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[10.5px] font-extrabold tracking-[.05em] text-[#33473E]">
                      {dealProduct(d) || '—'}
                    </span>
                    <span className="ml-auto text-[13px] font-bold tabular-nums text-[#0A1F17]">
                      {formatNum(d.purchase_qty)} {s(d.purchase_uom || 'MT')}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-start gap-2.5">
                      <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-[#8C2F26]" />
                      {/* The party names wrap rather than truncate. On a
                          laptop an ellipsis is recoverable — the column can
                          be widened, the row hovered. On a phone it is the
                          end of the information. */}
                      <span className="min-w-0 flex-1 text-[12px] font-bold leading-[1.35] text-[#33473E]">
                        {s(d.supplier_name) || '—'}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] font-bold tabular-nums">
                        {fmtINR(n(d.purchase_taxable))}
                      </span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      {many ? (
                        <Users className="mt-0.5 h-4 w-4 shrink-0 text-[#0B6B45]" />
                      ) : (
                        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-[#0B6B45]" />
                      )}
                      <span className="min-w-0 flex-1 text-[12px] font-bold leading-[1.35] text-[#0B6B45]">
                        {many ? `${n(d.customer_count)} buyers` : s(d.customer_name) || '—'}
                        {many && buyers.length ? (
                          <span className="block text-[11px] font-semibold text-[#5A6B62]">{buyers.join(' · ')}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] font-bold tabular-nums">
                        {fmtINR(n(d.sale_amount))}
                      </span>
                    </div>
                  </div>
                </div>

                <div
                  className={cn(
                    'flex items-center gap-2 border-t px-3.5 py-2.5',
                    loss ? 'border-t-[#F0D6D4] bg-[#FDF3F2]' : 'border-t-[#BFE3CB] bg-[#EAF6EC]'
                  )}
                >
                  {loss ? (
                    <TrendingDown className="h-4 w-4 shrink-0 text-[#B3261E]" />
                  ) : (
                    <TrendingUp className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                  )}
                  <span
                    className={cn(
                      'text-[10.5px] font-extrabold uppercase tracking-[.07em]',
                      loss ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
                    )}
                  >
                    {loss ? 'Loss' : 'Margin'}
                  </span>
                  <span
                    className={cn(
                      'ml-auto text-[13px] font-bold tabular-nums',
                      loss ? 'text-[#B3261E]' : 'text-[#0B6B45]'
                    )}
                  >
                    {fmtINR(n(d.margin))}
                  </span>
                  <span
                    className={cn(
                      'text-[11.5px] font-bold tabular-nums',
                      loss ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
                    )}
                  >
                    {n(d.margin_pct).toFixed(2)}%
                  </span>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* Fixed, because it is the page's one action and a list this long
          would bury it. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        <button
          type="button"
          onClick={() => setEntryNote(true)}
          className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13.5px] font-extrabold text-[#C7F03F]"
        >
          <Plus className="h-5 w-5" /> New trading deal
        </button>
      </div>

      {/* Why the button does not open a form. Said plainly, once, when it is
          asked for — rather than a disabled button nobody can interpret. */}
      {entryNote ? (
        <div className="fixed inset-0 z-50 flex items-end bg-[#0A1F17]/45" onClick={() => setEntryNote(false)}>
          <div
            className="w-full rounded-t-[10px] bg-white px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3.5 h-1 w-10 rounded-full bg-[#D6E2D6]" />
            <div className="text-[15px] font-extrabold text-[#0A1F17]">Recorded on a wider screen</div>
            <p className="mt-2 text-[12.5px] font-semibold leading-relaxed text-[#5A6B62]">
              A trading deal is two sides of invoices at once — every purchase invoice, every buyer&rsquo;s
              share, and the GST and TDS struck on each. That is a grid, and it needs the width to be
              entered without mistakes. Open Trading on a laptop to record one; everything already
              recorded is readable here.
            </p>
            <button
              type="button"
              onClick={() => setEntryNote(false)}
              className="mt-4 flex h-12 w-full items-center justify-center rounded-[4px] border-[1.5px] border-[#C3D2C6] text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E]"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One deal, full screen.
//
// The drawer on the desktop puts the two sides in facing columns. A phone has
// one column, so they become two tabs — the same split, made vertical. Which
// side you are on is the question the screen answers, so the tabs are the
// first thing under the header rather than a control at the end of a scroll.
function DealScreen({ deal: d, onBack }: { deal: Row; onBack: () => void }): React.JSX.Element {
  const [side, setSide] = useState<'seller' | 'buyer'>('seller')
  const uom = s(d.purchase_uom || 'MT')
  const pl: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
  const sl: Row[] = Array.isArray(d.sale_lines) ? d.sale_lines : []
  const sp: Row[] = Array.isArray(d.sale_parties) ? d.sale_parties : []
  const multi = sp.length > 1
  const loss = n(d.margin) < 0
  const totalQty = sp.reduce((a, b) => a + n(b.qty), 0)
  const noDetail = !pl.length && !sl.length && !sp.length

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-3 pb-3.5 pt-2 text-white">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] active:bg-white/10"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Trading deal</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-bold tabular-nums">{formatDate(d.deal_date)}</span>
              <span className="rounded-[2px] bg-white/[0.12] px-2 py-1 text-[10px] font-extrabold tracking-[.05em]">
                {dealProduct(d) || '—'}
              </span>
              <span className="text-[12px] font-bold tabular-nums text-[#C7F03F]">
                {formatNum(d.purchase_qty)} {uom}
              </span>
            </div>
          </div>
        </div>
        <div
          className={cn(
            'mt-2.5 flex items-center gap-2.5 rounded-[3px] border-l-[3px] px-3 py-2.5',
            loss ? 'border-l-[#FF8379] bg-[#6E211B]' : 'border-l-[#C7F03F] bg-[#0E5B3E]'
          )}
        >
          {loss ? (
            <TrendingDown className="h-[18px] w-[18px] shrink-0 text-[#F8B4AE]" />
          ) : (
            <TrendingUp className="h-[18px] w-[18px] shrink-0 text-[#C7F03F]" />
          )}
          <span
            className={cn(
              'text-[10px] font-extrabold uppercase tracking-[.1em]',
              loss ? 'text-[#FFC4BE]' : 'text-[#C7F03F]'
            )}
          >
            {loss ? 'Loss on deal' : 'Margin on deal'}
          </span>
          <span className="ml-auto whitespace-nowrap text-[14.5px] font-bold tabular-nums">{fmtINR(n(d.margin))}</span>
          <span className={cn('text-[11.5px] font-bold tabular-nums', loss ? 'text-[#F8D7D4]' : 'text-[#EAFBC9]')}>
            {n(d.margin_pct).toFixed(2)}%
          </span>
        </div>
      </div>

      <div className="flex shrink-0 border-b border-[#D6E2D6] bg-white">
        {(
          [
            ['seller', 'Seller side', n(d.purchase_taxable)],
            ['buyer', 'Buyer side', n(d.sale_amount)]
          ] as const
        ).map(([k, label, amt]) => {
          const on = side === k
          const rose = k === 'seller'
          return (
            <button
              key={k}
              type="button"
              onClick={() => setSide(k)}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-b-[3px] px-2 py-2',
                on ? (rose ? 'border-b-[#B3261E]' : 'border-b-[#0B6B45]') : 'border-b-transparent'
              )}
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-[12.5px] font-extrabold',
                  on ? (rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]') : 'text-[#8FA79B]'
                )}
              >
                {rose ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
                {label}
              </span>
              <span className={cn('text-[11px] font-bold tabular-nums', on ? 'text-[#33473E]' : 'text-[#A8B8AE]')}>
                {fmtINR(amt)}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-8 pt-3">
        {noDetail ? (
          <div className="flex flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-7">
            <Receipt className="h-7 w-7 text-[#C3D2C6]" />
            <span className="text-center text-[12.5px] font-semibold text-[#5A6B62]">
              No invoices are recorded against this deal yet.
            </span>
          </div>
        ) : side === 'seller' ? (
          <>
            <PartyCard
              rose
              label="Supplier"
              name={s(d.supplier_name) || '—'}
              amount={n(d.purchase_taxable)}
              note={`${pl.length} invoice${pl.length === 1 ? '' : 's'} · ${formatNum(d.purchase_qty)} ${uom}`}
            />
            <InvoiceCard rose heading="Purchase invoices" lines={pl} uom={uom} total={n(d.purchase_taxable)} idKey="order_id" />
            <TaxCard
              rose
              rows={[
                { k: `GST ${formatNum(d.purchase_gst_pct)}%`, v: fmtINR(n(d.purchase_gst_amount)) },
                { k: `TDS ${formatNum(d.purchase_tds_pct)}%`, v: fmtINR(n(d.purchase_tds_amount)), warn: true },
                { k: 'Net payable to supplier', v: fmtINR(n(d.purchase_net)), foot: true }
              ]}
            />
          </>
        ) : (
          <>
            {multi ? (
              <>
                <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3">
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                    Split between {sp.length} buyers
                  </div>
                  <div className="mt-2.5 flex h-3 gap-0.5 overflow-hidden rounded-[2px]">
                    {sp.map((b, i) => (
                      <div
                        key={i}
                        style={{
                          width: `${totalQty ? (n(b.qty) / totalQty) * 100 : 0}%`,
                          background: BUYER_COLORS[i % BUYER_COLORS.length]
                        }}
                      />
                    ))}
                  </div>
                  <div className="mt-2 text-[11.5px] font-bold tabular-nums text-[#33473E]">
                    {sp.map((b) => formatNum(b.qty)).join(' + ')} = {formatNum(totalQty)} {uom}
                  </div>
                </div>
                {sp.map((b, i) => (
                  <BuyerCard key={i} b={b} i={i} uom={uom} totalQty={totalQty} />
                ))}
              </>
            ) : (
              <>
                <PartyCard
                  rose={false}
                  label="Buyer"
                  name={s(sp[0]?.customer_name || d.customer_name) || '—'}
                  amount={n(d.sale_amount)}
                  note={`${sl.length} invoice${sl.length === 1 ? '' : 's'} · ${formatNum(d.sale_qty)} ${uom}`}
                />
                <InvoiceCard
                  rose={false}
                  heading="Sale invoices"
                  lines={sp.length ? (Array.isArray(sp[0]?.lines) ? sp[0].lines : []) : sl}
                  uom={uom}
                  total={n(d.sale_amount)}
                  idKey="sale_id"
                />
              </>
            )}
            <TaxCard
              rose={false}
              rows={[
                { k: multi ? 'GST · per buyer' : `GST ${formatNum(d.sale_gst_pct)}%`, v: fmtINR(n(d.sale_gst_amount)) },
                {
                  k: multi ? 'TDS · per buyer' : `TDS ${formatNum(d.sale_tds_pct)}%`,
                  v: fmtINR(n(d.sale_tds_amount)),
                  warn: true
                },
                { k: 'Net receivable', v: fmtINR(n(d.sale_net_receivable)), foot: true }
              ]}
            />
          </>
        )}

        {/* Both of these belong to the deal rather than to a side, so they
            sit under whichever one is open. */}
        {!!d.lc_id && (
          <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3">
            <span className="text-[11px] font-extrabold uppercase tracking-[.08em] text-[#0A1F17]">
              LC {s(d.lc_no) || `#${d.lc_id}`}
            </span>
            <span
              className={cn(
                'rounded-[3px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.05em]',
                d.lc_bank_repaid ? 'bg-[#EAF6EC] text-[#0B6B45]' : 'bg-[#FFEDD0] text-[#8A5300]'
              )}
            >
              {d.lc_bank_repaid ? 'Bank repaid' : 'Bank outstanding'}
            </span>
            <span
              className={cn(
                'rounded-[3px] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.05em]',
                d.sale_fully_paid ? 'bg-[#EAF6EC] text-[#0B6B45]' : 'bg-[#FFEDD0] text-[#8A5300]'
              )}
            >
              {d.sale_fully_paid
                ? 'Sale paid'
                : `Outstanding ${fmtINR(Math.max(0, n(d.sale_net_receivable) - n(d.sale_paid)))}`}
            </span>
          </div>
        )}
        {(!d.qty_matched || !!d.note) && (
          <div className="flex flex-col gap-1.5 rounded-[4px] border border-[#F0D9AE] bg-[#FFFBF2] px-3.5 py-3">
            {!d.qty_matched && (
              <span className="text-[12px] font-bold text-[#8A5300]">
                {formatNum(Math.abs(n(d.purchase_qty) - n(d.sale_qty)))} {uom}{' '}
                {n(d.purchase_qty) > n(d.sale_qty) ? 'still unsold' : 'oversold'}
              </span>
            )}
            {!!d.note && <span className="text-[12px] font-semibold text-[#33473E]">Note: {s(d.note)}</span>}
          </div>
        )}

        {/* The other side, one tap away at the end of this one — a phone
            reader who has finished the seller side wants the buyer side, and
            scrolling back to the tabs to get it is a wasted trip. */}
        <button
          type="button"
          onClick={() => setSide(side === 'seller' ? 'buyer' : 'seller')}
          className="mt-1 flex h-12 items-center justify-center gap-2 rounded-[4px] border-[1.5px] border-[#C3D2C6] bg-white text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E]"
        >
          {side === 'seller' ? 'Buyer side' : 'Seller side'} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function PartyCard({
  rose,
  label,
  name,
  amount,
  note
}: {
  rose: boolean
  label: string
  name: string
  amount: number
  note: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-[4px] border border-l-[3px] bg-white px-3.5 py-3',
        rose ? 'border-[#F0D6D4] border-l-[#B3261E]' : 'border-[#BFE3CB] border-l-[#12855A]'
      )}
    >
      <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{label}</div>
      <div className={cn('mt-1.5 text-[13px] font-extrabold leading-snug', rose ? 'text-[#0A1F17]' : 'text-[#0B6B45]')}>
        {name}
      </div>
      <div className="mt-1.5 text-[17px] font-bold tabular-nums text-[#0A1F17]">{fmtINR(amount)}</div>
      <div className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">{note}</div>
    </div>
  )
}

// Invoice rows, stacked rather than in columns: a phone cannot hold invoice
// no., quantity, rate and value on one line without shrinking all four past
// reading. Number and value on top — the two anyone is looking for — with
// the quantity and rate that explain them underneath.
function InvoiceCard({
  rose,
  heading,
  lines,
  uom,
  total,
  idKey
}: {
  rose: boolean
  heading: string
  lines: Row[]
  uom: string
  total: number
  idKey: string
}): React.JSX.Element {
  return (
    <div className={cn('overflow-hidden rounded-[4px] border bg-white', rose ? 'border-[#F0D6D4]' : 'border-[#BFE3CB]')}>
      <div
        className={cn(
          'border-b px-3 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.11em]',
          rose ? 'border-b-[#F0D6D4] bg-[#FDF3F2] text-[#8C2F26]' : 'border-b-[#BFE3CB] bg-[#F4FBF6] text-[#0B6B45]'
        )}
      >
        {heading}
      </div>
      {lines.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] font-semibold text-[#8FA79B]">No invoices recorded.</div>
      ) : (
        lines.map((l, i) => (
          <div key={s(l[idKey]) || i} className="border-b border-b-[#EAF0E9] px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <span className="min-w-0 truncate text-[13px] font-bold text-[#0A1F17]">{s(l.invoice_no) || '—'}</span>
              <span className="ml-auto shrink-0 whitespace-nowrap text-[13.5px] font-bold tabular-nums">
                {fmtINR(n(l.qty) * n(l.rate))}
              </span>
            </div>
            <div className="mt-1 text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">
              {formatNum(l.qty)} {uom} @ {fmtINR(n(l.rate))}
            </div>
          </div>
        ))
      )}
      <div className={cn('flex items-center gap-2.5 px-3 py-2.5', rose ? 'bg-[#F7EDEC]' : 'bg-[#EAF6EC]')}>
        <span
          className={cn(
            'text-[10.5px] font-extrabold uppercase tracking-[.06em]',
            rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
          )}
        >
          {lines.length} invoice{lines.length === 1 ? '' : 's'}
        </span>
        <span
          className={cn(
            'ml-auto whitespace-nowrap text-[13.5px] font-bold tabular-nums',
            rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
          )}
        >
          {fmtINR(total)}
        </span>
      </div>
    </div>
  )
}

function TaxCard({
  rose,
  rows
}: {
  rose: boolean
  rows: { k: string; v: string; warn?: boolean; foot?: boolean }[]
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
      {rows.map((r) => (
        <div
          key={r.k}
          className={cn(
            'flex items-baseline justify-between gap-3 px-3.5 py-2.5',
            r.foot
              ? rose
                ? 'bg-[#F7EDEC]'
                : 'bg-[#EAF6EC]'
              : 'border-b border-b-[#EAF0E9]'
          )}
        >
          <span
            className={cn(
              'min-w-0 text-[11.5px] font-extrabold',
              r.foot ? (rose ? 'uppercase tracking-[.06em] text-[#8C2F26]' : 'uppercase tracking-[.06em] text-[#0B6B45]') : 'text-[#5A6B62]'
            )}
          >
            {r.k}
          </span>
          <span
            className={cn(
              'shrink-0 whitespace-nowrap tabular-nums',
              r.foot
                ? cn('text-[15px] font-bold', rose ? 'text-[#8C2F26]' : 'text-[#0B6B45]')
                : cn('text-[13px] font-bold', r.warn ? 'text-[#8A5300]' : 'text-[#0A1F17]')
            )}
          >
            {r.v}
          </span>
        </div>
      ))}
    </div>
  )
}

function BuyerCard({ b, i, uom, totalQty }: { b: Row; i: number; uom: string; totalQty: number }): React.JSX.Element {
  const colour = BUYER_COLORS[i % BUYER_COLORS.length]
  const lines: Row[] = Array.isArray(b.lines) ? b.lines : []
  const share = totalQty ? (n(b.qty) / totalQty) * 100 : 0
  const outstanding = Math.max(0, n(b.net_receivable) - n(b.paid))
  return (
    <div className="overflow-hidden rounded-[4px] border border-l-[3px] border-[#BFE3CB] bg-white" style={{ borderLeftColor: colour }}>
      <div className="border-b border-b-[#BFE3CB] bg-[#F4FBF6] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 rounded-[2px] px-1.5 py-1 text-[9.5px] font-extrabold tracking-[.08em] text-white"
            style={{ background: colour }}
          >
            BUYER {i + 1}
          </span>
          <span className="ml-auto whitespace-nowrap text-[11.5px] font-extrabold tabular-nums text-[#0B6B45]">
            {formatNum(b.qty)} {uom} · {share.toFixed(0)}%
          </span>
        </div>
        <div className="mt-1.5 text-[12.5px] font-extrabold leading-snug text-[#0B6B45]">{s(b.customer_name) || '—'}</div>
      </div>
      {lines.map((l, k) => (
        <div key={k} className="border-b border-b-[#EAF0E9] px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="min-w-0 truncate text-[12.5px] font-bold text-[#0A1F17]">{s(l.invoice_no) || '—'}</span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-[13px] font-bold tabular-nums">
              {fmtINR(n(l.qty) * n(l.rate))}
            </span>
          </div>
          <div className="mt-1 text-[11px] font-semibold tabular-nums text-[#5A6B62]">
            {formatNum(l.qty)} {uom} @ {fmtINR(n(l.rate))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-b-[#EAF0E9] px-3 py-2.5">
        {[
          { k: 'GST', v: `${formatNum(b.gst_pct)}%`, tone: 'text-[#0A1F17]' },
          { k: 'TDS', v: fmtINR(n(b.tds_amount)), tone: 'text-[#8A5300]' },
          { k: 'Net due', v: fmtINR(n(b.net_receivable)), tone: 'text-[#0A1F17]' }
        ].map((f) => (
          <div key={f.k} className="min-w-[74px]">
            <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{f.k}</div>
            <div className={cn('mt-0.5 text-[12.5px] font-bold tabular-nums', f.tone)}>{f.v}</div>
          </div>
        ))}
      </div>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2.5',
          outstanding > 0.005 ? 'bg-[#FFFBF2]' : 'bg-[#EAF6EC]'
        )}
      >
        <span
          className={cn(
            'text-[10px] font-extrabold uppercase tracking-[.05em]',
            outstanding > 0.005 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
          )}
        >
          {outstanding > 0.005 ? 'Outstanding' : 'Paid in full'}
        </span>
        <span
          className={cn(
            'ml-auto whitespace-nowrap text-[12.5px] font-bold tabular-nums',
            outstanding > 0.005 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
          )}
        >
          {fmtINR(outstanding > 0.005 ? outstanding : n(b.net_receivable))}
        </span>
      </div>
    </div>
  )
}
