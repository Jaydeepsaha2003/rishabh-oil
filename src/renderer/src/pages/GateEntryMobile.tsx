// Mobile Gate Entry — website only (see the fork in GateEntry.tsx).
//
// Built to the "Gate entry — mobile" screen of the handoff. This is the one
// page in the app whose users are genuinely standing up: a supervisor at the
// barrier and a weighbridge operator beside a machine, neither of them at a
// desk. So the two jobs they do all day — take a weight, log a vehicle — are
// the two things this screen is built around, and everything else on it is
// there to look something up.
//
// SCOPE, stated plainly because it is a decision and not an omission:
//
//   Weights, dispatch quantity, vehicle number, in-time and note can all be
//   recorded and corrected here. A vehicle with nothing behind it — no
//   document, no weighment — can be logged in full ("Record a tanker", the
//   desktop's own `entry_kind: 'simple'`).
//
//   What is NOT here is the document-linked arrival: choosing a purchase
//   bargain, a party by category, a record type, or the sale invoices a
//   vehicle carries out. Those need the master lists and the category
//   machinery the desktop form carries, and a phone-sized version of that
//   flow would be a second implementation of the app's most delicate form.
//   An entry created there is fully readable and weighable here.
//
// One trap worth knowing about: gate.update REPLACES every column it is
// given. A partial payload would silently null the party, the invoice link
// and the record type — so every save here merges its changes onto the row
// as loaded and sends the lot back.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  Save,
  Scale,
  Search,
  Truck,
  X
} from 'lucide-react'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const round3 = (v: number): number => Math.round(v * 1000) / 1000
const isNa = (v: unknown): boolean => String(v ?? '').trim().toUpperCase() === 'NA'

// Who the entry is against, whichever side of the gate it is. The desktop
// register resolves the same three in the same order.
const partyOf = (r: Row): string =>
  s(r.supplier_name) || s(r.gate_customer_name) || s(r.sale_customer) || '—'

const dirOf = (r: Row): 'in' | 'out' => (String(r.direction || 'in') === 'out' ? 'out' : 'in')

type Tab = 'in' | 'out' | 'view' | 'rejected'

export function GateEntryMobile(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [tab, setTab] = useState<Tab>('in')
  const [query, setQuery] = useState('')
  const [screen, setScreen] = useState<null | { mode: 'edit'; id: number } | { mode: 'new' }>(null)
  // Weights being typed, keyed by entry id, so a half-entered figure survives
  // a re-render and a tab change.
  const [draft, setDraft] = useState<Record<string, { gross?: string; tare?: string }>>({})
  const [savingId, setSavingId] = useState(0)

  async function load(): Promise<void> {
    setLoading(true)
    setFailed('')
    try {
      const r = await window.api.gate.list()
      setRows(Array.isArray(r) ? r : [])
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // The same four buckets the desktop tabs hold, derived the same way — a
  // count that disagreed with the laptop's would be worse than no count.
  const buckets = useMemo(() => {
    const rejected = rows.filter((r) => !!r.rejected_at)
    const pending = rows.filter((r) => s(r.status) === 'pending' && !r.rejected_at)
    // Vehicles weighed tare-first at Gate In whose gross will be taken as
    // they leave: they have moved over to the out queue entirely.
    const awaitingGross = pending.filter((r) => dirOf(r) === 'in' && !!r.awaiting_gross_out && r.gross_weight == null)
    const inQ = pending.filter((r) => dirOf(r) === 'in' && !awaitingGross.includes(r))
    const outQ = [...pending.filter((r) => dirOf(r) === 'out'), ...awaitingGross]
    return { rejected, inQ, outQ }
  }, [rows])

  const register = useMemo(() => {
    const q = query.trim().toLowerCase()
    const live = rows.filter((r) => !r.rejected_at)
    if (!q) return live
    return live.filter((r) =>
      [r.gate_entry_no, r.ref_no, r.tanker_no, partyOf(r), r.rec_type, r.sale_invoices].some((f) =>
        s(f).toLowerCase().includes(q)
      )
    )
  }, [rows, query])

  const kpis = useMemo(() => {
    const today = todayISO()
    const todays = rows.filter((r) => s(r.entry_date).slice(0, 10) === today && !r.rejected_at)
    return [
      { k: 'In today', v: String(todays.filter((r) => dirOf(r) === 'in').length), fg: 'text-white' },
      { k: 'Out today', v: String(todays.filter((r) => dirOf(r) === 'out').length), fg: 'text-white' },
      {
        k: 'Waiting on weight',
        v: String(buckets.inQ.length + buckets.outQ.length),
        fg: buckets.inQ.length + buckets.outQ.length ? 'text-[#FFD9A8]' : 'text-[#C7F03F]'
      },
      {
        k: 'Rejected',
        v: String(buckets.rejected.length),
        fg: buckets.rejected.length ? 'text-[#FFC4BE]' : 'text-[#C7F03F]'
      }
    ]
  }, [rows, buckets])

  // Save whatever is on the weighbridge slip so far. One figure keeps the
  // vehicle in the queue; both complete it — the same rule the desk follows.
  async function saveWeights(row: Row): Promise<void> {
    const d = draft[String(row.id)] || {}
    const gross = d.gross != null && d.gross !== '' ? Number(d.gross) : row.gross_weight != null ? n(row.gross_weight) : null
    const tare = d.tare != null && d.tare !== '' ? Number(d.tare) : row.tare_weight != null ? n(row.tare_weight) : null
    if (gross == null && tare == null) {
      toast.error('Enter the gross or the tare weight')
      return
    }
    if (gross != null && tare != null && round3(gross - tare) <= 0) {
      toast.error('Net (gross − tare) must be more than zero — check the two figures')
      return
    }
    setSavingId(n(row.id))
    try {
      const dispatch = row.dispatch_na ? 'NA' : row.dispatch_qty == null ? null : n(row.dispatch_qty)
      const r = await window.api.gate.weights(n(row.id), gross, tare, undefined, dispatch)
      toast.success(
        r.status === 'completed'
          ? `${s(row.tanker_no)} completed — net ${formatNum(r.net || 0)} ${s(row.uom || 'MT')}`
          : `${s(row.tanker_no)}: saved — still waiting for the ${r.missing}`
      )
      setDraft((p) => {
        const next = { ...p }
        delete next[String(row.id)]
        return next
      })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingId(0)
    }
  }

  if (screen?.mode === 'new') {
    return (
      <QuickEntry
        onClose={() => setScreen(null)}
        onSaved={async () => {
          setScreen(null)
          await load()
        }}
      />
    )
  }
  if (screen?.mode === 'edit') {
    const row = rows.find((r) => n(r.id) === screen.id)
    if (row) {
      return (
        <EditEntry
          row={row}
          onClose={() => setScreen(null)}
          onSaved={async () => {
            setScreen(null)
            await load()
          }}
        />
      )
    }
  }

  const tabs: { k: Tab; label: string; count: number }[] = [
    { k: 'in', label: 'Gate in', count: buckets.inQ.length },
    { k: 'out', label: 'Gate out', count: buckets.outQ.length },
    { k: 'view', label: 'Entries', count: register.length },
    { k: 'rejected', label: 'Rejected', count: buckets.rejected.length }
  ]
  const queue = tab === 'in' ? buckets.inQ : tab === 'out' ? buckets.outQ : []

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-4 pb-3 pt-3 text-white">
        <div className="min-w-0">
          <div className="text-[19px] font-extrabold tracking-[-0.02em]">Gate entry</div>
          <div className="mt-0.5 text-[11.5px] font-bold text-[#8FBFA8]">{formatDate(todayISO())}</div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {kpis.map((c) => (
            <div key={c.k} className="min-w-0 rounded-[4px] bg-white/[0.08] px-3 py-2.5">
              <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{c.k}</div>
              <div className={cn('mt-1 text-[14px] font-extrabold tracking-[-0.02em] tabular-nums', c.fg)}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 overflow-x-auto border-b border-[#D6E2D6] bg-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = tab === t.k
          const red = t.k === 'rejected'
          return (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              className={cn(
                'flex h-[50px] shrink-0 items-center gap-2 border-b-[3px] px-4 text-[12.5px] font-extrabold',
                on
                  ? red
                    ? 'border-b-[#B3261E] text-[#8C2F26]'
                    : 'border-b-[#0B3D2E] text-[#0A1F17]'
                  : 'border-b-transparent text-[#8FA79B]'
              )}
            >
              {t.label}
              {t.count > 0 ? (
                <span
                  className={cn(
                    'rounded-[2px] px-1.5 py-0.5 text-[10.5px] font-extrabold tabular-nums',
                    on ? (red ? 'bg-[#FDF3F2] text-[#8C2F26]' : 'bg-[#EFF5EC] text-[#0B6B45]') : 'bg-[#EAF0E9] text-[#5A6B62]'
                  )}
                >
                  {t.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-24 pt-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] font-bold text-[#5A6B62]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the gate register…
          </div>
        ) : failed ? (
          <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
            {failed}
          </div>
        ) : tab === 'in' || tab === 'out' ? (
          queue.length === 0 ? (
            <Empty
              icon={<CheckCircle2 className="mx-auto h-7 w-7 text-[#9CCFAE]" />}
              title="Nothing waiting"
              note={tab === 'in' ? 'Every vehicle at the barrier has its weights.' : 'Nothing is waiting to leave.'}
            />
          ) : (
            queue.map((r) => (
              <WeighCard
                key={String(r.id)}
                row={r}
                draft={draft[String(r.id)] || {}}
                saving={savingId === n(r.id)}
                onDraft={(k, v) =>
                  setDraft((p) => ({ ...p, [String(r.id)]: { ...(p[String(r.id)] || {}), [k]: v } }))
                }
                onSave={() => void saveWeights(r)}
                onOpen={() => setScreen({ mode: 'edit', id: n(r.id) })}
              />
            ))
          )
        ) : tab === 'view' ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
              <Search className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Gate no, vehicle or party"
                className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} className="shrink-0 text-[#5A6B62]">
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            {register.length === 0 ? (
              <Empty icon={<Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />} title="Nothing matches that." note="" />
            ) : (
              register.map((r) => (
                <RegisterCard key={String(r.id)} row={r} onOpen={() => setScreen({ mode: 'edit', id: n(r.id) })} />
              ))
            )}
          </>
        ) : buckets.rejected.length === 0 ? (
          <Empty icon={<CheckCircle2 className="mx-auto h-7 w-7 text-[#9CCFAE]" />} title="Nothing rejected" note="" />
        ) : (
          buckets.rejected.map((r) => <RegisterCard key={String(r.id)} row={r} rejected onOpen={() => undefined} />)
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        <button
          type="button"
          onClick={() => setScreen({ mode: 'new' })}
          className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13.5px] font-extrabold text-[#C7F03F]"
        >
          <Plus className="h-5 w-5" /> Record a tanker
        </button>
      </div>
    </div>
  )
}

function Empty({ icon, title, note }: { icon: React.ReactNode; title: string; note: string }): React.JSX.Element {
  return (
    <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
      {icon}
      <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">{title}</p>
      {note ? <p className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">{note}</p> : null}
    </div>
  )
}

// The weighbridge card: what is known, what is missing, and a box for it.
//
// Only the missing figure is a field. A gross already taken is a fact, and
// re-opening it invites a slip of the thumb on the one number the whole
// invoice is settled against — it can still be corrected, on the entry
// itself, deliberately.
function WeighCard({
  row,
  draft,
  saving,
  onDraft,
  onSave,
  onOpen
}: {
  row: Row
  draft: { gross?: string; tare?: string }
  saving: boolean
  onDraft: (k: 'gross' | 'tare', v: string) => void
  onSave: () => void
  onOpen: () => void
}): React.JSX.Element {
  const uom = s(row.uom || 'MT')
  const hasGross = row.gross_weight != null
  const hasTare = row.tare_weight != null
  const gross = draft.gross != null && draft.gross !== '' ? Number(draft.gross) : hasGross ? n(row.gross_weight) : null
  const tare = draft.tare != null && draft.tare !== '' ? Number(draft.tare) : hasTare ? n(row.tare_weight) : null
  const net = gross != null && tare != null ? round3(gross - tare) : null
  const dispatch = row.dispatch_na ? 'NA' : row.dispatch_qty != null && n(row.dispatch_qty) > 0 ? formatNum(row.dispatch_qty) : '—'
  // What the slip will settle at, before it is saved. A shortage found here
  // is one the driver is still standing next to.
  const shortage = net != null && !row.dispatch_na && n(row.dispatch_qty) > 0 ? round3(n(row.dispatch_qty) - net) : null

  return (
    <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#C2700A] bg-white">
      <button type="button" onClick={onOpen} className="w-full px-3.5 pb-2 pt-3 text-left">
        <div className="flex items-center gap-2.5">
          <span className="text-[14.5px] font-bold tracking-[-0.01em] text-[#0A1F17]">{s(row.tanker_no) || '—'}</span>
          <span className="ml-auto shrink-0 text-[11px] font-bold tabular-nums text-[#5A6B62]">
            {s(row.gate_entry_no)}
          </span>
        </div>
        <div className="mt-1 text-[12px] font-bold leading-snug text-[#33473E]">{partyOf(row)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10px] font-extrabold tracking-[.05em] text-[#33473E]">
            {s(row.rec_type) || 'OIL'}
          </span>
          {row.bargain_no ? (
            <span className="text-[11px] font-semibold text-[#5A6B62]">{s(row.bargain_no)}</span>
          ) : null}
          <span className="ml-auto text-[10.5px] font-semibold text-[#8FA79B]">
            {formatDate(row.entry_date)} {s(row.entry_time).slice(0, 5)}
          </span>
        </div>
      </button>

      <div className="grid grid-cols-2 gap-2.5 px-3.5 pb-3 pt-1">
        <Box label="Dispatch" value={dispatch === '—' ? '—' : `${dispatch}`} />
        {hasGross ? (
          <Box label="Gross" value={formatNum(row.gross_weight)} />
        ) : (
          <FieldNum label="Gross *" value={draft.gross ?? ''} onChange={(v) => onDraft('gross', v)} />
        )}
        {hasTare ? (
          <Box label="Tare" value={formatNum(row.tare_weight)} />
        ) : (
          <FieldNum label="Tare *" value={draft.tare ?? ''} onChange={(v) => onDraft('tare', v)} />
        )}
        <Box
          label="Net"
          value={net == null ? '—' : formatNum(net)}
          tone={net == null ? '' : 'bg-[#EAF6EC] text-[#0B6B45]'}
        />
      </div>

      {shortage != null && Math.abs(shortage) > 0.0005 ? (
        <div
          className={cn(
            'flex items-start gap-2.5 border-t px-3.5 py-2.5',
            shortage > 0 ? 'border-t-[#F0D9AE] bg-[#FFFBF2]' : 'border-t-[#BFE3CB] bg-[#EAF6EC]'
          )}
        >
          <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', shortage > 0 ? 'text-[#C2700A]' : 'text-[#0B6B45]')} />
          <span className={cn('text-[11.5px] font-bold leading-snug', shortage > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]')}>
            {shortage > 0
              ? `${formatNum(shortage)} ${uom} short of the ${formatNum(row.dispatch_qty)} dispatched.`
              : `${formatNum(Math.abs(shortage))} ${uom} over the dispatched quantity.`}
          </span>
        </div>
      ) : null}

      {/* A vehicle weighed tare-first at Gate In takes its gross as it
          LEAVES, and completing it means naming the sale invoices it is
          carrying out and the day it left. That picker is a desk job — and
          saving the gross without it would complete the entry while leaving
          the sale unmarked, which is worse than not saving at all. */}
      {row.awaiting_gross_out ? (
        <div className="flex items-start gap-2.5 border-t border-t-[#D6E2D6] bg-[#F7FAF6] px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#5A6B62]" />
          <span className="text-[11.5px] font-semibold leading-relaxed text-[#5A6B62]">
            This one takes its gross as it leaves, against the sale invoices it carries. Complete it at
            the desk so those can be linked.
          </span>
        </div>
      ) : (
      <div className="border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-3.5 py-2.5">
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className={cn(
            'flex h-12 w-full items-center justify-center gap-2 rounded-[4px] text-[12.5px] font-extrabold uppercase tracking-[.03em]',
            saving ? 'bg-[#DCE7DB] text-[#8FA79B]' : 'bg-[#0B3D2E] text-[#C7F03F]'
          )}
        >
          {saving ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <Scale className="h-[18px] w-[18px]" />}
          {net == null ? 'Save what is taken' : 'Complete the entry'}
        </button>
      </div>
      )}
    </div>
  )
}

function RegisterCard({ row, rejected, onOpen }: { row: Row; rejected?: boolean; onOpen: () => void }): React.JSX.Element {
  const out = dirOf(row) === 'out'
  const done = s(row.status) === 'completed'
  const uom = s(row.uom || 'MT')
  const dis = row.dispatch_na ? 'NA' : n(row.dispatch_qty) > 0 ? `${formatNum(row.dispatch_qty)} ${uom}` : '—'
  const rec = n(row.received_qty) > 0 ? `${formatNum(row.received_qty)} ${uom}` : '—'
  const diff =
    !row.dispatch_na && n(row.dispatch_qty) > 0 && n(row.received_qty) > 0
      ? round3(n(row.dispatch_qty) - n(row.received_qty))
      : null
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white text-left',
        rejected ? 'border-l-[#B3261E]' : done ? 'border-l-[#12855A]' : 'border-l-[#C2700A]'
      )}
    >
      <div className="flex flex-col gap-1.5 px-3.5 pb-2.5 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-bold tabular-nums text-[#0A1F17]">{s(row.gate_entry_no)}</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-[2px] px-1.5 py-0.5 text-[10px] font-extrabold tracking-[.06em]',
              out ? 'bg-[#EAF0FA] text-[#1B4E82]' : 'bg-[#EFF5EC] text-[#0B6B45]'
            )}
          >
            {out ? <LogOut className="h-3 w-3" /> : <LogIn className="h-3 w-3" />}
            {out ? 'OUT' : 'IN'}
          </span>
          <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-extrabold tracking-[.05em] text-[#33473E]">
            {s(row.rec_type) || 'OIL'}
          </span>
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[10px] font-extrabold',
              rejected
                ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#8C2F26]'
                : done
                  ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                  : 'border-[#F0D9AE] bg-[#FFFBF2] text-[#8A5300]'
            )}
          >
            {rejected ? <Ban className="h-3 w-3" /> : done ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
            {rejected ? 'Rejected' : done ? 'Completed' : 'Pending wt.'}
          </span>
        </div>
        <div className="text-[13px] font-bold tabular-nums text-[#0A1F17]">{s(row.tanker_no) || '—'}</div>
        <div className="text-[11.5px] font-bold leading-snug text-[#33473E]">{partyOf(row)}</div>
        <div className="text-[10.5px] font-semibold tabular-nums text-[#5A6B62]">
          IN {formatDate(row.entry_date)} {s(row.entry_time).slice(0, 5)}
          {row.out_date ? ` · OUT ${formatDate(row.out_date)} ${s(row.out_time).slice(0, 5)}` : ''}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-3.5 py-2.5">
        {[
          { k: 'Dis qty', v: dis, tone: 'text-[#33473E]' },
          { k: 'Rec net', v: rec, tone: 'text-[#0A1F17]' },
          {
            k: 'Difference',
            v: diff == null ? '—' : `${formatNum(diff)} ${uom}`,
            tone: diff == null ? 'text-[#8FA79B]' : diff > 0.0005 ? 'text-[#B3261E]' : 'text-[#0B6B45]'
          }
        ].map((f) => (
          <div key={f.k} className="min-w-0">
            <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{f.k}</div>
            <div className={cn('mt-1 truncate text-[12.5px] font-bold tabular-nums', f.tone)}>{f.v}</div>
          </div>
        ))}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// One entry, opened.
//
// gate.update replaces every column, so the payload below starts from the row
// as loaded and only overwrites what this screen actually edits. Party,
// bargain, record type and invoice links ride through untouched.
function EditEntry({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const uom = s(row.uom || 'MT')
  const [tanker, setTanker] = useState(s(row.tanker_no))
  const [time, setTime] = useState(s(row.entry_time).slice(0, 5))
  const [gross, setGross] = useState(row.gross_weight == null ? '' : String(row.gross_weight))
  const [tare, setTare] = useState(row.tare_weight == null ? '' : String(row.tare_weight))
  const [manualNet, setManualNet] = useState(row.gross_weight == null && row.tare_weight == null ? String(row.received_qty ?? '') : '')
  const [noWeigh, setNoWeigh] = useState(row.gross_weight == null && row.tare_weight == null)
  const [dispatch, setDispatch] = useState(row.dispatch_na ? 'NA' : row.dispatch_qty == null ? '' : String(row.dispatch_qty))
  const [note, setNote] = useState(s(row.note))
  const [saving, setSaving] = useState(false)

  const g = gross === '' ? null : Number(gross)
  const t = tare === '' ? null : Number(tare)
  const net = noWeigh ? (manualNet === '' ? null : Number(manualNet)) : g != null && t != null ? round3(g - t) : null
  const disQty = isNa(dispatch) ? null : dispatch === '' ? null : Number(dispatch)
  const shortage = net != null && disQty != null ? round3(disQty - net) : null

  async function save(): Promise<void> {
    if (!tanker.trim()) {
      toast.error('Enter the vehicle number')
      return
    }
    if (!noWeigh && g != null && t != null && round3(g - t) <= 0) {
      toast.error('Net (gross − tare) must be more than zero')
      return
    }
    setSaving(true)
    try {
      await window.api.gate.update(n(row.id), {
        // Everything the row already carries, so a column this screen does
        // not show cannot be nulled by saving from it.
        ...row,
        tanker_no: tanker.trim(),
        entry_time: time || null,
        gross_weight: noWeigh ? '' : gross,
        tare_weight: noWeigh ? '' : tare,
        received_qty: noWeigh ? manualNet : undefined,
        dispatch_qty: isNa(dispatch) ? 0 : dispatch,
        dispatch_na: isNa(dispatch),
        note: note || null
      })
      toast.success(`${tanker.trim()} saved`)
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      eyebrow="Gate entry"
      title={s(row.gate_entry_no)}
      chip={s(row.status) === 'completed' ? 'Completed' : 'Pending wt.'}
      chipTone={s(row.status) === 'completed' ? 'bg-[#C7F03F] text-[#12280B]' : 'bg-[#FFEDD0] text-[#8A5300]'}
      onClose={onClose}
      footerNote={
        shortage != null && Math.abs(shortage) > 0.0005
          ? shortage > 0
            ? `${formatNum(shortage)} ${uom} short of the dispatched quantity.`
            : `${formatNum(Math.abs(shortage))} ${uom} over the dispatched quantity.`
          : net == null
            ? 'An entry with no net stays in the queue as pending.'
            : ''
      }
      footerTone={shortage != null && shortage > 0.0005 ? 'warn' : 'quiet'}
      saving={saving}
      onSave={() => void save()}
    >
      <Card title="Vehicle and party">
        <FieldNum label="Vehicle" value={tanker} onChange={setTanker} text />
        <Readout label="Party" value={partyOf(row)} />
        <div className="grid grid-cols-[1fr_112px] gap-2.5">
          <Readout label="Date" value={formatDate(row.entry_date)} />
          <FieldNum label="In time" value={time} onChange={setTime} text center />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <Readout label="Direction" value={dirOf(row) === 'out' ? 'Gate out' : 'Gate in'} />
          <Readout label="Material" value={s(row.rec_type) || 'OIL'} />
        </div>
      </Card>

      <Card
        title="Weighment"
        right={
          <button
            type="button"
            onClick={() => setNoWeigh((v) => !v)}
            className="flex h-11 items-center gap-2 pl-2"
          >
            <span className="whitespace-nowrap text-[11px] font-extrabold text-[#5A6B62]">No weighment</span>
            <span
              className={cn(
                'flex h-6 w-[42px] items-center rounded-[3px] p-[3px]',
                noWeigh ? 'justify-end bg-[#0B3D2E]' : 'justify-start bg-[#C3D2C6]'
              )}
            >
              <span className="h-[18px] w-[18px] rounded-[2px] bg-white" />
            </span>
          </button>
        }
      >
        {!noWeigh ? (
          <div className="grid grid-cols-2 gap-2.5">
            <FieldNum label="Gross" value={gross} onChange={setGross} />
            <FieldNum label="Tare" value={tare} onChange={setTare} />
          </div>
        ) : null}
        {noWeigh ? (
          <FieldNum label={`Net (typed, ${uom})`} value={manualNet} onChange={setManualNet} />
        ) : (
          <Readout label="Net" value={net == null ? '—' : `${formatNum(net)} ${uom}`} strong />
        )}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="flex-1 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
              Dispatch qty
            </span>
            {/* NA is the answer when nothing was dispatched against this
                vehicle at all — an empty box would read as "not entered yet"
                and keep the shortage arithmetic running on a zero. */}
            <button
              type="button"
              onClick={() => setDispatch(isNa(dispatch) ? '' : 'NA')}
              className={cn(
                'flex h-9 items-center rounded-[3px] border px-3.5 text-[11.5px] font-extrabold',
                isNa(dispatch) ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#C3D2C6] bg-white text-[#5A6B62]'
              )}
            >
              NA
            </button>
          </div>
          <input
            value={dispatch}
            inputMode="decimal"
            disabled={isNa(dispatch)}
            onChange={(e) => setDispatch(e.target.value)}
            className={cn(
              'h-[46px] w-full rounded-[4px] border px-3 text-right text-[14px] font-bold tabular-nums outline-none',
              isNa(dispatch) ? 'border-[#E4ECE3] bg-[#F7FAF6] text-[#A8B8AE]' : 'border-[#C3D2C6] bg-white text-[#0A1F17]'
            )}
          />
        </div>
        {shortage != null && Math.abs(shortage) > 0.0005 ? (
          <div
            className={cn(
              'rounded-[4px] border border-l-[3px] px-3 py-2.5',
              shortage > 0 ? 'border-[#F0D9AE] border-l-[#C2700A] bg-[#FFFBF2]' : 'border-[#BFE3CB] border-l-[#0B6B45] bg-[#EAF6EC]'
            )}
          >
            <div className="flex items-center gap-2.5">
              <AlertTriangle className={cn('h-4 w-4 shrink-0', shortage > 0 ? 'text-[#C2700A]' : 'text-[#0B6B45]')} />
              <span
                className={cn(
                  'text-[10px] font-extrabold uppercase tracking-[.09em]',
                  shortage > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                )}
              >
                {shortage > 0 ? 'Shortage' : 'Excess'}
              </span>
              <span
                className={cn(
                  'ml-auto text-[14px] font-bold tabular-nums',
                  shortage > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                )}
              >
                {formatNum(Math.abs(shortage))} {uom}
              </span>
              {disQty ? (
                <span
                  className={cn('text-[11.5px] font-bold tabular-nums', shortage > 0 ? 'text-[#8A5300]' : 'text-[#0B6B45]')}
                >
                  {((Math.abs(shortage) / disQty) * 100).toFixed(2)}%
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="Note">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the desk should know"
          className="h-[46px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
        />
      </Card>
    </Sheet>
  )
}

// A vehicle with nothing behind it: no document, no weighment, no stock. The
// desktop's own quick entry, which is the one arrival a phone can complete
// without the master lists.
function QuickEntry({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const [dir, setDir] = useState<'in' | 'out'>('in')
  const [tanker, setTanker] = useState('')
  const [person, setPerson] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    if (!tanker.trim()) {
      toast.error('Enter the vehicle number')
      return
    }
    if (!note.trim()) {
      toast.error('Say what the vehicle is carrying')
      return
    }
    setSaving(true)
    try {
      await window.api.gate.create({
        entry_kind: 'simple',
        direction: dir,
        entry_date: todayISO(),
        tanker_no: tanker.trim(),
        person: person.trim() || null,
        note: note.trim(),
        rec_type: 'MISCELLANEOUS',
        dispatch_qty: 0,
        received_qty: 0,
        no_weighment: true
      })
      toast.success(`${tanker.trim()} logged at the gate`)
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      eyebrow="Gate entry"
      title="Record a tanker"
      onClose={onClose}
      saving={saving}
      onSave={() => void save()}
      footerNote="A gate line with nothing behind it — no document, no weighment, no stock. A tanker against a purchase or a sale is recorded at the desk."
      footerTone="quiet"
    >
      <Card title="At the barrier">
        <div>
          <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Direction</div>
          <div className="flex gap-1 rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-1">
            {(
              [
                ['in', 'Coming in'],
                ['out', 'Going out']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setDir(k)}
                className={cn(
                  'h-10 min-w-0 flex-1 rounded-[2px] text-[12.5px] font-extrabold',
                  dir === k ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'text-[#5A6B62]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <FieldNum label="Vehicle *" value={tanker} onChange={setTanker} text />
        <FieldNum label="Driver or person" value={person} onChange={setPerson} text />
        <div>
          <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
            What is it carrying? *
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. spares for the boiler"
            className="h-[46px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
          />
        </div>
        <div className="flex items-start gap-2 rounded-[4px] border border-[#D6E2D6] bg-[#F7FAF6] px-3 py-2.5">
          <Truck className="mt-0.5 h-4 w-4 shrink-0 text-[#5A6B62]" />
          <span className="text-[11.5px] font-semibold leading-relaxed text-[#5A6B62]">
            Dated today and logged without weights. It appears in Entries straight away.
          </span>
        </div>
      </Card>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Shared furniture.
function Sheet({
  eyebrow,
  title,
  chip,
  chipTone,
  children,
  onClose,
  onSave,
  saving,
  footerNote,
  footerTone
}: {
  eyebrow: string
  title: string
  chip?: string
  chipTone?: string
  children: React.ReactNode
  onClose: () => void
  onSave: () => void
  saving: boolean
  footerNote?: string
  footerTone?: 'warn' | 'quiet'
}): React.JSX.Element {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-3 pb-3 pt-2 text-white">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] active:bg-white/10"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">{eyebrow}</div>
            <div className="mt-0.5 truncate text-[16px] font-bold tabular-nums">{title}</div>
          </div>
          {chip ? (
            <span className={cn('shrink-0 rounded-[2px] px-2.5 py-1.5 text-[10px] font-extrabold tracking-[.06em]', chipTone)}>
              {chip}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-6 pt-3">{children}</div>

      <div className="shrink-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        {footerNote ? (
          <div className="mb-2 flex items-start gap-2">
            <AlertTriangle
              className={cn('mt-0.5 h-[17px] w-[17px] shrink-0', footerTone === 'warn' ? 'text-[#8A5300]' : 'text-[#8FA79B]')}
            />
            <span
              className={cn(
                'text-[11.5px] font-bold leading-snug',
                footerTone === 'warn' ? 'text-[#8A5300]' : 'text-[#5A6B62]'
              )}
            >
              {footerNote}
            </span>
          </div>
        ) : null}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-[50px] flex-1 items-center justify-center rounded-[4px] border-[1.5px] border-[#C3D2C6] text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className={cn(
              'flex h-[50px] flex-[1.3] items-center justify-center gap-2 rounded-[4px] text-[13px] font-extrabold uppercase tracking-[.03em]',
              saving ? 'bg-[#DCE7DB] text-[#8FA79B]' : 'bg-[#0B3D2E] text-[#C7F03F]'
            )}
          >
            {saving ? <Loader2 className="h-[19px] w-[19px] animate-spin" /> : <Save className="h-[19px] w-[19px]" />}
            Save entry
          </button>
        </div>
      </div>
    </div>
  )
}

function Card({
  title,
  right,
  children
}: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
          {title}
        </span>
        {right}
      </div>
      {children}
    </div>
  )
}

function FieldNum({
  label,
  value,
  onChange,
  text,
  center
}: {
  label: string
  value: string
  onChange: (v: string) => void
  text?: boolean
  center?: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{label}</div>
      <input
        value={value}
        inputMode={text ? undefined : 'decimal'}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-[46px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[14px] font-bold tabular-nums text-[#0A1F17] outline-none',
          center ? 'text-center' : text ? 'text-left' : 'text-right'
        )}
      />
    </div>
  )
}

function Box({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{label}</div>
      <div
        className={cn(
          'flex h-11 items-center justify-end rounded-[4px] px-3 text-[13.5px] font-bold tabular-nums',
          tone || 'border border-[#E4ECE3] bg-[#F7FAF6] text-[#33473E]'
        )}
      >
        {value}
      </div>
    </div>
  )
}

function Readout({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{label}</div>
      <div
        className={cn(
          'flex h-[46px] items-center rounded-[4px] border border-[#E4ECE3] bg-[#F7FAF6] px-3 text-[12.5px] font-bold',
          strong ? 'justify-end text-[15px] tabular-nums text-[#0A1F17]' : 'text-[#33473E]'
        )}
      >
        <span className="min-w-0 truncate">{value}</span>
      </div>
    </div>
  )
}
