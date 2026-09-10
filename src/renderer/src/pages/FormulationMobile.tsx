// Mobile Formulation screen — website only (see the fork in Formulation.tsx).
//
// Built to the "Formulation — mobile" screen of the handoff: a forest header
// with the book's four counts, search and sub-category chips, one card per
// recipe, and a three-step editor behind a tap.
//
// The arithmetic is NOT re-implemented here. Every multiplier, TOR and
// expansion comes from lib/recipeMath — the same module the desktop editor
// and the main process both use — because a recipe that previews one way on a
// phone and posts another way from a laptop is the exact failure that module
// exists to prevent. The save payload is the desktop's, field for field, and
// so are its refusals.
//
// One field from the handoff is deliberately absent: Moisture %. It was taken
// out of the formula on the desktop (save() writes moisture_pct: null for
// every line), so a moisture box here would collect a number that changes
// nothing and is thrown away on save.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Beaker,
  Calculator,
  Check,
  ChevronRight,
  Inbox,
  Layers,
  Loader2,
  Package,
  Plus,
  Save,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { formatNum } from '@/lib/format'
import { MobileBar } from '@/components/MobileBar'
import { cn } from '@/lib/utils'
import { inputFattyAcidPct, inputTorMultiplier, recipeTor, uniformRecipeTor } from '@/lib/recipeMath'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const round2 = (v: number): number => Math.round(v * 100) / 100

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// A recipe's blend must total 100%: the inputs describe how the blend is
// composed, not how much of it is used.
const isBalanced = (blend: number): boolean => Math.abs(blend - 100) < 0.01

export function FormulationMobile(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [subcats, setSubcats] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')
  const [subFilter, setSubFilter] = useState('ALL')
  const [subsOpen, setSubsOpen] = useState(false)
  // Which recipe the editor is on: a row to edit, or 'new'.
  const [editing, setEditing] = useState<Row | 'new' | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setFailed('')
    try {
      const [f, p, sc] = await Promise.all([
        window.api.formulations.list(),
        window.api.data.list('products'),
        window.api.formulationSubcategory.list()
      ])
      setRows(Array.isArray(f) ? f : [])
      setProducts(Array.isArray(p) ? p.filter((x: Row) => n(x.active) !== 0) : [])
      setSubcats(Array.isArray(sc) ? sc : [])
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.product_name, r.name, r.subcategory_name, r.product_category].some((f) => s(f).toLowerCase().includes(q))
    )
  }, [rows, query])

  const shown = useMemo(
    () =>
      pool.filter((r) => {
        if (subFilter === 'ALL') return true
        if (subFilter === 'NONE') return !r.subcategory_id
        return String(r.subcategory_id ?? '') === subFilter
      }),
    [pool, subFilter]
  )

  const chips = useMemo(() => {
    const counts = new Map<string, number>()
    let none = 0
    for (const r of pool) {
      if (r.subcategory_id) {
        const k = String(r.subcategory_id)
        counts.set(k, (counts.get(k) || 0) + 1)
      } else none += 1
    }
    const named = [...counts.entries()]
      .map(([id, count]) => ({
        value: id,
        label: s(subcats.find((x) => String(x.id) === id)?.name) || 'Sub-category',
        count
      }))
      .sort((a, b) => b.count - a.count)
    return [
      { value: 'ALL', label: 'All', count: pool.length },
      ...named,
      ...(none ? [{ value: 'NONE', label: 'Unclassified', count: none }] : [])
    ]
  }, [pool, subcats])

  const kpis = useMemo(() => {
    const off = shown.filter((r) => !isBalanced(n(r.blend_pct)))
    const unclassified = shown.filter((r) => !r.subcategory_id)
    const outputs = new Set(shown.map((r) => String(r.product_id)))
    return [
      { k: 'Recipes', v: String(shown.length), fg: 'text-white' },
      { k: 'Products covered', v: String(outputs.size), fg: 'text-white' },
      {
        k: 'Blend off 100%',
        v: String(off.length),
        fg: off.length ? 'text-[#FFC4BE]' : 'text-[#C7F03F]'
      },
      {
        k: 'Unclassified',
        v: String(unclassified.length),
        fg: unclassified.length ? 'text-[#FFD9A8]' : 'text-[#C7F03F]'
      }
    ]
  }, [shown])

  if (editing) {
    return (
      <RecipeEditor
        row={editing === 'new' ? null : editing}
        products={products}
        subcats={subcats}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await load()
        }}
      />
    )
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-4 pb-3.5 pt-2.5 text-white">
        <MobileBar onRefresh={load} />
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <div className="text-[19px] font-extrabold tracking-[-0.02em]">Formulation</div>
            <div className="mt-0.5 text-[11.5px] font-bold text-[#8FBFA8]">
              {shown.length} recipe{shown.length === 1 ? '' : 's'}
              {subFilter !== 'ALL' ? ' · filtered' : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSubsOpen(true)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] bg-white/10 active:bg-white/20"
          >
            <Layers className="h-[22px] w-[22px]" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {kpis.map((c) => (
            <div key={c.k} className="min-w-0 rounded-[4px] bg-white/[0.08] px-3 py-2.5">
              <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{c.k}</div>
              <div className={cn('mt-1 text-[14px] font-extrabold tracking-[-0.02em] tabular-nums', c.fg)}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-b border-[#D6E2D6] bg-white px-4 py-2.5">
        <div className="flex h-11 items-center gap-2 rounded-[4px] border border-[#C3D2C6] px-3">
          <Search className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Product or recipe"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} className="shrink-0 text-[#5A6B62]">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {chips.length > 1 ? (
          <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {chips.map((c) => {
              const on = subFilter === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setSubFilter(c.value)}
                  className={cn(
                    'flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-[4px] border px-3.5 text-[12.5px] font-extrabold',
                    on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#DCE7DB] bg-white text-[#33473E]'
                  )}
                >
                  {c.label}
                  <span
                    className={cn(
                      'rounded-[2px] px-1.5 py-0.5 text-[10.5px] font-extrabold tabular-nums',
                      on ? 'bg-white/15 text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#5A6B62]'
                    )}
                  >
                    {c.count}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-24 pt-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] font-bold text-[#5A6B62]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the recipes…
          </div>
        ) : failed ? (
          <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
            {failed}
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
            <Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />
            <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">
              {query || subFilter !== 'ALL' ? 'Nothing matches that.' : 'No recipes yet.'}
            </p>
          </div>
        ) : (
          shown.map((r) => {
            const balanced = isBalanced(n(r.blend_pct))
            return (
              <button
                key={String(r.id)}
                type="button"
                onClick={() => setEditing(r)}
                className={cn(
                  'w-full overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] bg-white text-left',
                  balanced ? 'border-l-[#12855A]' : 'border-l-[#C2700A]'
                )}
              >
                <div className="flex flex-col gap-2.5 px-3.5 pb-2.5 pt-3">
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-extrabold leading-snug tracking-[-0.01em] text-[#0A1F17]">
                        {s(r.product_name) || '—'}
                      </div>
                      <div
                        className={cn(
                          'mt-1 text-[11.5px] font-semibold leading-snug',
                          r.name ? 'text-[#33473E]' : 'text-[#A8B8AE]'
                        )}
                      >
                        {s(r.name) || 'Unnamed recipe'}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 whitespace-nowrap rounded-[2px] border px-2 py-1 text-[10px] font-extrabold tracking-[.05em]',
                        r.product_category === 'finished'
                          ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                          : 'border-[#DCE7DB] bg-[#EAF0E9] text-[#33473E]'
                      )}
                    >
                      {(CAT_LABEL[s(r.product_category)] || s(r.product_category) || '—').toUpperCase()}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.subcategory_name ? (
                      <span className="whitespace-nowrap rounded-[2px] border border-[#D6CEF5] bg-[#EDE9FB] px-2 py-1 text-[10.5px] font-extrabold tracking-[.05em] text-[#3D3179]">
                        {s(r.subcategory_name)}
                      </span>
                    ) : (
                      <span className="whitespace-nowrap rounded-[2px] border border-[#F0E4CB] bg-[#FFF4E0] px-2 py-1 text-[10.5px] font-bold text-[#8A5300]">
                        Not classified
                      </span>
                    )}
                    <span className="whitespace-nowrap text-[11.5px] font-bold text-[#5A6B62]">
                      {n(r.item_count)} line{n(r.item_count) === 1 ? '' : 's'}
                    </span>
                    <span className="whitespace-nowrap text-[11.5px] font-bold text-[#5A6B62]">
                      Loss {formatNum(r.loss_pct)}%
                    </span>
                    {!balanced ? (
                      <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[11px] font-extrabold text-[#8A5300]">
                        <AlertTriangle className="h-3.5 w-3.5" /> Blend {formatNum(r.blend_pct)}%
                      </span>
                    ) : null}
                  </div>
                </div>
                {/* TOR is what the recipe COSTS: how much blend has to go in
                    for 100 of product to come out. It is the number a mill
                    compares two recipes on, so it gets the footer to itself. */}
                <div
                  className={cn(
                    'flex items-center gap-2.5 border-t px-3.5 py-2.5',
                    balanced ? 'border-t-[#BFE3CB] bg-[#EAF6EC]' : 'border-t-[#F0D9AE] bg-[#FFFBF2]'
                  )}
                >
                  <Calculator
                    className={cn('h-4 w-4 shrink-0', balanced ? 'text-[#0B6B45]' : 'text-[#C2700A]')}
                  />
                  <span
                    className={cn(
                      'text-[10.5px] font-extrabold uppercase tracking-[.07em]',
                      balanced ? 'text-[#0B6B45]' : 'text-[#8A5300]'
                    )}
                  >
                    TOR per 100
                  </span>
                  <span
                    className={cn(
                      'ml-auto text-[14.5px] font-bold tabular-nums',
                      balanced ? 'text-[#0B6B45]' : 'text-[#8A5300]'
                    )}
                  >
                    {formatNum(r.tor)}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#8FA79B]" />
                </div>
              </button>
            )
          })
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13.5px] font-extrabold text-[#C7F03F]"
        >
          <Plus className="h-5 w-5" /> New formulation
        </button>
      </div>

      {/* The sub-category list. Read-only here: renaming or retiring one
          reclassifies every recipe pointing at it, which is not a thing to do
          from a phone by accident. */}
      {subsOpen ? (
        <div className="fixed inset-0 z-50 flex items-end bg-[#0A1F17]/45" onClick={() => setSubsOpen(false)}>
          <div className="max-h-[75dvh] w-full overflow-y-auto rounded-t-[10px] bg-white px-5 pb-8 pt-5" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3.5 h-1 w-10 rounded-full bg-[#D6E2D6]" />
            <div className="text-[15px] font-extrabold text-[#0A1F17]">Sub-categories</div>
            <p className="mt-1.5 text-[11.5px] font-semibold text-[#5A6B62]">
              What a recipe is built on, as against what it makes. Managed on a desktop — renaming one
              reclassifies every recipe using it.
            </p>
            <div className="mt-3 overflow-hidden rounded-[4px] border border-[#D6E2D6]">
              {subcats.length === 0 ? (
                <div className="px-3.5 py-6 text-center text-[12px] font-semibold text-[#8FA79B]">None yet.</div>
              ) : (
                subcats.map((sc) => (
                  <div
                    key={String(sc.id)}
                    className="flex items-center gap-2.5 border-b border-b-[#EAF0E9] px-3.5 py-2.5 last:border-b-0"
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[12.5px] font-bold',
                        n(sc.active) === 0 ? 'text-[#A8B8AE] line-through' : 'text-[#0A1F17]'
                      )}
                    >
                      {s(sc.name)}
                    </span>
                    <span className="shrink-0 rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[10.5px] font-extrabold tabular-nums text-[#5A6B62]">
                      {n(sc.in_use)} recipe{n(sc.in_use) === 1 ? '' : 's'}
                    </span>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => setSubsOpen(false)}
              className="mt-4 flex h-12 w-full items-center justify-center rounded-[4px] border-[1.5px] border-[#C3D2C6] text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E]"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The editor.
//
// Three steps rather than one long scroll, because a recipe is three
// questions and a phone can only hold one of them at a time: what goes in,
// what that comes to, and what comes back out besides the product.
type Item = {
  product_id: string
  qty: string
  kind: 'input' | 'output' | 'loss'
  auto_calc: boolean
  ffa_pct: string
  loss_multiplier_pct: string
  byproduct_product_id: string
}

const toItem = (i: Row): Item => ({
  product_id: s(i.product_id),
  qty: s(i.qty ?? ''),
  kind: (i.kind === 'output' || i.kind === 'loss' ? i.kind : 'input') as Item['kind'],
  auto_calc: !!i.auto_calc,
  ffa_pct: i.ffa_pct == null ? '' : s(i.ffa_pct),
  loss_multiplier_pct: i.loss_multiplier_pct == null ? '' : s(i.loss_multiplier_pct),
  byproduct_product_id: i.byproduct_product_id ? s(i.byproduct_product_id) : ''
})

function RecipeEditor({
  row,
  products,
  subcats,
  onClose,
  onSaved
}: {
  row: Row | null
  products: Row[]
  subcats: Row[]
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [step, setStep] = useState<'recipe' | 'tor' | 'out'>('recipe')
  const [name, setName] = useState(s(row?.name))
  const [productId, setProductId] = useState(s(row?.product_id))
  const [subId, setSubId] = useState(row?.subcategory_id ? s(row.subcategory_id) : '')
  const [items, setItems] = useState<Item[]>([])
  const [batch, setBatch] = useState('100')
  const [loading, setLoading] = useState(!!row)
  const [saving, setSaving] = useState(false)
  // Which slot a product is being picked for: a new line of a kind, or an
  // existing line's product / by-product target.
  const [picker, setPicker] = useState<null | { for: 'new-input' | 'new-output' | 'output-product'; idx?: number; field?: 'product_id' | 'byproduct_product_id' }>(null)

  useEffect(() => {
    if (!row) {
      setItems([])
      setLoading(false)
      return
    }
    let live = true
    window.api.formulations
      .items(n(row.id))
      .then((its) => {
        if (live) setItems((Array.isArray(its) ? its : []).map(toItem))
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [row])

  const asRows = useMemo(
    () =>
      items.map((it) => ({
        product_id: n(it.product_id),
        qty: n(it.qty),
        kind: it.kind,
        auto_calc: it.auto_calc,
        ffa_pct: it.ffa_pct === '' ? null : n(it.ffa_pct),
        loss_multiplier_pct: it.loss_multiplier_pct === '' ? null : n(it.loss_multiplier_pct),
        byproduct_product_id: it.byproduct_product_id ? n(it.byproduct_product_id) : null
      })),
    [items]
  )

  const inputs = items.filter((i) => i.kind === 'input')
  const outputs = items.filter((i) => i.kind === 'output')
  const lossItem = items.find((i) => i.kind === 'loss')
  const blend = inputs.reduce((a, i) => a + n(i.qty), 0)
  const deadLoss = items.filter((i) => i.kind === 'loss').reduce((a, i) => a + n(i.qty), 0)
  const balanced = isBalanced(blend)
  const tor = recipeTor(asRows)
  const batchQty = n(batch) || 0

  const nameOf = (id: unknown): string => s(products.find((p) => String(p.id) === s(id))?.name) || '—'

  function patch(idx: number, k: keyof Item, v: string | boolean): void {
    setItems((p) => p.map((it, i) => (i === idx ? { ...it, [k]: v } : it)))
  }
  function removeAt(idx: number): void {
    setItems((p) => p.filter((_, i) => i !== idx))
  }
  function setLoss(v: string): void {
    setItems((p) => {
      const at = p.findIndex((i) => i.kind === 'loss')
      if (at >= 0) return p.map((it, i) => (i === at ? { ...it, qty: v } : it))
      // A dead-loss line needs a product to hang on, the same way the desktop
      // editor's does — the recipe's own output stands in for it.
      return [
        ...p,
        {
          product_id: productId,
          qty: v,
          kind: 'loss' as const,
          auto_calc: false,
          ffa_pct: '',
          loss_multiplier_pct: '',
          byproduct_product_id: ''
        }
      ]
    })
  }

  // The same refusals the desktop save() makes, in the same order — shown as
  // you go rather than as a toast after the button is pressed.
  const blocker = useMemo(() => {
    if (!productId) return 'Pick the product this recipe makes.'
    if (!inputs.length) return 'Add at least one input.'
    if (inputs.some((i) => !i.product_id)) return 'Every input needs a product.'
    if (!balanced) return `The input blend must total 100% — it is ${formatNum(blend)}% now.`
    if (inputs.some((i) => i.auto_calc && !i.byproduct_product_id))
      return 'Every auto-calculated input must say which product its fatty acid becomes.'
    if (inputs.some((i) => i.auto_calc) && !deadLoss)
      return 'Auto-calculated inputs need a dead loss % — set it under Outputs.'
    return ''
  }, [productId, inputs, balanced, blend, deadLoss])

  async function save(): Promise<void> {
    if (blocker) {
      toast.error(blocker)
      return
    }
    setSaving(true)
    try {
      const clean = asRows
        .map((it) => ({
          product_id: it.product_id,
          qty: it.qty,
          kind: it.kind,
          auto_calc: !!it.auto_calc,
          ffa_pct: it.auto_calc ? it.ffa_pct : null,
          loss_multiplier_pct: it.auto_calc ? it.loss_multiplier_pct : null,
          // Dropped from the formula on the desktop; nothing new carries one.
          moisture_pct: null,
          byproduct_product_id: it.auto_calc && it.kind === 'input' ? it.byproduct_product_id : null
        }))
        .filter((it) => it.product_id && it.qty > 0)
      const payload = {
        product_id: n(productId),
        name,
        uom: s(row?.uom) || 'MT',
        subcategory_id: subId ? n(subId) : null,
        items: clean
      }
      if (row) await window.api.formulations.update(n(row.id), payload)
      else await window.api.formulations.create(payload)
      toast.success(row ? 'Recipe saved — batches already recorded keep the version they were run on' : 'Recipe created')
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // What one batch actually draws and yields, at the batch size on screen.
  const preview = useMemo(() => {
    const uniform = uniformRecipeTor(asRows)
    const rowsOut = inputs.map((it) => {
      const r = { ...it, qty: n(it.qty), auto_calc: it.auto_calc, ffa_pct: n(it.ffa_pct), loss_multiplier_pct: n(it.loss_multiplier_pct) }
      const mult = it.auto_calc ? inputTorMultiplier(r, deadLoss) : uniform / 100
      const pct = n(it.qty) * mult
      return {
        kind: 'input' as const,
        name: nameOf(it.product_id),
        share: n(it.qty),
        mult,
        pct,
        qty: (batchQty * pct) / 100,
        fatty: it.auto_calc ? inputFattyAcidPct(r) : 0
      }
    })
    const drawn = rowsOut.reduce((a, r) => a + r.qty, 0)
    const lossQty = (batchQty * ((tor * deadLoss) / 100)) / 100
    const manualOut = outputs.map((o) => ({
      kind: 'output' as const,
      name: nameOf(o.product_id),
      share: n(o.qty),
      mult: 0,
      pct: (tor * n(o.qty)) / 100,
      qty: (batchQty * ((tor * n(o.qty)) / 100)) / 100,
      fatty: 0
    }))
    const recovered = rowsOut.reduce((a, r) => a + (r.qty * r.fatty) / 100, 0)
    return {
      rows: rowsOut,
      manualOut,
      drawn,
      lossQty,
      recovered,
      net: drawn - lossQty - recovered - manualOut.reduce((a, o) => a + o.qty, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asRows, batchQty, deadLoss, tor, products])

  const steps = [
    { k: 'recipe' as const, label: 'Recipe', icon: Beaker },
    { k: 'tor' as const, label: 'TOR', icon: Calculator },
    { k: 'out' as const, label: 'Outputs', icon: Package }
  ]

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-3 pb-3 pt-2 text-white">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] active:bg-white/10"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              {row ? 'Edit formulation' : 'New formulation'}
            </div>
            <div className="mt-0.5 truncate text-[15px] font-extrabold tracking-[-0.01em]">
              {productId ? nameOf(productId) : 'Pick an output product'}
              {name ? <span className="ml-2 text-[12.5px] font-bold text-[#8FBFA8]">{name}</span> : null}
            </div>
          </div>
        </div>
        <div
          className={cn(
            'mt-2.5 flex items-center gap-2.5 rounded-[3px] border px-3 py-2.5',
            balanced ? 'border-[#C7F03F]/40 bg-[#C7F03F]/15' : 'border-[#F8B4AE]/40 bg-[#B3261E]/30'
          )}
        >
          {balanced ? (
            <Beaker className="h-[18px] w-[18px] shrink-0 text-[#C7F03F]" />
          ) : (
            <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-[#FFC4BE]" />
          )}
          <span
            className={cn(
              'text-[10px] font-extrabold uppercase tracking-[.1em]',
              balanced ? 'text-[#C7F03F]' : 'text-[#FFC4BE]'
            )}
          >
            Blend
          </span>
          <span className={cn('ml-auto text-[14px] font-bold tabular-nums', balanced ? 'text-[#C7F03F]' : 'text-[#FFC4BE]')}>
            {formatNum(blend)}%
          </span>
          <span className="whitespace-nowrap text-[12px] font-bold tabular-nums text-white">
            TOR {formatNum(round2(tor))}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 border-b border-[#D6E2D6] bg-white">
        {steps.map((st) => {
          const on = step === st.k
          return (
            <button
              key={st.k}
              type="button"
              onClick={() => setStep(st.k)}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-[3px] py-3.5 text-[12px] font-extrabold',
                on ? 'border-b-[#0B3D2E] text-[#0A1F17]' : 'border-b-transparent text-[#8FA79B]'
              )}
            >
              <st.icon className="h-4 w-4" />
              {st.label}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-6 pt-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] font-bold text-[#5A6B62]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the recipe…
          </div>
        ) : step === 'recipe' ? (
          <>
            <div className="flex flex-col gap-3.5 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3.5">
              <Field label="Makes">
                <button
                  type="button"
                  onClick={() => setPicker({ for: 'output-product' })}
                  className="flex h-[46px] w-full items-center justify-between gap-2 rounded-[4px] border border-[#C3D2C6] px-3 text-left"
                >
                  <span className={cn('min-w-0 truncate text-[13px] font-bold', productId ? 'text-[#0A1F17]' : 'text-[#8FA79B]')}>
                    {productId ? nameOf(productId) : 'Pick the output product'}
                  </span>
                  <ChevronRight className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
                </button>
              </Field>
              <Field label="Recipe name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name this recipe"
                  className="h-[46px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13.5px] font-bold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
                />
              </Field>
              <Field label="Sub-category">
                <select
                  value={subId}
                  onChange={(e) => setSubId(e.target.value)}
                  className="h-[46px] w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13px] font-bold text-[#0A1F17] outline-none"
                >
                  <option value="">Not classified</option>
                  {subcats
                    .filter((sc) => n(sc.active) !== 0 || String(sc.id) === subId)
                    .map((sc) => (
                      <option key={String(sc.id)} value={String(sc.id)}>
                        {s(sc.name)}
                      </option>
                    ))}
                </select>
              </Field>
            </div>

            <SectionRule label="Inputs" count={`${formatNum(blend)}% of 100%`} warn={!balanced} />

            {items.map((it, idx) =>
              it.kind !== 'input' ? null : (
                <div key={idx} className="overflow-hidden rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#12855A] bg-white">
                  <div className="flex items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => setPicker({ for: 'new-input', idx, field: 'product_id' })}
                      className="min-w-0 flex-1 text-left text-[12.5px] font-extrabold leading-snug text-[#0A1F17]"
                    >
                      {it.product_id ? nameOf(it.product_id) : <span className="text-[#8FA79B]">Pick a product</span>}
                    </button>
                    <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#0B6B45]">
                      {formatNum(n(it.qty))}%
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAt(idx)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2]"
                    >
                      <Trash2 className="h-4 w-4 text-[#B3261E]" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 px-3 py-3">
                    <Field label="Share %">
                      <NumBox value={it.qty} onChange={(v) => patch(idx, 'qty', v)} />
                    </Field>
                    <Field label="FFA %">
                      <NumBox
                        value={it.ffa_pct}
                        disabled={!it.auto_calc}
                        onChange={(v) => patch(idx, 'ffa_pct', v)}
                      />
                    </Field>
                    <Field label="Loss multiplier %">
                      <NumBox
                        value={it.loss_multiplier_pct}
                        disabled={!it.auto_calc}
                        onChange={(v) => patch(idx, 'loss_multiplier_pct', v)}
                      />
                    </Field>
                    <Field label="Own multiplier">
                      {/* Auto-calculate is the switch that decides whether this
                          ingredient carries its own TOR — a blend of oils at
                          23% and 0.15% FFA cannot share one. Off, it takes the
                          recipe-wide figure. */}
                      <button
                        type="button"
                        onClick={() => patch(idx, 'auto_calc', !it.auto_calc)}
                        className={cn(
                          'flex h-11 w-full items-center justify-between gap-2 rounded-[4px] border px-3 text-[12px] font-extrabold',
                          it.auto_calc ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#C3D2C6] bg-white text-[#5A6B62]'
                        )}
                      >
                        {it.auto_calc ? 'On' : 'Off'}
                        <span className={cn('flex h-5 w-[34px] items-center rounded-[2px] p-0.5', it.auto_calc ? 'justify-end bg-white/25' : 'justify-start bg-[#C3D2C6]')}>
                          <span className="h-4 w-4 rounded-[2px] bg-white" />
                        </span>
                      </button>
                    </Field>
                  </div>
                  {it.auto_calc ? (
                    <div className="px-3 pb-3">
                      <Field label="Its fatty acid becomes">
                        <button
                          type="button"
                          onClick={() => setPicker({ for: 'new-input', idx, field: 'byproduct_product_id' })}
                          className={cn(
                            'flex h-11 w-full items-center justify-between gap-2 rounded-[4px] border px-3 text-left',
                            it.byproduct_product_id ? 'border-[#C3D2C6]' : 'border-[#F0D9AE] bg-[#FFFBF2]'
                          )}
                        >
                          <span className={cn('min-w-0 truncate text-[12px] font-bold', it.byproduct_product_id ? 'text-[#0A1F17]' : 'text-[#8A5300]')}>
                            {it.byproduct_product_id ? nameOf(it.byproduct_product_id) : 'Pick the product it becomes'}
                          </span>
                          <ChevronRight className="h-[19px] w-[19px] shrink-0 text-[#5A6B62]" />
                        </button>
                      </Field>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2.5 border-t border-t-[#E4ECE3] bg-[#F4FBF6] px-3 py-2.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-[.07em] text-[#5A6B62]">Multiplier</span>
                    <span className="ml-auto text-[13px] font-bold tabular-nums text-[#0B6B45]">
                      ×
                      {(it.auto_calc
                        ? inputTorMultiplier(
                            { ffa_pct: n(it.ffa_pct), loss_multiplier_pct: n(it.loss_multiplier_pct) },
                            deadLoss
                          )
                        : uniformRecipeTor(asRows) / 100
                      ).toFixed(4)}
                    </span>
                  </div>
                </div>
              )
            )}

            <AddButton
              label="Add input"
              onClick={() =>
                setItems((p) => [
                  ...p,
                  { product_id: '', qty: '', kind: 'input', auto_calc: false, ffa_pct: '', loss_multiplier_pct: '', byproduct_product_id: '' }
                ])
              }
            />
          </>
        ) : step === 'tor' ? (
          <>
            <div className="rounded-[4px] bg-[#0B3D2E] px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#8FBFA8]">
                    Total oil required
                  </div>
                  <div className="mt-1.5 text-[22px] font-bold tracking-[-0.03em] tabular-nums text-white">
                    {formatNum(round2(preview.drawn))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#8FBFA8]">TOR / 100</div>
                  <div className="mt-1.5 text-[22px] font-bold tracking-[-0.03em] tabular-nums text-[#C7F03F]">
                    {formatNum(round2(tor))}
                  </div>
                </div>
              </div>
              <div className="mt-2.5 text-[11.5px] font-semibold leading-relaxed text-[#8FBFA8]">
                What has to go in for {formatNum(batchQty)} of {productId ? nameOf(productId) : 'product'} to come out —
                by-products and loss are struck on the oil going in, not on the product coming out.
              </div>
            </div>

            <Field label="Batch size (preview only)">
              <NumBox value={batch} onChange={setBatch} />
            </Field>

            {preview.rows.map((r, i) => (
              <div key={i} className="rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#12855A] bg-white px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-[9.5px] font-extrabold tracking-[.07em] text-[#0B6B45]">IN</span>
                  <span className="min-w-0 flex-1 text-[12.5px] font-extrabold leading-snug text-[#0A1F17]">{r.name}</span>
                  <span className="shrink-0 text-[14px] font-bold tabular-nums text-[#0A1F17]">{formatNum(round2(r.qty))}</span>
                </div>
                <div className="mt-2.5 flex items-center gap-2.5">
                  <span className="text-[11.5px] font-bold tabular-nums text-[#33473E]">{formatNum(r.share)}%</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                    <div className="h-full bg-[#12855A]" style={{ width: `${Math.min(100, r.share)}%` }} />
                  </div>
                  <span className="whitespace-nowrap text-[11.5px] font-bold tabular-nums text-[#0B6B45]">
                    × {r.mult.toFixed(4)}
                  </span>
                </div>
                {r.fatty > 0 ? (
                  <div className="mt-1.5 text-[11px] font-semibold leading-relaxed text-[#5A6B62]">
                    {formatNum(round2(r.fatty))}% of it comes back as fatty acid — {formatNum(round2((r.qty * r.fatty) / 100))}
                  </div>
                ) : null}
              </div>
            ))}

            {preview.manualOut.map((o, i) => (
              <div key={i} className="rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#C2700A] bg-white px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-[9.5px] font-extrabold tracking-[.07em] text-[#8A5300]">OUT</span>
                  <span className="min-w-0 flex-1 text-[12.5px] font-extrabold leading-snug text-[#0A1F17]">{o.name}</span>
                  <span className="shrink-0 text-[14px] font-bold tabular-nums text-[#8A5300]">
                    {formatNum(round2(o.qty))}
                  </span>
                </div>
              </div>
            ))}

            {deadLoss > 0 ? (
              <div className="rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#B3261E] bg-white px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-[9.5px] font-extrabold tracking-[.07em] text-[#8C2F26]">LOSS</span>
                  <span className="min-w-0 flex-1 text-[12.5px] font-extrabold text-[#0A1F17]">
                    Dead loss {formatNum(deadLoss)}%
                  </span>
                  <span className="shrink-0 text-[14px] font-bold tabular-nums text-[#B3261E]">
                    {formatNum(round2(preview.lossQty))}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="rounded-[4px] border border-[#BFE3CB] bg-white px-3.5 py-3">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Net finished oil</div>
              <div className="mt-1.5 text-[18px] font-bold tabular-nums text-[#0B6B45]">
                {formatNum(round2(preview.net))}
              </div>
              <div className="mt-1 text-[11px] font-semibold tabular-nums text-[#5A6B62]">
                {formatNum(round2(preview.drawn))} drawn − {formatNum(round2(preview.recovered))} fatty acid −{' '}
                {formatNum(round2(preview.lossQty))} dead loss
                {preview.manualOut.length ? ` − ${formatNum(round2(preview.manualOut.reduce((a, o) => a + o.qty, 0)))} by-product` : ''}
              </div>
            </div>
          </>
        ) : (
          <>
            {outputs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-7">
                <Package className="h-7 w-7 text-[#C3D2C6]" />
                <span className="text-center text-[12.5px] font-semibold leading-relaxed text-[#5A6B62]">
                  No fixed by-product on this recipe. What an auto-calculated input recovers is set on the input
                  itself, under Recipe.
                </span>
              </div>
            ) : null}

            {items.map((it, idx) =>
              it.kind !== 'output' ? null : (
                <div key={idx} className="rounded-[4px] border border-[#D6E2D6] border-l-[3px] border-l-[#C2700A] bg-white px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => setPicker({ for: 'new-output', idx, field: 'product_id' })}
                    className="w-full text-left text-[12.5px] font-extrabold leading-snug text-[#0A1F17]"
                  >
                    {it.product_id ? nameOf(it.product_id) : <span className="text-[#8FA79B]">Pick a product</span>}
                  </button>
                  <div className="mt-2.5 flex items-end gap-2.5">
                    <div className="min-w-0 flex-1">
                      <Field label="Share % of the blend">
                        <NumBox value={it.qty} onChange={(v) => patch(idx, 'qty', v)} />
                      </Field>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAt(idx)}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2]"
                    >
                      <Trash2 className="h-[19px] w-[19px] text-[#B3261E]" />
                    </button>
                  </div>
                </div>
              )
            )}

            <AddButton
              label="Add by-product"
              onClick={() =>
                setItems((p) => [
                  ...p,
                  { product_id: '', qty: '', kind: 'output', auto_calc: false, ffa_pct: '', loss_multiplier_pct: '', byproduct_product_id: '' }
                ])
              }
            />

            <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Dead loss</div>
              <div className="mt-2 flex items-end gap-2.5">
                <div className="min-w-0 flex-1">
                  <NumBox value={s(lossItem?.qty ?? '')} onChange={setLoss} />
                </div>
                <span className="pb-3 text-[12px] font-bold text-[#5A6B62]">% of the blend</span>
              </div>
              <div className="mt-2 text-[11px] font-semibold leading-relaxed text-[#5A6B62]">
                What the batch loses outright — written off, not recovered as anything. Every auto-calculated input
                needs one, because its own multiplier is struck against it.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        {blocker ? (
          <div className="mb-2 flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-[17px] w-[17px] shrink-0 text-[#8A5300]" />
            <span className="text-[11.5px] font-bold leading-snug text-[#8A5300]">{blocker}</span>
          </div>
        ) : null}
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-[50px] flex-1 items-center justify-center rounded-[4px] border-[1.5px] border-[#C3D2C6] text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!!blocker || saving}
            onClick={() => void save()}
            className={cn(
              'flex h-[50px] flex-[1.3] items-center justify-center gap-2 rounded-[4px] text-[13px] font-extrabold uppercase tracking-[.03em]',
              blocker || saving ? 'bg-[#DCE7DB] text-[#8FA79B]' : 'bg-[#0B3D2E] text-[#C7F03F]'
            )}
          >
            {saving ? <Loader2 className="h-[19px] w-[19px] animate-spin" /> : <Save className="h-[19px] w-[19px]" />}
            Save recipe
          </button>
        </div>
      </div>

      {picker ? (
        <ProductPicker
          products={products}
          // Inputs are drawn from stock, so they are raw or intermediate; a
          // recipe MAKES a finished good. Not enforced — a mill that puts a
          // finished oil into another recipe is doing something real — but
          // ordered so the likely answers are at the top.
          preferred={picker.for === 'output-product' ? 'finished' : 'raw'}
          onPick={(id) => {
            if (picker.for === 'output-product') setProductId(id)
            else if (picker.idx != null && picker.field) patch(picker.idx, picker.field, id)
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{label}</div>
      {children}
    </div>
  )
}

// A number box that keeps what was typed as text. Parsing on every keystroke
// makes "0." impossible to type, and a percentage always goes through it.
function NumBox({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <input
      value={value}
      disabled={disabled}
      inputMode="decimal"
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-11 w-full rounded-[4px] border px-3 text-right text-[13.5px] font-bold tabular-nums outline-none',
        disabled ? 'border-[#E4ECE3] bg-[#F7FAF6] text-[#A8B8AE]' : 'border-[#C3D2C6] bg-white text-[#0A1F17]'
      )}
    />
  )
}

function SectionRule({ label, count, warn }: { label: string; count: string; warn?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <span className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#33473E]">{label}</span>
      <span className={cn('text-[11.5px] font-bold tabular-nums', warn ? 'text-[#8A5300]' : 'text-[#5A6B62]')}>
        {count}
      </span>
      <span className="h-px flex-1 bg-[#DCE7DB]" />
    </div>
  )
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-12 items-center justify-center gap-2 rounded-[4px] border-[1.5px] border-dashed border-[#C3D2C6] bg-white text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#0B6B45]"
    >
      <Plus className="h-[19px] w-[19px]" /> {label}
    </button>
  )
}

// A full-screen list rather than a dropdown: the product master runs to
// hundreds of rows, and a native select on a phone gives no way to search it.
function ProductPicker({
  products,
  preferred,
  onPick,
  onClose
}: {
  products: Row[]
  preferred: string
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const query = q.trim().toLowerCase()
    const rank = (p: Row): number => (s(p.category) === preferred ? 0 : 1)
    return products
      .filter((p) => !query || [p.name, p.code, p.material_type].some((f) => s(f).toLowerCase().includes(query)))
      .sort((a, b) => rank(a) - rank(b) || s(a.name).localeCompare(s(b.name)))
      .slice(0, 300)
  }, [products, q, preferred])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F1F5EF]">
      <div className="flex shrink-0 items-center gap-2 bg-[#0B3D2E] px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] text-white active:bg-white/10"
        >
          <X className="h-6 w-6" />
        </button>
        <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[4px] bg-white px-3">
          <Search className="h-[18px] w-[18px] shrink-0 text-[#5A6B62]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a product"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12.5px] font-bold text-[#5A6B62]">Nothing matches that.</div>
        ) : (
          list.map((p) => (
            <button
              key={String(p.id)}
              type="button"
              onClick={() => onPick(String(p.id))}
              className="flex w-full items-center gap-2.5 border-b border-b-[#E4ECE3] bg-white px-4 py-3 text-left active:bg-[#EFF5EC]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-bold text-[#0A1F17]">{s(p.name)}</div>
                <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">
                  {CAT_LABEL[s(p.category)] || s(p.category)}
                  {p.material_type ? ` · ${s(p.material_type)}` : ''}
                </div>
              </div>
              <Check className="h-4 w-4 shrink-0 text-[#C3D2C6]" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}
