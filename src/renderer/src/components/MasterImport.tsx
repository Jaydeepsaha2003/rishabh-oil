import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, Plus, Upload } from 'lucide-react'
import ExcelJS from 'exceljs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { FieldDef } from '@/components/EntityManager'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// UPDATING A MASTER FROM ITS OWN EXCEL.
//
// The sheet the Download button writes — an ID column and one column per field
// of the form, headed with the field's own label — comes back in through here.
// Every row is read and checked BEFORE anything is saved: a number that is not
// one, a choice that is not on the list, a switch that is not Yes or No, a
// required field left empty, a name used twice in the file or already held by
// another record. What passes is shown as "what will change" — field by field,
// old against new — and only after a look is it applied, row by row, through
// the same save the Edit and Add buttons use, so rights, approvals, duplicate
// names and the ledgers behind a party all apply exactly as when typed.
//
// A row with an ID updates that record; a row without one updates the record
// of the same name, or adds a new one. Columns the sheet does not carry are
// left alone — a sheet of just Name and GST % changes GST % and nothing else.

type Plan = {
  line: number
  name: string
  action: 'update' | 'create' | 'same' | 'error'
  id?: number
  values: Row
  changes: { label: string; from: string; to: string }[]
  errors: string[]
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()

function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) {
    // Excel dates come back at UTC midnight.
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  }
  if (typeof v === 'object') {
    const o = v as Row
    if ('result' in o) return cellText(o.result)
    if ('text' in o) return String(o.text ?? '')
    if (Array.isArray(o.richText)) return o.richText.map((t: Row) => String(t.text ?? '')).join('')
    if ('hyperlink' in o) return String(o.text ?? o.hyperlink ?? '')
  }
  return String(v).trim()
}

function parseDate(s: string): string | null {
  const t = s.trim()
  if (!t || t === '—') return ''
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

function parseSwitch(s: string): boolean | null {
  const t = norm(s)
  if (['yes', 'y', 'true', '1', 'on'].includes(t)) return true
  if (['no', 'n', 'false', '0', 'off'].includes(t)) return false
  return null
}

const show = (fd: FieldDef, v: unknown): string => {
  if (v == null || v === '') return '—'
  if (fd.type === 'switch') return Number(v) ? 'Yes' : 'No'
  if ((fd.type === 'select' || fd.type === 'searchable') && fd.options?.length) {
    return fd.options.find((o) => String(o.value) === String(v))?.label || String(v)
  }
  return String(v)
}

export function MasterImport({
  table,
  title,
  fields,
  rows,
  onDone
}: {
  table: string
  title: string
  fields: FieldDef[]
  rows: Row[]
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [plan, setPlan] = useState<Plan[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [onlyIssues, setOnlyIssues] = useState(false)

  const editable = fields.filter((f) => f.type !== 'computed' && !f.readOnly)

  async function read(file: File): Promise<void> {
    setReading(true)
    try {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      const ws = wb.worksheets[0]
      if (!ws) throw new Error('That workbook has no sheet in it')
      const grid: string[][] = []
      ws.eachRow({ includeEmpty: true }, (r, i) => {
        const cells: string[] = []
        r.eachCell({ includeEmpty: true }, (c, col) => {
          cells[col - 1] = cellText(c.value)
        })
        grid[i - 1] = cells
      })
      // THE HEADER ROW: the first of the top rows naming at least two of the
      // form's fields — the download puts a title above it.
      const byLabel = new Map<string, FieldDef>()
      for (const f of editable) {
        byLabel.set(norm(f.label), f)
        byLabel.set(norm(f.key), f)
      }
      let headAt = -1
      for (let i = 0; i < Math.min(12, grid.length); i++) {
        const hits = (grid[i] || []).filter((h) => byLabel.has(norm(h))).length
        if (hits >= 2) {
          headAt = i
          break
        }
      }
      if (headAt < 0) throw new Error(`No header row found — use the sheet from the Download button, whose columns are headed with the ${title} form's own field names`)
      const head = grid[headAt] || []
      const idCol = head.findIndex((h) => norm(h) === 'id')
      const cols: { at: number; fd: FieldDef }[] = []
      head.forEach((h, at) => {
        const fd = byLabel.get(norm(h))
        if (fd && !cols.some((c) => c.fd.key === fd.key)) cols.push({ at, fd })
      })
      const nameField = editable.find((f) => f.key === 'name')
      if (!cols.some((c) => c.fd.key === 'name') && idCol < 0) throw new Error('The sheet needs an ID or a Name column to know which record each row is')

      const byId = new Map(rows.map((r) => [Number(r.id), r]))
      const byName = new Map<string, Row[]>()
      for (const r of rows) byName.set(norm(r.name), [...(byName.get(norm(r.name)) || []), r])
      const namesInFile = new Map<string, number>()
      const out: Plan[] = []
      for (let i = headAt + 1; i < grid.length; i++) {
        const raw = grid[i] || []
        if (!raw.some((c) => String(c ?? '').trim())) continue
        const errors: string[] = []
        const values: Row = {}
        // A choice not on today's list, held until we know the record: an old
        // value the record already carries (DIL EXIM's "PVT LTD") passes when
        // it is left as it is — only a NEW value has to be on the list.
        const offList: { fd: FieldDef; s: string }[] = []
        for (const { at, fd } of cols) {
          const s = String(raw[at] ?? '').trim()
          if (fd.type === 'number') {
            if (s === '' || s === '—') values[fd.key] = 0
            else {
              const x = Number(s.replace(/[,₹\s]/g, ''))
              if (!Number.isFinite(x)) errors.push(`${fd.label}: "${s}" is not a number`)
              else values[fd.key] = x
            }
          } else if (fd.type === 'switch') {
            if (s === '' || s === '—') continue
            const b = parseSwitch(s)
            if (b == null) errors.push(`${fd.label}: "${s}" — write Yes or No`)
            else values[fd.key] = b ? 1 : 0
          } else if (fd.type === 'date') {
            const d = parseDate(s)
            if (d == null) errors.push(`${fd.label}: "${s}" is not a date (use DD/MM/YYYY)`)
            else values[fd.key] = d || null
          } else if ((fd.type === 'select' || fd.type === 'searchable') && fd.options?.length) {
            if (s === '' || s === '—') values[fd.key] = null
            else {
              const o = fd.options.find((x) => norm(x.value) === norm(s) || norm(x.label) === norm(s))
              if (!o) offList.push({ fd, s })
              else values[fd.key] = o.value
            }
          } else {
            values[fd.key] = s === '—' ? '' : s
          }
          if (fd.required && (values[fd.key] === '' || values[fd.key] == null) && !errors.some((e) => e.startsWith(fd.label))) {
            errors.push(`${fd.label} is required`)
          }
        }
        // Which record this row is.
        const idText = idCol >= 0 ? String(raw[idCol] ?? '').trim() : ''
        let target: Row | undefined
        if (idText) {
          target = byId.get(Number(idText))
          if (!target) errors.push(`ID ${idText} is not a ${title.toLowerCase()} on file — clear the ID to add it as new`)
        } else if (values.name) {
          const same = byName.get(norm(values.name)) || []
          if (same.length > 1) errors.push(`More than one ${title.toLowerCase()} is named "${values.name}" — give the row its ID`)
          target = same[0]
        }
        for (const { fd, s } of offList) {
          if (target && norm(target[fd.key]) === norm(s)) values[fd.key] = target[fd.key]
          else errors.push(`${fd.label}: "${s}" is not one of ${(fd.options || []).slice(0, 6).map((x) => x.label).join(', ')}${(fd.options || []).length > 6 ? '…' : ''}`)
        }
        const name = String(values.name ?? target?.name ?? '').trim()
        if (name) {
          const k = norm(name)
          if (namesInFile.has(k)) errors.push(`"${name}" is on line ${namesInFile.get(k)} of the sheet as well`)
          else namesInFile.set(k, i + 1)
          const holder = (byName.get(k) || []).find((r) => Number(r.id) !== Number(target?.id))
          if (holder && target) errors.push(`"${name}" already belongs to another ${title.toLowerCase()} (ID ${holder.id})`)
        }
        if (!target && nameField && !name) errors.push('A new row needs a Name')
        if (!target) {
          // A new record: every required field has to be there.
          for (const f of editable) if (f.required && (values[f.key] === '' || values[f.key] == null) && !errors.some((e) => e.startsWith(f.label))) errors.push(`${f.label} is required`)
        }
        const changes: Plan['changes'] = []
        if (target) {
          for (const { fd } of cols) {
            if (!(fd.key in values)) continue
            const was = target[fd.key]
            const now = values[fd.key]
            const same =
              fd.type === 'number'
                ? Math.abs(Number(was || 0) - Number(now || 0)) < 1e-9
                : fd.type === 'switch'
                  ? Number(was ? 1 : 0) === Number(now ? 1 : 0)
                  : norm(was) === norm(now)
            if (!same) changes.push({ label: fd.label, from: show(fd, was), to: show(fd, now) })
          }
        }
        out.push({
          line: i + 1,
          name: name || '(no name)',
          id: target ? Number(target.id) : undefined,
          action: errors.length ? 'error' : target ? (changes.length ? 'update' : 'same') : 'create',
          values,
          changes,
          errors
        })
      }
      if (!out.length) throw new Error('The sheet has no rows under its header')
      setFileName(file.name)
      setOnlyIssues(false)
      setPlan(out)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReading(false)
      if (input.current) input.current.value = ''
    }
  }

  async function apply(): Promise<void> {
    if (!plan) return
    const todo = plan.filter((p) => p.action === 'update' || p.action === 'create')
    setApplying(true)
    let done = 0
    const failed: string[] = []
    for (const p of todo) {
      try {
        if (p.action === 'update' && p.id) {
          // Only what the sheet changed — everything else stays as it is.
          const changedKeys = new Set(p.changes.map((c) => editable.find((f) => f.label === c.label)?.key).filter(Boolean) as string[])
          const patch: Row = {}
          for (const k of changedKeys) patch[k] = p.values[k]
          await window.api.data.update(table, p.id, patch)
        } else {
          const payload: Row = {}
          for (const f of editable) {
            if (f.key in p.values) payload[f.key] = p.values[f.key]
            else if (f.default !== undefined) payload[f.key] = f.type === 'switch' ? (f.default ? 1 : 0) : f.default
          }
          await window.api.data.create(table, payload)
        }
        done++
      } catch (e) {
        failed.push(`Line ${p.line} (${p.name}): ${(e as Error).message}`)
      }
    }
    setApplying(false)
    await onDone()
    if (failed.length) {
      toast.error(`${done} saved, ${failed.length} refused — ${failed[0]}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`)
      setPlan((cur) =>
        (cur || []).map((p) => {
          const f = failed.find((x) => x.startsWith(`Line ${p.line} `))
          return f ? { ...p, action: 'error', errors: [f.replace(/^Line \d+ \([^)]*\): /, '')] } : { ...p, action: p.action === 'error' ? 'error' : 'same' }
        })
      )
    } else {
      toast.success(`${done} ${title.toLowerCase()}${done === 1 ? '' : 's'} saved from ${fileName}`)
      setPlan(null)
    }
  }

  const count = (a: Plan['action']): number => (plan || []).filter((p) => p.action === a).length
  const shown = (plan || []).filter((p) => !onlyIssues || p.action === 'error' || p.action === 'update' || p.action === 'create')
  const todo = count('update') + count('create')
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void read(f)
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={reading}
        onClick={() => input.current?.click()}
        title={`Update ${title.toLowerCase()}s from Excel — the Download sheet, edited`}
        className={cn(__WEB__ && '!h-11 !rounded-[4px] !border-[rgba(199,240,63,.35)] !bg-white/10 !px-3 !text-[13px] !font-extrabold !text-white hover:!bg-white/20')}
      >
        {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
      </Button>

      <Dialog open={!!plan} onOpenChange={(o) => !o && !applying && setPlan(null)}>
        <DialogContent className="max-h-[90vh] !w-[min(94vw,1000px)] !max-w-[min(94vw,1000px)] overflow-y-auto border-[#D6E2D6] bg-[#F2F6F1] p-0">
          <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
            <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Upload · {fileName}</div>
            <DialogTitle className="mt-1 text-[18px] font-bold text-white">Update {title.toLowerCase()}s from Excel</DialogTitle>
            <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">Nothing is saved yet. Check what each row will do, then apply. Rows with a problem are skipped.</p>
          </DialogHeader>
          <div className="grid gap-3 p-4">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-[#E4ECE3] sm:grid-cols-4">
              {[
                { k: 'Will update', v: count('update'), tone: 'text-[#1B4E82]' },
                { k: 'Will add', v: count('create'), tone: 'text-[#0B6B45]' },
                { k: 'Unchanged', v: count('same'), tone: 'text-[#5A6B62]' },
                { k: 'Problems — skipped', v: count('error'), tone: count('error') ? 'text-[#B3261E]' : 'text-[#8CA396]' }
              ].map((c) => (
                <div key={c.k} className="bg-white px-3.5 py-2.5">
                  <div className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{c.k}</div>
                  <div className={cn('mt-0.5 text-[18px] font-bold tabular-nums', c.tone)}>{c.v}</div>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[12px] font-bold text-[#33473E]">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} className="h-4 w-4 accent-[#12855A]" />
              Hide unchanged rows
            </label>
            <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
              <div className="max-h-[52vh] overflow-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-[#F7FAF6]">
                    <tr className="border-b border-[#E4ECE3] text-left text-[10px] font-extrabold uppercase tracking-[.08em] text-[#33473E]">
                      <th className="px-3 py-2">Line</th>
                      <th className="px-3 py-2">{title}</th>
                      <th className="px-3 py-2">Will</th>
                      <th className="px-3 py-2">What changes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EEF3ED]">
                    {shown.map((p) => (
                      <tr key={p.line} className={cn(p.action === 'error' && 'bg-[#FDF3F2]')}>
                        <td className="px-3 py-2 align-top tabular-nums text-[#5A6B62]">{p.line}</td>
                        <td className="px-3 py-2 align-top font-bold">
                          {p.name}
                          {p.id && <div className="text-[10.5px] font-semibold text-[#5A6B62]">ID {p.id}</div>}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {p.action === 'update' ? (
                            <span className="inline-flex items-center gap-1 font-extrabold text-[#1B4E82]">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Update
                            </span>
                          ) : p.action === 'create' ? (
                            <span className="inline-flex items-center gap-1 font-extrabold text-[#0B6B45]">
                              <Plus className="h-3.5 w-3.5" /> Add
                            </span>
                          ) : p.action === 'same' ? (
                            <span className="font-bold text-[#8CA396]">No change</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-extrabold text-[#B3261E]">
                              <AlertTriangle className="h-3.5 w-3.5" /> Skip
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {p.action === 'error' ? (
                            <ul className="list-disc pl-4 font-semibold text-[#B3261E]">
                              {p.errors.map((e, i) => (
                                <li key={i}>{e}</li>
                              ))}
                            </ul>
                          ) : p.action === 'create' ? (
                            <span className="font-semibold text-[#5A6B62]">New {title.toLowerCase()} with the sheet&rsquo;s values</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {p.changes.map((c) => (
                                <span key={c.label} className="rounded-[3px] border border-[#D6E2D6] bg-[#F7FAF6] px-1.5 py-0.5">
                                  <b>{c.label}</b>: <span className="text-[#B3261E] line-through">{c.from}</span> → <span className="font-bold text-[#0B6B45]">{c.to}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[#D6E2D6] bg-white px-5 py-3">
            <span className="text-[12px] font-semibold text-[#5A6B62]">Each row is saved like an edit by hand — the same checks and approvals apply.</span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setPlan(null)} disabled={applying}>
                Cancel
              </Button>
              <Button className="bg-[#0B3D2E] font-bold text-[#C7F03F] hover:bg-[#0F4A38]" disabled={applying || todo === 0} onClick={() => void apply()}>
                {applying ? 'Saving…' : todo ? `Apply ${todo} ${todo === 1 ? 'row' : 'rows'}` : 'Nothing to apply'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
