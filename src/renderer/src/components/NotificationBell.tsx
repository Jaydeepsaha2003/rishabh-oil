import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Bell, BellRing, Check, ClipboardCheck, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
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
// POP-UPS ON THIS DEVICE — the system banners, separately from the chime.
// '0' is off. Unset, it follows the old mute: someone who muted to be rid of
// the banners (mute used to silence both) does not suddenly get them back.
const POPUP_KEY = 'rishabhoil.notifPopups'
function readPopups(): boolean {
  try {
    const v = localStorage.getItem(POPUP_KEY)
    if (v === '0') return false
    if (v === '1') return true
    return localStorage.getItem(MUTE_KEY) !== '1'
  } catch {
    return true
  }
}

// Off on this device: the server stops pushing to it, and the browser forgets
// the subscription, so nothing pops up with the app closed either.
async function unsubscribeDevice(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = reg ? await reg.pushManager?.getSubscription() : null
    if (!sub) return
    await window.api.push.unsubscribe(sub.endpoint).catch(() => undefined)
    await sub.unsubscribe().catch(() => undefined)
  } catch {
    /* nothing subscribed here, or nothing to be done */
  }
}
const TABLE_LABEL: Record<string, string> = {
  oil_types: 'Oil type', products: 'Product', suppliers: 'Supplier', transporters: 'Transporter',
  customers: 'Customer', sources: 'Port', uoms: 'UOM', brokers: 'Broker', packagings: 'Packed SKU'
}
const labelFor = (t: string): string => TABLE_LABEL[t] || t

// A short two-tone chime via the Web Audio API — no asset, CSP-safe.
//
// LOUDER THAN IT WAS. At 0.2 it was under the room: an oil mill's office is
// not a quiet place and a notification nobody hears is not a notification.
// 0.55 is still a chime rather than an alarm, and it is the peak of a 220ms
// envelope, not a sustained tone.
const CHIME_GAIN = 0.55

// The browser will not start audio until the page has been touched.
//
// Every tab starts its AudioContext 'suspended' and only a real user gesture
// resumes it — which is why the chime worked on a desktop that had been
// clicked around and was silent on a phone that had only been scrolled. One
// context, unlocked by the first gesture of any kind and kept for the session,
// rather than a new one per chime that is born suspended every time.
let audioCtx: AudioContext | null = null
function getCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {})
    return audioCtx
  } catch {
    return null
  }
}
if (typeof window !== 'undefined') {
  const unlock = (): void => {
    getCtx()
  }
  // `once` per event: the first tap, click or key of the session is enough.
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, unlock, { once: true, passive: true })
  }
}

function playChime(): void {
  try {
    const ctx = getCtx()
    if (!ctx) return
    const now = ctx.currentTime
    ;[880, 1174].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = now + i * 0.15
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(CHIME_GAIN, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.24)
    })
    // The context is NOT closed — it is the session's one context, and closing
    // it would mean the next chime starts suspended again.
  } catch {
    // audio not available — silently ignore
  }
}

// THE PHONE'S OWN NOTIFICATION.
//
// A chime is the wrong instrument on a phone: the screen is usually off or on
// another app, and a tone from a background tab is either blocked or missed.
// What a phone does well is its own notification — the system sound, the
// banner, the vibration the owner has already chosen. That needs permission,
// which is why there is an Enable control in the panel.
//
// Android requires it to come from the service worker registration rather than
// `new Notification()`, which throws an "Illegal constructor" there; the plain
// constructor is the desktop fallback.
async function systemNotify(title: string, body: string, tag: string): Promise<boolean> {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    const opts: NotificationOptions = {
      body,
      tag,
      icon: '/brand-default.png',
      badge: '/brand-default.png'
    }
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg) {
        await reg.showNotification(title, opts)
        return true
      }
    }
    new Notification(title, opts)
    return true
  } catch {
    return false
  }
}

// SUBSCRIBING THE DEVICE.
//
// Permission alone only buys a banner while the page is open — which on a
// phone is almost never. A SUBSCRIPTION is what lets the server reach the
// device with the app closed: the browser mints an endpoint at its own push
// service, and we hand that endpoint back for the server to post to.
//
// Idempotent: a device already subscribed returns the same endpoint, and the
// server's insert updates the row rather than adding a second.
type SubResult = { ok: boolean; why: string }

async function subscribeDevice(userId: number): Promise<SubResult> {
  // WHY IT FAILED, NOT MERELY THAT IT DID.
  //
  // Every one of these has a different answer for the person holding the
  // phone — allow the permission, open it from the Home Screen, wait for the
  // worker — and a bare false tells them none of them. This is the screen
  // somebody lands on when notifications are not arriving, so it has to say
  // which of the five things is wrong.
  if (!('serviceWorker' in navigator)) return { ok: false, why: 'This browser has no service worker, so it cannot be reached with the app closed.' }
  if (!('PushManager' in window)) {
    return {
      ok: false,
      why: 'This browser cannot receive push. On an iPhone, add the site to the Home Screen and open it from there.'
    }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { ok: false, why: 'Notifications are not allowed on this device yet.' }
  }
  try {
    // navigator.serviceWorker.ready never settles when registration was
    // blocked — by a private window, an enterprise policy, or plain http. Left
    // unbounded it hangs the button for ever with nothing said.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
    ])
    if (!reg) {
      return {
        ok: false,
        why: 'The service worker has not started. Reload the page once, and check the site is on https — push does not work over plain http.'
      }
    }
    const { key } = await window.api.push.key()
    if (!key) return { ok: false, why: 'The server has no push key yet. Restart it and try again.' }
    const existing = await reg.pushManager.getSubscription()
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // The raw key the browser wants, as bytes rather than base64url.
        applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0)
        )
      }))
    await window.api.push.subscribe(sub.toJSON() as unknown as Record<string, unknown>, userId, navigator.userAgent)
    return { ok: true, why: '' }
  } catch (e) {
    // Android's own refusals land here — most often a Chrome that cannot reach
    // its push service at all, which is a device-level block rather than
    // anything this site can change.
    return { ok: false, why: `This device refused the subscription: ${(e as Error).message}` }
  }
}

interface Props {
  user: AppUser
  onNavigate: (page: string) => void
  /**
   * Drawn for a phone's top bar rather than a desktop header: a square that
   * matches the other controls on that bar, and a panel that is a sheet
   * across the screen instead of a dropdown hanging off the button. A 22rem
   * dropdown anchored to a 34px button on a 375px screen hangs off the edge.
   */
  mobile?: boolean
}

export function NotificationBell({ user, onNavigate, mobile }: Props): React.JSX.Element {
  const isAdmin = user.role === 'admin'
  const [items, setItems] = useState<NoteItem[]>([])
  const [open, setOpen] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  const [popups, setPopupsState] = useState(readPopups)
  // 'default' means never asked, which is the state a phone arrives in — and
  // the reason nothing was ever heard there.
  // Whether this device can be reached with the app closed.
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [bcOpen, setBcOpen] = useState(false)
  const [bcTitle, setBcTitle] = useState('')
  const [bcBody, setBcBody] = useState('')
  const [perm, setPerm] = useState<string>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )
  const prevKeys = useRef<Set<string>>(new Set())
  const first = useRef(true)
  const wrapRef = useRef<HTMLDivElement>(null)
  // The panel's own node. Once it is portaled out of the bell it is no longer
  // INSIDE wrapRef, so the outside-click handler has to be told about it
  // separately or the first tap on the panel closes it.
  const panelRef = useRef<HTMLDivElement>(null)
  const [sheetTop, setSheetTop] = useState(60)
  // WHERE THE DESKTOP PANEL HANGS.
  //
  // It used to be `absolute` inside the bell's own wrapper, which makes it a
  // child of whatever the page has built around the header — and a child can
  // be clipped by an `overflow: hidden` two levels up, or trapped underneath
  // the page by any ancestor that starts a stacking context. Measured and
  // fixed instead, portaled out to the body: there is no ancestor left to
  // clip it or paint over it, on any page, whatever that page does.
  const [anchor, setAnchor] = useState<{ top: number; right: number }>({ top: 60, right: 16 })
  const place = useCallback((): void => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) })
  }, [])

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
  // Silent, and only where permission is already given: no prompt is raised
  // here. It catches the device that said yes before push existed, and the one
  // whose endpoint the browser has since rotated.
  useEffect(() => {
    if (perm !== 'granted' || !popups) return
    let alive = true
    void subscribeDevice(Number(user.id) || 0).then((r) => {
      if (alive) setSubscribed(r.ok)
    })
    return () => {
      alive = false
    }
  }, [perm, user.id, popups])
  useLiveRefresh(load)

  // Ring when a genuinely new (unseen, not previously present) notification
  // arrives — as the phone's own notification where that has been allowed,
  // and as the chime otherwise. Both, on a desktop that has granted it: the
  // banner is what you see, the chime is what you hear.
  useEffect(() => {
    const keys = items.map((i) => i.key)
    if (!first.current) {
      const fresh = items.filter((i) => !prevKeys.current.has(i.key) && !i.read)
      if (fresh.length && popups) {
        const one = fresh[0]
        void systemNotify(
          fresh.length === 1 ? one.title : `${fresh.length} new notifications`,
          fresh.length === 1 ? one.detail : fresh.map((i) => i.title).join(' · '),
          fresh.length === 1 ? one.key : 'rishabhoil-batch'
        ).then((shown) => {
          // The system sound IS the sound when the phone has taken it over;
          // chiming as well would be two noises for one event.
          if (!shown && !muted) playChime()
        })
      } else if (fresh.length && !muted) {
        // Pop-ups off: the bell fills in and chimes, and nothing pops up.
        playChime()
      }
    }
    prevKeys.current = new Set(keys)
    first.current = false
  }, [items, muted, popups])

  // A fixed panel is placed against the viewport, so it has to be re-placed
  // when the viewport moves under it. Capture phase, because the bar it hangs
  // off may itself be inside a scrolling pane rather than on the window.
  useEffect(() => {
    if (!open || mobile) return
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, mobile, place])

  // Close the panel on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event): void => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
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
    // On a phone the panel is a sheet across the screen rather than a dropdown
    // hanging off a 40px button, so it needs to know where the button ENDS.
    // Measured rather than guessed: this bar sits at a different height on
    // each page, and a hard-coded offset would float or overlap on most of
    // them.
    if (mobile && wrapRef.current) setSheetTop(wrapRef.current.getBoundingClientRect().bottom + 6)
    else place()
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

  // Asked for on a tap, never on load: a permission prompt that appears
  // unbidden is the one people dismiss, and a dismissed prompt cannot be
  // asked for again.
  async function askPermission(): Promise<void> {
    try {
      if (typeof Notification === 'undefined') return
      const r = await Notification.requestPermission()
      setPerm(r)
      if (r === 'granted') {
        // The banner proves the permission; the subscription is what makes one
        // arrive when the app is shut. Both, in that order, so the person sees
        // something immediately either way.
        await systemNotify('Notifications are on', 'This is how they will arrive.', 'rishabhoil-hello')
        const r2 = await subscribeDevice(Number(user.id) || 0)
        setSubscribed(r2.ok)
        if (!r2.ok) setNote(r2.why)
      }
    } catch {
      // a browser that refuses to be asked — nothing to do
    }
  }

  // Proof, on the device in your hand. It goes the whole way round — server,
  // push service, this phone — so a banner here means the real ones will
  // arrive the same way, with the app shut.
  async function sendTest(): Promise<void> {
    setBusy(true)
    try {
      const sub = await subscribeDevice(Number(user.id) || 0)
      setSubscribed(sub.ok)
      if (!sub.ok) {
        setNote(sub.why)
        return
      }
      const r = await window.api.push.test(Number(user.id) || 0)
      setNote(
        r.sent > 0
          ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'} on this login. It should arrive in a moment.`
          : 'Nothing was sent — this login has no subscribed device yet.'
      )
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // EVERY DEVICE THE SITE KNOWS ABOUT. An admin telling the whole mill
  // something no rule covers — a shutdown, a stock count, a visit.
  async function sendBroadcast(): Promise<void> {
    const title = bcTitle.trim()
    if (!title) return
    setBusy(true)
    try {
      const r = await window.api.push.broadcast(title, bcBody.trim(), Number(user.id) || 0)
      setNote(
        r.devices === 0
          ? 'No device has been subscribed yet — nobody has turned notifications on.'
          : `Sent to ${r.sent} of ${r.devices} device${r.devices === 1 ? '' : 's'}${r.gone ? `, ${r.gone} gone` : ''}${r.failed ? `, ${r.failed} refused` : ''}.`
      )
      if (r.sent > 0) {
        setBcTitle('')
        setBcBody('')
        setBcOpen(false)
      }
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function setPopups(on: boolean): Promise<void> {
    setPopupsState(on)
    try {
      localStorage.setItem(POPUP_KEY, on ? '1' : '0')
    } catch {
      /* the choice just is not remembered */
    }
    if (!on) {
      await unsubscribeDevice()
      setSubscribed(false)
      setNote('')
      return
    }
    if (perm === 'default') return void askPermission()
    if (perm === 'granted') {
      const r = await subscribeDevice(Number(user.id) || 0)
      setSubscribed(r.ok)
      setNote(r.ok ? '' : r.why)
    }
  }

  function toggleMute(): void {
    setMuted((m) => {
      localStorage.setItem(MUTE_KEY, m ? '0' : '1')
      return !m
    })
  }

  // THE PANEL, AS ITS OWN ELEMENT.
  //
  // On a phone it is PORTALED to the body. `fixed` and a z-index are not
  // enough on their own: a z-index only competes inside its own stacking
  // context, and a mobile page that gives its top bar a transform or a
  // z-index of its own creates one — so the sheet was being painted
  // underneath the page it is supposed to sit over. Out at the body there
  // is no ancestor left to trap it, whatever any page does.
  const panel = (
    <div
      ref={panelRef}
      className={cn(
        'flex flex-col overflow-hidden border bg-popover text-popover-foreground shadow-lg',
        mobile ? 'fixed left-2 right-2 z-[210] rounded-[6px]' : 'fixed z-[210] w-[23rem] rounded-lg'
      )}
      style={
        mobile
          ? { top: sheetTop }
          : {
              top: anchor.top,
              right: anchor.right,
              // Never taller than what is left below the bell, so a long feed
              // scrolls inside the panel instead of running off the screen.
              maxHeight: `calc(100vh - ${anchor.top + 16}px)`
            }
      }
    >
          <div className="flex flex-none items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
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
          {/* POP-UPS ON OR OFF, ON THIS DEVICE. The bell keeps every
              notification either way; this only decides whether one also
              pops up on the screen (and arrives with the app closed). */}
          <div className="flex flex-none items-center gap-2.5 border-b px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-bold text-[#0A1F17]">Pop-up notifications</span>
              <span className="block text-[10.5px] font-medium leading-[1.4] text-[#5A6B62]">
                {popups
                  ? 'On — they pop up on this device, even with the app closed.'
                  : 'Off — they wait here in the bell; nothing pops up on this device.'}
              </span>
            </span>
            <span className="text-[10.5px] font-extrabold uppercase tracking-[.06em]" style={{ color: popups ? '#0B6B45' : '#8CA396' }}>
              {popups ? 'On' : 'Off'}
            </span>
            <Switch checked={popups} onCheckedChange={(v) => void setPopups(v)} aria-label="Pop-up notifications on this device" />
          </div>
          {/* THE ANSWER TO "DO I HAVE TO ENABLE IT?" — yes, once, and this is
              where. Until it is granted a phone can only chime, and a phone
              will not chime unless the page is open and has been touched,
              which is why nothing arrived. Granted, the notification is the
              phone's own: its sound, its banner, its vibration. */}
          {popups && perm === 'default' && (
            <button
              onClick={() => void askPermission()}
              className="flex w-full items-center gap-2 border-b bg-[#EAF0FA] px-3 py-2 text-left text-[11.5px] font-semibold text-[#1B4E82] hover:bg-[#DCE7F7]"
            >
              <BellRing className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Turn on notifications to get these on this device, with its own sound.
              </span>
              <span className="shrink-0 rounded-[3px] bg-[#1B4E82] px-2 py-0.5 text-[10.5px] font-bold text-white">
                Enable
              </span>
            </button>
          )}
          {/* WHAT THIS DEVICE CAN ACTUALLY RECEIVE, and the proof.
              Permission alone only draws a banner while the page is open. The
              subscription is what reaches a shut phone, so the state worth
              stating is that one — and a test that goes the whole way round is
              the only honest way to show it works. */}
          {popups && perm === 'granted' && (
            <div className="flex-none border-b bg-[#F7FAF6] px-3 py-2">
              {/* TWO ROWS, NOT ONE WRAPPING ONE.
                  The state, the sentence and two buttons were a single wrapped
                  row: `flex-1` let the sentence give up its width to keep the
                  buttons on the same line, so at panel width it collapsed to a
                  three-character column and broke into seven lines. What it
                  says and what you can do about it are two thoughts; they get
                  a line each, and neither can squeeze the other. */}
              <div className="flex items-baseline gap-2">
                <span
                  className="inline-flex flex-none items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em]"
                  style={
                    subscribed
                      ? { background: '#E9F5EE', color: '#0B6B45' }
                      : { background: '#FFF4E0', color: '#8A5300' }
                  }
                >
                  {subscribed ? 'subscribed' : 'not subscribed'}
                </span>
                <span className="min-w-0 flex-1 text-[10.5px] font-medium leading-[1.45] text-[#5A6B62]">
                  {subscribed
                    ? 'This device gets them with the app closed.'
                    : 'Only while this page is open.'}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendTest()}
                  className="rounded-[3px] border border-[#C3D2C6] bg-white px-2 py-1 text-[10.5px] font-bold text-[#33473E] hover:bg-[#EDF3EC] disabled:opacity-50"
                >
                  Test on this device
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setBcOpen((o) => !o)}
                    className="rounded-[3px] bg-[#0B3D2E] px-2 py-1 text-[10.5px] font-bold text-[#C7F03F] hover:bg-[#0A3327]"
                  >
                    Send to everyone
                  </button>
                )}
              </div>
              {isAdmin && bcOpen && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <input
                    value={bcTitle}
                    onChange={(e) => setBcTitle(e.target.value)}
                    maxLength={120}
                    placeholder="What it says — e.g. Plant shut from 2pm"
                    className="h-8 w-full rounded-[3px] border border-[#C3D2C6] px-2 text-[11.5px] font-semibold outline-none focus:border-[#0B3D2E]"
                  />
                  <input
                    value={bcBody}
                    onChange={(e) => setBcBody(e.target.value)}
                    maxLength={300}
                    placeholder="The line under it (optional)"
                    className="h-8 w-full rounded-[3px] border border-[#C3D2C6] px-2 text-[11.5px] font-medium outline-none focus:border-[#0B3D2E]"
                  />
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-[10.5px] font-medium text-[#5A6B62]">
                      Goes to every device that has turned notifications on, whoever is logged in on it.
                    </span>
                    <button
                      type="button"
                      disabled={busy || !bcTitle.trim()}
                      onClick={() => void sendBroadcast()}
                      className="shrink-0 rounded-[3px] bg-[#C7F03F] px-2.5 py-1 text-[10.5px] font-extrabold text-[#0B3D2E] disabled:bg-[#C3D2C6] disabled:text-white"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
              {!!note && <p className="mt-1.5 text-[10.5px] font-semibold text-[#33473E]">{note}</p>}
            </div>
          )}
          {/* An iPhone refuses web notifications in a browser TAB — the same
              page added to the Home Screen may have them. Said here because
              the alternative is a panel that offers nothing and explains
              nothing on exactly the device where it does not work. */}
          {perm === 'unsupported' && (
            <p className="border-b bg-[#F7FAF6] px-3 py-2 text-[11px] font-medium leading-[1.45] text-[#5A6B62]">
              This browser will not show notifications. On an iPhone: Share &rarr; Add to Home Screen, then open the
              app from that icon and try again here.
            </p>
          )}
          {popups && perm === 'denied' && (
            <p className="border-b bg-amber-50 px-3 py-2 text-[11px] font-medium leading-[1.45] text-amber-800">
              Notifications are blocked for this site in the browser&rsquo;s own settings — they have to be allowed
              there. Until then these arrive only while this page is open.
            </p>
          )}
          <div className={cn('min-h-0 flex-1 overflow-y-auto', mobile && 'max-h-[62vh]')}>
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
            className="w-full flex-none border-t bg-muted/30 px-3 py-2 text-center text-xs font-medium text-primary hover:bg-muted"
          >
            Notification settings
          </button>
        </div>
  )

  // The scrim is the other half of "over the background": it dims the page
  // and it is what a tap outside lands on, which on a touch screen is more
  // reliable than listening for a stray touchstart.
  const sheet = mobile ? (
    <>
      <div
        className="fixed inset-0 z-[200]"
        style={{ background: 'rgba(10,31,23,.45)' }}
        onClick={() => setOpen(false)}
      />
      {panel}
    </>
  ) : (
    panel
  )

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={openPanel}
        title="Notifications"
        aria-label="Notifications"
        className={cn(
          'relative flex items-center justify-center transition-colors',
          mobile
            ? 'h-10 w-10 flex-none rounded-[4px] bg-white/[.12] text-[#C7F03F] active:bg-white/25'
            : 'h-10 w-10 rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground'
        )}
      >
        <Bell className={mobile ? 'h-[20px] w-[20px]' : 'h-5 w-5'} />
        {unseen.length > 0 && (
          <span
            className={cn(
              'absolute flex items-center justify-center rounded-full bg-red-500 font-bold text-white',
              mobile
                ? 'right-0.5 top-0.5 h-[15px] min-w-[15px] px-[3px] text-[9.5px]'
                : '-right-0.5 -top-0.5 h-5 min-w-5 px-1 text-[11px]'
            )}
          >
            {unseen.length > 99 ? '99+' : unseen.length}
          </span>
        )}
        {/* NOT YET ALLOWED ON THIS DEVICE — said on the bell, not only inside
            it. The Enable strip has always been in the panel, which is no help
            to somebody who does not know the panel is where to look: nothing
            arrives, and nothing says why. An amber dot is the smallest thing
            that sends them in. It gives way to the unread count, which is the
            more urgent of the two, and disappears for good once granted. */}
        {perm !== 'granted' && unseen.length === 0 && (
          <span
            title="Notifications are not switched on for this device — open this and turn them on"
            className={cn(
              'absolute rounded-full bg-[#E8A33D] ring-2',
              mobile ? 'right-1.5 top-1.5 h-[7px] w-[7px] ring-[#0B3D2E]' : 'right-0 top-0 h-2.5 w-2.5 ring-card'
            )}
          />
        )}
      </button>

      {/* Both shapes go out to the body now — the phone's sheet and the
          desktop dropdown. Neither can be clipped by the header it hangs off
          or painted under the page behind it. */}
      {open && (typeof document !== 'undefined' ? createPortal(sheet, document.body) : sheet)}
    </div>
  )
}
