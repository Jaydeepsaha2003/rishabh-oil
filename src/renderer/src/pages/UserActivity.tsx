// User activity — its own page, beside User Access.
// -----------------------------------------------------------------------------
// It was the Access tab inside Settings, next to the database backup. It is not
// a setting: it is the audit trail, and the two questions it answers — what did
// somebody just do, and who is on right now — are asked when something has gone
// wrong and nobody wants to hunt for them under a gear icon.
//
// The log itself is one table with a day band, and the right rail is the live
// side: who is signed in this minute, and which devices may sign in at all.
//
// Two things the raw rows cannot be shown without live in lib/activityLog.ts —
// created_at is UTC, and `action` is forty-seven free-text verbs that have to
// be bucketed into the four questions a reader actually has.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Clock,
  Download,
  FilterX,
  History,
  Info,
  LogIn,
  Monitor,
  MonitorOff,
  PlusCircle,
  Search,
  Trash2,
  Users,
  X,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import { MobileBar } from '@/components/MobileBar'
import { DatePicker } from '@/components/ui/date-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { exportRowsToExcel } from '@/lib/excel'
import { formatDate } from '@/lib/format'
import { useIsMobile } from '@/lib/useIsMobile'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { cn } from '@/lib/utils'
import {
  ago,
  bucketOf,
  BUCKET_LABEL,
  logDate,
  logDay,
  logDayLabel,
  logDetail,
  logTime,
  type Bucket
} from '@/lib/activityLog'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TONE: Record<Bucket, { bg: string; fg: string; bd: string; mark: string; icon: LucideIcon }> = {
  create: { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB', mark: '#12855A', icon: PlusCircle },
  edit: { bg: '#FFF4E0', fg: '#8A5300', bd: '#F0E4CB', mark: '#C2700A', icon: History },
  delete: { bg: '#FDF3F2', fg: '#B3261E', bd: '#F0D6D4', mark: '#B3261E', icon: Trash2 },
  status: { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0', mark: '#1B4E82', icon: ChevronDown },
  login: { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB', mark: '#5A6B62', icon: LogIn },
  other: { bg: '#F4F6F3', fg: '#5A6B62', bd: '#DCE7DB', mark: '#C3D2C6', icon: Info }
}

const TABS: (Bucket | 'all')[] = ['all', 'create', 'edit', 'delete', 'status', 'login', 'other']
const RETENTIONS = ['15', '30', '60', '90']

// A stable tint per username, so the same person is the same colour down the
// page without a palette having to be stored anywhere.
const AVATARS: [string, string][] = [
  ['#EDE9FB', '#3D3179'],
  ['#EAF0FA', '#1B4E82'],
  ['#E9F5EE', '#0B6B45'],
  ['#FFF4E0', '#8A5300'],
  ['#EAF0E9', '#33473E'],
  ['#FDF3F2', '#8C2F26']
]
function avatarOf(name: string): [string, string] {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997
  return AVATARS[h % AVATARS.length]
}
const initialsOf = (u: string): string => String(u || '?').slice(0, 2).toUpperCase()

const todayLocal = (): string => logDay(new Date().toISOString().replace('T', ' ').slice(0, 19))
function daysAgoLocal(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
// The server compares against a UTC created_at, so a local date sent as-is
// clips five and a half hours off each end. Widened by a day either side and
// then trimmed exactly on the client against the converted timestamp.
const widen = (iso: string, by: number): string => {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + by)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export function UserActivity(): React.JSX.Element {
  const isMobile = useIsMobile()
  const [logs, setLogs] = useState<Row[]>([])
  const [users, setUsers] = useState<string[]>([])
  const [sections, setSections] = useState<string[]>([])
  const [live, setLive] = useState<Row[]>([])
  const [ips, setIps] = useState<Row[]>([])
  const [retention, setRetention] = useState('30')
  const [loading, setLoading] = useState(true)
  const [mTab, setMTab] = useState<'log' | 'who'>('log')

  const [query, setQuery] = useState('')
  const [pickedUsers, setPickedUsers] = useState<string[]>([])
  const [pickedSections, setPickedSections] = useState<string[]>([])
  const [tab, setTab] = useState<Bucket | 'all'>('all')
  const [from, setFrom] = useState(() => daysAgoLocal(7))
  const [to, setTo] = useState(todayLocal)

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const [l, i, s] = await Promise.all([
        window.api.access.liveUsers(),
        window.api.access.ips(),
        window.api.settings.all()
      ])
      setLive(l)
      setIps(i)
      setRetention(String(s.log_retention_days ?? '30'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    const f: Row = {}
    if (pickedUsers.length) f.username = pickedUsers
    if (pickedSections.length) f.entity = pickedSections
    if (query.trim()) f.q = query.trim()
    if (from) f.from = widen(from, -1)
    if (to) f.to = widen(to, 1)
    try {
      const res = await window.api.access.logs(f)
      setLogs(res.rows)
      setUsers(res.users)
      setSections(res.entities)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [pickedUsers, pickedSections, query, from, to])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadLogs()
  }, [loadLogs])
  useLiveRefresh(load)
  useLiveRefresh(loadLogs)

  // Presence does not bump the global revision, so it is polled directly.
  useEffect(() => {
    const id = setInterval(() => {
      window.api.access.liveUsers().then(setLive).catch(() => {})
    }, 10000)
    return () => clearInterval(id)
  }, [])

  // Trimmed exactly here, against the LOCAL day — the query was widened by a
  // day either side to survive the UTC boundary.
  const inRange = useCallback(
    (r: Row): boolean => {
      const d = logDay(r.created_at)
      return (!from || d >= from) && (!to || d <= to)
    },
    [from, to]
  )

  const shaped = useMemo(
    () =>
      logs
        .filter(inRange)
        // Annotated: spreading a Record<string, any> into a literal makes TS
        // forget the index signature, and every r.username below becomes an error.
        .map((r): Row => ({ ...r, _bucket: bucketOf(r.action), _day: logDay(r.created_at) })),
    [logs, inRange]
  )
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: shaped.length }
    for (const r of shaped) c[r._bucket] = (c[r._bucket] || 0) + 1
    return c
  }, [shaped])
  const rows = useMemo(() => shaped.filter((r) => tab === 'all' || r._bucket === tab), [shaped, tab])

  const dayCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r._day] = (c[r._day] || 0) + 1
    return c
  }, [rows])

  const today = todayLocal()
  const todayRows = shaped.filter((r) => r._day === today)
  const changedToday = todayRows.filter((r) => ['edit', 'delete', 'status'].includes(r._bucket)).length
  const blockedCount = ips.filter((d) => !d.active).length

  const kpis = [
    {
      k: 'Entries today',
      v: String(todayRows.length),
      sub: `across ${new Set(todayRows.map((r) => String(r.entity || '—'))).size} sections`,
      accent: '#0B3D2E',
      fg: '#0A1F17'
    },
    { k: 'Changes today', v: String(changedToday), sub: 'edits, deletes and stage moves', accent: '#C2700A', fg: '#8A5300' },
    { k: 'Online now', v: String(live.length), sub: `of ${users.length} logins seen`, accent: '#12855A', fg: '#0B6B45' },
    { k: 'Blocked devices', v: String(blockedCount), sub: 'cannot sign in', accent: '#B3261E', fg: '#B3261E' }
  ]

  const anyFilter =
    !!query.trim() || pickedUsers.length > 0 || pickedSections.length > 0 || tab !== 'all' || from !== daysAgoLocal(7) || to !== today

  function clearFilters(): void {
    setQuery('')
    setPickedUsers([])
    setPickedSections([])
    setTab('all')
    setFrom(daysAgoLocal(7))
    setTo(today)
  }

  async function toggleIp(d: Row): Promise<void> {
    try {
      await window.api.access.setIp(Number(d.id), !d.active)
      toast.success(d.active ? 'Device blocked — it cannot sign in' : 'Device activated')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function saveRetention(v: string): Promise<void> {
    setRetention(v)
    try {
      await window.api.settings.set('log_retention_days', v)
      toast.success(`Activity kept for ${v} days`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function download(): Promise<void> {
    if (!rows.length) {
      toast.error('Nothing to export with these filters')
      return
    }
    try {
      await exportRowsToExcel({
        filename: `user-activity-${from || 'start'}-to-${to || 'date'}`,
        sheetName: 'User activity',
        title: 'User activity',
        subtitle:
          `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · ${formatDate(from)} to ${formatDate(to)} · ` +
          `times are local · kept ${retention} days`,
        freezeCols: 2,
        columns: [
          { header: 'Date', key: 'd', width: 12, value: (r) => logDayLabel(logDay(r.created_at)) },
          { header: 'Time', key: 't', width: 9, value: (r) => logTime(r.created_at) },
          { header: 'User', key: 'username', width: 20, value: (r) => String(r.username || '') },
          { header: 'Section', key: 'entity', width: 18, value: (r) => String(r.entity || '') },
          { header: 'Action', key: 'bucket', width: 12, value: (r) => BUCKET_LABEL[bucketOf(r.action)] },
          // The raw verb as well as the bucket: the bucket is for reading, the
          // verb is what somebody chasing a specific act will search for.
          { header: 'Logged as', key: 'action', width: 22, value: (r) => String(r.action || '') },
          { header: 'Details', key: 'detail', width: 44, value: (r) => logDetail(r) },
          { header: 'Device', key: 'ip', width: 16, value: (r) => String(r.ip || '') }
        ],
        rows
      })
      toast.success(`Exported ${rows.length} entries`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const MultiPick = ({
    label,
    all,
    picked,
    onChange
  }: {
    label: string
    all: string[]
    picked: string[]
    onChange: (v: string[]) => void
  }): React.JSX.Element => (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-10 min-w-[160px] items-center justify-between gap-2 rounded-[4px] border px-[11px]"
          style={{
            borderColor: picked.length ? '#0B3D2E' : '#C3D2C6',
            background: picked.length ? '#EFF5EC' : '#fff'
          }}
        >
          <span
            className="min-w-0 truncate text-[12.5px] font-bold"
            style={{ color: picked.length ? '#0B3D2E' : '#5A6B62' }}
          >
            {picked.length === 0 ? label : picked.length === 1 ? picked[0] : `${picked.length} selected`}
          </span>
          <ChevronDown className="h-[18px] w-[18px] flex-none text-[#5A6B62]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[320px] w-[250px] overflow-y-auto p-0">
        {all.length === 0 && <div className="px-3 py-4 text-[12px] font-semibold text-[#5A6B62]">Nothing logged yet.</div>}
        {all.map((v) => {
          const on = picked.includes(v)
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(on ? picked.filter((x) => x !== v) : [...picked, v])}
              className="flex h-10 w-full items-center gap-[9px] border-b border-b-[#EAF0E9] px-[11px] text-left last:border-b-0"
              style={{ background: on ? '#F1F5EF' : '#fff' }}
            >
              <span
                className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[3px] border-[1.5px]"
                style={{ background: on ? '#0B3D2E' : '#fff', borderColor: on ? '#0B3D2E' : '#C3D2C6' }}
              >
                {on && <Check className="h-3.5 w-3.5 text-white" />}
              </span>
              <span className={cn('min-w-0 truncate text-[12.5px]', on ? 'font-extrabold' : 'font-semibold')}>{v}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )

  const ActionTabs = (): React.JSX.Element => (
    <div className="flex gap-[3px] rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
      {TABS.map((k) => {
        const on = tab === k
        return (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-[11px] text-[11.5px] font-extrabold"
            style={{ background: on ? '#0B3D2E' : 'transparent', color: on ? '#fff' : '#33473E' }}
          >
            {k === 'all' ? 'All' : BUCKET_LABEL[k]}
            <span
              className="doc-ref rounded-[2px] px-[5px] py-[2px] text-[10px]"
              style={{
                background: on ? 'rgba(199,240,63,.22)' : '#DCE7DB',
                color: on ? '#C7F03F' : '#33473E'
              }}
            >
              {counts[k] || 0}
            </span>
          </button>
        )
      })}
    </div>
  )

  const LiveRail = (): React.JSX.Element => (
    <>
      <div className="flex flex-none items-center gap-[9px] bg-[#0B3D2E] px-4 py-[13px] text-white">
        <span className="h-[9px] w-[9px] flex-none rounded-full bg-[#C7F03F]" />
        <span className="min-w-0 flex-1 text-[10.5px] font-extrabold uppercase tracking-[.14em]">Live users</span>
        <span className="doc-ref text-[12px] font-bold text-[#C7F03F]">{live.length} online</span>
      </div>
      {live.map((u) => {
        const [bg, fg] = avatarOf(String(u.username || ''))
        const seen = ago(u.last_seen)
        return (
          <div key={String(u.id)} className="flex flex-none items-center gap-2.5 border-b border-b-[#EFF3EE] px-4 py-[11px]">
            <div
              className="flex h-8 w-8 flex-none items-center justify-center rounded-[3px] text-[11px] font-extrabold"
              style={{ background: bg, color: fg }}
            >
              {initialsOf(String(u.username))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="doc-ref truncate text-[12.5px] font-bold">{String(u.username)}</div>
              <div className="doc-ref mt-[3px] text-[10.5px] font-semibold text-[#5A6B62]">{String(u.ip || '—')}</div>
            </div>
            <div
              className="flex-none whitespace-nowrap text-[11px] font-extrabold"
              style={{ color: seen === 'just now' ? '#0B6B45' : '#5A6B62' }}
            >
              {seen}
            </div>
          </div>
        )
      })}
      {live.length === 0 && (
        <div className="flex-none px-4 py-6 text-center text-[12.5px] font-semibold text-[#5A6B62]">
          No users online right now.
        </div>
      )}
      <div className="flex-none border-y border-y-[#E4ECE3] border-t-[#D6E2D6] bg-[#F7FAF6] px-4 py-[13px]">
        <div className="text-[10.5px] font-extrabold uppercase tracking-[.14em]">Devices</div>
        <div className="mt-[5px] text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
          Each computer is a device, by IP. Deactivate one to block it from signing in.
        </div>
      </div>
      {ips.map((d) => {
        const off = !d.active
        const Ico = off ? MonitorOff : Monitor
        return (
          <div
            key={String(d.id)}
            className="flex-none border-b border-b-[#EFF3EE] px-4 py-[11px]"
            style={{ borderLeft: `3px solid ${off ? '#B3261E' : '#12855A'}` }}
          >
            <div className="flex items-center gap-[9px]">
              <Ico className="h-[18px] w-[18px] flex-none" style={{ color: off ? '#B3261E' : '#33473E' }} />
              <span className="doc-ref min-w-0 flex-1 truncate text-[12.5px] font-bold">{String(d.ip)}</span>
              <span
                className="flex-none rounded-[2px] border px-[7px] py-[3px] text-[9.5px] font-extrabold tracking-[.05em]"
                style={
                  off
                    ? { background: '#FDF3F2', color: '#B3261E', borderColor: '#F0D6D4' }
                    : { background: '#E9F5EE', color: '#0B6B45', borderColor: '#BFE3CB' }
                }
              >
                {off ? 'BLOCKED' : 'ACTIVE'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2.5">
              <span className="doc-ref min-w-0 flex-1 text-[10.5px] font-semibold text-[#5A6B62]">
                {logDate(d.last_seen) ? `${logDayLabel(logDay(d.last_seen))} ${logTime(d.last_seen)}` : '—'}
              </span>
              <button
                type="button"
                onClick={() => void toggleIp(d)}
                className="flex h-8 flex-none items-center whitespace-nowrap rounded-[3px] border-[1.5px] px-[11px] text-[11px] font-extrabold"
                style={
                  off
                    ? { borderColor: '#BFE3CB', background: '#F4FBF6', color: '#0B6B45' }
                    : { borderColor: '#F0D6D4', background: '#FDF3F2', color: '#B3261E' }
                }
              >
                {off ? 'ACTIVATE' : 'DEACTIVATE'}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )

  // Phone. After every hook, so the order cannot change between renders.
  if (__WEB__ && isMobile) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F1F5EF]">
        <div className="flex-none bg-[#0B3D2E] px-4 pb-3 pt-2.5 text-white">
          <MobileBar
            onRefresh={async () => {
              await load()
              await loadLogs()
            }}
          />
          <div className="text-[19px] font-extrabold tracking-[-0.02em]">User activity</div>
          <div className="mt-[3px] text-[11.5px] font-bold text-[#8FBFA8]">
            {rows.length} of {shaped.length} entries · kept {retention} days
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {kpis.map((k) => (
              <div key={k.k} className="min-w-0 rounded-[4px] bg-white/10 px-[11px] py-[9px]">
                <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{k.k}</div>
                <div className="doc-ref mt-[5px] text-[14px] font-bold text-white">{k.v}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-none overflow-x-auto border-b border-b-[#D6E2D6] bg-white">
          {([
            ['log', 'Activity', History],
            ['who', 'Who is on', Users]
          ] as const).map(([k, label, Ico]) => (
            <button
              key={k}
              type="button"
              onClick={() => setMTab(k)}
              className="flex h-[50px] flex-none items-center gap-[7px] whitespace-nowrap px-4 text-[12.5px] font-extrabold"
              style={{
                borderBottom: `3px solid ${mTab === k ? '#C7F03F' : 'transparent'}`,
                color: mTab === k ? '#0A1F17' : '#5A6B62'
              }}
            >
              <Ico className="h-[18px] w-[18px]" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-7 pt-3">
          {mTab === 'log' ? (
            <>
              <div className="flex h-11 flex-none items-center gap-[9px] rounded-[4px] border border-[#C3D2C6] bg-white px-3">
                <Search className="h-[19px] w-[19px] flex-none text-[#5A6B62]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search details…"
                  className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium outline-none"
                />
              </div>
              <div className="flex flex-none gap-[7px] overflow-x-auto pb-0.5">
                {TABS.map((k) => {
                  const on = tab === k
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setTab(k)}
                      className="flex h-11 flex-none items-center gap-[7px] whitespace-nowrap rounded-[4px] border border-[#DCE7DB] px-3.5 text-[12.5px] font-extrabold"
                      style={{ background: on ? '#0B3D2E' : '#fff', color: on ? '#fff' : '#33473E' }}
                    >
                      {k === 'all' ? 'All' : BUCKET_LABEL[k]}
                      <span
                        className="doc-ref rounded-[2px] px-[5px] py-[2px] text-[10.5px]"
                        style={{ background: on ? 'rgba(199,240,63,.22)' : '#DCE7DB', color: on ? '#C7F03F' : '#33473E' }}
                      >
                        {counts[k] || 0}
                      </span>
                    </button>
                  )
                })}
              </div>
              {rows.map((l, i) => {
                const t = TONE[l._bucket as Bucket]
                const [bg, fg] = avatarOf(String(l.username || ''))
                const Ico = t.icon
                const newDay = i === 0 || rows[i - 1]._day !== l._day
                return (
                  <div key={String(l.id)} className="flex flex-none flex-col gap-2.5">
                    {newDay && (
                      <div className="flex flex-wrap items-center gap-[9px] pt-[3px]">
                        <Clock className="h-4 w-4 flex-none text-[#0B3D2E]" />
                        <span className="doc-ref text-[12px] font-bold">{logDayLabel(l._day)}</span>
                        <span className="h-px min-w-[8px] flex-1 bg-[#DCE7DB]" />
                        <span className="whitespace-nowrap text-[10.5px] font-extrabold text-[#5A6B62]">
                          {dayCounts[l._day]} {dayCounts[l._day] === 1 ? 'entry' : 'entries'}
                        </span>
                      </div>
                    )}
                    <div
                      className="flex flex-col gap-[9px] rounded-[4px] border border-[#D6E2D6] bg-white px-[13px] py-3"
                      style={{ borderLeft: `3px solid ${t.mark}` }}
                    >
                      <div className="flex items-start gap-2.5">
                        <div
                          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[3px] text-[11px] font-extrabold"
                          style={{ background: bg, color: fg }}
                        >
                          {initialsOf(String(l.username))}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="doc-ref text-[12.5px] font-bold">{String(l.username || '—')}</div>
                          <div className="doc-ref mt-[3px] text-[10.5px] font-semibold text-[#5A6B62]">
                            {logTime(l.created_at)} · {String(l.ip || '—')}
                          </div>
                        </div>
                        <span
                          className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap rounded-[2px] border px-[7px] py-1 text-[10px] font-extrabold uppercase tracking-[.05em]"
                          style={{ background: t.bg, color: t.fg, borderColor: t.bd }}
                        >
                          <Ico className="h-3 w-3" />
                          {BUCKET_LABEL[l._bucket as Bucket]}
                        </span>
                      </div>
                      <div>
                        <span className="rounded-[2px] bg-[#EAF0E9] px-[7px] py-[3px] text-[10.5px] font-extrabold tracking-[.04em] text-[#33473E]">
                          {String(l.entity || '—')}
                        </span>
                        <div className="mt-[7px] text-[12.5px] font-bold leading-[1.45]">{logDetail(l)}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
              {!rows.length && (
                <div className="flex flex-none flex-col items-center gap-[9px] rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-8">
                  <FilterX className="h-7 w-7 text-[#C3D2C6]" />
                  <span className="text-[12.5px] font-bold text-[#5A6B62]">
                    {loading ? 'Loading…' : 'No activity matches these filters.'}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <LiveRail />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[62px] flex-none items-center justify-between gap-4 border-b border-b-[#D6E2D6] bg-white px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-[9px]">
            <History className="h-[22px] w-[22px] text-[#0B3D2E]" />
            <span className="text-[20px] font-extrabold tracking-[-0.02em]">User activity</span>
          </div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-[#5A6B62]">
            Every create, edit, delete and stage change across the app — who did it, when, and to what
          </div>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <div className="flex h-10 items-center gap-[9px] rounded-[4px] border border-[#C3D2C6] px-3">
            <Clock className="h-[18px] w-[18px] text-[#5A6B62]" />
            <span className="whitespace-nowrap text-[11.5px] font-bold text-[#5A6B62]">Keep for</span>
            <Select value={retention} onValueChange={(v) => void saveRetention(v)}>
              <SelectTrigger className="h-7 w-[92px] border-0 px-1 text-[12.5px] font-extrabold shadow-none focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTIONS.map((d) => (
                  <SelectItem key={d} value={d} className="text-[12.5px]">
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={() => void download()}
            className="flex h-10 items-center gap-[7px] rounded-[4px] border border-[#C3D2C6] px-3.5 text-[12.5px] font-bold hover:bg-[#EAF0E9]"
          >
            <Download className="h-[18px] w-[18px] text-[#33473E]" />
            Excel
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] pb-6 pt-4">
          <div className="grid flex-none gap-[11px]" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,190px),1fr))' }}>
            {kpis.map((k) => (
              <div
                key={k.k}
                className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
                style={{ borderTop: `3px solid ${k.accent}` }}
              >
                <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
                <div className="doc-ref mt-[5px] text-[23px] font-bold tracking-[-0.035em]" style={{ color: k.fg }}>
                  {k.v}
                </div>
                <div className="mt-[3px] text-[11.5px] font-semibold text-[#5A6B62]">{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-none flex-wrap items-center gap-[9px] rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-[11px]">
            <div className="flex h-10 min-w-[210px] flex-1 items-center gap-[9px] rounded-[4px] border border-[#C3D2C6] px-[11px]">
              <Search className="h-[19px] w-[19px] flex-none text-[#5A6B62]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search details…"
                className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-[#0A1F17] outline-none"
              />
            </div>
            <MultiPick label="All users" all={users} picked={pickedUsers} onChange={setPickedUsers} />
            <MultiPick label="All sections" all={sections} picked={pickedSections} onChange={setPickedSections} />
            <div className="w-[150px]"><DatePicker value={from} onChange={setFrom} max={to || undefined} /></div>
            <span className="text-[12px] font-semibold text-[#5A6B62]">to</span>
            <div className="w-[150px]"><DatePicker value={to} onChange={setTo} min={from || undefined} /></div>
            <ActionTabs />
            {anyFilter && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-[4px] border-[1.5px] border-[#F0D6D4] bg-[#FDF3F2] px-3 text-[11.5px] font-extrabold text-[#B3261E]"
              >
                <X className="h-4 w-4" />
                CLEAR
              </button>
            )}
          </div>

          <div className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div className="overflow-x-auto">
              <div className="min-w-[980px]">
                <div
                  className="grid min-h-9 items-center bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FBFA8]"
                  style={{ gridTemplateColumns: '110px 160px 140px 120px minmax(240px,1fr) 150px', borderLeft: '3px solid transparent' }}
                >
                  <span className="px-[9px] pl-[15px] text-white">When</span>
                  <span className="px-[9px]">User</span>
                  <span className="px-[9px]">Section</span>
                  <span className="px-[9px]">Action</span>
                  <span className="px-[9px] text-white">Details</span>
                  <span className="px-[9px] pr-[15px] text-right">Device</span>
                </div>
                {rows.map((l, i) => {
                  const t = TONE[l._bucket as Bucket]
                  const [bg, fg] = avatarOf(String(l.username || ''))
                  const Ico = t.icon
                  const newDay = i === 0 || rows[i - 1]._day !== l._day
                  const dev = ips.find((d) => String(d.ip) === String(l.ip))
                  return (
                    <div key={String(l.id)}>
                      {newDay && (
                        <div className="flex items-center gap-2.5 border-y border-y-[#DCE7DB] bg-[#EFF5EC] px-[15px] py-2">
                          <Clock className="h-4 w-4 flex-none text-[#0B3D2E]" />
                          <span className="doc-ref text-[12px] font-bold">{logDayLabel(l._day)}</span>
                          <span className="text-[10.5px] font-bold text-[#5A6B62]">
                            {l._day === today ? 'today' : ago(l.created_at)}
                          </span>
                          <span className="h-px min-w-[10px] flex-1 bg-[#DCE7DB]" />
                          <span className="text-[10.5px] font-extrabold tracking-[.06em] text-[#5A6B62]">
                            {dayCounts[l._day]} {dayCounts[l._day] === 1 ? 'entry' : 'entries'}
                          </span>
                        </div>
                      )}
                      <div
                        className="grid min-h-[52px] items-center border-b border-b-[#EFF3EE] bg-white"
                        style={{ gridTemplateColumns: '110px 160px 140px 120px minmax(240px,1fr) 150px', borderLeft: `3px solid ${t.mark}` }}
                      >
                        <div className="min-w-0 py-1.5 pl-3 pr-[9px]">
                          <div className="doc-ref whitespace-nowrap text-[12.5px] font-bold">{logTime(l.created_at)}</div>
                          <div className="mt-[3px] whitespace-nowrap text-[10.5px] font-semibold text-[#5A6B62]">
                            {ago(l.created_at)}
                          </div>
                        </div>
                        <div className="flex min-w-0 items-center gap-2 px-[9px] py-1.5">
                          <div
                            className="flex h-7 w-7 flex-none items-center justify-center rounded-[3px] text-[10.5px] font-extrabold"
                            style={{ background: bg, color: fg }}
                          >
                            {initialsOf(String(l.username))}
                          </div>
                          <span className="doc-ref min-w-0 truncate text-[12px] font-bold">{String(l.username || '—')}</span>
                        </div>
                        <div className="min-w-0 px-[9px] py-1.5">
                          <span className="inline-block max-w-full truncate rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[11px] font-extrabold tracking-[.04em] text-[#33473E]">
                            {String(l.entity || '—')}
                          </span>
                        </div>
                        <div className="min-w-0 px-[9px] py-1.5">
                          <span
                            className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-[.05em]"
                            style={{ background: t.bg, color: t.fg, borderColor: t.bd }}
                            title={`Logged as “${String(l.action)}”`}
                          >
                            <Ico className="h-[13px] w-[13px]" />
                            {BUCKET_LABEL[l._bucket as Bucket]}
                          </span>
                        </div>
                        <div className="min-w-0 px-[9px] py-1.5">
                          <div className="truncate text-[12.5px] font-bold leading-[1.4] text-[#0A1F17]" title={logDetail(l)}>
                            {logDetail(l)}
                          </div>
                          {/* The raw verb, small, under the detail. The chip
                              says which of the four questions this answers;
                              this says exactly what the app recorded — and the
                              two differ often enough to be worth both. */}
                          <div className="doc-ref mt-[3px] truncate text-[10.5px] font-semibold text-[#7C8A82]">
                            {String(l.action || '')}
                          </div>
                        </div>
                        <div className="min-w-0 py-1.5 pl-[9px] pr-[15px] text-right">
                          <div className="doc-ref whitespace-nowrap text-[11.5px] font-semibold text-[#5A6B62]">
                            {String(l.ip || '—')}
                          </div>
                          {dev && !dev.active && (
                            <div className="mt-[3px] text-[9.5px] font-extrabold tracking-[.05em] text-[#B3261E]">
                              BLOCKED SINCE
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!rows.length && (
                  <div className="flex flex-col items-center gap-[9px] px-5 py-12">
                    <FilterX className="h-[30px] w-[30px] text-[#C3D2C6]" />
                    <span className="text-[13px] font-bold text-[#5A6B62]">
                      {loading ? 'Loading…' : 'No activity matches these filters.'}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-[9px] bg-[#FBFDFA] px-[15px] py-[11px]">
              <Info className="h-[17px] w-[17px] flex-none text-[#A8B8AE]" />
              <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
                Up to 500 recent entries per query, newest first. Times are local. Anything older than the {retention}-day
                retention is deleted automatically.
              </span>
            </div>
          </div>
        </div>

        <div className="flex w-[340px] flex-none flex-col overflow-y-auto border-l border-l-[#D6E2D6] bg-white">
          <LiveRail />
        </div>
      </div>
    </div>
  )
}
