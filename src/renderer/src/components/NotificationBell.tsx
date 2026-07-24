import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Check, ClipboardCheck, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppUser } from '@/lib/session'
import { formatDate } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface NoteItem {
  key: string
  kind: 'pending' | 'approved' | 'rejected'
  title: string
  detail: string
  when: string
}

const SEEN_KEY = 'rishabhoil.notifSeen'
const MUTE_KEY = 'rishabhoil.notifMuted'
const TABLE_LABEL: Record<string, string> = {
  oil_types: 'Oil type', products: 'Product', suppliers: 'Supplier', transporters: 'Transporter',
  customers: 'Customer', sources: 'Port', uoms: 'UOM', brokers: 'Broker', packagings: 'Packed SKU'
}
const labelFor = (t: string): string => TABLE_LABEL[t] || t

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
function saveSeen(s: Set<string>): void {
  // keep it bounded so it can't grow forever
  const arr = Array.from(s).slice(-400)
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr))
}

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
  const [seen, setSeen] = useState<Set<string>>(loadSeen)
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  const prevKeys = useRef<Set<string>>(new Set())
  const first = useRef(true)
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      if (isAdmin) {
        const reqs = await window.api.approvals.list()
        // Admins are notified of things still waiting on them.
        setItems(
          reqs
            .filter((r: Row) => r.status === 'pending')
            .map((r: Row) => ({
              key: `p:${r.id}`,
              kind: 'pending' as const,
              title: `New ${labelFor(r.table_name)} to approve`,
              detail: `${r.label || '—'} · by ${r.requested_by_name || 'user'}`,
              when: r.requested_at
            }))
        )
      } else {
        const reqs = await window.api.approvals.mine()
        // Users are notified when their submissions get decided.
        setItems(
          reqs
            .filter((r: Row) => r.status !== 'pending')
            .map((r: Row) => ({
              key: `d:${r.id}:${r.status}`,
              kind: r.status as 'approved' | 'rejected',
              title: r.status === 'approved'
                ? `${labelFor(r.table_name)} approved`
                : `${labelFor(r.table_name)} rejected`,
              detail: r.status === 'rejected' ? `${r.label || '—'} — ${r.reason || 'no reason'}` : (r.label || '—'),
              when: r.decided_at || r.requested_at
            }))
        )
      }
    } catch {
      // ignore transient errors
    }
  }, [isAdmin])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Ring when a genuinely new (unseen, not previously present) notification arrives.
  useEffect(() => {
    const keys = items.map((i) => i.key)
    if (!first.current) {
      const isNew = keys.some((k) => !prevKeys.current.has(k) && !seen.has(k))
      if (isNew && !muted) playChime()
    }
    prevKeys.current = new Set(keys)
    first.current = false
  }, [items, seen, muted])

  // Close the panel on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const unseen = items.filter((i) => !seen.has(i.key))

  function openPanel(): void {
    setOpen((o) => !o)
    if (!open) {
      // opening marks everything currently shown as seen
      const next = new Set(seen)
      items.forEach((i) => next.add(i.key))
      setSeen(next)
      saveSeen(next)
    }
  }

  function toggleMute(): void {
    setMuted((m) => {
      localStorage.setItem(MUTE_KEY, m ? '0' : '1')
      return !m
    })
  }

  return (
    <div ref={wrapRef} className="fixed right-4 top-4 z-40">
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
        <div className="absolute right-0 mt-2 w-80 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button onClick={toggleMute} title={muted ? 'Unmute sound' : 'Mute sound'} className="text-muted-foreground hover:text-foreground">
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">You&apos;re all caught up.</div>
            ) : (
              items.slice(0, 30).map((it) => (
                <button
                  key={it.key}
                  onClick={() => { onNavigate('approvals'); setOpen(false) }}
                  className="flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent/50"
                >
                  <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    it.kind === 'approved' ? 'bg-emerald-100 text-emerald-700'
                    : it.kind === 'rejected' ? 'bg-red-100 text-red-600'
                    : 'bg-amber-100 text-amber-700')}>
                    {it.kind === 'approved' ? <Check className="h-3.5 w-3.5" /> : it.kind === 'rejected' ? <X className="h-3.5 w-3.5" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{it.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{it.detail}</span>
                    <span className="block text-[11px] text-muted-foreground/70">{formatDate(it.when)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            onClick={() => { onNavigate('approvals'); setOpen(false) }}
            className="w-full border-t bg-muted/30 px-3 py-2 text-center text-xs font-medium text-primary hover:bg-muted"
          >
            Open Approvals
          </button>
        </div>
      )}
    </div>
  )
}
