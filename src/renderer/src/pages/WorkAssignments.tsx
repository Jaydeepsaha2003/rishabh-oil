// The day's work, for everyone.
// -----------------------------------------------------------------------------
// Three tabs and one rule. MY WORK is the checklist this login is responsible
// for, built from the pages it can reach. REVIEW BOARD is the admin's queue of
// ticks to clear or send back. TEAM PROGRESS is the whole day in one place —
// admin only: it names every login's outstanding work, which is not something
// an ordinary desk needs to see about everybody else's.
//
// The rule: APPROVED is the only state that finishes a task. A tick is a claim,
// not a completion, so a task ticked Done still counts as outstanding until it
// clears review — which is the difference between a checklist people tick and
// one that tells you anything.
//
// Reachable by everyone on purpose. Every other page in the rail is gated on
// module rights; this one has to be the exception, because the thing it is for
// is telling each person what THEY owe today. The tabs and the actions are
// gated instead, and the server gates them again: only the owner may tick, only
// an admin may approve, send back, or see another login's board. See
// src/main/work.ts.
//
// EVERY PIECE OF SCREEN BELOW IS A MODULE-LEVEL FUNCTION, NOT DEFINED INSIDE
// WorkAssignments(). That used to look tidy — Thread, TaskCard, MyWork and the
// rest were declared right where they were used — and it broke every input on
// the page: a component defined inside another component's body is a NEW
// function on every render, so React reads it as a different component type
// each time and tears the old one's DOM down before mounting the new one. Type
// a second character into the note box and the tick that redraws the page
// (setDraft) redefines Thread, which unmounts the very <input> being typed
// into — which is why focus vanished after one keystroke. Hoisting them here
// fixes it: the component identity is now stable across renders, so React
// patches props instead of remounting, and typing works like typing anywhere
// else in the app. Data and callbacks travel in as props — mostly bundled into
// one `Ctx` object for the pieces that render a task or a thread, so this
// isn't nine near-identical argument lists to keep in sync.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CalendarClock,
  ClipboardList,
  Clock,
  ListChecks,
  ListPlus,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  ShieldQuestion,
  Trash2,
  Undo2,
  Users,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { MobileBar } from '@/components/MobileBar'
import { MODULES, MODULE_GROUP, MODULE_GROUPS } from '@/lib/modules'
import { formatDate } from '@/lib/format'
import { loadUser } from '@/lib/session'
import { useIsMobile } from '@/lib/useIsMobile'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

// The LOCAL day, not the UTC one. toISOString() renders in UTC, and India is
// five and a half hours ahead of it — before 05:30 that reads as yesterday,
// which on a board that is built per day is the wrong board entirely.
const todayISO = (): string => {
  const d = new Date()
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
// Days forward from a YYYY-MM-DD, month ends and leap years included.
const dayPlus = (date: string, k: number): string => {
  const d = new Date(`${s(date) || todayISO()}T00:00:00`)
  d.setDate(d.getDate() + k)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The five states, and what each looks like. One table so a chip, a tick box
// and a progress segment can never disagree about which colour means what.
const ST: Record<string, { label: string; fg: string; bg: string; bd: string; mark: string }> = {
  pending: { label: 'Pending', fg: '#5A6B62', bg: '#F7FAF6', bd: '#DCE7DB', mark: '#C3D2C6' },
  done: { label: 'Done', fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', mark: '#1B4E82' },
  fixes: { label: 'Needs fixes', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', mark: '#B3261E' },
  redone: { label: 'Redone', fg: '#8A5300', bg: '#FFF4E0', bd: '#F0E4CB', mark: '#C2700A' },
  approved: { label: 'Approved', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', mark: '#12855A' }
}
const st = (k: string): (typeof ST)['pending'] => ST[k] || ST.pending

const MODULE_LABEL: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.key, m.label]))
const pageLabel = (k: string): string => MODULE_LABEL[k] || (k === 'workAssignments' ? 'Assigned' : k)

const initialsOf = (name: string): string =>
  s(name)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?'

const pct = (list: Row[]): number =>
  list.length ? Math.round((list.filter((t) => t.state === 'approved').length / list.length) * 100) : 0

// Which notes this login has already looked at. Local on purpose: the real
// notification is on the bell, raised by the server and read there; this is
// only "have I glanced at it on this screen", and it should not cost a write
// to the database every time a list is scrolled past.
const READ_KEY = 'work.readNotes'
function loadRead(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
function saveRead(keys: Set<string>): void {
  try {
    // Capped: a year of notes is not worth carrying, and the only ones that
    // matter are the recent ones a badge is counting.
    localStorage.setItem(READ_KEY, JSON.stringify([...keys].slice(-400)))
  } catch {
    /* no storage — the badge simply comes back */
  }
}

const PRESETS = [
  'Figures do not match the source document',
  'No note against the difference',
  'Entered against the wrong date',
  'Incomplete — entries still missing'
]

type Tab = 'mine' | 'review' | 'team' | 'list' | 'cutoffs'

// Everything a task card or a thread needs, in one bundle — see the note at
// the top of the file for why these had to stop being closures.
type Ctx = {
  myId: number
  isAdmin: boolean
  busy: number
  /**
   * The cut-off as it should be READ for ONE login: '18:30', or '02:00 next
   * day'. A function rather than a string because the deadline is no longer
   * the same for everybody — a desk may carry its own.
   */
  cutoffLabel: (userId: unknown) => string
  late: (at: unknown, userId: unknown) => boolean
  /**
   * NOT DONE, AND THE HOUR HAS GONE.
   *
   * `late` judges a tick that was made — this judges one that was not. A task
   * still sitting untouched past the deadline its owner is held to is the one
   * thing an admin is scanning the board for, and grey said nothing about it.
   */
  overdue: (t: Row) => boolean
  openThread: Record<number, boolean>
  draft: Record<number, string>
  onToggleThread: (id: number) => void
  onDraftChange: (id: number, v: string) => void
  onTick: (t: Row) => void
  onUntick: (t: Row) => void
  onApprove: (t: Row) => void
  onRedo: (t: Row) => void
  onSend: (t: Row) => void
  onSendBackOpen: (t: Row) => void
}

// ------------------------------------------------------------- fragments ----
function Segments({ list, h = 6 }: { list: Row[]; h?: number }): React.JSX.Element {
  const total = list.length || 1
  return (
    <span className="flex overflow-hidden rounded-full bg-[#EAF0E9]" style={{ height: h }}>
      {['approved', 'redone', 'done', 'fixes', 'pending'].map((k) => {
        const c = list.filter((t) => t.state === k).length
        if (!c) return null
        return (
          <span
            key={k}
            title={`${c} ${st(k).label.toLowerCase()}`}
            style={{ width: `${(c / total) * 100}%`, background: st(k).mark }}
          />
        )
      })}
    </span>
  )
}

// THE DAY AT A GLANCE, one dot per page.
//
// A row that stays shut still has to say how the day is going, or shutting it
// only hides the work. Five states, four colours: nothing done yet reads grey,
// ticked-and-waiting reads light green, cleared reads dark green, and anything
// sent back reads red so it cannot be mistaken for progress.
const DOT: Record<string, { c: string; ink: string; word: string }> = {
  pending: { c: '#6E7C74', ink: '#FFFFFF', word: 'not started' },
  // Not started, and the deadline has gone. Its own entry rather than a shade
  // of pending, because it is a different fact about the day: red for nothing
  // done, deep maroon for sent back — near neighbours on purpose, since both
  // are somebody's outstanding work, and told apart by the ring.
  overdue: { c: '#B3261E', ink: '#FFFFFF', word: 'not started — past the cut-off' },
  done: { c: '#5BC47A', ink: '#0A2A17', word: 'ticked, waiting on you' },
  redone: { c: '#5BC47A', ink: '#0A2A17', word: 're-done, waiting on you' },
  fixes: { c: '#8C1D18', ink: '#FFFFFF', word: 'sent back' },
  approved: { c: '#0B6B45', ink: '#FFFFFF', word: 'approved' }
}
const dot = (k: string): (typeof DOT)['pending'] => DOT[k] || DOT.pending

function PageDots({ list, overdue }: { list: Row[]; overdue?: (t: Row) => boolean }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {list.map((t) => {
        const over = !!overdue && overdue(t)
        const d = over ? DOT.overdue : dot(s(t.state))
        return (
          <span
            key={n(t.id)}
            // The page's own initial, so a shut row says WHICH pages are red
            // rather than only how many. The full name is on the tooltip —
            // two pages can share a letter, and one letter cannot tell Sales
            // from Sales Bargain.
            title={`${pageLabel(s(t.module))} — ${s(t.title)} — ${d.word}`}
            className={cn(
              'flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full text-[10px] font-extrabold leading-none',
              over && 'ring-2 ring-[#F0AFAA]'
            )}
            style={{ background: d.c, color: d.ink }}
          >
            {pageLabel(s(t.module)).trim().charAt(0).toUpperCase() || '?'}
          </span>
        )
      })}
    </span>
  )
}

function StateChip({ k, small }: { k: string; small?: boolean }): React.JSX.Element {
  const c = st(k)
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center gap-1 rounded-[3px] border font-extrabold',
        small ? 'px-1.5 py-px text-[9.5px]' : 'px-2 py-[3px] text-[10.5px]'
      )}
      style={{ color: c.fg, background: c.bg, borderColor: c.bd }}
    >
      {c.label}
    </span>
  )
}

function Avatar({ name, size = 30 }: { name: string; size?: number }): React.JSX.Element {
  return (
    <span
      className="flex flex-none items-center justify-center rounded-full bg-[#0B3D2E] font-extrabold text-[#C7F03F]"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initialsOf(name)}
    </span>
  )
}

function Thread({ t, compact, ctx }: { t: Row; compact?: boolean; ctx: Ctx }): React.JSX.Element {
  const list = (t.thread || []) as Row[]
  const id = n(t.id)
  const canPost = n(t.user_id) === ctx.myId || ctx.isAdmin
  const draftVal = ctx.draft[id] ?? ''
  return (
    <div className={cn('border-t border-t-[#EAF0E9] bg-[#FBFCFA]', compact ? 'px-3 py-2.5' : 'px-4 py-3')}>
      {list.length === 0 && (
        <p className="text-[11.5px] font-semibold text-[#8CA396]">Nothing said on this task yet.</p>
      )}
      <div className="flex flex-col gap-2">
        {list.map((m) => {
          const admin = s(m.role) === 'admin'
          return (
            <div
              key={m.id}
              className="flex gap-2.5 rounded-[4px] border p-2.5"
              style={{
                background: admin ? '#FDF3F2' : '#fff',
                borderColor: admin ? '#F0D6D4' : '#DCE7DB'
              }}
            >
              <Avatar name={s(m.who)} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[12px] font-extrabold text-[#0A1F17]">{s(m.who)}</span>
                  <span
                    className="rounded-[2px] px-1.5 py-px text-[9px] font-extrabold uppercase tracking-[.08em]"
                    style={{
                      background: admin ? '#F7E0DE' : '#EAF0E9',
                      color: admin ? '#8C2F26' : '#33473E'
                    }}
                  >
                    {s(m.role)}
                  </span>
                  <span className="doc-ref text-[10.5px] font-semibold text-[#8CA396]">{s(m.at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[12px] font-medium leading-[1.5] text-[#33473E]">
                  {s(m.text)}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      {canPost && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            placeholder={t.state === 'fixes' ? 'Say what you changed…' : 'Add a note against this task…'}
            className="h-9 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[12px] font-semibold outline-none placeholder:font-medium placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
            value={draftVal}
            onChange={(e) => ctx.onDraftChange(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ctx.onSend(t)
              }
            }}
          />
          <button
            type="button"
            onClick={() => ctx.onSend(t)}
            disabled={!draftVal.trim() || !!ctx.busy}
            className={cn(
              'flex h-9 flex-none items-center gap-1.5 rounded-[4px] px-3 text-[11px] font-extrabold',
              draftVal.trim() ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#C3D2C6] text-[#F1F5EF]'
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {ctx.isAdmin && n(t.user_id) !== ctx.myId ? 'REPLY' : 'ADD NOTE'}
          </button>
        </div>
      )}
    </div>
  )
}

function TaskCard({ t, compact, ctx }: { t: Row; compact?: boolean; ctx: Ctx }): React.JSX.Element {
  const c = st(s(t.state))
  const mineOwn = n(t.user_id) === ctx.myId
  // Ticked, but nobody has reviewed it yet — the only window in which the
  // owner can take their own tick back. 'redone' returns to 'fixes', not to
  // 'pending', so unticking never erases an admin's send-back.
  const canUntick = mineOwn && (t.state === 'done' || t.state === 'redone')
  const isFixes = t.state === 'fixes'
  const lastAdmin = ((t.thread || []) as Row[]).filter((m) => s(m.role) === 'admin').slice(-1)[0]
  const id = n(t.id)
  return (
    <div
      className="overflow-hidden rounded-[4px] border bg-white"
      style={{ borderColor: isFixes ? '#F0D6D4' : '#E4ECE3' }}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        {/* The tick, and the way back off it. A tick used to be one-way, so a
            mis-click could only be undone by an admin SEND BACK — which says
            the work was wrong, when all that happened was the wrong row got
            clicked. The owner can now untick their own claim right up until
            somebody reviews it; after that the reviewer's decision stands and
            the server refuses. */}
        <button
          type="button"
          disabled={!mineOwn || !(t.state === 'pending' || canUntick) || !!ctx.busy}
          onClick={() => (canUntick ? ctx.onUntick(t) : ctx.onTick(t))}
          title={
            !mineOwn
              ? 'This belongs to somebody else'
              : t.state === 'pending'
                ? 'Tick this off — it goes for review'
                : canUntick
                  ? 'Ticked by mistake? Click to untick it'
                  : c.label
          }
          className={cn(
            'mt-px flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[4px] border-2 transition-colors',
            mineOwn && (t.state === 'pending' || canUntick) ? 'cursor-pointer hover:bg-[#F1F5EF]' : 'cursor-default'
          )}
          style={{
            borderColor: c.mark,
            background: t.state === 'pending' ? '#fff' : c.mark
          }}
        >
          {t.state === 'approved' && <CheckCheck className="h-3.5 w-3.5 text-white" />}
          {t.state === 'done' && <Check className="h-3.5 w-3.5 text-white" />}
          {t.state === 'redone' && <RotateCcw className="h-3 w-3 text-white" />}
          {isFixes && <AlertTriangle className="h-3 w-3 text-white" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn('text-[13px] font-bold', t.state === 'approved' ? 'text-[#5A6B62]' : 'text-[#0A1F17]')}
            >
              {s(t.title)}
            </span>
            <StateChip k={s(t.state)} />
            {t.kind === 'assigned' && (
              <span className="rounded-[2px] bg-[#EDE9FB] px-1.5 py-px text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#3D3179]">
                Assigned{t.assigned_by_name ? ` · ${s(t.assigned_by_name).split(' ')[0]}` : ''}
              </span>
            )}
          </div>
          {!!s(t.detail) && (
            <p className="mt-1 text-[11.5px] font-medium leading-[1.5] text-[#5A6B62]">{s(t.detail)}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[10.5px] font-bold',
                // Red for a tick that came in late, and for a tick that has
                // not come in at all — the deadline has gone either way.
                ctx.late(t.marked_stamp, t.user_id) || ctx.overdue(t) ? 'text-[#B3261E]' : 'text-[#8CA396]'
              )}
            >
              <Clock className="h-3.5 w-3.5" />
              {t.marked_at
                ? `ticked ${s(t.marked_at)}${ctx.late(t.marked_stamp, t.user_id) ? ' · after cut-off' : ''}`
                : ctx.overdue(t)
                  ? `not done · past ${ctx.cutoffLabel(t.user_id)}`
                  : `due by ${ctx.cutoffLabel(t.user_id)}`}
            </span>
            <button
              type="button"
              onClick={() => ctx.onToggleThread(id)}
              className="inline-flex items-center gap-1 text-[10.5px] font-extrabold text-[#0B6B45] hover:underline"
            >
              {((t.thread || []) as Row[]).length}{' '}
              {((t.thread || []) as Row[]).length === 1 ? 'note' : 'notes'}
              {ctx.openThread[id] ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* The admin's two buttons, wherever a ticked task is shown. */}
        {ctx.isAdmin && (t.state === 'done' || t.state === 'redone') && (
          <div className="flex flex-none flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={!!ctx.busy}
              onClick={() => ctx.onSendBackOpen(t)}
              className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-2.5 text-[11px] font-extrabold text-[#8C2F26] hover:bg-[#FBE9E7]"
            >
              <Undo2 className="h-3.5 w-3.5" /> SEND BACK
            </button>
            <button
              type="button"
              disabled={!!ctx.busy}
              onClick={() => ctx.onApprove(t)}
              className="flex h-8 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F] hover:bg-[#0A3327]"
            >
              <Check className="h-3.5 w-3.5" /> APPROVE
            </button>
          </div>
        )}
      </div>

      {/* Sent back: what needs fixing, and the one button that answers it. */}
      {isFixes && mineOwn && (
        <div className="flex flex-wrap items-start gap-2.5 border-t border-t-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-2.5">
          <AlertTriangle className="mt-px h-4 w-4 flex-none text-[#B3261E]" />
          <p className="min-w-0 flex-1 text-[11.5px] font-semibold leading-[1.5] text-[#8C2F26]">
            {s(lastAdmin?.text) || 'Sent back for fixes.'}
          </p>
          <button
            type="button"
            disabled={!!ctx.busy}
            onClick={() => ctx.onRedo(t)}
            className="flex h-8 flex-none items-center gap-1.5 rounded-[4px] bg-[#8C2F26] px-3 text-[11px] font-extrabold text-white hover:bg-[#7A2820]"
          >
            <RotateCcw className="h-3.5 w-3.5" /> MARK REDONE
          </button>
        </div>
      )}

      {ctx.openThread[id] && <Thread t={t} compact={compact} ctx={ctx} />}
    </div>
  )
}

// ------------------------------------------------------------- my work ------
/** One line per ask, on the owner's own board and on the admin's queue. */
function DayRequestLine({
  r,
  admin,
  busy,
  onDecide,
  onOpenDay
}: {
  r: Row
  admin?: boolean
  busy: number
  onDecide?: (id: number, approve: boolean) => void
  onOpenDay?: (date: string) => void
}): React.JSX.Element {
  const state = s(r.state)
  const tone =
    state === 'approved'
      ? { bg: '#EAF6EC', bd: '#BFE3CB', ink: '#0B6B45', word: 'open' }
      : state === 'refused'
        ? { bg: '#FDF3F2', bd: '#F0D6D4', ink: '#8C2F26', word: 'not opened' }
        : { bg: '#FFFBF2', bd: '#F0DCB4', ink: '#8A5300', word: 'waiting on an admin' }
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-[4px] border px-3 py-2"
      style={{ background: tone.bg, borderColor: tone.bd }}
    >
      <CalendarClock className="h-3.5 w-3.5 flex-none" style={{ color: tone.ink }} />
      <span className="doc-ref text-[12px] font-extrabold text-[#0A1F17]">{formatDate(s(r.work_date))}</span>
      {!!admin && <span className="text-[11.5px] font-bold text-[#33473E]">· {s(r.user_name)}</span>}
      {!!s(r.reason) && (
        <span className="min-w-[120px] flex-1 truncate text-[11.5px] font-medium text-[#5A6B62]" title={s(r.reason)}>
          {s(r.reason)}
        </span>
      )}
      {!s(r.reason) && <span className="min-w-0 flex-1" />}
      <span className="text-[10px] font-extrabold uppercase tracking-[.08em]" style={{ color: tone.ink }}>
        {tone.word}
      </span>
      {state === 'approved' && !admin && !!onOpenDay && (
        <button
          type="button"
          onClick={() => onOpenDay(s(r.work_date))}
          className="h-7 rounded-[3px] bg-[#0B3D2E] px-2.5 text-[10.5px] font-extrabold text-[#C7F03F] hover:bg-[#0A3327]"
        >
          Open that day
        </button>
      )}
      {!!admin && state === 'pending' && !!onDecide && (
        <span className="flex flex-none items-center gap-1.5">
          <button
            type="button"
            disabled={busy > 0}
            onClick={() => onDecide(n(r.id), false)}
            className="h-7 rounded-[3px] border border-[#C3D2C6] bg-white px-2.5 text-[10.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            No
          </button>
          <button
            type="button"
            disabled={busy > 0}
            onClick={() => onDecide(n(r.id), true)}
            className="h-7 rounded-[3px] bg-[#C7F03F] px-2.5 text-[10.5px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F]"
          >
            Open it
          </button>
        </span>
      )}
    </div>
  )
}

function MyWork({
  compact,
  mine,
  myApproved,
  myFixes,
  myNote,
  inbox,
  myGroups,
  onMarkRead,
  myRequests,
  onAsk,
  onOpenDay,
  closedDay,
  ctx
}: {
  compact?: boolean
  mine: Row[]
  myApproved: number
  myFixes: number
  myNote: string
  inbox: Row[]
  myGroups: { mod: string; list: Row[] }[]
  onMarkRead: (keys: string[]) => void
  /** This login's own asks for a closed day, newest first. */
  myRequests: Row[]
  onAsk: () => void
  onOpenDay: (date: string) => void
  /** Set when the board on screen is a closed day this login was let into. */
  closedDay: string
  ctx: Ctx
}): React.JSX.Element {
  const live = myRequests.filter((r) => s(r.state) !== 'refused' || s(r.work_date) >= dayPlus(todayISO(), -7))
  return (
    <div className="flex flex-col gap-3">
      {/* A DAY THAT IS NOT TODAY.
          Said first and plainly: a board that looks like today's but is not is
          the one mistake this feature could cause, and it would be silent. */}
      {!!closedDay && (
        <div className="flex flex-wrap items-center gap-2 rounded-[4px] border border-[#BFE3CB] bg-[#EAF6EC] px-3.5 py-2.5">
          <CalendarClock className="h-4 w-4 flex-none text-[#0B6B45]" />
          <span className="min-w-0 flex-1 text-[12px] font-extrabold text-[#0A1F17]">
            Filling in {formatDate(closedDay)} — opened for you.{' '}
            <span className="font-semibold text-[#5A6B62]">
              What you tick still records the time you tick it.
            </span>
          </span>
          <button
            type="button"
            onClick={() => onOpenDay('')}
            className="h-7 rounded-[3px] border border-[#C3D2C6] bg-white px-2.5 text-[10.5px] font-extrabold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Back to today
          </button>
        </div>
      )}

      {/* Today, in one line and four figures. */}
      <div className="rounded-[5px] border border-[#DCE7DB] bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-extrabold text-[#0A1F17]">Today&rsquo;s progress</span>
          <span className="doc-ref text-[12px] font-bold text-[#5A6B62]">
            {myApproved} of {mine.length} cleared
          </span>
        </div>
        <div className="mt-2.5">
          <Segments list={mine} />
        </div>
        <div className={cn('mt-3 grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-4')}>
          {(
            [
              ['To do', mine.filter((t) => t.state === 'pending').length, '#5A6B62'],
              ['In review', mine.filter((t) => t.state === 'done' || t.state === 'redone').length, '#1B4E82'],
              ['Needs fixes', myFixes, '#B3261E'],
              ['Approved', myApproved, '#0B6B45']
            ] as const
          ).map(([k, v, fg]) => (
            <div key={k} className="rounded-[4px] border border-[#E4ECE3] bg-[#FBFCFA] px-3 py-2">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">{k}</div>
              <div className="doc-ref mt-0.5 text-[19px] font-bold" style={{ color: fg }}>
                {v}
              </div>
            </div>
          ))}
        </div>
        <p
          className="mt-2.5 text-[11.5px] font-semibold leading-[1.5]"
          style={{ color: myFixes ? '#B3261E' : mine.length && myApproved === mine.length ? '#0B6B45' : '#8A5300' }}
        >
          {myNote}
        </p>
      </div>

      {/* What the admin has said, and has not been looked at. */}
      {inbox.length > 0 && (
        <div className="overflow-hidden rounded-[5px] border border-[#F0D6D4] bg-[#FDF3F2]">
          <div className="flex flex-wrap items-center gap-2 border-b border-b-[#F0D6D4] px-3.5 py-2.5">
            <BellRing className="h-4 w-4 flex-none text-[#B3261E]" />
            <span className="min-w-0 flex-1 text-[12px] font-extrabold text-[#8C2F26]">Sent back to you</span>
            <button
              type="button"
              onClick={() => onMarkRead(inbox.map((x) => s(x.key)))}
              className="text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#8C2F26] hover:underline"
            >
              Mark all read
            </button>
          </div>
          {inbox.map((x) => (
            <button
              key={s(x.key)}
              type="button"
              onClick={() => {
                onMarkRead([s(x.key)])
                ctx.onToggleThread(n(x.taskId))
              }}
              className="flex w-full items-start gap-2.5 border-b border-b-[#F6E3E1] px-3.5 py-2.5 text-left last:border-b-0 hover:bg-[#FBE9E7]"
            >
              <AlertTriangle className="mt-px h-4 w-4 flex-none text-[#B3261E]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-extrabold text-[#0A1F17]">{s(x.title)}</span>
                <span className="mt-0.5 block text-[11.5px] font-medium leading-[1.5] text-[#8C2F26]">
                  {s(x.body)}
                </span>
                <span className="doc-ref mt-1 block text-[10.5px] font-semibold text-[#A9807C]">
                  {s(x.who)} · {s(x.at)}
                </span>
              </span>
              <ChevronRight className="mt-0.5 h-4 w-4 flex-none text-[#C9A5A1]" />
            </button>
          ))}
        </div>
      )}

      {/* ASKING FOR A CLOSED DAY. Offered always rather than only after the
          cut-off: realising on Thursday that Tuesday was never ticked is the
          commoner case, and a button that appears only in the evening is one
          nobody finds. */}
      <div className="flex flex-col gap-2 rounded-[5px] border border-[#DCE7DB] bg-white p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-[#5A6B62]">
            Missed a day? A closed day can be opened for you, one day at a time.
          </span>
          <button
            type="button"
            onClick={onAsk}
            className="flex h-8 flex-none items-center gap-1.5 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[11.5px] font-extrabold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            <CalendarClock className="h-3.5 w-3.5" /> Ask to fill in a day
          </button>
        </div>
        {live.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {live.map((r) => (
              <DayRequestLine key={r.id} r={r} busy={ctx.busy} onOpenDay={onOpenDay} />
            ))}
          </div>
        )}
      </div>

      {mine.length === 0 ? (
        <div className="rounded-[5px] border border-dashed border-[#C3D2C6] bg-white px-6 py-12 text-center">
          <ListChecks className="mx-auto h-7 w-7 text-[#C3D2C6]" />
          <p className="mt-2 text-[13px] font-extrabold text-[#33473E]">
            {ctx.isAdmin ? 'Nothing on your own list' : 'No checklist for this login today'}
          </p>
          <p className="mx-auto mt-1 max-w-[420px] text-[11.5px] font-medium leading-[1.5] text-[#5A6B62]">
            {ctx.isAdmin
              ? 'An admin holds every page, so a checklist of the whole app would be its table of contents rather than a day of work. Your job is the Review board.'
              : 'The list is built from the pages this login can reach. Once it has a page with daily processes against it, they appear here the same morning.'}
          </p>
        </div>
      ) : (
        myGroups.map((g) => (
          <div key={g.mod} className="overflow-hidden rounded-[5px] border border-[#DCE7DB] bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
              <ClipboardList className="h-4 w-4 flex-none text-[#0B6B45]" />
              <span className="min-w-0 flex-1 text-[12px] font-extrabold text-[#0A1F17]">{pageLabel(g.mod)}</span>
              <span className="doc-ref text-[10.5px] font-bold text-[#5A6B62]">
                {g.list.filter((t) => t.state === 'approved').length} of {g.list.length} approved
              </span>
            </div>
            <div className="flex flex-col gap-2 p-2.5">
              {g.list.map((t) => (
                <TaskCard key={t.id} t={t} compact={compact} ctx={ctx} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// -------------------------------------------------------- review board ------
function ReviewBoard({
  compact,
  tasks,
  awaiting,
  stuck,
  teamUsers,
  revFilter,
  onRevFilterChange,
  openUser,
  onToggleUser,
  dayRequests,
  onDecideDay,
  ctx
}: {
  dayRequests: Row[]
  onDecideDay: (id: number, approve: boolean) => void
  compact?: boolean
  tasks: Row[]
  awaiting: Row[]
  stuck: Row[]
  teamUsers: Row[]
  revFilter: 'review' | 'fixes' | 'pending' | 'all'
  onRevFilterChange: (k: 'review' | 'fixes' | 'pending' | 'all') => void
  openUser: Record<number, boolean>
  onToggleUser: (id: number) => void
  ctx: Ctx
}): React.JSX.Element {
  if (!ctx.isAdmin) {
    return (
      <div className="rounded-[5px] border border-dashed border-[#C3D2C6] bg-white px-6 py-12 text-center">
        <ShieldQuestion className="mx-auto h-7 w-7 text-[#C3D2C6]" />
        <p className="mt-2 text-[13px] font-extrabold text-[#33473E]">Reviewing is an admin job</p>
        <p className="mx-auto mt-1 max-w-[420px] text-[11.5px] font-medium leading-[1.5] text-[#5A6B62]">
          Approving work and sending it back is what an admin login is for. Your own list is under My work.
        </p>
      </div>
    )
  }
  const revFilters = [
    { key: 'review' as const, label: 'Waiting on me', list: awaiting },
    { key: 'fixes' as const, label: 'Sent back', list: stuck },
    { key: 'pending' as const, label: 'Not started', list: tasks.filter((t) => t.state === 'pending') },
    { key: 'all' as const, label: 'Everything today', list: tasks }
  ]
  const activeFilter = revFilters.find((f) => f.key === revFilter) || revFilters[0]

  // WHO, then WHAT.
  //
  // The board was a flat list of every task on the day with the same name
  // repeated down its left edge. An admin reviews a day one person at a time
  // — so the person is the row, and the pages they hold live inside it.
  //
  // Grouped out of the ACTIVE filter, not the whole day: filter to Sent back
  // and a row shows only that person's sent-back pages, and the count and the
  // dots beside it say the same thing the list inside does.
  const byUser = new Map<number, Row[]>()
  for (const t of activeFilter.list) {
    const k = n(t.user_id)
    const arr = byUser.get(k)
    if (arr) arr.push(t)
    else byUser.set(k, [t])
  }
  // Roster order first, so the board reads the same way every morning, then
  // anybody holding tasks who is no longer on the roster — a login retired
  // mid-day still has its work reviewed rather than vanishing off the board.
  const order = [
    ...teamUsers.map((u) => n(u.id)).filter((id) => byUser.has(id)),
    ...[...byUser.keys()].filter((id) => !teamUsers.some((u) => n(u.id) === id))
  ]
  const groups = order.map((id) => {
    const list = byUser.get(id) || []
    const u = teamUsers.find((x) => n(x.id) === id)
    // The login NAME is the person (BANERJEE, VINEET GARG); `name` is the desk
    // they sit at (PUR A/C, SALES BG). The board showed only the desk, so a
    // day's work could not be put to a person by name.
    const desk = s(u?.name) || s(list[0]?.user_name)
    const r = s(u?.role)
    const roleWord = r ? r.charAt(0).toUpperCase() + r.slice(1) : ''
    return {
      id,
      person: s(u?.username) || desk || `#${id}`,
      desk,
      role: [roleWord, desk].filter(Boolean).join(' · '),
      list
    }
  })

  // ASKS FOR A CLOSED DAY, at the top of the queue.
  //
  // Above the day's own work on purpose: somebody is standing waiting for this
  // answer to be able to do anything at all, and an ask buried under three
  // dozen tasks is an ask nobody sees until tomorrow.
  const pendingDays = dayRequests.filter((r) => s(r.state) === 'pending')
  const recentDays = dayRequests.filter((r) => s(r.state) !== 'pending').slice(0, 4)

  return (
    <div className="flex flex-col gap-3">
      {(pendingDays.length > 0 || recentDays.length > 0) && (
        <div className="overflow-hidden rounded-[5px] border border-[#DCE7DB] bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
            <CalendarClock className="h-4 w-4 flex-none text-[#0B6B45]" />
            <span className="min-w-0 flex-1 text-[12px] font-extrabold text-[#0A1F17]">Closed days</span>
            <span className="doc-ref text-[10.5px] font-bold text-[#5A6B62]">
              {pendingDays.length
                ? `${pendingDays.length} waiting on you`
                : 'nothing waiting'}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 p-2.5">
            {pendingDays.map((r) => (
              <DayRequestLine key={r.id} r={r} admin busy={ctx.busy} onDecide={onDecideDay} />
            ))}
            {recentDays.map((r) => (
              <DayRequestLine key={r.id} r={r} admin busy={ctx.busy} />
            ))}
          </div>
        </div>
      )}
      <div className={cn('grid gap-2.5', compact ? 'grid-cols-2' : 'grid-cols-4')}>
        {(
          [
            ['Waiting on you', String(awaiting.length), 'ticked but not approved', '#1B4E82'],
            ['Sent back', String(stuck.length), 'not answered yet', '#B3261E'],
            ['Not started', String(tasks.filter((t) => t.state === 'pending').length), 'no tick against them', '#8A5300'],
            [
              'Approved',
              `${tasks.filter((t) => t.state === 'approved').length} of ${tasks.length}`,
              'cleared across the team',
              '#0B6B45'
            ]
          ] as const
        ).map(([k, v, sub, fg]) => (
          <div key={k} className="rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 py-3">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">{k}</div>
            <div className="doc-ref mt-1 text-[21px] font-bold leading-none" style={{ color: fg }}>
              {v}
            </div>
            <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">{sub}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {revFilters.map((f) => {
          const on = revFilter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => onRevFilterChange(f.key)}
              className={cn(
                'flex h-9 items-center gap-1.5 rounded-[4px] border px-3 text-[11.5px] font-extrabold',
                on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
              )}
            >
              {f.label}
              <span
                className={cn(
                  'doc-ref rounded-[2px] px-1.5 text-[10px] font-bold',
                  on ? 'bg-white/20 text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#33473E]'
                )}
              >
                {f.list.length}
              </span>
            </button>
          )
        })}
      </div>

      {/* What a colour means, said once. Four words is cheaper than leaving
          an admin to work out why a dot is red. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-0.5">
        {(['pending', 'overdue', 'done', 'approved', 'fixes'] as const).map((k) => (
          <span
            key={k}
            className={cn(
              'inline-flex items-center gap-1.5 text-[10.5px] font-bold',
              k === 'overdue' ? 'text-[#B3261E]' : 'text-[#5A6B62]'
            )}
          >
            <span
              className={cn('h-[9px] w-[9px] rounded-full', k === 'overdue' && 'ring-2 ring-[#F0AFAA]')}
              style={{ background: dot(k).c }}
            />
            {dot(k).word}
          </span>
        ))}
      </div>

      {activeFilter.list.length === 0 ? (
        <div className="rounded-[5px] border border-dashed border-[#C3D2C6] bg-white px-6 py-10 text-center">
          <CheckCheck className="mx-auto h-7 w-7 text-[#C3D2C6]" />
          <p className="mt-2 text-[12.5px] font-extrabold text-[#33473E]">Nothing in this filter.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => {
            const open = !!openUser[g.id]
            const toReview = g.list.filter((t) => t.state === 'done' || t.state === 'redone').length
            const sentBack = g.list.filter((t) => t.state === 'fixes').length
            const overdueN = g.list.filter((t) => ctx.overdue(t)).length
            return (
              <div key={g.id} className="overflow-hidden rounded-[5px] border border-[#DCE7DB] bg-white">
                {/* THE SHUT ROW. Who, what they are, and the whole day as
                    dots — enough to decide whether it needs opening. */}
                <button
                  type="button"
                  onClick={() => onToggleUser(g.id)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-x-3.5 gap-y-2 px-3.5 py-3 text-left hover:bg-[#F7FAF6]',
                    open && 'bg-[#F7FAF6]'
                  )}
                >
                  <Avatar name={g.desk} size={34} />
                  <div className="min-w-0 flex-[1_1_160px]">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">User</div>
                    <div className="truncate text-[13px] font-extrabold text-[#0A1F17]">{g.person}</div>
                  </div>
                  <div className="min-w-0 flex-[1_1_160px]">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">Role</div>
                    <div className="truncate text-[12px] font-bold text-[#33473E]">{g.role || '—'}</div>
                  </div>
                  <div className="min-w-0 flex-[2_1_220px]">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">
                      {g.list.length} {g.list.length === 1 ? 'page' : 'pages'}
                    </div>
                    <div className="mt-[5px]">
                      <PageDots list={g.list} overdue={ctx.overdue} />
                    </div>
                  </div>
                  {/* Why this row is worth opening, in the colour of the thing
                      that needs doing. */}
                  <span className="flex flex-none items-center gap-1.5">
                    {overdueN > 0 && (
                      <span className="rounded-[3px] border border-[#F0D6D4] bg-[#FDF3F2] px-2 py-[3px] text-[10.5px] font-extrabold text-[#B3261E]">
                        {overdueN} past cut-off
                      </span>
                    )}
                    {toReview > 0 && (
                      <span className="rounded-[3px] border border-[#C6DAF0] bg-[#EAF0FA] px-2 py-[3px] text-[10.5px] font-extrabold text-[#1B4E82]">
                        {toReview} to review
                      </span>
                    )}
                    {sentBack > 0 && (
                      <span className="rounded-[3px] border border-[#F0D6D4] bg-[#FDF3F2] px-2 py-[3px] text-[10.5px] font-extrabold text-[#B3261E]">
                        {sentBack} sent back
                      </span>
                    )}
                  </span>
                  {open ? (
                    <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
                  ) : (
                    <ChevronRight className="h-4 w-4 flex-none text-[#8CA396]" />
                  )}
                </button>

                {/* THE OPEN ROW: one line per page, with the two buttons that
                    answer it. The name is not repeated — the row above it
                    already said whose day this is. */}
                {open && (
                  <div className="flex flex-col gap-1.5 border-t border-t-[#E4ECE3] bg-[#FBFCFA] p-2.5">
                    {g.list.map((t) => (
                      <div key={t.id} className="overflow-hidden rounded-[4px] border border-[#E4ECE3] bg-white">
                        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                          <span
                            className="h-[9px] w-[9px] flex-none rounded-full"
                            style={{ background: dot(s(t.state)).c }}
                          />
                          <div className="min-w-0 flex-[1_1_130px]">
                            <div className="text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#8CA396]">
                              {pageLabel(s(t.module))}
                            </div>
                          </div>
                          <div className="min-w-0 flex-[2_1_220px]">
                            <div className="text-[12.5px] font-bold text-[#0A1F17]">{s(t.title)}</div>
                            <button
                              type="button"
                              onClick={() => ctx.onToggleThread(n(t.id))}
                              className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-extrabold text-[#0B6B45] hover:underline"
                            >
                              {((t.thread || []) as Row[]).length} notes
                              {ctx.openThread[n(t.id)] ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                          <span
                            className={cn(
                              'doc-ref flex-none text-[11.5px] font-bold',
                              ctx.late(t.marked_stamp, t.user_id) ? 'text-[#B3261E]' : 'text-[#5A6B62]'
                            )}
                          >
                            {t.marked_at || '—'}
                          </span>
                          <StateChip k={s(t.state)} />
                          {t.state === 'done' || t.state === 'redone' ? (
                            <div className="flex flex-none items-center gap-1.5">
                              <button
                                type="button"
                                disabled={!!ctx.busy}
                                onClick={() => ctx.onSendBackOpen(t)}
                                className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-2.5 text-[11px] font-extrabold text-[#8C2F26] hover:bg-[#FBE9E7]"
                              >
                                <Undo2 className="h-3.5 w-3.5" /> SEND BACK
                              </button>
                              <button
                                type="button"
                                disabled={!!ctx.busy}
                                onClick={() => ctx.onApprove(t)}
                                className="flex h-8 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F] hover:bg-[#0A3327]"
                              >
                                <Check className="h-3.5 w-3.5" /> APPROVE
                              </button>
                            </div>
                          ) : (
                            <span className="flex-none text-[10.5px] font-semibold italic text-[#8CA396]">
                              {t.state === 'fixes'
                                ? `waiting on ${s(t.user_name).split(' ')[0]}`
                                : t.state === 'approved'
                                  ? 'approved'
                                  : 'not ticked yet'}
                            </span>
                          )}
                        </div>
                        {ctx.openThread[n(t.id)] && <Thread t={t} compact ctx={ctx} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------- team progress ------
// Admin only — see the note above the tab list in WorkAssignments() for why.
function TeamProgress({
  compact,
  tasks,
  teamUsers,
  stuck,
  siteCutoffLabel,
  late,
  openUser,
  onToggleUser
}: {
  compact?: boolean
  tasks: Row[]
  teamUsers: Row[]
  stuck: Row[]
  siteCutoffLabel: string
  late: (at: unknown, userId: unknown) => boolean
  openUser: Record<number, boolean>
  onToggleUser: (id: number) => void
}): React.JSX.Element {
  const approved = tasks.filter((t) => t.state === 'approved').length
  const lateN = tasks.filter((t) => late(t.marked_stamp, t.user_id)).length
  return (
    <div className="flex flex-col gap-3">
      <div className={cn('grid gap-2.5', compact ? 'grid-cols-2' : 'grid-cols-4')}>
        {(
          [
            ['Tasks today', String(tasks.length), `across ${teamUsers.length} ${teamUsers.length === 1 ? 'person' : 'people'}`, '#0A1F17'],
            ['Cleared', `${tasks.length ? Math.round((approved / tasks.length) * 100) : 0}%`, `${approved} approved of ${tasks.length}`, '#0B6B45'],
            ['Sent back', String(stuck.length), 'work that needed a correction', '#B3261E'],
            [
              'After cut-off',
              String(lateN),
              teamUsers.some((u) => u.cutoff_own)
                ? 'each judged on their own deadline'
                : `ticked later than ${siteCutoffLabel}`,
              '#8A5300'
            ]
          ] as const
        ).map(([k, v, sub, fg]) => (
          <div key={k} className="rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 py-3">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">{k}</div>
            <div className="doc-ref mt-1 text-[21px] font-bold leading-none" style={{ color: fg }}>
              {v}
            </div>
            <div className="mt-1 text-[10.5px] font-semibold text-[#5A6B62]">{sub}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {['approved', 'redone', 'done', 'fixes', 'pending'].map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[10.5px] font-bold text-[#5A6B62]">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: st(k).mark }} />
            {st(k).label}
          </span>
        ))}
      </div>

      {teamUsers.length === 0 && (
        <div className="rounded-[5px] border border-dashed border-[#C3D2C6] bg-white px-6 py-10 text-center">
          <Users className="mx-auto h-7 w-7 text-[#C3D2C6]" />
          <p className="mt-2 text-[12.5px] font-extrabold text-[#33473E]">No logins with page access yet.</p>
        </div>
      )}

      {teamUsers.map((u) => {
        const list = tasks.filter((t) => n(t.user_id) === n(u.id))
        const open = !!openUser[n(u.id)]
        const fixes = list.filter((t) => t.state === 'fixes').length
        const p = pct(list)
        return (
          <div key={u.id} className="overflow-hidden rounded-[5px] border border-[#DCE7DB] bg-white">
            <button
              type="button"
              onClick={() => onToggleUser(n(u.id))}
              className={cn('flex w-full items-center gap-3 px-3.5 py-3 text-left', open && 'bg-[#F7FAF6]')}
            >
              <Avatar name={s(u.name)} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-extrabold text-[#0A1F17]">{s(u.name)}</span>
                  <span className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-[#8CA396]">
                    {s(u.role)}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Segments list={list} h={5} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] font-semibold text-[#5A6B62]">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-[2px] px-1.5 py-[1px] text-[10px] font-extrabold',
                      u.cutoff_own ? 'bg-[#EAF0FA] text-[#1B4E82]' : 'bg-[#EAF0E9] text-[#33473E]'
                    )}
                    title={u.cutoff_own ? 'A cut-off of this login’s own' : 'Follows the site cut-off'}
                  >
                    <Clock className="h-3 w-3" />
                    {s(u.cutoff_day) === 'next' ? `${s(u.cutoff)} next day` : s(u.cutoff)}
                    {!!u.cutoff_own && <span className="opacity-70">own</span>}
                  </span>
                  <span>{list.filter((t) => t.state === 'approved').length} approved ·{' '}
                  {list.filter((t) => t.state === 'done' || t.state === 'redone').length} in review · {fixes} needing
                  fixes · {list.filter((t) => t.state === 'pending').length} not started</span>
                </div>
              </div>
              <span
                className="doc-ref flex-none text-[17px] font-bold"
                style={{ color: p === 100 ? '#0B6B45' : fixes ? '#B3261E' : '#0A1F17' }}
              >
                {p}%
              </span>
              {open ? (
                <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
              ) : (
                <ChevronRight className="h-4 w-4 flex-none text-[#8CA396]" />
              )}
            </button>
            {open && (
              <div className="border-t border-t-[#E4ECE3] bg-[#FBFCFA] p-2.5">
                {list.length === 0 && (
                  <p className="px-1 py-2 text-[11.5px] font-semibold text-[#8CA396]">
                    Nothing on this login&rsquo;s list today.
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  {list.map((t) => (
                    <div
                      key={t.id}
                      className="flex flex-wrap items-center gap-2 rounded-[4px] border border-[#E4ECE3] bg-white px-3 py-2"
                    >
                      <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: st(s(t.state)).mark }} />
                      <span className="min-w-0 flex-1 text-[12px] font-bold text-[#0A1F17]">{s(t.title)}</span>
                      <span className="flex-none text-[10.5px] font-semibold text-[#8CA396]">
                        {pageLabel(s(t.module))}
                      </span>
                      <StateChip k={s(t.state)} small />
                      <span className="doc-ref flex-none text-[10.5px] font-semibold text-[#8CA396]">
                        {t.marked_at || 'not ticked'}
                      </span>
                    </div>
                  ))}
                </div>
                {fixes > 0 && (
                  <p className="mt-2 px-1 text-[11px] font-semibold text-[#B3261E]">
                    Held up on {fixes} {fixes === 1 ? 'task' : 'tasks'} sent back for correction.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p className="rounded-[4px] border border-[#DCE7DB] bg-[#F7FAF6] px-3.5 py-3 text-[11px] font-medium leading-[1.6] text-[#5A6B62]">
        Approved is the only state that counts as finished, so a task ticked Done still shows as outstanding until it
        clears review. The list resets each morning; a task sent back stays on the day it was raised so nothing
        disappears unresolved.
      </p>
    </div>
  )
}

// ------------------------------------------------------------- dialogs ------
function SendBackDialog({
  sendBack,
  onClose,
  sbNote,
  onNoteChange,
  busy,
  onConfirm
}: {
  sendBack: Row | null
  onClose: () => void
  sbNote: string
  onNoteChange: (v: string) => void
  busy: number
  onConfirm: () => void
}): React.JSX.Element | null {
  if (!sendBack) return null
  const ready = sbNote.trim().length > 0
  const who = s(sendBack.user_name).split(' ')[0]
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-[min(100%,560px)] flex-col overflow-hidden rounded-lg bg-white shadow-[0_24px_60px_rgba(10,31,23,.34)]">
        <div className="flex flex-none items-start justify-between gap-3 px-[22px] pt-5">
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#B3261E]">
              Send back for fixes
            </div>
            <div className="mt-1 text-[17px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">
              {s(sendBack.title)}
            </div>
            <div className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">
              {s(sendBack.user_name)} · {pageLabel(s(sendBack.module))} · ticked {s(sendBack.marked_at) || '—'}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] hover:bg-[#F1F5EF]"
          >
            <X className="h-5 w-5 text-[#5A6B62]" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4">
          <label className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            What needs fixing <span className="text-[#B3261E]">*</span>
          </label>
          <textarea
            rows={3}
            autoFocus
            value={sbNote}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Say what is wrong and what to do about it — this is what they will see."
            className="mt-1.5 w-full rounded-[4px] border bg-white px-3 py-2.5 text-[12.5px] font-medium leading-[1.55] outline-none placeholder:text-[#A9BCB0] focus:border-[#8C2F26]"
            style={{ borderColor: ready ? '#C3D2C6' : '#E3C58C' }}
          />
          <div className="mt-2.5 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]">
            Common reasons
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onNoteChange(p)}
                className="rounded-[4px] border border-[#DCE7DB] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#33473E] hover:bg-[#F7FAF6]"
              >
                {p}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-start gap-2.5 rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3 py-2.5">
            <BellRing className="mt-px h-4 w-4 flex-none text-[#B3261E]" />
            <p className="text-[11.5px] font-semibold leading-[1.5] text-[#8C2F26]">
              {who} gets this as a notification and sees it on this page. The task moves to Needs fixes and stays on
              today until they answer it.
            </p>
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] px-[22px] py-4">
          <span
            className="min-w-0 flex-1 text-[11.5px] font-semibold"
            style={{ color: ready ? '#0B6B45' : '#8A5300' }}
          >
            {ready ? `Sending this back to ${who}.` : 'Say what needs fixing before sending it back.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-none rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || !!busy}
            onClick={onConfirm}
            className={cn(
              'flex h-10 flex-none items-center gap-1.5 rounded-[4px] px-4 text-[12px] font-extrabold',
              ready ? 'bg-[#8C2F26] text-white hover:bg-[#7A2820]' : 'bg-[#C3D2C6] text-[#F1F5EF]'
            )}
          >
            <Undo2 className="h-4 w-4" /> SEND BACK
          </button>
        </div>
      </div>
    </div>
  )
}

function AssignDialog({
  open,
  onClose,
  asForm,
  onFormChange,
  teamUsers,
  busy,
  onConfirm,
  cutoffLabel
}: {
  open: boolean
  onClose: () => void
  asForm: Row
  onFormChange: (patch: Row) => void
  teamUsers: Row[]
  busy: number
  onConfirm: () => void
  cutoffLabel: (userId: unknown) => string
}): React.JSX.Element | null {
  if (!open) return null
  const lines: Row[] = Array.isArray(asForm.lines) ? (asForm.lines as Row[]) : []
  const filled = lines.filter((l) => s(l.title).trim().length > 0).length
  const ready = n(asForm.user_id) > 0 && filled > 0
  const setLine = (i: number, patch: Row): void =>
    onFormChange({ lines: lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) })
  const addLine = (): void => onFormChange({ lines: [...lines, { title: '', detail: '', open: false }] })
  const dropLine = (i: number): void =>
    onFormChange({ lines: lines.length <= 1 ? lines : lines.filter((_, k) => k !== i) })
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-[min(100%,600px)] flex-col overflow-hidden rounded-lg bg-white shadow-[0_24px_60px_rgba(10,31,23,.34)]">
        <div className="flex flex-none items-start justify-between gap-3 px-[22px] pt-5">
          <div className="min-w-0">
            <div className="text-[17px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">Assign a one-off task</div>
            <p className="mt-1 text-[11.5px] font-medium leading-[1.55] text-[#5A6B62]">
              The daily list builds itself from page access. Use this for something outside it — a stock recount, a
              supplier follow-up.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] hover:bg-[#F1F5EF]"
          >
            <X className="h-5 w-5 text-[#5A6B62]" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4">
          <label className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            Who does it <span className="text-[#B3261E]">*</span>
          </label>
          {/* A TABLE THAT SCROLLS ON ITS OWN.
              Eight logins as eight full-height cards pushed What to do below
              the fold, so the form's own subject was off screen while its
              first question was answered. One bounded, scrolling pane: the
              whole form stays visible however many people there are. */}
          <div className="mt-1.5 overflow-hidden rounded-[4px] border border-[#DCE7DB]">
            <div className="flex items-center gap-2.5 border-b border-b-[#EDF3EC] bg-[#F7FAF6] px-3 py-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]">
              <span className="min-w-0 flex-1">Login</span>
              <span className="flex-none">Reaches · cut-off</span>
            </div>
            <div className="max-h-[186px] overflow-y-auto">
              {teamUsers.map((u) => {
                const on = n(asForm.user_id) === n(u.id)
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => onFormChange({ user_id: n(u.id) })}
                    className={cn(
                      'flex w-full items-center gap-2.5 border-b border-b-[#F1F5EF] px-3 py-2 text-left last:border-b-0',
                      on ? 'bg-[#F1F5EF]' : 'bg-white hover:bg-[#F7FAF6]'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full border-[1.5px]',
                        on ? 'border-[#0B3D2E] bg-[#0B3D2E]' : 'border-[#C3D2C6] bg-white'
                      )}
                    >
                      {on && <Check className="h-3 w-3 text-[#C7F03F]" />}
                    </span>
                    <Avatar name={s(u.name)} size={24} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#0A1F17]">{s(u.name)}</span>
                    <span className="flex-none text-right text-[10.5px] font-semibold text-[#8CA396]">
                      {Array.isArray(u.grants) ? `${(u.grants as string[]).length} pages` : s(u.role)}
                      {!!u.cutoff_own && (
                        <span className="ml-1.5 font-bold text-[#1B4E82]">
                          {s(u.cutoff_day) === 'next' ? `${s(u.cutoff)} next day` : s(u.cutoff)}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* SEVERAL THINGS, HANDED OVER ONCE.
              Somebody caught in the corridor is given three jobs, not one job
              three times — and three trips through this dialog is three
              notifications for one conversation. Each line becomes its own
              task on the board; the bell rings once.

              The note is folded away: most one-offs are a sentence, and a
              second empty box under every line made the form look like it
              wanted twice as much as it does. */}
          <div className="mt-3 flex items-center gap-2">
            <label className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
              What to do <span className="text-[#B3261E]">*</span>
            </label>
            <span className="min-w-0 flex-1" />
            {filled > 1 && (
              <span className="text-[10.5px] font-bold text-[#0B6B45]">{filled} tasks</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {lines.map((l, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-[14px] flex-none text-right text-[11px] font-extrabold tabular-nums text-[#8CA396]">
                    {i + 1}
                  </span>
                  <input
                    value={s(l.title)}
                    autoFocus={i === lines.length - 1 && lines.length > 1}
                    onChange={(e) => setLine(i, { title: e.target.value })}
                    onKeyDown={(e) => {
                      // Enter on the last, filled line opens the next one —
                      // typing a list should not need the mouse.
                      if (e.key === 'Enter' && s(l.title).trim() && i === lines.length - 1) {
                        e.preventDefault()
                        addLine()
                      }
                    }}
                    maxLength={300}
                    placeholder={i === 0 ? 'Recount tank 4 against the dip book' : 'And then…'}
                    className="h-10 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12.5px] font-semibold outline-none placeholder:font-medium placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
                  />
                  <button
                    type="button"
                    onClick={() => setLine(i, { open: !l.open })}
                    title={l.open ? 'Hide the note' : 'Add a note for this one'}
                    className={cn(
                      'flex h-10 w-9 flex-none items-center justify-center rounded-[4px] border text-[11px] font-extrabold',
                      l.open || s(l.detail).trim()
                        ? 'border-[#0B3D2E] bg-[#F1F5EF] text-[#0B3D2E]'
                        : 'border-[#C3D2C6] bg-white text-[#8CA396] hover:bg-[#F7FAF6]'
                    )}
                  >
                    <ListPlus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => dropLine(i)}
                    disabled={lines.length <= 1}
                    title="Remove this line"
                    className="flex h-10 w-9 flex-none items-center justify-center rounded-[4px] border border-[#C3D2C6] bg-white text-[#8CA396] hover:border-[#B3261E] hover:text-[#B3261E] disabled:opacity-30"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {(!!l.open || !!s(l.detail).trim()) && (
                  <textarea
                    rows={2}
                    value={s(l.detail)}
                    onChange={(e) => setLine(i, { detail: e.target.value })}
                    placeholder="Anything they need to know to do this one. Optional."
                    className="ml-[22px] rounded-[4px] border border-[#C3D2C6] bg-white px-3 py-2 text-[12px] font-medium leading-[1.5] outline-none placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
                  />
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addLine}
            className="mt-2 flex h-9 items-center gap-1.5 rounded-[4px] border border-dashed border-[#A8C0B2] bg-white px-3 text-[11.5px] font-extrabold text-[#0B3D2E] hover:bg-[#F7FAF6]"
          >
            <Plus className="h-4 w-4" /> Add another line
          </button>
          <label className="mt-3 block text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            Against which page
          </label>
          <select
            value={s(asForm.module)}
            onChange={(e) => onFormChange({ module: e.target.value })}
            className="mt-1.5 h-10 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[12.5px] font-semibold text-[#0A1F17] outline-none focus:border-[#0B3D2E]"
          >
            {MODULES.filter((m) => !m.derived).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-[#5A6B62]">
            <Clock className="h-3.5 w-3.5" /> Due by {cutoffLabel(asForm.user_id)}, like everything else on that
            login&rsquo;s board.
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] px-[22px] py-4">
          <span
            className="min-w-0 flex-1 text-[11.5px] font-semibold"
            style={{ color: ready ? '#0B6B45' : '#8A5300' }}
          >
            {ready
              ? `${filled === 1 ? 'One task' : `${filled} tasks`} — they will be told straight away.`
              : 'Pick who it is for and say what needs doing.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-none rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || !!busy}
            onClick={onConfirm}
            className={cn(
              'flex h-10 flex-none items-center gap-1.5 rounded-[4px] px-4 text-[12px] font-extrabold',
              ready ? 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]' : 'bg-[#C3D2C6] text-[#F1F5EF]'
            )}
          >
            <Plus className="h-4 w-4" /> {filled > 1 ? `ASSIGN ${filled}` : 'ASSIGN'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ========================================================= a day reopened ==
// ASKING FOR A DAY BACK.
//
// The board is today's, and it closes. Work still happened on a day that has
// shut — a shift that ran past midnight, a day somebody was out — and the
// record should be able to say so without the checklist becoming something
// anyone can fill in whenever they like. So the day is ASKED for: one login,
// one date, an admin's answer, and a tick that still carries the moment it was
// really made.
function DayRequestBox({
  open,
  onClose,
  busy,
  boardDate,
  onSend
}: {
  open: boolean
  onClose: () => void
  busy: number
  boardDate: string
  onSend: (date: string, reason: string) => Promise<void>
}): React.JSX.Element | null {
  const [date, setDate] = useState('')
  const [why, setWhy] = useState('')
  useEffect(() => {
    if (open) {
      setDate(dayPlus(boardDate, -1))
      setWhy('')
    }
  }, [open, boardDate])
  if (!open) return null
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < boardDate
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex w-[min(100%,460px)] flex-col overflow-hidden rounded-lg bg-white shadow-[0_24px_60px_rgba(10,31,23,.34)]">
        <div className="flex items-start justify-between gap-3 px-[22px] pt-5">
          <div className="min-w-0">
            <div className="text-[17px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">Ask to fill in a closed day</div>
            <p className="mt-1 text-[11.5px] font-medium leading-[1.55] text-[#5A6B62]">
              An admin opens that one day for you. What you tick afterwards still shows the time you actually ticked it.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] hover:bg-[#F1F5EF]"
          >
            <X className="h-5 w-5 text-[#5A6B62]" />
          </button>
        </div>
        <div className="px-[22px] pt-4">
          <label className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">Which day</label>
          <input
            type="date"
            value={date}
            max={dayPlus(boardDate, -1)}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1.5 h-10 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12.5px] font-bold text-[#0A1F17] outline-none focus:border-[#0B3D2E]"
          />
          <label className="mt-3 block text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            Why it was not done on the day
          </label>
          <textarea
            rows={2}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="The last tanker was weighed after midnight."
            className="mt-1.5 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 py-2.5 text-[12.5px] font-medium leading-[1.55] outline-none placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] px-[22px] py-4">
          <span className="min-w-0 flex-1 text-[11.5px] font-semibold" style={{ color: ready ? '#0B6B45' : '#8A5300' }}>
            {ready ? 'The admin is told as soon as you send it.' : 'Pick a day before this one.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || busy > 0}
            onClick={() => void onSend(date, why)}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-[4px] px-4 text-[12px] font-extrabold',
              ready ? 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]' : 'bg-[#C3D2C6] text-[#F1F5EF]'
            )}
          >
            <Send className="h-4 w-4" /> ASK
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================ cut-offs ==
// WHEN EACH DESK'S DAY CLOSES.
//
// One time for the site, and a time of its own for any login that does not fit
// it — a weighbridge that shuts at six and a billing desk still invoicing at
// nine are not the same day, and one deadline across both makes the board
// wrong about one of them.
//
// It only decides who is LATE. Which day's board is open stays site-wide: the
// team works one day at a time, and giving two people on the same shift
// different boards would be a rota, not a checklist.
function CutoffRow({
  label,
  sub,
  value,
  day,
  own,
  busy,
  editing,
  draft,
  dayDraft,
  onEdit,
  onDraft,
  onDayDraft,
  onSave,
  onClear,
  onCancel
}: {
  label: string
  sub?: string
  value: string
  day: 'same' | 'next'
  own?: boolean
  busy: number
  editing: boolean
  draft: string
  dayDraft: 'same' | 'next'
  onEdit: () => void
  onDraft: (v: string) => void
  onDayDraft: (v: 'same' | 'next') => void
  onSave: () => void
  onClear?: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-t-[#EDF3EC] px-3.5 py-2.5 first:border-t-0">
      <div className="min-w-[160px] flex-1">
        <div className="text-[12.5px] font-extrabold text-[#0A1F17]">{label}</div>
        {!!sub && <div className="text-[10.5px] font-semibold text-[#8CA396]">{sub}</div>}
      </div>
      {editing ? (
        <>
          <input
            type="time"
            value={draft}
            autoFocus
            onChange={(e) => onDraft(e.target.value)}
            className="h-8 w-[104px] rounded-[3px] border border-[#C3D2C6] px-2 text-[12px] font-bold text-[#33473E] outline-none focus:border-[#0B3D2E]"
          />
          <span className="flex h-8 items-center rounded-[3px] border border-[#DCE7DB] bg-[#F7FAF6] p-[2px]">
            {(['same', 'next'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDayDraft(d)}
                title={
                  d === 'same'
                    ? 'The deadline falls inside the working day itself'
                    : 'The deadline falls in the small hours of the following morning'
                }
                className={cn(
                  'h-full rounded-[2px] px-2 text-[10.5px] font-extrabold',
                  dayDraft === d ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'text-[#5A6B62] hover:bg-[#EDF3EC]'
                )}
              >
                {d === 'same' ? 'Same day' : 'Next day'}
              </button>
            ))}
          </span>
          <button
            type="button"
            disabled={busy > 0 || !/^\d{2}:\d{2}$/.test(draft)}
            onClick={onSave}
            className="h-8 rounded-[3px] bg-[#C7F03F] px-3 text-[11px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F] disabled:opacity-50"
          >
            Save
          </button>
          {!!onClear && (
            <button
              type="button"
              disabled={busy > 0}
              onClick={onClear}
              title="Follow the site cut-off again, including whenever it changes"
              className="h-8 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[11px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
            >
              Use the site&rsquo;s
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="flex h-8 w-8 items-center justify-center rounded-[3px] text-[#5A6B62] hover:bg-[#F1F5EF]"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[3px] px-2 py-1 text-[11.5px] font-extrabold',
              own ? 'bg-[#EAF0FA] text-[#1B4E82]' : 'bg-[#EAF0E9] text-[#33473E]'
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            {day === 'next' ? `${value} next day` : value}
            {own && <span className="text-[9.5px] uppercase tracking-[.08em] opacity-70">own</span>}
          </span>
          <button
            type="button"
            onClick={onEdit}
            className="h-8 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[11px] font-extrabold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Change
          </button>
        </>
      )}
    </div>
  )
}

function CutoffsAdmin({
  users,
  siteCutoff,
  siteDay,
  today,
  dayRequests,
  busy,
  onSetSite,
  onSetUser,
  onSetDayOpen
}: {
  users: Row[]
  siteCutoff: string
  siteDay: 'same' | 'next'
  today: string
  dayRequests: Row[]
  busy: number
  onSetSite: (cutoff: string, day: 'same' | 'next') => Promise<void>
  onSetUser: (userId: number, cutoff: string, day: string) => Promise<void>
  onSetDayOpen: (userIds: number[], date: string, open: boolean, note: string) => Promise<boolean>
}): React.JSX.Element {
  // 0 is nothing being edited and -1 is the site's own row — one at a time,
  // because this is a setting and not a form to fill in down the page.
  const [editId, setEditId] = useState(0)
  const [draft, setDraft] = useState('')
  const [dayDraft, setDayDraft] = useState<'same' | 'next'>('same')
  const own = users.filter((u) => u.cutoff_own)

  // OPENING A DAY WITHOUT BEING ASKED.
  //
  // It lives on this tab because it is the same subject: the cut-off decides
  // when a day stops accepting work, and this is the exception to it. The
  // date defaults to the day before the open one, which is the day being
  // asked about nearly every time.
  const yesterday = useMemo(() => dayPlus(today || todayISO(), -1), [today])
  const [openDate, setOpenDate] = useState(yesterday)
  const [openWho, setOpenWho] = useState<number[]>([])
  const [openNote, setOpenNote] = useState('')
  // An admin's own board never closes, so offering to open one is a promise
  // this cannot keep — the server skips them and the list should too.
  const openable = users.filter((u) => s(u.role) !== 'admin')
  // Every day currently standing open, whoever opened it and however.
  const standing = dayRequests.filter((r) => s(r.state) === 'approved')
  const toggleWho = (id: number): void =>
    setOpenWho((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const start = (id: number, at: string, day: 'same' | 'next'): void => {
    setEditId(id)
    setDraft(at)
    setDayDraft(day)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2.5 rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 py-3">
        <Clock className="mt-[2px] h-4 w-4 flex-none text-[#0B6B45]" />
        <p className="min-w-0 flex-1 text-[11.5px] font-medium leading-[1.55] text-[#5A6B62]">
          The site cut-off is what every login follows — <strong className="font-extrabold text-[#33473E]">now and
          whenever it changes</strong> — until one is given a time of its own. A cut-off only decides who is late; the
          day itself still opens and closes once, for everybody.
        </p>
      </div>

      <div className="rounded-[4px] border border-[#DCE7DB] bg-white">
        <div className="border-b border-b-[#EDF3EC] bg-[#F7FAF6] px-3.5 py-2 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
          The site
        </div>
        <CutoffRow
          label="Everyone, unless said otherwise"
          sub={
            own.length
              ? `${own.length} ${own.length === 1 ? 'login has' : 'logins have'} a time of their own`
              : 'every login is on this time'
          }
          value={siteCutoff}
          day={siteDay}
          busy={busy}
          editing={editId === -1}
          draft={draft}
          dayDraft={dayDraft}
          onEdit={() => start(-1, siteCutoff, siteDay)}
          onDraft={setDraft}
          onDayDraft={setDayDraft}
          onSave={() => {
            setEditId(0)
            void onSetSite(draft, dayDraft)
          }}
          onCancel={() => setEditId(0)}
        />
      </div>

      <div className="rounded-[4px] border border-[#DCE7DB] bg-white">
        <div className="border-b border-b-[#EDF3EC] bg-[#F7FAF6] px-3.5 py-2 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
          Each login
        </div>
        {users.length === 0 && (
          <div className="px-3.5 py-8 text-center text-[12px] font-semibold text-[#8CA396]">
            No logins with page access yet.
          </div>
        )}
        {users.map((u) => (
          <CutoffRow
            key={u.id}
            label={s(u.name)}
            sub={`${s(u.role)}${u.cutoff_own ? '' : ' · on the site cut-off'}`}
            value={s(u.cutoff) || siteCutoff}
            day={s(u.cutoff_day) === 'next' ? 'next' : 'same'}
            own={!!u.cutoff_own}
            busy={busy}
            editing={editId === n(u.id)}
            draft={draft}
            dayDraft={dayDraft}
            onEdit={() => start(n(u.id), s(u.cutoff) || siteCutoff, s(u.cutoff_day) === 'next' ? 'next' : 'same')}
            onDraft={setDraft}
            onDayDraft={setDayDraft}
            onSave={() => {
              setEditId(0)
              void onSetUser(n(u.id), draft, dayDraft)
            }}
            onClear={
              u.cutoff_own
                ? () => {
                    setEditId(0)
                    void onSetUser(n(u.id), '', 'same')
                  }
                : undefined
            }
            onCancel={() => setEditId(0)}
          />
        ))}
      </div>

      {/* A DAY OPENED WITHOUT BEING ASKED.
          The board is today's, and it shuts at the cut-off — that is what the
          rest of this tab is about. This is the exception, and it belongs
          beside the rule rather than behind a queue of requests: somebody was
          off sick, a laptop would not start, the site itself lost a day.
          Making them file a request first, so it can be approved by the hand
          that already decided, is a form and nothing else. */}
      <div className="rounded-[4px] border border-[#DCE7DB] bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-b-[#EDF3EC] bg-[#F7FAF6] px-3.5 py-2">
          <CalendarClock className="h-3.5 w-3.5 text-[#0B6B45]" />
          <span className="text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
            Open a closed day
          </span>
          <span className="min-w-0 flex-1" />
          <span className="text-[10.5px] font-semibold text-[#8CA396]">no request needed</span>
        </div>

        <div className="flex flex-wrap items-end gap-3 px-3.5 py-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]">Which day</span>
            <input
              type="date"
              value={openDate}
              max={yesterday}
              onChange={(e) => setOpenDate(e.target.value)}
              className="h-8 w-[150px] rounded-[3px] border border-[#C3D2C6] px-2 text-[12px] font-bold text-[#33473E] outline-none focus:border-[#0B3D2E]"
            />
          </div>
          <div className="flex min-w-[180px] flex-1 flex-col gap-1">
            <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]">
              Why — they will read it
            </span>
            <input
              value={openNote}
              placeholder="optional · was on leave, laptop down"
              onChange={(e) => setOpenNote(e.target.value)}
              className="h-8 w-full rounded-[3px] border border-[#C3D2C6] px-2 text-[12px] font-semibold text-[#33473E] outline-none focus:border-[#0B3D2E]"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-3.5">
          <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#8CA396]">For whom</span>
          {openable.length > 1 && (
            <button
              type="button"
              onClick={() => setOpenWho(openWho.length === openable.length ? [] : openable.map((u) => n(u.id)))}
              className="rounded-[3px] border border-[#C3D2C6] bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
            >
              {openWho.length === openable.length ? 'Clear' : 'Everyone'}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3 pt-2">
          {openable.length === 0 && (
            <span className="py-2 text-[12px] font-semibold text-[#8CA396]">
              Nobody to open a day for — an admin&rsquo;s own board never closes.
            </span>
          )}
          {openable.map((u) => {
            const on = openWho.includes(n(u.id))
            const already = standing.some((r) => n(r.user_id) === n(u.id) && s(r.work_date) === openDate)
            return (
              <button
                key={n(u.id)}
                type="button"
                onClick={() => toggleWho(n(u.id))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-1 text-[11.5px] font-bold',
                  on
                    ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                    : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                )}
              >
                {on && <Check className="h-3 w-3 text-[#C7F03F]" />}
                {s(u.name)}
                {/* Already open on the chosen date. Picking them again is
                    harmless, but saying so saves the admin wondering why
                    nothing appeared to happen. */}
                {already && (
                  <span className={cn('text-[10px] font-extrabold', on ? 'text-[#C7F03F]' : 'text-[#0B6B45]')}>
                    open
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-t-[#EDF3EC] px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[11px] font-medium leading-[1.5] text-[#5A6B62]">
            It opens that one date for those logins, and tells each of them so. A tick made afterwards still carries
            the moment it was really made — this reopens the door, it does not backdate anything.
          </span>
          <button
            type="button"
            disabled={busy > 0 || !openWho.length || !openDate}
            onClick={() =>
              void onSetDayOpen(openWho, openDate, true, openNote).then((ok) => {
                // Only on success: a failed open leaves the picks where they
                // are, so the retry is one click and not the whole list again.
                if (!ok) return
                setOpenWho([])
                setOpenNote('')
              })
            }
            className="h-8 rounded-[3px] bg-[#0B3D2E] px-3 text-[12px] font-extrabold text-[#C7F03F] disabled:opacity-40"
          >
            Open {openWho.length ? `for ${openWho.length}` : 'the day'}
          </button>
        </div>

        {/* What stands open right now — days an admin opened and days somebody
            asked for, together, because from here they are the same thing: a
            door that is open and can be shut again. */}
        <div className="border-t border-t-[#EDF3EC] bg-[#F7FAF6] px-3.5 py-2 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
          Standing open{standing.length > 0 ? ` · ${standing.length}` : ''}
        </div>
        {standing.length === 0 ? (
          <div className="px-3.5 py-5 text-center text-[11.5px] font-semibold text-[#8CA396]">
            Every day is shut but the one on the board.
          </div>
        ) : (
          standing.map((r) => (
            <div key={n(r.id)} className="flex flex-wrap items-center gap-2 border-t border-t-[#EDF3EC] px-3.5 py-2">
              <span className="doc-ref text-[12px] font-extrabold text-[#0A1F17]">{formatDate(s(r.work_date))}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#33473E]">
                {s(r.user_name)}
                <span className="ml-1.5 text-[10.5px] font-semibold text-[#8CA396]">
                  {n(r.opened_by_admin) === 1 ? 'opened for them' : 'they asked'}
                </span>
              </span>
              <button
                type="button"
                disabled={busy > 0}
                onClick={() => void onSetDayOpen([n(r.user_id)], s(r.work_date), false, '')}
                className="inline-flex items-center gap-1 rounded-[3px] border border-[#C3D2C6] bg-white px-2 py-1 text-[11px] font-bold text-[#8C2F26] hover:border-[#B3261E] disabled:opacity-40"
              >
                <X className="h-3 w-3" /> Shut it
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ============================================================== task list ==
// THE CATALOGUE, WHICH IS WHERE EVERY BOARD COMES FROM.
//
// Nobody is given a checklist here. A line is written against a PAGE, and
// whoever can reach that page is asked it, every day, for as long as they can
// reach it — which is why a new line needs no thought about who does it and a
// staff change needs no thought about the checklist. The Assign button is the
// other half: a one-off for one person on one day, which this deliberately is
// not.
//
// Everything on this tab is admin-only, and the server says so too.

/** Which logins a line will actually reach, given what they can open. */
function reachOf(users: Row[], module: string, scope: string): Row[] {
  return users.filter((u) => {
    const g = u.grants
    // An admin is not on anybody's checklist — a list of the whole app against
    // the person doing the reviewing is the app's table of contents, not a day.
    if (!Array.isArray(g)) return false
    const scopes = new Set<string>()
    for (const raw of g as string[]) {
      const [m, sc] = s(raw).split(':')
      if (m === module) scopes.add(s(sc))
    }
    // An unscoped line belongs to an unscoped grant; a desk line belongs only
    // to that desk. Exactly the rule the board is built with — see work.ts.
    return scope ? scopes.has(scope) : scopes.has('')
  })
}

// The narrowed desks the rights screen can hand out. A line written against
// one of them is asked of that desk INSTEAD of the page's own list, which is
// the only reason scope exists here.
//
// The inter-company desk appears under both pages because it IS both: the
// transfer is billed on Sales and read on Purchases, and a checklist line
// about it could belong to either side of that job.
const DESK_OPTIONS: Record<string, { value: string; label: string }[]> = {
  sales: [
    { value: '', label: 'Everyone who can open Sales' },
    { value: 'unload', label: 'The unloading desk only' },
    { value: 'intercompany', label: 'The inter-company transfer desk only' }
  ],
  orders: [
    { value: '', label: 'Everyone who can open Purchases' },
    { value: 'readings', label: 'The readings (lab) desk only' },
    { value: 'intercompany', label: 'The inter-company transfer desk only' }
  ]
}

function TaskListAdmin({
  compact,
  procs,
  users,
  busy,
  boardDate,
  openDay,
  onSave,
  onRemove,
  onReorder
}: {
  compact: boolean
  procs: Row[]
  users: Row[]
  busy: number
  boardDate: string
  openDay: string
  onSave: (values: Row) => Promise<boolean>
  onRemove: (id: number) => Promise<void>
  onReorder: (ids: number[]) => Promise<void>
}): React.JSX.Element {
  const [mod, setMod] = useState('')
  // A page with no lines yet is not in the catalogue, so it is remembered here
  // until its first line makes it real.
  const [editId, setEditId] = useState(0)
  const [draft, setDraft] = useState<Row>({ title: '', detail: '', scope: '' })
  const [adding, setAdding] = useState(false)
  const [bulk, setBulk] = useState('')
  const [askDel, setAskDel] = useState(0)

  // EVERY PAGE, NOT ONLY THE ONES ALREADY ASKED ABOUT.
  //
  // The rail used to list a page once it HAD a line, and hid the rest behind a
  // dropdown — so the screen answered "which pages have a checklist" when the
  // question being asked is "what could I put a checklist on". Now it is the
  // same list the rights grid shows, in the same families, with the count
  // beside each: a page with nothing on it reads 0 and is one click from its
  // first line.
  const pages = useMemo(() => {
    const have = new Set(procs.map((p) => s(p.module)))
    const known = MODULES.map((m) => m.key)
    // Anything carrying lines that the rail does not know by name still has to
    // appear — a list you cannot see is a list you cannot fix.
    const rest = [...have].filter((k) => !known.includes(k)).sort()
    return [...known, ...rest]
  }, [procs])
  const grouped = useMemo(() => {
    const by = new Map<string, string[]>()
    for (const k of pages) {
      const g = MODULE_GROUP[k] || 'Other'
      if (!by.has(g)) by.set(g, [])
      by.get(g)!.push(k)
    }
    return MODULE_GROUPS.filter((g) => by.has(g)).map((g) => ({ group: g, keys: by.get(g) as string[] }))
  }, [pages])
  // DECLARED BEFORE THEY ARE CALLED, WHICH HERE IS NOT A STYLE POINT.
  //
  // `firstWithLines` below calls countOfRaw inside an arrow passed to .find —
  // and .find runs that arrow AT ONCE. With the const declared after this
  // point it was still in its temporal dead zone when the arrow ran, so the
  // whole tab threw "Cannot access 'countOfRaw' before initialization" on
  // first render and the page went white.
  //
  // TypeScript cannot see it: the reference is inside a function body, which
  // is legal to write above the declaration, and nothing static says when that
  // function is called. The typecheck and the build were both clean.
  const countOfRaw = useCallback(
    (key: string): number => procs.filter((p) => s(p.module) === key && p.active).length,
    [procs]
  )
  const countOf = useCallback(
    (key: string): { on: number; off: number } => {
      const l = procs.filter((p) => s(p.module) === key)
      return { on: l.filter((x) => x.active).length, off: l.filter((x) => !x.active).length }
    },
    [procs]
  )

  // Opens on a page that HAS lines rather than on Dashboard, which almost
  // never has any — the first thing on screen should be something to read.
  const firstWithLines = pages.find((k) => countOfRaw(k) > 0) || pages[0] || ''
  const pageKey = pages.includes(mod) ? mod : firstWithLines

  const lines = useMemo(
    () => procs.filter((p) => s(p.module) === pageKey).sort((a, b) => n(a.sort_order) - n(b.sort_order) || n(a.id) - n(b.id)),
    [procs, pageKey]
  )

  function startEdit(l: Row): void {
    setAdding(false)
    setAskDel(0)
    setEditId(n(l.id))
    setDraft({ title: s(l.title), detail: s(l.detail), scope: s(l.scope), user_id: n(l.user_id) })
  }

  async function saveEdit(l: Row): Promise<void> {
    const ok = await onSave({
      id: n(l.id),
      module: s(l.module),
      scope: s(draft.scope),
      title: s(draft.title),
      detail: s(draft.detail),
      user_id: n(draft.user_id),
      active: !!l.active
    })
    if (ok) setEditId(0)
  }

  async function addLines(): Promise<void> {
    // One per line, so a list that already exists on paper or in a chat can be
    // pasted in whole rather than typed one box at a time.
    const wanted = bulk
      .split(/\r?\n/)
      // A bullet or a numbering is the shape of the list it was pasted from,
      // not part of the task. Both need the space after them, so a line that
      // genuinely starts "4 tanks to dip" keeps its number.
      .map((x) => x.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
    if (!wanted.length || !pageKey) return
    let made = 0
    for (const title of wanted) {
      if (await onSave({ module: pageKey, scope: '', title, detail: '', active: true })) made += 1
    }
    if (made) {
      setBulk('')
      setAdding(false)
    }
  }

  async function move(i: number, by: number): Promise<void> {
    const j = i + by
    if (j < 0 || j >= lines.length) return
    const ids = lines.map((l) => n(l.id))
    const [cut] = ids.splice(i, 1)
    ids.splice(j, 0, cut)
    await onReorder(ids)
  }

  const reach = (l: Row): Row[] => {
    const all = reachOf(users, s(l.module), s(l.scope))
    const only = n(l.user_id)
    return only ? all.filter((u) => n(u.id) === only) : all
  }
  const pageReach = pageKey ? reachOf(users, pageKey, '') : []

  const rail = (
    <div
      className={cn(
        'flex flex-col gap-1',
        compact ? '' : 'sc w-[264px] flex-none overflow-y-auto pr-1'
      )}
      style={compact ? undefined : { maxHeight: 'calc(100vh - 230px)' }}
    >
      {grouped.map(({ group, keys }) => (
        <div key={group} className="flex flex-col gap-1">
          <div className="px-1 pb-0.5 pt-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
            {group}
          </div>
          {keys.map((k) => {
        const c = countOf(k)
        const on = k === pageKey
        return (
          <button
            key={k}
            type="button"
            onClick={() => {
              setMod(k)
              setEditId(0)
              setAdding(false)
              setAskDel(0)
            }}
            title={pageLabel(k)}
            className={cn(
              'flex items-center gap-2 rounded-[4px] border px-2.5 py-2 text-left',
              on ? 'border-[#0B3D2E] bg-[#0B3D2E]' : 'border-[#DCE7DB] bg-white hover:bg-[#F7FAF6]'
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate text-[12.5px] font-extrabold', on ? 'text-white' : 'text-[#0A1F17]')}>
              {pageLabel(k)}
            </span>
            <span
              className={cn(
                'doc-ref flex-none rounded-[2px] px-1.5 text-[10px] font-bold',
                on ? 'bg-[#C7F03F] text-[#0B3D2E]' : 'bg-[#EAF0E9] text-[#33473E]'
              )}
            >
              {c.on}
              {c.off > 0 && <span className={cn('ml-1', on ? 'text-[#0B3D2E]/60' : 'text-[#8CA396]')}>+{c.off}</span>}
            </span>
          </button>
        )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2.5 rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 py-3">
        <ListPlus className="mt-[2px] h-4 w-4 flex-none text-[#0B6B45]" />
        <p className="min-w-0 flex-1 text-[11.5px] font-medium leading-[1.55] text-[#5A6B62]">
          Every line here becomes a tick box on the board of <strong className="font-extrabold text-[#33473E]">everyone who can
          open that page</strong> — today and every day after, with no one to name and nothing to repeat. Reword a line and
          today&rsquo;s untouched boards follow it; switch one off and it stops being asked, while anything already ticked
          stays exactly as it was.
        </p>
      </div>

      {/* WHICH BOARD A NEW LINE ACTUALLY LANDS ON.
          The catalogue has no date — it is the standing list — but the boards
          do, and only the open one is ever written: a past day keeps exactly
          what it asked at the time, which is the whole reason a tick can be
          trusted months later. Add a line while the picker is on an older day
          and it is correctly absent from the board on screen, with nothing to
          say why. This says why. */}
      {!!boardDate && !!openDay && boardDate !== openDay && (
        <div className="flex flex-wrap items-start gap-2.5 rounded-[4px] border border-[#F0E4CB] bg-[#FFF9EC] px-3.5 py-2.5">
          <AlertTriangle className="mt-[2px] h-4 w-4 flex-none text-[#C2700A]" />
          <p className="min-w-0 flex-1 text-[11.5px] font-medium leading-[1.55] text-[#8A5300]">
            The board on screen is <strong className="font-extrabold">{formatDate(boardDate)}</strong>. A line added or
            reworded now reaches everyone whose cut-off for that day has <strong className="font-extrabold">not yet
            passed</strong>, and every day after. Once somebody&rsquo;s cut-off is behind them, their side of that day
            keeps exactly what it asked.
          </p>
        </div>
      )}

      <div className={cn('flex gap-3', compact && 'flex-col')}>
        {rail}
        <div className="min-w-0 flex-1">
          {!pageKey ? (
            <div className="rounded-[4px] border border-dashed border-[#C3D2C6] bg-white px-4 py-10 text-center text-[12px] font-semibold text-[#8CA396]">
              No page has a list yet. Pick one above to start.
            </div>
          ) : (
            <>
              {/* The page's own head stays with its lines. Which page you are
                  editing, and how many people it reaches, are the two facts
                  every line below is read against — scrolling a long checklist
                  used to take both away. Below the page chrome's z so the two
                  never overlap. */}
              <div className="sticky top-[118px] z-20 flex flex-wrap items-center gap-2 rounded-t-[4px] border border-b-0 border-[#DCE7DB] bg-[#F7FAF6] px-3.5 py-2.5">
                <span className="text-[13px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">{pageLabel(pageKey)}</span>
                <span className="text-[11px] font-semibold text-[#5A6B62]">
                  {lines.length === 0
                    ? 'no lines yet'
                    : `${lines.filter((l) => l.active).length} asked daily${
                        lines.some((l) => !l.active) ? ` · ${lines.filter((l) => !l.active).length} off` : ''
                      }`}
                </span>
                <span className="min-w-0 flex-1" />
                {/* WHO IT LANDS ON. Written before the lines rather than after,
                    because a page nobody holds is a list nobody will ever see —
                    and that is worth knowing before typing ten of them. */}
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-[3px] px-2 py-1 text-[10.5px] font-extrabold',
                    pageReach.length ? 'bg-[#EAF0E9] text-[#33473E]' : 'bg-[#FFF4E0] text-[#8A5300]'
                  )}
                  title={pageReach.map((u) => s(u.name)).join(', ') || 'No login can open this page yet'}
                >
                  <Users className="h-3.5 w-3.5" />
                  {pageReach.length ? `${pageReach.length} ${pageReach.length === 1 ? 'person' : 'people'}` : 'nobody yet'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAdding((a) => !a)
                    setEditId(0)
                  }}
                  className="flex h-8 flex-none items-center gap-1.5 rounded-[3px] bg-[#C7F03F] px-2.5 text-[11.5px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add lines
                </button>
              </div>

              {adding && (
                <div className="border-x border-[#DCE7DB] bg-[#FBFDFA] px-3.5 py-3">
                  <label className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
                    One task per line
                  </label>
                  <textarea
                    rows={4}
                    autoFocus
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    placeholder={'Check the tank dips against the book\nClose the register before cut-off\nSign off the difference note from last night'}
                    className="mt-1.5 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 py-2.5 text-[12.5px] font-semibold leading-[1.6] outline-none placeholder:font-medium placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-[11px] font-semibold text-[#5A6B62]">
                      Paste a whole list — bullets and numbering are stripped. Detail and desk can be set on each line
                      afterwards.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false)
                        setBulk('')
                      }}
                      className="h-8 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[11.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!bulk.trim() || busy > 0}
                      onClick={() => void addLines()}
                      className="h-8 rounded-[3px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F] hover:bg-[#0A3327] disabled:opacity-50"
                    >
                      Add {bulk.split(/\r?\n/).filter((x) => x.trim()).length || ''} {
                        bulk.split(/\r?\n/).filter((x) => x.trim()).length === 1 ? 'line' : 'lines'
                      }
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-b-[4px] border border-[#DCE7DB] bg-white">
                {lines.length === 0 && !adding && (
                  <div className="px-3.5 py-8 text-center text-[12px] font-semibold text-[#8CA396]">
                    Nothing asked of this page yet. Add the first line.
                  </div>
                )}
                {lines.map((l, i) => {
                  const editing = editId === n(l.id)
                  const who = reach(l)
                  const desks = DESK_OPTIONS[pageKey]
                  return (
                    <div
                      key={n(l.id)}
                      className={cn(
                        'flex items-start gap-2.5 border-t border-t-[#EDF3EC] px-3 py-2.5 first:border-t-0',
                        !l.active && 'bg-[#FBFCFB]',
                        editing && 'bg-[#F7FAF6]'
                      )}
                    >
                      <div className="flex flex-none flex-col pt-[2px]">
                        <button
                          type="button"
                          disabled={i === 0 || busy > 0}
                          onClick={() => void move(i, -1)}
                          aria-label="Move up"
                          className="flex h-[18px] w-5 items-center justify-center rounded-[2px] text-[#8CA396] hover:bg-[#EDF3EC] disabled:opacity-25"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={i === lines.length - 1 || busy > 0}
                          onClick={() => void move(i, 1)}
                          aria-label="Move down"
                          className="flex h-[18px] w-5 items-center justify-center rounded-[2px] text-[#8CA396] hover:bg-[#EDF3EC] disabled:opacity-25"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <span
                        className={cn(
                          'mt-[3px] flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] border-[1.5px]',
                          l.active ? 'border-[#0B3D2E]' : 'border-[#C3D2C6]'
                        )}
                      />

                      {editing ? (
                        <div className="min-w-0 flex-1">
                          <input
                            value={s(draft.title)}
                            autoFocus
                            maxLength={300}
                            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveEdit(l)
                              if (e.key === 'Escape') setEditId(0)
                            }}
                            className="h-9 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[12.5px] font-bold text-[#0A1F17] outline-none focus:border-[#0B3D2E]"
                          />
                          <textarea
                            rows={2}
                            value={s(draft.detail)}
                            onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                            placeholder="What doing it properly means — shown under the line on their board."
                            className="mt-1.5 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 py-2 text-[12px] font-medium leading-[1.55] outline-none placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
                          />
                          {desks && (
                            <select
                              value={s(draft.scope)}
                              onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value }))}
                              className="mt-1.5 h-9 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2 text-[12px] font-bold text-[#33473E] outline-none focus:border-[#0B3D2E]"
                            >
                              {desks.map((d) => (
                                <option key={d.value} value={d.value}>
                                  {d.label}
                                </option>
                              ))}
                            </select>
                          )}
                          {/* WHOSE LINE IT IS.
                              A catalogue line is asked of everyone who can
                              open the page, which is the whole point of it —
                              nobody named, nothing to maintain when people
                              change. But some jobs on a shared page belong to
                              one desk: three can open Stock and one of them
                              dips the tanks. Naming somebody NARROWS it; the
                              page access is still required, so this can never
                              hand a line to someone who cannot do it. */}
                          <select
                            value={String(n(draft.user_id) || '')}
                            onChange={(e) => setDraft((d) => ({ ...d, user_id: Number(e.target.value) || 0 }))}
                            className="mt-1.5 h-9 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2 text-[12px] font-bold text-[#33473E] outline-none focus:border-[#0B3D2E]"
                          >
                            <option value="">
                              Everyone who can open this page ({reachOf(users, s(l.module), s(draft.scope)).length})
                            </option>
                            {reachOf(users, s(l.module), s(draft.scope)).map((u) => (
                              <option key={n(u.id)} value={String(n(u.id))}>
                                {s(u.name)} only
                              </option>
                            ))}
                          </select>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="min-w-0 flex-1 text-[11px] font-semibold text-[#8CA396]">
                              Enter saves · Esc cancels
                            </span>
                            <button
                              type="button"
                              onClick={() => setEditId(0)}
                              className="h-8 rounded-[3px] border border-[#C3D2C6] bg-white px-3 text-[11.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={!s(draft.title).trim() || busy > 0}
                              onClick={() => void saveEdit(l)}
                              className="h-8 rounded-[3px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F] hover:bg-[#0A3327] disabled:opacity-50"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(l)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span
                            className={cn(
                              'block text-[12.5px] font-extrabold leading-[1.35]',
                              l.active ? 'text-[#0A1F17]' : 'text-[#8CA396] line-through'
                            )}
                          >
                            {s(l.title)}
                          </span>
                          {!!s(l.detail) && (
                            <span className="mt-0.5 block text-[11.5px] font-medium leading-[1.5] text-[#5A6B62]">
                              {s(l.detail)}
                            </span>
                          )}
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            {!!s(l.scope) && (
                              <span className="rounded-[2px] bg-[#EAF0FA] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#1B4E82]">
                                {s(l.scope) === 'unload' ? 'unloading desk' : s(l.scope) === 'readings' ? 'readings desk' : s(l.scope)}
                              </span>
                            )}
                            {/* A named line says the name. "reaches 1" is
                                true and tells the reader nothing they wanted
                                to know. */}
                            {n(l.user_id) > 0 && (
                              <span
                                className="rounded-[2px] bg-[#EAF6EC] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]"
                                title="Only this login is asked this line"
                              >
                                {s(users.find((u) => n(u.id) === n(l.user_id))?.name) || 'that login'} only
                              </span>
                            )}
                            <span
                              className={cn(
                                'text-[10.5px] font-bold',
                                who.length ? 'text-[#8CA396]' : 'text-[#8A5300]'
                              )}
                              title={
                                who.map((u) => s(u.name)).join(', ') ||
                                (n(l.user_id) > 0
                                  ? 'That login can no longer open this page, so nobody is asked this'
                                  : 'No login holds this page')
                              }
                            >
                              {who.length
                                ? n(l.user_id) > 0
                                  ? 'on their board only'
                                  : `reaches ${who.length}`
                                : 'reaches nobody'}
                            </span>
                          </span>
                        </button>
                      )}

                      {!editing && (
                        <div className="flex flex-none items-center gap-1">
                          {askDel === n(l.id) ? (
                            <>
                              <span className="text-[11px] font-bold text-[#8C2F26]">Remove?</span>
                              <button
                                type="button"
                                disabled={busy > 0}
                                onClick={() => {
                                  setAskDel(0)
                                  void onRemove(n(l.id))
                                }}
                                className="h-7 rounded-[3px] bg-[#8C2F26] px-2 text-[11px] font-extrabold text-white hover:bg-[#762720]"
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                onClick={() => setAskDel(0)}
                                className="h-7 rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-[11px] font-bold text-[#33473E]"
                              >
                                No
                              </button>
                            </>
                          ) : (
                            <>
                              {/* On or off, rather than only delete: a line
                                  that is not asked THIS season is not a line
                                  that never existed, and the days it was
                                  ticked on still have to read properly. */}
                              <button
                                type="button"
                                disabled={busy > 0}
                                onClick={() =>
                                  void onSave({
                                    id: n(l.id),
                                    module: s(l.module),
                                    scope: s(l.scope),
                                    title: s(l.title),
                                    detail: s(l.detail),
                                    active: !l.active
                                  })
                                }
                                title={l.active ? 'Stop asking this' : 'Ask this again from today'}
                                className={cn(
                                  'flex h-7 items-center rounded-[3px] px-2 text-[10.5px] font-extrabold uppercase tracking-[.06em]',
                                  l.active
                                    ? 'bg-[#EAF0E9] text-[#33473E] hover:bg-[#DCE7DB]'
                                    : 'bg-[#FFF4E0] text-[#8A5300] hover:bg-[#F7E7CB]'
                                )}
                              >
                                {l.active ? 'on' : 'off'}
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(l)}
                                aria-label="Edit this line"
                                className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#5A6B62] hover:bg-[#F1F5EF]"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setAskDel(n(l.id))}
                                aria-label="Remove this line"
                                className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#8C2F26] hover:bg-[#FDF3F2]"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// =================================================================== page ==
export function WorkAssignments(): React.JSX.Element {
  const me = loadUser()
  const isAdmin = s(me?.role) === 'admin'
  const isMobile = useIsMobile()

  const [data, setData] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>(isAdmin ? 'review' : 'mine')
  const [busy, setBusy] = useState(0)
  const [read, setRead] = useState<Set<string>>(loadRead)
  const [openThread, setOpenThread] = useState<Record<number, boolean>>({})
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [openUser, setOpenUser] = useState<Record<number, boolean>>({})
  // The Review board keeps its own, so opening a person to approve their work
  // does not quietly rearrange Team progress behind the tab.
  const [openRevUser, setOpenRevUser] = useState<Record<number, boolean>>({})
  const [revFilter, setRevFilter] = useState<'review' | 'fixes' | 'pending' | 'all'>('review')

  const [sendBack, setSendBack] = useState<Row | null>(null)
  const [sbNote, setSbNote] = useState('')
  const [assignOpen, setAssignOpen] = useState(false)
  // One person, several things to do. `lines` is the form's shape now; the
  // server still accepts a lone title, so nothing else had to change.
  const [asForm, setAsForm] = useState<Row>({ user_id: 0, lines: [{ title: '', detail: '', open: false }], module: 'stock' })
  // The catalogue behind every board. Read only for an admin — nobody else has
  // a tab that shows it, and the server refuses to change it for anybody else.
  const [procs, setProcs] = useState<Row[]>([])
  const [askDayOpen, setAskDayOpen] = useState(false)

  // Which day's board is on screen. Empty means "today" — the server's own
  // default — so an ordinary login (who never sees the picker) always reads
  // as today with no extra state to keep in sync. Only an admin can set this
  // to anything else; the server still enforces that day's own data, since
  // ensureDay only ever materialises TODAY's tasks and simply reads back
  // whatever already exists for any other date.
  const [viewDate, setViewDate] = useState('')

  const myId = n(me?.id)

  const load = useCallback(
    async (background = false): Promise<void> => {
      if (!background) setLoading(true)
      try {
        // The server scopes what comes back to who is asking: an admin gets the
        // whole site's board (Review board and Team progress both need it), an
        // ordinary login gets only its own tasks. The client hiding the Team tab
        // is not the only thing standing between another desk and this login's
        // work — the payload itself no longer carries it.
        setData(await window.api.work.board(viewDate || undefined, myId))
        if (isAdmin) setProcs(await window.api.work.processes())
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [myId, viewDate, isAdmin]
  )
  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const tasks: Row[] = useMemo(() => (Array.isArray(data?.tasks) ? (data?.tasks as Row[]) : []), [data])
  const users: Row[] = useMemo(() => (Array.isArray(data?.users) ? (data?.users as Row[]) : []), [data])
  const cutoff = s(data?.cutoff) || '18:30'
  const now = s(data?.now)
  // WHICH DAY THE CUT-OFF FALLS ON.
  //
  // A deadline of 01:00 is not one in the morning of the day the work was
  // raised — it is the small hours AFTER it, the end of a shift that started
  // the previous morning. Compared as a bare clock reading, such a cut-off
  // called 23:50 late and let everything after midnight through, which is
  // both answers wrong. So the deadline is built as a whole stamp on the day
  // the admin says it belongs to, and ticks are judged against that.
  const cutoffDay: 'same' | 'next' = s(data?.cutoff_day) === 'next' ? 'next' : 'same'
  const boardDate = s(data?.date) || todayISO()
  const deadline = `${cutoffDay === 'next' ? dayPlus(boardDate, 1) : boardDate} ${cutoff}`
  // WHOSE DEADLINE.
  //
  // The site's is the default and most logins are on it, but a desk may carry
  // its own — so every place a tick is judged, or a deadline printed, asks for
  // the login it concerns rather than reading one number off the page. The
  // server resolves each login's already; this only has to find them.
  const cutoffOf = useCallback(
    (userId: unknown): { cutoff: string; day: 'same' | 'next'; own: boolean } => {
      const u = users.find((x) => n(x.id) === n(userId))
      const c = s(u?.cutoff)
      if (!/^\d{2}:\d{2}$/.test(c)) return { cutoff, day: cutoffDay, own: false }
      return { cutoff: c, day: s(u?.cutoff_day) === 'next' ? 'next' : 'same', own: !!u?.cutoff_own }
    },
    [users, cutoff, cutoffDay]
  )
  const cutoffLabelOf = useCallback(
    (userId: unknown): string => {
      const c = cutoffOf(userId)
      return c.day === 'next' ? `${c.cutoff} next day` : c.cutoff
    },
    [cutoffOf]
  )
  // The server's own clock, not the browser's: a phone with a wrong time
  // should not decide whether the mill is late.
  const nowStamp = s(data?.now_stamp).slice(0, 16)
  // How the cut-off should be READ wherever it is printed.
  // The SITE's, as it should be read — what the header chip edits and what
  // every login follows until an admin gives one its own.
  const cutoffLabel = cutoffDay === 'next' ? `${cutoff} next day` : cutoff
  // Takes the whole stamp. It used to take the clock alone, which is what
  // made a next-day cut-off impossible to express — and now the login too,
  // since two people ticking at the same minute are not necessarily both late.
  const deadlineOf = useCallback(
    (userId: unknown): string => {
      const c = cutoffOf(userId)
      return `${c.day === 'next' ? dayPlus(boardDate, 1) : boardDate} ${c.cutoff}`
    },
    [cutoffOf, boardDate]
  )
  const late = useCallback(
    (stamp: unknown, userId: unknown): boolean =>
      !!s(stamp) && s(stamp).slice(0, 16) > deadlineOf(userId),
    [deadlineOf]
  )
  // What the viewer's own header chip should say: an admin sets and watches
  // the site's, everybody else is told the one they are actually judged on.
  const myCutoff = cutoffOf(myId)
  const myCutoffLabel = isAdmin ? cutoffLabel : cutoffLabelOf(myId)
  const myDeadline = isAdmin ? deadline : deadlineOf(myId)
  // NOTHING DONE, AND THE HOUR HAS GONE.
  //
  // Judged against the SERVER's clock (nowStamp), not the browser's — a phone
  // with a wrong time should not decide that the mill is behind. Only ever
  // about a task nobody has touched: once it is ticked, `late` has the answer
  // and the tick's own stamp is the evidence.
  const overdue = useCallback(
    (t: Row): boolean =>
      s(t?.state) === 'pending' && !!nowStamp && nowStamp > deadlineOf(t?.user_id),
    [deadlineOf, nowStamp]
  )
  // Past the deadline the VIEWER is judged on — the site's for an admin, who
  // is watching the whole board rather than working it.
  const afterCutoff = !!nowStamp && nowStamp > myDeadline

  const mine = useMemo(() => tasks.filter((t) => n(t.user_id) === myId), [tasks, myId])
  const awaiting = useMemo(() => tasks.filter((t) => t.state === 'done' || t.state === 'redone'), [tasks])
  const stuck = useMemo(() => tasks.filter((t) => t.state === 'fixes'), [tasks])
  const teamUsers = useMemo(() => users.filter((u) => u.active && u.grants !== 'ALL'), [users])
  // CLOSED DAYS. The day the board is really on, which days this login has
  // been let back into, and every ask the viewer is entitled to see.
  const openDay = s(data?.open_day) || boardDate
  const openDays: string[] = useMemo(
    () => (Array.isArray(data?.open_days) ? (data?.open_days as string[]).map(s) : []),
    [data]
  )
  const dayRequests: Row[] = useMemo(
    () => (Array.isArray(data?.day_requests) ? (data?.day_requests as Row[]) : []),
    [data]
  )
  const myRequests = useMemo(
    () => (isAdmin ? [] : dayRequests.filter((r) => n(r.user_id) === myId)),
    [dayRequests, isAdmin, myId]
  )
  // The board on screen is a closed day this login was let into — said on the
  // screen, because a board that looks like today's but is not is the one
  // mistake this could cause silently.
  const closedDay = !isAdmin && boardDate !== openDay && openDays.includes(boardDate) ? boardDate : ''

  // The inbox: what an admin has said on MY tasks that I have not looked at.
  const inbox = useMemo(() => {
    const out: Row[] = []
    for (const t of mine) {
      for (const m of (t.thread || []) as Row[]) {
        if (s(m.role) !== 'admin') continue
        const key = `${t.id}:${m.id}`
        if (read.has(key)) continue
        out.push({ key, taskId: n(t.id), title: s(t.title), body: s(m.text), who: s(m.who), at: s(m.at), state: s(t.state) })
      }
    }
    return out.reverse()
  }, [mine, read])

  function markRead(keys: string[]): void {
    setRead((prev) => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      saveRead(next)
      return next
    })
  }

  // Every action reloads the board rather than patching a row: the server
  // decides the new state, writes the thread entry and raises the
  // notification, and guessing at all three on the client is how a screen ends
  // up showing an approval that was refused.
  async function act(what: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy((b) => b + 1)
    try {
      await fn()
      await load(true)
    } catch (e) {
      toast.error((e as Error).message || `Could not ${what}`)
    } finally {
      setBusy((b) => Math.max(0, b - 1))
    }
  }

  const tick = (t: Row): Promise<void> =>
    act('tick this off', async () => {
      await window.api.work.tick(n(t.id), myId)
      toast.success(`${s(t.title)} — ticked, waiting on review`)
    })
  const untick = (t: Row): Promise<void> =>
    act('untick this', async () => {
      const r = await window.api.work.untick(n(t.id), myId)
      toast.success(
        r.state === 'fixes'
          ? `${s(t.title)} — unticked, back on your fixes list`
          : `${s(t.title)} — unticked, back on your list`
      )
    })
  const redo = (t: Row): Promise<void> =>
    act('mark this redone', async () => {
      await window.api.work.redo(n(t.id), myId)
      toast.success(`${s(t.title)} — back with the reviewer`)
    })
  const approve = (t: Row): Promise<void> =>
    act('approve this', async () => {
      await window.api.work.approve(n(t.id), myId)
      toast.success(`${s(t.title)} — approved`)
    })
  const say = (t: Row): Promise<void> =>
    act('add that note', async () => {
      const text = s(draft[n(t.id)]).trim()
      if (!text) return
      await window.api.work.note(n(t.id), myId, text)
      setDraft((p) => ({ ...p, [n(t.id)]: '' }))
    })

  function shiftDate(days: number): void {
    // Anchored to UTC throughout — a local Date parsed at midnight and
    // re-read via toISOString() rolls back a day in any timezone ahead of
    // UTC (India included), since local midnight is the PREVIOUS day in UTC.
    // Reading and writing the same UTC fields keeps the shift a plain
    // calendar-day step with no timezone conversion in either direction.
    const base = viewDate || s(data?.date) || new Date().toISOString().slice(0, 10)
    const d = new Date(`${base}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    setViewDate(d.toISOString().slice(0, 10))
  }

  async function confirmSendBack(): Promise<void> {
    if (!sendBack || !sbNote.trim()) return
    await act('send it back', async () => {
      await window.api.work.sendBack(n(sendBack.id), myId, sbNote.trim())
      toast.success(`Sent back to ${s(sendBack.user_name).split(' ')[0]}`)
      setSendBack(null)
      setSbNote('')
    })
  }

  async function confirmAssign(): Promise<void> {
    const lines = (Array.isArray(asForm.lines) ? (asForm.lines as Row[]) : [])
      .map((l) => ({ title: s(l.title).trim(), detail: s(l.detail).trim() }))
      .filter((l) => !!l.title)
    if (!n(asForm.user_id) || !lines.length) return
    await act('assign that', async () => {
      const r = await window.api.work.assign({ ...asForm, lines }, myId)
      const who = users.find((u) => n(u.id) === n(asForm.user_id))
      const cnt = r.ids?.length || lines.length
      toast.success(
        `${cnt === 1 ? 'Assigned' : `${cnt} tasks assigned`} to ${s(who?.name).split(' ')[0] || 'them'} — they have been told`
      )
      setAssignOpen(false)
      setAsForm({ user_id: 0, lines: [{ title: '', detail: '', open: false }], module: 'stock' })
    })
  }

  // THE CATALOGUE'S THREE MOVES.
  //
  // Each reloads everything rather than patching the list in place: adding a
  // line materialises it onto today's boards, switching one off takes it back
  // off them, and both of those are the server's decision to make, not a guess
  // worth rendering.
  const saveProc = async (values: Row): Promise<boolean> => {
    setBusy((b) => b + 1)
    try {
      await window.api.work.saveProcess(values, myId)
      await load(true)
      return true
    } catch (e) {
      toast.error((e as Error).message || 'Could not save that line')
      return false
    } finally {
      setBusy((b) => Math.max(0, b - 1))
    }
  }
  const removeProc = (id: number): Promise<void> =>
    act('remove that line', async () => {
      const r = await window.api.work.removeProcess(id, myId)
      toast.success(
        r.retired
          ? 'Removed from the daily list — the days it was already asked on keep it'
          : 'Removed from the daily list'
      )
    })
  const reorderProcs = (ids: number[]): Promise<void> =>
    act('reorder those', () => window.api.work.reorderProcesses(ids, myId))

  const askForDay = (date: string, reason: string): Promise<void> =>
    act('send that request', async () => {
      await window.api.work.requestDay(date, myId, reason)
      setAskDayOpen(false)
      toast.success(`Asked an admin to open ${formatDate(date)}`)
    })
  const decideDay = (id: number, approve: boolean): Promise<void> =>
    act('answer that request', async () => {
      const r = dayRequests.find((x) => n(x.id) === n(id))
      await window.api.work.decideDay(id, approve, myId)
      toast.success(
        approve
          ? `${formatDate(s(r?.work_date))} opened for ${s(r?.user_name).split(' ')[0] || 'them'}`
          : 'Left closed'
      )
    })

  // The same door, opened from this side. No ask to answer, so no request to
  // find: the admin names the day and the logins, and it is open.
  const setDayOpen = async (ids: number[], date: string, open: boolean, note: string): Promise<boolean> => {
    let done = false
    await act(open ? 'open that day' : 'close that day', async () => {
      const r = await window.api.work.setDayOpen(ids, date, open, myId, note)
      const cnt = open ? r.opened : r.closed
      if (!cnt) throw new Error('Nothing changed — pick at least one login that is not an admin')
      toast.success(
        open
          ? `${formatDate(r.work_date)} is open for ${cnt} ${cnt === 1 ? 'login' : 'logins'}`
          : `${formatDate(r.work_date)} is shut again for ${cnt} ${cnt === 1 ? 'login' : 'logins'}`
      )
      done = true
    })
    return done
  }

  const setSiteCutoff = (at: string, day: 'same' | 'next'): Promise<void> =>
    act('change the cut-off', async () => {
      if (!/^\d{2}:\d{2}$/.test(at)) throw new Error('Give the cut-off as HH:MM')
      await window.api.work.setCutoff(at, myId, day)
      toast.success(`Site cut-off set to ${at}${day === 'next' ? ' the next day' : ''}`)
    })

  const setUserCutoff = (userId: number, at: string, day: string): Promise<void> =>
    act('change that cut-off', async () => {
      const r = await window.api.work.setUserCutoff(userId, at, day, myId)
      const who = s(users.find((u) => n(u.id) === n(userId))?.name).split(' ')[0] || 'that login'
      toast.success(
        r.own
          ? `${who} now closes at ${r.cutoff_day === 'next' ? `${r.cutoff} the next day` : r.cutoff}`
          : `${who} is back on the site cut-off`
      )
    })

  const myGroups = useMemo(() => {
    const by = new Map<string, Row[]>()
    for (const t of mine) {
      const k = s(t.module)
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(t)
    }
    return [...by.entries()].map(([mod, list]) => ({ mod, list }))
  }, [mine])

  const myFixes = mine.filter((t) => t.state === 'fixes').length
  const myApproved = mine.filter((t) => t.state === 'approved').length
  const myNote =
    mine.length === 0
      ? 'Nothing assigned to this login today.'
      : myFixes
        ? `${myFixes} task${myFixes === 1 ? ' was' : 's were'} sent back — fix those first, they are the only ones holding the day open.`
        : mine.every((t) => t.state === 'approved')
          ? 'Everything cleared and approved. Nothing left today.'
          : `${mine.filter((t) => t.state === 'pending').length} still to tick, ${awaiting.filter((t) => n(t.user_id) === myId).length} waiting on review.`

  // The callbacks every task-facing component shares, bundled once per render
  // rather than threaded individually — see the note at the top of the file.
  const ctx: Ctx = {
    myId,
    isAdmin,
    busy,
    cutoffLabel: cutoffLabelOf,
    late,
    overdue,
    openThread,
    draft,
    onToggleThread: (id) => setOpenThread((p) => ({ ...p, [id]: !p[id] })),
    onDraftChange: (id, v) => setDraft((p) => ({ ...p, [id]: v })),
    onTick: (t) => void tick(t),
    onUntick: (t) => void untick(t),
    onApprove: (t) => void approve(t),
    onRedo: (t) => void redo(t),
    onSend: (t) => void say(t),
    onSendBackOpen: (t) => {
      setSendBack(t)
      setSbNote('')
    }
  }

  // TEAM PROGRESS IS ADMIN ONLY. It names every login's outstanding work — who
  // has not started, who was sent back, who is running late — which is not
  // something an ordinary desk needs to see about everybody else's day. The
  // server backs this up: a non-admin's board request now comes back scoped to
  // their own tasks alone, so there is nothing to show even if this tab were
  // forced open.
  const ALL_TABS: { key: Tab; label: string; short: string; count: number; show: boolean }[] = [
    { key: 'mine', label: 'My work', short: 'Mine', count: mine.length, show: true },
    { key: 'review', label: 'Review board', short: 'Review', count: awaiting.length, show: isAdmin },
    { key: 'team', label: 'Team progress', short: 'Team', count: teamUsers.length, show: isAdmin },
    // The list everything else on this page is built from. Last, because it is
    // the setting rather than the day: looked at when something needs changing,
    // not every morning.
    { key: 'list', label: 'Task list', short: 'List', count: procs.filter((x) => x.active).length, show: isAdmin },
    // When each desk's day closes. Its own tab rather than a strip inside
    // Team progress: it is a setting, looked at when a shift changes, and
    // hunting for it behind a person's card is not where anybody would look.
    {
      key: 'cutoffs',
      label: 'Cut-offs',
      short: 'Cut-off',
      count: teamUsers.filter((u) => u.cutoff_own).length,
      show: isAdmin
    }
  ]
  const TABS = ALL_TABS.filter((x) => x.show)

  const body = (compact: boolean): React.JSX.Element => (
    <>
      {tab === 'mine' && (
        <MyWork
          compact={compact}
          mine={mine}
          myApproved={myApproved}
          myFixes={myFixes}
          myNote={myNote}
          inbox={inbox}
          myGroups={myGroups}
          onMarkRead={markRead}
          myRequests={myRequests}
          onAsk={() => setAskDayOpen(true)}
          onOpenDay={(d) => setViewDate(d)}
          closedDay={closedDay}
          ctx={ctx}
        />
      )}
      {tab === 'review' && isAdmin && (
        <ReviewBoard
          compact={compact}
          tasks={tasks}
          awaiting={awaiting}
          stuck={stuck}
          teamUsers={teamUsers}
          revFilter={revFilter}
          onRevFilterChange={setRevFilter}
          openUser={openRevUser}
          onToggleUser={(id) => setOpenRevUser((p) => ({ ...p, [id]: !p[id] }))}
          dayRequests={dayRequests}
          onDecideDay={(id, approve) => void decideDay(id, approve)}
          ctx={ctx}
        />
      )}
      {tab === 'cutoffs' && isAdmin && (
        <CutoffsAdmin
          users={teamUsers}
          siteCutoff={cutoff}
          siteDay={cutoffDay}
          today={openDay}
          dayRequests={dayRequests}
          busy={busy}
          onSetSite={setSiteCutoff}
          onSetUser={setUserCutoff}
          onSetDayOpen={setDayOpen}
        />
      )}
      {tab === 'list' && isAdmin && (
        <TaskListAdmin
          compact={compact}
          procs={procs}
          users={teamUsers}
          busy={busy}
          boardDate={boardDate}
          openDay={openDay}
          onSave={saveProc}
          onRemove={removeProc}
          onReorder={reorderProcs}
        />
      )}
      {tab === 'team' && isAdmin && (
        <TeamProgress
          compact={compact}
          tasks={tasks}
          teamUsers={teamUsers}
          stuck={stuck}
          siteCutoffLabel={cutoffLabel}
          late={late}
          openUser={openUser}
          onToggleUser={(id) => setOpenUser((p) => ({ ...p, [id]: !p[id] }))}
        />
      )}
    </>
  )

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[12.5px] font-semibold text-[#5A6B62]">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading today&rsquo;s board…
      </div>
    )
  }

  // The phone. After every hook, so the hook order cannot change.
  if (isMobile) {
    return (
      <div className="flex min-h-[100dvh] flex-col bg-[#F7FAF6]">
        <div className="flex-none bg-[#0B3D2E] px-4 pb-3 pt-2.5">
          <MobileBar onRefresh={() => load(true)} />
          <div className="text-[20px] font-extrabold tracking-[-0.03em] text-white">Work assignments</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <label className="relative flex items-center gap-1 rounded-full bg-white/[.14] px-2 py-[3px] text-[11px] font-bold text-white">
                {formatDate(s(data?.date))}
                <input
                  type="date"
                  value={viewDate || s(data?.date)}
                  onChange={(e) => setViewDate(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
            ) : (
              <span className="doc-ref text-[11px] font-bold text-white/70">{formatDate(s(data?.date))}</span>
            )}
            {viewDate !== '' && (
              <button
                type="button"
                onClick={() => setViewDate('')}
                className="rounded-full bg-white/[.14] px-2 py-[3px] text-[9.5px] font-extrabold uppercase text-white"
              >
                Today
              </button>
            )}
            {/* Set on the Cut-offs tab; here it is only worth SAYING, and
                only to the person it judges. */}
            {!isAdmin && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.1em]',
                  afterCutoff ? 'bg-[#8C2F26] text-white' : 'bg-white/[.14] text-[#C7F03F]'
                )}
              >
                <Clock className="h-3 w-3" /> cut-off {myCutoffLabel}
                {myCutoff.own && <span className="opacity-70">yours</span>}
              </span>
            )}
            {inbox.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#F0AFAA] px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#4A1512]">
                <BellRing className="h-3 w-3" /> {inbox.length}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-none gap-1 border-b border-b-[#DCE7DB] bg-white px-2">
          {TABS.map((x) => (
            <button
              key={x.key}
              type="button"
              onClick={() => setTab(x.key)}
              className={cn(
                'flex-1 border-b-2 px-2 py-2.5 text-[12px] font-extrabold',
                tab === x.key ? 'border-b-[#C7F03F] text-[#0A1F17]' : 'border-b-transparent text-[#5A6B62]'
              )}
            >
              {x.short}
              <span className="ml-1 text-[10px] font-bold text-[#8CA396]">{x.count}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3">{body(true)}</div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            className="fixed bottom-4 right-4 z-[40] flex h-12 items-center gap-2 rounded-full bg-[#0B3D2E] px-4 text-[12.5px] font-extrabold text-[#C7F03F] shadow-[0_10px_26px_-8px_rgba(10,31,23,.6)]"
          >
            <Plus className="h-5 w-5" /> Assign
          </button>
        )}
        <SendBackDialog
          sendBack={sendBack}
          onClose={() => setSendBack(null)}
          sbNote={sbNote}
          onNoteChange={setSbNote}
          busy={busy}
          onConfirm={() => void confirmSendBack()}
        />
        <DayRequestBox
          open={askDayOpen}
          onClose={() => setAskDayOpen(false)}
          busy={busy}
          boardDate={openDay}
          onSend={(d, why) => askForDay(d, why)}
        />
        <AssignDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          asForm={asForm}
          onFormChange={(patch) => setAsForm((p) => ({ ...p, ...patch }))}
          teamUsers={teamUsers}
          busy={busy}
          onConfirm={() => void confirmAssign()}
          cutoffLabel={cutoffLabelOf}
        />
      </div>
    )
  }

  return (
    <>
      {/* This page builds its own chrome instead of using PageHeader, so it
          has to keep the app's layer ladder by hand: a table head and the
          panel head below stay at or under 20, this sits on 30 with every
          other page header, and the sidebar rail owns 40 above it. */}
      <div className="sticky top-0 z-30 border-b border-b-[#DCE7DB] bg-white px-5 pb-0 pt-4 shadow-[0_1px_0_rgba(10,31,23,.04)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-extrabold tracking-[-0.03em] text-[#0A1F17]">Work assignments</h1>
              {inbox.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#F0D6D4] bg-[#FDF3F2] px-2.5 py-1 text-[10.5px] font-extrabold text-[#8C2F26]">
                  <BellRing className="h-3.5 w-3.5" />
                  {inbox.length} {inbox.length === 1 ? 'note for you' : 'notes for you'}
                </span>
              )}
            </div>
            <p className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">
              {isAdmin
                ? `${awaiting.length} ticked and waiting on you · ${stuck.length} sent back and not answered`
                : 'Your checklist for today, built from the pages you can reach'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <div className="flex h-9 items-center gap-0.5 rounded-[4px] border border-[#C3D2C6] bg-white pl-1 pr-2">
                <button
                  type="button"
                  onClick={() => shiftDate(-1)}
                  className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#5A6B62] hover:bg-[#F7FAF6]"
                  aria-label="Previous day"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <label className="doc-ref relative flex cursor-pointer items-center text-[12px] font-bold text-[#33473E]">
                  {formatDate(s(data?.date))}
                  <input
                    type="date"
                    value={viewDate || s(data?.date)}
                    onChange={(e) => setViewDate(e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => shiftDate(1)}
                  className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#5A6B62] hover:bg-[#F7FAF6]"
                  aria-label="Next day"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                {viewDate !== '' && (
                  <button
                    type="button"
                    onClick={() => setViewDate('')}
                    className="ml-1 rounded-[3px] bg-[#F7FAF6] px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-[#5A6B62] hover:bg-[#EDF3EC]"
                  >
                    Today
                  </button>
                )}
              </div>
            ) : (
              <span className="doc-ref inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#33473E]">
                {formatDate(s(data?.date))}
              </span>
            )}
            {/* THE CUT-OFF LIVES ON ITS OWN TAB NOW.
                An admin sets the site's and each login's there, so a second
                control up here was two doors onto one setting. What is left is
                for everybody else: the deadline they are judged on, said where
                they will see it, and nothing to press. */}
            {!isAdmin && (
              <span
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
                  afterCutoff
                    ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]'
                    : 'border-[#DCE7DB] bg-[#F7FAF6] text-[#33473E]'
                )}
                title={
                  myCutoff.own
                    ? 'This login has a cut-off of its own — an admin sets it on Work assignments.'
                    : 'The cut-off everybody follows.'
                }
              >
                <Clock className="h-4 w-4" /> Cut-off {myCutoffLabel}
                {myCutoff.own && (
                  <span className="text-[10px] font-extrabold uppercase tracking-[.08em] opacity-60">yours</span>
                )}
              </span>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => setAssignOpen(true)}
                className="flex h-9 items-center gap-1.5 rounded-[4px] bg-[#C7F03F] px-3 text-[12px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F]"
              >
                <Plus className="h-4 w-4" /> Assign a task
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {TABS.map((x) => {
            const on = tab === x.key
            const Ico =
              x.key === 'mine'
                ? ListChecks
                : x.key === 'review'
                  ? ClipboardList
                  : x.key === 'team'
                    ? Users
                    : x.key === 'list'
                      ? ListPlus
                      : Clock
            return (
              <button
                key={x.key}
                type="button"
                onClick={() => setTab(x.key)}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-[12.5px] font-extrabold',
                  on ? 'border-b-[#C7F03F] text-[#0A1F17]' : 'border-b-transparent text-[#5A6B62] hover:text-[#0A1F17]'
                )}
              >
                <Ico className="h-4 w-4" />
                {x.label}
                <span
                  className={cn(
                    'doc-ref rounded-[2px] px-1.5 text-[10px] font-bold',
                    on ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#33473E]'
                  )}
                >
                  {x.count}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="px-5 py-4">{body(false)}</div>
      <SendBackDialog
        sendBack={sendBack}
        onClose={() => setSendBack(null)}
        sbNote={sbNote}
        onNoteChange={setSbNote}
        busy={busy}
        onConfirm={() => void confirmSendBack()}
      />
      <DayRequestBox
        open={askDayOpen}
        onClose={() => setAskDayOpen(false)}
        busy={busy}
        boardDate={openDay}
        onSend={(d, why) => askForDay(d, why)}
      />
      <AssignDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        asForm={asForm}
        onFormChange={(patch) => setAsForm((p) => ({ ...p, ...patch }))}
        teamUsers={teamUsers}
        busy={busy}
        onConfirm={() => void confirmAssign()}
        cutoffLabel={cutoffLabelOf}
      />
    </>
  )
}
