import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
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

function emptyForm(uom: string): Row {
  return {
    bargain_date: todayISO(),
    supplier_id: '',
    oil_type_id: '',
    bargain_type: 'EX',
    qty: '',
    uom,
    base_rate: '',
    duty: '',
    allowed_shortage_pct: '',
    rate_expiry_date: ''
  }
}

export function Bargains(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [oilTypes, setOilTypes] = useState<Row[]>([])
  const [defaultUom, setDefaultUom] = useState('MT')
  const [defaultShortage, setDefaultShortage] = useState('0.2')
  const [typeFilter, setTypeFilter] = useState('OIL')

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>(emptyForm('MT'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [b, s, o, settings] = await Promise.all([
      window.api.bargains.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.settings.all()
    ])
    setRows(b)
    setSuppliers(s.filter((x) => x.active))
    setOilTypes(
      o
        .filter((x) => x.active && x.category === 'raw')
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    )
    setDefaultUom(settings.default_uom ?? 'MT')
    setDefaultShortage(settings.allowed_shortage_pct ?? '0.2')
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
      oil_type_id: String(row.oil_type_id ?? ''),
      bargain_type: row.bargain_type ?? 'EX',
      qty: row.qty ?? '',
      uom: row.uom ?? defaultUom,
      base_rate: row.base_rate ?? '',
      duty: row.duty ?? '',
      allowed_shortage_pct: row.allowed_shortage_pct ?? '',
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
        oil_type_id: Number(form.oil_type_id),
        bargain_type: form.bargain_type,
        qty: Number(form.qty),
        uom: form.uom || defaultUom,
        base_rate: Number(form.base_rate) || 0,
        duty: Number(form.duty) || 0,
        allowed_shortage_pct: form.bargain_type === 'DLD' ? 0 : form.allowed_shortage_pct,
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

  return (
    <>
      <PageHeader
        title="Bargains"
        subtitle="Rate contracts — drawn down as purchase tankers are loaded"
        hint="Each bargain locks a rate and quantity with a supplier. The bargain number is generated as OILCODE/DD-MM/PARTYNAME/SERIAL (e.g. RPO/29-06/DILEXIM/0002). Landed rate = base rate + customs duty."
        actions={
          <Button size="sm" onClick={openAdd} disabled={noMasters}>
            <Plus className="h-4 w-4" />
            New bargain
          </Button>
        }
      />

      <div className="p-8">
        {noMasters && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Add at least one supplier and one oil type in Settings before creating a bargain.
          </div>
        )}

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bargain no</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Oil</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">BG rate</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Total</TableHead>
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
              ) : visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                    {rows.length === 0
                      ? 'No bargains yet. Click “New bargain” to add one.'
                      : `No ${typeFilter === 'ALL' ? '' : typeFilter + ' '}bargains to show.`}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map((row) => (
                  <TableRow key={row.id as number}>
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
                ))
              )}
            </TableBody>
          </Table>
        </div>
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
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>Bargain condition</Label>
              <Select
                value={form.bargain_type}
                onValueChange={(v) =>
                  setForm((p) => ({
                    ...p,
                    bargain_type: v,
                    allowed_shortage_pct: v === 'DLD' ? '0' : p.allowed_shortage_pct
                  }))
                }
              >
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
              <Label>Duty per {form.uom || 'ton'}</Label>
              <Input type="number" value={form.duty} onChange={(e) => setField('duty', e.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Allowed shortage %</Label>
              <Input
                type="number"
                value={form.bargain_type === 'DLD' ? '0' : form.allowed_shortage_pct}
                disabled={form.bargain_type === 'DLD'}
                onChange={(e) => setField('allowed_shortage_pct', e.target.value)}
                placeholder={form.bargain_type === 'DLD' ? 'NIL — supplier delivers' : `default ${defaultShortage}`}
              />
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
