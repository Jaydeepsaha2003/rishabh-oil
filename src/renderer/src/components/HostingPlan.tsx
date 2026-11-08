import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Globe, KeyRound, RefreshCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// SETTINGS → HOSTING: when the Hostinger plan renews or runs out, and the
// domains with it. Read through the server (hostinger.ts), which alone holds
// the API key; an administrator sets or removes it here.
function daysTo(iso: string | null): number | null {
  if (!iso) return null
  const d = Date.parse(iso)
  if (!Number.isFinite(d)) return null
  return Math.ceil((d - Date.now()) / 86400000)
}

function DueChip({ iso, kind }: { iso: string | null; kind: 'renews' | 'expires' }): React.JSX.Element {
  const d = daysTo(iso)
  if (d == null) return <span className="text-[11.5px] font-semibold text-[#8CA396]">no date given</span>
  const tone = d < 0 ? 'bad' : d <= 15 ? 'bad' : d <= 45 ? 'warn' : 'ok'
  const text = d < 0 ? `${kind === 'renews' ? 'was due' : 'expired'} ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-[3px] px-2 py-0.5 text-[11px] font-extrabold',
        tone === 'bad' && 'bg-[#FDECEA] text-[#B3261E]',
        tone === 'warn' && 'bg-[#FFF4DC] text-[#8A5300]',
        tone === 'ok' && 'bg-[#E9F5EE] text-[#0B6B45]'
      )}
    >
      {text}
    </span>
  )
}

export function HostingPlan({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<Row | null>(null)
  const [plans, setPlans] = useState<Row | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    setErr('')
    try {
      const st = await window.api.hostinger.status()
      setStatus(st)
      if (st.configured) setPlans(await window.api.hostinger.plans(refresh))
      else setPlans(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function save(remove = false): Promise<void> {
    if (remove && !confirm('Remove the Hostinger API key? The plan dates will no longer show here.')) return
    setBusy(true)
    try {
      await window.api.hostinger.setToken(remove ? null : token)
      setToken('')
      setEditing(false)
      toast.success(remove ? 'Hostinger API key removed' : 'Hostinger API key saved — it works')
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const subs = ((plans?.subscriptions as Row[]) || []).slice().sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')))
  const doms = ((plans?.domains as Row[]) || []).slice().sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')))
  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const head = 'flex items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#33473E]'

  return (
    <div className="flex max-w-[900px] flex-col gap-4">
      <div className={card}>
        <div className={head}>
          <KeyRound className="h-4 w-4" /> Hostinger API key
        </div>
        <div className="space-y-3 px-4 py-3.5 text-[12.5px] text-[#33473E]">
          {status?.configured && !editing ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-bold text-[#0B6B45]">Set</span>
              <span className="font-mono text-[12px] text-[#5A6B62]">{String(status.hint)}</span>
              {status.updated_by && (
                <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                  by {String(status.updated_by)}
                  {status.updated_at ? ` · ${formatDate(String(status.updated_at).slice(0, 10))}` : ''}
                </span>
              )}
              {isAdmin && (
                <span className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={busy}>
                    Replace
                  </Button>
                  <Button variant="outline" size="sm" className="text-[#B3261E]" onClick={() => void save(true)} disabled={busy}>
                    Remove
                  </Button>
                </span>
              )}
            </div>
          ) : isAdmin ? (
            <>
              <p className="leading-[1.55] text-[#5A6B62]">
                Create a token in <b>hPanel → Profile → API</b> and paste it here. It is kept on the server only — never shown again, never in a
                snapshot or the audit log — and is used just to read your plan and domain dates.
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste the Hostinger API token"
                  className="h-9 min-w-[280px] flex-1 font-mono text-[12.5px]"
                />
                <Button onClick={() => void save()} disabled={busy || !token.trim()}>
                  {busy ? 'Checking…' : 'Save key'}
                </Button>
                {status?.configured && (
                  <Button variant="outline" onClick={() => setEditing(false)} disabled={busy}>
                    Cancel
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-[#5A6B62]">Not set yet — an administrator adds the Hostinger API key here.</p>
          )}
        </div>
      </div>

      {status?.configured && (
        <>
          <div className="flex items-center gap-3">
            <span className="text-[11.5px] font-semibold text-[#5A6B62]">
              {plans?.fetched_at ? `Read from Hostinger ${new Date(String(plans.fetched_at)).toLocaleString()}` : ''}
            </span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => void load(true)} disabled={busy}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', busy && 'animate-spin')} /> Refresh
            </Button>
          </div>
          {err && <div className="rounded-[5px] border border-[#F0C9C4] bg-[#FDF3F2] px-4 py-2.5 text-[12.5px] font-semibold text-[#B3261E]">{err}</div>}

          <div className={card}>
            <div className={head}>
              <Server className="h-4 w-4" /> Hosting plans &amp; subscriptions · {subs.length}
            </div>
            {subs.length === 0 ? (
              <div className="px-4 py-5 text-[12.5px] text-[#5A6B62]">{busy ? 'Reading…' : 'No subscriptions on this Hostinger account.'}</div>
            ) : (
              subs.map((s) => (
                <div key={String(s.id)} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#EFF3EE] px-4 py-3 last:border-b-0">
                  <div className="min-w-[220px] flex-1">
                    <div className="text-[13px] font-extrabold text-[#0A1F17]">{String(s.name)}</div>
                    <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-[#5A6B62]">
                      {String(s.status).replace(/_/g, ' ')}
                      {s.billing_period ? ` · every ${String(s.billing_period)}` : ''} · {s.auto_renew ? 'auto-renew on' : 'auto-renew off'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-[#8CA396]" />
                    <span className="text-[12.5px] font-bold text-[#0A1F17]">
                      {s.date_kind === 'renews' ? 'Renews' : 'Expires'} {s.date ? formatDate(String(s.date).slice(0, 10)) : '—'}
                    </span>
                    <DueChip iso={s.date as string | null} kind={s.date_kind as 'renews' | 'expires'} />
                  </div>
                  {s.renewal_price != null && (
                    <div className="w-full text-[11.5px] font-semibold text-[#5A6B62] sm:w-auto">
                      Renewal {Number(s.renewal_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {String(s.currency)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className={card}>
            <div className={head}>
              <Globe className="h-4 w-4" /> Domains · {doms.length}
            </div>
            {plans?.domains_error ? (
              <div className="px-4 py-3 text-[12.5px] font-semibold text-[#8A5300]">{String(plans.domains_error)}</div>
            ) : doms.length === 0 ? (
              <div className="px-4 py-5 text-[12.5px] text-[#5A6B62]">No domains registered on this Hostinger account.</div>
            ) : (
              doms.map((d) => (
                <div key={String(d.domain)} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#EFF3EE] px-4 py-3 last:border-b-0">
                  <div className="min-w-[220px] flex-1 text-[13px] font-extrabold text-[#0A1F17]">{String(d.domain) || '—'}</div>
                  <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-[#5A6B62]">{String(d.status).replace(/_/g, ' ')}</span>
                  <span className="text-[12.5px] font-bold text-[#0A1F17]">Expires {d.date ? formatDate(String(d.date).slice(0, 10)) : '—'}</span>
                  <DueChip iso={d.date as string | null} kind="expires" />
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
