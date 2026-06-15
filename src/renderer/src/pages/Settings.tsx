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
import { MODULES } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const ROLES = ['admin', 'manager', 'operator', 'viewer']

function parsePerms(value: unknown): string[] {
  if (!value) return []
  try {
    const p = JSON.parse(String(value))
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

function accessLabel(u: Row): string {
  if (u.role === 'admin') return 'All'
  return `${parsePerms(u.permissions).length} modules`
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
      permissions: ['dashboard']
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

  function togglePerm(key: string, on: boolean): void {
    setForm((p) => {
      const set = new Set<string>(p.permissions || [])
      if (on) set.add(key)
      else set.delete(key)
      return { ...p, permissions: Array.from(set) }
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
                Admins have full access to every module.
              </p>
            ) : (
              <div className="grid gap-1.5">
                <Label>Module access</Label>
                <div className="grid grid-cols-2 gap-1 rounded-md border p-2">
                  {MODULES.map((m) => (
                    <label
                      key={m.key}
                      className="flex items-center justify-between rounded px-2 py-1 text-sm"
                    >
                      <span>{m.label}</span>
                      <Switch
                        checked={(form.permissions || []).includes(m.key)}
                        onCheckedChange={(v) => togglePerm(m.key, v)}
                      />
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Choose exactly which sections this user can open.
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

const oilTypeFields: FieldDef[] = [
  { key: 'code', label: 'Code', type: 'text', required: true, placeholder: 'MUS' },
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Mustard oil' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]
const oilTypeColumns: ColumnDef[] = [
  { key: 'code', label: 'Code' },
  { key: 'name', label: 'Name' },
  { key: 'active', label: 'Active', type: 'switch' }
]

const supplierFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'company_type', label: 'Company type', type: 'text', placeholder: 'Pvt Ltd / Partnership' },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  { key: 'tds_pct', label: 'TDS %', type: 'number', default: 0 },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  { key: 'adds_interest', label: 'Adds interest on invoice', type: 'switch', default: false },
  { key: 'interest_pct', label: 'Interest %', type: 'number', default: 0 },
  { key: 'interest_days', label: 'Interest days', type: 'number', default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]
const supplierColumns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'credit_period_days', label: 'Credit days', align: 'right' },
  { key: 'adds_interest', label: 'Interest?', type: 'switch' }
]

const transporterFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'contact', label: 'Contact', type: 'text' },
  { key: 'default_rate_per_ton', label: 'Default rate / ton', type: 'number', default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]
const transporterColumns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'contact', label: 'Contact' },
  { key: 'default_rate_per_ton', label: 'Rate / ton', align: 'right' }
]

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

export function Settings({ user }: { user: AppUser }): React.JSX.Element {
  const isAdmin = user.role === 'admin'
  return (
    <>
      <PageHeader title="Settings" subtitle="Master data used across bargains and orders" />
      <div className="p-8">
        <Tabs defaultValue="oil_types">
          <TabsList>
            <TabsTrigger value="oil_types">Oil types</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="transporters">Transporters</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
            {isAdmin && <TabsTrigger value="users">Users</TabsTrigger>}
          </TabsList>

          <TabsContent value="oil_types" className="mt-6">
            <EntityManager
              table="oil_types"
              title="Oil type"
              description="The oils you trade in."
              fields={oilTypeFields}
              columns={oilTypeColumns}
            />
          </TabsContent>
          <TabsContent value="suppliers" className="mt-6">
            <EntityManager
              table="suppliers"
              title="Supplier"
              description="GST, TDS, credit period and interest rule per supplier."
              fields={supplierFields}
              columns={supplierColumns}
            />
          </TabsContent>
          <TabsContent value="transporters" className="mt-6">
            <EntityManager
              table="transporters"
              title="Transporter"
              fields={transporterFields}
              columns={transporterColumns}
            />
          </TabsContent>
          <TabsContent value="sources" className="mt-6">
            <EntityManager
              table="sources"
              title="Source"
              description="Delivery source points, each with its transit days."
              fields={sourceFields}
              columns={sourceColumns}
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
        </Tabs>
      </div>
    </>
  )
}
