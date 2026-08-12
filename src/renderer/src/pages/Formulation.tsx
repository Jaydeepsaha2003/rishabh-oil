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
    setItems([{ product_id: '', qty: '', kind: 'input' }])
    setBuilding(true)
  }

  async function openEdit(row: Row): Promise<void> {
    setEditing(row)
    setForm({ product_id: String(row.product_id ?? ''), name: row.name ?? '', uom: row.uom ?? 'ton' })
    const its = await window.api.formulations.items(row.id as number)
    setItems(
      its.length
        ? its.map((i) => ({ product_id: String(i.product_id), qty: i.qty, kind: String(i.kind || 'input') }))
        : [{ product_id: '', qty: '', kind: 'input' }]
    )
    setBuilding(true)
  }

  function setItem(idx: number, key: string, value: unknown): void {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)))
  }
  function addItem(kind: string): void {
    setItems((prev) => [...prev, { product_id: '', qty: '', kind }])
  }
  function removeItem(idx: number): void {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  // Inputs describe the BLEND that goes in — its shares total 100% (100% CPO
  // base, or 70/30 of two oils). How much of that blend is actually needed
  // follows from what the batch gives back: 100% of the output, plus the
  // by-products, plus the loss. That total is the TOR.
  const pctOf = (kind: string): number =>
    items.filter((it) => String(it.kind || 'input') === kind).reduce((s, it) => s + (Number(it.qty) || 0), 0)
  const blendPct = pctOf('input')
  const byProductPct = pctOf('output')
  const lossPct = pctOf('loss')
  // By-products and loss come off the oil going IN, so the yield is what is
  // left of it and the requirement is 100 ÷ that yield:
  //   5.7% fatty + 1% dead loss -> 93.3% yield -> 100/0.933 = 107.18%
  const offInput = byProductPct + lossPct
  const tor = offInput > 0 && offInput < 100 ? (100 * 100) / (100 - offInput) : 100
  const balanced = Math.abs(blendPct - 100) < 0.01
  // What the recipe means in real quantities, for a batch the user names.
  const [torQty, setTorQty] = useState('100')
  const total = tor

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select the output product')
      return
    }
    const clean = items
      .map((it) => ({
        product_id: Number(it.product_id),
        qty: Number(it.qty) || 0,
        kind: String(it.kind || 'input')
      }))
      .filter((it) => it.product_id && it.qty > 0)
    if (!clean.some((it) => it.kind === 'input')) {
      toast.error('Add at least one input with a percentage')
      return
    }
    if (!balanced) {
      toast.error(`The input blend must total 100% (currently ${formatNum(blendPct)}%)`)
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
        <div className="px-4 py-6">
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

            {/* Three kinds of line, each a % of the output quantity: what is
                drawn from stock, what the batch throws off besides the main
                product, and what is simply lost. */}
            {([
              { kind: 'input', title: 'Inputs — consumed from stock', add: 'Add input', tone: 'text-rose-800' },
              { kind: 'output', title: 'By-products — added to stock', add: 'Add by-product', tone: 'text-emerald-800' },
              { kind: 'loss', title: 'Loss — written off', add: 'Add loss', tone: 'text-amber-800' }
            ] as const).map((sec) => (
              <div className="mt-6" key={sec.kind}>
                <div className="mb-2 flex items-center justify-between">
                  <Label className={sec.tone}>{sec.title}</Label>
                  <Button variant="outline" size="sm" onClick={() => addItem(sec.kind)}>
                    <Plus className="h-4 w-4" /> {sec.add}
                  </Button>
                </div>
                <div className="rounded-lg border">
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span className="flex-1">Product</span>
                    <span className="w-32">% of output</span>
                    <span className="w-8" />
                  </div>
                  <div className="divide-y">
                    {items.filter((it) => String(it.kind || 'input') === sec.kind).length === 0 ? (
                      <p className="px-3 py-2.5 text-xs text-muted-foreground">None.</p>
                    ) : (
                      items.map((it, idx) =>
                        String(it.kind || 'input') !== sec.kind ? null : (
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
                              className="w-32 text-right"
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
                        )
                      )
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* The mass balance, and what it means for a real batch. */}
            <div className="mt-6 rounded-lg border border-[#d9d2b8] bg-[#fffdf4] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-[#1a2c56]">Input blend</span>
                <span className={cn('font-semibold tabular-nums', balanced ? 'text-emerald-700' : 'text-red-600')}>
                  {formatNum(blendPct)}% {balanced ? '✓' : '· must be 100%'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {offInput > 0 ? (
                  <>
                    {formatNum(byProductPct)}% by-products + {formatNum(lossPct)}% loss comes off the oil going in, so{' '}
                    {formatNum(100 - offInput)}% of it becomes{' '}
                    {products.find((p) => String(p.id) === String(form.product_id))?.name || 'the output'} — meaning{' '}
                    100 ÷ {((100 - offInput) / 100).toFixed(4)} = <b className="text-foreground">{formatNum(tor)}%</b> has
                    to be put in.
                  </>
                ) : (
                  <>Nothing is lost, so the blend goes in one for one with the output.</>
                )}
              </p>

              <div className="mt-3 border-t border-dotted border-[#d9d2b8] pt-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold text-[#1a2c56]">TOR</span>
                  <span className="text-muted-foreground">— to produce</span>
                  <Input
                    type="number"
                    className="h-8 w-24 bg-white text-right"
                    value={torQty}
                    onChange={(e) => setTorQty(e.target.value)}
                  />
                  <span className="text-muted-foreground">{form.uom || 'MT'}, total oil required is</span>
                  <span className="rounded bg-[#1a2c56] px-2 py-0.5 font-bold tabular-nums text-white">
                    {formatNum(((Number(torQty) || 0) * tor) / 100)} {form.uom || 'MT'}
                  </span>
                </div>
                <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {items
                    .filter((it) => it.product_id && Number(it.qty) > 0)
                    .map((it, i) => {
                      const p = products.find((x) => String(x.id) === String(it.product_id))
                      const kind = String(it.kind || 'input')
                      const share = Number(it.qty) || 0
                      // Everything is measured against the oil going in, and
                      // that quantity is the TOR — so every line scales by it.
                      const effPct = (tor * share) / 100
                      const q = ((Number(torQty) || 0) * effPct) / 100
                      return (
                        <div key={i} className="flex justify-between">
                          <span>
                            {kind === 'input' ? 'Needs' : kind === 'output' ? 'Yields' : 'Loses'} {p?.name || '—'}
                            {kind === 'input' && share !== 100 && (
                              <span className="ml-1 opacity-70">({formatNum(share)}% of blend)</span>
                            )}
                          </span>
                          <span className="tabular-nums">
                            {formatNum(q)} {form.uom || 'MT'} ({formatNum(effPct)}%)
                          </span>
                        </div>
                      )
                    })}
                </div>
              </div>
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
        hint="Inputs are the blend that goes in and total 100% (100% CPO base, or 70/30 of two oils). By-products and loss are percentages of that oil — 5.7% fatty acid and 1% dead loss leave 93.3% becoming RPO. TOR (Total Oil Required) follows: 100 ÷ 0.933 = 107.18%, so 100 MT of RPO draws 107.18 MT of CPO and throws off 6.11 MT of fatty acid. Inputs are consumed from stock, by-products land in stock, loss is written off."
        actions={
          <Button size="sm" onClick={openAdd} disabled={outputs.length === 0}>
            <Plus className="h-4 w-4" />
            New formulation
          </Button>
        }
      />
      <div className="px-4 py-6">
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
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">By-products</TableHead>
                <TableHead className="text-right">Loss</TableHead>
                <TableHead className="text-right">TOR (per 100)</TableHead>
                <TableHead className="w-[90px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
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
                    <TableCell className="text-right tabular-nums text-emerald-700">
                      {Number(row.byproduct_pct) ? `${formatNum(row.byproduct_pct)}%` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-amber-700">
                      {Number(row.loss_pct) ? `${formatNum(row.loss_pct)}%` : '—'}
                    </TableCell>
                    {(() => {
                      // The blend must total 100%; TOR is derived from it.
                      const ok = Math.abs(Number(row.blend_pct || 0) - 100) < 0.01
                      return (
                        <TableCell
                          className={cn('text-right font-semibold tabular-nums', ok ? 'text-[#1a2c56]' : 'text-red-600')}
                          title={
                            ok
                              ? 'Total oil required to produce 100 of the output'
                              : `The input blend totals ${formatNum(row.blend_pct)}% — it must be 100%`
                          }
                        >
                          {formatNum(row.tor)}%
                        </TableCell>
                      )
                    })()}
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
