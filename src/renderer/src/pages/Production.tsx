import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
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
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { Pagination, usePaged } from '@/components/Pagination'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

export function Production(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const paged = usePaged(rows)
  const [products, setProducts] = useState<Row[]>([])
  const [formulations, setFormulations] = useState<Row[]>([])
  const [stock, setStock] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)

  const [building, setBuilding] = useState(false)
  const [form, setForm] = useState<Row>({ prod_date: todayISO(), product_id: '', qty: '' })
  const [components, setComponents] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [p, pr, f, s] = await Promise.all([
      window.api.production.list(),
      window.api.data.list('products'),
      window.api.formulations.list(),
      window.api.stock.list()
    ])
    setRows(p)
    setProducts(pr.filter((x) => x.active))
    setFormulations(f)
    const sm: Record<number, number> = {}
    for (const l of s) sm[l.id as number] = l.stock as number
    setStock(sm)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const outputs = products.filter((p) => p.category === 'finished' || p.category === 'intermediate')

  // A product can have more than one formulation (e.g. RPO's CPO-based recipe
  // and a SHEA-based one) — listFormulations() already comes back newest
  // first, so that's the default; the picker only shows at all once there's
  // an actual choice to make.
  const recipesForProduct = formulations.filter((x) => String(x.product_id) === String(form.product_id))

  async function loadRecipe(formulationId: number | null): Promise<void> {
    setForm((p) => ({ ...p, formulation_id: formulationId }))
    setComponents(formulationId ? await window.api.formulations.items(formulationId) : [])
  }

  async function selectProduct(v: string): Promise<void> {
    setForm((p) => ({ ...p, product_id: v, formulation_id: null }))
    const matches = formulations.filter((x) => String(x.product_id) === v)
    await loadRecipe(matches.length ? Number(matches[0].id) : null)
  }

  function openAdd(): void {
    setForm({ prod_date: todayISO(), product_id: '', qty: '', formulation_id: null })
    setComponents([])
    setBuilding(true)
  }

  const qty = Number(form.qty) || 0
  const consumption: Row[] = components.map((c) => {
    const consumes = (qty * Number(c.qty)) / 100
    const current = stock[c.product_id as number] ?? 0
    return { ...c, consumes, current, after: current - consumes }
  })
  const hasShortfall = consumption.some((c) => c.after < -1e-9)

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select a product')
      return
    }
    if (!qty || qty <= 0) {
      toast.error('Enter the quantity produced')
      return
    }
    setSaving(true)
    try {
      await window.api.production.create({
        prod_date: form.prod_date,
        product_id: Number(form.product_id),
        qty,
        formulation_id: form.formulation_id || null
      })
      toast.success('Production recorded')
      setBuilding(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete this production entry for ${row.product_name}?`)) return
    try {
      await window.api.production.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (building) {
    return (
      <>
        <PageHeader
          title="Record production"
          subtitle="Today's finished goods or intermediates — stock is drawn from the formula"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setBuilding(false)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          }
        />
        <div className="px-4 py-6">
          <Card className="max-w-3xl p-6">
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Date</Label>
                <DatePicker
                  value={form.prod_date}
                  onChange={(v) => setForm((p) => ({ ...p, prod_date: v }))}
                />
              </div>
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label>Product *</Label>
                <Select value={String(form.product_id)} onValueChange={selectProduct}>
                  <SelectTrigger>
                    <SelectValue placeholder="Finished good or intermediate" />
                  </SelectTrigger>
                  <SelectContent>
                    {outputs.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name} · {CAT_LABEL[p.category] ?? p.category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Quantity produced *</Label>
                <Input type="number" value={form.qty} onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))} />
              </div>
              {/* Only shown once there's an actual choice — a product with a
                  single formulation just uses it, same as before. */}
              {recipesForProduct.length > 1 && (
                <div className="col-span-2 flex flex-col gap-1.5">
                  <Label>Recipe <span className="text-[10px] font-normal text-muted-foreground">({recipesForProduct.length} formulations for this product)</span></Label>
                  <Select value={String(form.formulation_id ?? '')} onValueChange={(v) => void loadRecipe(Number(v))}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose which recipe to use" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipesForProduct.map((f) => (
                        <SelectItem key={f.id} value={String(f.id)}>
                          {f.name || `Recipe #${f.id}`} · TOR {formatNum(f.tor)}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="mt-6">
              <div className="mb-2 text-sm font-medium">Raw material consumed (from formula)</div>
              {!form.product_id ? (
                <p className="text-sm text-muted-foreground">Select a product to see its recipe.</p>
              ) : components.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No formulation for this product — nothing will be consumed.
                </p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Component</TableHead>
                        <TableHead className="text-right">%</TableHead>
                        <TableHead className="text-right">Consumes</TableHead>
                        <TableHead className="text-right">In stock</TableHead>
                        <TableHead className="text-right">After</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {consumption.map((c) => (
                        <TableRow key={c.id as number}>
                          <TableCell>{c.product_name}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(c.qty)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(c.consumes)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatNum(c.current)}</TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-medium tabular-nums',
                              c.after < -1e-9 ? 'text-red-600' : ''
                            )}
                          >
                            {formatNum(c.after)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {hasShortfall && (
                <p className="mt-2 text-xs text-amber-700">
                  Some components go negative — you can still record it, but raw stock will show short.
                </p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBuilding(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Record production'}
              </Button>
            </div>
          </Card>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Production"
        subtitle="Daily production runs"
        hint="Recording a run consumes the formula's input products from stock and adds the produced output. The formula must total 100%."
        actions={
          <div className="flex items-center gap-2">
            <ExcelButton
              filename={`production-${todayISO()}`}
              sheetName="Production"
              title="Production runs"
              columns={[
                { header: 'Date', key: 'prod_date', value: (r) => formatDate(r.prod_date) },
                { header: 'Product', key: 'product_name', value: (r) => r.product_name || '' },
                { header: 'Category', key: 'product_category', value: (r) => CAT_LABEL[r.product_category] ?? r.product_category ?? '' },
                { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
                { header: 'UOM', key: 'uom', value: (r) => r.uom || '' }
              ]}
              rows={rows}
            />
            <Button size="sm" onClick={openAdd} disabled={outputs.length === 0}>
              <Plus className="h-4 w-4" />
              Record production
            </Button>
          </div>
        }
      />
      <div className="px-4 py-6">
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="w-[60px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No production recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                paged.pageRows.map((row) => (
                  <TableRow key={row.id as number}>
                    <TableCell>{formatDate(row.prod_date)}</TableCell>
                    <TableCell className="font-medium">
                      {row.product_name}
                      {row.formulation_name && (
                        <div className="text-xs font-normal text-muted-foreground">{row.formulation_name}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.product_category === 'finished' ? 'success' : 'secondary'}>
                        {CAT_LABEL[row.product_category] ?? row.product_category}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNum(row.qty)} {row.uom}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => del(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <Pagination {...paged} label="runs" className="border-t px-3" />
        </div>
      </div>
    </>
  )
}
