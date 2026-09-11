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
  ClipboardList,
  Clock,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  ShieldQuestion,
  Undo2,
  Users,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { MobileBar } from '@/components/MobileBar'
import { MODULES } from '@/lib/modules'
import { formatDate } from '@/lib/format'
import { loadUser } from '@/lib/session'
import { useIsMobile } from '@/lib/useIsMobile'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

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

type Tab = 'mine' | 'review' | 'team'

// Everything a task card or a thread needs, in one bundle — see the note at
// the top of the file for why these had to stop being closures.
type Ctx = {
  myId: number
  isAdmin: boolean
  busy: number
  cutoff: string
  late: (at: unknown) => boolean
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
                ctx.late(t.marked_at) ? 'text-[#B3261E]' : 'text-[#8CA396]'
              )}
            >
              <Clock className="h-3.5 w-3.5" />
              {t.marked_at
                ? `ticked ${s(t.marked_at)}${ctx.late(t.marked_at) ? ' · after cut-off' : ''}`
                : `due by ${ctx.cutoff}`}
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
function MyWork({
  compact,
  mine,
  myApproved,
  myFixes,
  myNote,
  inbox,
  myGroups,
  onMarkRead,
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
  ctx: Ctx
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
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
  revFilter,
  onRevFilterChange,
  ctx
}: {
  compact?: boolean
  tasks: Row[]
  awaiting: Row[]
  stuck: Row[]
  revFilter: 'review' | 'fixes' | 'pending' | 'all'
  onRevFilterChange: (k: 'review' | 'fixes' | 'pending' | 'all') => void
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
  return (
    <div className="flex flex-col gap-3">
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

      {activeFilter.list.length === 0 ? (
        <div className="rounded-[5px] border border-dashed border-[#C3D2C6] bg-white px-6 py-10 text-center">
          <CheckCheck className="mx-auto h-7 w-7 text-[#C3D2C6]" />
          <p className="mt-2 text-[12.5px] font-extrabold text-[#33473E]">Nothing in this filter.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {activeFilter.list.map((t) => (
            <div key={t.id} className="overflow-hidden rounded-[4px] border border-[#DCE7DB] bg-white">
              <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
                <Avatar name={s(t.user_name)} size={30} />
                <div className="min-w-0 flex-[1_1_150px]">
                  <div className="truncate text-[12.5px] font-extrabold text-[#0A1F17]">{s(t.user_name)}</div>
                  <div className="text-[10.5px] font-semibold text-[#8CA396]">{pageLabel(s(t.module))}</div>
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
                    ctx.late(t.marked_at) ? 'text-[#B3261E]' : 'text-[#5A6B62]'
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
}

// ------------------------------------------------------- team progress ------
// Admin only — see the note above the tab list in WorkAssignments() for why.
function TeamProgress({
  compact,
  tasks,
  teamUsers,
  stuck,
  cutoff,
  late,
  openUser,
  onToggleUser
}: {
  compact?: boolean
  tasks: Row[]
  teamUsers: Row[]
  stuck: Row[]
  cutoff: string
  late: (at: unknown) => boolean
  openUser: Record<number, boolean>
  onToggleUser: (id: number) => void
}): React.JSX.Element {
  const approved = tasks.filter((t) => t.state === 'approved').length
  const lateN = tasks.filter((t) => late(t.marked_at)).length
  return (
    <div className="flex flex-col gap-3">
      <div className={cn('grid gap-2.5', compact ? 'grid-cols-2' : 'grid-cols-4')}>
        {(
          [
            ['Tasks today', String(tasks.length), `across ${teamUsers.length} ${teamUsers.length === 1 ? 'person' : 'people'}`, '#0A1F17'],
            ['Cleared', `${tasks.length ? Math.round((approved / tasks.length) * 100) : 0}%`, `${approved} approved of ${tasks.length}`, '#0B6B45'],
            ['Sent back', String(stuck.length), 'work that needed a correction', '#B3261E'],
            ['After cut-off', String(lateN), `ticked later than ${cutoff}`, '#8A5300']
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
                <div className="mt-1.5 text-[10.5px] font-semibold text-[#5A6B62]">
                  {list.filter((t) => t.state === 'approved').length} approved ·{' '}
                  {list.filter((t) => t.state === 'done' || t.state === 'redone').length} in review · {fixes} needing
                  fixes · {list.filter((t) => t.state === 'pending').length} not started
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
  cutoff
}: {
  open: boolean
  onClose: () => void
  asForm: Row
  onFormChange: (patch: Row) => void
  teamUsers: Row[]
  busy: number
  onConfirm: () => void
  cutoff: string
}): React.JSX.Element | null {
  if (!open) return null
  const ready = n(asForm.user_id) > 0 && s(asForm.title).trim().length > 0
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
          <div className="mt-1.5 flex flex-col gap-1.5">
            {teamUsers.map((u) => {
              const on = n(asForm.user_id) === n(u.id)
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onFormChange({ user_id: n(u.id) })}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[4px] border px-3 py-2 text-left',
                    on ? 'border-[#0B3D2E] bg-[#F1F5EF]' : 'border-[#DCE7DB] bg-white hover:bg-[#F7FAF6]'
                  )}
                >
                  <Avatar name={s(u.name)} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-extrabold text-[#0A1F17]">{s(u.name)}</span>
                    <span className="block text-[10.5px] font-semibold text-[#8CA396]">
                      {Array.isArray(u.grants) ? `${(u.grants as string[]).length} pages` : s(u.role)}
                    </span>
                  </span>
                  {on && <Check className="h-4 w-4 flex-none text-[#0B6B45]" />}
                </button>
              )
            })}
          </div>

          <label className="mt-3 block text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            What to do <span className="text-[#B3261E]">*</span>
          </label>
          <input
            value={s(asForm.title)}
            onChange={(e) => onFormChange({ title: e.target.value })}
            maxLength={300}
            placeholder="Recount tank 4 against the dip book"
            className="mt-1.5 h-10 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12.5px] font-semibold outline-none placeholder:font-medium placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
          />
          <label className="mt-3 block text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
            Detail
          </label>
          <textarea
            rows={2}
            value={s(asForm.detail)}
            onChange={(e) => onFormChange({ detail: e.target.value })}
            placeholder="Anything they need to know to do it."
            className="mt-1.5 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 py-2.5 text-[12.5px] font-medium leading-[1.55] outline-none placeholder:text-[#A9BCB0] focus:border-[#0B3D2E]"
          />
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
            <Clock className="h-3.5 w-3.5" /> Due by {cutoff} today, like everything else on the board.
          </p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] px-[22px] py-4">
          <span
            className="min-w-0 flex-1 text-[11.5px] font-semibold"
            style={{ color: ready ? '#0B6B45' : '#8A5300' }}
          >
            {ready ? 'Ready to assign.' : 'Pick who it is for and say what needs doing.'}
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
            <Plus className="h-4 w-4" /> ASSIGN
          </button>
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
  const [revFilter, setRevFilter] = useState<'review' | 'fixes' | 'pending' | 'all'>('review')

  const [sendBack, setSendBack] = useState<Row | null>(null)
  const [sbNote, setSbNote] = useState('')
  const [assignOpen, setAssignOpen] = useState(false)
  const [asForm, setAsForm] = useState<Row>({ user_id: 0, title: '', detail: '', module: 'stock' })

  // Which day's board is on screen. Empty means "today" — the server's own
  // default — so an ordinary login (who never sees the picker) always reads
  // as today with no extra state to keep in sync. Only an admin can set this
  // to anything else; the server still enforces that day's own data, since
  // ensureDay only ever materialises TODAY's tasks and simply reads back
  // whatever already exists for any other date.
  const [viewDate, setViewDate] = useState('')
  const [cutoffDraft, setCutoffDraft] = useState<string | null>(null)

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
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [myId, viewDate]
  )
  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const tasks: Row[] = useMemo(() => (Array.isArray(data?.tasks) ? (data?.tasks as Row[]) : []), [data])
  const users: Row[] = useMemo(() => (Array.isArray(data?.users) ? (data?.users as Row[]) : []), [data])
  const cutoff = s(data?.cutoff) || '18:30'
  const now = s(data?.now)
  const afterCutoff = !!now && now > cutoff
  const late = useCallback((at: unknown): boolean => !!s(at) && s(at) > cutoff, [cutoff])

  const mine = useMemo(() => tasks.filter((t) => n(t.user_id) === myId), [tasks, myId])
  const awaiting = useMemo(() => tasks.filter((t) => t.state === 'done' || t.state === 'redone'), [tasks])
  const stuck = useMemo(() => tasks.filter((t) => t.state === 'fixes'), [tasks])
  const teamUsers = useMemo(() => users.filter((u) => u.active && u.grants !== 'ALL'), [users])

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

  async function saveCutoff(): Promise<void> {
    const v = s(cutoffDraft).trim()
    if (!/^\d{2}:\d{2}$/.test(v)) return
    await act('change the cut-off', async () => {
      await window.api.work.setCutoff(v, myId)
      toast.success(`Cut-off set to ${v}`)
      setCutoffDraft(null)
    })
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
    if (!n(asForm.user_id) || !s(asForm.title).trim()) return
    await act('assign that', async () => {
      await window.api.work.assign(asForm, myId)
      const who = users.find((u) => n(u.id) === n(asForm.user_id))
      toast.success(`Assigned to ${s(who?.name).split(' ')[0] || 'them'}`)
      setAssignOpen(false)
      setAsForm({ user_id: 0, title: '', detail: '', module: 'stock' })
    })
  }

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
    cutoff,
    late,
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
    { key: 'team', label: 'Team progress', short: 'Team', count: teamUsers.length, show: isAdmin }
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
          ctx={ctx}
        />
      )}
      {tab === 'review' && isAdmin && (
        <ReviewBoard
          compact={compact}
          tasks={tasks}
          awaiting={awaiting}
          stuck={stuck}
          revFilter={revFilter}
          onRevFilterChange={setRevFilter}
          ctx={ctx}
        />
      )}
      {tab === 'team' && isAdmin && (
        <TeamProgress
          compact={compact}
          tasks={tasks}
          teamUsers={teamUsers}
          stuck={stuck}
          cutoff={cutoff}
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
            {isAdmin && cutoffDraft !== null ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/[.14] px-2 py-[3px]">
                <input
                  type="time"
                  value={cutoffDraft}
                  onChange={(e) => setCutoffDraft(e.target.value)}
                  className="h-[16px] w-[72px] bg-transparent text-[10px] font-extrabold text-white outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={busy > 0}
                  onClick={() => void saveCutoff()}
                  className="rounded-full bg-[#C7F03F] px-1.5 text-[9px] font-extrabold text-[#0B3D2E]"
                >
                  Save
                </button>
                <button type="button" onClick={() => setCutoffDraft(null)} className="text-white/70">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <span
                onClick={() => isAdmin && setCutoffDraft(cutoff)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.1em]',
                  afterCutoff ? 'bg-[#8C2F26] text-white' : 'bg-white/[.14] text-[#C7F03F]'
                )}
              >
                <Clock className="h-3 w-3" /> cut-off {cutoff}
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
        <AssignDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          asForm={asForm}
          onFormChange={(patch) => setAsForm((p) => ({ ...p, ...patch }))}
          teamUsers={teamUsers}
          busy={busy}
          onConfirm={() => void confirmAssign()}
          cutoff={cutoff}
        />
      </div>
    )
  }

  return (
    <>
      <div className="border-b border-b-[#DCE7DB] bg-white px-5 pb-0 pt-4">
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
            {isAdmin && cutoffDraft !== null ? (
              <div className="flex h-9 items-center gap-1.5 rounded-[4px] border border-[#C3D2C6] bg-white px-2">
                <Clock className="h-4 w-4 text-[#5A6B62]" />
                <input
                  type="time"
                  value={cutoffDraft}
                  onChange={(e) => setCutoffDraft(e.target.value)}
                  className="h-full w-[92px] text-[12px] font-bold text-[#33473E] outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={busy > 0}
                  onClick={() => void saveCutoff()}
                  className="rounded-[3px] bg-[#C7F03F] px-2 py-1 text-[10.5px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F] disabled:opacity-60"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setCutoffDraft(null)}
                  className="rounded-[3px] px-1.5 py-1 text-[10.5px] font-bold text-[#5A6B62] hover:bg-[#F7FAF6]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <span
                onClick={() => isAdmin && setCutoffDraft(cutoff)}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
                  isAdmin && 'cursor-pointer hover:brightness-95',
                  afterCutoff
                    ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]'
                    : 'border-[#DCE7DB] bg-[#F7FAF6] text-[#33473E]'
                )}
                title={isAdmin ? 'Click to change the cut-off' : undefined}
              >
                <Clock className="h-4 w-4" /> Cut-off {cutoff}
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
            const Ico = x.key === 'mine' ? ListChecks : x.key === 'review' ? ClipboardList : Users
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
      <AssignDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        asForm={asForm}
        onFormChange={(patch) => setAsForm((p) => ({ ...p, ...patch }))}
        teamUsers={teamUsers}
        busy={busy}
        onConfirm={() => void confirmAssign()}
        cutoff={cutoff}
      />
    </>
  )
}
