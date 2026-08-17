import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Beaker, Calculator, Flame, Package, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
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

// Three kinds of line, each a % of the input quantity: what is drawn from
// stock, what the batch throws off besides the main product, and what is
// simply lost — by-products and loss are struck on the input going in, not
// the output coming out. Each gets its own colour so a recipe reads at a
// glance instead of as one undifferentiated list.
const SECTIONS = [
  {
    kind: 'input' as const,
    title: 'Inputs',
    subtitle: 'Consumed from stock',
    add: 'Add input',
    icon: Package,
    grad: 'from-sky-600 to-sky-500',
    accent: 'border-sky-400',
    calcBox: 'border-sky-200 bg-sky-50/60',
    formulaText: 'text-sky-800'
  },
  {
    kind: 'output' as const,
    title: 'By-products',
    subtitle: 'Added to stock',
    add: 'Add by-product',
    icon: Sparkles,
    grad: 'from-emerald-600 to-emerald-500',
    accent: 'border-emerald-400',
    calcBox: 'border-emerald-200 bg-emerald-50/60',
    formulaText: 'text-emerald-800'
  },
  {
    kind: 'loss' as const,
    title: 'Loss',
    subtitle: 'Written off',
    add: 'Add loss',
    icon: Flame,
    grad: 'from-rose-600 to-rose-500',
    accent: 'border-rose-400',
    calcBox: 'border-rose-200 bg-rose-50/60',
    formulaText: 'text-rose-800'
  }
]

// Tile tone per line kind, for the calculator's per-product requirement grid.
const KIND_TILE: Record<string, { box: string; label: string }> = {
  input: { box: 'border-sky-400/30 bg-sky-400/10', label: 'Needs' },
  output: { box: 'border-emerald-400/30 bg-emerald-400/10', label: 'Yields' },
  loss: { box: 'border-rose-400/30 bg-rose-400/10', label: 'Loses' }
}

const round2 = (v: number): number => Math.round(v * 100) / 100

// FFA% x (1 + loss multiplier%) + moisture% — e.g. 5% FFA x 1.10 + 0.2% = 5.7%.
// Full precision — feeds the TOR multiplier math below, which the backend
// (src/main/production.ts) also does at full precision. Rounding this to 2dp
// before it's divided into a multiplier and then multiplied by a blend share
// throws off the final TOR by more than a rounding error should (a 65% share
// alone turns a 0.003 rounding slip into +0.2), so it's kept raw here and only
// rounded at the edges: once for the by-product's own displayed/saved % (see
// autoCalcPct), and via formatNum wherever a figure is actually shown.
function rawFattyAcidPct(it: Row): number {
  const ffa = Number(it.ffa_pct) || 0
  const loss = Number(it.loss_multiplier_pct) || 0
  const moist = Number(it.moisture_pct) || 0
  return ffa * (1 + loss / 100) + moist
}

// The rounded, user-facing version — this is what a by-product line's own
// qty field shows and saves as its % of input, so it deliberately IS rounded
// (a clean percentage, not an internal ratio component).
function autoCalcPct(it: Row): number {
  return round2(rawFattyAcidPct(it))
}

// An input's own TOR multiplier — for a blend of differing-quality raw oils,
// each ingredient needs its own answer rather than one shared across the
// whole blend: 1 / (1 - (FFA% x (1 + loss%) + moisture%) - dead loss%). Dead
// loss isn't per-input — it's the recipe's own shared 'Loss' line total,
// always the same standing assumption for every ingredient.
function inputTorMultiplier(it: Row, sharedDeadLossPct: number): number {
  const yieldPct = 100 - rawFattyAcidPct(it) - sharedDeadLossPct
  return yieldPct > 0 ? 100 / yieldPct : 1
}

// The recipe-wide multiplier shared by every input line that doesn't carry
// its own — by-products and loss come off the oil going in, so the yield is
// (100 − their total)% and the requirement is 100 ÷ that yield.
function uniformTorOf(items: Row[]): number {
  const sum = (kind: string): number =>
    items.filter((it) => String(it.kind || 'input') === kind).reduce((s, it) => s + (Number(it.qty) || 0), 0)
  const offInput = sum('output') + sum('loss')
  return offInput > 0 && offInput < 100 ? (100 * 100) / (100 - offInput) : 100
}

// Dead loss is always the recipe's own 'Loss — written off' lines, total —
// the same standing assumption whether a recipe uses one shared multiplier
// or gives each input its own.
function sharedDeadLossPctOf(items: Row[]): number {
  return items.filter((it) => String(it.kind || 'input') === 'loss').reduce((s, it) => s + (Number(it.qty) || 0), 0)
}

// The recipe's total oil required, per 100 of output — the sum of each
// input's own share x its own multiplier (auto-calculated, or the recipe's
// shared one). A recipe with no per-input auto-calc collapses back to the
// plain uniform figure, exactly as it always worked.
function recipeTorOf(items: Row[]): number {
  const inputs = items.filter((it) => String(it.kind || 'input') === 'input')
  const blend = inputs.reduce((s, it) => s + (Number(it.qty) || 0), 0)
  const uniformTor = uniformTorOf(items)
  if (blend <= 0) return uniformTor
  const sharedDeadLoss = sharedDeadLossPctOf(items)
  return round2(
    inputs.reduce((s, it) => {
      const mult = it.auto_calc ? inputTorMultiplier(it, sharedDeadLoss) : uniformTor / 100
      return s + (Number(it.qty) || 0) * mult
    }, 0)
  )
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
        ? its.map((i) => ({
            product_id: String(i.product_id),
            qty: i.qty,
            kind: String(i.kind || 'input'),
            auto_calc: !!i.auto_calc,
            ffa_pct: i.ffa_pct ?? '',
            loss_multiplier_pct: i.loss_multiplier_pct ?? '',
            moisture_pct: i.moisture_pct ?? '',
            byproduct_product_id: i.byproduct_product_id ? String(i.byproduct_product_id) : ''
          }))
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

  // A by-product's % of input can be typed by hand, or auto-calculated from
  // its own FFA/loss/moisture inputs (Fatty Acid being the standing example).
  // Turning auto-calc on immediately writes the computed % into qty; turning
  // it off just freezes qty at whatever it last was, editable again by hand.
  //
  // An INPUT line's auto-calc is different: its qty is the blend SHARE (e.g.
  // 65%), typed by hand either way — auto-calc instead gives that one
  // ingredient its own TOR multiplier (see inputTorMultiplier above), for a
  // blend of raw oils where each is its own quality rather than one shared
  // loss across the whole blend.
  function toggleItemAutoCalc(idx: number): void {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it
        if (it.auto_calc) return { ...it, auto_calc: false }
        if (String(it.kind || 'input') === 'input') return { ...it, auto_calc: true }
        return { ...it, auto_calc: true, qty: String(autoCalcPct(it)) }
      })
    )
  }
  function setItemFormula(idx: number, key: 'ffa_pct' | 'loss_multiplier_pct' | 'moisture_pct', value: string): void {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it
        const next = { ...it, [key]: value }
        if (String(it.kind || 'input') === 'input') return next
        return { ...next, qty: String(autoCalcPct(next)) }
      })
    )
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
  // Shared by every input that doesn't carry its own multiplier — a blend of
  // differing-quality raw oils can give one (or more) input its own instead
  // (see inputTorMultiplier), in which case the recipe's real TOR is the sum
  // of each input's own share x its own multiplier, not this single figure.
  const uniformTor = uniformTorOf(items)
  const hasPerInputAutoCalc = items.some((it) => String(it.kind || 'input') === 'input' && it.auto_calc)
  const tor = recipeTorOf(items)
  const balanced = Math.abs(blendPct - 100) < 0.01
  // The manual By-products section is legacy — new recipes recover a
  // by-product through an input's own "By-product goes to" field instead.
  // Only shown at all when the recipe being edited already has one of these
  // lines (e.g. IVF, which can't move to the per-input model without
  // changing its recovered quantity) — hidden for every new recipe.
  const hasManualByproduct = items.some((it) => String(it.kind || 'input') === 'output')
  const visibleSections = hasManualByproduct ? SECTIONS : SECTIONS.filter((sec) => sec.kind !== 'output')
  // What the recipe means in real quantities, for a batch the user names.
  const [torQty, setTorQty] = useState('100')

  async function save(): Promise<void> {
    if (!form.product_id) {
      toast.error('Select the output product')
      return
    }
    const clean = items
      .map((it) => ({
        product_id: Number(it.product_id),
        qty: Number(it.qty) || 0,
        kind: String(it.kind || 'input'),
        auto_calc: !!it.auto_calc,
        ffa_pct: it.auto_calc && it.ffa_pct !== '' && it.ffa_pct != null ? Number(it.ffa_pct) : null,
        loss_multiplier_pct:
          it.auto_calc && it.loss_multiplier_pct !== '' && it.loss_multiplier_pct != null ? Number(it.loss_multiplier_pct) : null,
        moisture_pct: it.auto_calc && it.moisture_pct !== '' && it.moisture_pct != null ? Number(it.moisture_pct) : null,
        byproduct_product_id:
          it.auto_calc && String(it.kind || 'input') === 'input' && it.byproduct_product_id
            ? Number(it.byproduct_product_id)
            : null
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
    if (clean.some((it) => it.kind === 'input' && it.auto_calc && !it.byproduct_product_id)) {
      toast.error('Pick which product the recovered fatty acid becomes for every auto-calculated input')
      return
    }
    if (items.some((it) => String(it.kind || 'input') === 'input' && it.auto_calc) && !lossPct) {
      toast.error('Add a dead loss line under "Loss — written off" — every auto-calculated input needs one')
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
          <div className="mx-auto max-w-6xl space-y-5">
            {/* Output product header — no overflow-hidden here: the Output
                product dropdown opens INSIDE this card, and clipping the
                card would clip its panel along with it. */}
            <div className="rounded-2xl border shadow-sm">
              <div className="flex items-center gap-3 rounded-t-2xl bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-5 py-4 text-white">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15">
                  <Beaker className="h-5 w-5" />
                </span>
                <div>
                  <div className="text-[15px] font-bold">{editing ? 'Edit formulation' : 'New formulation'}</div>
                  <div className="text-[11px] text-white/70">Compose a finished good or intermediate from other products</div>
                </div>
              </div>
              <div className="grid gap-3 rounded-b-2xl bg-card p-5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Output product *</Label>
                  <Select
                    value={String(form.product_id)}
                    onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}
                  >
                    <SelectTrigger className="h-10">
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
                <div className="flex flex-col gap-1.5">
                  <Label>Name (optional)</Label>
                  <Input
                    className="h-10"
                    value={form.name ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. standard recipe"
                  />
                </div>
              </div>
            </div>

            {/* Three kinds of line, each a % of the input quantity: what is
                drawn from stock, what the batch throws off besides the main
                product, and what is simply lost — by-products and loss are
                struck on the input going in, not the output coming out. */}
            {visibleSections.map((sec) => {
              const secItems = items.map((it, idx) => ({ it, idx })).filter(({ it }) => String(it.kind || 'input') === sec.kind)
              return (
                // No overflow-hidden here either — each item row's product
                // dropdown opens inside this card and would get clipped along
                // with it, same reason as the header card above.
                <div key={sec.kind} className="rounded-2xl border shadow-sm">
                  <div className={cn('flex items-center gap-2.5 rounded-t-2xl bg-gradient-to-r px-4 py-3 text-white', sec.grad)}>
                    <sec.icon className="h-4 w-4 shrink-0" />
                    <div className="flex-1">
                      <div className="text-[13px] font-bold uppercase tracking-wide">{sec.title}</div>
                      <div className="text-[10px] text-white/75">{sec.subtitle}</div>
                    </div>
                    <Badge variant="secondary" className="border-transparent bg-white/20 text-white">
                      {secItems.length}
                    </Badge>
                    <Button size="sm" variant="secondary" className="h-7 bg-white/90 text-[#1a2c56] hover:bg-white" onClick={() => addItem(sec.kind)}>
                      <Plus className="h-3.5 w-3.5" /> {sec.add}
                    </Button>
                  </div>
                  <div className="space-y-2 rounded-b-2xl bg-muted/20 p-3">
                    {secItems.length === 0 ? (
                      <p className="px-2 py-4 text-center text-xs text-muted-foreground">None yet.</p>
                    ) : (
                      secItems.map(({ it, idx }) => (
                        <div key={idx} className={cn('rounded-xl border-l-4 bg-card p-3 shadow-sm transition-shadow hover:shadow-md', sec.accent)}>
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <Select
                                value={String(it.product_id)}
                                onValueChange={(v) => setItem(idx, 'product_id', v)}
                              >
                                <SelectTrigger className="h-9">
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
                            <div className="relative w-32 shrink-0">
                              <Input
                                type="number"
                                className={cn('h-9 pr-6 text-right font-semibold tabular-nums', sec.kind === 'output' && it.auto_calc && 'bg-muted/60 text-muted-foreground')}
                                placeholder="0"
                                readOnly={sec.kind === 'output' && !!it.auto_calc}
                                value={it.qty ?? ''}
                                onChange={(e) => setItem(idx, 'qty', e.target.value)}
                              />
                              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">%</span>
                            </div>
                            {(sec.kind === 'output' || sec.kind === 'input') && (
                              <Button
                                type="button"
                                variant={it.auto_calc ? 'default' : 'outline'}
                                size="icon"
                                className="h-9 w-9 shrink-0"
                                title={
                                  it.auto_calc
                                    ? sec.kind === 'input'
                                      ? 'Auto-calculated TOR multiplier — click to turn off'
                                      : 'Auto-calculated — click to enter the % by hand instead'
                                    : sec.kind === 'input'
                                      ? "Give this ingredient its own TOR multiplier from FFA %, loss multiplier and moisture — dead loss always comes from the recipe's own Loss line below"
                                      : 'Auto-calculate from FFA %, loss multiplier and moisture loss'
                                }
                                onClick={() => toggleItemAutoCalc(idx)}
                              >
                                <Calculator className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10"
                              onClick={() => removeItem(idx)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {(sec.kind === 'output' || sec.kind === 'input') && it.auto_calc && (
                            <div className={cn('mt-2.5 grid gap-2.5 rounded-lg border p-2.5', sec.kind === 'input' ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3', sec.calcBox)}>
                              <div className="flex flex-col gap-0.5">
                                <Label className="flex items-center gap-1 text-[10px] font-semibold text-amber-800">
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" /> Oil FFA %
                                </Label>
                                <Input
                                  type="number"
                                  className="h-8 border-amber-200 bg-amber-50/60 text-right focus-visible:ring-amber-400"
                                  value={it.ffa_pct ?? ''}
                                  onChange={(e) => setItemFormula(idx, 'ffa_pct', e.target.value)}
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <Label className="flex items-center gap-1 text-[10px] font-semibold text-rose-800">
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" /> Loss multiplier % (the "1 +")
                                </Label>
                                <Input
                                  type="number"
                                  className="h-8 border-rose-200 bg-rose-50/60 text-right focus-visible:ring-rose-400"
                                  value={it.loss_multiplier_pct ?? ''}
                                  onChange={(e) => setItemFormula(idx, 'loss_multiplier_pct', e.target.value)}
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <Label className="flex items-center gap-1 text-[10px] font-semibold text-cyan-800">
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" /> Moisture loss %
                                </Label>
                                <Input
                                  type="number"
                                  className="h-8 border-cyan-200 bg-cyan-50/60 text-right focus-visible:ring-cyan-400"
                                  value={it.moisture_pct ?? ''}
                                  onChange={(e) => setItemFormula(idx, 'moisture_pct', e.target.value)}
                                />
                              </div>
                              {sec.kind === 'input' && (
                                <div className="flex flex-col gap-0.5">
                                  <Label className="flex items-center gap-1 text-[10px] font-semibold text-emerald-800">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /> By-product goes to *
                                  </Label>
                                  <Select
                                    value={it.byproduct_product_id ? String(it.byproduct_product_id) : ''}
                                    onValueChange={(v) => setItem(idx, 'byproduct_product_id', v)}
                                  >
                                    <SelectTrigger className="h-8 border-emerald-200 bg-emerald-50/60 text-xs"><SelectValue placeholder="e.g. Fatty Acid" /></SelectTrigger>
                                    <SelectContent>
                                      {products.map((p) => (
                                        <SelectItem key={p.id} value={String(p.id)}>
                                          {p.name} · {CAT_LABEL[p.category] ?? p.category}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}
                              {sec.kind === 'input' ? (
                                <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2.5 py-1.5 sm:col-span-4">
                                  <span className={cn('text-[11px]', sec.formulaText)}>
                                    1 ÷ (1 − (FFA % × (1 + loss %) + moisture %) − recipe's dead loss %) = this ingredient's own TOR multiplier
                                  </span>
                                  <span className="rounded-full bg-sky-600 px-2.5 py-0.5 text-[12px] font-bold tabular-nums text-white">
                                    ×{inputTorMultiplier(it, lossPct).toFixed(4)}
                                  </span>
                                </div>
                              ) : (
                                <div className="col-span-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2.5 py-1.5">
                                  <span className="text-[11px] text-emerald-800">FFA % × (1 + loss %) + moisture % = % of input</span>
                                  <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-[12px] font-bold tabular-nums text-white">
                                    {formatNum(autoCalcPct(it))}%
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}

            {/* TOR calculator — the mass balance, and what it means for a real batch. */}
            <div className="overflow-hidden rounded-2xl border border-[#2c4a8c] shadow-lg">
              <div className="flex flex-wrap items-center gap-2 bg-gradient-to-r from-[#0f1c3d] to-[#1a2c56] px-5 py-3 text-white">
                <Calculator className="h-4 w-4 shrink-0 text-amber-400" />
                <span className="text-[13px] font-bold uppercase tracking-widest">TOR Calculator</span>
                <span
                  className={cn(
                    'ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tabular-nums',
                    balanced ? 'border-emerald-400 bg-emerald-400/10 text-emerald-300' : 'border-rose-400 bg-rose-400/10 text-rose-300'
                  )}
                >
                  Input blend {formatNum(blendPct)}% {balanced ? '✓' : '· must be 100%'}
                </span>
              </div>
              <div className="bg-gradient-to-b from-[#1a2c56] to-[#132247] p-5 text-white">
                <p className="text-[12px] leading-relaxed text-white/70">
                  {hasPerInputAutoCalc ? (
                    <>
                      One or more inputs carry their own TOR multiplier (a blend of differing-quality raw oils), so the
                      total isn&apos;t one shared loss — it&apos;s each input&apos;s own share × its own multiplier, summed:{' '}
                      <b className="text-white">{formatNum(tor)}%</b> total raw material to make 100 of{' '}
                      {products.find((p) => String(p.id) === String(form.product_id))?.name || 'the output'}.
                    </>
                  ) : offInput > 0 ? (
                    <>
                      {formatNum(byProductPct)}% by-products + {formatNum(lossPct)}% loss comes off the oil going in, so{' '}
                      {formatNum(100 - offInput)}% of it becomes{' '}
                      {products.find((p) => String(p.id) === String(form.product_id))?.name || 'the output'} — meaning{' '}
                      100 ÷ {((100 - offInput) / 100).toFixed(4)} = <b className="text-white">{formatNum(tor)}%</b> has
                      to be put in.
                    </>
                  ) : (
                    <>Nothing is lost, so the blend goes in one for one with the output.</>
                  )}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-black/20 p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-white/60">Produce</span>
                    <Input
                      type="number"
                      className="h-11 w-28 border-white/20 bg-white/10 text-center text-lg font-bold tabular-nums text-white"
                      value={torQty}
                      onChange={(e) => setTorQty(e.target.value)}
                    />
                    <span className="text-[11px] uppercase tracking-wide text-white/60">{form.uom || 'MT'}</span>
                  </div>
                  <ArrowRight className="h-5 w-5 shrink-0 text-white/40" />
                  <div className="flex items-baseline gap-2 rounded-xl bg-amber-400/15 px-4 py-2">
                    <span className="text-[11px] uppercase tracking-wide text-amber-300">Total oil required</span>
                    <span className="text-2xl font-black tabular-nums text-amber-300">
                      {formatNum(((Number(torQty) || 0) * tor) / 100)}
                    </span>
                    <span className="text-[11px] text-amber-300/80">{form.uom || 'MT'}</span>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] uppercase tracking-wide text-white/50">TOR per 100</div>
                    <div className="text-xl font-bold tabular-nums">{formatNum(tor)}%</div>
                  </div>
                </div>

                {/* Per-product requirement — one table, not a wall of
                    tiles, so exactly how much of each product this batch
                    size needs (and what it recovers, and loses) reads the
                    way the client's own spreadsheet lays it out. */}
                <div className="mt-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-white/60">Per-product requirement</div>
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-white/5 text-[10px] uppercase tracking-wide text-white/60">
                          <th className="px-3 py-2 text-left">Type</th>
                          <th className="px-3 py-2 text-left">Product</th>
                          <th className="px-3 py-2 text-right">Share</th>
                          <th className="px-3 py-2 text-right">Quantity</th>
                          <th className="px-3 py-2 text-right">Fatty yield</th>
                          <th className="px-3 py-2 text-right">Multiplier</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          // Multiplier = effPct ÷ the line's own entered %, the
                          // same "TOR MULTIPLE" the client's spreadsheet shows —
                          // for an input that's its per-kg TOR multiplier, and
                          // for a loss/by-product line it collapses to the
                          // recipe's overall TOR ÷ 100 (since that line rides on
                          // the whole recipe's draw, not its own multiplier).
                          type ReqRow = { key: string; kind: string; name: string; share: number | null; q: number; fattyYield: number | null; multiplier: number | null; auto?: boolean }
                          const rows: ReqRow[] = []
                          const batchQty = Number(torQty) || 0
                          items
                            .filter((it) => it.product_id && Number(it.qty) > 0)
                            .forEach((it, i) => {
                              const p = products.find((x) => String(x.id) === String(it.product_id))
                              const kind = String(it.kind || 'input')
                              const share = Number(it.qty) || 0
                              // An input with its own TOR multiplier takes share x
                              // its own multiplier directly; a plain input rides
                              // on the recipe's shared multiplier. A by-product/
                              // loss line is a % of the input, so it rides on the
                              // recipe's REAL total TOR — not the uniform figure,
                              // which understates it once any input carries its
                              // own multiplier (e.g. 1.01% instead of the correct
                              // 1.2375% on a 123.75% TOR).
                              const effPct =
                                kind === 'input'
                                  ? it.auto_calc
                                    ? share * inputTorMultiplier(it, lossPct)
                                    : (share * uniformTor) / 100
                                  : (tor * share) / 100
                              // This input's OWN slice of the recovered fatty
                              // acid — the client's spreadsheet shows this per
                              // ingredient (22.31 / 0.053 / 0.143), not just the
                              // pooled total.
                              const fattyYield =
                                kind === 'input' && it.auto_calc
                                  ? (batchQty * effPct * rawFattyAcidPct(it)) / 100 / 100
                                  : null
                              rows.push({
                                key: `it-${i}`,
                                kind,
                                name: p?.name || '—',
                                share: kind === 'input' ? share : null,
                                q: (batchQty * effPct) / 100,
                                fattyYield,
                                multiplier: share > 0 ? effPct / share : null
                              })
                            })
                          // The fatty acid each auto-calc input throws off is a
                          // real by-product, not just a yield hit — summed here
                          // by whichever product each one names, exactly what a
                          // production run using this recipe will add to stock.
                          const byproductAdds = new Map<number, number>()
                          for (const it of items) {
                            if (String(it.kind || 'input') !== 'input' || !it.auto_calc || !it.byproduct_product_id) continue
                            const share = Number(it.qty) || 0
                            const effPct = share * inputTorMultiplier(it, lossPct)
                            // Raw, not the rounded display %, so this matches the
                            // actual by-product qty a production run will add to
                            // stock (src/main/production.ts does the same).
                            const fattyAcidEffPct = (effPct * rawFattyAcidPct(it)) / 100
                            const pid = Number(it.byproduct_product_id)
                            byproductAdds.set(pid, (byproductAdds.get(pid) || 0) + fattyAcidEffPct)
                          }
                          let fattyYieldTotal = 0
                          for (const [pid, effPct] of byproductAdds) {
                            const p = products.find((x) => Number(x.id) === pid)
                            const q = (batchQty * effPct) / 100
                            fattyYieldTotal += q
                            rows.push({
                              key: `byp-${pid}`,
                              kind: 'output',
                              name: p?.name || '—',
                              share: null,
                              q,
                              // Same figure as Quantity for this row — it IS the
                              // pooled fatty yield — but shown here too so the
                              // total lines up under its own column, not just in
                              // Quantity.
                              fattyYield: q,
                              // Pooled across every input that recovers into this
                              // same product, each at its own multiplier — no
                              // single multiplier describes the combined line.
                              multiplier: null,
                              auto: true
                            })
                          }
                          const bodyRows = rows.map((r) => {
                            const tile = KIND_TILE[r.kind]
                            return (
                              <tr key={r.key} className={cn('border-t border-white/10', tile.box)}>
                                <td className="px-3 py-2 font-semibold uppercase tracking-wide text-[11px] text-white/80">{tile.label}</td>
                                <td className="px-3 py-2 font-medium">
                                  {r.name}
                                  {r.auto && <span className="ml-1.5 text-[10px] font-normal text-white/50">auto, from FFA</span>}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-white/70">{r.share != null ? `${formatNum(r.share)}%` : '—'}</td>
                                <td className="px-3 py-2 text-right font-bold tabular-nums">
                                  {formatNum(r.q)} <span className="font-normal text-white/60">{form.uom || 'MT'}</span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-emerald-300">
                                  {r.fattyYield != null ? `${formatNum(r.fattyYield)} ${form.uom || 'MT'}` : '—'}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-white/60">{r.multiplier != null ? `×${r.multiplier.toFixed(4)}` : '—'}</td>
                              </tr>
                            )
                          })
                          // Net = everything drawn in, minus what came back out as
                          // by-product or loss — the same reconciliation the
                          // client's spreadsheet ends on, and it should always
                          // land back on the batch size itself.
                          const inputTotal = rows.filter((r) => r.kind === 'input').reduce((s, r) => s + r.q, 0)
                          const deadLossTotal = rows.filter((r) => r.kind === 'loss').reduce((s, r) => s + r.q, 0)
                          const net = inputTotal - fattyYieldTotal - deadLossTotal
                          bodyRows.push(
                            <tr key="net" className="border-t border-white/20 bg-white/5 font-bold">
                              <td colSpan={2} className="px-3 py-2 text-[11px] uppercase tracking-wide text-white/70">Net</td>
                              <td colSpan={4} className="px-3 py-2 text-right">
                                <span className="inline-flex flex-wrap items-baseline justify-end gap-1.5 tabular-nums">
                                  <span className="text-white">{formatNum(inputTotal)}</span>
                                  <span className="text-white/50">−</span>
                                  <span className="text-emerald-300">{formatNum(fattyYieldTotal)}</span>
                                  <span className="text-white/50">−</span>
                                  <span className="text-rose-300">{formatNum(deadLossTotal)}</span>
                                  <span className="text-white/50">=</span>
                                  <span className="text-amber-300">{formatNum(net)} {form.uom || 'MT'}</span>
                                </span>
                                <div className="mt-0.5 text-right text-[10px] font-normal normal-case tracking-normal text-white/40">
                                  inputs − fatty yield − dead loss = batch size
                                </div>
                              </td>
                            </tr>
                          )
                          return bodyRows
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pb-2">
              <Button variant="outline" onClick={() => setBuilding(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving} className="bg-[#1a2c56] hover:bg-[#24407e]">
                {saving ? 'Saving…' : 'Save formulation'}
              </Button>
            </div>
          </div>
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
