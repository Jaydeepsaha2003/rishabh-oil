import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

export function Production(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
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

  async function selectProduct(v: string): Promise<void> {
    setForm((p) => ({ ...p, product_id: v }))
    const f = formulations.find((x) => String(x.product_id) === v)
    setComponents(f ? await window.api.formulations.items(f.id as number) : [])
  }

  function openAdd(): void {
    setForm({ prod_date: todayISO(), product_id: '', qty: '' })
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
        qty
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
        <div className="p-8">
          <Card className="max-w-3xl p-6">
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={form.prod_date}
                  onChange={(e) => setForm((p) => ({ ...p, prod_date: e.target.value }))}
                />
              </div>
              <div className="col-span-2 grid gap-1.5">
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
            <div className="mt-3 grid max-w-[12rem] gap-1.5">
              <Label>Quantity produced *</Label>
              <Input type="number" value={form.qty} onChange={(e) => setForm((p) => ({ ...p, qty: e.target.value }))} />
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
          <Button size="sm" onClick={openAdd} disabled={outputs.length === 0}>
            <Plus className="h-4 w-4" />
            Record production
          </Button>
        }
      />
      <div className="p-8">
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
                rows.map((row) => (
                  <TableRow key={row.id as number}>
                    <TableCell>{formatDate(row.prod_date)}</TableCell>
                    <TableCell className="font-medium">{row.product_name}</TableCell>
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
        </div>
      </div>
    </>
  )
}
