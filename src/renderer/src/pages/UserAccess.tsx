// User access — its own page, off the sidebar.
// -----------------------------------------------------------------------------
// It used to be a tab inside Settings, which put "who may open what" beside the
// database backup and the brand logo. Granting access is not a setting; it is a
// register of people, and it is the thing an admin opens most often after
// somebody joins or leaves.
//
// Two screens and no modal. The LIST answers who has what at a glance, and the
// FORM is the whole width of the page — the grid is twenty-eight rows by four
// ticks plus two day fields, and a dialog could only ever show a third of it.
//
// The form carries a digest rail on the right that says, in words, what the
// login will actually do. The grid states what is TICKED; the rail states what
// that MEANS, and the two being side by side is what stops a well-meaning row
// of ticks from handing the weighbridge the ledger.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Anchor,
  ArrowLeft,
  BellRing,
  BookOpenCheck,
  Boxes,
  Briefcase,
  Building2,
  Check,
  CircleSlash,
  ClipboardCheck,
  Contact,
  CornerDownRight,
  DoorOpen,
  Droplets,
  Eye,
  Factory,
  FileText,
  FlaskConical,
  Info,
  Landmark,
  LayoutDashboard,
  Lock,
  Package,
  PackageOpen,
  Pencil,
  Repeat,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Tag,
  Tags,
  Trash2,
  Truck,
  UserPlus,
  Wallet,
  Warehouse,
  type LucideIcon
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { MODULES } from '@/lib/modules'
import { clearEntryWindows } from '@/lib/useEntryWindow'
import { useIsMobile } from '@/lib/useIsMobile'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { cn } from '@/lib/utils'
import {
  FLAGS,
  parsePerms,
  rightsOf,
  scopeOf,
  setAllDays,
  setAllPerms,
  setColumn,
  setDesk,
  toggleFlag,
  windowsOf,
  writeRights,
  type Flag,
  type Perms,
  type Rights
} from '@/lib/userRights'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Display metadata for the grid. Deliberately NOT in lib/modules.ts: that file
// is the permission core, read by the router, the sidebar and the server gate,
// and it has no business knowing what icon a row draws. The keys are the same
// list, and a module missing from these maps still renders — with a default
// icon, under "Other" — rather than vanishing from the grid it is granted on.
const ICON_OF: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  bargains: FileText,
  orders: ShoppingCart,
  consignment: PackageOpen,
  gateEntry: DoorOpen,
  trading: Repeat,
  accounts: BookOpenCheck,
  treasuryLc: Landmark,
  treasuryBd: Landmark,
  treasuryTracker: Landmark,
  bankRecon: Wallet,
  categories: Tags,
  products: Boxes,
  formulation: FlaskConical,
  production: Factory,
  stock: Warehouse,
  salesBargains: ScrollText,
  sales: Tag,
  suppliers: Building2,
  transporters: Truck,
  customers: Contact,
  ports: Anchor,
  banks: Landmark,
  brokers: Briefcase,
  packaging: Package,
  companies: Building2,
  factories: Factory,
  approvals: ClipboardCheck,
  notifications: BellRing,
  settings: SettingsIcon
}
const GROUP_OF: Record<string, string> = {
  dashboard: 'Daily work',
  bargains: 'Daily work',
  orders: 'Daily work',
  consignment: 'Daily work',
  gateEntry: 'Daily work',
  trading: 'Daily work',
  salesBargains: 'Daily work',
  sales: 'Daily work',
  accounts: 'Money',
  treasuryLc: 'Money',
  treasuryBd: 'Money',
  treasuryTracker: 'Money',
  bankRecon: 'Money',
  formulation: 'Plant',
  production: 'Plant',
  stock: 'Plant',
  categories: 'Masters',
  products: 'Masters',
  suppliers: 'Masters',
  transporters: 'Masters',
  customers: 'Masters',
  ports: 'Masters',
  banks: 'Masters',
  brokers: 'Masters',
  packaging: 'Masters',
  companies: 'Masters',
  factories: 'Masters',
  approvals: 'System',
  notifications: 'System',
  settings: 'System'
}
const GROUPS = ['Daily work', 'Money', 'Plant', 'Masters', 'System', 'Other']

// The two the app decides for itself — see directLevel in lib/modules.ts. Shown
// LOCKED rather than as free tick boxes that would not be honoured: a box that
// does nothing is worse than no box.
const FIXED: Record<string, { note: string; adminOnly?: boolean }> = {
  approvals: { note: 'Everyone · full' },
  notifications: { note: 'Everyone · read', adminOnly: true }
}

// Treasury takes no row: it is reached by holding one of its three desks, so a
// parent tick beside three child ticks could only ever disagree with itself.
const GRID_MODULES = MODULES.filter((m) => !m.derived)
const GRID_KEYS = GRID_MODULES.map((m) => m.key)
const IS_SECTION = (key: string): boolean => key.startsWith('treasury') && key !== 'treasury'

const ROLES: { key: string; sub: string; icon: LucideIcon }[] = [
  { key: 'admin', sub: 'Everything, with no window', icon: ShieldCheck },
  { key: 'manager', sub: 'Reads the whole plant, keys most of it', icon: Contact },
  { key: 'operator', sub: 'Keys the pages of one desk', icon: Factory },
  { key: 'viewer', sub: 'Reads only, changes nothing', icon: Eye }
]

type Tone = { bg: string; fg: string; bd: string }
const roleTone = (r: string): Tone =>
  r === 'admin'
    ? { bg: '#EDE9FB', fg: '#3D3179', bd: '#D6CEF5' }
    : r === 'manager'
      ? { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0' }
      : r === 'viewer'
        ? { bg: '#EAF0E9', fg: '#33473E', bd: '#DCE7DB' }
        : { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' }

const initialsOf = (name: string): string =>
  String(name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?'

const DESKS = [
  {
    key: 'unload',
    module: 'sales',
    title: 'Special access — unloading desk only',
    body:
      'Turns the Sales page into a receiving list instead of the invoice register: Date / Invoice, Customer, Item and Dispatch status only, for FOR deliveries still out. Everything already unloaded, every Ex sale, and every rate, invoice value, GST and freight figure is left out of the data entirely — not merely hidden. The one thing this user can record is the received quantity on unloading.',
    override: 'The Sales row in the grid below is overridden while this is on.',
    bd: '#C2700A',
    bg: '#FFF4E0',
    ink: '#8A5300'
  },
  {
    key: 'readings',
    module: 'orders',
    title: 'Special access — technical parameters only',
    body:
      'The lab opens Purchase entries, sees the invoices, and records technical parameters against them — and that is the whole of it. No New purchase, no row menu, no stage moves, and the other two tabs are not there. Rates and values are withheld from this user whatever the screen shows.',
    override: 'The Purchases row in the grid below is overridden while this is on.',
    bd: '#1B4E82',
    bg: '#EAF0FA',
    ink: '#1B4E82'
  }
] as const

const LIST_GRID = 'minmax(200px,1.4fr) 130px 110px minmax(150px,1fr) 130px 120px 110px'
const PERM_GRID = 'minmax(200px,1fr) 76px 76px 76px 76px 128px 136px'

export function UserAccess(): React.JSX.Element {
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editing, setEditing] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)
  const [allView, setAllView] = useState('')
  const [allEdit, setAllEdit] = useState('')
  const [form, setForm] = useState<Row>({
    full_name: '',
    username: '',
    password: '',
    role: 'operator',
    active: true,
    permissions: { dashboard: { view: true } } as Perms
  })

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      setRows(await window.api.users.list())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const perms = (form.permissions || {}) as Perms
  const admin = String(form.role) === 'admin'
  const rights = (key: string): Rights => rightsOf(perms, key)
  const setPerms = (next: Perms): void => setForm((p) => ({ ...p, permissions: next }))

  const unloadOn = rights('sales').scope === 'unload'
  const readingsOn = rights('orders').scope === 'readings'

  // What the login actually gets, in words. Recomputed from the same rights the
  // grid draws, so the two cannot disagree.
  const granted = useMemo(
    () => GRID_MODULES.map((m) => ({ m, r: rightsOf(perms, m.key) })).filter((x) => x.r.view),
    [perms]
  )
  const writable = granted.filter((x) => x.r.create || x.r.edit || x.r.delete)

  const digestRows = granted.map(({ m, r }) => {
    const acts = [r.create && 'add', r.edit && 'change', r.delete && 'delete'].filter(Boolean) as string[]
    const scoped = r.scope === 'unload' || r.scope === 'readings'
    let text: string
    if (r.scope === 'unload') text = 'Receiving list only — records the received quantity on unloading. No rates, no values.'
    else if (r.scope === 'readings') text = 'Opens purchase entries and records technical parameters. Nothing else on the page.'
    else if (!acts.length) text = 'Reads the page, changes nothing.'
    else text = `Can ${acts.join(', ')}.`
    const win: string[] = []
    if (r.viewDays !== '') win.push(`sees the last ${r.viewDays} days`)
    if (r.editDays !== '' && acts.length) win.push(`may key back ${r.editDays} days`)
    return {
      key: m.key,
      label: m.label,
      icon: ICON_OF[m.key] || Droplets,
      mark: scoped ? (r.scope === 'unload' ? '#C2700A' : '#1B4E82') : acts.length ? '#12855A' : '#5A6B62',
      text: text + (win.length ? ` ${win.join('; ')}.` : '')
    }
  })

  const missing: string[] = []
  if (!String(form.username || '').trim()) missing.push('username')
  if (!editing && !String(form.password || '').trim()) missing.push('password')
  if (!admin && granted.length === 0) missing.push('at least one page')

  function openAdd(): void {
    setEditing(null)
    setAllView('')
    setAllEdit('')
    setForm({
      full_name: '',
      username: '',
      password: '',
      role: 'operator',
      active: true,
      permissions: { dashboard: { view: true } } as Perms
    })
    setView('form')
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setAllView('')
    setAllEdit('')
    setForm({
      full_name: row.full_name ?? '',
      username: row.username ?? '',
      password: '',
      role: row.role ?? 'viewer',
      active: !!row.active,
      permissions: parsePerms(row.permissions)
    })
    setView('form')
  }

  async function save(): Promise<void> {
    if (missing.length) {
      toast.error(`Still needed: ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    try {
      if (editing) await window.api.users.update(editing.id as number, form)
      else await window.api.users.create(form)
      // The day counts just moved; the next form to ask must not be handed the
      // window this session cached at login.
      clearEntryWindows()
      toast.success('User saved')
      setView('list')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete the login "${row.username}"? Their access goes with it.`)) return
    try {
      await window.api.users.remove(row.id as number)
      toast.success('Login deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (u) => !q || `${String(u.full_name || '')} ${String(u.username || '')}`.toLowerCase().includes(q)
  )

  const kpis = [
    {
      k: 'Logins',
      v: String(rows.length),
      sub: `${rows.filter((u) => u.active).length} active`,
      accent: '#0B3D2E',
      fg: '#0A1F17'
    },
    {
      k: 'Admins',
      v: String(rows.filter((u) => u.role === 'admin').length),
      sub: 'unrestricted access',
      accent: '#5B4BA8',
      fg: '#3D3179'
    },
    {
      k: 'Special access',
      v: String(rows.filter((u) => u.role !== 'admin' && scopeOf(parsePerms(u.permissions))).length),
      sub: 'one job, not a page',
      accent: '#C2700A',
      fg: '#8A5300'
    },
    {
      k: 'Switched off',
      v: String(rows.filter((u) => !u.active).length),
      sub: 'kept on record, cannot sign in',
      accent: '#B3261E',
      fg: '#B3261E'
    }
  ]

  // One row of the list, shaped once and used by both the table and the phone
  // cards so the two cannot describe the same login differently.
  const cardOf = (u: Row): Row => {
    const p = parsePerms(u.permissions)
    const all = u.role === 'admin'
    const scope = all ? '' : scopeOf(p)
    const count = Object.keys(p).length
    const t = roleTone(String(u.role))
    return {
      ...u,
      tone: t,
      initials: initialsOf(String(u.full_name || u.username)),
      mark: u.active ? (all ? '#5B4BA8' : '#12855A') : '#C3D2C6',
      access: all ? 'All pages' : `${count} ${count === 1 ? 'page' : 'pages'}`,
      accessFg: all ? '#3D3179' : '#0A1F17',
      scope,
      scopeBg: scope === 'Unloading desk' ? '#FFF4E0' : '#EAF0FA',
      scopeFg: scope === 'Unloading desk' ? '#8A5300' : '#1B4E82',
      scopeBd: scope === 'Unloading desk' ? '#F0E4CB' : '#C6DAF0',
      windows: all ? 'no limit' : windowsOf(p, GRID_KEYS),
      winFg: all ? '#5A6B62' : '#0A1F17'
    }
  }

  // Phone. After every hook, so the order cannot change between renders.
  if (__WEB__ && isMobile) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F1F5EF]">
        <div className="flex-none bg-[#0B3D2E] px-4 pb-3.5 pt-1 text-white">
          <div className="text-[19px] font-extrabold tracking-[-0.02em]">User access</div>
          <div className="mt-[3px] text-[11.5px] font-bold text-[#8FBFA8]">
            {rows.length} logins · {rows.filter((u) => u.active).length} active
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
        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-[100px] pt-3">
          {shown.map((raw) => {
            const u = cardOf(raw)
            return (
              <div
                key={String(u.id)}
                className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white"
                style={{ borderLeft: `3px solid ${u.mark}` }}
              >
                <div className="flex flex-col gap-2.5 px-[13px] py-3">
                  <div className="flex items-start gap-[11px]">
                    <div
                      className="flex h-10 w-10 flex-none items-center justify-center rounded-[4px] text-[13px] font-extrabold"
                      style={{ background: u.tone.bg, color: u.tone.fg }}
                    >
                      {u.initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-extrabold tracking-[-0.01em]">{String(u.full_name || '—')}</div>
                      <div className="doc-ref mt-[3px] text-[11.5px] font-semibold text-[#5A6B62]">{String(u.username)}</div>
                    </div>
                    <span
                      className="flex-none rounded-[2px] border px-[7px] py-1 text-[10px] font-extrabold tracking-[.05em]"
                      style={
                        u.active
                          ? { background: '#E9F5EE', color: '#0B6B45', borderColor: '#BFE3CB' }
                          : { background: '#EAF0E9', color: '#5A6B62', borderColor: '#DCE7DB' }
                      }
                    >
                      {u.active ? 'ACTIVE' : 'OFF'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-[7px]">
                    <span
                      className="rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-[.06em]"
                      style={{ background: u.tone.bg, color: u.tone.fg, borderColor: u.tone.bd }}
                    >
                      {String(u.role)}
                    </span>
                    {!!u.scope && (
                      <span
                        className="inline-flex items-center gap-[5px] rounded-[2px] border px-[7px] py-1 text-[9.5px] font-extrabold uppercase tracking-[.05em]"
                        style={{ background: u.scopeBg, color: u.scopeFg, borderColor: u.scopeBd }}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        {u.scope}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 border-t border-t-[#EAF0E9] bg-[#F7FAF6] px-[13px] py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Access</div>
                    <div className="mt-[3px] text-[12.5px] font-extrabold" style={{ color: u.accessFg }}>
                      {u.access}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-right">
                    <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Visible · entry</div>
                    <div className="doc-ref mt-[3px] text-[12.5px] font-bold" style={{ color: u.winFg }}>
                      {u.windows}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openEdit(raw)}
                  className="flex h-12 w-full items-center justify-center gap-2 border-t border-t-[#EAF0E9] bg-white text-[12.5px] font-extrabold text-[#33473E]"
                >
                  <Pencil className="h-[19px] w-[19px]" />
                  EDIT ACCESS
                </button>
              </div>
            )
          })}
          {/* Granting page by page is a grid twenty-eight rows deep. The phone
              says who has what and switches a login off; it does not pretend
              to be the place to build a grant. */}
          <div className="flex flex-none items-start gap-[9px] rounded-[4px] border border-[#E4ECE3] bg-[#F7FAF6] px-[13px] py-[11px]">
            <Info className="h-[17px] w-[17px] flex-none text-[#A8B8AE]" />
            <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
              Granting access page by page is a workstation job — the phone lists who has what and lets you switch a
              login off.
            </span>
          </div>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------ list --
  if (view === 'list') {
    return (
      <>
        <PageHeader
          title="User access"
          subtitle="Logins, what each one may open, and how far back they may read or key"
          hint="A user's access is a page-by-page grant plus two day windows: how far back rows are VISIBLE, and how far back they may be keyed or changed. Reading a week of history and keying a week late are different permissions, so they are granted separately."
          actions={
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  'flex h-10 w-[280px] items-center gap-2.5 rounded-[4px] border border-[#C3D2C6] bg-white px-3'
                )}
              >
                <Search className="h-[19px] w-[19px] flex-none text-[#5A6B62]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name or username"
                  className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-[#0A1F17] outline-none"
                />
              </div>
              <button
                type="button"
                onClick={openAdd}
                className="flex h-10 flex-none items-center gap-1.5 rounded-[4px] bg-[#C7F03F] px-4 text-[13px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E52F]"
              >
                <UserPlus className="h-[19px] w-[19px]" />
                New user
              </button>
            </div>
          }
        />
        <div className="flex flex-col gap-3 p-5">
          <div className="grid gap-[11px]" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))' }}>
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

          <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div className="overflow-x-auto">
              <div className="min-w-[1100px]">
                <div
                  className="grid min-h-[38px] items-center bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FBFA8]"
                  style={{ gridTemplateColumns: LIST_GRID }}
                >
                  <span className="px-[10px] pl-[18px] text-white">Name</span>
                  <span className="px-[9px]">Username</span>
                  <span className="px-[9px]">Role</span>
                  <span className="px-[9px]">Access</span>
                  <span className="px-[9px]">Windows</span>
                  <span className="px-[9px]">Status</span>
                  <span className="px-[9px] pr-[18px] text-right text-white">Actions</span>
                </div>
                {shown.map((raw) => {
                  const u = cardOf(raw)
                  return (
                    <div
                      key={String(u.id)}
                      onClick={() => openEdit(raw)}
                      className="grid min-h-[62px] cursor-pointer items-center border-b border-b-[#EAF0E9] bg-white hover:bg-[#FBFDFA]"
                      style={{ gridTemplateColumns: LIST_GRID, borderLeft: `3px solid ${u.mark}` }}
                    >
                      <div className="flex min-w-0 items-center gap-[11px] py-2 pl-[15px] pr-[10px]">
                        <div
                          className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] text-[12.5px] font-extrabold"
                          style={{ background: u.tone.bg, color: u.tone.fg }}
                        >
                          {u.initials}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13.5px] font-extrabold tracking-[-0.01em]">
                            {String(u.full_name || '—')}
                          </div>
                          <div className="mt-[3px] truncate text-[11px] font-bold text-[#5A6B62]">
                            {String(u.role) === 'admin' ? 'Unrestricted' : u.access}
                          </div>
                        </div>
                      </div>
                      <div className="doc-ref min-w-0 truncate px-[9px] text-[12.5px] font-semibold text-[#33473E]">
                        {String(u.username)}
                      </div>
                      <div className="px-[9px]">
                        <span
                          className="whitespace-nowrap rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-[.06em]"
                          style={{ background: u.tone.bg, color: u.tone.fg, borderColor: u.tone.bd }}
                        >
                          {String(u.role)}
                        </span>
                      </div>
                      <div className="min-w-0 px-[9px] py-2">
                        <div className="text-[12.5px] font-extrabold" style={{ color: u.accessFg }}>
                          {u.access}
                        </div>
                        {!!u.scope && (
                          <div
                            className="mt-[5px] inline-flex items-center gap-[5px] whitespace-nowrap rounded-[2px] border px-1.5 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.05em]"
                            style={{ background: u.scopeBg, color: u.scopeFg, borderColor: u.scopeBd }}
                          >
                            <ShieldCheck className="h-3 w-3" />
                            {u.scope}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 px-[9px] py-2">
                        <div className="doc-ref whitespace-nowrap text-[11.5px] font-bold" style={{ color: u.winFg }}>
                          {u.windows}
                        </div>
                        <div className="mt-[3px] text-[10px] font-bold text-[#5A6B62]">visible · entry</div>
                      </div>
                      <div className="px-[9px]">
                        <span
                          className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold tracking-[.05em]"
                          style={
                            u.active
                              ? { background: '#E9F5EE', color: '#0B6B45', borderColor: '#BFE3CB' }
                              : { background: '#EAF0E9', color: '#5A6B62', borderColor: '#DCE7DB' }
                          }
                        >
                          {u.active ? <Check className="h-[13px] w-[13px]" /> : <CircleSlash className="h-[13px] w-[13px]" />}
                          {u.active ? 'ACTIVE' : 'OFF'}
                        </span>
                      </div>
                      <div className="flex justify-end gap-1.5 px-[9px] pr-[18px]">
                        <button
                          type="button"
                          title="Edit access"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(raw)
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-[3px] border border-[#D6E2D6] hover:bg-[#EAF0E9]"
                        >
                          <Pencil className="h-[17px] w-[17px] text-[#33473E]" />
                        </button>
                        <button
                          type="button"
                          title="Delete user"
                          onClick={(e) => {
                            e.stopPropagation()
                            void del(raw)
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-[3px] border border-[#F0D6D4] bg-[#FDF3F2] hover:bg-[#FBE7E5]"
                        >
                          <Trash2 className="h-[17px] w-[17px] text-[#B3261E]" />
                        </button>
                      </div>
                    </div>
                  )
                })}
                {!shown.length && (
                  <div className="px-5 py-10 text-center text-[13px] font-semibold text-[#5A6B62]">
                    {loading ? 'Loading…' : q ? `No login matches “${query}”.` : 'No logins yet.'}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-[9px] px-1">
            <Info className="h-[17px] w-[17px] flex-none text-[#A8B8AE]" />
            <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
              A user&rsquo;s access is a page-by-page grant plus two day windows: how far back rows are{' '}
              <b>visible</b>, and how far back they may be <b>keyed or changed</b>. Reading a week of history and keying
              a week late are different permissions.
            </span>
          </div>
        </div>
      </>
    )
  }

  // ------------------------------------------------------------------ form --
  const flagTitle = (fl: Flag): string => fl
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[62px] flex-none items-center justify-between gap-4 border-b border-b-[#D6E2D6] bg-white px-5">
        <div className="flex min-w-0 items-center gap-[11px]">
          <button
            type="button"
            onClick={() => setView('list')}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-[4px] border border-[#C3D2C6] hover:bg-[#EAF0E9]"
          >
            <ArrowLeft className="h-[21px] w-[21px] text-[#33473E]" />
          </button>
          <div className="min-w-0">
            <div className="text-[20px] font-extrabold tracking-[-0.02em]">
              {editing ? 'Edit user access' : 'New user'}
            </div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-[#5A6B62]">
              One page per grant, and the two day windows that go with it
            </div>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <button
            type="button"
            onClick={() => setView('list')}
            className="flex h-10 items-center rounded-[4px] border-[1.5px] border-[#C3D2C6] px-[18px] text-[12.5px] font-extrabold tracking-[.03em] text-[#33473E] hover:bg-[#EAF0E9]"
          >
            CANCEL
          </button>
          <button
            type="button"
            disabled={saving || missing.length > 0}
            onClick={() => void save()}
            className="flex h-10 items-center gap-[7px] rounded-[4px] px-5 text-[12.5px] font-extrabold tracking-[.03em] disabled:cursor-not-allowed"
            style={
              missing.length
                ? { background: '#C3D2C6', color: '#F1F5EF' }
                : { background: '#0B3D2E', color: '#C7F03F' }
            }
          >
            <Check className="h-[19px] w-[19px]" />
            {saving ? 'SAVING…' : 'SAVE USER'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6 pt-4">
          {/* -------------------------------------------------- the login -- */}
          <div className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div className="border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-[11px] text-[10.5px] font-extrabold uppercase tracking-[.13em]">
              The login
            </div>
            <div className="grid gap-3.5 px-4 py-[15px]" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,190px),1fr))' }}>
              <Field label="Name">
                <input
                  value={String(form.full_name || '')}
                  onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))}
                  placeholder="Full name"
                  className="h-11 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-[11px] text-[13px] font-bold text-[#0A1F17] outline-none"
                />
              </Field>
              <Field label="Username" required>
                <input
                  value={String(form.username || '')}
                  onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                  placeholder="lowercase, no spaces"
                  className="doc-ref h-11 w-full rounded-[4px] border bg-white px-[11px] text-[13px] font-bold text-[#0A1F17] outline-none"
                  style={{ borderColor: String(form.username || '').trim() ? '#C3D2C6' : '#E3C58C' }}
                />
              </Field>
              <Field label={`Password${editing ? '' : ' *'}`}>
                <input
                  value={String(form.password || '')}
                  onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                  placeholder={editing ? 'leave blank to keep' : 'set a password'}
                  className="h-11 w-full rounded-[4px] border bg-white px-[11px] text-[13px] font-bold text-[#0A1F17] outline-none"
                  style={{ borderColor: !editing && !String(form.password || '').trim() ? '#E3C58C' : '#C3D2C6' }}
                />
                <div className="mt-1.5 text-[11px] font-semibold leading-[1.4] text-[#5A6B62]">
                  {editing ? 'Blank leaves the current password untouched.' : 'Required on a new login.'}
                </div>
              </Field>
              <Field label="Signed in">
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, active: !p.active }))}
                  className="flex h-11 w-full items-center gap-2.5 rounded-[4px] border border-[#C3D2C6] bg-white px-[11px]"
                >
                  <span
                    className="flex h-6 w-[42px] flex-none rounded-[3px] p-[3px]"
                    style={{
                      background: form.active ? '#0B3D2E' : '#C3D2C6',
                      justifyContent: form.active ? 'flex-end' : 'flex-start'
                    }}
                  >
                    <span className="h-[18px] w-[18px] rounded-[2px] bg-white" />
                  </span>
                  <span className="text-[12.5px] font-extrabold" style={{ color: form.active ? '#0B6B45' : '#5A6B62' }}>
                    {form.active ? 'Can sign in' : 'Cannot sign in'}
                  </span>
                </button>
              </Field>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-2 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Role</div>
              <div className="grid gap-[9px]" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))' }}>
                {ROLES.map((r) => {
                  const on = String(form.role) === r.key
                  const t = roleTone(r.key)
                  const Ico = r.icon
                  return (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, role: r.key }))}
                      className="rounded-[4px] border-[1.5px] px-3 py-[11px] text-left"
                      style={{ borderColor: on ? t.fg : '#DCE7DB', background: on ? t.bg : '#fff' }}
                    >
                      <div className="flex items-center gap-2">
                        <Ico className="h-[19px] w-[19px] flex-none" style={{ color: on ? t.fg : '#8CA396' }} />
                        <span className="text-[12.5px] font-extrabold capitalize" style={{ color: on ? t.fg : '#0A1F17' }}>
                          {r.key}
                        </span>
                        <span
                          className="ml-auto flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-2"
                          style={{ borderColor: on ? t.fg : '#C3D2C6' }}
                        >
                          {on && <span className="h-2 w-2 rounded-full" style={{ background: t.fg }} />}
                        </span>
                      </div>
                      <div
                        className="mt-1.5 text-[11px] font-semibold leading-[1.45]"
                        style={{ color: on ? t.fg : '#5A6B62' }}
                      >
                        {r.sub}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {admin ? (
            <div className="flex flex-none items-start gap-3 rounded-[4px] border border-[#D6CEF5] bg-[#EDE9FB] px-[18px] py-5" style={{ borderLeft: '4px solid #5B4BA8' }}>
              <ShieldCheck className="h-6 w-6 flex-none text-[#5B4BA8]" />
              <div className="min-w-0">
                <div className="text-[13.5px] font-extrabold text-[#3D3179]">
                  Admins have full read &amp; write access to every module.
                </div>
                <div className="mt-[5px] text-[12px] font-semibold leading-[1.55] text-[#4A3D8C]">
                  There is nothing to grant page by page, and no day window applies. Change the role to grant a narrower
                  set.
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* ------------------------------------------ special access -- */}
              <div className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-[11px]">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.13em]">
                    Special access · one job, not a set of ticks
                  </span>
                  <span className="text-[11.5px] font-bold text-[#5A6B62]">
                    {unloadOn || readingsOn ? 'One is on — it overrides that page below' : 'Both off'}
                  </span>
                </div>
                <div className="flex flex-col gap-[11px] px-4 py-3.5">
                  {DESKS.map((d) => {
                    const on = d.key === 'unload' ? unloadOn : readingsOn
                    return (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => setPerms(setDesk(perms, d.module, d.key, !on))}
                        className="flex items-start gap-3 rounded-[4px] border-[1.5px] px-3.5 py-[13px] text-left"
                        style={{
                          borderColor: on ? d.bd : `${d.bd}80`,
                          borderStyle: on ? 'solid' : 'dashed',
                          background: on ? d.bg : '#FBFDFA'
                        }}
                      >
                        <span
                          className="flex h-[26px] w-11 flex-none rounded-[3px] p-[3px]"
                          style={{ background: on ? d.bd : '#C3D2C6', justifyContent: on ? 'flex-end' : 'flex-start' }}
                        >
                          <span className="h-5 w-5 rounded-[2px] bg-white" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-[9px]">
                            <ShieldCheck className="h-[19px] w-[19px] flex-none" style={{ color: d.ink }} />
                            <span className="text-[13px] font-extrabold" style={{ color: d.ink }}>
                              {d.title}
                            </span>
                            <span
                              className="rounded-[2px] px-2 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[.09em]"
                              style={
                                on
                                  ? { background: d.bd, color: '#fff' }
                                  : { background: '#DCE7DB', color: '#5A6B62' }
                              }
                            >
                              {on ? 'ON' : 'OFF'}
                            </span>
                          </div>
                          <div className="mt-[7px] text-[12px] font-semibold leading-[1.6]" style={{ color: d.ink }}>
                            {d.body}
                          </div>
                          {on && (
                            <div
                              className="mt-[9px] rounded-[3px] px-2.5 py-[7px] text-[11.5px] font-bold"
                              style={{ background: `${d.bd}29`, color: d.ink }}
                            >
                              {d.override}
                            </div>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* ------------------------------------------- module access -- */}
              <div className="flex-none overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-[11px]">
                  <span className="text-[10.5px] font-extrabold uppercase tracking-[.13em]">Module access</span>
                  <div className="flex flex-wrap items-center gap-[7px]">
                    {(
                      [
                        { label: 'ALL READ', icon: Eye, level: 'read' as const, bd: '#C3D2C6', bg: '#fff', fg: '#33473E' },
                        { label: 'ALL WRITE', icon: Pencil, level: 'write' as const, bd: '#C3D2C6', bg: '#fff', fg: '#33473E' },
                        { label: 'CLEAR', icon: CircleSlash, level: 'none' as const, bd: '#F0D6D4', bg: '#FDF3F2', fg: '#B3261E' }
                      ] as const
                    ).map((p) => {
                      const Ico = p.icon
                      return (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => setPerms(setAllPerms(GRID_KEYS, p.level))}
                          className="flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[3px] border-[1.5px] px-3 text-[11.5px] font-extrabold"
                          style={{ borderColor: p.bd, background: p.bg, color: p.fg }}
                        >
                          <Ico className="h-4 w-4" />
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 border-b border-b-[#EAF0E9] bg-[#FBFDFA] px-4 py-[11px]">
                  <span className="text-[11.5px] font-bold text-[#5A6B62]">Set every module below —</span>
                  {(
                    [
                      ['Visible for', allView, setAllView, 'viewDays' as const],
                      ['Entry window', allEdit, setAllEdit, 'editDays' as const]
                    ] as const
                  ).map(([label, val, setVal, field]) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="text-[11.5px] font-extrabold">{label}</span>
                      <input
                        value={val}
                        onChange={(e) => {
                          setVal(e.target.value)
                          setPerms(setAllDays(perms, GRID_KEYS, field, e.target.value))
                        }}
                        placeholder="days"
                        className="doc-ref h-9 w-[74px] rounded-[3px] border border-[#C3D2C6] bg-white px-[9px] text-right text-[12.5px] font-bold text-[#0A1F17] outline-none"
                      />
                      <span className="text-[11.5px] font-semibold text-[#5A6B62]">days</span>
                    </div>
                  ))}
                  <span className="ml-auto max-w-[340px] text-right text-[11px] font-semibold text-[#5A6B62]">
                    A week of history to read and two days to key is the common setup.
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <div className="min-w-[900px]">
                    <div
                      className="grid items-stretch bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#8FBFA8]"
                      style={{ gridTemplateColumns: PERM_GRID, borderLeft: '3px solid transparent' }}
                    >
                      <span className="flex items-center py-2.5 pl-[18px] pr-[9px] text-white">Page</span>
                      {FLAGS.map((fl) => (
                        <div
                          key={fl}
                          className="flex flex-col items-center gap-[5px] border-l border-l-[#C7F03F]/[.14] px-1 py-2"
                          style={{
                            background:
                              fl === 'view'
                                ? 'rgba(255,255,255,.04)'
                                : fl === 'delete'
                                  ? 'rgba(179,38,30,.16)'
                                  : 'rgba(199,240,63,.1)'
                          }}
                        >
                          <span style={{ color: fl === 'delete' ? '#F0AFAA' : fl === 'view' ? '#fff' : '#C7F03F' }}>
                            {fl}
                          </span>
                          <span className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPerms(setColumn(perms, GRID_KEYS, fl, true))}
                              className="text-[9.5px] font-extrabold tracking-[.04em] text-[#C7F03F] hover:underline"
                            >
                              ALL
                            </button>
                            <button
                              type="button"
                              onClick={() => setPerms(setColumn(perms, GRID_KEYS, fl, false))}
                              className="text-[9.5px] font-extrabold tracking-[.04em] text-[#8FBFA8] hover:underline"
                            >
                              NONE
                            </button>
                          </span>
                        </div>
                      ))}
                      <div className="flex flex-col items-end justify-center gap-[3px] border-l border-l-[#C7F03F]/[.14] px-[9px] py-2">
                        <span className="text-white">Visible for</span>
                        <span className="text-[8.5px] font-bold normal-case tracking-[.04em]">days · blank = all</span>
                      </div>
                      <div className="flex flex-col items-end justify-center gap-[3px] border-l border-l-[#C7F03F]/[.14] py-2 pl-[9px] pr-[18px]">
                        <span className="text-white">Entry window</span>
                        <span className="text-[8.5px] font-bold normal-case tracking-[.04em]">
                          days · blank = no limit
                        </span>
                      </div>
                    </div>

                    {GROUPS.flatMap((g) => GRID_MODULES.filter((m) => (GROUP_OF[m.key] || 'Other') === g)).map(
                      (m, i, arr) => {
                        const r = rights(m.key)
                        const on = r.view || r.create || r.edit || r.delete
                        const scoped = r.scope === 'unload' || r.scope === 'readings'
                        const writes = r.create || r.edit || r.delete
                        const fixed = FIXED[m.key]
                        const fixedNote = fixed ? (fixed.adminOnly ? (admin ? 'Admin · full' : 'Everyone · read') : fixed.note) : ''
                        const group = GROUP_OF[m.key] || 'Other'
                        const newGroup = i === 0 || (GROUP_OF[arr[i - 1].key] || 'Other') !== group
                        const section = IS_SECTION(m.key)
                        const Ico = ICON_OF[m.key] || Droplets
                        const mark = scoped
                          ? r.scope === 'unload'
                            ? '#C2700A'
                            : '#1B4E82'
                          : on
                            ? '#12855A'
                            : 'transparent'
                        return (
                          <div key={m.key}>
                            {newGroup && (
                              <div className="border-y border-y-[#DCE7DB] bg-[#EFF5EC] px-[18px] py-[7px] text-[9px] font-extrabold uppercase tracking-[.15em] text-[#33473E]">
                                {group}
                              </div>
                            )}
                            <div
                              className="grid min-h-[44px] items-center border-b border-b-[#EFF3EE]"
                              style={{
                                gridTemplateColumns: PERM_GRID,
                                borderLeft: `3px solid ${mark}`,
                                opacity: on ? 1 : 0.62,
                                background: scoped ? (r.scope === 'unload' ? '#FFFBF2' : '#F4F8FD') : '#fff'
                              }}
                            >
                              <div
                                className="flex min-w-0 items-center gap-[9px] py-1.5 pr-[9px]"
                                style={{ paddingLeft: section ? 30 : 15 }}
                              >
                                {section && <CornerDownRight className="h-[15px] w-[15px] flex-none text-[#A8B8AE]" />}
                                <Ico
                                  className="h-[17px] w-[17px] flex-none"
                                  style={{ color: on ? '#33473E' : '#A8B8AE' }}
                                />
                                <span className="min-w-0 truncate text-[12.5px] font-bold">{m.label}</span>
                                {scoped && (
                                  <span
                                    className="flex-none whitespace-nowrap rounded-[2px] px-1.5 py-[3px] text-[9px] font-extrabold uppercase tracking-[.06em] text-white"
                                    style={{ background: r.scope === 'unload' ? '#C2700A' : '#1B4E82' }}
                                  >
                                    {r.scope === 'unload' ? 'unloading desk' : 'readings desk'}
                                  </span>
                                )}
                                {!!fixed && (
                                  <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-[2px] bg-[#EAF0E9] px-1.5 py-[3px] text-[9px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">
                                    <Lock className="h-3 w-3" />
                                    {fixedNote}
                                  </span>
                                )}
                              </div>
                              {FLAGS.map((fl) => {
                                const locked = scoped || !!fixed
                                const ticked = fixed
                                  ? fixed.adminOnly
                                    ? admin || fl === 'view'
                                    : true
                                  : r[fl]
                                return (
                                  <button
                                    key={fl}
                                    type="button"
                                    title={
                                      fixed
                                        ? `The app fixes this one — ${fixedNote}`
                                        : scoped
                                          ? 'Fixed by the special access above'
                                          : flagTitle(fl)
                                    }
                                    onClick={() => {
                                      if (!locked) setPerms(toggleFlag(perms, m.key, fl))
                                    }}
                                    className={cn(
                                      'flex items-stretch justify-center self-stretch border-l border-l-[#EFF3EE]',
                                      locked ? 'cursor-default' : 'cursor-pointer hover:bg-[#F4F8F3]'
                                    )}
                                    style={{
                                      background: fl === 'delete' && ticked && !locked ? '#FDF3F2' : 'transparent'
                                    }}
                                  >
                                    <span className="flex items-center justify-center">
                                      <span
                                        className="flex h-5 w-5 items-center justify-center rounded-[3px] border-[1.5px]"
                                        style={{
                                          background: ticked
                                            ? locked
                                              ? '#C3D2C6'
                                              : fl === 'delete'
                                                ? '#B3261E'
                                                : '#0B3D2E'
                                            : '#fff',
                                          borderColor: ticked
                                            ? locked
                                              ? '#C3D2C6'
                                              : fl === 'delete'
                                                ? '#B3261E'
                                                : '#0B3D2E'
                                            : locked
                                              ? '#E4ECE3'
                                              : '#C3D2C6'
                                        }}
                                      >
                                        {ticked &&
                                          (locked ? (
                                            <Lock className="h-3 w-3 text-white" />
                                          ) : (
                                            <Check className="h-[15px] w-[15px] text-white" />
                                          ))}
                                      </span>
                                    </span>
                                  </button>
                                )
                              })}
                              <div className="flex justify-end border-l border-l-[#EFF3EE] px-[9px] py-1.5">
                                <input
                                  value={r.viewDays}
                                  onChange={(e) => setPerms(writeRights(perms, m.key, { ...r, viewDays: e.target.value }))}
                                  placeholder={r.view ? 'all' : '—'}
                                  disabled={!r.view}
                                  className="doc-ref h-8 w-[78px] rounded-[3px] border px-2 text-right text-[12px] font-bold outline-none"
                                  style={{
                                    borderColor: r.view ? '#C3D2C6' : '#EAF0E9',
                                    background: r.view ? '#fff' : '#F7FAF6',
                                    color: r.view ? '#0A1F17' : '#C3D2C6'
                                  }}
                                />
                              </div>
                              <div className="flex justify-end border-l border-l-[#EFF3EE] py-1.5 pl-[9px] pr-[18px]">
                                <input
                                  value={r.editDays}
                                  onChange={(e) => setPerms(writeRights(perms, m.key, { ...r, editDays: e.target.value }))}
                                  placeholder={writes ? 'no limit' : '—'}
                                  disabled={!writes}
                                  className="doc-ref h-8 w-[78px] rounded-[3px] border px-2 text-right text-[12px] font-bold outline-none"
                                  style={{
                                    borderColor: writes ? '#C3D2C6' : '#EAF0E9',
                                    background: writes ? '#fff' : '#F7FAF6',
                                    color: writes ? '#0A1F17' : '#C3D2C6'
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )
                      }
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-[9px] bg-[#FBFDFA] px-4 py-3">
                  <Info className="h-[17px] w-[17px] flex-none text-[#A8B8AE]" />
                  <span className="text-[11.5px] font-semibold leading-[1.55] text-[#5A6B62]">
                    Nothing can be done to a page this user cannot see, so clearing <b>View</b> clears the rest of the
                    row, and ticking any of the other three turns View on. <b>Create</b> without <b>Edit</b> means they
                    can add entries but not change one afterwards. A <b>visible</b> window hides older rows outright; an{' '}
                    <b>entry</b> window only stops them being keyed or changed. <b>Treasury</b> takes no row of its own —
                    it is reached by holding one of its three desks, so a parent tick beside three child ticks could only
                    disagree with itself. <b>Approvals</b> and <b>Notifications</b> are fixed by the app and shown locked.
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ------------------------------------------------- the digest -- */}
        <div className="flex w-[360px] flex-none flex-col border-l border-l-[#D6E2D6] bg-white">
          <div className="flex-none bg-[#0B3D2E] px-4 py-3.5 text-white">
            <div className="text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              What this user gets
            </div>
            <div className="mt-[5px] text-[15px] font-extrabold tracking-[-0.01em]">
              {admin
                ? `${String(form.full_name || 'This admin')} opens every page`
                : granted.length === 0
                  ? 'No pages granted'
                  : `${String(form.full_name || 'This user')} opens ${granted.length} ${granted.length === 1 ? 'page' : 'pages'}`}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[11px] overflow-y-auto px-4 py-3.5">
            <div className="flex flex-none flex-col gap-2.5 rounded-[4px] border border-[#E4ECE3] bg-[#F7FAF6] px-[13px] py-3">
              {(
                [
                  ['Pages they can open', admin ? `all ${GRID_KEYS.length}` : String(granted.length), '#0A1F17'],
                  [
                    'Pages they can change',
                    admin ? `all ${GRID_KEYS.length}` : String(writable.length),
                    writable.length || admin ? '#0B6B45' : '#5A6B62'
                  ],
                  [
                    'Special access',
                    unloadOn ? 'unloading desk' : readingsOn ? 'readings desk' : 'none',
                    unloadOn ? '#8A5300' : readingsOn ? '#1B4E82' : '#5A6B62'
                  ]
                ] as const
              ).map(([k, v, fg]) => (
                <div key={k} className="flex items-baseline justify-between gap-2.5">
                  <span className="min-w-0 text-[11.5px] font-bold text-[#5A6B62]">{k}</span>
                  <span className="doc-ref flex-none whitespace-nowrap text-[13.5px] font-bold" style={{ color: fg }}>
                    {v}
                  </span>
                </div>
              ))}
            </div>

            {!admin &&
              digestRows.map((d) => {
                const Ico = d.icon
                return (
                  <div
                    key={d.key}
                    className="flex-none rounded-[4px] border border-[#E4ECE3] px-3 py-2.5"
                    style={{ borderLeft: `3px solid ${d.mark}` }}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Ico className="h-4 w-4 flex-none" style={{ color: d.mark }} />
                      <span className="min-w-0 truncate text-[12.5px] font-extrabold">{d.label}</span>
                    </div>
                    <div className="mt-[5px] text-[11.5px] font-semibold leading-[1.5] text-[#33473E]">{d.text}</div>
                  </div>
                )
              })}

            {!admin && digestRows.length === 0 && (
              <div className="flex flex-none flex-col items-center gap-2 rounded-[4px] border border-dashed border-[#C3D2C6] px-3.5 py-6">
                <Lock className="h-[26px] w-[26px] text-[#C3D2C6]" />
                <span className="text-center text-[12px] font-bold text-[#5A6B62]">
                  Nothing granted yet — this login would open to an empty app.
                </span>
              </div>
            )}
          </div>

          <div
            className="flex flex-none items-start gap-[9px] border-t border-t-[#D6E2D6] bg-[#F7FAF6] px-4 py-[13px]"
            style={{ color: missing.length ? '#8A5300' : '#0B6B45' }}
          >
            {missing.length ? <Info className="h-[17px] w-[17px] flex-none" /> : <Check className="h-[17px] w-[17px] flex-none" />}
            <span className="text-[11.5px] font-bold leading-[1.45]">
              {missing.length
                ? `${missing.length} still needed: ${missing.join(', ')}.`
                : editing
                  ? 'Saving replaces this login’s access from the next time they sign in.'
                  : 'Saving creates the login and lets them sign in straight away.'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
        {label}
        {required && <span className="text-[#B3261E]"> *</span>}
      </div>
      {children}
    </div>
  )
}
