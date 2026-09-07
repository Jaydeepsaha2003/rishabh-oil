import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Check, CheckCircle2, Pencil, Plus, Trash2, XCircle } from 'lucide-react'
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
import { ColumnFilter } from '@/components/ui/column-filter'
import { useIsMobile } from '@/lib/useIsMobile'

export type FieldType = 'text' | 'number' | 'switch' | 'select' | 'date' | 'creatable' | 'color' | 'computed'
export type ColumnType = FieldType

// Chip colours for the values a master list's select column actually carries.
// Anything not named here still gets a chip, in the neutral tone.
const CHIP_TONES: Record<string, { bg: string; fg: string }> = {
  purchase: { bg: '#EAF0E9', fg: '#33473E' },
  sales: { bg: '#E9F5EE', fg: '#0B6B45' },
  both: { bg: '#FFEDD0', fg: '#8A5300' },
  // The party's side of the business. Two tones that read apart at a glance
  // down a long list — the mill's own manufacturing in the house green, and
  // trading in a cooler blue that belongs to nothing else here.
  manufacturing: { bg: '#E9F5EE', fg: '#0B6B45' },
  trading: { bg: '#E3EEF5', fg: '#255B7A' },
  // How a packed SKU is made up: the container it ships in, and the unit it
  // is measured in. A tone each, so a long SKU list can be read down the
  // column rather than word by word.
  box: { bg: '#EAF0E9', fg: '#33473E' },
  pch: { bg: '#EDE7F6', fg: '#4B3C8C' },
  pouch: { bg: '#EDE7F6', fg: '#4B3C8C' },
  jar: { bg: '#E3EEF5', fg: '#255B7A' },
  tin: { bg: '#FFEDD0', fg: '#8A5300' },
  bag: { bg: '#F2ECE3', fg: '#6B5330' },
  kg: { bg: '#E9F5EE', fg: '#0B6B45' },
  mt: { bg: '#E9F5EE', fg: '#0B6B45' },
  g: { bg: '#EAF0E9', fg: '#33473E' },
  l: { bg: '#E3EEF5', fg: '#255B7A' },
  ml: { bg: '#E3EEF5', fg: '#255B7A' }
}

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
  // For type 'computed': what to show. Read-only, worked out from the fields
  // above it as they are typed, and never sent — a figure that is derivable
  // has no business being stored and going stale.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compute?: (form: Record<string, any>) => string
  // Shown, saved, but not typed into. For a value the form works out for
  // itself: readOnly rather than disabled, because a disabled input is greyed
  // to half opacity and reads as "not applicable" when in fact it is the
  // answer. The value still goes in the payload — unlike 'computed', these
  // ARE columns.
  readOnly?: boolean
}

export interface ColumnDef {
  key: string
  label: string
  type?: ColumnType
  align?: 'left' | 'right'
  // Derives what the cell shows, for columns that are not a plain field —
  // e.g. an id resolved to the linked record's name.
  value?: (row: Row) => string
  // Opt-in header filter. Off by default so no existing master changes: a
  // list of eight ports does not need one, and a list of twenty-one SKUs does.
  filterable?: boolean
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
  rowAction?: {
    title: string | ((row: Row) => string)
    icon: React.ComponentType<{ className?: string }>
    onClick: (row: Row) => void
    // A small dot on the button when the row already has something behind it,
    // so the list says which rows are linked without opening each one.
    marked?: (row: Row) => boolean
  }
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
  // Phone width on the website swaps the register for cards — see below.
  const isMobile = useIsMobile()

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
  // Excel-style per-column filters, on the columns that ask for one. Keyed by
  // column, empty meaning "every value" — the same convention ColumnFilter
  // uses everywhere else in the app.
  const [colFilters, setColFilters] = useState<Record<string, string[]>>({})
  // Options come from renderCell, not the raw field, so what the funnel offers
  // is exactly what the column displays — "Yes"/"No" for a switch, the
  // resolved name for a linked id, the derived total for a computed column.
  const filterOptions = useMemo(() => {
    const out: Record<string, { value: string; label: string; count: number }[]> = {}
    for (const c of columns) {
      if (!c.filterable) continue
      const tally = new Map<string, number>()
      for (const r of rows) {
        const t = renderCell(r, c)
        tally.set(t, (tally.get(t) || 0) + 1)
      }
      out[c.key] = [...tally.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([value, count]) => ({ value, label: value, count }))
    }
    return out
    // renderCell is stable for a given rows/columns pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns])
  const filteredRows = useMemo(
    () =>
      shownRows.filter((r) =>
        columns.every((c) => {
          const sel = colFilters[c.key]
          if (!c.filterable || !sel?.length) return true
          return sel.includes(renderCell(r, c))
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownRows, colFilters, columns]
  )
  // 10 per page with page numbers underneath, shared by every master list.
  const paged = usePaged(filteredRows)
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
      if (fd.type === 'computed') continue
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
        if (fd.type === 'computed') continue
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

  // What a cell LOOKS like, as opposed to what it says. Kept apart from
  // renderCell because that one's plain string is what the Excel export
  // writes — a chip in a spreadsheet cell would be nonsense.
  function renderCellNode(row: Row, col: ColumnDef): React.ReactNode {
    const text = renderCell(row, col)
    if (!__WEB__) return text
    if (col.type === 'switch') {
      const on = text === 'Yes'
      return (
        <span className={cn('inline-flex items-center gap-1.5 font-bold', on ? 'text-[#12855A]' : 'text-[#B3261E]')}>
          {on ? <CheckCircle2 className="h-[18px] w-[18px]" /> : <XCircle className="h-[18px] w-[18px]" />}
          {text}
        </span>
      )
    }
    if (col.type === 'select' && text !== '—') {
      // Purchase / sales / both carry the handoff's own colours; any other
      // select value still gets a chip, just a neutral one.
      const tone =
        CHIP_TONES[String(row[col.key] ?? '').trim().toLowerCase()] ?? { bg: '#EAF0E9', fg: '#33473E' }
      return (
        <span
          className="inline-block rounded-[2px] px-[9px] py-1 text-[11.5px] font-extrabold uppercase tracking-[.05em]"
          style={{ background: tone.bg, color: tone.fg }}
        >
          {text}
        </span>
      )
    }
    return text
  }

  return (
    <div
      className={cn(
        // Website: the Categories handoff's card — a white sheet under a
        // forest strip. Every master page draws through here, so they all
        // move together. The desktop app keeps its Tally-styled cream card.
        __WEB__
          ? 'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white'
          : 'rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg'
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 px-4 py-2',
          __WEB__ ? cn('gap-3 bg-[#0B3D2E] px-[18px] py-4 text-white', isMobile && '!px-3 !py-3 [&>div.ml-auto]:!w-full [&>div.ml-auto]:!ml-0') : 'rounded-t-md bg-[#dce6f5] text-[#1a2c56]'
        )}
      >
        <div className="min-w-0">
          <h3 className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && 'text-[14px] font-extrabold tracking-[.14em]')}>{title}</h3>
          {description && (
            <p className={cn('text-[11px] text-[#1a2c56]/70', __WEB__ && '!mt-0.5 !text-[12.5px] !font-medium !text-[#8FBFA8]')}>{description}</p>
          )}
        </div>
        <span
          className={cn(
            'rounded bg-white/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
            __WEB__ && '!rounded-[3px] !bg-[#C7F03F] !px-2.5 !py-1 !text-[13px] !font-extrabold !text-[#12280B]'
          )}
        >
          {filteredRows.length}
          {search || filteredRows.length !== rows.length ? ` / ${rows.length}` : ''}
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
            className={cn(
              'h-8 w-48 bg-white text-[13px]',
              // Sits on the forest strip, so it inverts: translucent fill,
              // lime-tinted rim, white text.
              __WEB__ &&
                cn('!h-11 !rounded-[4px] !border-[rgba(199,240,63,.2)] !bg-white/10 !text-[13.5px] !text-white placeholder:!text-[#8FBFA8]', isMobile ? '!w-full !flex-1' : '!w-[280px]')
            )}
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
            <Button
              size="sm"
              className={cn(
                'bg-[#1a2c56] hover:bg-[#24407e]',
                __WEB__ && '!h-11 !rounded-[4px] !bg-[#C7F03F] !px-[18px] !text-[14px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#b3d936]'
              )}
              title="Alt+N"
              onClick={openAdd}
            >
              <Plus /> Add
            </Button>
          )}
        </div>
      </div>

      {/* Phone width: a six-column register does not fit, and a sideways
          scroll makes a master list unusable. One card per record instead —
          the name as the heading, every other column as a labelled line. */}
      {__WEB__ && isMobile ? (
        <div className="bg-[#F1F5EF] p-3">
          {loading ? (
            <div className="py-10 text-center text-[13px] text-[#7C9188]">Loading…</div>
          ) : paged.pageRows.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-[#7C9188]">
              {rows.length === 0
                ? 'No records yet.'
                : search
                  ? 'Nothing matches that search.'
                  : 'Nothing matches these filters.'}
            </div>
          ) : (
            <div className="space-y-2.5">
              {paged.pageRows.map((row) => (
                <div
                  key={row.id as number}
                  onClick={() => !readOnly && openEdit(row)}
                  className="rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#12855A] bg-white p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-bold tracking-[-0.01em]">
                        {renderCell(row, columns[0])}
                      </div>
                      {isDuplicated(row) && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-red-700">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Duplicate name
                        </div>
                      )}
                    </div>
                    {!readOnly && (
                      <div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="outline"
                          size="icon"
                          className="!h-9 !w-9 !rounded-[3px] !border-[#C3D2C6] !text-[#0B3D2E]"
                          onClick={() => openEdit(row)}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="!h-9 !w-9 !rounded-[3px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !text-[#B3261E]"
                          onClick={() => del(row)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {/* Everything after the name, as label / value lines. */}
                  <div className="mt-2.5 space-y-1.5 border-t border-[#EAF0E9] pt-2.5">
                    {columns.slice(1).map((c) => (
                      <div key={c.key} className="flex items-center justify-between gap-3">
                        <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#7C9188]">
                          {c.label}
                        </span>
                        <span className="min-w-0 truncate text-right text-[13px] font-semibold">
                          {renderCellNode(row, c)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <div>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow
              className={cn(
                'bg-[#f1ecd9] hover:bg-[#f1ecd9]',
                __WEB__ && '!border-b-[#D6E2D6] !bg-[#EAF0E9] hover:!bg-[#EAF0E9]'
              )}
            >
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    'h-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                    __WEB__ && '!h-[42px] !text-[11px] !font-extrabold !tracking-[.12em] !text-[#33473E]',
                    c.align === 'right' && 'text-right'
                  )}
                >
                  {c.filterable ? (
                    <ColumnFilter
                      label={c.label}
                      options={filterOptions[c.key] || []}
                      value={colFilters[c.key] || []}
                      onApply={(vals) => setColFilters((prev) => ({ ...prev, [c.key]: vals }))}
                      align={c.align === 'right' ? 'end' : 'start'}
                    />
                  ) : (
                    c.label
                  )}
                </TableHead>
              ))}
              <TableHead
                className={cn(
                  'h-8 w-[90px] text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                  __WEB__ && '!h-[42px] !w-[200px] !text-[11px] !font-extrabold !tracking-[.12em] !text-[#33473E]'
                )}
              >
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
                    __WEB__ && '!border-solid !border-[#EAF0E9] hover:!bg-[#F7FAF6] [&>td]:!min-h-[56px] [&>td]:!py-3.5',
                    !readOnly && 'cursor-pointer'
                  )}
                  onClick={() => !readOnly && openEdit(row)}
                  title={readOnly ? undefined : 'Open to alter'}
                >
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn(
                        'py-1.5',
                        // The record's own name leads the row, and the date is
                        // the other thing people scan down a master list for.
                        // Every value on a master list is a fact somebody is
                        // checking, so none of them sit at the default weight.
                        __WEB__ && '!text-[13px] !font-semibold !text-[#33473E]',
                        __WEB__ && c.key === 'name' && '!text-[14.5px] !font-bold !tracking-[-0.01em] !text-[#0A1F17]',
                        __WEB__ && c.type === 'date' && '!text-[13px] !font-bold !text-[#5A6B62]',
                        c.align === 'right' && 'text-right tabular-nums'
                      )}
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
                        renderCellNode(row, c)
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
                            className="relative h-8 w-8"
                            title={typeof rowAction.title === 'function' ? rowAction.title(row) : rowAction.title}
                            onClick={() => rowAction.onClick(row)}
                          >
                            <rowAction.icon className="h-4 w-4" />
                            {rowAction.marked?.(row) && (
                              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white" />
                            )}
                          </Button>
                        )}
                        {/* The handoff gives Edit a label and Delete a tinted
                            square — the destructive one shouldn't look like
                            the everyday one. */}
                        <Button
                          variant={__WEB__ ? 'outline' : 'ghost'}
                          size={__WEB__ ? 'sm' : 'icon'}
                          className={cn(
                            'h-8 w-8',
                            __WEB__ && '!h-[34px] !w-auto gap-1.5 !rounded-[3px] !border-[#C3D2C6] !px-3 !text-[12.5px] !font-extrabold !text-[#0B3D2E]'
                          )}
                          onClick={() => openEdit(row)}
                        >
                          <Pencil className="h-4 w-4" />
                          {__WEB__ && 'Edit'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            'h-8 w-8 text-destructive',
                            __WEB__ && '!h-[34px] !w-[34px] !rounded-[3px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !text-[#B3261E] hover:!bg-[#f9e6e4]'
                          )}
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
      )}

      <Pagination
        {...paged}
        label="records"
        className={cn(
          'rounded-b-md border-t border-[#d9d2b8] bg-[#fffdf4] px-3',
          __WEB__ && '!rounded-none !border-t-0 !bg-white !px-[18px] !py-3.5',
          __WEB__ && isMobile && '!flex-wrap !gap-2 !px-3'
        )}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        {/* Re-anchored to the right edge rather than replaced: this is still a
            Radix dialog, so the focus trap holds and the custom Select still
            finds its [role="dialog"] host to portal its menu into — a bespoke
            drawer div would break every dropdown in this form. */}
        <DialogContent
          className={cn(
            'w-[calc(100vw-2rem)] max-w-2xl border-[#d9d2b8] bg-[#fffdf4]',
            __WEB__ &&
              cn(
                '!left-auto !right-0 !top-0 !flex !h-screen !max-w-none !translate-x-0 !translate-y-0 !flex-col !gap-0 !rounded-none !border-0 !bg-[#F1F5EF] !p-0 !shadow-[-16px_0_40px_rgba(10,31,23,.22)]',
                isMobile ? '!w-full' : '!w-[520px]'
              )
          )}
        >
          <DialogHeader
            className={cn(
              '-mx-6 -mt-6 mb-1 rounded-t-lg bg-[#dce6f5] px-6 py-2.5',
              __WEB__ && '!mx-0 !mt-0 !mb-0 flex-none !rounded-none !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left'
            )}
          >
            {__WEB__ && (
              <span className="text-[12px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
                {editingId == null ? `New ${title.toLowerCase()}` : `Alter ${title.toLowerCase()}`}
              </span>
            )}
            <DialogTitle
              className={cn(
                'text-[13px] font-bold uppercase tracking-widest text-[#1a2c56]',
                __WEB__ && '!mt-1 !text-[21px] !font-extrabold !normal-case !tracking-[-0.02em] !text-white'
              )}
            >
              {__WEB__
                ? editingId == null
                  ? `Add a ${title.toLowerCase()}`
                  : String(form.name || title)
                : editingId == null
                  ? `Create ${title}`
                  : `Alter ${title}`}
            </DialogTitle>
          </DialogHeader>
          <div
            className={cn(
              'grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1',
              __WEB__ &&
                '!max-h-none min-h-0 flex-1 content-start !gap-[18px] bg-[#F1F5EF] !p-[22px] [&_input]:!h-[50px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[15px] [&_[data-slot=select-trigger]]:!h-[50px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=date-picker]]:!h-[50px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_label]:!text-[9.5px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.13em] [&_label]:!text-[#5A6B62]'
            )}
          >
            {fields.map((fd) => {
              const fieldDisabled = fd.enabledWhen ? !fd.enabledWhen(form) : false
              return (
                <div key={fd.key} className={cn('flex flex-col gap-1.5', fieldDisabled && 'opacity-50')}>
                  {fd.type === 'computed' ? (
                    <>
                      <Label>{fd.label}</Label>
                      <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-sm font-semibold tabular-nums text-foreground">
                        {fd.compute?.(form) || '—'}
                      </div>
                    </>
                  ) : fd.type === 'switch' ? (
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <Label>{fd.label}</Label>
                      <Switch
                        checked={!!form[fd.key]}
                        disabled={fieldDisabled}
                        onCheckedChange={(v) => setField(fd.key, v)}
                      />
                    </div>
                  ) : fd.type === 'color' ? (
                    <>
                      <Label>
                        {fd.label}
                        {fd.required ? ' *' : ''}
                      </Label>
                      {/* The swatch and the hex, side by side. The native
                          picker alone gives no way to read back or paste a
                          value, and Clear matters because "no colour" is a
                          real choice here — the name then reads in the
                          ordinary ink. */}
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={String(form[fd.key] || '#0B3D2E')}
                          disabled={fieldDisabled}
                          onChange={(e) => setField(fd.key, e.target.value)}
                          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-white p-1"
                        />
                        <Input
                          value={String(form[fd.key] ?? '')}
                          placeholder="#0B3D2E"
                          disabled={fieldDisabled}
                          onChange={(e) => setField(fd.key, e.target.value)}
                          className="font-mono"
                        />
                        {!!form[fd.key] && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={fieldDisabled}
                            onClick={() => setField(fd.key, '')}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </>
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
                        readOnly={fd.readOnly}
                        tabIndex={fd.readOnly ? -1 : undefined}
                        title={fd.readOnly ? 'Worked out from the fields above — not typed' : undefined}
                        onChange={(e) => !fd.readOnly && setField(fd.key, e.target.value)}
                        className={cn(fd.readOnly && 'cursor-default bg-muted/40 font-semibold text-foreground')}
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
          <DialogFooter
            className={cn(
              __WEB__ && 'flex-none !justify-end gap-2.5 border-t border-[#D6E2D6] bg-white !px-[22px] !py-3.5'
            )}
          >
            <Button
              variant="outline"
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-5 !text-[13.5px] !font-extrabold !tracking-[.03em] !text-[#33473E]')}
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              {__WEB__ ? 'CANCEL' : 'Cancel'}
            </Button>
            <Button
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !bg-[#0B3D2E] !px-6 !text-[13.5px] !font-extrabold !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0f4f3b]')}
              onClick={save}
              disabled={saving || nameBlocked}
              title={nameBlocked ? 'That name is already taken' : undefined}
            >
              {__WEB__ && !saving && <Check className="h-5 w-5" />}
              {saving ? 'Saving…' : __WEB__ ? 'SAVE' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
