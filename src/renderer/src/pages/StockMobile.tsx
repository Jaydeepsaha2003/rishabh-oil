// Mobile Stock — website only (see the fork in Stock.tsx).
//
// Built to the "Stock — mobile" screen of the handoff. The page answers three
// separate questions and the handoff keeps them three separate screens, each
// with its own header colour so you always know which one you are on:
//
//   Book        what the books say      forest
//   Actual      what was counted        forest, day close
//   Opening     where it all starts     violet
//
// The two counting screens WRITE. That is the point of them: a stock count is
// taken walking the tanks, and a phone is the only thing anyone carries while
// doing it. Everything typed here goes through the same channels the desktop
// sheets use — stockCount.save, stockOpening.save, skuOpening.save — with the
// same rules about what a blank means.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BookOpen,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Database,
  Copy,
  Inbox,
  Layers,
  Loader2,
  Monitor,
  Package,
  Plus,
  Save,
  Search,
  X,
  Zap
} from 'lucide-react'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { MobileBar } from '@/components/MobileBar'
import { SerialNo } from '@/components/SerialNo'
import { PpBreakdown } from '@/components/PpBreakdown'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const CAT_LABEL: Record<string, string> = { raw: 'Raw', intermediate: 'Intermediate', finished: 'Finished' }

type Menu = 'book' | 'actual' | 'opening'

export function StockMobile(): React.JSX.Element {
  const [menu, setMenu] = useState<Menu>('book')
  const violet = menu === 'opening'
  // See the note on the key below.
  const [nonce, setNonce] = useState(0)

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      {/* The header is the screen's identity: forest for the two registers
          that report, violet for the sheet that sets the starting line. */}
      <div className={cn('shrink-0 px-4 pb-3 pt-2.5 text-white', violet ? 'bg-[#3D3179]' : 'bg-[#0B3D2E]')}>
        <MobileBar tone={violet ? 'violet' : 'forest'} onRefresh={() => setNonce((n) => n + 1)} />
        <div className="text-[19px] font-extrabold tracking-[-0.02em]">Stock</div>
        <div className={cn('mt-0.5 text-[11px] font-extrabold uppercase tracking-[.12em]', violet ? 'text-[#C9BEF5]' : 'text-[#8FBFA8]')}>
          {menu === 'book' ? 'What the books say' : menu === 'actual' ? 'What was counted' : 'Where it all starts'}
        </div>
      </div>

      <div className="flex shrink-0 overflow-x-auto border-b border-[#D6E2D6] bg-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(
          [
            ['book', 'Book', BookOpen],
            ['actual', 'Actual', ClipboardCheck],
            ['opening', 'Opening', CalendarCheck]
          ] as const
        ).map(([k, label, Icon]) => {
          const on = menu === k
          const v = k === 'opening'
          return (
            <button
              key={k}
              type="button"
              onClick={() => setMenu(k)}
              className={cn(
                'flex h-[50px] shrink-0 items-center gap-2 border-b-[3px] px-4 text-[12.5px] font-extrabold',
                on
                  ? v
                    ? 'border-b-[#5B4BA8] text-[#3D3179]'
                    : 'border-b-[#0B3D2E] text-[#0A1F17]'
                  : 'border-b-transparent text-[#8FA79B]'
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </button>
          )
        })}
      </div>

      {/* `nonce` as a key, so the refresh button remounts the active screen
          and its own load effect runs again. Each of the three fetches in its
          own effect with no shared loader to call, and threading a refresh
          into all three is more moving parts than a remount is worth. */}
      {menu === 'book' ? (
        <BookScreen key={nonce} />
      ) : menu === 'actual' ? (
        <ActualScreen key={nonce} />
      ) : (
        <OpeningScreen key={nonce} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// What the books say. Read-only, because every figure on it is the sum of
// entries made elsewhere — a purchase, a batch, a dispatch — and the way to
// change one is to correct the entry it came from.
function BookScreen(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    window.api.stock
      .list()
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
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    // An inactive product is left off only when there is nothing on it — one
    // still holding a balance (or below zero) is exactly what needs seeing,
    // and the desktop register lists it.
    const live = rows.filter((r) => n(r.active) !== 0 || Math.abs(n(r.stock)) > 0.0005)
    if (!q) return live
    return live.filter((r) => [r.name, r.code, r.category].some((f) => s(f).toLowerCase().includes(q)))
  }, [rows, query])

  // Only products counted in MT add to these — a carton (PCS) or KG product
  // summed in would be "counted as tonnes", the rule the desktop footer keeps.
  const totals = useMemo(() => {
    const mt = shown.filter((r) => s(r.uom || 'MT').toUpperCase() === 'MT')
    return {
      closing: mt.reduce((a, r) => a + n(r.stock), 0),
      received: mt.reduce((a, r) => a + n(r.received), 0),
      produced: mt.reduce((a, r) => a + n(r.produced), 0),
      negative: shown.filter((r) => n(r.stock) < -0.0005).length
    }
  }, [shown])

  return (
    <>
      <Kpis
        tone="green"
        items={[
          { k: 'Closing MT', v: formatNum(r3(totals.closing)) },
          { k: 'Received MT', v: formatNum(r3(totals.received)) },
          { k: 'Produced MT', v: formatNum(r3(totals.produced)) },
          { k: 'Below zero', v: String(totals.negative), warn: totals.negative > 0 }
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-8 pt-3">
        <SearchBox value={query} onChange={setQuery} placeholder="Product or code" />
        {loading ? (
          <Loading />
        ) : failed ? (
          <Failed msg={failed} />
        ) : shown.length === 0 ? (
          <Empty title={query ? 'Nothing matches that.' : 'No products.'} />
        ) : (
          shown.map((r, ri) => {
            const closing = n(r.stock)
            return (
              <div
                key={String(r.id)}
                className={cn(
                  'overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white',
                  closing < -0.0005 ? 'border-l-[#B3261E]' : closing > 0 ? 'border-l-[#12855A]' : 'border-l-[#C3D2C6]'
                )}
              >
                <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
                  <SerialNo n={ri + 1} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">{s(r.name)}</div>
                    <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">
                      {s(r.code) || '—'} · {CAT_LABEL[s(r.category)] || s(r.category)} · {s(r.uom || 'MT')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Closing</div>
                    <div
                      className={cn(
                        'mt-0.5 text-[16px] font-bold tabular-nums',
                        closing < -0.0005 ? 'text-[#B3261E]' : 'text-[#0A1F17]'
                      )}
                    >
                      {formatNum(r3(closing))}
                    </div>
                  </div>
                </div>
                {/* Opening + Adj. + In − Out = Closing, as on the desktop. The
                    adjustment (count correction, FFA restatement, a batch out
                    of PP) is its own figure there; left off here the card
                    did not add up, and Out carries the PP half of it. */}
                <div className="grid grid-cols-4 gap-2 border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-3.5 py-2.5">
                  {[
                    { k: 'Opening', v: n(r.opening), tone: 'text-[#33473E]' },
                    { k: 'Adj.', v: n(r.opening_adj), tone: 'text-[#7C9188]' },
                    { k: 'In', v: n(r.received) + n(r.produced) + n(r.transferred_in), tone: 'text-[#0B6B45]' },
                    {
                      k: 'Out',
                      v: n(r.consumed) + n(r.sold) + n(r.packed_out) + n(r.transferred_out),
                      tone: 'text-[#B3261E]'
                    }
                  ].map((f) => (
                    <div key={f.k} className="min-w-0">
                      <div className="text-[9px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">{f.k}</div>
                      <div className={cn('mt-1 truncate text-[12px] font-bold tabular-nums', f.tone)}>
                        {f.v ? formatNum(r3(f.v)) : '—'}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Recirculation is not production and is not in the figures
                    above; it is reported here for the same reason it is
                    reported on the desktop register. */}
                {n(r.recirculated) > 0 ? (
                  <div className="border-t border-t-[#DCE7F5] bg-[#F4F8FD] px-3.5 py-2 text-[11px] font-bold tabular-nums text-[#1B4E82]">
                    +{formatNum(r.recirculated)} −{formatNum(r.recirculated)} recirculated
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// ACTUAL STOCK — the same four views as the desk: the day's count, packed
// SKUs, MNC / consignment stock and transfers between the companies.
type ActualTab = 'count' | 'sku' | 'mnc' | 'transfers'
function ActualScreen(): React.JSX.Element {
  const [tab, setTab] = useState<ActualTab>('count')
  return (
    <>
      <div className="flex shrink-0 gap-1.5 overflow-x-auto bg-[#0B3D2E] px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(
          [
            ['count', 'Count'],
            ['sku', 'Packed SKU'],
            ['mnc', 'MNC'],
            ['transfers', 'Transfers']
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'h-9 shrink-0 rounded-full px-3.5 text-[12px] font-extrabold',
              tab === k ? 'bg-[#C7F03F] text-[#0A1F17]' : 'bg-white/10 text-[#BFE3CB]'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'count' ? <DayCloseScreen /> : tab === 'sku' ? <SkuScreen /> : tab === 'mnc' ? <MncScreen /> : <TransfersScreen />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Day close — walk the tanks and enter what is there.
function DayCloseScreen(): React.JSX.Element {
  const [date, setDate] = useState(todayISO())
  // The counts already saved, newest first — so what was counted is one tap
  // away, and the screen opens on the last count rather than an empty today.
  const [history, setHistory] = useState<Row[]>([])
  const [openNote, setOpenNote] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
    void window.api.stockCount
      .history(from, todayISO())
      .then((h) => {
        const list = (Array.isArray(h) ? h : []).filter((x) => n(x.products) > 0)
        list.sort((a, b) => s(b.count_date).localeCompare(s(a.count_date)))
        setHistory(list)
        if (list.length && !list.some((x) => s(x.count_date).slice(0, 10) === todayISO())) setDate(s(list[0].count_date).slice(0, 10))
      })
      .catch(() => undefined)
  }, [])
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState<Record<string, { actual?: string; pp?: string; note?: string }>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  async function load(d: string): Promise<void> {
    setLoading(true)
    try {
      const r = await window.api.stockCount.sheet(d)
      setRows(Array.isArray(r) ? r : [])
      setDraft({})
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(date)
  }, [date])

  const valOf = (r: Row, k: 'actual' | 'pp' | 'note'): string => {
    const d = draft[String(r.product_id)]
    if (d && d[k] != null) return String(d[k])
    if (k === 'actual') return r.actual_qty == null ? '' : String(r.actual_qty)
    if (k === 'pp') return r.pp_qty == null ? '' : String(r.pp_qty)
    return s(r.note)
  }
  const set = (r: Row, k: 'actual' | 'pp' | 'note', v: string): void =>
    setDraft((p) => ({ ...p, [String(r.product_id)]: { ...(p[String(r.product_id)] || {}), [k]: v } }))

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.name, r.code].some((f) => s(f).toLowerCase().includes(q)))
  }, [rows, query])

  // Grouped the way the plant walks: raw tanks, then intermediate, then
  // finished.
  const groups = useMemo(() => {
    const order = ['raw', 'intermediate', 'finished']
    return order
      .map((cat) => ({
        cat,
        title: CAT_LABEL[cat],
        rows: shown.filter((r) => s(r.category) === cat)
      }))
      .filter((g) => g.rows.length)
  }, [shown])

  const counted = rows.filter((r) => {
    const a = valOf(r, 'actual')
    const p = valOf(r, 'pp')
    return a !== '' || p !== ''
  }).length

  // Copy the book figure into every uncounted row. A starting point, not an
  // answer — it is the shape of a count, to be corrected where the dip
  // disagrees.
  function copyBook(): void {
    setDraft((p) => {
      const next = { ...p }
      for (const r of rows) {
        const key = String(r.product_id)
        const already = (next[key]?.actual ?? (r.actual_qty == null ? '' : String(r.actual_qty))) !== ''
        if (already) continue
        next[key] = { ...(next[key] || {}), actual: String(r3(n(r.book_qty))) }
      }
      return next
    })
    toast.success('Book figures copied into the uncounted rows — correct what the dip disagrees with')
  }

  async function save(): Promise<void> {
    const items = rows
      .map((r) => ({
        product_id: r.product_id,
        // The book figure the count is set against — the desktop sends it
        // too. Without it the server stored 0, and every phone count read as
        // a mismatch the size of the whole stock in the day-close history.
        book_qty: r.book_qty,
        actual_qty: valOf(r, 'actual'),
        pp_qty: valOf(r, 'pp'),
        note: valOf(r, 'note')
      }))
      .filter((i) => i.actual_qty !== '' || i.pp_qty !== '')
    if (!items.length) {
      toast.error('Nothing counted yet')
      return
    }
    setSaving(true)
    try {
      const res = await window.api.stockCount.save(date, items)
      toast.success(`${res.count} counted for ${formatDate(date)}`)
      await load(date)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Kpis
        tone="green"
        dense
        items={[
          { k: 'Counted', v: `${counted} / ${rows.length}` },
          { k: 'Book', v: formatNum(r3(rows.reduce((a, r) => a + n(r.book_qty), 0))) },
          {
            k: 'Counted qty',
            v: formatNum(r3(rows.reduce((a, r) => a + n(valOf(r, 'actual')) + n(valOf(r, 'pp')), 0)))
          }
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-28 pt-3">
        {/* THE COUNTS ALREADY TAKEN — today first, then each saved day. */}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[todayISO(), ...history.map((h) => s(h.count_date).slice(0, 10)).filter((d) => d !== todayISO())].map((d) => {
            const h = history.find((x) => s(x.count_date).slice(0, 10) === d)
            const on = d === date
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDate(d)}
                className={cn(
                  'shrink-0 rounded-[6px] border px-3 py-1.5 text-left',
                  on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#D6E2D6] bg-white text-[#0A1F17]'
                )}
              >
                <div className="text-[12px] font-extrabold">{d === todayISO() ? 'Today' : formatDate(d).slice(0, 5)}</div>
                <div className={cn('text-[10px] font-bold', on ? 'text-[#BFE3CB]' : 'text-[#5A6B62]')}>
                  {h ? `${n(h.products)} counted${n(h.mismatches) ? ` · ${n(h.mismatches)} off` : ''}` : 'new count'}
                </div>
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2.5 rounded-[4px] border border-[#D6E2D6] bg-white px-3 py-2">
          <ClipboardCheck className="h-[18px] w-[18px] shrink-0 text-[#0B3D2E]" />
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={(e) => setDate(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] font-extrabold text-[#0A1F17] outline-none"
          />
          <button
            type="button"
            onClick={copyBook}
            className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border-[1.5px] border-[#C3D2C6] px-2.5 text-[11.5px] font-extrabold text-[#33473E]"
          >
            <Copy className="h-[17px] w-[17px]" /> Copy book
          </button>
        </div>

        <SearchBox value={query} onChange={setQuery} placeholder="Product or code" />

        {loading ? (
          <Loading />
        ) : groups.length === 0 ? (
          <Empty title={query ? 'Nothing matches that.' : 'Nothing to count.'} />
        ) : (
          groups.map((g, gi) => {
            // Counted straight down the sheet, not restarting per category —
            // "line 23" names one product on the whole count.
            const base = groups.slice(0, gi).reduce((t, x) => t + x.rows.length, 0)
            const diff = g.rows.reduce(
              (a, r) => a + (n(valOf(r, 'actual')) + n(valOf(r, 'pp')) - n(r.book_qty)),
              0
            )
            return (
              <div key={g.cat} className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">{g.title}</span>
                  <span className="h-px min-w-2.5 flex-1 bg-[#DCE7DB]" />
                  <span className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Difference</span>
                  <span
                    className={cn(
                      'whitespace-nowrap text-[12px] font-bold tabular-nums',
                      Math.abs(diff) < 0.0005 ? 'text-[#5A6B62]' : diff < 0 ? 'text-[#B3261E]' : 'text-[#0B6B45]'
                    )}
                  >
                    {diff > 0 ? '+' : ''}
                    {formatNum(r3(diff))}
                  </span>
                </div>

                {g.rows.map((r, ri) => {
                  const actual = valOf(r, 'actual')
                  const pp = valOf(r, 'pp')
                  const total = n(actual) + n(pp)
                  const entered = actual !== '' || pp !== ''
                  const d = entered ? r3(total - n(r.book_qty)) : null
                  return (
                    <div
                      key={String(r.product_id)}
                      className={cn(
                        'overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white',
                        !entered ? 'border-l-[#C3D2C6]' : d && Math.abs(d) > 0.0005 ? 'border-l-[#C2700A]' : 'border-l-[#12855A]'
                      )}
                    >
                      <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
                        <SerialNo n={base + ri + 1} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">{s(r.name)}</div>
                          <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">{s(r.code) || '—'}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Book</div>
                          <div className="mt-0.5 text-[14px] font-bold tabular-nums text-[#0A1F17]">
                            {formatNum(r3(n(r.book_qty)))}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2 px-3.5 pb-2.5">
                        <div className="grid grid-cols-2 gap-2.5">
                          <Num label="Counted raw" value={actual} onChange={(v) => set(r, 'actual', v)} />
                          <Num label="PP / in process" value={pp} onChange={(v) => set(r, 'pp', v)} />
                        </div>
                        {openNote[String(r.product_id)] || valOf(r, 'note') ? (
                          <input
                            value={valOf(r, 'note')}
                            onChange={(e) => set(r, 'note', e.target.value)}
                            placeholder="Note — which tank, who counted it"
                            className="h-10 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[12.5px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setOpenNote((o) => ({ ...o, [String(r.product_id)]: true }))}
                            className="self-start text-[11.5px] font-extrabold text-[#0B6B45]"
                          >
                            + Note
                          </button>
                        )}
                      </div>

                      <div
                        className={cn(
                          'flex flex-wrap items-center gap-2 border-t border-t-[#EAF0E9] px-3.5 py-2.5',
                          !entered ? 'bg-[#F7FAF6]' : d && Math.abs(d) > 0.0005 ? 'bg-[#FFFBF2]' : 'bg-[#EAF6EC]'
                        )}
                      >
                        <span
                          className={cn(
                            'text-[9.5px] font-extrabold uppercase tracking-[.07em]',
                            !entered ? 'text-[#8FA79B]' : d && Math.abs(d) > 0.0005 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                          )}
                        >
                          {!entered ? 'Not counted' : d && Math.abs(d) > 0.0005 ? (d < 0 ? 'Short of book' : 'Over book') : 'Matches book'}
                        </span>
                        {entered ? (
                          <>
                            <span
                              className={cn(
                                'ml-auto whitespace-nowrap text-[13.5px] font-bold tabular-nums',
                                d && Math.abs(d) > 0.0005 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                              )}
                            >
                              {d != null && d > 0 ? '+' : ''}
                              {formatNum(d || 0)}
                            </span>
                            <span className="whitespace-nowrap text-[11px] font-bold tabular-nums text-[#5A6B62]">
                              counted {formatNum(r3(total))}
                              {/* Valued at the weighted-average cost the count snapshots. */}
                              {n(r.rate) ? ` · ${formatINR(total * n(r.rate))}` : ''}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}

      </div>

      <SaveBar
        tone="green"
        note={`${counted} of ${rows.length} counted for ${formatDate(date)}. A row with neither figure is left uncounted.`}
        saving={saving}
        disabled={counted === 0}
        label="Save count"
        onSave={() => void save()}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// PACKED SKU — cases and pieces on the shelf, as the desk register works them.
function SkuScreen(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  // One day, as the desk register opens: brought forward + packed + adjusted
  // − sold = on hand at the day's end.
  const [date, setDate] = useState(todayISO())
  useEffect(() => {
    setLoading(true)
    void window.api.skuStock
      .list(date)
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [date])
  const shown = rows.filter((r) => {
    const q = query.trim().toLowerCase()
    return !q || [r.name, r.product_name].some((f) => s(f).toLowerCase().includes(q))
  })
  const neg = rows.filter((r) => n(r.on_hand) < 0).length
  return (
    <>
      <Kpis
        tone="green"
        items={[
          { k: 'SKUs', v: String(rows.length) },
          { k: 'Below zero', v: String(neg), warn: neg > 0 }
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-8 pt-3">
        <div className="flex items-center gap-2.5 rounded-[4px] border border-[#D6E2D6] bg-white px-3 py-2">
          <Package className="h-[18px] w-[18px] shrink-0 text-[#0B3D2E]" />
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={(e) => setDate(e.target.value || todayISO())}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] font-extrabold text-[#0A1F17] outline-none"
          />
          <span className="text-[11px] font-bold text-[#5A6B62]">closing</span>
        </div>
        <SearchBox value={query} onChange={setQuery} placeholder="SKU or product" />
        {loading ? (
          <Loading />
        ) : !shown.length ? (
          <Empty title={query ? 'Nothing matches that.' : 'No packed SKUs.'} />
        ) : (
          shown.map((r, i) => {
            const box = s(r.box_label) || 'Case'
            const low = n(r.on_hand) < 0
            return (
              <div key={String(r.id)} className={cn('overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white', low ? 'border-l-[#B3261E]' : 'border-l-[#12855A]')}>
                <div className="flex items-start gap-2.5 px-3.5 py-3">
                  <SerialNo n={i + 1} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-extrabold text-[#0A1F17]">{s(r.name)}</div>
                    <div className="mt-0.5 text-[10.5px] font-semibold text-[#5A6B62]">
                      {s(r.product_name)} · {n(r.pouches_per_box)} {s(r.pouch_label) || 'pc'} per {box.toLowerCase()}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">On hand</div>
                    <div className={cn('mt-0.5 text-[16px] font-bold tabular-nums', low ? 'text-[#B3261E]' : 'text-[#0A1F17]')}>
                      {formatNum(n(r.on_hand))}
                    </div>
                    <div className="text-[10px] font-bold text-[#5A6B62]">{box}s</div>
                  </div>
                </div>
                <div className="grid grid-cols-4 border-t border-t-[#EAF0E9] bg-[#F7FAF6] text-center">
                  {[
                    ['B/f', n(r.opening)],
                    ['Packed', n(r.packed_on)],
                    ['Adjusted', n(r.adj_on)],
                    ['Sold', n(r.sold_on) ? -n(r.sold_on) : 0]
                  ].map(([k, v]) => (
                    <div key={String(k)} className="px-1 py-2">
                      <div className="text-[9px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">{k}</div>
                      <div className={cn('mt-0.5 text-[12px] font-bold tabular-nums', Number(v) < 0 ? 'text-[#8C2F26]' : 'text-[#0A1F17]')}>
                        {Number(v) > 0 && k !== 'B/f' ? '+' : ''}
                        {formatNum(Number(v))}
                      </div>
                    </div>
                  ))}
                </div>
                {r.negative_since ? (
                  <div className="border-t border-t-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-1.5 text-[11px] font-bold text-[#B3261E]">
                    Below zero since {formatDate(s(r.negative_since))}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

// MNC / CONSIGNMENT — oil lying with us that is the supplier's until invoiced.
function MncScreen(): React.JSX.Element {
  const [sum, setSum] = useState<Row[]>([])
  const [lots, setLots] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    void Promise.all([window.api.consignment.summary(), window.api.consignment.list('stock')])
      .then(([a, b]) => {
        setSum(Array.isArray(a) ? a : [])
        setLots(Array.isArray(b) ? b : [])
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [])
  const total = r3(sum.reduce((t, x) => t + n(x.balance), 0))
  return (
    <>
      <Kpis
        tone="green"
        items={[
          { k: 'On hand', v: formatNum(total) },
          { k: 'Lines', v: String(sum.length) }
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-8 pt-3">
        {loading ? (
          <Loading />
        ) : !sum.length ? (
          <Empty title="No MNC / consignment stock." />
        ) : (
          sum.map((x) => {
            const key = `${x.supplier_id}-${x.product_id}`
            const mine = lots.filter((l) => n(l.supplier_id) === n(x.supplier_id) && n(l.product_id) === n(x.product_id))
            return (
              <div key={key} className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <button type="button" onClick={() => setOpen((o) => (o === key ? null : key))} className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-extrabold text-[#0A1F17]">{s(x.product_code || x.product_name)}</div>
                    <div className="mt-0.5 truncate text-[10.5px] font-semibold text-[#5A6B62]">{s(x.supplier_name)}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Balance</div>
                    <div className="mt-0.5 text-[16px] font-bold tabular-nums text-[#0A1F17]">{formatNum(r3(n(x.balance)))}</div>
                    <div className="text-[10px] font-bold text-[#5A6B62]">{s(x.uom || 'MT')}</div>
                  </div>
                  <ChevronDown className={cn('mt-1 h-4 w-4 shrink-0 text-[#8FA79B] transition-transform', open === key && 'rotate-180')} />
                </button>
                <div className="grid grid-cols-3 border-t border-t-[#EAF0E9] bg-[#F7FAF6] text-center">
                  {[
                    ['Opening', n(x.opening)],
                    ['Deposited', n(x.deposited)],
                    ['Invoiced', n(x.invoiced) ? -n(x.invoiced) : 0]
                  ].map(([k, v]) => (
                    <div key={String(k)} className="px-1 py-2">
                      <div className="text-[9px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">{k}</div>
                      <div className={cn('mt-0.5 text-[12px] font-bold tabular-nums', Number(v) < 0 ? 'text-[#8C2F26]' : 'text-[#0A1F17]')}>{formatNum(r3(Number(v)))}</div>
                    </div>
                  ))}
                </div>
                {open === key && (
                  <div className="divide-y divide-[#EFF3EE] border-t border-t-[#E4ECE3]">
                    {mine.length === 0 ? (
                      <div className="px-3.5 py-2.5 text-[11.5px] font-semibold text-[#5A6B62]">No lots listed.</div>
                    ) : (
                      mine.map((l) => (
                        <div key={String(l.id)} className="flex items-start gap-2 px-3.5 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-extrabold text-[#0A1F17]">
                              {s(l.tanker_no) || s(l.lot_no) || 'Lot'}
                              {l.lot_no && l.tanker_no ? <span className="ml-1.5 text-[10.5px] font-bold text-[#5A6B62]">lot {s(l.lot_no)}</span> : null}
                            </div>
                            <div className="mt-0.5 text-[10.5px] font-semibold text-[#5A6B62]">
                              {formatDate(s(l.deposit_date))}
                              {l.gate_entry_no ? ` · ${s(l.gate_entry_no)}` : ''}
                              {l.invoice_no ? ` · inv ${s(l.invoice_no)}` : ''}
                            </div>
                          </div>
                          <div className="shrink-0 text-[12.5px] font-bold tabular-nums text-[#0A1F17]">
                            {formatNum(r3(n(l.qty)))} {s(l.uom || 'MT')}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

// TRANSFERS — stock moved from one company's books to the other's.
function TransfersScreen(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void window.api.stock
      .transfers()
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-8 pt-3">
      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty title="No transfers between the companies." />
      ) : (
        rows.map((t) => (
          <div key={String(t.id)} className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-extrabold text-[#0A1F17]">{s(t.product_code || t.product_name)}</div>
                <div className="mt-0.5 text-[10.5px] font-semibold text-[#5A6B62]">
                  {s(t.from_company_name)} → {s(t.to_company_name)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[15px] font-bold tabular-nums text-[#0A1F17]">
                  {formatNum(r3(n(t.qty)))} {s(t.uom || 'MT')}
                </div>
                <div className="text-[10.5px] font-bold text-[#5A6B62]">{formatDate(s(t.transfer_date))}</div>
              </div>
            </div>
            {t.note ? <div className="mt-1.5 text-[11.5px] font-semibold text-[#5A6B62]">{s(t.note)}</div> : null}
          </div>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Opening stock — the morning the books begin.
function OpeningScreen(): React.JSX.Element {
  const [view, setView] = useState<'products' | 'packed'>('products')
  return (
    <>
      <div className="shrink-0 bg-white px-4 pb-2.5 pt-2.5">
        <div className="flex gap-1 rounded-[4px] border border-[#D6CEF5] bg-[#EAE6F7] p-1">
          {(
            [
              ['products', 'Products', Package],
              ['packed', 'Packed SKU', Inbox]
            ] as const
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setView(k)}
              className={cn(
                'flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[3px] text-[12.5px] font-extrabold',
                view === k ? 'bg-[#5B4BA8] text-white' : 'text-[#4A3D8C]'
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'products' ? <OpeningProducts /> : <OpeningPacked />}
    </>
  )
}

// Raw split by tank, as the desktop sheet has it: each line a tank and what it
// held, and Raw is their sum. Saved with the opening (Save opening).
type TankLine = { tank: string; qty: string }
const tankSum = (lines: TankLine[]): number => r3(lines.reduce((t, l) => t + n(l.qty), 0))

function OpeningProducts(): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [draft, setDraft] = useState<Record<string, { qty?: string; pp?: string; adj?: string; tanks?: TankLine[] }>>({})
  // Which products have their tank list open. Shut by default — a card is a
  // product's three figures first; the tanks open when they are wanted.
  const [openTanks, setOpenTanks] = useState<Set<string>>(new Set())
  // Which product's PP breakdown is open — the same editor the desktop sheet
  // uses, because the stage list it writes to is the site's and there must not
  // be two versions of what it means.
  const [ppRow, setPpRow] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const d = await window.api.stockOpening.list()
      setData(d || null)
      setDraft({})
      setOpenTanks(new Set())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // One row patched in place. load() clears the draft, and somebody halfway
  // down a forty-product count would lose all of it.
  const applyPp = (productId: number, total: number, lines: Row[]): void => {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        rows: (Array.isArray(prev.rows) ? (prev.rows as Row[]) : []).map((r) =>
          n(r.id) === productId ? { ...r, pp_lines: lines, pp_qty: lines.length ? total : r.pp_qty } : r
        )
      }
    })
    setDraft((p) => ({
      ...p,
      [String(productId)]: { ...(p[String(productId)] || {}), pp: lines.length ? String(total) : '' }
    }))
    setPpRow((cur) => (cur && n(cur.id) === productId ? { ...cur, pp_lines: lines } : cur))
  }

  const rows: Row[] = Array.isArray(data?.rows) ? (data?.rows as Row[]) : []
  const asOf = s(data?.as_of)

  const valOf = (r: Row, k: 'qty' | 'pp' | 'adj'): string => {
    const d = draft[String(r.id)]
    if (d && d[k] != null) return String(d[k])
    const src = k === 'qty' ? r.qty : k === 'pp' ? r.pp_qty : r.adj_qty
    // A saved row comes back with 0 for an empty PP or Adj. Shown as "0" it was
    // sent back as a figure, so clearing Raw kept the row at 0 instead of
    // removing it. The desktop reads 0 there as blank; so does this.
    if (k !== 'qty' && src != null && n(src) === 0) return ''
    return src == null ? '' : String(src)
  }
  const set = (r: Row, k: 'qty' | 'pp' | 'adj', v: string): void =>
    setDraft((p) => ({ ...p, [String(r.id)]: { ...(p[String(r.id)] || {}), [k]: v } }))
  // The tanks as they stand: what was changed here, else what is on file.
  const tanksOf = (r: Row): TankLine[] => {
    const d = draft[String(r.id)]
    if (d?.tanks) return d.tanks
    return Array.isArray(r.raw_tanks) ? (r.raw_tanks as Row[]).map((l) => ({ tank: s(l.tank), qty: l.qty == null ? '' : String(l.qty) })) : []
  }
  // Raw follows the lines; taking the last one away leaves Raw where it was.
  const setTanks = (r: Row, lines: TankLine[]): void =>
    setDraft((p) => {
      const cur = p[String(r.id)] || {}
      return { ...p, [String(r.id)]: { ...cur, tanks: lines, qty: lines.length ? String(tankSum(lines)) : (cur.qty ?? valOf(r, 'qty')) } }
    })
  // Names already used on this sheet, offered as a tank is typed.
  const tankNames = useMemo(() => {
    const out = new Set<string>()
    for (const r of rows) for (const l of tanksOf(r)) if (l.tank.trim()) out.add(l.tank.trim())
    return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, draft])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.name, r.code].some((f) => s(f).toLowerCase().includes(q)))
  }, [rows, query])

  const entered = rows.filter((r) => ['qty', 'pp', 'adj'].some((k) => valOf(r, k as 'qty') !== '')).length
  // A product whose movements alone leave it below zero has a hole an opening
  // has to fill. That is the sheet's whole reason to exist.
  const shorts = rows.filter((r) => n(r.shortfall) > 0.0005 && valOf(r, 'qty') === '')

  function fill(r: Row): void {
    set(r, 'qty', String(r3(n(r.shortfall))))
  }
  function fillAll(): void {
    setDraft((p) => {
      const next = { ...p }
      for (const r of shorts) next[String(r.id)] = { ...(next[String(r.id)] || {}), qty: String(r3(n(r.shortfall))) }
      return next
    })
    toast.success(`${shorts.length} hole${shorts.length === 1 ? '' : 's'} filled — check each before saving`)
  }

  async function save(): Promise<void> {
    if (!asOf) {
      toast.error('No opening date is set for this site')
      return
    }
    setSaving(true)
    try {
      const payload = rows.map((r) => ({
        product_id: r.id,
        qty: valOf(r, 'qty'),
        // Sent every time, as the desktop does — an empty list says Raw is one figure.
        raw_tanks: tanksOf(r)
          .filter((l) => l.tank.trim() || n(l.qty) !== 0)
          .map((l) => ({ tank: l.tank.trim(), qty: n(l.qty) })),
        pp_qty: valOf(r, 'pp'),
        adj_qty: valOf(r, 'adj'),
        // The rate as saved, or blank — as the desktop sends it. The
        // suggested (weighted-average) rate is a hint to click, not a value to
        // write into every opening that had none.
        rate: r.rate == null ? '' : r.rate,
        note: r.note ?? null
      }))
      const res = await window.api.stockOpening.save(payload, asOf, undefined, String(data?.version || ''))
      toast.success(`${res.saved} saved, ${res.cleared} cleared`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-28 pt-1">
        <div className="rounded-[4px] border border-[#D6CEF5] border-l-[3px] border-l-[#5B4BA8] bg-[#EDE9FB] px-3.5 py-3">
          <div className="flex items-center gap-2.5">
            <CalendarCheck className="h-[18px] w-[18px] shrink-0 text-[#5B4BA8]" />
            <span className="min-w-0 flex-1 text-[11px] font-extrabold uppercase tracking-[.12em] text-[#3D3179]">
              Counted {asOf ? formatDate(asOf) : '—'}
            </span>
            <span className="whitespace-nowrap text-[12.5px] font-bold tabular-nums text-[#3D3179]">
              {entered} / {rows.length}
            </span>
          </div>
          <div className="mt-2.5 flex h-[7px] overflow-hidden rounded-[2px] bg-[#DDD5F3]">
            <div className="h-full bg-[#5B4BA8]" style={{ width: `${rows.length ? (entered / rows.length) * 100 : 0}%` }} />
            <div className="h-full bg-[#B3261E]" style={{ width: `${rows.length ? (shorts.length / rows.length) * 100 : 0}%` }} />
          </div>
          {shorts.length ? (
            <button
              type="button"
              onClick={fillAll}
              className="mt-3 flex h-[46px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#5B4BA8] text-[12.5px] font-extrabold text-white"
            >
              <Zap className="h-[19px] w-[19px]" /> Fill every hole ({shorts.length})
            </button>
          ) : null}
        </div>

        <SearchBox value={query} onChange={setQuery} placeholder="Product or code" />

        {loading ? (
          <Loading />
        ) : shown.length === 0 ? (
          <Empty title={query ? 'Nothing matches that.' : 'No products.'} />
        ) : (
          shown.map((r, ri) => {
            const total = n(valOf(r, 'qty')) + n(valOf(r, 'pp')) + n(valOf(r, 'adj'))
            const any = ['qty', 'pp', 'adj'].some((k) => valOf(r, k as 'qty') !== '')
            const after = r3(n(r.movement_closing) + total)
            const short = n(r.shortfall) > 0.0005 && valOf(r, 'qty') === ''
            const ppCount = Array.isArray(r.pp_lines) ? (r.pp_lines as Row[]).length : 0
            const tanks = tanksOf(r)
            const tanksOpen = openTanks.has(String(r.id))
            const toggleTanks = (): void =>
              setOpenTanks((p) => {
                const next = new Set(p)
                if (next.has(String(r.id))) next.delete(String(r.id))
                else next.add(String(r.id))
                return next
              })
            return (
              <div
                key={String(r.id)}
                className={cn(
                  'overflow-hidden rounded-[4px] border border-[#E4DEF8] border-l-[3px] bg-white',
                  short ? 'border-l-[#B3261E]' : any ? 'border-l-[#5B4BA8]' : 'border-l-[#C3D2C6]'
                )}
              >
                <div className="flex flex-col gap-2 px-3.5 pb-2 pt-3">
                  <div className="flex items-start gap-2.5">
                    <SerialNo n={ri + 1} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">{s(r.name)}</div>
                      <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">
                        {s(r.code) || '—'} · {CAT_LABEL[s(r.category)] || s(r.category)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                        Moved since
                      </div>
                      <div
                        className={cn(
                          'mt-0.5 text-[13.5px] font-bold tabular-nums',
                          n(r.movement_closing) < -0.0005 ? 'text-[#B3261E]' : 'text-[#33473E]'
                        )}
                      >
                        {formatNum(r3(n(r.movement_closing)))}
                      </div>
                    </div>
                  </div>
                  {short ? (
                    <button
                      type="button"
                      onClick={() => fill(r)}
                      className="flex h-11 items-center gap-2.5 rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3"
                    >
                      <Zap className="h-[18px] w-[18px] shrink-0 text-[#B3261E]" />
                      <span className="min-w-0 flex-1 text-left text-[11.5px] font-extrabold text-[#B3261E]">
                        Short {formatNum(r.shortfall)} — tap to fill
                      </span>
                    </button>
                  ) : null}
                  {!any && !short ? (
                    <div className="rounded-[4px] border border-[#F0E4CB] bg-[#FFF4E0] px-3 py-2 text-[11.5px] font-bold leading-snug text-[#8A5300]">
                      Not counted. Blank keeps it off the register; enter 0 to state it opened at nothing.
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-3 gap-2.5 px-3.5 pb-2">
                  {/* Locked while tanks are listed: Raw is their sum. */}
                  <Num
                    label="Raw qty"
                    value={valOf(r, 'qty')}
                    onChange={(v) => set(r, 'qty', v)}
                    readOnly={tanks.length > 0}
                  />
                  {/* Locked while a breakdown stands behind it: the stages are
                      the count, and a second place to type the same figure is
                      how the two come to disagree. */}
                  <Num
                    label="PP"
                    value={valOf(r, 'pp')}
                    onChange={(v) => set(r, 'pp', v)}
                    readOnly={ppCount > 0}
                  />
                  <Num label="Adj." value={valOf(r, 'adj')} onChange={(v) => set(r, 'adj', v)} />
                </div>

                {/* RAW BY TANK — shut until tapped. */}
                <div className="px-3.5 pb-2">
                  <button
                    type="button"
                    onClick={toggleTanks}
                    aria-expanded={tanksOpen}
                    className={cn(
                      'flex h-11 w-full items-center gap-2.5 rounded-[4px] border px-3',
                      tanks.length ? 'border-[#D6CEF5] bg-[#F6F3FD]' : 'border-[#E1E8E0] bg-white'
                    )}
                  >
                    <Database className={cn('h-[17px] w-[17px] shrink-0', tanks.length ? 'text-[#5B4BA8]' : 'text-[#7C9188]')} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-left text-[11.5px] font-extrabold',
                        tanks.length ? 'text-[#3D3179]' : 'text-[#5A6B62]'
                      )}
                    >
                      {tanks.length ? `Raw by tank · ${tanks.length} tank${tanks.length === 1 ? '' : 's'}` : 'Split Raw by tank'}
                    </span>
                    {tanks.length ? (
                      <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-[#3D3179]">{formatNum(tankSum(tanks))}</span>
                    ) : null}
                    {tanksOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-[#7C9188]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-[#7C9188]" />
                    )}
                  </button>
                  {tanksOpen && (
                    <div className="mt-1.5 grid gap-1.5 rounded-[4px] border border-[#E4DEF8] bg-[#FAF9FE] p-2.5">
                      {tanks.length === 0 && (
                        <div className="text-[11px] font-semibold leading-snug text-[#5A6B62]">
                          Raw is one figure{valOf(r, 'qty') ? ` (${valOf(r, 'qty')})` : ''}. Add the tanks it stands in — the first starts from that figure.
                        </div>
                      )}
                      {tanks.map((l, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <input
                            list={`tanks-${String(r.id)}`}
                            placeholder={`Tank ${i + 1}`}
                            value={l.tank}
                            onChange={(e) => setTanks(r, tanks.map((x, k) => (k === i ? { ...x, tank: e.target.value.slice(0, 60) } : x)))}
                            className="h-11 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[13px] font-bold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6]"
                          />
                          <input
                            inputMode="decimal"
                            placeholder="0"
                            value={l.qty}
                            onChange={(e) =>
                              setTanks(r, tanks.map((x, k) => (k === i ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, '') } : x)))
                            }
                            className="h-11 w-[96px] rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-right text-[13px] font-bold tabular-nums text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6]"
                          />
                          <button
                            type="button"
                            aria-label="Remove this tank"
                            onClick={() => setTanks(r, tanks.filter((_, k) => k !== i))}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border border-[#F0D6D4] bg-white text-[#B3261E]"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      <datalist id={`tanks-${String(r.id)}`}>
                        {tankNames.map((nm) => (
                          <option key={nm} value={nm} />
                        ))}
                      </datalist>
                      <button
                        type="button"
                        onClick={() => setTanks(r, [...tanks, { tank: '', qty: tanks.length === 0 ? valOf(r, 'qty') : '' }])}
                        className="flex h-11 items-center justify-center gap-1.5 rounded-[4px] border border-dashed border-[#C7BCF0] bg-white text-[12px] font-extrabold text-[#3D3179]"
                      >
                        <Plus className="h-4 w-4" /> Add tank
                      </button>
                    </div>
                  )}
                </div>

                <div className="px-3.5 pb-3">
                  <button
                    type="button"
                    onClick={() => setPpRow(r)}
                    className={cn(
                      'flex h-11 w-full items-center gap-2.5 rounded-[4px] border px-3',
                      ppCount > 0
                        ? 'border-[#D6CEF5] bg-[#F6F3FD]'
                        : 'border-[#E1E8E0] bg-white'
                    )}
                  >
                    <Layers
                      className={cn('h-[17px] w-[17px] shrink-0', ppCount > 0 ? 'text-[#5B4BA8]' : 'text-[#7C9188]')}
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-left text-[11.5px] font-extrabold',
                        ppCount > 0 ? 'text-[#3D3179]' : 'text-[#5A6B62]'
                      )}
                    >
                      {ppCount > 0
                        ? `PP by stage · ${ppCount} vessel${ppCount === 1 ? '' : 's'}`
                        : 'Break PP down by stage'}
                    </span>
                    {ppCount > 0 ? (
                      <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-[#3D3179]">
                        {formatNum(r3(n(r.pp_qty)))}
                      </span>
                    ) : null}
                  </button>
                </div>

                <div
                  className={cn(
                    'flex items-center gap-2.5 border-t border-t-[#E4DEF8] px-3.5 py-2.5',
                    after < -0.0005 ? 'bg-[#FDF3F2]' : any ? 'bg-[#F6F3FD]' : 'bg-[#F7FAF6]'
                  )}
                >
                  <span className="text-[10px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">
                    Register opens at
                  </span>
                  <span
                    className={cn(
                      'ml-auto text-[14.5px] font-bold tabular-nums',
                      after < -0.0005 ? 'text-[#B3261E]' : 'text-[#3D3179]'
                    )}
                  >
                    {any ? formatNum(r3(total)) : '—'}
                  </span>
                  <span
                    className={cn(
                      'whitespace-nowrap text-[10.5px] font-bold',
                      after < -0.0005 ? 'text-[#B3261E]' : 'text-[#5A6B62]'
                    )}
                  >
                    closes {formatNum(after)}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>

      <PpBreakdown
        version={String(data?.version || '')}
        product={ppRow}
        open={!!ppRow}
        onOpenChange={(o) => !o && setPpRow(null)}
        onSaved={applyPp}
      />

      <SaveBar
        tone="violet"
        note={
          shorts.length
            ? `${shorts.length} product${shorts.length === 1 ? '' : 's'} still read below zero without an opening.`
            : `${entered} of ${rows.length} entered${asOf ? ` as at ${formatDate(asOf)}` : ''}.`
        }
        warn={shorts.length > 0}
        saving={saving}
        disabled={!asOf}
        label="Save opening"
        onSave={() => void save()}
      />
    </>
  )
}

function OpeningPacked(): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const d = await window.api.skuOpening.list()
      setData(d || null)
      setDraft({})
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const rows: Row[] = Array.isArray(data?.rows) ? (data?.rows as Row[]) : []
  const asOf = s(data?.as_of)
  const valOf = (r: Row): string => {
    const d = draft[String(r.id)]
    if (d != null) return d
    return r.qty == null ? '' : String(r.qty)
  }
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => s(r.name).toLowerCase().includes(q))
  }, [rows, query])
  const entered = rows.filter((r) => valOf(r) !== '').length

  async function save(): Promise<void> {
    if (!asOf) {
      toast.error('No opening date is set')
      return
    }
    setSaving(true)
    try {
      const res = await window.api.skuOpening.save(
        rows.map((r) => ({ packaging_id: r.id, qty: valOf(r), note: r.note ?? null })),
        asOf
      )
      toast.success(`${res.saved} saved, ${res.cleared} cleared`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-28 pt-1">
        <div className="flex items-center gap-2.5 rounded-[4px] border border-[#D6CEF5] border-l-[3px] border-l-[#5B4BA8] bg-[#EDE9FB] px-3.5 py-3">
          <Inbox className="h-[18px] w-[18px] shrink-0 text-[#5B4BA8]" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#3D3179]">
              Packed SKU opening
            </div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-[#4A3D8C]">
              {entered} of {rows.length} counted in their own pack type
              {asOf ? ` · ${formatDate(asOf)}` : ''}
            </div>
          </div>
        </div>

        <SearchBox value={query} onChange={setQuery} placeholder="SKU" />

        {loading ? (
          <Loading />
        ) : shown.length === 0 ? (
          <Empty title={query ? 'Nothing matches that.' : 'No packed SKUs.'} />
        ) : (
          shown.map((r, ri) => {
            const v = valOf(r)
            const after = r3(n(r.movement_closing) + n(v))
            const short = n(r.shortfall) > 0.0005 && v === ''
            return (
              <div
                key={String(r.id)}
                className={cn(
                  'overflow-hidden rounded-[4px] border border-[#E4DEF8] border-l-[3px] bg-white',
                  short ? 'border-l-[#B3261E]' : v !== '' ? 'border-l-[#5B4BA8]' : 'border-l-[#C3D2C6]'
                )}
              >
                <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
                  <SerialNo n={ri + 1} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-extrabold leading-snug tracking-[-0.01em] text-[#0A1F17]">
                      {s(r.name)}
                    </div>
                    {/* Pack and Type, named the way the packed register
                        names them: the size of one counted piece, and what
                        that piece is called. */}
                    <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">
                      {n(r.unit_size) > 0
                        ? `${formatNum(r.unit_size)} ${s(r.unit_uom)}`
                        : n(r.base_per_pouch) > 0
                          ? `${formatNum(r.base_per_pouch)} ${s(r.base_uom)}`
                          : '—'}
                      {s(r.pouch_label) ? ` · ${s(r.pouch_label).toUpperCase()}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Moved since</div>
                    <div
                      className={cn(
                        'mt-0.5 text-[13.5px] font-bold tabular-nums',
                        n(r.movement_closing) < -0.0005 ? 'text-[#B3261E]' : 'text-[#33473E]'
                      )}
                    >
                      {formatNum(r3(n(r.movement_closing)))}
                    </div>
                  </div>
                </div>
                <div className="px-3.5 pb-3">
                  <Num
                    label="Counted that morning"
                    value={v}
                    placeholder="not counted"
                    onChange={(nv) => setDraft((p) => ({ ...p, [String(r.id)]: nv }))}
                  />
                </div>
                <div
                  className={cn(
                    'flex items-center gap-2.5 border-t border-t-[#E4DEF8] px-3.5 py-2.5',
                    after < -0.0005 ? 'bg-[#FDF3F2]' : v !== '' ? 'bg-[#F6F3FD]' : 'bg-[#F7FAF6]'
                  )}
                >
                  <span className="text-[10px] font-extrabold uppercase tracking-[.09em] text-[#5A6B62]">
                    Register opens at
                  </span>
                  <span
                    className={cn(
                      'ml-auto text-[14.5px] font-bold tabular-nums',
                      after < -0.0005 ? 'text-[#B3261E]' : 'text-[#3D3179]'
                    )}
                  >
                    {v !== '' ? formatNum(r3(n(v))) : '—'}
                  </span>
                  <span className="whitespace-nowrap text-[10.5px] font-bold text-[#5A6B62]">
                    closes {formatNum(after)}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>

      <SaveBar
        tone="violet"
        note={`${entered} of ${rows.length} counted. Blank keeps a SKU off the register; 0 states it opened at nothing.`}
        saving={saving}
        disabled={!asOf}
        label="Save opening"
        onSave={() => void save()}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Furniture.
function Kpis({
  tone,
  items,
  dense
}: {
  tone: 'green' | 'violet'
  items: { k: string; v: string; warn?: boolean }[]
  /** One row, smaller — where the screen below needs the room. */
  dense?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('shrink-0 px-4', dense ? 'pb-2.5 pt-1' : 'pb-3 pt-3', tone === 'violet' ? 'bg-[#3D3179]' : 'bg-[#0B3D2E]')}>
      <div className={cn('grid gap-2', dense ? 'grid-cols-3' : 'grid-cols-2')}>
        {items.map((c) => (
          <div key={c.k} className={cn('min-w-0 rounded-[4px] bg-white/10', dense ? 'px-2.5 py-1.5' : 'px-3 py-2.5')}>
            <div className={cn('text-[9px] font-extrabold uppercase tracking-[.1em]', tone === 'violet' ? 'text-[#C9BEF5]' : 'text-[#8FBFA8]')}>
              {c.k}
            </div>
            <div
              className={cn(
                'mt-1 text-[14px] font-bold tracking-[-0.02em] tabular-nums',
                c.warn ? 'text-[#FFC4BE]' : 'text-white'
              )}
            >
              {c.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SearchBox({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}): React.JSX.Element {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
      <Search className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
      />
      {value ? (
        <button type="button" onClick={() => onChange('')} className="shrink-0 text-[#5A6B62]">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}

function Lbl({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-1.5 text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{children}</div>
}

function Num({
  label,
  value,
  onChange,
  placeholder,
  readOnly
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <Lbl>{label}</Lbl>
      <input
        value={value}
        inputMode="decimal"
        readOnly={readOnly}
        placeholder={placeholder ?? '—'}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-11 w-full rounded-[4px] border border-[#C3D2C6] px-2.5 text-right text-[13px] font-bold tabular-nums text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6]',
          readOnly ? 'bg-[#F1F5EF]' : 'bg-white'
        )}
      />
    </div>
  )
}

function SaveBar({
  tone,
  note,
  warn,
  saving,
  disabled,
  label,
  onSave
}: {
  tone: 'green' | 'violet'
  note: string
  warn?: boolean
  saving: boolean
  disabled?: boolean
  label: string
  onSave: () => void
}): React.JSX.Element {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
      <div className="mb-2 flex items-start gap-2">
        <AlertTriangle className={cn('mt-0.5 h-[16px] w-[16px] shrink-0', warn ? 'text-[#8A5300]' : 'text-[#8FA79B]')} />
        <span className={cn('text-[11px] font-bold leading-snug', warn ? 'text-[#8A5300]' : 'text-[#5A6B62]')}>{note}</span>
      </div>
      <button
        type="button"
        disabled={saving || disabled}
        onClick={onSave}
        className={cn(
          'flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] text-[13.5px] font-extrabold',
          saving || disabled ? 'bg-[#DCE7DB] text-[#8FA79B]' : tone === 'violet' ? 'bg-[#5B4BA8] text-white' : 'bg-[#0B3D2E] text-[#C7F03F]'
        )}
      >
        {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
        {label}
      </button>
    </div>
  )
}

function Loading(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] font-bold text-[#5A6B62]">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  )
}
function Failed({ msg }: { msg: string }): React.JSX.Element {
  return (
    <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
      {msg}
    </div>
  )
}
function Empty({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
      <Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />
      <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">{title}</p>
    </div>
  )
}
