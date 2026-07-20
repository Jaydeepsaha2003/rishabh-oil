import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import type { AppUser } from '@/lib/session'
import { MODULES, canWrite } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const ROLES = ['admin', 'manager', 'operator', 'viewer']

function parsePerms(value: unknown): Record<string, string> {
  if (!value) return {}
  try {
    const p = JSON.parse(String(value))
    if (Array.isArray(p)) {
      const out: Record<string, string> = {}
      for (const k of p) out[String(k)] = 'write'
      return out
    }
    return p && typeof p === 'object' ? (p as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function accessLabel(u: Row): string {
  if (u.role === 'admin') return 'All'
  return `${Object.keys(parsePerms(u.permissions)).length} modules`
}

function UsersManager(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setRows(await window.api.users.list())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function openAdd(): void {
    setEditing(null)
    setForm({
      full_name: '',
      username: '',
      password: '',
      role: 'operator',
      active: true,
      permissions: { dashboard: 'read' }
    })
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      full_name: row.full_name ?? '',
      username: row.username ?? '',
      password: '',
      role: row.role ?? 'viewer',
      active: !!row.active,
      permissions: parsePerms(row.permissions)
    })
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((p) => ({ ...p, [key]: value }))
  }

  function setPerm(key: string, level: string): void {
    setForm((p) => {
      const perms = { ...(p.permissions || {}) }
      if (level === 'none') delete perms[key]
      else perms[key] = level
      return { ...p, permissions: perms }
    })
  }

  async function save(): Promise<void> {
    if (!form.username) {
      toast.error('Username is required')
      return
    }
    if (!editing && !form.password) {
      toast.error('Password is required')
      return
    }
    setSaving(true)
    try {
      if (editing) await window.api.users.update(editing.id as number, form)
      else await window.api.users.create(form)
      toast.success('User saved')
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete user "${row.username}"?`)) return
    try {
      await window.api.users.remove(row.id as number)
      toast.success('User deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">Users</h3>
          <p className="text-xs text-muted-foreground">Create logins and assign roles.</p>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-[90px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No users yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((u) => (
                <TableRow key={u.id as number}>
                  <TableCell className="font-medium">{u.full_name ?? '—'}</TableCell>
                  <TableCell>{u.username}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === 'admin' ? 'default' : 'muted'}>{u.role}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{accessLabel(u)}</TableCell>
                  <TableCell>{u.active ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(u)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => del(u)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.username}` : 'Add user'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Full name</Label>
              <Input value={form.full_name ?? ''} onChange={(e) => setField('full_name', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Username *</Label>
                <Input
                  value={form.username ?? ''}
                  onChange={(e) => setField('username', e.target.value)}
                  disabled={!!editing}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setField('role', v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{editing ? 'New password (leave blank to keep)' : 'Password *'}</Label>
              <Input
                type="password"
                value={form.password ?? ''}
                onChange={(e) => setField('password', e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-1.5">
              <span className="text-sm">Active</span>
              <Switch checked={!!form.active} onCheckedChange={(v) => setField('active', v)} />
            </div>

            {form.role === 'admin' ? (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Admins have full read &amp; write access to every module.
              </p>
            ) : (
              <div className="grid gap-1.5">
                <Label>Module access</Label>
                <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                  {MODULES.map((m) => (
                    <div key={m.key} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                      <span>{m.label}</span>
                      <Select
                        value={(form.permissions || {})[m.key] || 'none'}
                        onValueChange={(v) => setPerm(m.key, v)}
                      >
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No access</SelectItem>
                          <SelectItem value="read">Read</SelectItem>
                          <SelectItem value="write">Read &amp; write</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Read lets them view; Read &amp; write lets them add, edit and delete.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const sourceFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Kandla port' },
  { key: 'transit_days', label: 'Transit days', type: 'number', default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]
const sourceColumns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'transit_days', label: 'Transit days', align: 'right' }
]

const companyFields: FieldDef[] = [
  { key: 'name', label: 'Company name', type: 'text', required: true },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]
const companyColumns: ColumnDef[] = [
  { key: 'name', label: 'Company' },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

function GeneralSettings(): React.JSX.Element {
  const [shortage, setShortage] = useState('')
  const [uom, setUom] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.settings.all().then((s) => {
      setShortage(s.allowed_shortage_pct ?? '0.2')
      setUom(s.default_uom ?? 'ton')
    })
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await window.api.settings.set('allowed_shortage_pct', shortage)
      await window.api.settings.set('default_uom', uom)
      toast.success('Settings saved')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="max-w-md p-6">
      <h3 className="mb-4 text-base font-medium">General</h3>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label>Allowed shortage % (edible oil tankers)</Label>
          <Input
            type="number"
            value={shortage}
            onChange={(e) => setShortage(e.target.value)}
            placeholder="0.2"
          />
          <p className="text-xs text-muted-foreground">
            Shortage beyond this tolerance is charged to the transporter at the bargain rate.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label>Default unit of measure</Label>
          <Input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="ton" />
        </div>
        <div>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function AccessPanel(): React.JSX.Element {
  const [live, setLive] = useState<Row[]>([])
  const [ips, setIps] = useState<Row[]>([])
  const [logs, setLogs] = useState<Row[]>([])
  const [logUsers, setLogUsers] = useState<string[]>([])
  const [logEntities, setLogEntities] = useState<string[]>([])
  const [filter, setFilter] = useState<Row>({ username: '', entity: '', q: '', from: '', to: '' })
  const [retention, setRetention] = useState('30')

  const load = useCallback(async () => {
    const [l, i, s] = await Promise.all([
      window.api.access.liveUsers(),
      window.api.access.ips(),
      window.api.settings.all()
    ])
    setLive(l)
    setIps(i)
    setRetention(s.log_retention_days ?? '30')
  }, [])

  const loadLogs = useCallback(async () => {
    const f: Row = {}
    if (filter.username) f.username = filter.username
    if (filter.entity) f.entity = filter.entity
    if (filter.q) f.q = filter.q
    if (filter.from) f.from = filter.from
    if (filter.to) f.to = filter.to
    const res = await window.api.access.logs(f)
    setLogs(res.rows)
    setLogUsers(res.users)
    setLogEntities(res.entities)
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadLogs()
  }, [loadLogs])

  useLiveRefresh(load)
  useLiveRefresh(loadLogs)

  // Live presence doesn't bump the global revision, so poll it directly.
  useEffect(() => {
    const id = setInterval(() => {
      window.api.access.liveUsers().then(setLive)
    }, 10000)
    return () => clearInterval(id)
  }, [])

  async function toggleIp(ip: Row): Promise<void> {
    try {
      await window.api.access.setIp(ip.id as number, !ip.active)
      toast.success(ip.active ? 'Device deactivated' : 'Device activated')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function saveRetention(v: string): Promise<void> {
    setRetention(v)
    await window.api.settings.set('log_retention_days', v)
    toast.success(`Logs kept for ${v} days`)
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-medium">Live users</h3>
          <Badge variant="success">{live.length} online</Badge>
        </div>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users online right now.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Device IP</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {live.map((s) => (
                <TableRow key={s.id as number}>
                  <TableCell className="font-medium">{s.username}</TableCell>
                  <TableCell>{s.ip}</TableCell>
                  <TableCell className="text-muted-foreground">{s.last_seen}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-2 text-base font-medium">Devices</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Each computer is a device (by IP). Deactivate one to block it from signing in.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>IP</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ips.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  No devices have connected yet.
                </TableCell>
              </TableRow>
            ) : (
              ips.map((ip) => (
                <TableRow key={ip.id as number}>
                  <TableCell className="font-medium">{ip.ip}</TableCell>
                  <TableCell className="text-muted-foreground">{ip.last_seen}</TableCell>
                  <TableCell>
                    <Badge variant={ip.active ? 'success' : 'destructive'}>
                      {ip.active ? 'Active' : 'Blocked'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => toggleIp(ip)}>
                      {ip.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-medium">Activity log</h3>
            <p className="text-xs text-muted-foreground">Every create, edit, delete and status change across the app — who did it, when, and to what.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Keep for</span>
            <Select value={retention} onValueChange={saveRetention}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            placeholder="Search details…"
            value={filter.q}
            onChange={(e) => setFilter((p) => ({ ...p, q: e.target.value }))}
          />
          <Select value={filter.username || 'ALL'} onValueChange={(v) => setFilter((p) => ({ ...p, username: v === 'ALL' ? '' : v }))}>
            <SelectTrigger><SelectValue placeholder="All users" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All users</SelectItem>
              {logUsers.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filter.entity || 'ALL'} onValueChange={(v) => setFilter((p) => ({ ...p, entity: v === 'ALL' ? '' : v }))}>
            <SelectTrigger><SelectValue placeholder="All sections" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sections</SelectItem>
              {logEntities.map((en) => <SelectItem key={en} value={en}>{en}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="date" value={filter.from} onChange={(e) => setFilter((p) => ({ ...p, from: e.target.value }))} />
          <Input type="date" value={filter.to} onChange={(e) => setFilter((p) => ({ ...p, to: e.target.value }))} />
        </div>

        <div className="max-h-[28rem] overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Device</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No activity matches these filters.
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((l) => (
                  <TableRow key={l.id as number}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{l.created_at}</TableCell>
                    <TableCell className="font-medium">{l.username}</TableCell>
                    <TableCell>{l.entity || '—'}</TableCell>
                    <TableCell className="capitalize">{l.action}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-muted-foreground" title={String(l.detail || '')}>{l.detail || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{l.ip}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Showing up to 500 recent entries. Older entries are deleted automatically based on the retention above.
        </p>
      </Card>
    </div>
  )
}

function UpdatePanel(): React.JSX.Element {
  const [version, setVersion] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [status, setStatus] = useState<Record<string, any>>({ state: 'idle' })
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.updates.version().then(setVersion).catch(() => {})
    const off = window.api.updates.onStatus((s) => setStatus(s))
    return off
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    setStatus({ state: 'checking' })
    try {
      const r = await window.api.updates.check()
      if (!r.ok) setStatus({ state: r.message?.includes('installed app') ? 'dev' : 'error', message: r.message })
    } catch (e) {
      setStatus({ state: 'error', message: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }

  const st = status.state
  return (
    <Card className="max-w-xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Rishabh Oil</h3>
          <p className="text-sm text-muted-foreground">Current version {version || '—'}</p>
        </div>
        <Button onClick={check} disabled={checking || st === 'downloading'}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      <div className="mt-4 rounded-lg border bg-muted/30 p-4 text-sm">
        {st === 'idle' && <span className="text-muted-foreground">Click “Check for updates” to see if a newer version is available.</span>}
        {st === 'checking' && <span className="text-muted-foreground">Checking for updates…</span>}
        {st === 'none' && <span className="text-emerald-700">You’re on the latest version.</span>}
        {st === 'available' && <span>Update {status.version ? `v${status.version}` : ''} found — downloading in the background…</span>}
        {st === 'downloading' && (
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
              <span>Downloading update…</span>
              <span>{status.percent ?? 0}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${status.percent ?? 0}%` }} />
            </div>
          </div>
        )}
        {st === 'downloaded' && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-emerald-700">Update {status.version ? `v${status.version}` : ''} downloaded and ready.</span>
            <Button size="sm" onClick={() => window.api.updates.install()}>Restart &amp; install</Button>
          </div>
        )}
        {st === 'dev' && <span className="text-muted-foreground">Updates are only available in the installed app (not in dev mode).</span>}
        {st === 'error' && <span className="text-red-600">Update check failed: {status.message}</span>}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        The app also checks for updates automatically shortly after it starts. Updates download in the background; you decide when to restart.
      </p>
    </Card>
  )
}

export function Settings({ user }: { user: AppUser }): React.JSX.Element {
  const isAdmin = user.role === 'admin'
  return (
    <>
      <PageHeader title="Settings" subtitle="Master data used across bargains and purchases" hint="Ports/sources (with transit days), the default allowed shortage %, users and access control. Changes here flow through to every module." />
      <div className="p-8">
        <Tabs defaultValue="sources">
          <TabsList>
            <TabsTrigger value="sources">Ports</TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="update">Software update</TabsTrigger>
            {isAdmin && <TabsTrigger value="companies">Companies</TabsTrigger>}
            {isAdmin && <TabsTrigger value="users">Users</TabsTrigger>}
            {isAdmin && <TabsTrigger value="access">Access</TabsTrigger>}
          </TabsList>

          <TabsContent value="sources" className="mt-6">
            <EntityManager
              table="sources"
              title="Port"
              description="Delivery ports, each with its transit days."
              fields={sourceFields}
              columns={sourceColumns}
              readOnly={!canWrite(user, 'settings')}
            />
          </TabsContent>
          <TabsContent value="general" className="mt-6">
            <GeneralSettings />
          </TabsContent>
          <TabsContent value="update" className="mt-6">
            <UpdatePanel />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="companies" className="mt-6">
              <EntityManager
                table="companies"
                title="Company"
                description="Each company keeps its own bargains, purchases, sales, stock and account books. Switch the working company from the sidebar. Masters and Gate Entry are shared."
                fields={companyFields}
                columns={companyColumns}
              />
            </TabsContent>
          )}
          {isAdmin && (
            <TabsContent value="users" className="mt-6">
              <UsersManager />
            </TabsContent>
          )}
          {isAdmin && (
            <TabsContent value="access" className="mt-6">
              <AccessPanel />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </>
  )
}
