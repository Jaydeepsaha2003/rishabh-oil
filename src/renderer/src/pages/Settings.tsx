import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
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
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import type { AppUser } from '@/lib/session'
import { cn } from '@/lib/utils'
import { MODULES, canWrite } from '@/lib/modules'
import { clearEntryWindows } from '@/lib/useEntryWindow'

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
      // The day counts just moved; the next form to ask must not be handed the
      // window this session cached at login.
      clearEntryWindows()
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

  // A module's rights, read from either the new object shape or the older
  // 'read' / 'write' string so existing users edit without being reset.
  // editDays = the ENTRY window (how far back they may date, edit or delete).
  // viewDays  = the VISIBLE window (how far back rows are listed at all).
  // Two numbers because reading a week of history is context and keying a week
  // late is a habit: the client wants to grant the first without the second.
  type Rights = {
    view: boolean
    create: boolean
    edit: boolean
    delete: boolean
    editDays: string
    viewDays: string
    scope: string
  }
  function rightsOf(key: string): Rights {
    const raw = (form.permissions || {})[key]
    if (raw === 'write')
      return { view: true, create: true, edit: true, delete: true, editDays: '', viewDays: '', scope: '' }
    if (raw === 'read')
      return { view: true, create: false, edit: false, delete: false, editDays: '', viewDays: '', scope: '' }
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      return {
        view: !!o.view || !!o.create || !!o.edit || !!o.delete,
        create: !!o.create,
        edit: !!o.edit,
        delete: !!o.delete,
        editDays: o.editDays == null || o.editDays === '' ? '' : String(o.editDays),
        viewDays: o.viewDays == null || o.viewDays === '' ? '' : String(o.viewDays),
        scope: o.scope ? String(o.scope) : ''
      }
    }
    return { view: false, create: false, edit: false, delete: false, editDays: '', viewDays: '', scope: '' }
  }

  function writeRights(key: string, next: Rights): void {
    setForm((p) => {
      const perms = { ...(p.permissions || {}) }
      const any = next.view || next.create || next.edit || next.delete
      if (!any) delete perms[key]
      else {
        const entry: Record<string, unknown> = {
          view: true,
          create: next.create,
          edit: next.edit,
          delete: next.delete
        }
        if (next.editDays !== '' && Number.isFinite(Number(next.editDays))) {
          entry.editDays = Math.max(0, Number(next.editDays))
        }
        if (next.viewDays !== '' && Number.isFinite(Number(next.viewDays))) {
          entry.viewDays = Math.max(0, Number(next.viewDays))
        }
        // Carried, not rebuilt — ticking any box on a scoped module would
        // otherwise silently drop the restriction it was granted under.
        if (next.scope) entry.scope = next.scope
        perms[key] = entry
      }
      return { ...p, permissions: perms }
    })
  }

  function toggleRight(key: string, flag: 'view' | 'create' | 'edit' | 'delete', on: boolean): void {
    const cur = rightsOf(key)
    const next = { ...cur, [flag]: on }
    // Nothing can be done to a module you cannot see.
    if (flag === 'view' && !on) {
      next.create = false
      next.edit = false
      next.delete = false
    }
    if (on && flag !== 'view') next.view = true
    writeRights(key, next)
  }

  // Column-wise bulk set, and a whole-row preset.
  function setColumn(flag: 'view' | 'create' | 'edit' | 'delete', on: boolean): void {
    setForm((p) => {
      const perms = { ...(p.permissions || {}) }
      for (const m of MODULES.filter((x) => !x.derived)) {
        const cur = rightsOf(m.key)
        const next = { ...cur, [flag]: on }
        if (flag === 'view' && !on) {
          next.create = false
          next.edit = false
          next.delete = false
        }
        if (on && flag !== 'view') next.view = true
        const any = next.view || next.create || next.edit || next.delete
        if (!any) delete perms[m.key]
        else {
          const entry: Record<string, unknown> = { view: true, create: next.create, edit: next.edit, delete: next.delete }
          if (next.editDays !== '') entry.editDays = Math.max(0, Number(next.editDays))
          if (next.viewDays !== '') entry.viewDays = Math.max(0, Number(next.viewDays))
          if (next.scope) entry.scope = next.scope
          perms[m.key] = entry
        }
      }
      return { ...p, permissions: perms }
    })
  }

  function setAllPerms(level: 'none' | 'read' | 'write'): void {
    setForm((p) => {
      if (level === 'none') return { ...p, permissions: {} }
      const perms: Record<string, unknown> = {}
      for (const m of MODULES.filter((x) => !x.derived)) {
        perms[m.key] =
          level === 'read'
            ? { view: true, create: false, edit: false, delete: false }
            : { view: true, create: true, edit: true, delete: true }
      }
      return { ...p, permissions: perms }
    })
  }

  // Special access: the unloading desk. A grant of its own rather than a
  // combination of tick boxes, because what it restricts is not an action but
  // WHICH ROWS AND COLUMNS exist — the page shows Date/Invoice, Customer, Item
  // and Dispatch status for FOR deliveries still out, and nothing else. The
  // rights are fixed to view + edit: there is exactly one thing to record.
  const unloadDesk = rightsOf('sales').scope === 'unload'
  function setUnloadDesk(on: boolean): void {
    setForm((p) => {
      const perms = { ...(p.permissions || {}) }
      if (!on) {
        const cur = perms.sales
        if (cur && typeof cur === 'object') {
          const o = { ...(cur as Record<string, unknown>) }
          delete o.scope
          perms.sales = o
        }
      } else {
        perms.sales = { view: true, create: false, edit: true, delete: false, scope: 'unload' }
      }
      return { ...p, permissions: perms }
    })
  }

  // Fill one window down the whole grid. Typing 7 into Visible and 2 into Entry
  // is the common setup — a week of history to read, two days to key — and
  // doing it a row at a time across two dozen modules invites a missed box.
  //
  // The two fields have different reach on purpose: a visible window restricts
  // READING, so it applies to any module the user can open; an entry window
  // restricts WRITING, so it would mean nothing on a view-only module.
  function setAllDays(field: 'editDays' | 'viewDays', days: string): void {
    setForm((p) => {
      const perms = { ...(p.permissions || {}) }
      for (const m of MODULES.filter((x) => !x.derived)) {
        const cur = rightsOf(m.key)
        const writes = cur.create || cur.edit || cur.delete
        if (field === 'editDays' ? !writes : !cur.view) continue
        const entry: Record<string, unknown> = { view: true, create: cur.create, edit: cur.edit, delete: cur.delete }
        // Carry the OTHER window through untouched — filling one column must
        // not wipe the column beside it.
        const keep = field === 'editDays' ? cur.viewDays : cur.editDays
        const keepKey = field === 'editDays' ? 'viewDays' : 'editDays'
        if (keep !== '') entry[keepKey] = Math.max(0, Number(keep))
        if (days !== '' && Number.isFinite(Number(days))) entry[field] = Math.max(0, Number(days))
        if (cur.scope) entry.scope = cur.scope
        perms[m.key] = entry
      }
      return { ...p, permissions: perms }
    })
  }

  // Full-page user access form (replaces the old modal for more room).
  if (open) {
    return (
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
          <button className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="h-4 border-l" />
          <h2 className="text-base font-semibold">{editing ? `Edit user · ${editing.username}` : 'Create user & access'}</h2>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_1fr]">
          {/* Account details */}
          <div className="space-y-4 rounded-xl border bg-card p-5">
            <h3 className="text-sm font-semibold">Account</h3>
            <div className="flex flex-col gap-1.5">
              <Label>Full name</Label>
              <Input value={form.full_name ?? ''} onChange={(e) => setField('full_name', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Username *</Label>
              <Input value={form.username ?? ''} onChange={(e) => setField('username', e.target.value)} disabled={!!editing} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setField('role', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{editing ? 'New password (leave blank to keep)' : 'Password *'}</Label>
              <Input type="password" value={form.password ?? ''} onChange={(e) => setField('password', e.target.value)} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-1.5">
              <span className="text-sm">Active</span>
              <Switch checked={!!form.active} onCheckedChange={(v) => setField('active', v)} />
            </div>
          </div>

          {/* Module access */}
          <div className="space-y-3 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Module access</h3>
              {form.role !== 'admin' && (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAllPerms('read')}>All read</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAllPerms('write')}>All write</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAllPerms('none')}>Clear</Button>
                </div>
              )}
            </div>
            {form.role === 'admin' ? (
              <p className="rounded-md bg-muted px-3 py-6 text-center text-sm text-muted-foreground">
                Admins have full read &amp; write access to every module.
              </p>
            ) : (
              <>
                {/* Special access sits ABOVE the grid, not under it: it is not
                    one more right to tick but a different shape of page, and at
                    the bottom of a 24-row table nobody found it. */}
                <div
                  className={cn(
                    'rounded-lg border-2 p-3 transition-colors',
                    unloadDesk ? 'border-amber-500 bg-amber-100/70' : 'border-dashed border-amber-400/70 bg-amber-50/50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Switch checked={unloadDesk} onCheckedChange={setUnloadDesk} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <ShieldCheck className={cn('h-4 w-4 shrink-0', unloadDesk ? 'text-amber-700' : 'text-amber-600/70')} />
                        <span className="text-[13px] font-bold text-amber-900">Special access — unloading desk only</span>
                        {unloadDesk ? (
                          <Badge className="bg-amber-600 text-[10px] uppercase tracking-wide hover:bg-amber-600">On</Badge>
                        ) : (
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-700/60">Off</span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-amber-900/85">
                        Turns the Sales page into a receiving list instead of the invoice register: <b>Date / Invoice</b>,{' '}
                        <b>Customer</b>, <b>Item</b> and <b>Dispatch status</b> only, for <b>FOR</b> deliveries still out.
                        Everything already unloaded, every Ex sale, and every rate, invoice value, GST and freight figure is
                        left out of the data entirely — not merely hidden. The one thing this user can record is the{' '}
                        <b>received quantity</b> on unloading.
                      </p>
                      {unloadDesk && (
                        <p className="mt-1.5 rounded bg-amber-200/70 px-2 py-1 text-[11px] font-medium text-amber-900">
                          The Sales row in the grid below is overridden while this is on.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                  <span className="text-muted-foreground">Set every module below —</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">Visible for</span>
                    <Input
                      type="number"
                      min="0"
                      className="h-7 w-16 text-right"
                      placeholder="days"
                      onChange={(e) => setAllDays('viewDays', e.target.value)}
                    />
                    <span className="text-muted-foreground">days</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">Entry window</span>
                    <Input
                      type="number"
                      min="0"
                      className="h-7 w-16 text-right"
                      placeholder="days"
                      onChange={(e) => setAllDays('editDays', e.target.value)}
                    />
                    <span className="text-muted-foreground">days</span>
                  </div>
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-muted/70 text-left">
                        <th className="px-3 py-1.5 font-semibold">Page</th>
                        {(['view', 'create', 'edit', 'delete'] as const).map((f) => (
                          <th key={f} className="px-2 py-1.5 text-center font-semibold capitalize">
                            {f}
                            <div className="mt-0.5 flex justify-center gap-1 font-normal">
                              <button type="button" className="text-[10px] text-sky-700 hover:underline" onClick={() => setColumn(f, true)}>all</button>
                              <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => setColumn(f, false)}>none</button>
                            </div>
                          </th>
                        ))}
                        <th className="px-3 py-1.5 text-right font-semibold">
                          Visible for
                          <div className="font-normal text-muted-foreground">days (blank = all)</div>
                        </th>
                        <th className="px-3 py-1.5 text-right font-semibold">
                          Entry window
                          <div className="font-normal text-muted-foreground">days (blank = no limit)</div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* A derived page takes no row: it is reached through
                          its sections, so ticking it as well would be a second
                          switch for the same door. */}
                      {MODULES.filter((m) => !m.derived).map((m, i) => {
                        const r = rightsOf(m.key)
                        const granted = r.view || r.create || r.edit || r.delete
                        return (
                          <tr
                            key={m.key}
                            className={cn(
                              'border-b last:border-0',
                              i % 2 === 1 && 'bg-muted/30',
                              !granted && 'opacity-60',
                              m.key === 'sales' && unloadDesk && 'bg-amber-100/70 opacity-100'
                            )}
                          >
                            <td className="px-3 py-1.5 font-medium">
                              {m.label}
                              {m.key === 'sales' && unloadDesk && (
                                <span className="ml-1.5 rounded bg-amber-600 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">
                                  unloading desk
                                </span>
                              )}
                            </td>
                            {(['view', 'create', 'edit', 'delete'] as const).map((f) => (
                              <td key={f} className="px-2 py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 accent-sky-600"
                                  checked={r[f]}
                                  disabled={m.key === 'sales' && unloadDesk}
                                  title={m.key === 'sales' && unloadDesk ? 'Fixed by the unloading-desk access above' : undefined}
                                  onChange={(e) => toggleRight(m.key, f, e.target.checked)}
                                />
                              </td>
                            ))}
                            <td className="px-3 py-1.5 text-right">
                              {/* Visible window: a read limit, so it applies to
                                  anyone who can open the page at all. */}
                              <Input
                                type="number"
                                min="0"
                                className="ml-auto h-7 w-20 text-right text-[12px]"
                                placeholder="all"
                                disabled={!r.view}
                                value={r.viewDays}
                                onChange={(e) => writeRights(m.key, { ...r, viewDays: e.target.value })}
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              {/* Entry window: a write limit, so it means
                                  nothing without one of the write ticks. */}
                              <Input
                                type="number"
                                min="0"
                                className="ml-auto h-7 w-20 text-right text-[12px]"
                                placeholder="no limit"
                                disabled={!r.create && !r.edit && !r.delete}
                                value={r.editDays}
                                onChange={(e) => writeRights(m.key, { ...r, editDays: e.target.value })}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Tick what this user may do on each page. <b>Create</b> without <b>Edit</b> means they can add entries
                  but never change them afterwards.
                </p>
                <p className="text-xs text-muted-foreground">
                  Both windows count days on the calendar with <b>today among them</b>: <b>2</b> on the 29th means the
                  28th and the 29th, and nothing before. Blank means no limit, and an admin is never limited.
                </p>
                <p className="text-xs text-muted-foreground">
                  <b>Visible for</b> is how far back they may <b>read</b>. An entry whose own date (invoice date,
                  bargain date…) falls outside it is not listed on that page at all — the bound goes into the query, so
                  those rows are never sent to their screen rather than merely hidden on it. Pages that only borrow a
                  register keep their own window, so a short window on Sales does not shorten Treasury.
                </p>
                <p className="text-xs text-muted-foreground">
                  <b>Entry window</b> is how far back they may <b>write</b> — date a new entry, or edit or delete an
                  old one. The date picker greys out everything before it, and the save refuses it too. Keep this one
                  tight: it is what puts an operator on duty, since someone who cannot reach last Friday has to key
                  Friday&apos;s work on Friday. It is capped by <b>Visible for</b>, because changing a row you cannot
                  see is not a right worth granting.
                </p>
                <p className="text-xs text-muted-foreground">
                  A page&apos;s own totals cover the rows that user can see, so a restricted user&apos;s figures will
                  not match an admin&apos;s. Stock, Accounting and Treasury are computed from every row and are not
                  affected.
                </p>

              </>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save user'}</Button>
        </div>
      </div>
    )
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

function GeneralSettings({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const [shortage, setShortage] = useState('')
  const [uom, setUom] = useState('')
  // Default true (required) — an LC needs a real invoice to draw against
  // unless an admin explicitly relaxes it here.
  const [lcRequireInvoice, setLcRequireInvoice] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.settings.all().then((s) => {
      setShortage(s.allowed_shortage_pct ?? '0.2')
      setUom(s.default_uom ?? 'ton')
      setLcRequireInvoice(s.lc_require_linked_invoice !== '0')
    })
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await window.api.settings.set('allowed_shortage_pct', shortage)
      await window.api.settings.set('default_uom', uom)
      if (isAdmin) await window.api.settings.set('lc_require_linked_invoice', lcRequireInvoice ? '1' : '0')
      toast.success('Settings saved')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid max-w-md gap-6">
      <Card className="p-6">
        <h3 className="mb-4 text-base font-medium">General</h3>
        <div className="grid gap-4">
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
            <Label>Default unit of measure</Label>
            <Input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="ton" />
          </div>
        </div>
      </Card>
      {isAdmin && (
        <Card className="p-6">
          <h3 className="mb-1 text-base font-medium">Letters of Credit</h3>
          <p className="mb-4 text-xs text-muted-foreground">Admin only — changes the rule for every LC going forward.</p>
          <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 p-3">
            <div>
              <Label>Require a linked purchase invoice</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {lcRequireInvoice
                  ? 'ON — an LC must name the invoice(s) it covers before it can leave Application, same as today.'
                  : 'OFF — an LC can be opened and taken to Payment received with no invoice linked. It settles as an ON ACCOUNT receipt against the supplier instead of a specific bill.'}
              </p>
            </div>
            <Switch checked={lcRequireInvoice} onCheckedChange={setLcRequireInvoice} />
          </div>
        </Card>
      )}
      <div>
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function AccessPanel(): React.JSX.Element {
  const [live, setLive] = useState<Row[]>([])
  const [ips, setIps] = useState<Row[]>([])
  const [logs, setLogs] = useState<Row[]>([])
  const [logUsers, setLogUsers] = useState<string[]>([])
  const [logEntities, setLogEntities] = useState<string[]>([])
  const [filter, setFilter] = useState<Row>({ username: [] as string[], entity: [] as string[], q: '', from: '', to: '' })
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
    if (filter.username?.length) f.username = filter.username
    if (filter.entity?.length) f.entity = filter.entity
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
          <MultiSelectFilter
            options={logUsers.map((u) => ({ value: u, label: u }))}
            value={filter.username || []}
            onApply={(v) => setFilter((p) => ({ ...p, username: v }))}
            allLabel="All users"
          />
          <MultiSelectFilter
            options={logEntities.map((en) => ({ value: en, label: en }))}
            value={filter.entity || []}
            onApply={(v) => setFilter((p) => ({ ...p, entity: v }))}
            allLabel="All sections"
          />
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
          <h3 className="font-medium">Database Management Software</h3>
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
      <div className="px-4 py-6">
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
            <GeneralSettings isAdmin={isAdmin} />
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
