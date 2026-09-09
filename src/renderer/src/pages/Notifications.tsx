import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronRight,
  Info,
  Play,
  RotateCcw,
  Users
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { loadUser } from '@/lib/session'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Notification settings.
//
// The page renders itself from the catalogue in src/main/notify.ts — it has no
// list of events of its own. Add a rule there and it appears here with its
// description, its threshold box and its defaults; there is no second place to
// keep in step.
//
// IN-APP ONLY, deliberately and throughout. There is no channel picker, because
// there is one channel: the bell. Nothing here sends an email, a message or a
// text, and no part of the system pretends it might.

const MODULES: { key: string; label: string; hint: string }[] = [
  { key: 'approvals', label: 'Approvals', hint: 'Masters waiting for an admin' },
  { key: 'treasury', label: 'Treasury', hint: 'Credits, discounted bills and their dates' },
  { key: 'purchase', label: 'Purchases', hint: 'Invoices, tankers and what they weighed' },
  { key: 'sales', label: 'Sales', hint: 'Invoices and what is owed' },
  { key: 'stock', label: 'Stock', hint: 'What the registers close at' }
]

const SEV: Record<string, { label: string; chip: string; mark: string }> = {
  critical: { label: 'Critical', chip: 'border-[#8C2F26] bg-[#B3261E] text-white', mark: '#B3261E' },
  warning: { label: 'Warning', chip: 'border-[#8A5300] bg-[#C2700A] text-white', mark: '#C2700A' },
  normal: { label: 'Normal', chip: 'border-[#095538] bg-[#0B6B45] text-white', mark: '#12855A' }
}

export function Notifications(): React.JSX.Element {
  const user = loadUser()
  const isAdmin = user?.role === 'admin'
  const [rules, setRules] = useState<Row[]>([])
  const [feed, setFeed] = useState<Row[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({ approvals: true, treasury: true })
  const [busy, setBusy] = useState('')
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    const [r, f] = await Promise.all([
      window.api.notify.rules().catch(() => [] as Row[]),
      window.api.notify.list(Number(user?.id) || 0, !!isAdmin, 30).catch(() => [] as Row[])
    ])
    setRules(r)
    setFeed(f)
  }, [user?.id, isAdmin])

  useEffect(() => { void load() }, [load])
  useLiveRefresh(load)

  // Saving one rule saves that rule. The whole page is not a form with an
  // Apply button — a desk turning one thing off should not have to think about
  // what else it might be committing.
  async function patch(rule: Row, change: Row): Promise<void> {
    setBusy(String(rule.key))
    try {
      await window.api.notify.saveRule({
        key: rule.key,
        enabled: change.enabled ?? rule.enabled,
        severity: change.severity ?? rule.severity,
        audience: change.audience ?? rule.audience,
        threshold: change.threshold ?? rule.threshold
      })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
      await load()
    } finally {
      setBusy('')
    }
  }

  async function reset(rule: Row): Promise<void> {
    setBusy(String(rule.key))
    try {
      await window.api.notify.resetRule(String(rule.key))
      await load()
      toast.success('Back to the default')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function runNow(): Promise<void> {
    setRunning(true)
    try {
      const res = await window.api.notify.run()
      await load()
      if (res.failed?.length) {
        toast.error(`${res.failed.length} rule(s) could not be checked`)
        for (const f of res.failed) console.error('[notify]', f)
      } else {
        toast.success(res.raised ? `${res.raised} new notification${res.raised === 1 ? '' : 's'}` : 'Nothing new to tell you')
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const byModule = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rules) {
      const k = String(r.module)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    return m
  }, [rules])

  const liveCount = rules.filter((r) => r.enabled).length
  const changed = rules.filter(
    (r) =>
      r.enabled !== r.default_enabled ||
      r.severity !== r.default_severity ||
      r.audience !== r.default_audience ||
      (r.threshold != null && r.threshold !== r.default_threshold)
  ).length

  return (
    <div>
      <PageHeader
        title="Notifications"
        hint="What the app tells you, when, and who hears it. Every notification lands on the bell in this app — nothing is sent anywhere else."
        actions={
          <Button variant="outline" onClick={() => void runNow()} disabled={running}>
            <Play className="h-4 w-4" /> {running ? 'Checking…' : 'Check now'}
          </Button>
        }
      />

      <div className={cn('space-y-4 px-4 py-5', __WEB__ && '!space-y-3 !px-3 !py-3')}>
        {/* What the page is, in one line, plus the one thing everybody asks. */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-card px-4 py-3',
            __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white !px-[18px]'
          )}
        >
          <span className="flex items-center gap-2">
            <Bell className="h-[18px] w-[18px] text-[#0B6B45]" />
            <span className="text-[13px] font-bold text-[#0A1F17]">{liveCount} of {rules.length} on</span>
          </span>
          <span className="text-[12.5px] font-semibold text-[#5A6B62]">
            {changed === 0
              ? 'All at their defaults.'
              : `${changed} changed from the default.`}
          </span>
          <span className="ml-auto flex items-center gap-2 text-[12px] font-semibold text-[#5A6B62]">
            <Info className="h-4 w-4 shrink-0 text-[#A8B8AE]" />
            Everything arrives on the bell in this app.
          </span>
        </div>

        {MODULES.filter((mod) => (byModule.get(mod.key) || []).length > 0).map((mod) => {
          const list = byModule.get(mod.key) || []
          const on = list.filter((r) => r.enabled).length
          const isOpen = open[mod.key] !== false
          return (
            <section
              key={mod.key}
              className={cn('overflow-hidden rounded-md border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}
            >
              <button
                type="button"
                onClick={() => setOpen((p) => ({ ...p, [mod.key]: !isOpen }))}
                aria-expanded={isOpen}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b px-4 py-3 text-left transition-colors hover:bg-muted/40',
                  __WEB__ && '!border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[18px] hover:!bg-[#EFF5EC]'
                )}
              >
                <ChevronRight className={cn('h-4 w-4 shrink-0 text-[#5A6B62] transition-transform', isOpen && 'rotate-90')} />
                <span className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#0A1F17]">{mod.label}</span>
                <span className="text-[12px] font-semibold text-[#5A6B62]">{mod.hint}</span>
                <span className="ml-auto rounded-[2px] border border-[#DCE7DB] bg-[#EAF0E9] px-2 py-[3px] text-[11px] font-extrabold tabular-nums text-[#33473E]">
                  {on}/{list.length} on
                </span>
              </button>

              {isOpen && (
                <div>
                  {list.map((r) => {
                    const sev = SEV[String(r.severity)] || SEV.normal
                    const spec = r.threshold_spec as Row | null
                    const isDefault =
                      r.enabled === r.default_enabled &&
                      r.severity === r.default_severity &&
                      r.audience === r.default_audience &&
                      (r.threshold == null || r.threshold === r.default_threshold)
                    return (
                      <div
                        key={String(r.key)}
                        className={cn(
                          'border-b px-4 py-3.5 last:border-b-0',
                          __WEB__ && '!border-b-[#EAF0E9] !px-[18px]',
                          !r.enabled && 'opacity-60'
                        )}
                        style={__WEB__ ? { borderLeft: `3px solid ${r.enabled ? sev.mark : 'transparent'}` } : undefined}
                      >
                        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                          <Switch
                            checked={!!r.enabled}
                            disabled={busy === r.key || !isAdmin}
                            onCheckedChange={(v) => void patch(r, { enabled: v })}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[13px] font-extrabold text-[#0A1F17]">{r.label}</span>
                              <span
                                className={cn(
                                  'rounded-[2px] border px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[.08em]',
                                  sev.chip
                                )}
                              >
                                {sev.label}
                              </span>
                              {!isDefault && (
                                <span className="rounded-[2px] border border-[#C3B78F] bg-[#FDFBF3] px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[.08em] text-[#8A5300]">
                                  Changed
                                </span>
                              )}
                            </div>
                            <p className="mt-1.5 max-w-[60ch] text-[12px] font-semibold leading-[1.55] text-[#5A6B62]">
                              {r.desc}
                              {r.audience === 'access' && (
                                <span className="text-[#0B6B45]">
                                  {' '}
                                  Reaches anyone who can open{' '}
                                  {MODULES.find((x) => x.key === r.module)?.label || 'that page'}.
                                </span>
                              )}
                            </p>
                          </div>

                          {/* The three knobs, only where they mean something. */}
                          <div className="flex flex-wrap items-end gap-2">
                            {spec && (
                              <div className="flex flex-col gap-1">
                                {/* Label and unit share one line above the box.
                                    The unit used to sit BESIDE it, which made
                                    the field twice as wide as the number it
                                    holds and pushed the two pickers off the row
                                    on a narrow screen. */}
                                <Label className="whitespace-nowrap text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                  {spec.label}{' '}
                                  <span className="font-bold normal-case tracking-normal text-[#8FA79B]">
                                    · {spec.unit}
                                  </span>
                                </Label>
                                <Input
                                  type="number"
                                  step={spec.step || 1}
                                  min={spec.min}
                                  max={spec.max}
                                  disabled={!r.enabled || busy === r.key || !isAdmin}
                                  defaultValue={String(r.threshold ?? '')}
                                  key={`${r.key}:${r.threshold}`}
                                  onBlur={(e) => {
                                    const v = e.target.value
                                    if (v !== String(r.threshold ?? '')) void patch(r, { threshold: v })
                                  }}
                                  className={cn('w-[62px] text-right', __WEB__ && '!h-8 !rounded-[3px] !px-2 !text-[12.5px]')}
                                />
                              </div>
                            )}
                            <div className="flex flex-col gap-1">
                              <Label className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                Severity
                              </Label>
                              <Select
                                value={String(r.severity)}
                                disabled={!r.enabled || busy === r.key || !isAdmin}
                                onValueChange={(v) => void patch(r, { severity: v })}
                              >
                                <SelectTrigger className={cn('w-[104px]', __WEB__ && '!h-8 !rounded-[3px] !px-2 !text-[12.5px]')}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="critical">Critical</SelectItem>
                                  <SelectItem value="warning">Warning</SelectItem>
                                  <SelectItem value="normal">Normal</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                              <Label className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                Who hears it
                              </Label>
                              <Select
                                value={String(r.audience)}
                                disabled={!r.enabled || busy === r.key || !isAdmin}
                                onValueChange={(v) => void patch(r, { audience: v })}
                              >
                                <SelectTrigger className={cn('w-[126px]', __WEB__ && '!h-8 !rounded-[3px] !px-2 !text-[12.5px]')}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="admins">Admins</SelectItem>
                                  {/* Usually the one that fits: a Treasury
                                      alert wants the people who work in
                                      Treasury, who are neither all the admins
                                      nor the whole desk. */}
                                  <SelectItem value="access">Who has access</SelectItem>
                                  <SelectItem value="everyone">Everyone</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            {!isDefault && isAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Put this notification back to how it ships"
                                className="h-8 px-2 text-[11px] font-bold text-[#5A6B62]"
                                disabled={busy === r.key}
                                onClick={() => void reset(r)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" /> Reset
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}

        {!isAdmin && (
          <div
            className={cn(
              'flex items-start gap-2.5 rounded-md border px-4 py-3',
              __WEB__ && '!rounded-[4px] !border-[#F0E4CB] !border-l-4 !border-l-[#C2700A] !bg-[#FFFBF2] !px-[18px]'
            )}
          >
            <Users className="mt-[1px] h-[18px] w-[18px] shrink-0 text-[#8A5300]" />
            <span className="text-[12.5px] font-bold leading-[1.5] text-[#8A5300]">
              These settings are read-only for you — an admin decides what the desk is told. You still receive
              everything marked for Everyone.
            </span>
          </div>
        )}

        {/* What has actually been raised, so the settings above can be judged
            against their output rather than guessed at. */}
        <section className={cn('overflow-hidden rounded-md border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
          <div className={cn('flex items-center gap-2.5 border-b px-4 py-3', __WEB__ && '!border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[18px]')}>
            <Bell className="h-[17px] w-[17px] text-[#33473E]" />
            <span className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#0A1F17]">
              On your bell now
            </span>
            <span className="text-[12px] font-semibold text-[#5A6B62]">
              The newest {feed.length === 1 ? 'one' : feed.length}, as you would see {feed.length === 1 ? 'it' : 'them'}
            </span>
          </div>
          {feed.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] font-semibold text-[#8FA79B]">
              <BellOff className="h-4 w-4" /> Nothing has been raised yet. Use Check now to look.
            </div>
          ) : (
            <div>
              {feed.map((f) => {
                const sev = SEV[String(f.severity)] || SEV.normal
                return (
                  <div
                    key={String(f.id)}
                    className={cn('flex items-start gap-3 border-b px-4 py-3 last:border-b-0', __WEB__ && '!border-b-[#EAF0E9] !px-[18px]')}
                    style={__WEB__ ? { borderLeft: `3px solid ${sev.mark}` } : undefined}
                  >
                    {String(f.severity) === 'critical' ? (
                      <AlertTriangle className="mt-[2px] h-4 w-4 shrink-0" style={{ color: sev.mark }} />
                    ) : (
                      <CheckCircle2 className="mt-[2px] h-4 w-4 shrink-0" style={{ color: sev.mark }} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={cn('text-[12.5px] font-extrabold text-[#0A1F17]', f.is_read && '!font-bold !text-[#5A6B62]')}>
                        {f.title}
                      </div>
                      <div className="mt-0.5 text-[12px] font-semibold leading-[1.5] text-[#5A6B62]">{f.body}</div>
                    </div>
                    {!f.is_read && (
                      <span className="mt-[3px] h-2 w-2 shrink-0 rounded-full bg-[#C7F03F] ring-1 ring-[#0B6B45]" title="Unread" />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
