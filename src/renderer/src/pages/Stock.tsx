import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, Download, Trash2, Upload } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { downloadDayCloseExcel, parseDayCloseExcel } from '@/lib/dayCloseExcel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// A number cell that reveals a party-wise breakdown on hover.
function PartyCell({ value, parties, uom }: { value: number; parties: Row[]; uom?: string }): React.JSX.Element {
  const cell = <span className="tabular-nums">{formatNum(value)}</span>
  if (!parties || parties.length === 0) {
    return <TableCell className="text-right tabular-nums text-muted-foreground">{value ? cell : '—'}</TableCell>
  }
  return (
    <TableCell className="text-right tabular-nums text-muted-foreground">
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

function StockTable({ rows, breakdown }: { rows: Row[]; breakdown: Record<number, { receipt: Row[]; dispatch: Row[] }> }): React.JSX.Element {
  const sum = (k: string): number => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)
  const totals = {
    received: sum('received'),
    produced: sum('produced'),
    transferred_in: sum('transferred_in'),
    transferred_out: sum('transferred_out'),
    consumed: sum('consumed'),
    sold: sum('sold'),
    stock: sum('stock')
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Receipt</TableHead>
            <TableHead className="text-right">Produced</TableHead>
            <TableHead className="text-right">Transfer in</TableHead>
            <TableHead className="text-right">Transfer out</TableHead>
            <TableHead className="text-right">Consumed</TableHead>
            <TableHead className="text-right">Dispatch</TableHead>
            <TableHead className="text-right">In stock</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                Nothing here yet.
              </TableCell>
            </TableRow>
          ) : (
            <>
              {rows.map((r) => (
                <TableRow key={r.id as number}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <PartyCell value={Number(r.received)} parties={breakdown[r.id as number]?.receipt || []} />
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.produced)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{Number(r.transferred_in) > 0 ? formatNum(r.transferred_in) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{Number(r.transferred_out) > 0 ? formatNum(r.transferred_out) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.consumed)}</TableCell>
                  <PartyCell value={Number(r.sold)} parties={breakdown[r.id as number]?.dispatch || []} />
                  <TableCell
                    className={cn(
                      'text-right font-semibold tabular-nums',
                      Number(r.stock) < -1e-9 ? 'text-red-600' : ''
                    )}
                  >
                    {formatNum(r.stock)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                <TableCell className="font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
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
  )
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone)}>{value}</div>
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
              setRows={setRows}
              rateOf={rateOf}
              actualValueOf={actualValueOf}
              diffOf={diffOf}
            />
          </TabsContent>
        ))}
      </Tabs>

      <p className="text-xs text-muted-foreground">
        Book qty is the system-computed stock (received + produced − consumed − sold). Difference = book − actual; a positive value means physical stock is short of the books. Actual value is valued automatically at the weighted-average cost (rate × actual qty). Download a protected Excel per section — only the Actual qty and Note cells are editable — hand it to the person counting, then upload it back.
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
  setRows,
  rateOf,
  actualValueOf,
  diffOf
}: {
  section: { key: string; title: string; cats: string[] }
  date: string
  loading: boolean
  rows: Row[]
  setField: (pid: number, key: string, value: unknown) => void
  setRows: React.Dispatch<React.SetStateAction<Row[]>>
  rateOf: (r: Row) => number
  actualValueOf: (r: Row) => number
  diffOf: (r: Row) => number
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)

  const counted = rows.filter((r) => r.actual_qty !== null && r.actual_qty !== '')
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
      const allowed = new Set(rows.map((r) => Number(r.product_id)))
      let applied = 0
      setRows((all) =>
        all.map((r) => {
          if (!allowed.has(Number(r.product_id))) return r
          const p = byId.get(String(r.product_id)) || byName.get(String(r.name).toLowerCase())
          if (!p) return r
          applied++
          return {
            ...r,
            actual_qty: p.actual_qty != null && p.actual_qty !== '' ? p.actual_qty : r.actual_qty,
            note: p.note != null && p.note !== '' ? p.note : r.note
          }
        })
      )
      toast.success(`Imported ${applied} ${applied === 1 ? 'row' : 'rows'} — review and Save day close`)
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
            <TooltipContent>Upload the filled {section.title} sheet to fill the counts below</TooltipContent>
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
              <TableHead className="text-right">Difference</TableHead>
              <TableHead className="text-right">Rate (₹)</TableHead>
              <TableHead className="text-right">Actual value (₹)</TableHead>
              <TableHead className="w-[180px]">Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No products in this section.</TableCell></TableRow>
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
          </TableBody>
        </Table>
      </div>
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
  const [rows, setRows] = useState<Row[]>([])
  const [breakdown, setBreakdown] = useState<Record<number, { receipt: Row[]; dispatch: Row[] }>>({})

  const load = useCallback(async () => {
    const [s, b] = await Promise.all([window.api.stock.list(), window.api.stock.breakdown()])
    setRows(s)
    setBreakdown(b)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const byCat = useMemo(() => (cat: string): Row[] => rows.filter((r) => r.category === cat), [rows])

  return (
    <>
      <PageHeader title="Stock" subtitle="Live balance per product, and daily book-vs-actual reconciliation" hint="Book balances update automatically (purchases add raw oil, production consumes inputs and adds outputs, sales reduce finished goods). Use Day close to enter the actual physical count each day and see the difference." />
      <div className="p-5">
        <Tabs defaultValue="raw">
          <TabsList>
            <TabsTrigger value="raw">Raw ({byCat('raw').length})</TabsTrigger>
            <TabsTrigger value="intermediate">Intermediate ({byCat('intermediate').length})</TabsTrigger>
            <TabsTrigger value="finished">Finished ({byCat('finished').length})</TabsTrigger>
            <TabsTrigger value="transfers">Transfers</TabsTrigger>
            <TabsTrigger value="dayclose">Day close (actual vs book)</TabsTrigger>
          </TabsList>
          <TabsContent value="raw" className="mt-6">
            <StockTable rows={byCat('raw')} breakdown={breakdown} />
          </TabsContent>
          <TabsContent value="intermediate" className="mt-6">
            <StockTable rows={byCat('intermediate')} breakdown={breakdown} />
          </TabsContent>
          <TabsContent value="finished" className="mt-6">
            <StockTable rows={byCat('finished')} breakdown={breakdown} />
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
