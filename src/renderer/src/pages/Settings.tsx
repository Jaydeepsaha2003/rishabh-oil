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
  const [retention, setRetention] = useState('30')

  const load = useCallback(async () => {
    const [l, i, lg, s] = await Promise.all([
      window.api.access.liveUsers(),
      window.api.access.ips(),
      window.api.access.logs(),
      window.api.settings.all()
    ])
    setLive(l)
    setIps(i)
    setLogs(lg)
    setRetention(s.log_retention_days ?? '30')
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

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
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-base font-medium">Activity log</h3>
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
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>User</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No activity yet.
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((l) => (
                  <TableRow key={l.id as number}>
                    <TableCell className="text-muted-foreground">{l.created_at}</TableCell>
                    <TableCell>{l.username}</TableCell>
                    <TableCell>{l.ip}</TableCell>
                    <TableCell className="capitalize">{l.action}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Older entries are deleted automatically based on the retention above.
        </p>
      </Card>
    </div>
  )
}

export function Settings({ user }: { user: AppUser }): React.JSX.Element {
  const isAdmin = user.role === 'admin'
  return (
    <>
      <PageHeader title="Settings" subtitle="Master data used across bargains and purchases" />
      <div className="p-8">
        <Tabs defaultValue="sources">
          <TabsList>
            <TabsTrigger value="sources">Ports</TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
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
