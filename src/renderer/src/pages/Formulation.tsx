import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
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
import { formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

export function Formulation(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState<Row | null>(null)
  const [building, setBuilding] = useState(false)
  const [form, setForm] = useState<Row>({ product_id: '', name: '', uom: 'ton' })
  const [items, setItems] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [f, p] = await Promise.all([
      window.api.formulations.list(),
      window.api.data.list('products')
    ])
    setRows(f)
    setProducts(p.filter((x) => x.active))
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const outputs = products.filter((p) => p.category === 'finished' || p.category === 'intermediate')

  function openAdd(): void {
    setEditing(null)
    setForm({ product_id: '', name: '', uom: 'ton' })
    setItems([{ product_id: '', qty: '' }])
    setBuilding(true)
  }

  async function openEdit(row: Row): Promise<void> {
    setEditing(row)
    setForm({ product_id: String(row.product_id ?? ''), name: row.name ?? '', uom: row.uom ?? 'ton' })
    const its = await window.api.formulations.items(row.id as number)
    setItems(
      its.length
        ? its.map((i) => ({ product_id: String(i.product_id), qty: i.qty }))
        : [{ product_id: '', qty: '' }]
    )
    setBuilding(true)
  }

  function setItem(idx: number, key: string, value: unknown): void {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)))
  }
  function addItem(): void {
    setItems((prev) => [...prev, { product_id: '', qty: '' }])
  }
  function removeItem(idx: number): void {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const total = items.reduce((s, it) => s + (Number(it.qty) || 0), 0)

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select the output product')
      return
    }
    const clean = items
      .map((it) => ({ product_id: Number(it.product_id), qty: Number(it.qty) || 0 }))
      .filter((it) => it.product_id && it.qty > 0)
    if (clean.length === 0) {
      toast.error('Add at least one component with a quantity')
      return
    }
    const cleanTotal = clean.reduce((s, it) => s + it.qty, 0)
    if (Math.abs(cleanTotal - 100) > 0.01) {
      toast.error(`Components must total 100% (currently ${formatNum(cleanTotal)}%)`)
      return
    }
    setSaving(true)
    try {
      const payload = {
        product_id: Number(form.product_id),
        name: form.name,
        uom: form.uom,
        items: clean
      }
      if (editing) await window.api.formulations.update(editing.id as number, payload)
      else await window.api.formulations.create(payload)
      toast.success('Formulation saved')
      setBuilding(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete the formulation for ${row.product_name}?`)) return
    try {
      await window.api.formulations.remove(row.id as number)
      toast.success('Formulation deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ---- builder (page view) ----
  if (building) {
    return (
      <>
        <PageHeader
          title={editing ? 'Edit formulation' : 'New formulation'}
          subtitle="Compose a finished good or intermediate from other products"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setBuilding(false)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          }
        />
        <div className="p-8">
          <Card className="max-w-3xl p-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Output product *</Label>
                <Select
                  value={String(form.product_id)}
                  onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}
                >
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
              <div className="grid gap-1.5">
                <Label>Name (optional)</Label>
                <Input
                  value={form.name ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. standard recipe"
                />
              </div>
            </div>

            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <Label>Components</Label>
                <Button variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4" /> Add component
                </Button>
              </div>
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <span className="flex-1">Product</span>
                  <span className="w-32">Percent (%)</span>
                  <span className="w-8" />
                </div>
                <div className="divide-y">
                  {items.map((it, idx) => (
                    <div key={idx} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1">
                        <Select
                          value={String(it.product_id)}
                          onValueChange={(v) => setItem(idx, 'product_id', v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select product" />
                          </SelectTrigger>
                          <SelectContent>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.name} · {CAT_LABEL[p.category] ?? p.category}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Input
                        type="number"
                        className="w-32"
                        placeholder="0"
                        value={it.qty ?? ''}
                        onChange={(e) => setItem(idx, 'qty', e.target.value)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-8 text-destructive"
                        onClick={() => removeItem(idx)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Total</span>
                  <span
                    className={cn(
                      'pr-10 text-right font-semibold tabular-nums',
                      Math.abs(total - 100) < 0.01 ? 'text-emerald-600' : 'text-red-600'
                    )}
                  >
                    {formatNum(total)}% {Math.abs(total - 100) < 0.01 ? '✓' : '· must be 100%'}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Each component is a percentage of the output. The recipe must total exactly 100% to
                save.
              </p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBuilding(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save formulation'}
              </Button>
            </div>
          </Card>
        </div>
      </>
    )
  }

  // ---- list ----
  return (
    <>
      <PageHeader
        title="Formulation"
        subtitle="Recipes for finished goods and intermediates"
        actions={
          <Button size="sm" onClick={openAdd} disabled={outputs.length === 0}>
            <Plus className="h-4 w-4" />
            New formulation
          </Button>
        }
      />
      <div className="p-8">
        {outputs.length === 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Add finished or intermediate products first (Products page) to build a formulation.
          </div>
        )}
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Output product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Recipe</TableHead>
                <TableHead className="text-right">Components</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-[90px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No formulations yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id as number}>
                    <TableCell className="font-medium">{row.product_name ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={row.product_category === 'finished' ? 'success' : 'secondary'}>
                        {CAT_LABEL[row.product_category] ?? row.product_category}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.name || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.item_count}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        Math.abs(Number(row.total_qty) - 100) < 0.01 ? '' : 'text-red-600'
                      )}
                    >
                      {formatNum(row.total_qty)}%
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
    </>
  )
}
