import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { ExcelButton } from '@/components/ExcelButton'
import { todayISO } from '@/lib/format'

export type FieldType = 'text' | 'number' | 'switch' | 'select' | 'date'
export type ColumnType = FieldType

// Format a stored date/datetime as DD/MM/YYYY.
function fmtDate(v: unknown): string {
  const s = String(v ?? '').slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'
}

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  default?: string | number | boolean
  placeholder?: string
  options?: { value: string; label: string }[]
  // Field is editable only while this returns true (e.g. gated by a switch).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enabledWhen?: (form: Record<string, any>) => boolean
}

export interface ColumnDef {
  key: string
  label: string
  type?: ColumnType
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
  readOnly?: boolean
  // When a field changes, optionally return other fields to auto-fill.
  onFieldChange?: (key: string, value: unknown, form: Row) => Row | undefined
}

export function EntityManager({
  table,
  title,
  description,
  fields,
  columns,
  readOnly = false,
  onFieldChange
}: Props): React.JSX.Element {
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
    setForm((prev) => {
      let next = { ...prev, [key]: value }
      const extra = onFieldChange?.(key, value, next)
      if (extra) next = { ...next, ...extra }
      return next
    })
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
      if (editingId == null) {
        const res = await window.api.data.create(table, payload)
        setOpen(false)
        if (res && res.pending) {
          toast.success(`${title} submitted for admin approval — it will appear here once approved.`)
        } else {
          toast.success(`${title} saved`)
        }
      } else {
        await window.api.data.update(table, editingId, payload)
        setOpen(false)
        toast.success(`${title} saved`)
      }
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
    if (col.type === 'date') return fmtDate(v)
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
        <div className="flex items-center gap-2">
          <ExcelButton
            filename={`${table}-${todayISO()}`}
            sheetName={title}
            title={title}
            columns={columns.map((c) => ({
              header: c.label,
              key: c.key,
              align: c.align,
              value: (r: Row) => {
                // Keep real numbers numeric in the sheet; format switch/date as text.
                if (c.type !== 'switch' && c.type !== 'date' && c.align === 'right') {
                  const num = Number(r[c.key])
                  if (r[c.key] !== '' && r[c.key] != null && Number.isFinite(num)) return num
                }
                return renderCell(r, c)
              }
            }))}
            rows={rows}
          />
          {!readOnly && (
            <Button size="sm" onClick={openAdd}>
              <Plus /> Add
            </Button>
          )}
        </div>
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
                    {readOnly ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
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
                    )}
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
            {fields.map((fd) => {
              const fieldDisabled = fd.enabledWhen ? !fd.enabledWhen(form) : false
              return (
                <div key={fd.key} className={cn('grid gap-1.5', fieldDisabled && 'opacity-50')}>
                  {fd.type === 'switch' ? (
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <Label>{fd.label}</Label>
                      <Switch
                        checked={!!form[fd.key]}
                        disabled={fieldDisabled}
                        onCheckedChange={(v) => setField(fd.key, v)}
                      />
                    </div>
                  ) : fd.type === 'date' ? (
                    <>
                      <Label>
                        {fd.label}
                        {fd.required ? ' *' : ''}
                      </Label>
                      <DatePicker
                        value={(form[fd.key] as string) ?? ''}
                        disabled={fieldDisabled}
                        onChange={(v) => setField(fd.key, v)}
                      />
                    </>
                  ) : fd.type === 'select' ? (
                    <>
                      <Label>
                        {fd.label}
                        {fd.required ? ' *' : ''}
                      </Label>
                      <Select
                        value={String(form[fd.key] ?? '')}
                        disabled={fieldDisabled}
                        onValueChange={(v) => setField(fd.key, v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={`Select ${fd.label.toLowerCase()}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {(fd.options ?? []).map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
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
                        disabled={fieldDisabled}
                        onChange={(e) => setField(fd.key, e.target.value)}
                      />
                    </>
                  )}
                </div>
              )
            })}
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
