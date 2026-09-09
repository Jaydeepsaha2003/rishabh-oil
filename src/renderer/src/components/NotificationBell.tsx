import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, Check, ClipboardCheck, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppUser } from '@/lib/session'
import { formatDate } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface NoteItem {
  /** The notification's row id — read state lives on the server against it. */
  id: number
  key: string
  severity: 'critical' | 'warning' | 'normal'
  title: string
  detail: string
  when: string
  page: string
  read: boolean
}

// The read state used to live here, in a localStorage list of keys capped at
// 400. It was per BROWSER rather than per person, so the same user signing in
// on another machine saw everything again; it could only ever grow; and there
// was no way back — once a key was in the list the notification was read
// forever. It is a row per user per notification on the server now, which
// fixes all three and is what makes "mark unread" possible.
const MUTE_KEY = 'rishabhoil.notifMuted'
const TABLE_LABEL: Record<string, string> = {
  oil_types: 'Oil type', products: 'Product', suppliers: 'Supplier', transporters: 'Transporter',
  customers: 'Customer', sources: 'Port', uoms: 'UOM', brokers: 'Broker', packagings: 'Packed SKU'
}
const labelFor = (t: string): string => TABLE_LABEL[t] || t

// A short two-tone chime via the Web Audio API — no asset, CSP-safe.
function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const now = ctx.currentTime
    ;[880, 1174].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = now + i * 0.15
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.24)
    })
    setTimeout(() => ctx.close().catch(() => {}), 800)
  } catch {
    // audio not available — silently ignore
  }
}

interface Props {
  user: AppUser
  onNavigate: (page: string) => void
}

export function NotificationBell({ user, onNavigate }: Props): React.JSX.Element {
  const isAdmin = user.role === 'admin'
  const [items, setItems] = useState<NoteItem[]>([])
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  const prevKeys = useRef<Set<string>>(new Set())
  const first = useRef(true)
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const rows = await window.api.notify.list(Number(user.id) || 0, isAdmin, 30)
      setItems(
        rows.map((r: Row) => ({
          id: Number(r.id),
          key: String(r.dedupe_key || r.id),
          severity: (String(r.severity) as NoteItem['severity']) || 'normal',
          title: String(r.title || ''),
          detail: String(r.body || ''),
          when: String(r.created_at || ''),
          page: String(r.page || 'approvals'),
          read: !!r.is_read
        }))
      )
    } catch {
      // ignore transient errors
    }
  }, [user.id, isAdmin])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Ring when a genuinely new (unseen, not previously present) notification arrives.
  useEffect(() => {
    const keys = items.map((i) => i.key)
    if (!first.current) {
      const isNew = items.some((i) => !prevKeys.current.has(i.key) && !i.read)
      if (isNew && !muted) playChime()
    }
    prevKeys.current = new Set(keys)
    first.current = false
  }, [items, muted])

  // Close the panel on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const unseen = items.filter((i) => !i.read)

  // Opening the panel no longer marks anything read.
  //
  // It used to mark everything shown the moment the bell was clicked, which is
  // how the old localStorage list worked and is also why a "mark as read"
  // button was impossible — by the time you could see one, there was nothing
  // left to mark. Read is an action now: open a notification and it is read,
  // tick one, or clear the lot. The badge means "not yet dealt with", which is
  // what a badge is for.
  function openPanel(): void {
    setOpen((o) => !o)
  }

  async function markRead(ids: number[]): Promise<void> {
    if (!ids.length) return
    setItems((p) => p.map((i) => (ids.includes(i.id) ? { ...i, read: true } : i)))
    await window.api.notify.markRead(Number(user.id) || 0, ids).catch(() => load())
  }

  async function putBack(id: number): Promise<void> {
    setItems((p) => p.map((i) => (i.id === id ? { ...i, read: false } : i)))
    await window.api.notify.markUnread(Number(user.id) || 0, id).catch(() => load())
  }

  function openItem(it: NoteItem): void {
    // Going to look at it IS reading it.
    if (!it.read) void markRead([it.id])
    onNavigate(it.page)
    setOpen(false)
  }

  function toggleMute(): void {
    setMuted((m) => {
      localStorage.setItem(MUTE_KEY, m ? '0' : '1')
      return !m
    })
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={openPanel}
        title="Notifications"
        className="relative flex h-10 w-10 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
      >
        <Bell className="h-5 w-5" />
        {unseen.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
            {unseen.length > 99 ? '99+' : unseen.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[22rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="text-sm font-semibold">
              Notifications
              {unseen.length > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">{unseen.length} unread</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              {unseen.length > 0 && (
                <button
                  onClick={() => void markRead(unseen.map((i) => i.id))}
                  title="Mark every notification shown here as read"
                  className="!h-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-muted"
                >
                  Mark all read
                </button>
              )}
              <button onClick={toggleMute} title={muted ? 'Unmute sound' : 'Mute sound'} className="!h-auto text-muted-foreground hover:text-foreground">
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">You&apos;re all caught up.</div>
            ) : (
              items.slice(0, 30).map((it) => (
                <div
                  key={it.key}
                  className={cn(
                    'group flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent/50',
                    // The severity is the left edge, so a critical row is
                    // findable in a list of thirty without reading any of it.
                    __WEB__ && 'border-l-[3px]',
                    __WEB__ && (it.severity === 'critical' ? 'border-l-[#B3261E]'
                      : it.severity === 'warning' ? 'border-l-[#C2700A]' : 'border-l-[#12855A]')
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openItem(it)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openItem(it)
                      }
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
                  >
                    <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                      it.severity === 'critical' ? 'bg-red-100 text-red-600'
                      : it.severity === 'warning' ? 'bg-amber-100 text-amber-700'
                      : 'bg-emerald-100 text-emerald-700')}>
                      {it.severity === 'critical' ? <AlertTriangle className="h-3.5 w-3.5" />
                        : it.severity === 'warning' ? <ClipboardCheck className="h-3.5 w-3.5" />
                        : <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-[13px] leading-[1.35]', it.read ? 'font-normal text-muted-foreground' : 'font-semibold')}>
                        {it.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11.5px] leading-[1.35] text-muted-foreground">
                        {it.detail}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] leading-none text-muted-foreground/70">
                        {formatDate(it.when)}
                      </span>
                    </span>
                  </div>
                  {/* One control, two directions. Unread shows a tick that
                      marks it read WITHOUT opening it — for the ones you have
                      taken in from the list and do not need to visit. Read
                      shows the way back. */}
                  <div
                    role="button"
                    tabIndex={0}
                    title={it.read ? 'Mark as unread' : 'Mark as read'}
                    onClick={(e) => { e.stopPropagation(); void (it.read ? putBack(it.id) : markRead([it.id])) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void (it.read ? putBack(it.id) : markRead([it.id]))
                      }
                    }}
                    className={cn(
                      'mt-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent',
                      it.read
                        ? 'text-muted-foreground opacity-0 group-hover:opacity-100'
                        : 'text-emerald-700 hover:text-emerald-800'
                    )}
                  >
                    {it.read ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  </div>
                </div>
              ))
            )}
          </div>
          <button
            onClick={() => { onNavigate('notifications'); setOpen(false) }}
            className="w-full border-t bg-muted/30 px-3 py-2 text-center text-xs font-medium text-primary hover:bg-muted"
          >
            Notification settings
          </button>
        </div>
      )}
    </div>
  )
}
