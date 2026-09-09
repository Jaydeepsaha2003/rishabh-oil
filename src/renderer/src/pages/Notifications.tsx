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
  MessageSquareText,
  RotateCcw,
  Users,
  Wand2
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

// One column template for the section header and every row under it.
//
// The controls used to be a flex row that wrapped and right-aligned, so a rule
// WITHOUT a threshold pulled its two pickers left and nothing lined up with
// the row above — three ragged columns down the page. A grid fixes the tracks
// once; an empty cell just stays empty.
const GRID = 'grid grid-cols-[minmax(0,1fr)_118px_152px_150px_104px] items-center gap-x-3'

// Plain English for the settings, said once in the left column. The controls
// on the right change it; this is what it currently DOES, which is the thing
// somebody scanning the page actually wants.
const SEV_WORD: Record<string, string> = {
  critical: 'Urgent',
  warning: 'Worth a look',
  normal: 'Just so you know'
}
const AUD_WORD: Record<string, string> = {
  admins: 'only admins',
  access: 'anyone who can open the page',
  everyone: 'everybody'
}

const SEV: Record<string, { label: string; chip: string; mark: string }> = {
  critical: { label: 'Critical', chip: 'border-[#8C2F26] bg-[#B3261E] text-white', mark: '#B3261E' },
  warning: { label: 'Warning', chip: 'border-[#8A5300] bg-[#C2700A] text-white', mark: '#C2700A' },
  normal: { label: 'Normal', chip: 'border-[#095538] bg-[#0B6B45] text-white', mark: '#12855A' }
}

// The same substitution the server does, so the preview and the real thing
// cannot say different words. Kept tiny and dumb on purpose: no expressions,
// no conditionals — a message people type must not be a place code can run.
function fill(tpl: string, sample: Row): string {
  if (!tpl.trim()) return ''
  const vars = (sample.vars || {}) as Record<string, unknown>
  return tpl.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) => {
    const v = vars[key]
    return v == null || v === '' ? whole : String(v)
  })
}

export function Notifications(): React.JSX.Element {
  const user = loadUser()
  const isAdmin = user?.role === 'admin'
  const [rules, setRules] = useState<Row[]>([])
  const [feed, setFeed] = useState<Row[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({ approvals: true, treasury: true })
  const [busy, setBusy] = useState('')
  const [running, setRunning] = useState(false)
  // Which rule's message is being rewritten, and the draft being typed.
  const [editing, setEditing] = useState<string>('')
  const [draft, setDraft] = useState<{ title: string; body: string }>({ title: '', body: '' })
  const [sample, setSample] = useState<Row | null>(null)

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

  // Opening the editor fetches a REAL example, so the preview underneath is
  // this rule against today's books rather than invented words.
  async function openMessage(rule: Row): Promise<void> {
    setEditing(String(rule.key))
    setDraft({ title: String(rule.title_tpl || ''), body: String(rule.body_tpl || '') })
    setSample(null)
    try {
      const rows = await window.api.notify.preview(String(rule.key))
      setSample(rows[0] || null)
    } catch {
      setSample(null)
    }
  }

  async function saveMessage(rule: Row): Promise<void> {
    setBusy(String(rule.key))
    try {
      await window.api.notify.saveRule({
        key: rule.key,
        enabled: rule.enabled,
        severity: rule.severity,
        audience: rule.audience,
        threshold: rule.threshold,
        window_from: rule.window_from,
        window_to: rule.window_to,
        title_tpl: draft.title,
        body_tpl: draft.body
      })
      setEditing('')
      await load()
      toast.success(draft.title || draft.body ? 'Your wording saved' : 'Back to the standard wording')
    } catch (e) {
      toast.error((e as Error).message)
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

              {/* Column headings once per section, not repeated over every
                  row. Nine copies of "HOW IMPORTANT" down a page is noise, and
                  it was what made each row look like its own little form. */}
              {isOpen && (
                <div className={cn(GRID, 'border-b border-b-[#EAF0E9] bg-white px-[18px] py-1.5 pl-[52px]')}>
                  <span />
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#8FA79B]">When</span>
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#8FA79B]">How important</span>
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#8FA79B]">Who gets told</span>
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#8FA79B]">Message</span>
                </div>
              )}

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
                        <div className={cn(GRID, 'relative pl-[34px]')}>
                          <Switch
                            checked={!!r.enabled}
                            disabled={busy === r.key || !isAdmin}
                            onCheckedChange={(v) => void patch(r, { enabled: v })}
                            className="absolute left-0 top-[3px] shrink-0"
                          />
                          <div className="min-w-0">
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
                            <p className="mt-1 max-w-[62ch] text-[12px] font-semibold leading-[1.5] text-[#5A6B62]">
                              {r.desc}
                            </p>
                            {/* What it does right now, as a sentence. The
                                headings above say what each control is; this
                                says what the settings add up to, which is the
                                thing you actually read a list like this for. */}
                            <p className="mt-1 text-[11.5px] font-bold leading-[1.5] text-[#0B6B45]">
                              {r.enabled ? (
                                <>
                                  {spec
                                    ? `${String(spec.question).replace(/^Tell me /, 'Tells you ').replace(/^Only /, 'Only ')} ${r.threshold} ${spec.unit}`
                                    : 'Tells you as soon as it happens'}
                                  {' · '}
                                  {SEV_WORD[String(r.severity)] || r.severity}
                                  {' · '}
                                  {r.audience === 'access'
                                    ? `anyone who can open ${MODULES.find((x) => x.key === r.module)?.label || 'that page'}`
                                    : AUD_WORD[String(r.audience)] || r.audience}
                                  {(r.title_tpl || r.body_tpl) && ' · your own wording'}
                                </>
                              ) : (
                                <span className="text-[#8FA79B]">Off — nobody is told.</span>
                              )}
                            </p>
                          </div>

                          {/* One cell per column, so every row lines up with
                              the headings and with each other. A rule with no
                              threshold leaves an empty cell rather than
                              dragging the rest of the row leftwards, which is
                              what made the columns ragged. */}
                          {spec ? (
                            <div className="flex items-center gap-1.5" title={spec.question}>
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
                                  <span className="whitespace-nowrap text-[11px] font-semibold text-[#8FA79B]">
                                    {spec.unit}
                                  </span>
                              </div>
                          ) : (
                            <span />
                          )}
                            <Select
                                value={String(r.severity)}
                                disabled={!r.enabled || busy === r.key || !isAdmin}
                                onValueChange={(v) => void patch(r, { severity: v })}
                              >
                                <SelectTrigger className={cn('w-full', __WEB__ && '!h-8 !rounded-[3px] !px-2 !text-[12.5px]')}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="critical">Urgent</SelectItem>
                                  <SelectItem value="warning">Worth a look</SelectItem>
                                  <SelectItem value="normal">Just so you know</SelectItem>
                                </SelectContent>
                              </Select>
                            <Select
                                value={String(r.audience)}
                                disabled={!r.enabled || busy === r.key || !isAdmin}
                                onValueChange={(v) => void patch(r, { audience: v })}
                              >
                                <SelectTrigger className={cn('w-full', __WEB__ && '!h-8 !rounded-[3px] !px-2 !text-[12.5px]')}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="admins">Only admins</SelectItem>
                                  {/* Usually the one that fits: a Treasury
                                      alert wants the people who work in
                                      Treasury, who are neither all the admins
                                      nor the whole desk. */}
                                  <SelectItem value="access">Who has access</SelectItem>
                                  <SelectItem value="everyone">Everybody</SelectItem>
                                </SelectContent>
                              </Select>
                            <div className="flex items-center justify-end gap-1">
                              {isAdmin && (
                                <Button
                                  variant={r.title_tpl || r.body_tpl ? 'default' : 'outline'}
                                  size="sm"
                                  disabled={!r.enabled}
                                  title={
                                    r.title_tpl || r.body_tpl
                                      ? 'You have written your own wording for this — click to change it'
                                      : 'Write your own wording for this notification'
                                  }
                                  className={cn('h-8 w-8 !p-0', __WEB__ && '!rounded-[3px]')}
                                  onClick={() => (editing === r.key ? setEditing('') : void openMessage(r))}
                                >
                                  <MessageSquareText className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {!isDefault && isAdmin && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Put this notification back to how it ships"
                                  className="h-8 w-8 !p-0 text-[#5A6B62]"
                                  disabled={busy === r.key}
                                  onClick={() => void reset(r)}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                        </div>

                        {editing === r.key && (
                          <div className="mt-3.5 rounded-[4px] border border-[#C3D2C6] bg-[#F7FAF6] p-3.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <Wand2 className="h-4 w-4 text-[#0B6B45]" />
                              <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0A1F17]">
                                Say it your way
                              </span>
                              <span className="text-[12px] font-semibold text-[#5A6B62]">
                                Leave both empty to use the standard wording.
                              </span>
                            </div>

                            {/* The placeholders, as buttons. Typing {lc_no}
                                from memory is how a message ends up with a
                                name this notification cannot fill. */}
                            {(r.vars as Row[])?.length > 0 && (
                              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] font-bold text-[#5A6B62]">Drop in:</span>
                                {(r.vars as Row[]).map((v) => (
                                  <button
                                    key={String(v.key)}
                                    type="button"
                                    title={`${v.label} — click to add`}
                                    onClick={() => setDraft((d) => ({ ...d, body: `${d.body}{${v.key}}` }))}
                                    className="rounded-[2px] border border-[#C3D2C6] bg-white px-1.5 py-[2px] font-mono text-[11px] font-bold text-[#0B6B45] hover:bg-[#EFF5EC]"
                                  >
                                    {`{${v.key}}`}
                                  </button>
                                ))}
                              </div>
                            )}

                            <div className="mt-3 grid gap-2.5">
                              <div className="flex flex-col gap-1">
                                <Label className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                  Heading
                                </Label>
                                <Input
                                  value={draft.title}
                                  placeholder={String(sample?.default_title || 'The standard heading')}
                                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                                  className={cn(__WEB__ && '!h-9 !rounded-[3px] !text-[12.5px]')}
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <Label className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                  The line under it
                                </Label>
                                <Input
                                  value={draft.body}
                                  placeholder={String(sample?.default_body || 'The standard message')}
                                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                                  className={cn(__WEB__ && '!h-9 !rounded-[3px] !text-[12.5px]')}
                                />
                              </div>
                            </div>

                            {/* Against a real one from today's books, not made
                                up — so what you see here is what will arrive. */}
                            <div className="mt-3 rounded-[3px] border border-[#D6E2D6] bg-white px-3 py-2.5">
                              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FA79B]">
                                {sample ? 'How it will read' : 'Nothing to preview — this one has nothing to report right now'}
                              </div>
                              {sample && (
                                <>
                                  <div className="mt-1 text-[12.5px] font-extrabold text-[#0A1F17]">
                                    {fill(draft.title, sample) || String(sample.default_title || '')}
                                  </div>
                                  <div className="mt-0.5 text-[12px] font-semibold text-[#5A6B62]">
                                    {fill(draft.body, sample) || String(sample.default_body || '')}
                                  </div>
                                </>
                              )}
                            </div>

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                disabled={busy === r.key}
                                className={cn('h-8 text-[12px] font-bold', __WEB__ && '!rounded-[3px]')}
                                onClick={() => void saveMessage(r)}
                              >
                                Save wording
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className={cn('h-8 text-[12px] font-bold', __WEB__ && '!rounded-[3px]')}
                                onClick={() => setEditing('')}
                              >
                                Cancel
                              </Button>
                              {(r.title_tpl || r.body_tpl) && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-[11.5px] font-bold text-[#5A6B62]"
                                  onClick={() => setDraft({ title: '', body: '' })}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" /> Standard wording
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
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
