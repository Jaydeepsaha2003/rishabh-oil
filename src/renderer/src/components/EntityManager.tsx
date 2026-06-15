import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { useLiveRefresh } from '@/lib/useLiveRefresh'

export type FieldType = 'text' | 'number' | 'switch'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  default?: string | number | boolean
  placeholder?: string
}

export interface ColumnDef {
  key: string
  label: string
  type?: FieldType
  align?: 'left' | 'right'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface Props {
  table: string
  title: string
  description?: string
  fields: FieldDef[]
  columns: ColumnDef[]
}

export function EntityManager({ table, title, description, fields, columns }: Props): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await window.api.data.list(table))
    setLoading(false)
  }, [table])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function blankForm(): Row {
    const f: Row = {}
    for (const fd of fields) f[fd.key] = fd.default ?? (fd.type === 'switch' ? false : '')
    return f
  }

  function openAdd(): void {
    setEditingId(null)
    setForm(blankForm())
    setError(null)
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditingId(row.id as number)
    const f: Row = {}
    for (const fd of fields) f[fd.key] = fd.type === 'switch' ? !!row[fd.key] : (row[fd.key] ?? '')
    setForm(f)
    setError(null)
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function save(): Promise<void> {
    for (const fd of fields) {
      if (fd.required && (form[fd.key] === '' || form[fd.key] == null)) {
        setError(`${fd.label} is required`)
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Row = {}
      for (const fd of fields) {
        let v = form[fd.key]
        if (fd.type === 'number') v = v === '' || v == null ? 0 : Number(v)
        if (fd.type === 'switch') v = v ? 1 : 0
        payload[fd.key] = v
      }
      if (editingId == null) await window.api.data.create(table, payload)
      else await window.api.data.update(table, editingId, payload)
      setOpen(false)
      toast.success(`${title} saved`)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    const label = (row[columns[0].key] as string) ?? `#${row.id}`
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return
    try {
      await window.api.data.remove(table, row.id as number)
      toast.success(`${title} deleted`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function renderCell(row: Row, col: ColumnDef): string {
    const v = row[col.key]
    if (col.type === 'switch') return v ? 'Yes' : 'No'
    if (v == null || v === '') return '—'
    return String(v)
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">{title}</h3>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus /> Add
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={c.align === 'right' ? 'text-right' : ''}>
                  {c.label}
                </TableHead>
              ))}
              <TableHead className="w-[90px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="py-8 text-center text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="py-8 text-center text-muted-foreground"
                >
                  No records yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id as number}>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={c.align === 'right' ? 'text-right tabular-nums' : ''}
                    >
                      {renderCell(row, c)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => del(row)}
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
            <DialogTitle>{editingId == null ? `Add ${title}` : `Edit ${title}`}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1">
            {fields.map((fd) => (
              <div key={fd.key} className="grid gap-1.5">
                {fd.type === 'switch' ? (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <Label>{fd.label}</Label>
                    <Switch
                      checked={!!form[fd.key]}
                      onCheckedChange={(v) => setField(fd.key, v)}
                    />
                  </div>
                ) : (
                  <>
                    <Label>
                      {fd.label}
                      {fd.required ? ' *' : ''}
                    </Label>
                    <Input
                      type={fd.type === 'number' ? 'number' : 'text'}
                      value={form[fd.key] ?? ''}
                      placeholder={fd.placeholder}
                      onChange={(e) => setField(fd.key, e.target.value)}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
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
