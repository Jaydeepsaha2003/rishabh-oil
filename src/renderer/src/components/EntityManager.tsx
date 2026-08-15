import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { Pagination, usePaged } from '@/components/Pagination'

export type FieldType = 'text' | 'number' | 'switch' | 'select' | 'date' | 'creatable'
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
  // Derives what the cell shows, for columns that are not a plain field —
  // e.g. an id resolved to the linked record's name.
  value?: (row: Row) => string
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
  // An extra per-row button (e.g. linking related records), before edit/delete.
  rowAction?: { title: string; icon: React.ComponentType<{ className?: string }>; onClick: (row: Row) => void }
}

export function EntityManager({
  table,
  title,
  description,
  fields,
  columns,
  readOnly = false,
  onFieldChange,
  rowAction
}: Props): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])

  // Names already taken, and the ones duplicated in the data as it stands.
  const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()
  const nameCounts = new Map<string, number>()
  for (const r of rows) {
    const k = norm(r.name)
    if (k) nameCounts.set(k, (nameCounts.get(k) || 0) + 1)
  }
  const isDuplicated = (r: Row): boolean => (nameCounts.get(norm(r.name)) || 0) > 1
  // Tally-style type-to-find across every visible column.
  const [search, setSearch] = useState('')
  const shownRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search])
  // 10 per page with page numbers underneath, shared by every master list.
  const paged = usePaged(shownRows)
  // Options a creatable field offers: whatever the field declares, plus every
  // value already used by an existing record, plus anything added this session.
  const [addedOptions, setAddedOptions] = useState<Record<string, string[]>>({})
  const [newOption, setNewOption] = useState<Record<string, string>>({})
  function optionsFor(fd: FieldDef): { value: string; label: string }[] {
    const seen = new Map<string, string>()
    for (const o of fd.options ?? []) seen.set(o.value, o.label)
    for (const r of rows) {
      const v = String(r[fd.key] ?? '').trim()
      if (v && !seen.has(v)) seen.set(v, v)
    }
    for (const v of addedOptions[fd.key] ?? []) if (!seen.has(v)) seen.set(v, v)
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }))
  }
  function addOption(key: string): void {
    const v = String(newOption[key] ?? '').trim()
    if (!v) return
    setAddedOptions((p) => ({ ...p, [key]: [...(p[key] ?? []), v] }))
    setField(key, v)
    setNewOption((p) => ({ ...p, [key]: '' }))
  }
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

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.altKey && (e.key === 'n' || e.key === 'N') && !readOnly) {
        e.preventDefault()
        openAdd()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  // What the dialog is about to save, checked against the rest of the table.
  const typedName = norm(form.name)
  const clash = typedName
    ? rows.find((r) => norm(r.name) === typedName && Number(r.id) !== Number(editingId))
    : undefined
  // Editing a row that is already duplicated must stay possible — only a new
  // clash (or renaming into one) is blocked.
  const nameBlocked = !!clash && (editingId == null || norm(rows.find((r) => Number(r.id) === Number(editingId))?.name) !== typedName)

  function renderCell(row: Row, col: ColumnDef): string {
    const v = col.value ? col.value(row) : row[col.key]
    if (col.type === 'switch') return v ? 'Yes' : 'No'
    if (col.type === 'date') return fmtDate(v)
    if (v == null || v === '') return '—'
    return String(v)
  }

  return (
    <div className="rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg">
      <div className="flex flex-wrap items-center gap-2 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]">
        <div className="min-w-0">
          <h3 className="text-[13px] font-bold uppercase tracking-widest">{title}</h3>
          {description && <p className="text-[11px] text-[#1a2c56]/70">{description}</p>}
        </div>
        <span className="rounded bg-white/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {shownRows.length}{search ? ` / ${rows.length}` : ''}
        </span>
        {(() => {
          const dupes = rows.filter(isDuplicated).length
          return dupes > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700"
              title="These names appear more than once — rename or remove the extras"
            >
              <AlertCircle className="h-3 w-3" /> {dupes} duplicate{dupes === 1 ? '' : 's'}
            </span>
          ) : null
        })()}
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="h-8 w-48 bg-white text-[13px]"
            placeholder={`Search ${title.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
            <Button size="sm" className="bg-[#1a2c56] hover:bg-[#24407e]" title="Alt+N" onClick={openAdd}>
              <Plus /> Add
            </Button>
          )}
        </div>
      </div>

      <div>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="bg-[#f1ecd9] hover:bg-[#f1ecd9]">
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    'h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                    c.align === 'right' && 'text-right'
                  )}
                >
                  {c.label}
                </TableHead>
              ))}
              <TableHead className="h-8 w-[90px] text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Actions
              </TableHead>
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
              paged.pageRows.map((row) => (
                <TableRow
                  key={row.id as number}
                  className={cn(
                    'border-b border-dotted border-[#e5dfc8] transition-colors hover:bg-amber-100/70',
                    !readOnly && 'cursor-pointer'
                  )}
                  onClick={() => !readOnly && openEdit(row)}
                  title={readOnly ? undefined : 'Open to alter'}
                >
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn('py-1.5', c.align === 'right' && 'text-right tabular-nums')}
                    >
                      {c.key === 'name' && isDuplicated(row) ? (
                        <span className="inline-flex items-center gap-1.5">
                          <AlertCircle
                            className="h-3.5 w-3.5 shrink-0 text-red-600"
                            aria-label="Duplicate name"
                          />
                          <span className="font-medium text-red-700" title="Another record carries this exact name — rename one of them, or delete the one not in use">
                            {renderCell(row, c)}
                          </span>
                        </span>
                      ) : (
                        renderCell(row, c)
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {readOnly ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex justify-end gap-1">
                        {rowAction && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title={rowAction.title}
                            onClick={() => rowAction.onClick(row)}
                          >
                            <rowAction.icon className="h-4 w-4" />
                          </Button>
                        )}
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
        <Pagination {...paged} label="records" className="rounded-b-md border-t border-[#d9d2b8] bg-[#fffdf4] px-3" />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-[#d9d2b8] bg-[#fffdf4]">
          <DialogHeader className="-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5">
            <DialogTitle className="text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]">
              {editingId == null ? `Create ${title}` : `Alter ${title}`}
            </DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1">
            {fields.map((fd) => {
              const fieldDisabled = fd.enabledWhen ? !fd.enabledWhen(form) : false
              return (
                <div key={fd.key} className={cn('flex flex-col gap-1.5', fieldDisabled && 'opacity-50')}>
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
                  ) : fd.type === 'creatable' ? (
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
                          {optionsFor(fd).map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {/* Type a value that is not in the list yet and add it. It
                          becomes a permanent option once the record is saved. */}
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 text-[13px]"
                          placeholder={`New ${fd.label.toLowerCase()}…`}
                          value={newOption[fd.key] ?? ''}
                          disabled={fieldDisabled}
                          onChange={(e) => setNewOption((p) => ({ ...p, [fd.key]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addOption(fd.key)
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title={`Add ${fd.label.toLowerCase()}`}
                          disabled={fieldDisabled || !String(newOption[fd.key] ?? '').trim()}
                          onClick={() => addOption(fd.key)}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
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
          {nameBlocked && (
            <p className="flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                <b>{String(clash?.name)}</b> already exists. Two masters with the same name split the
                history between them — give this one a different name.
              </span>
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || nameBlocked} title={nameBlocked ? 'That name is already taken' : undefined}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
