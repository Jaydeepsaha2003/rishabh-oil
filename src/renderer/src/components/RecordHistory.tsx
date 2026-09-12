import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, History, Loader2, User2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDate, formatINR, formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE STORY OF ONE RECORD — who changed what, and when.
// -----------------------------------------------------------------------------
// Two trails were being kept and shown separately: the activity log (who saved
// this, at what time, from which machine) and the field diff (what the rate was
// before). Read apart, neither answers the question — one knows the hour but
// not the figure, the other the figure but not the reason. So they are woven
// into a single timeline here, a save at a time.
//
// What it deliberately does NOT do is print every column that moved as an equal
// line. A rate correction drags the taxable value, the GST, the TDS and the net
// along with it; listing all five the same way buries the one decision somebody
// actually made under four of its own consequences. The decision is the
// headline; the arithmetic that followed is a quiet footnote under it.

export type RecordHistoryTarget = {
  // The field-level trail — change_log, via history:list.
  changes: { entity: 'orders' | 'bargains'; id: number }
  // The activity trail — user_logs. Optional: not every module logs one.
  activity?: { entity: string | string[]; id: number }
  kicker?: string
  title: string
  subtitle?: string
}

/* -------------------------------------------------------------------------- */
/* How a stored value is read back                                            */
/* -------------------------------------------------------------------------- */

// change_log keeps values as plain strings, so the field name is what says how
// to read one. A rate is money, a quantity is not, and an id is neither.
const MONEY = new Set([
  'bargain_rate', 'invoice_rate', 'adjusted_rate', 'additional_interest', 'rate_round_off',
  'taxable_value', 'net_amount', 'round_off', 'rate_per_uom', 'base_rate', 'duty'
])
const QTY = new Set(['ordered_qty', 'qty'])
const PCT = new Set(['interest_pct', 'gst_pct', 'tds_pct', 'allowed_shortage_pct'])
const DATE = new Set(['order_date', 'bargain_date', 'rate_expiry_date'])
// Stored as a number that means a name. Showing "12 → 15" helps nobody, so the
// line says it changed and stops there rather than pretending to inform.
const REF = new Set(['company_id', 'supplier_id', 'oil_type_id', 'broker_id'])

// The figures that are WORKED OUT from the others. None of these is ever typed
// by anybody — they move because a rate or a quantity moved.
const DERIVED = new Set(['adjusted_rate', 'taxable_value', 'net_amount', 'round_off'])

// What the save was about, in three words. Taken from the fields that moved,
// because the verb the channel logged ('Updated') says nothing.
const RATE_FIELDS = new Set(['bargain_rate', 'invoice_rate', 'rate_per_uom', 'base_rate', 'duty'])
const TERM_FIELDS = new Set(['gst_pct', 'tds_pct', 'gst_type', 'interest_pct', 'interest_days', 'additional_interest', 'rate_round_off'])

function readValue(field: string, raw: unknown): string {
  const s = raw == null ? '' : String(raw).trim()
  if (!s || s === '—') return '—'
  if (MONEY.has(field)) return formatINR(Number(s))
  if (QTY.has(field)) return formatNum(Number(s))
  if (PCT.has(field)) return `${formatNum(Number(s))}%`
  if (DATE.has(field)) return formatDate(s)
  return s
}

// Stamps are stored as UTC 'YYYY-MM-DD HH:MM:SS' — shown in the reader's own
// clock, because "6:59 pm" against a save they made at half past midnight is
// how a trail loses the trust it exists to earn.
function localDate(v: unknown): Date | null {
  let s = String(v || '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = `${s.replace(' ', 'T')}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function clockTime(d: Date): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m} ${ampm}`
}

function dayLabel(d: Date): string {
  const today = new Date()
  const same = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return 'Today'
  const y = new Date(today)
  y.setDate(y.getDate() - 1)
  if (same(d, y)) return 'Yesterday'
  return formatDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  )
}

/* -------------------------------------------------------------------------- */
/* One save = one event                                                       */
/* -------------------------------------------------------------------------- */

type Line = { field: string; label: string; from: string; to: string }
type Event = {
  key: string
  at: Date | null
  who: string
  verb: string
  detail: string
  lines: Line[]
  derived: Line[]
}

// Same person, same minute, same record: one save. The diff writes a row per
// field, so without this a single correction arrives as five separate events.
function bucket(who: string, at: Date | null): string {
  return `${who}|${at ? Math.floor(at.getTime() / 60000) : 'x'}`
}

function headline(ev: Event): string {
  if (ev.verb === 'created') return 'Entered'
  if (ev.verb === 'deleted') return 'Deleted'
  const fields = ev.lines.map((l) => l.field)
  if (fields.some((f) => RATE_FIELDS.has(f))) return 'Rate changed'
  if (fields.some((f) => QTY.has(f))) return 'Quantity changed'
  if (fields.some((f) => REF.has(f) || f === 'invoice_no' || f === 'bargain_no' || DATE.has(f)))
    return 'Details amended'
  if (fields.some((f) => TERM_FIELDS.has(f))) return 'Terms changed'
  if (fields.length === 1 && fields[0] === 'remarks') return 'Remarks edited'
  if (!ev.lines.length && ev.derived.length) return 'Amounts recalculated'
  if (!ev.lines.length && !ev.derived.length) return ev.detail ? '' : 'Opened for editing'
  return 'Edited'
}

function buildEvents(changes: Row[], activity: Row[]): Event[] {
  const by = new Map<string, Event>()
  const take = (who: string, at: Date | null): Event => {
    const k = bucket(who, at)
    let ev = by.get(k)
    if (!ev) {
      ev = { key: k, at, who, verb: 'updated', detail: '', lines: [], derived: [] }
      by.set(k, ev)
    }
    return ev
  }

  for (const r of changes) {
    const at = localDate(r.changed_at)
    const ev = take(String(r.changed_by_name || 'system'), at)
    if (r.action && r.action !== 'updated') ev.verb = String(r.action)
    if (!r.field) continue
    const field = String(r.field)
    const line: Line = {
      field,
      label: String(r.label || field),
      from: REF.has(field) ? '' : readValue(field, r.old_value),
      to: REF.has(field) ? '' : readValue(field, r.new_value)
    }
    ;(DERIVED.has(field) ? ev.derived : ev.lines).push(line)
  }

  // The activity row for the same minute is the same save — its verb and its
  // one-line summary belong on the event the diff already built, not beside it.
  for (const a of activity) {
    const at = localDate(a.created_at)
    const ev = take(String(a.username || 'system'), at)
    const act = String(a.action || '')
    if (act && act.toLowerCase() !== 'update' && act.toLowerCase() !== 'updated') ev.detail = ev.detail || act
    if (a.detail) ev.detail = String(a.detail)
  }

  return [...by.values()].sort((x, y) => (y.at?.getTime() ?? 0) - (x.at?.getTime() ?? 0))
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

function Pair({ line, small }: { line: Line; small?: boolean }): React.JSX.Element {
  // A reference field has nothing worth printing on either side of the arrow.
  if (!line.from && !line.to) {
    return (
      <span className={cn('font-semibold text-[#5A6B62]', small ? 'text-[11.5px]' : 'text-[12.5px]')}>
        changed
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      <span className={cn('doc-ref font-semibold text-[#8A9690]', small ? 'text-[11.5px]' : 'text-[12.5px]')}>
        {line.from}
      </span>
      <span className={cn('text-[#B3C0B8]', small ? 'text-[10.5px]' : 'text-[11.5px]')}>→</span>
      <span className={cn('doc-ref font-bold text-[#0A1F17]', small ? 'text-[11.5px]' : 'text-[13px]')}>
        {line.to}
      </span>
    </span>
  )
}

function Timeline({ events, loading }: { events: Event[]; loading: boolean }): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] font-semibold text-[#5A6B62]">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the trail…
      </div>
    )
  }
  if (!events.length) {
    return (
      <div className="rounded-[4px] border border-dashed border-[#C3D2C6] bg-white px-5 py-12 text-center">
        <History className="mx-auto h-7 w-7 text-[#C3D2C6]" />
        <p className="mt-3 text-[13px] font-bold text-[#33473E]">Nothing has been changed</p>
        <p className="mx-auto mt-1.5 max-w-[34ch] text-[12px] font-semibold leading-[1.55] text-[#5A6B62] [text-wrap:pretty]">
          This record still reads exactly as it was entered.
        </p>
      </div>
    )
  }

  let lastDay = ''
  return (
    <div className="flex flex-col">
      {events.map((ev) => {
        const day = ev.at ? dayLabel(ev.at) : 'Earlier'
        const newDay = day !== lastDay
        lastDay = day
        const head = headline(ev)
        return (
          <div key={ev.key}>
            {newDay && (
              <div className="sticky top-0 z-10 -mx-[1px] bg-[#F1F5EF]/95 px-1 pb-1.5 pt-3 text-[10px] font-extrabold uppercase tracking-[.14em] text-[#5A6B62] backdrop-blur">
                {day}
              </div>
            )}
            {/* The rail runs down the left so the eye reads a sequence rather
                than a stack of unrelated cards. */}
            <div className="relative pl-[26px]">
              <span className="absolute left-[7px] top-[22px] h-[calc(100%-14px)] w-px bg-[#DCE7DB]" />
              <span
                className={cn(
                  'absolute left-0 top-[15px] h-[15px] w-[15px] rounded-full border-[3px] border-white',
                  ev.verb === 'created'
                    ? 'bg-[#12855A]'
                    : ev.verb === 'deleted'
                      ? 'bg-[#B3261E]'
                      : ev.lines.some((l) => RATE_FIELDS.has(l.field))
                        ? 'bg-[#C2700A]'
                        : 'bg-[#8FBFA8]'
                )}
              />
              <div className="mb-2 rounded-[4px] border border-[#DCE7DB] bg-white px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  {!!head && (
                    <span className="text-[12.5px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">{head}</span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-[11px] font-bold text-[#5A6B62]">
                    <User2 className="h-[13px] w-[13px] text-[#8FBFA8]" />
                    {ev.who}
                    <span className="text-[#C3D2C6]">·</span>
                    <Clock className="h-[13px] w-[13px] text-[#8FBFA8]" />
                    {ev.at ? clockTime(ev.at) : '—'}
                  </span>
                </div>

                {!!ev.lines.length && (
                  <div className="mt-2.5 flex flex-col gap-1.5">
                    {ev.lines.map((l) => (
                      <div key={l.field} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="min-w-[104px] text-[11px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
                          {l.label}
                        </span>
                        <Pair line={l} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Consequences, not decisions — smaller, greyer, and on one
                    line, so they are there to be checked without competing
                    with the change that caused them. */}
                {!!ev.derived.length && (
                  <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-t-[#EFF3EE] pt-2">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#8A9690]">
                      {ev.lines.length ? 'Recalculated' : 'Amounts'}
                    </span>
                    {ev.derived.map((l) => (
                      <span key={l.field} className="inline-flex items-baseline gap-1.5">
                        <span className="text-[11px] font-bold text-[#8A9690]">{l.label}</span>
                        <Pair line={l} small />
                      </span>
                    ))}
                  </div>
                )}

                {!!ev.detail && !ev.lines.length && !ev.derived.length && (
                  <p className="mt-1.5 text-[12px] font-semibold leading-[1.5] text-[#5A6B62]">{ev.detail}</p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function RecordHistory({
  target,
  onClose,
  // The timeline on its own, with no dialog around it, so a panel that already
  // has a frame can hold it as a section.
  inline = false
}: {
  target: RecordHistoryTarget | null
  onClose?: () => void
  inline?: boolean
}): React.JSX.Element {
  const [changes, setChanges] = useState<Row[]>([])
  const [activity, setActivity] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (t: RecordHistoryTarget) => {
    setLoading(true)
    setChanges([])
    setActivity([])
    // The trail must never be the reason a screen breaks: whichever half is
    // unavailable is simply empty, and the other half still tells its story.
    const [c, a] = await Promise.all([
      window.api.history.list(t.changes.entity, Number(t.changes.id)).catch(() => [] as Row[]),
      t.activity
        ? window.api.access.entityHistory(t.activity.entity, { id: Number(t.activity.id) }).catch(() => [] as Row[])
        : Promise.resolve([] as Row[])
    ])
    setChanges(c)
    setActivity(a)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (target) void load(target)
  }, [target, load])

  const events = useMemo(() => buildEvents(changes, activity), [changes, activity])

  if (inline) {
    return (
      <div className="flex flex-col">
        <Timeline events={events} loading={loading} />
      </div>
    )
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent
        className={cn(
          'max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto',
          __WEB__ &&
            '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[560px] !max-w-[95vw] !translate-x-0 !translate-y-0 !grid !grid-rows-[auto_minmax(0,1fr)] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
        )}
      >
        <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left')}>
          {__WEB__ && (
            <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              <History className="h-[15px] w-[15px]" />
              History · {target?.kicker || 'record'}
            </div>
          )}
          <DialogTitle
            className={cn(
              'text-[13px] font-bold uppercase tracking-widest',
              __WEB__ && '!doc-ref !mt-1.5 !break-all !text-[19px] !font-bold !normal-case !tracking-[-0.02em] !text-white'
            )}
          >
            {__WEB__ ? target?.title || 'Record' : `History — ${target?.title || 'record'}`}
          </DialogTitle>
          {!!target?.subtitle && (
            <div
              className={cn(
                'text-xs text-muted-foreground',
                __WEB__ && '!mt-1.5 !text-[12.5px] !font-semibold !text-[#8FBFA8]'
              )}
            >
              {target.subtitle}
            </div>
          )}
        </DialogHeader>

        <div className={cn('min-h-0 overflow-y-auto', __WEB__ ? 'px-[22px] pb-6' : 'pt-2')}>
          <Timeline events={events} loading={loading} />
          {!loading && events.length > 0 && (
            <p className="px-1 pb-1 pt-3 text-[11.5px] font-semibold text-[#5A6B62]">
              {events.length} entr{events.length === 1 ? 'y' : 'ies'}, newest first · shown in your own clock
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Saves every page repeating the same two pieces of state. */
export function useRecordHistory(): {
  target: RecordHistoryTarget | null
  open: (t: RecordHistoryTarget) => void
  close: () => void
} {
  const [target, setTarget] = useState<RecordHistoryTarget | null>(null)
  return { target, open: setTarget, close: () => setTarget(null) }
}
