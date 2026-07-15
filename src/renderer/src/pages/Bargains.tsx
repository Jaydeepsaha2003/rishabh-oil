import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
import { UomSelect } from '@/components/UomSelect'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

type SortState = { key: string; dir: 'asc' | 'desc' } | null

// Per-column sort accessors. Anything not listed here isn't sortable.
const SORT_ACCESSORS: Record<string, (r: Row) => string | number> = {
  bargain_no: (r) => String(r.bargain_no || ''),
  bargain_date: (r) => String(r.bargain_date || ''),
  supplier: (r) => String(r.supplier_name || ''),
  oil: (r) => String(r.oil_code || r.oil_name || ''),
  condition: (r) => String(r.bargain_type || ''),
  qty: (r) => Number(r.qty) || 0,
  rate: (r) => Number(r.rate_per_uom) || 0,
  balance: (r) => Number(r.balance_qty) || 0,
  total: (r) => Number(r.total_amount) || 0
}

const oilOf = (r: Row): string => String(r.oil_code || r.oil_name || '—')

// Default order: grouped by oil (A→Z), oldest first inside each group.
function defaultCompare(a: Row, b: Row): number {
  const byOil = oilOf(a).localeCompare(oilOf(b))
  if (byOil !== 0) return byOil
  const byDate = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
  if (byDate !== 0) return byDate
  return (Number(a.id) || 0) - (Number(b.id) || 0)
}

function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename: string, lines: string[]): void {
  // BOM so Excel opens it with the right encoding (₹, Unicode names)
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function emptyForm(uom: string): Row {
  return {
    bargain_date: todayISO(),
    supplier_id: '',
    broker_id: '',
    oil_type_id: '',
    bargain_type: 'EX',
    qty: '',
    uom,
    base_rate: '',
    duty: '',
    rate_expiry_date: ''
  }
}

export function Bargains(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [brokers, setBrokers] = useState<Row[]>([])
  const [oilTypes, setOilTypes] = useState<Row[]>([])
  const [defaultUom, setDefaultUom] = useState('MT')
  const [typeFilter, setTypeFilter] = useState('OIL')

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyForm('MT'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [b, s, o, br, settings] = await Promise.all([
      window.api.bargains.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.data.list('brokers'),
      window.api.settings.all()
    ])
    setRows(b)
    setSuppliers(s.filter((x) => x.active))
    setBrokers(br.filter((x) => x.active))
    setOilTypes(
      o
        .filter((x) => x.active && x.category === 'raw')
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    )
    setDefaultUom(settings.default_uom ?? 'MT')
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  function openAdd(): void {
    setEditing(null)
    setForm(emptyForm(defaultUom))
    setError(null)
    setOpen(true)
  }

  function openEdit(row: Row): void {
    setEditing(row)
    setForm({
      bargain_date: row.bargain_date ?? todayISO(),
      supplier_id: String(row.supplier_id ?? ''),
      broker_id: row.broker_id ? String(row.broker_id) : '',
      oil_type_id: String(row.oil_type_id ?? ''),
      bargain_type: row.bargain_type ?? 'EX',
      qty: row.qty ?? '',
      uom: row.uom ?? defaultUom,
      base_rate: row.base_rate ?? '',
      duty: row.duty ?? '',
      rate_expiry_date: row.rate_expiry_date ?? ''
    })
    setError(null)
    setOpen(true)
  }

  function setField(key: string, value: unknown): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const bgRate = (Number(form.base_rate) || 0) + (Number(form.duty) || 0)
  const total = (Number(form.qty) || 0) * bgRate

  async function save(): Promise<void> {
    if (!form.supplier_id) return setError('Supplier is required')
    if (!form.oil_type_id) return setError('Oil type is required')
    if (!form.qty || Number(form.qty) <= 0) return setError('Quantity must be greater than 0')
    if (bgRate <= 0) return setError('Base rate must be greater than 0')

    setSaving(true)
    setError(null)
    try {
      const payload: Row = {
        bargain_date: form.bargain_date,
        supplier_id: Number(form.supplier_id),
        broker_id: form.broker_id ? Number(form.broker_id) : null,
        oil_type_id: Number(form.oil_type_id),
        bargain_type: form.bargain_type,
        qty: Number(form.qty),
        uom: form.uom || defaultUom,
        base_rate: Number(form.base_rate) || 0,
        duty: Number(form.duty) || 0,
        rate_expiry_date: form.rate_expiry_date || null
      }
      if (editing) {
        await window.api.bargains.update(editing.id as number, payload)
        toast.success('Bargain updated')
      } else {
        const res = await window.api.bargains.create(payload)
        toast.success(`Bargain ${res.bargain_no} created`)
      }
      setOpen(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete bargain ${row.bargain_no}? This cannot be undone.`)) return
    try {
      await window.api.bargains.remove(row.id as number)
      toast.success('Bargain deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const noMasters = suppliers.length === 0 || oilTypes.length === 0
  const TYPE_FILTERS = ['OIL', 'HUSK', 'PACKAGING', 'CHEMICAL', 'ALL']
  const visibleRows =
    typeFilter === 'ALL'
      ? rows
      : rows.filter((r) => String(r.supplier_type || '').toUpperCase() === typeFilter)

  const [sort, setSort] = useState<SortState>(null)
  const [reportOpen, setReportOpen] = useState(false)

  function toggleSort(key: string): void {
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
  }

  const sortedRows = useMemo(() => {
    const list = [...visibleRows]
    if (!sort) {
      list.sort(defaultCompare)
    } else {
      const acc = SORT_ACCESSORS[sort.key]
      list.sort((a, b) => {
        const va = acc(a)
        const vb = acc(b)
        const c = typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb))
        return sort.dir === 'asc' ? c : -c
      })
    }
    return list
  }, [visibleRows, sort])

  // Oil-group separators only make sense while rows are grouped by oil.
  const groupedByOil = !sort || sort.key === 'oil'

  // Collapsed oil groups (band click toggles).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  function toggleGroup(oil: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(oil)) next.delete(oil)
      else next.add(oil)
      return next
    })
  }

  // Per-oil totals shown on the group band, aligned to the table columns.
  const groupStats = useMemo(() => {
    const m = new Map<string, { count: number; qty: number; bal: number; balValue: number; uom: string }>()
    for (const r of visibleRows) {
      const k = oilOf(r)
      if (!m.has(k)) m.set(k, { count: 0, qty: 0, bal: 0, balValue: 0, uom: String(r.uom || 'MT') })
      const g = m.get(k)!
      g.count += 1
      g.qty += Number(r.qty) || 0
      g.bal += Number(r.balance_qty) || 0
      g.balValue += (Number(r.balance_qty) || 0) * (Number(r.rate_per_uom) || 0)
    }
    return m
  }, [visibleRows])

  // Report: one summary line per oil type — open bargains (balance left), total
  // qty/balance, weighted average rate and total value. Not bargain-wise.
  const report = useMemo(() => {
    type Agg = {
      label: string
      count: number
      openCount: number
      qty: number
      balance: number
      total: number
      openValue: number
    }
    const groups = new Map<string, Agg>()
    for (const r of rows) {
      const key = oilOf(r)
      if (!groups.has(key))
        groups.set(key, { label: key, count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0 })
      const g = groups.get(key)!
      const qty = Number(r.qty) || 0
      const balance = Number(r.balance_qty) || 0
      const rate = Number(r.rate_per_uom) || 0
      g.count += 1
      g.qty += qty
      g.balance += balance
      g.total += Number(r.total_amount) || 0
      if (balance > 0.005) {
        g.openCount += 1
        g.openValue += balance * rate
      }
    }
    const list = Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label))
    const grand = list.reduce(
      (s, g) => ({
        count: s.count + g.count,
        openCount: s.openCount + g.openCount,
        qty: s.qty + g.qty,
        balance: s.balance + g.balance,
        total: s.total + g.total,
        openValue: s.openValue + g.openValue
      }),
      { count: 0, openCount: 0, qty: 0, balance: 0, total: 0, openValue: 0 }
    )
    return { groups: list, grand }
  }, [rows])

  // Weighted average rate = total value ÷ total qty.
  const avgRate = (g: { total: number; qty: number }): number => (g.qty > 0 ? g.total / g.qty : 0)

  function downloadExcel(): void {
    const headers = ['Bargain No', 'Date', 'Supplier', 'Oil', 'Condition', 'Op Qty', 'UOM', 'BG Rate', 'Bal Qty', 'Total Amount']
    const lines = [headers.join(',')]
    for (const r of sortedRows) {
      lines.push(
        [r.bargain_no, r.bargain_date, r.supplier_name, oilOf(r), r.bargain_type, r.qty, r.uom, r.rate_per_uom, r.balance_qty, r.total_amount]
          .map(csvCell)
          .join(',')
      )
    }
    downloadCsv(`bargains-${typeFilter.toLowerCase()}-${todayISO()}.csv`, lines)
  }

  function downloadReportExcel(): void {
    const lines = ['Oil,Open Bargains,Total Bargains,Open Qty,Total Qty,Avg Rate,Open Value,Total Value']
    for (const g of report.groups) {
      lines.push(
        [g.label, g.openCount, g.count, g.balance, g.qty, avgRate(g).toFixed(2), g.openValue, g.total]
          .map(csvCell)
          .join(',')
      )
    }
    const t = report.grand
    lines.push(
      ['GRAND TOTAL', t.openCount, t.count, t.balance, t.qty, avgRate(t).toFixed(2), t.openValue, t.total]
        .map(csvCell)
        .join(',')
    )
    downloadCsv(`bargain-report-by-oil-${todayISO()}.csv`, lines)
  }

  return (
    <>
      <PageHeader
        title="Bargains"
        subtitle="Rate contracts — drawn down as purchase tankers are loaded"
        hint="Each bargain locks a rate and quantity with a supplier. The bargain number is OILCODE/DD-MM/PARTYNAME/SERIAL, where the serial restarts every month from 01 (e.g. MAHUWA/01-07/ROHINIOIL/03). Landed rate = base rate + customs duty. Click any column header to sort; the Report button groups the full history by oil."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setReportOpen((v) => !v)}>
              <BarChart3 className="h-4 w-4" />
              {reportOpen ? 'Back to list' : 'Report'}
            </Button>
            <Button variant="outline" size="sm" onClick={downloadExcel}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button size="sm" onClick={openAdd} disabled={noMasters}>
              <Plus className="h-4 w-4" />
              New bargain
            </Button>
          </div>
        }
      />

      <div className="w-full p-4">
        {noMasters && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Add at least one supplier and one oil type in Settings before creating a bargain.
          </div>
        )}

        {reportOpen ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <button
                  className="mb-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setReportOpen(false)}
                >
                  <ArrowLeft className="h-4 w-4" /> Back to list
                </button>
                <h3 className="text-lg font-semibold">Bargain report — by oil</h3>
                <p className="text-xs text-muted-foreground">
                  Open bargains, weighted average rate and value per oil type · {report.grand.count} bargains overall
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadReportExcel}>
                <FileSpreadsheet className="h-4 w-4" /> Download report
              </Button>
            </div>

            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <Table className="text-[13px]">
                <TableHeader className="bg-amber-100/70">
                  <TableRow>
                    <TableHead className="text-amber-900">Oil</TableHead>
                    <TableHead className="text-center text-amber-900">Open bargains</TableHead>
                    <TableHead className="text-center text-amber-900">Total bargains</TableHead>
                    <TableHead className="text-right text-amber-900">Open qty</TableHead>
                    <TableHead className="text-right text-amber-900">Total qty</TableHead>
                    <TableHead className="text-right text-amber-900">Avg rate</TableHead>
                    <TableHead className="text-right text-amber-900">Open value</TableHead>
                    <TableHead className="text-right text-amber-900">Total value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No bargains yet.</TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {report.groups.map((g) => (
                        <TableRow key={g.label}>
                          <TableCell className="font-semibold">{g.label}</TableCell>
                          <TableCell className="text-center tabular-nums">
                            <Badge variant={g.openCount > 0 ? 'warning' : 'muted'}>{g.openCount}</Badge>
                          </TableCell>
                          <TableCell className="text-center tabular-nums">{g.count}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.balance)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(g.qty)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(avgRate(g))}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(g.openValue)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatINR(g.total)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell>Grand total</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.openCount}</TableCell>
                        <TableCell className="text-center tabular-nums">{report.grand.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.balance)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(report.grand.qty)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatINR(avgRate(report.grand))}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatINR(report.grand.openValue)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatINR(report.grand.total)}</TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Open = bargains with balance quantity left. Avg rate is weighted (total value ÷ total qty). Open value = balance qty × bargain rate.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
              {TYPE_FILTERS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    typeFilter === t ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t === 'ALL' ? 'All' : t}
                </button>
              ))}
            </div>

            <div className="rounded-lg border bg-card">
              <Table className="text-[13px]">
                <TableHeader>
                  <TableRow>
                    {(
                      [
                        { id: 'bargain_no', label: 'Bargain no' },
                        { id: 'bargain_date', label: 'Date' },
                        { id: 'supplier', label: 'Supplier' },
                        { id: 'oil', label: 'Oil' },
                        { id: 'condition', label: 'Condition' },
                        { id: 'qty', label: 'Op Qty', right: true },
                        { id: 'rate', label: 'BG rate', right: true },
                        { id: 'balance', label: 'Bal Qty', right: true },
                        { id: 'total', label: 'Total', right: true }
                      ] as { id: string; label: string; right?: boolean }[]
                    ).map((c) => (
                      <TableHead key={c.id} className={c.right ? 'text-right' : ''}>
                        <button
                          onClick={() => toggleSort(c.id)}
                          className={cn(
                            'inline-flex items-center gap-1 transition-colors hover:text-foreground',
                            c.right && 'w-full justify-end'
                          )}
                          title={`Sort by ${c.label}`}
                        >
                          {c.label}
                          {sort?.key === c.id ? (
                            sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-30" />
                          )}
                        </button>
                      </TableHead>
                    ))}
                    <TableHead className="w-[90px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        Loading…
                      </TableCell>
                    </TableRow>
                  ) : sortedRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        {rows.length === 0
                          ? 'No bargains yet. Click “New bargain” to add one.'
                          : `No ${typeFilter === 'ALL' ? '' : typeFilter + ' '}bargains to show.`}
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedRows.map((row, i) => {
                      const oil = oilOf(row)
                      const newGroup =
                        groupedByOil && (i === 0 || oil !== oilOf(sortedRows[i - 1]))
                      const isCollapsed = groupedByOil && collapsed.has(oil)
                      const g = groupStats.get(oil)
                      return (
                        <Fragment key={row.id as number}>
                          {newGroup && (
                            <TableRow
                              className="cursor-pointer border-y-2 border-slate-300 bg-slate-100 hover:bg-slate-200/70"
                              onClick={() => toggleGroup(oil)}
                            >
                              <TableCell colSpan={5} className="py-1.5">
                                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-700">
                                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                  {oil}
                                  <span className="font-medium normal-case tracking-normal text-slate-500">
                                    · {g?.count ?? 0} bargain{(g?.count ?? 0) === 1 ? '' : 's'}
                                  </span>
                                </span>
                              </TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">
                                {formatNum(g?.qty ?? 0)} {g?.uom || 'MT'}
                              </TableCell>
                              <TableCell className="py-1.5" />
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">
                                {formatNum(g?.bal ?? 0)} {g?.uom || 'MT'}
                              </TableCell>
                              <TableCell className="py-1.5 text-right text-xs font-bold tabular-nums text-slate-700">
                                {formatINR(g?.balValue ?? 0)}
                              </TableCell>
                              <TableCell className="py-1.5" />
                            </TableRow>
                          )}
                          {!isCollapsed && (
                          <TableRow>
                          <TableCell className="font-medium">{row.bargain_no}</TableCell>
                          <TableCell>{formatDate(row.bargain_date)}</TableCell>
                          <TableCell>{row.supplier_name ?? '—'}</TableCell>
                          <TableCell>
                            <span className="font-medium">{row.oil_code}</span>
                          </TableCell>
                          <TableCell>
                            <Badge variant={row.bargain_type === 'DLD' || row.bargain_type === 'Delivered' ? 'secondary' : 'muted'}>
                              {row.bargain_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNum(row.qty)} {row.uom}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(row.rate_per_uom)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span className={Number(row.balance_qty) < 0 ? 'text-red-600' : ''}>
                              {formatNum(row.balance_qty)} {row.uom}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatINR(row.total_amount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
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
                          )}
                        </Fragment>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.bargain_no}` : 'New bargain'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 py-1">
            <div className="grid gap-1.5">
              <Label>Bargain date *</Label>
              <DatePicker
                value={form.bargain_date}
                onChange={(v) => setField('bargain_date', v)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Bargain no</Label>
              <Input value={editing ? editing.bargain_no : 'Auto-generated'} disabled />
            </div>

            <div className="grid gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(form.supplier_id)} onValueChange={(v) => setField('supplier_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Oil type *</Label>
              <Select value={String(form.oil_type_id)} onValueChange={(v) => setField('oil_type_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select oil type" />
                </SelectTrigger>
                <SelectContent>
                  {oilTypes.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.code || o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Broker</Label>
              <Select value={String(form.broker_id || '')} onValueChange={(v) => setField('broker_id', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select broker (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {brokers.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Bargain condition</Label>
              <Select value={form.bargain_type} onValueChange={(v) => setField('bargain_type', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EX">EX</SelectItem>
                  <SelectItem value="DLD">DLD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>UOM</Label>
              <UomSelect value={form.uom} onChange={(v) => setField('uom', v)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Bargain qty *</Label>
              <Input type="number" value={form.qty} onChange={(e) => setField('qty', e.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Base rate (ex duty) *</Label>
              <Input
                type="number"
                value={form.base_rate}
                onChange={(e) => setField('base_rate', e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Duty per {form.uom || 'MT'}</Label>
              <Input type="number" value={form.duty} onChange={(e) => setField('duty', e.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Contract expiry</Label>
              <DatePicker
                value={form.rate_expiry_date ?? ''}
                onChange={(v) => setField('rate_expiry_date', v)}
              />
            </div>

            <div className="grid content-end gap-1.5">
              <Label>Bargain rate (base + duty)</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium tabular-nums">
                {formatINR(bgRate)}
              </div>
            </div>
            <div className="grid content-end gap-1.5">
              <Label>Total bargain amount</Label>
              <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm font-semibold tabular-nums">
                {formatINR(total)}
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save bargain'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
