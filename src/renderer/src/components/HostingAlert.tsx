import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { formatDate } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE HOSTING RENEWAL REMINDER, ON EVERY SCREEN, FOR EVERY USER.
//
// 30 to 16 days out: an amber bar along the top, which can be shut for the
// rest of the day only. 15 days or fewer (or already past): a red bar that
// cannot be shut, and a pop-up on every sign-in / page load that has to be
// acknowledged. Fed by hostinger.ts (one shared, hourly-cached call).
const todayKey = (): string => new Date().toISOString().slice(0, 10)

function store(kind: 'local' | 'session', key: string, value?: string): string | null {
  try {
    const s = kind === 'local' ? window.localStorage : window.sessionStorage
    if (value === undefined) return s.getItem(key)
    s.setItem(key, value)
  } catch {
    /* private window: the reminder simply shows again */
  }
  return null
}

const whenText = (days: number): string =>
  days < 0 ? `${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'TODAY' : `in ${days} day${days === 1 ? '' : 's'}`

export function HostingAlert({ isAdmin, onOpenSettings }: { isAdmin: boolean; onOpenSettings?: () => void }): React.JSX.Element | null {
  const [a, setA] = useState<Row | null>(null)
  const [shut, setShut] = useState(() => store('local', 'hostingAlert.shut') === todayKey())
  const [ack, setAck] = useState(() => store('session', 'hostingAlert.ack') === '1')

  useEffect(() => {
    let alive = true
    const read = (): void => {
      window.api.hostinger
        .alert()
        .then((r) => alive && setA(r))
        .catch(() => {})
    }
    read()
    const t = window.setInterval(read, 60 * 60 * 1000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  if (!a || !Array.isArray(a.items) || !a.items.length) return null
  const days = Number(a.days)
  const strict = days <= 15
  const first = a.items[0] as Row
  const what = first.kind === 'domain' ? `The domain ${String(first.name)}` : `The hosting plan (${String(first.name)})`
  const verb = first.auto_renew ? 'renews' : days < 0 ? 'expired' : 'expires'
  const line = `${what} ${verb} ${first.date ? `on ${formatDate(String(first.date).slice(0, 10))}` : ''} — ${whenText(days)}.`
  const consequence = first.auto_renew
    ? 'Make sure the payment goes through — if it fails, the website and ALL its data will be lost.'
    : 'Renew it now, or the website and ALL its data will be lost.'

  const bar =
    strict || !shut ? (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12.5px] font-bold"
        style={strict ? { background: '#B3261E', color: '#fff' } : { background: '#FFF4DC', color: '#6B4300', borderBottom: '1px solid #F1D9A6' }}
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {line} {consequence}
          {a.items.length > 1 ? ` (+${a.items.length - 1} more due within 30 days)` : ''}
        </span>
        {isAdmin && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-[4px] px-2.5 py-1 text-[11.5px] font-extrabold underline-offset-2 hover:underline"
            style={strict ? { background: 'rgba(255,255,255,.18)' } : { background: '#fff', border: '1px solid #EAD9AE' }}
          >
            See dates
          </button>
        )}
        {!strict && (
          <button
            type="button"
            aria-label="Hide until tomorrow"
            title="Hide until tomorrow — it comes back every day until renewed"
            onClick={() => {
              store('local', 'hostingAlert.shut', todayKey())
              setShut(true)
            }}
            className="rounded-[4px] p-1 hover:bg-black/5"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    ) : null

  return (
    <>
      {bar}
      <Dialog open={strict && !ack} onOpenChange={() => {}}>
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-[520px] [&>button:last-child]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="bg-[#B3261E] px-6 py-4 text-white">
            <div className="flex items-center gap-2 text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#FFD9D5]">
              <AlertTriangle className="h-4 w-4" /> Urgent · hosting {days < 0 ? 'expired' : 'about to expire'}
            </div>
            <DialogTitle className="mt-1 text-[19px] font-extrabold text-white">Your data will be lost — renew it now</DialogTitle>
          </div>
          <div className="space-y-3 px-6 py-5 text-[13.5px] leading-[1.6] text-[#33473E]">
            <p className="font-bold text-[#0A1F17]">{line}</p>
            <p>
              {consequence} Every purchase, sale, voucher and ledger on this website lives on that hosting. When it lapses, Hostinger deletes it.
            </p>
            {a.items.length > 1 && (
              <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">
                {(a.items as Row[]).map((x, i) => (
                  <li key={i}>
                    {x.kind === 'domain' ? 'Domain' : 'Plan'} <b>{String(x.name)}</b> — {x.date ? formatDate(String(x.date).slice(0, 10)) : '—'} ({whenText(Number(x.days))})
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[12px] font-semibold text-[#5A6B62]">
              {isAdmin ? 'Renew from hPanel → Billing. This reminder shows to every user until it is renewed.' : 'Tell the administrator today. This reminder shows to every user until it is renewed.'}
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-[#F0D6D4] px-6 py-3.5">
            {isAdmin && onOpenSettings && (
              <button
                type="button"
                onClick={() => {
                  store('session', 'hostingAlert.ack', '1')
                  setAck(true)
                  onOpenSettings()
                }}
                className="h-9 rounded-[6px] border border-[#D6E2D6] px-4 text-[13px] font-extrabold text-[#33473E] hover:bg-[#F7FAF6]"
              >
                See the dates
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                store('session', 'hostingAlert.ack', '1')
                setAck(true)
              }}
              className="h-9 rounded-[6px] bg-[#B3261E] px-4 text-[13px] font-extrabold text-white hover:bg-[#8C2F26]"
            >
              I understand
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
