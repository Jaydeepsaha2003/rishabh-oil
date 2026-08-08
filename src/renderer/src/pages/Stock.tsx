import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, Building2, Check, ChevronDown, ChevronRight, Download, Plus, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange } from '@/lib/globalDateRange'
import { downloadDayCloseExcel, parseDayCloseExcel } from '@/lib/dayCloseExcel'
import { downloadSkuCountExcel, parseSkuCountExcel } from '@/lib/skuCountExcel'
import { ExcelButton } from '@/components/ExcelButton'
import { FyPicker } from '@/components/FyPicker'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// Pack size → MT per piece. Litres are treated 1 L ≈ 1 KG (the mill's despatch
// reports total 15 Ltr and 15 Kg SKUs into one MT figure the same way).
function packSizeMT(size: number, uom: string): number {
  const u = String(uom || 'KG').toUpperCase()
  const kg =
    u === 'GM' || u === 'G' || u === 'ML'
      ? size / 1000
      : u === 'QUINTAL'
        ? size * 100
        : u === 'MT' || u === 'TON' || u === 'KL'
          ? size * 1000
          : size // KG or L
  return kg / 1000
}

// Compact, colour-coded stat tile used across the Stock tabs.
const STAT_TONES: Record<string, string> = {
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  rose: 'border-rose-200 bg-rose-50 text-rose-800',
  sky: 'border-sky-200 bg-sky-50 text-sky-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-900',
  violet: 'border-violet-200 bg-violet-50 text-violet-800'
}
function MiniStat({ label, value, tone = 'slate' }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className={cn('rounded-lg border px-3 py-2', STAT_TONES[tone] || STAT_TONES.slate)}>
      <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// A number cell that reveals a party-wise breakdown on hover.
function PartyCell({ value, parties, uom, tone }: { value: number; parties: Row[]; uom?: string; tone?: string }): React.JSX.Element {
  const cell = <span className="tabular-nums">{formatNum(value)}</span>
  const cls = cn('text-right tabular-nums', tone || 'text-emerald-700')
  if (!parties || parties.length === 0) {
    return <TableCell className={cls}>{value ? cell : '—'}</TableCell>
  }
  return (
    <TableCell className={cls}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">{cell}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-0.5">
            {parties.map((p, i) => (
              <div key={i} className="flex justify-between gap-4">
                <span>{p.party}</span>
                <span className="tabular-nums font-medium">{formatNum(p.qty)} {uom || 'MT'}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TableCell>
  )
}

// One company, several, or all — the book registers aggregate whatever is
// picked. An empty selection means the active company, so the default view is
// unchanged.
function CompanyPicker({
  companies,
  value,
  onChange,
  activeId
}: {
  companies: Row[]
  value: number[]
  onChange: (ids: number[]) => void
  activeId: number
}): React.JSX.Element {
  // Same grammar as the Tanker Movement filter: one dropdown offering the
  // active company, every company together, or any single company.
  const all = companies.length > 1 && companies.every((c) => value.includes(Number(c.id)))
  const current = value.length === 0 ? 'active' : all ? 'all' : value.length === 1 ? String(value[0]) : 'all'
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        if (v === 'active') onChange([])
        else if (v === 'all') onChange(companies.map((c) => Number(c.id)))
        else onChange([Number(v)])
      }}
    >
      <SelectTrigger className="h-9 w-[13rem] text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="active">
          Active company
          {companies.find((c) => Number(c.id) === activeId)?.name
            ? ` — ${companies.find((c) => Number(c.id) === activeId)?.name}`
            : ''}
        </SelectItem>
        <SelectItem value="all">All companies</SelectItem>
        {companies.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function StockTable({ rows, breakdown, label = 'stock', range, onRange, companyPicker, companySplit = {} }: { rows: Row[]; breakdown: Record<number, { receipt: Row[]; dispatch: Row[] }>; label?: string; range: { from: string; to: string }; onRange: (r: { from: string; to: string }) => void; companyPicker?: React.ReactNode; companySplit?: Record<number, Row[]> }): React.JSX.Element {
  const ranged = !!(range.from || range.to)
  const sum = (k: string): number => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const totals = {
    opening: sum('opening'),
    received: sum('received'),
    produced: sum('produced'),
    transferred_in: sum('transferred_in'),
    transferred_out: sum('transferred_out'),
    consumed: sum('consumed'),
    sold: sum('sold'),
    stock: sum('stock')
  }
  const negatives = rows.filter((r) => Number(r.stock) < -1e-9).length
  const inFlow = totals.received + totals.produced + totals.transferred_in
  const outFlow = totals.consumed + totals.sold + totals.transferred_out
  // Excel rows: a line per product, then a line per party underneath it —
  // exactly what the hover shows — with the parties on outline level 1 so each
  // product collapses in Excel.
  const sheetRows = rows.flatMap((r) => {
    const bd = breakdown[r.id as number]
    const split = companySplit[r.id as number] || []
    const kids = [
      // Company rows first: whose books hold how much of this product.
      ...split.map((x) => ({
        party: String(x.company),
        flow: 'Company',
        opening: x.opening,
        received: x.received,
        produced: x.produced,
        transferred_in: x.transferred_in,
        transferred_out: x.transferred_out,
        consumed: x.consumed,
        sold: x.sold,
        stock: x.stock
      })),
      ...(bd?.receipt || []).map((x) => ({ party: x.party, flow: 'Receipt', received: x.qty })),
      ...(bd?.dispatch || []).map((x) => ({ party: x.party, flow: 'Dispatch', sold: x.qty }))
    ]
    return [{ ...r, is_group: true }, ...kids.map((k) => ({ name: r.name, ...k }))]
  })

  return (
    <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <MiniStat label="Products" value={String(rows.length)} tone="slate" />
      <MiniStat label="Total in" value={formatNum(inFlow)} tone="emerald" />
      <MiniStat label="Total out" value={formatNum(outFlow)} tone="rose" />
      <MiniStat label={negatives ? `In stock · ${negatives} negative` : 'In stock'} value={formatNum(totals.stock)} tone={negatives ? 'amber' : 'sky'} />
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {companyPicker}
      <FyPicker from={range.from} to={range.to} onRange={(f, t) => onRange({ from: f, to: t })} className="h-9 w-28 text-xs" />
      {/* Period for the register: opening balance before it, flows within it. */}
      <span className="text-[11px] font-semibold text-muted-foreground">From</span>
      <div className="w-40"><DatePicker value={range.from} onChange={(v) => onRange({ ...range, from: v })} /></div>
      <span className="text-[11px] font-semibold text-muted-foreground">To</span>
      <div className="w-40"><DatePicker value={range.to} onChange={(v) => onRange({ ...range, to: v })} /></div>
      {ranged && (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => onRange({ from: '', to: '' })}>
          Clear
        </Button>
      )}
      <ExcelButton
        filename={ranged ? `${label}-stock-${range.from || 'start'}-to-${range.to || todayISO()}` : `${label}-stock-${todayISO()}`}
        sheetName={`${label} stock`}
        title={`${label.charAt(0).toUpperCase()}${label.slice(1)} stock${ranged ? ` (${range.from || 'start'} → ${range.to || 'today'})` : ''}`}
        columns={[
          { header: 'Product', key: 'name', value: (r) => r.name || '' },
          { header: 'Party', key: 'party', value: (r) => r.party || '' },
          { header: 'Flow', key: 'flow', value: (r) => r.flow || '' },
          ...(ranged
            ? [{ header: 'Opening', key: 'opening', align: 'right' as const, numFmt: '#,##0.000', value: (r: Row) => Number(r.opening) || 0 }]
            : []),
          { header: 'Receipt', key: 'received', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.received) || 0 },
          { header: 'Produced', key: 'produced', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.produced) || 0 },
          { header: 'Transfer in', key: 'transferred_in', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.transferred_in) || 0 },
          { header: 'Transfer out', key: 'transferred_out', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.transferred_out) || 0 },
          { header: 'Consumed', key: 'consumed', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.consumed) || 0 },
          { header: 'Dispatch', key: 'sold', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.sold) || 0 },
          { header: ranged ? 'Closing' : 'In stock', key: 'stock', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.stock) || 0 }
        ]}
        rows={sheetRows}
        isGroup={(r) => !!r.is_group}
        outlineDetail
      />
    </div>
    <div className="rounded-xl border bg-card shadow-sm">
      <Table
        wrapperClassName="max-h-[calc(100vh-330px)] rounded-xl"
        className="min-w-[820px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
      >
        <TableHeader>
          <TableRow>
            {([
              { l: 'Product' },
              ...(ranged ? [{ l: 'Opening', r: true, tone: 'text-slate-700' }] : []),
              { l: 'Receipt', r: true, tone: 'text-emerald-700' },
              { l: 'Produced', r: true, tone: 'text-emerald-700' },
              { l: 'Transfer in', r: true, tone: 'text-emerald-700' },
              { l: 'Transfer out', r: true, tone: 'text-rose-700' },
              { l: 'Consumed', r: true, tone: 'text-rose-700' },
              { l: 'Dispatch', r: true, tone: 'text-rose-700' },
              { l: ranged ? 'Closing' : 'In stock', r: true, tone: 'text-sky-800' }
            ] as { l: string; r?: boolean; tone?: string }[]).map((h) => (
              <TableHead
                key={h.l}
                className={cn(
                  'sticky top-0 z-20 bg-slate-100 text-[10px] font-semibold uppercase tracking-wide',
                  h.tone || 'text-slate-700',
                  h.r && 'text-right'
                )}
              >
                {h.l}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={ranged ? 9 : 8} className="py-10 text-center text-muted-foreground">
                Nothing here yet.
              </TableCell>
            </TableRow>
          ) : (
            <>
              {rows.map((r, i) => (
                <TableRow key={r.id as number} className={cn('border-b', i % 2 === 1 && 'bg-muted/30')}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  {ranged && (
                    <TableCell className="text-right tabular-nums text-slate-700">
                      {Number(r.opening) ? formatNum(r.opening) : '—'}
                    </TableCell>
                  )}
                  <PartyCell value={Number(r.received)} parties={breakdown[r.id as number]?.receipt || []} />
                  <TableCell className="text-right tabular-nums text-emerald-700">{Number(r.produced) ? formatNum(r.produced) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-700">{Number(r.transferred_in) > 0 ? formatNum(r.transferred_in) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-rose-700">{Number(r.transferred_out) > 0 ? formatNum(r.transferred_out) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-rose-700">{Number(r.consumed) ? formatNum(r.consumed) : '—'}</TableCell>
                  <PartyCell value={Number(r.sold)} parties={breakdown[r.id as number]?.dispatch || []} tone="text-rose-700" />
                  <TableCell
                    className={cn(
                      'text-right font-bold tabular-nums',
                      Number(r.stock) < -1e-9 ? 'text-red-600' : 'text-sky-900'
                    )}
                  >
                    {formatNum(r.stock)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                <TableCell className="text-[11px] font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
                {ranged && <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.opening)}</TableCell>}
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.received)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.produced)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.transferred_in)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.transferred_out)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.consumed)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.sold)}</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totals.stock)}</TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-[15px] font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  )
}

// The two work-sections of the day-close sheet — one person owns each. Actual
// value is auto-valued at the weighted-average cost (never hand-typed).
const DAY_SECTIONS: Array<{ key: string; title: string; cats: string[] }> = [
  { key: 'raw-intermediate', title: 'Raw + Intermediate', cats: ['raw', 'intermediate'] },
  { key: 'finished', title: 'Finished', cats: ['finished'] }
]

// Daily physical-count sheet: enter actual closing stock and compare with the
// computed book stock to see the difference (for tally / reconciliation). Split
// into two owners — Raw/Intermediate and Finished — each with its own protected
// Excel download/upload; actual value = actual qty × weighted-average cost.
function DayClose(): React.JSX.Element {
  const [date, setDate] = useState(todayISO())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<string>(DAY_SECTIONS[0].key)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await window.api.stockCount.sheet(date))
    setLoading(false)
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  function setField(pid: number, key: string, value: unknown): void {
    setRows((rs) => rs.map((r) => (r.product_id === pid ? { ...r, [key]: value } : r)))
  }

  const rateOf = (r: Row): number => Number(r.rate) || 0
  const actualValueOf = (r: Row): number => (Number(r.actual_qty) || 0) * rateOf(r)
  const diffOf = (r: Row): number => Number(r.book_qty || 0) - Number(r.actual_qty || 0)

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const res = await window.api.stockCount.save(date, rows)
      toast.success(`Saved ${res.count} actual ${res.count === 1 ? 'count' : 'counts'}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Merge an uploaded sheet into this section's rows and SAVE it straight away —
  // an uploaded count sheet is meant to be recorded, so it must not sit unsaved
  // in the grid (where a reload or date change would silently discard it).
  async function applyImport(
    cats: string[],
    parsed: Array<{ product_id?: number; name?: string; actual_qty?: string; pp_qty?: string; note?: string }>
  ): Promise<{ applied: number; saved: number }> {
    const byId = new Map<string, (typeof parsed)[number]>()
    const byName = new Map<string, (typeof parsed)[number]>()
    for (const p of parsed) {
      if (p.product_id != null) byId.set(String(p.product_id), p)
      if (p.name) byName.set(p.name.trim().toLowerCase(), p)
    }
    let applied = 0
    const merged = rows.map((r) => {
      if (!cats.includes(String(r.category))) return r
      const p = byId.get(String(r.product_id)) || byName.get(String(r.name).toLowerCase())
      if (!p) return r
      const hasQty = p.actual_qty != null && p.actual_qty !== ''
      const hasPp = p.pp_qty != null && p.pp_qty !== ''
      const hasNote = p.note != null && p.note !== ''
      if (!hasQty && !hasNote) return r
      applied++
      return {
        ...r,
        actual_qty: hasQty ? p.actual_qty : r.actual_qty,
        pp_qty: hasPp ? p.pp_qty : r.pp_qty,
        note: hasNote ? p.note : r.note
      }
    })
    setRows(merged)
    const res = await window.api.stockCount.save(date, merged)
    await load()
    return { applied, saved: res.count }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">Closing date</Label>
          <DatePicker max={todayISO()} value={date} onChange={(v) => setDate(v || todayISO())} className="w-44" />
        </div>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save day close'}</Button>
      </div>

      <Tabs value={section} onValueChange={setSection}>
        <TabsList>
          {DAY_SECTIONS.map((s) => (
            <TabsTrigger key={s.key} value={s.key}>{s.title}</TabsTrigger>
          ))}
        </TabsList>
        {DAY_SECTIONS.map((s) => (
          <TabsContent key={s.key} value={s.key} className="mt-4">
            <DayCloseSection
              section={s}
              date={date}
              loading={loading}
              rows={rows.filter((r) => s.cats.includes(r.category))}
              setField={setField}
              onImport={applyImport}
              rateOf={rateOf}
              actualValueOf={actualValueOf}
              diffOf={diffOf}
            />
          </TabsContent>
        ))}
      </Tabs>

      <p className="text-xs text-muted-foreground">
        Book qty is the system-computed stock (received + produced − consumed − sold). PP is the presentation stock counted alongside the physical figure. Difference = book − actual; a positive value means physical stock is short of the books. Actual value is valued automatically at the weighted-average cost (rate × actual qty). Download a protected Excel per section — only the Actual qty and Note cells are editable — hand it to the person counting, then upload it back — uploading records the counts immediately.
      </p>
    </div>
  )
}

// One section (Raw+Intermediate or Finished): its own download/upload + grid.
function DayCloseSection({
  section,
  date,
  loading,
  rows,
  setField,
  onImport,
  rateOf,
  actualValueOf,
  diffOf
}: {
  section: { key: string; title: string; cats: string[] }
  date: string
  loading: boolean
  rows: Row[]
  setField: (pid: number, key: string, value: unknown) => void
  onImport: (cats: string[], parsed: Array<{ product_id?: number; name?: string; actual_qty?: string; pp_qty?: string; note?: string }>) => Promise<{ applied: number; saved: number }>
  rateOf: (r: Row) => number
  actualValueOf: (r: Row) => number
  diffOf: (r: Row) => number
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)

  const counted = rows.filter((r) => (r.actual_qty !== null && r.actual_qty !== '') || (r.pp_qty !== null && r.pp_qty !== ''))
  const totalDiff = counted.reduce((s, r) => s + diffOf(r), 0)
  const totalActualValue = rows.reduce((s, r) => s + actualValueOf(r), 0)
  const mismatches = counted.filter((r) => Math.abs(diffOf(r)) > 0.0005).length

  async function onDownload(): Promise<void> {
    try {
      await downloadDayCloseExcel(rows, section, date)
      toast.success(`Downloaded the protected ${section.title} sheet`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Upload a filled Excel — match by Product ID (or name) into this section's rows.
  async function onUpload(file: File | undefined): Promise<void> {
    if (!file) return
    try {
      const parsed = await parseDayCloseExcel(file)
      if (!parsed.length) {
        toast.error('No data rows found in the file')
        return
      }
      const byId = new Map<string, (typeof parsed)[number]>()
      const byName = new Map<string, (typeof parsed)[number]>()
      for (const p of parsed) {
        if (p.product_id != null) byId.set(String(p.product_id), p)
        if (p.name) byName.set(p.name.trim().toLowerCase(), p)
      }
      const { applied, saved } = await onImport(section.cats, parsed)
      if (applied === 0) {
        toast.error('No matching products in this section — check you uploaded the right sheet')
      } else {
        toast.success(`Imported ${applied} ${applied === 1 ? 'row' : 'rows'} and saved (${saved} counts recorded)`)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 flex-1">
          <StatCard label="Products counted" value={`${counted.length} / ${rows.length}`} />
          <StatCard label="Mismatches" value={String(mismatches)} tone={mismatches ? 'text-amber-700' : 'text-emerald-700'} />
          <StatCard label="Net difference (book − actual)" value={`${formatNum(totalDiff)}`} tone={Math.abs(totalDiff) > 0.0005 ? 'text-amber-700' : ''} />
          <StatCard label="Section actual value" value={formatINR(totalActualValue)} />
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => onUpload(e.target.files?.[0])}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download className="mr-2 h-4 w-4" /> Excel
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download the protected {section.title} sheet (only Actual qty + Note editable)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Upload
              </Button>
            </TooltipTrigger>
            <TooltipContent>Upload the filled {section.title} sheet — the counts are recorded straight away</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Book qty</TableHead>
              <TableHead className="w-[130px] text-right">Actual qty</TableHead>
              <TableHead className="w-[120px] text-right">
                PP <span className="text-[10px] font-normal text-muted-foreground">(presentation)</span>
              </TableHead>
              <TableHead className="text-right">Difference</TableHead>
              <TableHead className="text-right">Rate (₹)</TableHead>
              <TableHead className="text-right">Actual value (₹)</TableHead>
              <TableHead className="w-[180px]">Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No products in this section.</TableCell></TableRow>
            ) : (
              rows.map((r) => {
                const has = r.actual_qty !== null && r.actual_qty !== ''
                const diff = diffOf(r)
                const off = has && Math.abs(diff) > 0.0005
                return (
                  <TableRow key={r.product_id as number}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell><Badge variant="secondary">{CAT_LABEL[r.category] || r.category}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.book_qty)}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        className="h-8 w-28 text-right"
                        placeholder="—"
                        value={r.actual_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'actual_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        className="h-8 w-24 text-right"
                        placeholder="—"
                        value={r.pp_qty ?? ''}
                        onChange={(e) => setField(r.product_id, 'pp_qty', e.target.value)}
                      />
                    </TableCell>
                    <TableCell className={cn('text-right tabular-nums', off ? (diff > 0 ? 'text-amber-700' : 'text-red-600') : 'text-muted-foreground')}>
                      {has ? formatNum(diff) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{rateOf(r) ? formatNum(rateOf(r)) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{has ? formatINR(actualValueOf(r)) : '—'}</TableCell>
                    <TableCell>
                      <Input
                        className="h-8"
                        placeholder="optional"
                        value={r.note ?? ''}
                        onChange={(e) => setField(r.product_id, 'note', e.target.value)}
                      />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
            {!loading && rows.length > 0 && (
              <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                <TableCell colSpan={2} className="font-bold uppercase tracking-wide text-amber-900">Total</TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.book_qty) || 0), 0))}
                </TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.actual_qty) || 0), 0))}
                </TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">
                  {formatNum(rows.reduce((a, r) => a + (Number(r.pp_qty) || 0), 0))}
                </TableCell>
                <TableCell className="text-right font-bold tabular-nums text-amber-900">
                  {formatNum(
                    rows.reduce(
                      (a, r) => a + (r.actual_qty !== null && r.actual_qty !== '' ? diffOf(r) : 0),
                      0
                    )
                  )}
                </TableCell>
                <TableCell />
                <TableCell className="text-right font-bold tabular-nums text-amber-900">
                  {formatINR(rows.reduce((a, r) => a + actualValueOf(r), 0))}
                </TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// Searchable multi-select for narrowing the Packed SKU table to specific
// SKUs — a long SKU list is unworkable as a plain dropdown, so this is a
// checklist-style combobox (type to filter, click to toggle, chips to undo).
function SkuMultiSelect({
  skus,
  value,
  onChange
}: {
  skus: Row[]
  value: string[]
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const picked = new Set(value)
  const selectedRows = skus.filter((s) => picked.has(String(s.id)))

  function toggle(id: string): void {
    const next = new Set(value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 min-w-[11rem] max-w-xs items-center gap-1.5 rounded-md border bg-white px-2.5 text-[13px]',
            'focus:outline-none focus:ring-2 focus:ring-primary/40',
            !value.length && 'text-muted-foreground'
          )}
        >
          <span className="truncate">
            {value.length === 0
              ? 'Filter by SKU…'
              : value.length === 1
                ? selectedRows[0]?.name || '1 selected'
                : `${value.length} SKUs selected`}
          </span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Search SKU…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No SKU matches.</CommandEmpty>
            {skus.map((s) => {
              const id = String(s.id)
              const isPicked = picked.has(id)
              return (
                <CommandItem key={id} value={String(s.name || '')} onSelect={() => toggle(id)}>
                  <span
                    className={cn(
                      'mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      isPicked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                    )}
                  >
                    {isPicked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{s.name}</span>
                </CommandItem>
              )
            })}
          </CommandList>
          {value.length > 0 && (
            <div className="flex items-center justify-between border-t p-1.5">
              <span className="px-1 text-[11px] text-muted-foreground">{value.length} selected</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => onChange([])}
              >
                <X className="h-3 w-3" /> Clear
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Packed finished stock per SKU (packaging). A lightweight, manually-maintained
// count: add packs in / remove, and it's reduced automatically by dispatched
// PACKED sales of that SKU. on-hand = packed in − packed sold (in units).
function SkuStock(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [adjustRow, setAdjustRow] = useState<Row | null>(null)
  const [adjustForm, setAdjustForm] = useState<{ mode: 'add' | 'remove'; amount: string; note: string; date: string }>({
    mode: 'add',
    amount: '',
    note: '',
    date: todayISO()
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Day register: pick a date to see/update that day's pieces (opening b/f +
  // packed in − despatched = closing). "All time" shows running totals.
  const [dayMode, setDayMode] = useState(true)
  const [date, setDate] = useState(todayISO())

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await window.api.skuStock.list(dayMode ? date : undefined))
    setLoading(false)
  }, [dayMode, date])
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  const unitLabel = (r: Row): string => {
    const size = Number(r.unit_size) || 0
    if (size > 0) return `${formatNum(size)} ${r.unit_uom || ''}`.trim()
    const bpp = Number(r.base_per_pouch) || 0
    return bpp > 0 ? `${formatNum(bpp)} ${r.base_uom || ''}`.trim() : '—'
  }

  // Tonnage of one SKU's on-hand pieces (pieces × pack size → MT).
  const skuMT = (r: Row): number => {
    const size = Number(r.unit_size) > 0 ? Number(r.unit_size) : Number(r.base_per_pouch) || 0
    const uom = Number(r.unit_size) > 0 ? String(r.unit_uom || 'KG') : String(r.base_uom || 'KG')
    return (Number(r.on_hand) || 0) * packSizeMT(size, uom)
  }

  // Every SKU's tonnage, summed — the sheet's TOTAL (MT).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const totalMT = useMemo(() => rows.reduce((s, r) => s + skuMT(r), 0), [rows])

  function openAdjust(row: Row): void {
    setAdjustRow(row)
    // Default the entry to the day being viewed, so day-wise updates land there.
    setAdjustForm({ mode: 'add', amount: '', note: '', date: dayMode ? date : todayISO() })
    setError(null)
  }

  async function saveAdjust(): Promise<void> {
    if (!adjustRow) return
    const amt = Number(adjustForm.amount)
    if (!amt || amt <= 0) { setError('Enter a quantity greater than zero'); return }
    const delta = adjustForm.mode === 'add' ? amt : -amt
    setSaving(true)
    setError(null)
    try {
      await window.api.skuStock.adjust(Number(adjustRow.id), delta, adjustForm.note || undefined, adjustForm.date || undefined)
      toast.success(`${adjustForm.mode === 'add' ? 'Added' : 'Removed'} ${amt} × ${adjustRow.name}`)
      setAdjustRow(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const totalOnHand = rows.reduce((s, r) => s + (Number(r.on_hand) || 0), 0)
  const negatives = rows.filter((r) => Number(r.on_hand) < -1e-6).length

  // Search + hide-empty, so a long SKU list stays workable. skuPick narrows to
  // specific SKUs (searchable multi-select) — empty means no narrowing.
  const [search, setSearch] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [skuPick, setSkuPick] = useState<string[]>([])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const picked = new Set(skuPick)
    return rows.filter((r) => {
      if (q && !String(r.name || '').toLowerCase().includes(q)) return false
      if (picked.size && !picked.has(String(r.id))) return false
      if (hideEmpty) {
        const moved = (Number(r.opening) || 0) + (Number(r.added_on ?? r.added) || 0) + (Number(r.sold_on ?? r.sold) || 0)
        if (Math.abs(Number(r.on_hand) || 0) < 1e-6 && Math.abs(moved) < 1e-6) return false
      }
      return true
    })
  }, [rows, search, hideEmpty, skuPick])
  const shownMT = useMemo(() => shown.reduce((s, r) => s + skuMT(r), 0), [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Excel count sheet -------------------------------------------------
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)

  async function downloadCountSheet(): Promise<void> {
    try {
      await downloadSkuCountExcel(
        shown.map((r) => ({ ...r, pack_label: unitLabel(r) })),
        dayMode ? date : todayISO(),
        skuMT
      )
      toast.success('Count sheet downloaded — only the Counted column is editable')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // A filled-in sheet is applied as dated adjustments: for each SKU the delta
  // between the counted closing and what the system holds, dated to the day
  // being viewed. Untouched rows come back equal, so they change nothing.
  async function importCountSheet(file: File): Promise<void> {
    setImporting(true)
    try {
      const parsed = await parseSkuCountExcel(file)
      if (!parsed.length) {
        toast.error('No counted rows found — use the downloaded count sheet')
        return
      }
      const when = dayMode ? date : todayISO()
      let applied = 0
      let unchanged = 0
      const missing: string[] = []
      for (const p of parsed) {
        const row =
          rows.find((r) => Number(r.id) === p.id) ||
          rows.find((r) => String(r.name || '').toLowerCase() === p.name.toLowerCase())
        if (!row) {
          missing.push(p.name)
          continue
        }
        const delta = p.counted - (Number(row.on_hand) || 0)
        if (Math.abs(delta) < 1e-6) {
          unchanged++
          continue
        }
        await window.api.skuStock.adjust(
          Number(row.id),
          delta,
          p.note || `Closing count ${formatDate(when)}`,
          when
        )
        applied++
      }
      await load()
      toast.success(
        `${applied} SKU${applied === 1 ? '' : 's'} updated${unchanged ? `, ${unchanged} already matched` : ''}` +
          (missing.length ? ` · not found: ${missing.slice(0, 3).join(', ')}` : '')
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      {/* Controls: period, search, and the count-sheet round trip */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border p-0.5">
          <button
            type="button"
            onClick={() => setDayMode(true)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] font-medium transition',
              dayMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Day wise
          </button>
          <button
            type="button"
            onClick={() => setDayMode(false)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] font-medium transition',
              !dayMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            All time
          </button>
        </div>
        {dayMode && (
          <div className="flex items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Date</span>
            <DatePicker max={todayISO()} value={date} onChange={(v) => setDate(v || todayISO())} className="w-36" />
            <Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => setDate(todayISO())}>
              Today
            </Button>
          </div>
        )}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU…"
          className="h-8 w-40 text-[13px]"
        />
        <SkuMultiSelect skus={rows} value={skuPick} onChange={setSkuPick} />
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
          <Switch checked={hideEmpty} onCheckedChange={setHideEmpty} />
          Hide untouched
        </label>

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importCountSheet(f)
            }}
          />
          <Button variant="outline" size="sm" onClick={downloadCountSheet} disabled={!shown.length}>
            <Download className="h-4 w-4" /> Count sheet
          </Button>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            <Upload className="h-4 w-4" /> {importing ? 'Uploading…' : 'Upload closing'}
          </Button>
          <ExcelButton
            filename={`packed-sku-stock-${dayMode ? date : todayISO()}`}
            sheetName="Packed SKU stock"
            title={`Packed SKU stock${dayMode ? ` — ${formatDate(date)}` : ''}`}
            columns={
              dayMode
                ? [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Opening (pcs)', key: 'opening', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.opening) || 0 },
                    { header: 'Packed in', key: 'added_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added_on) || 0 },
                    { header: 'Despatch', key: 'sold_on', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold_on) || 0 },
                    { header: 'Closing (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'Closing (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
                : [
                    { header: 'SKU', key: 'name', value: (r) => r.name || '' },
                    { header: 'Pack size', key: 'size', value: (r) => unitLabel(r) },
                    { header: 'Packed in', key: 'added', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.added) || 0 },
                    { header: 'Sold (packed)', key: 'sold', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.sold) || 0 },
                    { header: 'On hand (pcs)', key: 'on_hand', align: 'right' as const, numFmt: '#,##0.000', value: (r) => Number(r.on_hand) || 0 },
                    { header: 'On hand (MT)', key: 'mt', align: 'right' as const, numFmt: '#,##0.000', value: (r) => skuMT(r) }
                  ]
            }
            rows={shown}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <MiniStat label="SKUs" value={`${shown.length}${shown.length !== rows.length ? ` / ${rows.length}` : ''}`} tone="slate" />
        <MiniStat label={dayMode ? 'Packed in' : 'Packed (total)'} value={formatNum(rows.reduce((s, r) => s + (dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0), 0))} tone="emerald" />
        <MiniStat label={dayMode ? 'Despatched' : 'Sold (packed)'} value={formatNum(rows.reduce((s, r) => s + (dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0), 0))} tone="rose" />
        <MiniStat label={dayMode ? 'Closing (pcs)' : 'On hand (pcs)'} value={formatNum(totalOnHand)} tone="sky" />
        <MiniStat label={dayMode ? 'Closing (MT)' : 'On hand (MT)'} value={`${formatNum(totalMT)} MT`} tone="violet" />
      </div>

      {negatives > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          <b>{negatives}</b> SKU{negatives === 1 ? '' : 's'} below zero — more despatched than packed. Check the packing
          entries for those rows.
        </div>
      )}

      <div className="rounded-xl border bg-card shadow-sm">
        <Table
          wrapperClassName="max-h-[calc(100vh-360px)] rounded-xl"
          className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-slate-200 hover:bg-slate-200">
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">SKU</TableHead>
              <TableHead className="text-[10px] font-semibold uppercase tracking-wide text-slate-700">Pack</TableHead>
              {dayMode && (
                <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">Opening</TableHead>
              )}
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Packed in' : 'Packed (total)'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Despatch' : 'Sold'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Closing (pcs)' : 'On hand (pcs)'}
              </TableHead>
              <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                {dayMode ? 'Closing (MT)' : 'On hand (MT)'}
              </TableHead>
              <TableHead className="w-[64px] text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                Update
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={dayMode ? 8 : 7} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={dayMode ? 8 : 7} className="py-12 text-center text-muted-foreground">
                  {rows.length === 0
                    ? 'No SKUs. Add packagings under Masters → Packed SKU first.'
                    : 'No SKU matches this search.'}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {shown.map((r, i) => {
                  const onHand = Number(r.on_hand) || 0
                  const inQty = dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0
                  const outQty = dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0
                  const touched = inQty > 1e-6 || outQty > 1e-6
                  return (
                    <TableRow
                      key={r.id as number}
                      className={cn('border-b', i % 2 === 1 && 'bg-muted/30', touched && 'bg-sky-50/70 hover:bg-sky-50')}
                    >
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{unitLabel(r)}</TableCell>
                      {dayMode && (
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {Number(r.opening) ? formatNum(r.opening) : '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-medium tabular-nums text-emerald-700">
                        {inQty ? formatNum(inQty) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-red-600">
                        {outQty ? formatNum(outQty) : '—'}
                      </TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', onHand < -1e-6 ? 'text-red-600' : 'text-slate-900')}>
                        {formatNum(onHand)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-violet-700">{formatNum(skuMT(r))}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={dayMode ? `Add / remove packs on ${formatDate(date)}` : 'Add / remove packs'}
                          onClick={() => openAdjust(r)}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell colSpan={dayMode ? 3 : 2} className="font-bold uppercase tracking-wide text-amber-900">
                    Total{shown.length !== rows.length ? ' (filtered)' : ''}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.added_on) || 0 : Number(r.added) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (dayMode ? Number(r.sold_on) || 0 : Number(r.sold) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">
                    {formatNum(shown.reduce((s, r) => s + (Number(r.on_hand) || 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(shownMT)} MT</TableCell>
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {dayMode
          ? 'Day wise: opening (brought forward) + packed in on this date − despatched on this date = closing. Rows with movement on the day are tinted. Closing (MT) = pieces × pack size (1 L counted as 1 KG). Use the sliders icon for one SKU, or Count sheet → Upload closing to set the whole day at once.'
          : 'All time: packs added − packs sold on dispatched PACKED sales = on hand. On hand (MT) = pieces × pack size (1 L counted as 1 KG).'}
      </p>

      <Dialog open={!!adjustRow} onOpenChange={(o) => !o && setAdjustRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update packed stock — {adjustRow?.name}</DialogTitle>
          </DialogHeader>
          {adjustRow && (() => {
            const onHand = Number(adjustRow.on_hand) || 0
            const amt = Number(adjustForm.amount) || 0
            const delta = adjustForm.mode === 'add' ? amt : -amt
            const newHand = onHand + delta
            return (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'add' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'add' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'hover:bg-muted/40')}>+ Add packs</button>
                  <button type="button" onClick={() => setAdjustForm((p) => ({ ...p, mode: 'remove' }))} className={cn('flex-1 rounded-md border px-3 py-2 text-sm font-medium', adjustForm.mode === 'remove' ? 'border-red-500 bg-red-50 text-red-700' : 'hover:bg-muted/40')}>− Remove packs</button>
                </div>
                <div className="grid gap-1.5">
                  <Label>Packs to {adjustForm.mode === 'add' ? 'add' : 'remove'}</Label>
                  <Input type="number" autoFocus value={adjustForm.amount} onChange={(e) => setAdjustForm((p) => ({ ...p, amount: e.target.value }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={adjustForm.date} onChange={(v) => setAdjustForm((p) => ({ ...p, date: v || '' }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Note (optional)</Label>
                  <Input value={adjustForm.note} onChange={(e) => setAdjustForm((p) => ({ ...p, note: e.target.value }))} placeholder="e.g. packed today / stock correction" />
                </div>
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  On hand: <span className="tabular-nums">{formatNum(onHand)}</span> → <span className={cn('font-semibold tabular-nums', newHand < -1e-9 && 'text-red-600')}>{formatNum(newHand)}</span>
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustRow(null)} disabled={saving}>Cancel</Button>
            <Button onClick={saveAdjust} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// MNC / consignment stock: goods a supplier (e.g. BUNGE) keeps at our place.
// It is NOT our stock until invoiced, so it is shown separately here —
// deposited − invoiced = balance still owned by the supplier.
function MncStock(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [lots, setLots] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  // Opening stock: what the MNC already held with us when the books started.
  // No gate entry behind it, so it is entered by hand.
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [openingOpen, setOpeningOpen] = useState(false)
  const [opening, setOpening] = useState<Row>({})
  const [openingLog, setOpeningLog] = useState<Row[]>([])
  const [savingOpening, setSavingOpening] = useState(false)
  const [openingError, setOpeningError] = useState<string | null>(null)
  // Period for the register: opening balance before it, deposits/invoices
  // within it — same convention as Book Stock's date range.
  const [mncFrom, setMncFrom] = useState('')
  const [mncTo, setMncTo] = useState('')
  const mncRanged = !!(mncFrom || mncTo)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRangeMnc = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeMnc.version > 0) { setMncFrom(globalRangeMnc.from); setMncTo(globalRangeMnc.to) }
  }, [globalRangeMnc.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true)
    const [sm, ls, sup, prd] = await Promise.all([
      window.api.consignment.summary(mncRanged ? { from: mncFrom, to: mncTo } : undefined),
      window.api.consignment.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('products')
    ])
    setRows(sm)
    setLots(ls)
    setSuppliers(sup.filter((x) => x.active))
    setProducts(prd.filter((x) => x.active))
    setLoading(false)
  }, [mncRanged, mncFrom, mncTo])

  // The opening lot already recorded for a party + product, if any. A second
  // entry restates it rather than adding another row.
  // Every unbooked opening lot for a party + product. Normally one, but entries
  // made before opening stock became an update-in-place can leave several.
  const openingLotsFor = useCallback(
    (supplierId: unknown, productId: unknown): Row[] =>
      lots
        .filter(
          (l) =>
            Number(l.is_opening) === 1 &&
            l.order_id == null &&
            String(l.supplier_id) === String(supplierId || '') &&
            String(l.product_id) === String(productId || '')
        )
        // Newest first: the last figure entered is the one that counts.
        .sort((a, b) => Number(b.id) - Number(a.id)),
    [lots]
  )
  const openingLotFor = useCallback(
    (supplierId: unknown, productId: unknown): Row | undefined => openingLotsFor(supplierId, productId)[0],
    [openingLotsFor]
  )
  const existingOpenings = openingLotsFor(opening.supplier_id, opening.product_id)
  const existingOpening = existingOpenings[0]
  const existingOpeningTotal = existingOpenings.reduce((s, l) => s + (Number(l.qty) || 0), 0)

  function openOpeningStock(supplierId?: unknown, productId?: unknown): void {
    const existing = openingLotsFor(supplierId, productId)
    const found = existing[0]
    setOpening({
      supplier_id: supplierId ? String(supplierId) : '',
      product_id: productId ? String(productId) : '',
      qty: existing.length ? String(existing[0].qty ?? '') : '',
      uom: String(found?.uom || 'MT'),
      deposit_date: String(found?.deposit_date || todayISO()).slice(0, 10),
      note: found?.note ?? ''
    })
    setOpeningError(null)
    setOpeningOpen(true)
  }

  async function saveOpeningStock(): Promise<void> {
    if (!opening.supplier_id) return setOpeningError('Choose the MNC / party')
    if (!opening.product_id) return setOpeningError('Choose the product')
    if ((Number(opening.qty) || 0) <= 0) return setOpeningError('Enter the opening quantity')
    setSavingOpening(true)
    setOpeningError(null)
    try {
      // One validated main-process step: logs the old figure, merges duplicate
      // lots, refuses figures below what is already drawn or future dates.
      await window.api.consignment.saveOpening({
        supplier_id: Number(opening.supplier_id),
        product_id: Number(opening.product_id),
        qty: Number(opening.qty),
        uom: opening.uom || 'MT',
        deposit_date: opening.deposit_date,
        note: opening.note ? String(opening.note).trim() : 'Opening stock'
      })
      toast.success(`Opening stock set to ${formatNum(Number(opening.qty))} ${opening.uom || 'MT'}`)
      setOpeningOpen(false)
      await load()
    } catch (e) {
      setOpeningError((e as Error).message)
    } finally {
      setSavingOpening(false)
    }
  }

  // The band's live numbers for the pair in the dialog — shown before changing.
  const dlgBand = rows.find(
    (r) => String(r.supplier_id) === String(opening.supplier_id) && String(r.product_id) === String(opening.product_id)
  )
  const dlgDrawn = dlgBand ? (Number(dlgBand.deposited) || 0) - (Number(dlgBand.balance) || 0) : 0
  const dlgMin = dlgBand ? Math.max(0, dlgDrawn - ((Number(dlgBand.deposited) || 0) - existingOpeningTotal)) : 0
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // The restatement trail for the pair currently in the dialog — every set,
  // restate and delete of this opening, so mistakes can be put back.
  useEffect(() => {
    if (!openingOpen || !opening.supplier_id || !opening.product_id) {
      setOpeningLog([])
      return
    }
    let live = true
    window.api.consignment
      .openingLog(Number(opening.supplier_id), Number(opening.product_id))
      .then((r) => { if (live) setOpeningLog(r) })
      .catch(() => {})
    return () => { live = false }
  }, [openingOpen, opening.supplier_id, opening.product_id])

  const key = (r: Row): string => `${r.supplier_id}:${r.product_id}`
  function toggle(k: string): void {
    setOpen((p) => {
      const next = new Set(p)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  // The Opening figure a row shows: the pre-books manual balance when there is
  // no period selected, or the period's computed opening (which already
  // folds that manual balance in, once it is dated before the range) once a
  // range is chosen — same convention as Book Stock's ranged Opening column.
  const openingFor = useCallback(
    (r: Row): number =>
      mncRanged
        ? Number(r.opening) || 0
        : openingLotsFor(r.supplier_id, r.product_id).reduce((s2, l) => s2 + (Number(l.qty) || 0), 0),
    [mncRanged, openingLotsFor]
  )

  // Roll up per supplier — the "MNC" view (all of Bunge's stock with us).
  const byParty = useMemo(() => {
    const m = new Map<string, { name: string; opening: number; deposited: number; invoiced: number; balance: number; rows: Row[] }>()
    for (const r of rows) {
      const k = String(r.supplier_name || '—')
      if (!m.has(k)) m.set(k, { name: k, opening: 0, deposited: 0, invoiced: 0, balance: 0, rows: [] })
      const g = m.get(k)!
      g.opening += openingFor(r)
      g.deposited += Number(r.deposited) || 0
      g.invoiced += Number(r.invoiced) || 0
      g.balance += Number(r.balance) || 0
      g.rows.push(r)
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [rows, openingFor])

  const tot = rows.reduce(
    (s, r) => ({
      deposited: s.deposited + (Number(r.deposited) || 0),
      invoiced: s.invoiced + (Number(r.invoiced) || 0),
      balance: s.balance + (Number(r.balance) || 0)
    }),
    { deposited: 0, invoiced: 0, balance: 0 }
  )
  const totOpening = byParty.reduce((s, g) => s + g.opening, 0)

  // Excel rows: party+product summary, then each of its lots underneath.
  const mncSheetRows = byParty.flatMap((g) =>
    g.rows.flatMap((p) => [
      {
        supplier_name: g.name,
        product_code: p.product_code || p.product_name,
        opening: openingFor(p),
        deposited: p.deposited,
        invoiced: p.invoiced,
        balance: p.balance,
        uom: p.uom,
        is_group: true
      },
      ...lots
        .filter(
          (l) =>
            String(l.supplier_id) === String(p.supplier_id) && String(l.product_id) === String(p.product_id)
        )
        .map((l) => ({
          supplier_name: g.name,
          product_code: p.product_code || p.product_name,
          deposit_date: l.deposit_date,
          tanker_no: l.tanker_no,
          gate_entry_no: l.gate_entry_no,
          weighed_qty: l.weighed_qty,
          shortage_pct: l.shortage_pct,
          deposited: l.qty,
          uom: l.uom,
          invoice_no: l.invoice_no,
          status: Number(l.qty) > 0 ? 'Completed' : 'Pending'
        }))
    ])
  )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MiniStat label="Parties" value={String(byParty.length)} tone="violet" />
        <MiniStat label={mncRanged ? 'Deposited (period)' : 'Deposited'} value={formatNum(tot.deposited)} tone="emerald" />
        <MiniStat label={mncRanged ? 'Invoiced (period)' : 'Invoiced (became ours)'} value={formatNum(tot.invoiced)} tone="rose" />
        <MiniStat label={mncRanged ? 'Closing (supplier owned)' : 'Balance (supplier owned)'} value={formatNum(tot.balance)} tone="violet" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FyPicker from={mncFrom} to={mncTo} onRange={(f, t) => { setMncFrom(f); setMncTo(t) }} className="h-9 w-28 text-xs" />
          <span className="text-[11px] font-semibold text-muted-foreground">From</span>
          <div className="w-40"><DatePicker value={mncFrom} onChange={(v) => setMncFrom(v || '')} /></div>
          <span className="text-[11px] font-semibold text-muted-foreground">To</span>
          <div className="w-40"><DatePicker value={mncTo} onChange={(v) => setMncTo(v || '')} /></div>
          {mncRanged && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setMncFrom(''); setMncTo('') }}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openOpeningStock()}>
          <Plus className="h-4 w-4" /> Add opening stock
        </Button>
        <ExcelButton
          filename={mncRanged ? `mnc-consignment-stock-${mncFrom || 'start'}-to-${mncTo || todayISO()}` : `mnc-consignment-stock-${todayISO()}`}
          sheetName="MNC stock"
          title={`MNC / consignment stock${mncRanged ? ` (${mncFrom || 'start'} → ${mncTo || 'today'})` : ''}`}
          columns={[
            { header: 'Party', key: 'supplier_name', value: (r) => r.supplier_name || '' },
            { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
            { header: 'Opening', key: 'opening', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.opening) || 0 },
            { header: 'Deposited', key: 'deposited', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.deposited) || 0 },
            { header: 'Invoiced', key: 'invoiced', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.invoiced) || 0 },
            { header: mncRanged ? 'Closing' : 'Balance', key: 'balance', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.balance) || 0 },
            { header: 'UOM', key: 'uom', value: (r) => r.uom || 'MT' },
            { header: 'Date', key: 'deposit_date', value: (r) => (r.deposit_date ? formatDate(r.deposit_date) : '') },
            { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
            { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
            { header: 'Weighed', key: 'weighed_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.weighed_qty) || 0 },
            { header: 'Short %', key: 'shortage_pct', value: (r) => (Number(r.shortage_pct) > 0 ? `${r.shortage_pct}%` : '') },
            { header: 'Status', key: 'status', value: (r) => r.status || '' },
            { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' }
          ]}
          rows={mncSheetRows}
          isGroup={(r) => !!r.is_group}
          outlineDetail
        />
        </div>
      </div>
      <div className="rounded-xl border bg-card shadow-sm">
        <Table
          wrapperClassName="max-h-[calc(100vh-330px)] rounded-xl"
          className="min-w-[720px] text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900">Party / product</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-700">Opening</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Deposited</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-rose-700">Invoiced</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-right text-[10px] font-semibold uppercase tracking-wide text-violet-900">{mncRanged ? 'Closing' : 'Balance'}</TableHead>
              <TableHead className="sticky top-0 z-20 bg-violet-100 text-[10px] font-semibold uppercase tracking-wide text-violet-900">UOM</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No consignment stock. Log a deposit under Consignment.</TableCell></TableRow>
            ) : (
              <>
                {byParty.map((g) => (
                  <Fragment key={g.name}>
                    <TableRow className="border-y-2 border-violet-300 bg-violet-50 hover:bg-violet-50">
                      <TableCell className="text-[11px] font-bold uppercase tracking-wide text-violet-900">
                        {g.name}
                        <span className="ml-1 font-medium normal-case tracking-normal text-violet-500">· {g.rows.length} product{g.rows.length === 1 ? '' : 's'}</span>
                      </TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-slate-700">{g.opening ? formatNum(g.opening) : '—'}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.deposited)}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.invoiced)}</TableCell>
                      <TableCell className="text-right text-[11px] font-bold tabular-nums text-violet-900">{formatNum(g.balance)}</TableCell>
                      <TableCell />
                    </TableRow>
                    {g.rows.map((r) => {
                      const k = key(r)
                      const isOpen = open.has(k)
                      const myLots = lots.filter((l) => String(l.supplier_id) === String(r.supplier_id) && String(l.product_id) === String(r.product_id))
                      return (
                        <Fragment key={k}>
                          <TableRow className={cn('cursor-pointer border-b', isOpen && 'bg-slate-100')} onClick={() => toggle(k)}>
                            <TableCell className="font-medium">
                              <span className="inline-flex items-center gap-1.5">
                                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                                {r.product_code || r.product_name}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-slate-600">
                              {(() => {
                                const o = openingFor(r)
                                return o ? formatNum(o) : '—'
                              })()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-emerald-700">{formatNum(r.deposited)}</TableCell>
                            <TableCell className="text-right tabular-nums text-rose-700">{Number(r.invoiced) ? formatNum(r.invoiced) : '—'}</TableCell>
                            <TableCell className={cn('text-right font-bold tabular-nums', Number(r.balance) < -1e-9 ? 'text-red-600' : 'text-violet-900')}>{formatNum(r.balance)}</TableCell>
                            <TableCell className="text-muted-foreground">
                              <span className="flex items-center justify-between gap-2">
                                {r.uom || 'MT'}
                                {openingLotFor(r.supplier_id, r.product_id) && (
                                  <button
                                    type="button"
                                    title="Modify the opening stock (validated against what is already drawn)"
                                    className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-slate-200 hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openOpeningStock(r.supplier_id, r.product_id)
                                    }}
                                  >
                                    <SlidersHorizontal className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </span>
                            </TableCell>
                          </TableRow>
                          {isOpen && (
                            <TableRow className="bg-slate-100 hover:bg-slate-100">
                              <TableCell colSpan={6} className="p-0">
                                <div className="px-6 py-3">
                                  {myLots.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">No deposit lots recorded.</p>
                                  ) : (
                                    <table className="overflow-hidden rounded-lg border border-slate-300 bg-card text-xs shadow-sm [&_td]:pl-3 [&_th]:pl-3">
                                      <thead>
                                        <tr className="border-b bg-slate-200/70 text-left text-slate-700">
                                          <th className="w-8 py-1.5 pr-3 font-semibold">#</th>
                                          <th className="py-1.5 pr-3 font-semibold">Deposit date</th>
                                          <th className="py-1.5 pr-3 font-semibold">Tanker</th>
                                          <th className="py-1.5 pr-3 font-semibold">Gate no</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Weighed</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Short %</th>
                                          <th className="py-1.5 pr-3 text-right font-semibold">Qty (net)</th>
                                          <th className="py-1.5 pr-3 font-semibold">Status</th>
                                          <th className="py-1.5 pr-3 font-semibold">Note</th>
                                          <th className="w-10 py-1.5 pr-3" />
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {myLots.map((l, li) => (
                                          <tr key={l.id as number} className={cn('border-b', li % 2 === 1 ? 'bg-muted/40' : 'bg-card')}>
                                            <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{li + 1}</td>
                                            <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(l.deposit_date)}</td>
                                            <td className="py-1.5 pr-3 font-medium">
                                              {l.tanker_no ||
                                                (Number(l.is_opening) === 1 ? (
                                                  <span className="text-violet-700">Opening</span>
                                                ) : (
                                                  <span className="text-muted-foreground">—</span>
                                                ))}
                                            </td>
                                            <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{l.gate_entry_no || '—'}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{Number(l.weighed_qty) > 0 ? formatNum(l.weighed_qty) : '—'}</td>
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{Number(l.shortage_pct) > 0 ? `${l.shortage_pct}%` : '—'}</td>
                                            <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-emerald-700">{formatNum(l.qty)} {l.uom}</td>
                                            <td className="py-1.5 pr-3">
                                              {Number(l.qty) > 0 ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                  <span className="font-medium text-emerald-700">Completed</span>
                                                  {l.order_id != null && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                      {String(l.invoice_no || 'booked')}
                                                    </span>
                                                  )}
                                                </span>
                                              ) : (
                                                <span className="font-medium text-amber-700">Pending</span>
                                              )}
                                            </td>
                                            <td className="py-1.5 pr-3 text-muted-foreground">{l.note || '—'}</td>
                                            <td className="py-1 pr-2 text-right">
                                              {Number(l.is_opening) === 1 && l.order_id == null && (
                                                <button
                                                  type="button"
                                                  title="Delete this opening lot (kept in history — restorable)"
                                                  className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                                                  onClick={async (e) => {
                                                    e.stopPropagation()
                                                    if (!confirm(`Delete the opening lot of ${formatNum(l.qty)} ${l.uom || 'MT'}? Its figure stays in the restatement history.`)) return
                                                    try {
                                                      await window.api.consignment.remove(Number(l.id))
                                                      toast.success('Opening lot deleted — restorable from the opening dialog history')
                                                      await load()
                                                    } catch (err) {
                                                      toast.error((err as Error).message)
                                                    }
                                                  }}
                                                >
                                                  <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                ))}
                <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                  <TableCell className="text-[11px] font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(totOpening)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.deposited)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.invoiced)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tot.balance)}</TableCell>
                  <TableCell />
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Consigned stock belongs to the supplier until you invoice it, so it is kept out of your own stock figures above. Deposited − Invoiced = Balance still owned by the party. Booking a consignment purchase against a bargain moves that quantity into your books and reduces this balance automatically. Expand a product to see its deposit lots. Use <span className="font-medium">Add opening stock</span> for what a party already held with you before the books started.
      </p>

      {/* Opening stock for an MNC party — no gate entry, entered by hand */}
      <Dialog open={openingOpen} onOpenChange={(o) => !o && setOpeningOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{existingOpening ? 'Update opening stock' : 'Add opening stock'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>MNC / party *</Label>
                <Select
                  value={String(opening.supplier_id || '')}
                  onValueChange={(v) => setOpening((p) => ({ ...p, supplier_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the party" /></SelectTrigger>
                  <SelectContent>
                    {suppliers.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.name}
                        {x.skip_tanker_stages ? ' · direct' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Product *</Label>
                <Select
                  value={String(opening.product_id || '')}
                  onValueChange={(v) => setOpening((p) => ({ ...p, product_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the product" /></SelectTrigger>
                  <SelectContent>
                    {products.map((x) => (
                      <SelectItem key={x.id} value={String(x.id)}>
                        {x.code || x.name}
                        {x.category ? ` · ${x.category}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {opening.supplier_id && opening.product_id && (
                <div className="sm:col-span-2">
                  <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2.5 sm:grid-cols-4">
                    {[
                      { l: 'Current opening', v: existingOpening ? `${formatNum(existingOpeningTotal)} ${existingOpening.uom}` : '—', tone: 'text-violet-900' },
                      { l: 'Deposited (all lots)', v: dlgBand ? formatNum(dlgBand.deposited) : '—', tone: 'text-emerald-700' },
                      { l: 'Already drawn', v: dlgBand ? formatNum(dlgDrawn) : '—', tone: 'text-rose-700' },
                      { l: 'Minimum allowed', v: `${formatNum(dlgMin)} ${opening.uom || 'MT'}`, tone: 'text-amber-700' }
                    ].map((x) => (
                      <div key={x.l}>
                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{x.l}</div>
                        <div className={cn('text-[13px] font-semibold tabular-nums', x.tone)}>{x.v}</div>
                      </div>
                    ))}
                  </div>
                  {existingOpenings.length > 1 && (
                    <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                      {existingOpenings.length} opening entries exist — saving merges them into one figure.
                    </p>
                  )}
                  {!existingOpening && openingLog.length > 0 && (
                    <p className="mt-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                      The opening here was removed — its last figure was{' '}
                      <b>
                        {formatNum(openingLog[0].old_qty ?? openingLog[0].new_qty)} {openingLog[0].uom || 'MT'}
                      </b>
                      . Use Restore below to bring it back.
                    </p>
                  )}
                </div>
              )}
              <div className="grid gap-1.5">
                <Label>Opening quantity *</Label>
                <Input
                  type="number"
                  value={opening.qty ?? ''}
                  placeholder="0.000"
                  onChange={(e) => setOpening((p) => ({ ...p, qty: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>UOM</Label>
                <Select value={String(opening.uom || 'MT')} onValueChange={(v) => setOpening((p) => ({ ...p, uom: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MT">MT</SelectItem>
                    <SelectItem value="KG">KG</SelectItem>
                    <SelectItem value="L">L</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>As on date</Label>
                <DatePicker
                  value={String(opening.deposit_date || '')}
                  onChange={(v) => setOpening((p) => ({ ...p, deposit_date: v }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Note</Label>
                <Input
                  value={opening.note ?? ''}
                  placeholder="Opening stock"
                  onChange={(e) => setOpening((p) => ({ ...p, note: e.target.value }))}
                />
              </div>
            </div>
            {opening.supplier_id && opening.product_id && openingLog.length > 0 && (
              <div className="rounded-lg border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Restatement history — every change is kept
                </div>
                <div className="max-h-36 overflow-auto">
                  {openingLog.map((h) => (
                    <div key={String(h.id)} className="flex items-center gap-2 border-b border-dotted px-3 py-1.5 text-[12px] last:border-0">
                      <span className="w-32 shrink-0 tabular-nums text-muted-foreground">
                        {formatDate(String(h.changed_at).slice(0, 10))}
                      </span>
                      <span
                        className={cn(
                          'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase',
                          h.action === 'delete' ? 'bg-red-100 text-red-700' : h.action === 'create' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'
                        )}
                      >
                        {h.action === 'delete' ? 'Removed' : h.action === 'create' ? 'Created' : 'Restated'}
                      </span>
                      <span className="min-w-0 flex-1 truncate tabular-nums">
                        {h.old_qty != null ? `${formatNum(h.old_qty)} → ` : ''}
                        {h.new_qty != null ? `${formatNum(h.new_qty)} ${h.uom || 'MT'}` : 'removed'}
                      </span>
                      {(h.old_qty != null || h.new_qty != null) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-1.5 text-[11px] text-indigo-700"
                          title="Fill this figure into the form — Save applies it with full validation"
                          onClick={() =>
                            setOpening((prev) => ({
                              ...prev,
                              qty: String(h.action === 'delete' || h.new_qty == null ? h.old_qty : h.old_qty ?? h.new_qty),
                              uom: String(h.uom || prev.uom || 'MT'),
                              deposit_date: String(h.deposit_date || prev.deposit_date || todayISO()).slice(0, 10)
                            }))
                          }
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {openingError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {openingError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpeningOpen(false)} disabled={savingOpening}>Cancel</Button>
            <Button onClick={saveOpeningStock} disabled={savingOpening}>
              {savingOpening ? 'Saving…' : existingOpening ? 'Update opening stock' : 'Add opening stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Move stock from the active (current) company to another company.
function Transfers(): React.JSX.Element {
  const [stock, setStock] = useState<Row[]>([])
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeId, setActiveId] = useState<number>(0)
  const [transfers, setTransfers] = useState<Row[]>([])
  const [form, setForm] = useState<Row>({ product_id: '', to_company_id: '', qty: '', transfer_date: todayISO(), note: '' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [s, cs, active, t] = await Promise.all([
      window.api.stock.list(),
      window.api.company.list(),
      window.api.company.getActive(),
      window.api.stock.transfers()
    ])
    setStock(s)
    setCompanies(cs)
    setActiveId(Number(active.id))
    setTransfers(t)
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  const activeName = companies.find((c) => Number(c.id) === activeId)?.name || 'this company'
  const targets = companies.filter((c) => c.active && Number(c.id) !== activeId)
  const chosen = stock.find((s) => String(s.id) === String(form.product_id))
  const available = chosen ? Number(chosen.stock) || 0 : 0

  async function submit(): Promise<void> {
    if (!form.product_id) return setError('Select a product')
    if (!form.to_company_id) return setError('Select the destination company')
    const qty = Number(form.qty) || 0
    if (qty <= 0) return setError('Enter a quantity greater than zero')
    if (qty > available + 1e-6) return setError(`Only ${formatNum(available)} in stock to transfer`)
    setSaving(true)
    setError(null)
    try {
      await window.api.stock.transfer({
        product_id: Number(form.product_id),
        to_company_id: Number(form.to_company_id),
        qty,
        transfer_date: form.transfer_date,
        note: form.note || null
      })
      toast.success('Stock transferred')
      setForm({ product_id: '', to_company_id: '', qty: '', transfer_date: todayISO(), note: '' })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: Row): Promise<void> {
    if (!window.confirm('Reverse this transfer? The stock returns to the source company.')) return
    try {
      await window.api.stock.deleteTransfer(row.id as number)
      toast.success('Transfer reversed')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-1 font-medium">Transfer stock to another company</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          Moves stock out of <b>{activeName}</b> and into the destination company. This is a physical stock move only — it does not create a sale or any ledger entry.
        </p>
        <div className="grid gap-4 md:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>Product *</Label>
            <Select value={String(form.product_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}>
              <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
              <SelectContent>
                {stock.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>{s.name} · {formatNum(s.stock)} in stock</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>To company *</Label>
            <Select value={String(form.to_company_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, to_company_id: v }))}>
              <SelectTrigger><SelectValue placeholder="Select company" /></SelectTrigger>
              <SelectContent>
                {targets.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Quantity * {chosen ? `(max ${formatNum(available)})` : ''}</Label>
            <Input type="number" value={form.qty} onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label>Date</Label>
            <DatePicker value={form.transfer_date || ''} onChange={(v) => setForm((p) => ({ ...p, transfer_date: v }))} />
          </div>
          <div className="grid gap-1.5 md:col-span-3">
            <Label>Note</Label>
            <Input value={form.note ?? ''} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
          </div>
          <div className="flex items-end">
            <Button className="w-full" onClick={submit} disabled={saving}>
              <ArrowRightLeft className="h-4 w-4" /> {saving ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>From → To</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfers.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No transfers yet.</TableCell></TableRow>
            ) : (
              transfers.map((t) => (
                <TableRow key={t.id as number}>
                  <TableCell>{formatDate(t.transfer_date)}</TableCell>
                  <TableCell>
                    <Badge variant={t.direction === 'out' ? 'secondary' : 'default'}>
                      {t.direction === 'out' ? 'Out' : 'In'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{t.product_code || t.product_name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.from_company_name} → {t.to_company_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(t.qty)} {t.uom}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-muted-foreground">{t.note || '—'}</TableCell>
                  <TableCell className="text-right">
                    {t.direction === 'out' && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => remove(t)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
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

export function Stock(): React.JSX.Element {
  const [stockGroup, setStockGroup] = useState<'book' | 'actual'>('book')
  const [tab, setTab] = useState('raw')
  const [rows, setRows] = useState<Row[]>([])
  const [breakdown, setBreakdown] = useState<Record<number, { receipt: Row[]; dispatch: Row[] }>>({})
  const [range, setRange] = useState({ from: '', to: '' })
  const ranged = !!(range.from || range.to)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRangeStock = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeStock.version > 0) setRange({ from: globalRangeStock.from, to: globalRangeStock.to })
  }, [globalRangeStock.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCid, setActiveCid] = useState(0)
  const [cids, setCids] = useState<number[]>([])
  // Per-company rows under each product when more than one company is in view,
  // so the register (and its Excel) says whose stock is whose.
  const [companySplit, setCompanySplit] = useState<Record<number, Row[]>>({})

  const load = useCallback(async () => {
    const sel = cids.length ? cids : undefined
    const [s, b, cs, active] = await Promise.all([
      window.api.stock.list(range.from || range.to ? range : undefined, sel),
      window.api.stock.breakdown(sel, range.from || range.to ? range : undefined),
      window.api.company.list(),
      window.api.company.getActive()
    ])
    setRows(s)
    setBreakdown(b)
    setCompanies(cs)
    setActiveCid(Number(active.id))
    // The split needs one levels call per selected company (2-3 at most).
    if (sel && sel.length > 1) {
      const per = await Promise.all(
        sel.map((id) => window.api.stock.list(range.from || range.to ? range : undefined, [id]))
      )
      const split: Record<number, Row[]> = {}
      per.forEach((list, i) => {
        const cname = String(cs.find((x) => Number(x.id) === sel[i])?.name || `Company ${sel[i]}`)
        for (const r of list) {
          const moved =
            Math.abs(Number(r.opening) || 0) + (Number(r.received) || 0) + (Number(r.produced) || 0) +
            (Number(r.transferred_in) || 0) + (Number(r.transferred_out) || 0) + (Number(r.consumed) || 0) +
            (Number(r.sold) || 0) + Math.abs(Number(r.stock) || 0)
          if (moved < 1e-9) continue
          ;(split[Number(r.id)] ??= []).push({ ...r, company: cname })
        }
      })
      setCompanySplit(split)
    } else {
      setCompanySplit({})
    }
  }, [range, cids])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const byCat = useMemo(() => (cat: string): Row[] => rows.filter((r) => r.category === cat), [rows])
  const companyPicker = (
    <CompanyPicker companies={companies} value={cids} onChange={setCids} activeId={activeCid} />
  )

  return (
    <>
      <PageHeader title="Stock" subtitle="Live balance per product, and daily book-vs-actual reconciliation" hint="Book balances update automatically (purchases add raw oil, production consumes inputs and adds outputs, sales reduce finished goods). Use Day close to enter the actual physical count each day and see the difference." />
      <div className="p-5">
        {/* Two families: what the books say, and what was physically counted or
            is held for someone else. Switching family lands on its first tab. */}
        <div className="mb-3 inline-flex rounded-lg border p-0.5">
          {([
            { key: 'book', label: 'Book Stock', first: 'raw' },
            { key: 'actual', label: 'Actual Stock', first: 'sku' }
          ] as const).map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => { setStockGroup(g.key); setTab(g.first) }}
              className={cn(
                'rounded-md px-4 py-1.5 text-[13px] font-semibold transition-colors',
                stockGroup === g.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {stockGroup === 'book' ? (
              <>
                <TabsTrigger value="raw">Raw ({byCat('raw').length})</TabsTrigger>
                <TabsTrigger value="intermediate">Intermediate ({byCat('intermediate').length})</TabsTrigger>
                <TabsTrigger value="finished">Finished ({byCat('finished').length})</TabsTrigger>
              </>
            ) : (
              <>
                <TabsTrigger value="sku">Packed SKU</TabsTrigger>
                <TabsTrigger value="mnc">MNC / Consignment</TabsTrigger>
                <TabsTrigger value="transfers">Transfers</TabsTrigger>
                <TabsTrigger value="dayclose">Day close (actual vs book)</TabsTrigger>
              </>
            )}
          </TabsList>
          <TabsContent value="raw" className="mt-6">
            <StockTable rows={byCat('raw')} breakdown={breakdown} label="raw" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} />
          </TabsContent>
          <TabsContent value="intermediate" className="mt-6">
            <StockTable rows={byCat('intermediate')} breakdown={breakdown} label="intermediate" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} />
          </TabsContent>
          <TabsContent value="finished" className="mt-6">
            <StockTable rows={byCat('finished')} breakdown={breakdown} label="finished" range={range} onRange={setRange} companyPicker={companyPicker} companySplit={companySplit} />
          </TabsContent>
          <TabsContent value="sku" className="mt-6">
            <SkuStock />
          </TabsContent>
          <TabsContent value="mnc" className="mt-4">
            <MncStock />
          </TabsContent>
          <TabsContent value="transfers" className="mt-6">
            <Transfers />
          </TabsContent>
          <TabsContent value="dayclose" className="mt-6">
            <DayClose />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
